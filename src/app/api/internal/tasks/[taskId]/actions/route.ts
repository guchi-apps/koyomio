import { requireInternalTasksApiKey, resolveInternalUserId } from "@/lib/internal-auth";
import { getNotionConnection } from "@/services/calendar/write-context";
import { createNotionClient } from "@/services/notion/client";
import type { PropertyMap } from "@/services/notion/task-database";
import { completeTask, skipTask, updateTask } from "@/services/notion/tasks";
import {
  assertTaskVersion,
  claimTaskOperation,
  completeTaskOperation,
  completedActionForTask,
  getInternalTask,
  markTaskOperationUnknown,
  parseTaskAction,
  requestHash,
} from "@/services/internal/tasks";

import { existingOperation, json, taskError } from "../../route";

export async function POST(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const unauthorized = await requireInternalTasksApiKey(request);
  if (unauthorized) return unauthorized;
  let raw: Record<string, unknown>;
  try { raw = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "invalid_json_body" }, 400); }
  try {
    const userId = await resolveInternalUserId(request);
    if (!userId) return json({ error: "target_user_not_resolvable" }, 500);
    const connection = await getNotionConnection(userId);
    if (!connection) return json({ error: "not_connected" }, 404);
    const { taskId } = await params;
    const action = parseTaskAction(raw.action);
    if ((action === "skip" || action === "unskip") && !(connection.propertyMap as PropertyMap | null)?.outcome) {
      return json({ error: "unsupported_field:outcome" }, 400);
    }
    const claim = await claimTaskOperation(userId, request.headers.get("idempotency-key") ?? "", action, taskId, requestHash(raw));
    if (claim.kind === "existing") return existingOperation(claim.record);
    const notion = createNotionClient(connection);
    try {
      const current = await getInternalTask(notion, connection, taskId);
      assertTaskVersion(current, raw.version);
      let nextTaskId: string | null = null;
      if (action === "complete") {
        const previous = await completedActionForTask(userId, taskId);
        if (!previous) {
          nextTaskId = (await completeTask(notion, connection, taskId, true)).nextTaskId;
        } else if (current.status !== "completed") {
          // 以前の完了で次回を作った回を再完了しても、状態だけを戻す。
          // `completeTask` を通すと同じ元タスクから次回が増えるため使わない。
          await updateTask(notion, connection, taskId, { done: true, ...(current.status === "skipped" ? { outcome: null } : {}) });
        }
      } else if (action === "reopen") await completeTask(notion, connection, taskId, false);
      else if (action === "skip") await skipTask(notion, connection, taskId, true);
      else await skipTask(notion, connection, taskId, false);
      const result = { task: await getInternalTask(notion, connection, taskId), nextTaskId };
      await completeTaskOperation(claim.record.id, result);
      return json(result, 200);
    } catch (error) {
      await markTaskOperationUnknown(claim.record.id);
      throw error;
    }
  } catch (error) { return taskError(error, "内部タスクの状態変更"); }
}
