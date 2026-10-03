import { isRealDateKey } from "@/lib/calendar-range";
import type { TaskWriteInput } from "@/services/notion/tasks";

export const INTERNAL_TASK_STATUSES = ["open", "completed", "skipped"] as const;
export type InternalTaskStatus = (typeof INTERNAL_TASK_STATUSES)[number];
export const INTERNAL_TASK_DATE_FIELDS = ["due", "planned", "none"] as const;
export type InternalTaskDateField = (typeof INTERNAL_TASK_DATE_FIELDS)[number];
export const INTERNAL_TASK_ACTIONS = ["complete", "reopen", "skip", "unskip"] as const;
export type InternalTaskAction = (typeof INTERNAL_TASK_ACTIONS)[number];
export class InternalTaskInputError extends Error {}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const EDITABLE_FIELDS = new Set(["title", "due", "planned", "priority", "memo", "tags", "recurrence", "progress"]);

export function parseInternalTaskWrite(value: unknown, { create = false }: { create?: boolean } = {}): TaskWriteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InternalTaskInputError("body_must_be_object");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !EDITABLE_FIELDS.has(key));
  if (unknown.length) throw new InternalTaskInputError(`unknown_field:${unknown[0]}`);
  const result: TaskWriteInput = {};
  if ("title" in body) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 500) throw new InternalTaskInputError("invalid_title");
    result.title = body.title.trim();
  }
  if (create && !result.title) throw new InternalTaskInputError("title_required");
  for (const field of ["due", "planned"] as const) {
    if (!(field in body)) continue;
    const item = body[field];
    if (item !== null && (typeof item !== "string" || !isTaskDate(item))) throw new InternalTaskInputError(`invalid_${field}`);
    result[field] = item;
  }
  for (const field of ["priority", "memo", "recurrence", "progress"] as const) {
    if (!(field in body)) continue;
    const item = body[field];
    if (item !== null && (typeof item !== "string" || item.length > 2000)) throw new InternalTaskInputError(`invalid_${field}`);
    result[field] = item;
  }
  if ("tags" in body) {
    if (!Array.isArray(body.tags) || body.tags.length > 50 || body.tags.some((tag) => typeof tag !== "string" || !tag || tag.length > 100)) throw new InternalTaskInputError("invalid_tags");
    result.tags = body.tags as string[];
  }
  if (!create && Object.keys(result).length === 0) throw new InternalTaskInputError("empty_update");
  return result;
}

function isTaskDate(value: string): boolean {
  return isRealDateKey(value) || (DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)));
}

export function parseTaskAction(value: unknown): InternalTaskAction {
  if (typeof value !== "string" || !(INTERNAL_TASK_ACTIONS as readonly string[]).includes(value)) throw new InternalTaskInputError("invalid_action");
  return value as InternalTaskAction;
}

/**
 * 一覧の日付絞り込み。`none` は期限・予定日のどちらも無いタスク（from/to は無視）。
 * `due` / `planned` は日付部分（先頭10文字）を from/to の両端を含めて比べ、値が無いタスクは除く。
 */
export function matchesInternalDate(
  task: { due: string | null; planned: string | null },
  input: { dateField: InternalTaskDateField; from?: string; to?: string },
): boolean {
  if (input.dateField === "none") return task.due === null && task.planned === null;
  const value = input.dateField === "due" ? task.due : task.planned;
  if (!value) return false;
  const key = value.slice(0, 10);
  return (!input.from || key >= input.from) && (!input.to || key <= input.to);
}
