import { NextResponse } from "next/server";

import { externalApiError } from "@/lib/api-error";
import { requireInternalApiKey, requireInternalTasksApiKey, resolveInternalUserId } from "@/lib/internal-auth";
import { getNotionConnection } from "@/services/calendar/write-context";
import { createNotionClient } from "@/services/notion/client";
import { createTask, TaskNotEditableError } from "@/services/notion/tasks";
import {
  assertWritableFields,
  claimTaskOperation,
  completeTaskOperation,
  getInternalTask,
  InternalTaskConflictError,
  InternalTaskInputError,
  listInternalTasks,
  markTaskOperationUnknown,
  parseInternalTaskWrite,
  requestHash,
} from "@/services/internal/tasks";

export const dynamic = "force-dynamic";
const MAX_LIMIT = 100;

export async function GET(request: Request) {
  const unauthorized = await requireInternalApiKey(request);
  if (unauthorized) return unauthorized;
  const params = new URL(request.url).searchParams;
  const status = params.get("status") ?? "open";
  const dateField = params.get("dateField") ?? "due";
  const limit = Number(params.get("limit") ?? "50");
  if (!(["open", "completed", "skipped"] as string[]).includes(status) || !(["due", "planned", "none"] as string[]).includes(dateField))
    return json({ error: "invalid_filter" }, 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return json({ error: "invalid_limit" }, 400);
  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) || (from && to && from > to))
    return json({ error: "invalid_date_range" }, 400);

  try {
    const userId = await resolveInternalUserId(request);
    if (!userId) return json({ error: "target_user_not_resolvable" }, 500);
    const connection = await getNotionConnection(userId);
    if (!connection) return json({ generatedAt: new Date().toISOString(), source: "not_configured", tasks: [], nextCursor: null, hasMore: false }, 200);
    const result = await listInternalTasks(createNotionClient(connection), connection, {
      status: status as "open" | "completed" | "skipped",
      dateField: dateField as "due" | "planned" | "none",
      from,
      to,
      limit,
      cursor: params.get("cursor") ?? undefined,
    });
    return json({ generatedAt: new Date().toISOString(), source: "ready", ...result }, 200);
  } catch (error) {
    return externalApiError("notion", "内部タスクの取得", error);
  }
}

export async function POST(request: Request) {
  const unauthorized = await requireInternalTasksApiKey(request);
  if (unauthorized) return unauthorized;
  let raw: unknown;
  try { raw = await request.json(); } catch { return json({ error: "invalid_json_body" }, 400); }
  try {
    const userId = await resolveInternalUserId(request);
    if (!userId) return json({ error: "target_user_not_resolvable" }, 500);
    const connection = await getNotionConnection(userId);
    if (!connection) return json({ error: "not_connected" }, 404);
    const input = parseInternalTaskWrite(raw, { create: true });
    assertWritableFields(connection, input);
    const key = request.headers.get("idempotency-key") ?? "";
    const claim = await claimTaskOperation(userId, key, "create", null, requestHash(input));
    if (claim.kind === "existing") return existingOperation(claim.record);
    try {
      const created = await createTask(createNotionClient(connection), connection, input);
      const task = await getInternalTask(createNotionClient(connection), connection, created.id);
      const result = { task };
      await completeTaskOperation(claim.record.id, result);
      return json(result, 201);
    } catch (error) {
      await markTaskOperationUnknown(claim.record.id);
      throw error;
    }
  } catch (error) { return taskError(error, "内部タスクの作成"); }
}

export function existingOperation(record: { state: string; result: unknown }) {
  if (record.state === "SUCCEEDED") return json(record.result, 200);
  return json({ error: record.state === "RESULT_UNKNOWN" ? "result_unknown" : "operation_in_progress", retryWithSameKey: true }, 409);
}

export function taskError(error: unknown, operation: string): NextResponse {
  if (error instanceof InternalTaskInputError) return json({ error: error.message }, 400);
  if (error instanceof InternalTaskConflictError) return json({ error: error.message }, 409);
  if (error instanceof TaskNotEditableError) return json({ error: "not_editable" }, 403);
  return externalApiError("notion", operation, error);
}

export function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
