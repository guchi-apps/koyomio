import { createHash } from "node:crypto";

import type { NotionConnection } from "@prisma/client";
import type { Client } from "@notionhq/client";

import { db } from "@/lib/db";
import { SKIPPED_OUTCOME, type PropertyMap } from "@/services/notion/task-database";
import {
  getTaskPage,
  normalizeTask,
  queryTaskPage,
  type NotionTaskPage,
  type TaskWriteInput,
} from "@/services/notion/tasks";
import type { TaskItem } from "@/types/calendar";
import {
  INTERNAL_TASK_ACTIONS,
  INTERNAL_TASK_DATE_FIELDS,
  INTERNAL_TASK_STATUSES,
  InternalTaskInputError,
  matchesInternalDate,
  parseInternalTaskWrite,
  parseTaskAction,
  type InternalTaskAction,
  type InternalTaskDateField,
  type InternalTaskStatus,
} from "./task-contract";

export {
  INTERNAL_TASK_ACTIONS,
  INTERNAL_TASK_DATE_FIELDS,
  INTERNAL_TASK_STATUSES,
  InternalTaskInputError,
  parseInternalTaskWrite,
  parseTaskAction,
};
export type { InternalTaskAction, InternalTaskDateField, InternalTaskStatus };


export type InternalTask = Omit<TaskItem, "kind" | "done" | "skipped" | "canSkip" | "canProgress" | "links"> & {
  status: InternalTaskStatus;
  version: string;
};

export type InternalTaskListInput = {
  status: InternalTaskStatus;
  dateField: InternalTaskDateField;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
};

export class InternalTaskConflictError extends Error {}

function taskStatus(task: TaskItem): InternalTaskStatus {
  if (task.skipped) return "skipped";
  return task.done ? "completed" : "open";
}

function pageVersion(page: NotionTaskPage): string {
  // Notionが常に返す最終更新時刻を版として使う。欠けた部分レスポンスは更新に使わせない。
  if (!page.last_edited_time) throw new InternalTaskConflictError("task_version_unavailable");
  return page.last_edited_time;
}

function toInternalTask(page: NotionTaskPage, propertyMap: PropertyMap): InternalTask {
  const task = normalizeTask(page, propertyMap);
  return {
    id: task.id,
    title: task.title,
    due: task.due,
    hasTime: task.hasTime,
    planned: task.planned,
    plannedHasTime: task.plannedHasTime,
    priority: task.priority,
    tags: task.tags,
    memo: task.memo,
    recurrence: task.recurrence,
    url: task.url,
    progress: task.progress,
    status: taskStatus(task),
    version: pageVersion(page),
  };
}

/**
 * Notionの1ページ（`limit` 件）を取得したあとにメモリ上で絞り込むため、
 * 条件に合う件が0件でも `hasMore: true` になりうる。呼び出し側は `hasMore` が false になるまで
 * `nextCursor` を辿る必要がある（docs/internal-api.md）。
 */
export async function listInternalTasks(
  notion: Client,
  connection: NotionConnection,
  input: InternalTaskListInput,
): Promise<{ tasks: InternalTask[]; nextCursor: string | null; hasMore: boolean }> {
  if (!connection.taskDataSourceId) return { tasks: [], nextCursor: null, hasMore: false };
  const propertyMap = (connection.propertyMap as PropertyMap | null) ?? {};
  const page = await queryTaskPage(notion, connection.taskDataSourceId, undefined, input.cursor, input.limit);
  const tasks = page.pages
    .map((page) => ({ page, task: normalizeTask(page, propertyMap) }))
    .filter(({ task }) => taskStatus(task) === input.status && matchesInternalDate(task, input));
  return {
    tasks: tasks.map(({ page }) => toInternalTask(page, propertyMap)),
    nextCursor: page.nextCursor,
    hasMore: page.nextCursor !== null,
  };
}

export async function getInternalTask(
  notion: Client,
  connection: NotionConnection,
  taskId: string,
): Promise<InternalTask> {
  const page = await getTaskPage(notion, connection, taskId);
  return toInternalTask(page, (connection.propertyMap as PropertyMap | null) ?? {});
}


export function assertWritableFields(connection: NotionConnection, input: TaskWriteInput): void {
  const map = (connection.propertyMap as PropertyMap | null) ?? {};
  for (const field of Object.keys(input) as Array<keyof TaskWriteInput>) {
    if (!map[field]) throw new InternalTaskInputError(`unsupported_field:${field}`);
  }
}

export function assertTaskVersion(current: InternalTask, version: unknown): void {
  if (typeof version !== "string" || !version) throw new InternalTaskInputError("version_required");
  if (current.version !== version) throw new InternalTaskConflictError("task_version_conflict");
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function claimTaskOperation(
  userId: string,
  idempotencyKey: string,
  operation: string,
  taskId: string | null,
  hash: string,
) {
  if (!/^[\x21-\x7e]{1,191}$/.test(idempotencyKey)) throw new InternalTaskInputError("invalid_idempotency_key");
  try {
    return { kind: "claimed" as const, record: await db.internalTaskOperation.create({ data: { userId, idempotencyKey, operation, taskId, requestHash: hash } }) };
  } catch (error) {
    if (!(typeof error === "object" && error && "code" in error && error.code === "P2002")) throw error;
    const record = await db.internalTaskOperation.findUniqueOrThrow({ where: { userId_idempotencyKey: { userId, idempotencyKey } } });
    if (record.requestHash !== hash || record.operation !== operation || record.taskId !== taskId)
      throw new InternalTaskConflictError("idempotency_key_reused");
    return { kind: "existing" as const, record };
  }
}

export async function completeTaskOperation(id: string, result: object): Promise<void> {
  await db.internalTaskOperation.update({ where: { id }, data: { state: "SUCCEEDED", result } });
}

export async function markTaskOperationUnknown(id: string): Promise<void> {
  await db.internalTaskOperation.update({ where: { id }, data: { state: "RESULT_UNKNOWN" } });
}

export async function completedActionForTask(userId: string, taskId: string) {
  return db.internalTaskOperation.findFirst({ where: { userId, taskId, operation: "complete", state: "SUCCEEDED" } });
}

export { SKIPPED_OUTCOME };
