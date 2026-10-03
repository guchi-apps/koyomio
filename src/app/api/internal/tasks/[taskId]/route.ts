import { requireInternalApiKey, requireInternalTasksApiKey, resolveInternalUserId } from "@/lib/internal-auth";
import { getNotionConnection } from "@/services/calendar/write-context";
import { createNotionClient } from "@/services/notion/client";
import { updateTask } from "@/services/notion/tasks";
import { unlinkOverriddenTaskDateLinks } from "@/services/task-links/links";
import { assertTaskVersion, assertWritableFields, getInternalTask, parseInternalTaskWrite } from "@/services/internal/tasks";

import { json, taskError } from "../route";

export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const unauthorized = await requireInternalApiKey(request);
  if (unauthorized) return unauthorized;
  try {
    const userId = await resolveInternalUserId(request);
    if (!userId) return json({ error: "target_user_not_resolvable" }, 500);
    const connection = await getNotionConnection(userId);
    if (!connection) return json({ error: "not_connected" }, 404);
    const { taskId } = await params;
    return json({ task: await getInternalTask(createNotionClient(connection), connection, taskId) }, 200);
  } catch (error) { return taskError(error, "内部タスクの取得"); }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
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
    const { version, ...inputRaw } = raw;
    const input = parseInternalTaskWrite(inputRaw);
    assertWritableFields(connection, input);
    const notion = createNotionClient(connection);
    assertTaskVersion(await getInternalTask(notion, connection, taskId), version);
    await updateTask(notion, connection, taskId, input);
    await unlinkOverriddenTaskDateLinks(userId, taskId, input);
    return json({ task: await getInternalTask(notion, connection, taskId) }, 200);
  } catch (error) { return taskError(error, "内部タスクの更新"); }
}
