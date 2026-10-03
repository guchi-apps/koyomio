import type { GoogleAccount, TaskEventLink } from "@prisma/client";

import { db } from "@/lib/db";
import { placeDisplayName } from "@/lib/place-text";
import { getNotionConnection } from "@/services/calendar/write-context";
import { getEvent, toCalendarItems } from "@/services/google-calendar/events";
import { createNotionClient } from "@/services/notion/client";
import type { PropertyMap } from "@/services/notion/task-database";
import { updateTask, type TaskWriteInput } from "@/services/notion/tasks";
import type {
  CalendarEventItem,
  TaskEventLinkItem,
  TaskEventStage,
  TaskItem,
  TaskLinkTarget,
  TravelItem,
} from "@/types/calendar";
import { TASK_LINK_TARGET_LABELS } from "@/types/calendar";

import { isSameTaskDate, resolveStageDate } from "./stage";

/**
 * タスクと予定の紐づけ（docs/spec.md §31）。
 *
 * 紐づけ本体はDaySpanのDBにあり、そこから決まる日時はNotionのタスクの「期限」か「予定日」へ
 * 書き込む。どちらへ入れるかは紐づけの行き先（target）で決まる。既存の日付へ入れるのは、
 * カレンダーの取得・描画をそのまま使えるようにするため。新しい枠を足すと、1つのタスクが
 * 期限・予定日と合わせて3枠に現れることになる。
 *
 * 書き込みの順序はNotionが先、DaySpanのDBが後にする。逆にすると、Notionへの書き込みが
 * 失敗したときに「紐づいているのに日付が入っていない」行が残る。先にNotionへ入れておけば、
 * DBの保存で失敗しても残るのは普通の期限・予定日だけで、もう一度紐づければやり直せる。
 */

/**
 * 予定名の写しの上限。Prismaの String は varchar(191) で作られるため、これを超える名前を
 * そのまま入れると保存そのものが失敗する。表示のためだけに持っている値なので、切って通す。
 */
const EVENT_TITLE_LIMIT = 191;

function toEventTitle(title: string): string {
  return title.length > EVENT_TITLE_LIMIT ? title.slice(0, EVENT_TITLE_LIMIT) : title;
}

/** 画面へ返せる理由を持つ失敗。外部APIの失敗（TaskLinkExternalError）とは分けて扱う。 */
export class TaskLinkError extends Error {}

/**
 * 外部APIの失敗。紐づけはGoogle（予定の取得）とNotion（期限・予定日の書き込み）の両方を通るため、
 * どちらで落ちたかを持ったまま呼び出し元へ返す。握りつぶすと、スコープ不足なのか
 * プロパティ不足なのかを画面からもログからも切り分けられなくなる（docs/spec.md §26）。
 */
export class TaskLinkExternalError extends Error {
  constructor(
    readonly source: "google" | "notion",
    readonly operation: string,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

export type TaskLinkInput = {
  taskId: string;
  /** 紐づけ先が移動のときは travelId を渡す（calendarId / eventId は使わない）。 */
  travelId?: string;
  calendarId: string;
  eventId: string;
  stage: TaskEventStage;
  /** 決まった日時の行き先。期限と予定日で別の予定へ紐づけられる。 */
  target: TaskLinkTarget;
};

export async function listTaskLinks(userId: string): Promise<TaskEventLink[]> {
  return db.taskEventLink.findMany({ where: { userId } });
}

export async function getTaskLink(userId: string, linkId: string): Promise<TaskEventLink | null> {
  return db.taskEventLink.findFirst({ where: { id: linkId, userId } });
}

export async function getTaskLinkByTaskId(
  userId: string,
  taskId: string,
  target: TaskLinkTarget,
): Promise<TaskEventLink | null> {
  return db.taskEventLink.findUnique({
    where: { userId_taskId_target: { userId, taskId, target } },
  });
}

/**
 * 期限・予定日の直接更新が紐づけ先と異なるとき、該当する行き先だけを外す。
 * ブラウザーAPIと内部APIが同じ規則を通るよう、ルートからここへ集約する。
 */
export async function unlinkOverriddenTaskDateLinks(
  userId: string,
  taskId: string,
  input: Pick<TaskWriteInput, "due" | "planned">,
): Promise<void> {
  for (const target of ["DUE", "PLANNED"] as const) {
    const date = target === "DUE" ? input.due : input.planned;
    if (date === undefined) continue;

    const link = await getTaskLinkByTaskId(userId, taskId, target);
    if (!link) continue;

    const resolved = link.resolvedAt.toISOString();
    const same = isSameTaskDate(
      { date, allDay: date ? !date.includes("T") : false },
      {
        date: link.resolvedAllDay ? resolved.slice(0, 10) : resolved,
        allDay: link.resolvedAllDay,
      },
    );
    if (!same) await unlinkTask(userId, link.id);
  }
}

/** DBに入っている解決済みの日時を、タスクの日付と同じ形（日付のみ／ISO 8601）へ戻す。 */
function resolvedDate(link: TaskEventLink): string {
  const iso = link.resolvedAt.toISOString();
  return link.resolvedAllDay ? iso.slice(0, 10) : iso;
}

/** 日付のみは その日の00:00(UTC) として持つ。日付のみかどうかは resolvedAllDay で分ける。 */
function toResolvedColumns(resolved: { date: string; allDay: boolean }) {
  return {
    resolvedAt: new Date(resolved.allDay ? `${resolved.date}T00:00:00Z` : resolved.date),
    resolvedAllDay: resolved.allDay,
  };
}

/** 行き先に当たるタスクの日付。ずれの判定と、書き込み先の選択の両方で同じ組を使う。 */
export function taskDateForTarget(
  task: Pick<TaskItem, "due" | "hasTime" | "planned" | "plannedHasTime">,
  target: TaskLinkTarget,
): { date: string | null; allDay: boolean } {
  return target === "DUE"
    ? { date: task.due, allDay: !task.hasTime }
    : { date: task.planned, allDay: !task.plannedHasTime };
}

/**
 * タスクへ紐づけを付ける。
 *
 * 予定が手元にある（＝カレンダーの取得範囲に入っている）ときは、予定名を最新の値へ差し替え、
 * 行き先の日付とのずれも判定する。予定が無いときはずれを判定しない。取得範囲の外にあるだけ
 * なのか、予定が消えているのかをここでは区別できず、消えたことにすると範囲を送るたびに
 * 警告が出るため。
 */
export function attachTaskLinks(
  tasks: TaskItem[],
  links: TaskEventLink[],
  eventsById?: Map<string, CalendarEventItem>,
  travelsById?: Map<string, Pick<TravelItem, "start" | "end" | "title">>,
): TaskItem[] {
  if (links.length === 0) return tasks;

  // 紐づけは行き先ごとに1件のため、1つのタスクに最大2件（期限・予定日）が並ぶ。
  const byTaskId = new Map<string, TaskEventLink[]>();
  for (const link of links) {
    const list = byTaskId.get(link.taskId);
    if (list) list.push(link);
    else byTaskId.set(link.taskId, [link]);
  }

  return tasks.map((task) => {
    const found = byTaskId.get(task.id);
    if (!found) return task;

    const items = found.map((link) => {
      // 移動への紐づけは移動の出発・到着から決まる。移動は終日にならない。
      const travel = link.travelId ? travelsById?.get(link.travelId) : undefined;
      const event: Pick<CalendarEventItem, "allDay" | "start" | "end" | "title"> | undefined =
        link.travelId
          ? travel && { allDay: false, start: travel.start, end: travel.end, title: travel.title }
          : eventsById?.get(link.eventId);
      const stage = link.stage as TaskEventStage;
      const target = link.target as TaskLinkTarget;
      const expected = event ? resolveStageDate(event, stage) : null;
      const drifted = expected
        ? !isSameTaskDate(taskDateForTarget(task, target), {
            date: expected.date,
            allDay: expected.allDay,
          })
        : false;

      const item: TaskEventLinkItem = {
        id: link.id,
        taskId: link.taskId,
        calendarId: link.calendarId,
        eventId: link.eventId,
        travelId: link.travelId,
        stage,
        target,
        eventTitle: event?.title ?? link.eventTitle,
        resolvedAt: resolvedDate(link),
        resolvedAllDay: link.resolvedAllDay,
        drifted,
        expectedAt: drifted && expected ? expected.date : null,
      };

      return item;
    });

    // 並びは期限・予定日の順で固定する。DBの返す順に任せると、画面の欄が保存のたびに入れ替わる。
    items.sort((a, b) => (a.target === b.target ? 0 : a.target === "DUE" ? -1 : 1));

    return { ...task, links: items };
  });
}

/**
 * 紐づけ先の予定を1件取得する。
 *
 * 「使用」がオフのカレンダーでも取得する。紐づけはGoogleへ書き込まないため、
 * resolveGoogleAccountForCalendar() の書き込み判定を通す必要が無い。見たいだけの
 * カレンダー（共有された予定表）に対しても、その予定に合わせたタスクは置ける。
 */
async function fetchLinkedEvent(
  userId: string,
  calendarId: string,
  eventId: string,
): Promise<CalendarEventItem | null> {
  const setting = await db.calendarSetting.findFirst({
    where: { userId, calendarId },
    include: { googleAccount: true },
  });
  if (!setting) return null;

  return getLinkedEvent(setting.googleAccount, calendarId, eventId);
}

async function getLinkedEvent(
  account: GoogleAccount,
  calendarId: string,
  eventId: string,
): Promise<CalendarEventItem | null> {
  let event;
  try {
    event = await getEvent(account, calendarId, eventId);
  } catch (error) {
    // 予定が消えている場合の404・410は「見つからない」として扱い、紐づけを外す案内へ回す。
    if (isMissingEventError(error)) return null;
    throw new TaskLinkExternalError("google", "紐づけ先の予定の取得", error);
  }

  if (event.status === "cancelled") return null;

  // 名前・色は紐づけでは使わないが、終日の終了日の扱いを一覧と揃えるため同じ変換を通す。
  const [item] = toCalendarItems([event], {
    calendarId,
    name: "",
    color: null,
    readOnly: false,
  });

  return item ?? null;
}

/**
 * 決まった日時をNotionのタスクの行き先（期限・予定日）へ入れる。
 *
 * 期限はタスクDBの必須プロパティのため常に置けるが、予定日は任意で、無いDBがある。
 * その場合は行き先が無いことをそのまま断る（黙って落とすと、紐づけたつもりのタスクが残る）。
 */
async function writeResolvedDate(
  userId: string,
  taskId: string,
  target: TaskLinkTarget,
  date: string,
): Promise<void> {
  const connection = await getNotionConnection(userId);
  if (!connection) {
    throw new TaskLinkError("Notionのタスクが接続されていません。");
  }

  const label = TASK_LINK_TARGET_LABELS[target];
  const input: TaskWriteInput = target === "DUE" ? { due: date } : { planned: date };

  const propertyMap = (connection.propertyMap as PropertyMap | null) ?? {};
  if (!propertyMap[target === "DUE" ? "due" : "planned"]) {
    throw new TaskLinkError(
      `タスクDBに「${label}」のプロパティがありません。Notionへ足してから、設定画面でタスクDBを選び直してください。`,
    );
  }

  try {
    await updateTask(createNotionClient(connection), connection, taskId, input);
  } catch (error) {
    throw new TaskLinkExternalError("notion", `タスクの${label}の更新`, error);
  }
}

/** 移動の表示名。toTravelItem() と同じく、住所を除いた場所名で組み立てる。 */
function travelTitle(plan: { origin: string; destination: string }): string {
  return `${placeDisplayName(plan.origin)} → ${placeDisplayName(plan.destination)}`;
}

/**
 * 紐づけ先の移動を1件取得する（issue #914）。移動の本体はDaySpanのDBにあり、外部APIの往復は無い。
 * 段階の起点は出発（start）と到着（end）。移動は必ず時刻を持つため終日にはならない。
 */
async function fetchLinkedTravel(
  userId: string,
  travelId: string,
): Promise<Pick<CalendarEventItem, "allDay" | "start" | "end" | "title"> | null> {
  const plan = await db.travelPlan.findFirst({ where: { id: travelId, userId } });
  if (!plan) return null;

  return {
    allDay: false,
    start: plan.departAt.toISOString(),
    end: plan.arriveAt.toISOString(),
    title: travelTitle(plan),
  };
}

/** Googleが「その予定は無い」と答えたか。googleCalendarFetch はステータスを文面に含める。 */
function isMissingEventError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(404|410)\b/.test(message);
}

/**
 * 紐づける。同じ行き先の紐づけがすでにあるときは、その1件を置き換える（行き先ごとに1件）。
 * もう一方の行き先の紐づけはそのまま残る。
 */
export async function linkTaskToEvent(
  userId: string,
  input: TaskLinkInput,
): Promise<{ link: TaskEventLink; date: string }> {
  const travelId = input.travelId ?? null;
  // 移動への紐づけでは、移動をDBから引いて出発・到着を段階の起点にする（issue #914）。
  const event = travelId
    ? await fetchLinkedTravel(userId, travelId)
    : await fetchLinkedEvent(userId, input.calendarId, input.eventId);
  if (!event) {
    throw new TaskLinkError(
      travelId ? "紐づけ先の移動が見つかりませんでした。" : "紐づけ先の予定が見つかりませんでした。",
    );
  }

  const resolved = resolveStageDate(event, input.stage);
  await writeResolvedDate(userId, input.taskId, input.target, resolved.date);

  const data = {
    calendarId: travelId ? "" : input.calendarId,
    eventId: travelId ? "" : input.eventId,
    travelId,
    stage: input.stage,
    eventTitle: toEventTitle(event.title),
    ...toResolvedColumns(resolved),
  };

  const link = await db.taskEventLink.upsert({
    where: { userId_taskId_target: { userId, taskId: input.taskId, target: input.target } },
    create: { userId, taskId: input.taskId, target: input.target, ...data },
    update: data,
  });

  return { link, date: resolved.date };
}

/**
 * 紐づけを解決し直す。段階を変えたときと、「予定に合わせる」を押したときの両方で通る。
 * 行き先は変えない（別の行き先へ移すのは、解除してから紐づけ直す操作にする）。
 *
 * DaySpanの外（Googleカレンダーのアプリなど）で予定が動いた場合、カレンダーを取得するたびに
 * Notionへ書き戻すことはしない。読み取りの途中で外部APIへの書き込みが積み上がるため
 * （docs/spec.md §20）。ずれは画面に出し、押されたときにここを通す。
 */
export async function resyncTaskLink(
  userId: string,
  linkId: string,
  stage?: TaskEventStage,
): Promise<{ link: TaskEventLink; date: string }> {
  const existing = await getTaskLink(userId, linkId);
  if (!existing) {
    throw new TaskLinkError("紐づけが見つかりませんでした。");
  }

  const event = existing.travelId
    ? await fetchLinkedTravel(userId, existing.travelId)
    : await fetchLinkedEvent(userId, existing.calendarId, existing.eventId);
  if (!event) {
    throw new TaskLinkError(
      existing.travelId
        ? "紐づけ先の移動が見つかりませんでした。移動が消えている場合は紐づけを解除してください。"
        : "紐づけ先の予定が見つかりませんでした。予定が消えている場合は紐づけを解除してください。",
    );
  }

  const nextStage = stage ?? (existing.stage as TaskEventStage);
  const resolved = resolveStageDate(event, nextStage);
  await writeResolvedDate(
    userId,
    existing.taskId,
    existing.target as TaskLinkTarget,
    resolved.date,
  );

  const link = await db.taskEventLink.update({
    where: { id: existing.id },
    data: { stage: nextStage, eventTitle: toEventTitle(event.title), ...toResolvedColumns(resolved) },
  });

  return { link, date: resolved.date };
}

/**
 * 紐づけを外す。入っている日付（期限・予定日）はそのまま残す。
 *
 * 消してしまうと、紐づけを外しただけで「いつまでにやるつもりだったか」まで失われる。
 * 要らなければその日付を未設定にすればよく、そちらは元に戻せる操作ではない。
 */
export async function unlinkTask(userId: string, linkId: string): Promise<boolean> {
  const existing = await getTaskLink(userId, linkId);
  if (!existing) return false;

  await db.taskEventLink.delete({ where: { id: existing.id } });
  return true;
}

/** タスクを消した・完了で作り直したときに、そのタスクの紐づけを外す。 */
export async function unlinkTaskByTaskId(userId: string, taskId: string): Promise<void> {
  await db.taskEventLink.deleteMany({ where: { userId, taskId } });
}

/**
 * 予定が動いたときに、紐づいたタスクの日付（行き先）を追随させる。
 *
 * 予定の更新そのものは成功しているため、ここでの失敗で応答全体を失敗にしない。
 * 追随できなかった紐づけは日付がずれたまま残り、次に画面へ出たときにずれとして示される。
 */
export async function syncLinksForEvent(
  userId: string,
  eventId: string,
  event: Pick<CalendarEventItem, "allDay" | "start" | "end" | "title">,
): Promise<{ synced: number; failed: number }> {
  const links = await db.taskEventLink.findMany({ where: { userId, eventId } });
  if (links.length === 0) return { synced: 0, failed: 0 };

  let synced = 0;
  let failed = 0;

  for (const link of links) {
    const resolved = resolveStageDate(event, link.stage as TaskEventStage);
    try {
      await writeResolvedDate(userId, link.taskId, link.target as TaskLinkTarget, resolved.date);
      await db.taskEventLink.update({
        where: { id: link.id },
        data: { eventTitle: toEventTitle(event.title), ...toResolvedColumns(resolved) },
      });
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error(
        "[dayspan] task link sync failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { synced, failed };
}

/**
 * 予定を消したときに紐づけを外す（入っている日付は残す）。
 *
 * 画面に出ている繰り返し予定は展開した1回分で、IDは `<親のID>_<日時>` の形になる。
 * シリーズ全体・これ以降を消した場合は消えた回のぶんだけ外す必要があるため、
 * 親のIDを前にした範囲で引く。
 */
export async function dropLinksForEvent(
  userId: string,
  eventId: string,
  scope: "single" | "following" | "all",
): Promise<number> {
  const separator = eventId.indexOf("_");

  if (scope === "single" || separator < 0) {
    const result = await db.taskEventLink.deleteMany({ where: { userId, eventId } });
    return result.count;
  }

  const prefix = `${eventId.slice(0, separator)}_`;
  const result = await db.taskEventLink.deleteMany({
    where: {
      userId,
      // 回のIDは `<親のID>_YYYYMMDDTHHMMSSZ` で桁が揃っているため、文字列の大小で前後を比べられる。
      eventId: scope === "all" ? { startsWith: prefix } : { startsWith: prefix, gte: eventId },
    },
  });

  return result.count;
}

/**
 * 移動が動いたときに、紐づいたタスクの日付（行き先）を追随させる（issue #914）。
 * 予定の場合（syncLinksForEvent）と同じく、失敗しても移動の更新そのものは成功のまま扱う。
 */
export async function syncLinksForTravel(
  userId: string,
  travelId: string,
  travel: { departAt: Date; arriveAt: Date; origin: string; destination: string },
): Promise<{ synced: number; failed: number }> {
  const links = await db.taskEventLink.findMany({ where: { userId, travelId } });
  if (links.length === 0) return { synced: 0, failed: 0 };

  const event = {
    allDay: false,
    start: travel.departAt.toISOString(),
    end: travel.arriveAt.toISOString(),
    title: travelTitle(travel),
  };

  let synced = 0;
  let failed = 0;

  for (const link of links) {
    const resolved = resolveStageDate(event, link.stage as TaskEventStage);
    try {
      await writeResolvedDate(userId, link.taskId, link.target as TaskLinkTarget, resolved.date);
      await db.taskEventLink.update({
        where: { id: link.id },
        data: { eventTitle: toEventTitle(event.title), ...toResolvedColumns(resolved) },
      });
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error(
        "[dayspan] task link sync (travel) failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { synced, failed };
}

/** 移動を消したときに紐づけを外す（入っている日付は残す）。 */
export async function dropLinksForTravel(userId: string, travelId: string): Promise<number> {
  const result = await db.taskEventLink.deleteMany({ where: { userId, travelId } });
  return result.count;
}
