import { calendarWriteError, externalApiError } from "@/lib/api-error";
import { db } from "@/lib/db";
import { requireInternalEventsApiKey, resolveInternalUserId } from "@/lib/internal-auth";
import { dropOutcomesForEvent } from "@/services/calendar/event-outcomes";
import { dropNotificationSettingsForEvent } from "@/services/calendar/event-notification-settings";
import { resolveGoogleAccountForCalendar } from "@/services/calendar/write-context";
import { deleteEventWithScope, getEvent, updateEvent } from "@/services/google-calendar/events";
import { mergeInternalEventUpdate } from "@/services/internal/event-update";
import { dropLinksForEvent, syncLinksForEvent } from "@/services/task-links/links";
import type { InternalUpdateEventRequest } from "@/types/internal-api";

const UPDATE_FIELDS = [
  "title",
  "date",
  "endDate",
  "startTime",
  "endTime",
  "allDay",
  "location",
  "tentative",
];

/**
 * サーバー間（AIDE）から予定を1件更新する（docs/internal-api.md・issue #805）。
 *
 * 認証は作成と同じ `DAYSPAN_INTERNAL_EVENTS_API_KEY`。ブラウザ用の `PATCH /api/events/[eventId]` と同じ
 * 更新処理（`updateEvent`・書き込み可否の判定・紐づけたタスクの日付の追随）を通す。
 * 送った項目だけを変える。対象は `calendarId` と予定のIDで必ず名指しさせる。
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const unauthorized = await requireInternalEventsApiKey(request);
  if (unauthorized) return unauthorized;

  let body: InternalUpdateEventRequest;
  try {
    body = (await request.json()) as InternalUpdateEventRequest;
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }

  const calendarId = body.calendarId?.trim();
  if (!calendarId) return json({ error: "calendarId is required" }, 400);
  if (!UPDATE_FIELDS.some((field) => (body as Record<string, unknown>)[field] !== undefined)) {
    return json({ error: "at least one field to update is required" }, 400);
  }

  const { eventId } = await params;

  try {
    const userId = await resolveInternalUserId(request);
    if (!userId) return json({ error: "target_user_not_resolvable" }, 500);

    const target = await resolveGoogleAccountForCalendar(userId, calendarId);
    if (!target.ok) return calendarWriteError(target.reason);

    const existing = await getEvent(target.account, calendarId, eventId);
    if (existing.status === "cancelled") return json({ error: "event_not_found" }, 404);

    const uiSetting = await db.uiSetting.findUnique({ where: { userId } });
    const timeZone = uiSetting?.timeZone ?? "Asia/Tokyo";

    const merged = mergeInternalEventUpdate(existing, body, timeZone);
    if (!merged.ok) {
      return json({ error: merged.error, message: merged.message }, merged.status);
    }

    await updateEvent(target.account, calendarId, eventId, merged.input);

    // 紐づいたタスクの日付を動かした先へ合わせる（ブラウザ用の更新と同じ。docs/spec.md §31）。
    await syncLinksForEvent(userId, eventId, {
      allDay: merged.input.allDay,
      start: merged.input.start,
      end: merged.input.end,
      title: merged.input.title,
    });

    return json({ id: eventId, url: existing.htmlLink ?? null }, 200);
  } catch (error) {
    return externalApiError("google", "予定の更新", error);
  }
}

/**
 * サーバー間（AIDE）から予定を1件削除する（issue #805）。
 *
 * 誤操作の影響を抑えるため、ブラウザ用より絞る。
 * - `calendarId` と、削除する予定の現在の `title` の両方を必須にする。IDの取り違え・
 *   復唱と違う予定への操作は、タイトルが一致しないことで `409` になり何も消えない
 * - 消せるのは1回分だけ（繰り返しの「これ以降」「すべて」は無い）。繰り返しの親のIDも断る
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const unauthorized = await requireInternalEventsApiKey(request);
  if (unauthorized) return unauthorized;

  const searchParams = new URL(request.url).searchParams;
  const calendarId = searchParams.get("calendarId")?.trim();
  const expectedTitle = searchParams.get("title")?.trim();
  if (!calendarId) return json({ error: "calendarId is required" }, 400);
  if (!expectedTitle) return json({ error: "title is required" }, 400);

  const { eventId } = await params;

  try {
    const userId = await resolveInternalUserId(request);
    if (!userId) return json({ error: "target_user_not_resolvable" }, 500);

    const target = await resolveGoogleAccountForCalendar(userId, calendarId);
    if (!target.ok) return calendarWriteError(target.reason);

    const existing = await getEvent(target.account, calendarId, eventId);
    if (existing.status === "cancelled") return json({ error: "event_not_found" }, 404);

    if (existing.recurrence?.length) {
      return json(
        {
          error: "recurring_master_unsupported",
          message: "繰り返しの元の予定（シリーズ全体）は削除できません。1回分のIDを指定してください。",
        },
        409,
      );
    }

    if ((existing.summary ?? "").trim() !== expectedTitle) {
      return json(
        {
          error: "title_mismatch",
          message: "指定したタイトルと予定の現在のタイトルが一致しないため削除しませんでした。",
          currentTitle: existing.summary ?? "",
        },
        409,
      );
    }

    await deleteEventWithScope(target.account, calendarId, eventId, "single");
    await dropLinksForEvent(userId, eventId, "single");
    await dropOutcomesForEvent(userId, eventId, "single");
    await dropNotificationSettingsForEvent(userId, eventId, "single");

    return json({ ok: true }, 200);
  } catch (error) {
    return externalApiError("google", "予定の削除", error);
  }
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
