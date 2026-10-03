import type { Client } from "@notionhq/client";
import type { NotionConnection } from "@prisma/client";

import type { TaskItem } from "@/types/calendar";

import type { NotionQueryFilter } from "./client";
import { formatRecurrence, nextDue, parseRecurrence } from "./recurrence";
import { externalApiMessage } from "@/lib/api-error";
import { db } from "@/lib/db";

import { taskRangeFilter, type OverdueTaskRange } from "./task-query-filter";

import {
  resolveRefreshedPropertyMap,
  SKIPPED_OUTCOME,
  validateTaskDataSource,
  type PropertyMap,
} from "./task-database";

// Notionのページプロパティは型ごとに形が違ううえ、完了状態や優先度は
// ユーザーの設定次第で checkbox / status / select のどれにもなりうる。
// 読み取り側で実際の type を見て解釈する。

type NotionPropertyValue = {
  type?: string;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  checkbox?: boolean;
  status?: { name?: string } | null;
  select?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
  date?: { start?: string | null; end?: string | null } | null;
};

export type NotionTaskPage = {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, NotionPropertyValue>;
};

const DONE_STATUS_PATTERN = /完了|done|complete|済/i;

function plainText(items: Array<{ plain_text?: string }> | undefined): string {
  if (!items || items.length === 0) return "";
  return items.map((item) => item.plain_text ?? "").join("").trim();
}

function readDone(property: NotionPropertyValue | undefined): boolean {
  if (!property) return false;
  if (property.type === "checkbox") return Boolean(property.checkbox);
  // status型はグループ（未着手/進行中/完了）をAPIから判別できないため、名前で判定する。
  if (property.type === "status") return DONE_STATUS_PATTERN.test(property.status?.name ?? "");
  return false;
}

function readChoice(property: NotionPropertyValue | undefined): string | null {
  if (!property) return null;
  if (property.type === "select") return property.select?.name ?? null;
  if (property.type === "status") return property.status?.name ?? null;
  return null;
}

export function normalizeTask(page: NotionTaskPage, propertyMap: PropertyMap): TaskItem {
  const properties = page.properties ?? {};
  const get = (field: keyof PropertyMap) => {
    const name = propertyMap[field];
    return name ? properties[name] : undefined;
  };

  const dateStart = (property: NotionPropertyValue | undefined): string | null =>
    property?.type === "date" ? (property.date?.start ?? null) : null;

  const dueStart = dateStart(get("due"));
  const plannedStart = dateStart(get("planned"));

  const skipped = readChoice(get("outcome")) === SKIPPED_OUTCOME;

  return {
    kind: "task",
    id: page.id,
    title: plainText(get("title")?.title) || "(タイトルなし)",
    due: dueStart,
    // Notionの日付は「日付のみ」なら YYYY-MM-DD、時刻ありなら時刻部分を含む。
    hasTime: Boolean(dueStart && dueStart.includes("T")),
    planned: plannedStart,
    plannedHasTime: Boolean(plannedStart && plannedStart.includes("T")),
    // 「対応しない」は完了と同じく片付いたものとして扱う（docs/spec.md §12）。
    done: readDone(get("done")) || skipped,
    skipped,
    canSkip: Boolean(propertyMap.outcome),
    // 進捗（issue #873）。完了とは独立に持つ。プロパティが無いDBでは null / false。
    progress: readChoice(get("progress")),
    canProgress: Boolean(propertyMap.progress),
    priority: readChoice(get("priority")),
    tags: (get("tags")?.multi_select ?? []).map((tag) => tag.name ?? "").filter(Boolean),
    memo: plainText(get("memo")?.rich_text) || null,
    recurrence: readChoice(get("recurrence")),
    // 予定への紐づけはDaySpanのDBにある（docs/spec.md §31）。Notionの応答からは分からないため、
    // ここでは空にしておき、読み込み側（services/task-links/links.ts）で埋める。
    links: [],
    url: page.url ?? null,
  };
}

export async function queryTaskPages(
  notion: Client,
  dataSourceId: string,
  filter: NotionQueryFilter | undefined,
): Promise<NotionTaskPage[]> {
  const pages: NotionTaskPage[] = [];
  let cursor: string | undefined;

  do {
    const response = await queryTaskPage(notion, dataSourceId, filter, cursor);
    pages.push(...response.pages);
    cursor = response.nextCursor ?? undefined;
  } while (cursor);

  return pages;
}

/** 一覧API向けの1ページだけのNotion問い合わせ。全件取得が必要な画面用の関数と分ける。 */
export async function queryTaskPage(
  notion: Client,
  dataSourceId: string,
  filter: NotionQueryFilter | undefined,
  cursor?: string,
  pageSize = 100,
): Promise<{ pages: NotionTaskPage[]; nextCursor: string | null }> {
  const response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    page_size: pageSize,
    ...(filter ? { filter } : {}),
    ...(cursor ? { start_cursor: cursor } : {}),
  });
  const pages = response.results
    .filter((result) => result.object === "page" && "properties" in result)
    .map((result) => result as NotionTaskPage);
  return { pages, nextCursor: response.has_more ? (response.next_cursor ?? null) : null };
}

/** 対応付けの取り直しの間隔。取得のたびに `dataSources.retrieve` が1往復増えるのを避ける（docs/spec.md §20）。 */
const PROPERTY_MAP_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Notion側でプロパティを足した・改名した場合に追従できるよう、保存済みの対応付けを
 * 一定間隔で取り直す。読み取りだけで、Notionは書き換えない。
 * 失敗しても既存の対応付けで続行する（タスクの取得自体は止めない）。
 * `lastValidatedAt` は他のDB（勤務・場所など）の検証でも更新されるため、間隔は目安になる。
 */
export async function refreshTaskPropertyMapIfStale(
  notion: Client,
  connection: NotionConnection,
  { force = false }: { force?: boolean } = {},
): Promise<NotionConnection> {
  if (!connection.taskDataSourceId) return connection;
  const validatedAt = connection.lastValidatedAt?.getTime() ?? 0;
  if (!force && Date.now() - validatedAt < PROPERTY_MAP_REFRESH_MS) return connection;

  try {
    const validation = await validateTaskDataSource(notion, connection.taskDataSourceId);
    const next = resolveRefreshedPropertyMap(
      connection.propertyMap as PropertyMap | null,
      validation,
    );
    const updated = await db.notionConnection.update({
      where: { userId: connection.userId },
      data: {
        ...(next ? { propertyMap: next } : {}),
        lastValidatedAt: new Date(),
      },
    });
    return updated;
  } catch (error) {
    externalApiMessage("notion", "タスクDBの対応付けの再取得", error);
    return connection;
  }
}

/**
 * 指定期間に期限または予定日があるタスクを取得する。
 * どちらも未設定のタスクはカレンダーに置く日が決まらないため取得しない（docs/spec.md §10）。
 * 完了したタスクもカレンダーには出さない。履歴はタスク画面の「完了」から確認できる（docs/spec.md §12）。
 *
 * 予定日だけが期間内のタスクも要る。期限が半年先でも、予定日がこの月にあれば
 * その日のカレンダーに出す必要があるため、期限での絞り込みだけでは足りない。
 *
 * 完了状態はcheckbox/statusのどちらでもありえ、Notion側のフィルタ条件を型ごとに
 * 出し分けるより、取得後にnormalizeTaskの判定結果で絞るほうが単純なため後段で除く。
 */
export async function listTasksInRange(
  notion: Client,
  initialConnection: NotionConnection,
  range: { from: string; to: string },
  options?: { overdueRange?: OverdueTaskRange },
): Promise<TaskItem[]> {
  const connection = await refreshTaskPropertyMapIfStale(notion, initialConnection);
  const propertyMap = (connection.propertyMap as PropertyMap | null) ?? {};
  const dueProperty = propertyMap.due;

  if (!connection.taskDataSourceId || !dueProperty) return [];

  const pages = await queryTaskPages(
    notion,
    connection.taskDataSourceId,
    taskRangeFilter(dueProperty, propertyMap.planned, range, options?.overdueRange),
  );

  return pages.map((page) => normalizeTask(page, propertyMap)).filter((task) => !task.done);
}

/** タスク画面用に全件取得する（期限未設定・完了済みを含む）。 */
export async function listAllTasks(
  notion: Client,
  initialConnection: NotionConnection,
): Promise<TaskItem[]> {
  const connection = await refreshTaskPropertyMapIfStale(notion, initialConnection);
  const propertyMap = (connection.propertyMap as PropertyMap | null) ?? {};
  if (!connection.taskDataSourceId) return [];

  const pages = await queryTaskPages(notion, connection.taskDataSourceId, undefined);
  return pages.map((page) => normalizeTask(page, propertyMap));
}

// --- タスクの作成・更新・完了 ---

export type TaskWriteInput = {
  title?: string;
  /** YYYY-MM-DD（日付のみ）/ ISO 8601（時刻あり）/ null（期限未設定） */
  due?: string | null;
  /** 予定日。期限と同じ形式で、null は未設定。 */
  planned?: string | null;
  done?: boolean;
  priority?: string | null;
  memo?: string | null;
  tags?: string[];
  recurrence?: string | null;
  /** 対応状況。null は未設定（issue #750）。 */
  outcome?: string | null;
  /** 進捗（「承認待ち」など。issue #873）。null は未設定。 */
  progress?: string | null;
};

/**
 * 入力をNotionのプロパティ形へ変換する。DBに存在しない項目（propertyMapに無いもの）は
 * 書き込まず黙って落とす。ユーザーのタスクDBに必須でない項目が無いのは正常なため。
 */
function toProperties(
  input: TaskWriteInput,
  propertyMap: PropertyMap,
  doneType: "checkbox" | "status",
  doneStatusNames: { done: string; notDone: string },
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const set = (field: keyof PropertyMap, value: unknown) => {
    const name = propertyMap[field];
    if (name) properties[name] = value;
  };

  if (input.title !== undefined) {
    set("title", { title: [{ type: "text", text: { content: input.title } }] });
  }

  if (input.due !== undefined) {
    set("due", { date: input.due ? { start: input.due } : null });
  }

  if (input.planned !== undefined) {
    set("planned", { date: input.planned ? { start: input.planned } : null });
  }

  if (input.done !== undefined) {
    if (doneType === "status") {
      set("done", {
        status: { name: input.done ? doneStatusNames.done : doneStatusNames.notDone },
      });
    } else {
      set("done", { checkbox: input.done });
    }
  }

  if (input.priority !== undefined) {
    set("priority", { select: input.priority ? { name: input.priority } : null });
  }

  if (input.memo !== undefined) {
    set("memo", {
      rich_text: input.memo ? [{ type: "text", text: { content: input.memo } }] : [],
    });
  }

  if (input.tags !== undefined) {
    set("tags", { multi_select: input.tags.map((name) => ({ name })) });
  }

  if (input.recurrence !== undefined) {
    set("recurrence", { select: input.recurrence ? { name: input.recurrence } : null });
  }

  if (input.outcome !== undefined) {
    set("outcome", { select: input.outcome ? { name: input.outcome } : null });
  }

  if (input.progress !== undefined) {
    set("progress", { select: input.progress ? { name: input.progress } : null });
  }

  return properties;
}

/** タスクDB以外のページを書き換えようとしたときのエラー。API側で403に変える。 */
export class TaskNotEditableError extends Error {
  constructor() {
    super("This page is not in the task data source");
    this.name = "TaskNotEditableError";
  }
}

/**
 * 対象ページがタスクDBのものか確かめ、取得したページをそのまま返す。
 *
 * ゴミの日DB・勤務記録DBのように外部アプリ（myroom）や別画面が正で、DaySpanから無条件に
 * 書き込んでよいとは限らないページを、APIから直接書き換えられないようにする。UIで入口を
 * 隠すだけだと、DaySpanのAPIや将来のMCPから直接呼ばれた要求が素通りするため、経路によらず
 * 同じ結果になるここで断る（買い物・勤務・日付リマインド・場所と同じ考え方）。
 *
 * 戻り値は `completeTask` が「変更前のタスク」を読むのにも使う（往復を増やさないため）。
 */
async function assertTaskPage(
  notion: Client,
  connection: NotionConnection,
  taskId: string,
): Promise<NotionTaskPage> {
  if (!connection.taskDataSourceId) throw new TaskNotEditableError();

  const page = await notion.pages.retrieve({ page_id: taskId });
  const parent = "parent" in page ? page.parent : null;
  const dataSourceId = parent?.type === "data_source_id" ? parent.data_source_id : null;
  // NotionのIDはハイフン付き・無しのどちらの表記でも同じものを指す。比較の前に揃える。
  const sameId = (a: string | null, b: string | null) =>
    a !== null &&
    b !== null &&
    a.replaceAll("-", "").toLowerCase() === b.replaceAll("-", "").toLowerCase();

  if (!sameId(dataSourceId, connection.taskDataSourceId)) throw new TaskNotEditableError();
  return page as NotionTaskPage;
}

/** 内部APIなどが版照合のために、所属確認済みのページを取得する。 */
export async function getTaskPage(
  notion: Client,
  connection: NotionConnection,
  taskId: string,
): Promise<NotionTaskPage> {
  return assertTaskPage(notion, connection, taskId);
}

/** 完了状態のプロパティがcheckboxかstatusかを、既存ページの値から判別する。 */
async function resolveDoneType(
  notion: Client,
  connection: NotionConnection,
  propertyMap: PropertyMap,
): Promise<"checkbox" | "status"> {
  const name = propertyMap.done;
  if (!name || !connection.taskDataSourceId) return "checkbox";

  const dataSource = await notion.dataSources.retrieve({
    data_source_id: connection.taskDataSourceId,
  });
  const property = (dataSource.properties as Record<string, { type?: string }>)[name];

  return property?.type === "status" ? "status" : "checkbox";
}

// status型の場合、完了/未完了に相当する選択肢名はDBごとに違う。よくある名前から推測する。
const DONE_STATUS_FALLBACK = { done: "完了", notDone: "未着手" };

export async function createTask(
  notion: Client,
  connection: NotionConnection,
  input: TaskWriteInput,
): Promise<{ id: string }> {
  const propertyMap = (connection.propertyMap as PropertyMap | null) ?? {};
  if (!connection.taskDataSourceId) throw new Error("Task data source is not configured");

  const doneType = await resolveDoneType(notion, connection, propertyMap);

  const page = await notion.pages.create({
    parent: { type: "data_source_id", data_source_id: connection.taskDataSourceId },
    properties: toProperties(
      { done: false, ...input },
      propertyMap,
      doneType,
      DONE_STATUS_FALLBACK,
    ) as never,
  });

  return { id: page.id };
}

/**
 * プロパティを書き込む本体。対象ページがタスクDBのものかの確認（`assertTaskPage`）を
 * 済ませたあとに呼ぶ内部関数で、単体では公開しない。
 */
async function writeTaskProperties(
  notion: Client,
  connection: NotionConnection,
  taskId: string,
  input: TaskWriteInput,
): Promise<void> {
  const propertyMap = (connection.propertyMap as PropertyMap | null) ?? {};
  const doneType = await resolveDoneType(notion, connection, propertyMap);

  await notion.pages.update({
    page_id: taskId,
    properties: toProperties(input, propertyMap, doneType, DONE_STATUS_FALLBACK) as never,
  });
}

export async function updateTask(
  notion: Client,
  connection: NotionConnection,
  taskId: string,
  input: TaskWriteInput,
): Promise<void> {
  await assertTaskPage(notion, connection, taskId);
  await writeTaskProperties(notion, connection, taskId, input);
}

/**
 * タスクを完了にする。繰り返し設定があれば次回分を新規作成する。
 * 完了した回は履歴としてNotionに残す（削除しない。docs/spec.md §12・§13）。
 */
export async function completeTask(
  notion: Client,
  connection: NotionConnection,
  taskId: string,
  done: boolean,
): Promise<{ nextTaskId: string | null }> {
  const propertyMap = (connection.propertyMap as PropertyMap | null) ?? {};

  const page = await assertTaskPage(notion, connection, taskId);
  const current = "properties" in page ? normalizeTask(page, propertyMap) : null;

  // 同じ完了要求がそのまま再送された場合、繰り返しの次回をもう1件作らない。
  // 冪等キーを持たない既存の画面経路でも最低限同じ回の重複を防ぐ。
  if (done && current?.done && !current.skipped) return { nextTaskId: null };

  // 「対応しない」から完了へ変える操作では、対応状況を外す（完了と対応しないは両立しない）。
  // 他の値（利用者が独自に足した選択肢）は触らない。
  // 対象ページの確認は上ですでに済んでいるため、往復を増やさないよう updateTask ではなく
  // writeTaskProperties を直接呼ぶ。
  await writeTaskProperties(notion, connection, taskId, {
    done,
    ...(current?.skipped ? { outcome: null } : {}),
  });

  // 未完了へ戻す操作では次回分を作らない。二重に増えてしまうため。
  if (!done || !current) return { nextTaskId: null };

  const recurrence = parseRecurrence(current.recurrence);
  const due = nextDue(current.due, recurrence);
  if (!due) return { nextTaskId: null };

  const created = await createTask(notion, connection, {
    title: current.title,
    due,
    // 予定日も同じ繰り返しで進める。前回の予定日をそのまま写すと、次回分が
    // 作られた時点で過ぎた日を指してしまうため。
    planned: nextDue(current.planned, recurrence),
    done: false,
    priority: current.priority,
    memo: current.memo,
    tags: current.tags,
    recurrence: formatRecurrence(recurrence),
  });

  return { nextTaskId: created.id };
}

/**
 * タスクを「対応しない」にする、または戻す（issue #750）。
 * 完了と違い、繰り返しの次回分は作らない。やらないと決めた回は次へ進めない扱いにする。
 * 完了状態も合わせて動かすのは、Notion側の一覧でも片付いたものとして並ぶようにするため。
 */
export async function skipTask(
  notion: Client,
  connection: NotionConnection,
  taskId: string,
  skipped: boolean,
): Promise<void> {
  const propertyMap = (connection.propertyMap as PropertyMap | null) ?? {};
  if (!propertyMap.outcome) throw new Error("このタスクDBには「対応状況」プロパティがありません。");

  await updateTask(notion, connection, taskId, {
    done: skipped,
    outcome: skipped ? SKIPPED_OUTCOME : null,
  });
}

/**
 * タスクを消す。完了したタスクは履歴として残す（docs/spec.md §12）が、
 * 要らなくなった・間違えて作ったタスクは残す意味がないため消せるようにする。
 * Notionのゴミ箱へ移すだけなので、間違えてもNotion側で戻せる。
 *
 * 繰り返しタスクは完了のたびに次回分を別ページとして作る方式のため、
 * ここで消えるのはこの回だけで、すでに作られた次回分は残る。
 */
export async function deleteTask(
  notion: Client,
  connection: NotionConnection,
  taskId: string,
): Promise<void> {
  await assertTaskPage(notion, connection, taskId);
  await notion.pages.update({ page_id: taskId, in_trash: true });
}
