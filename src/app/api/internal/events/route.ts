import { localInputToIso } from "@/components/calendar/datetime-fields";
import { calendarWriteError, externalApiError } from "@/lib/api-error";
import { isRealDateKey } from "@/lib/calendar-range";
import { db } from "@/lib/db";
import { requireInternalEventsApiKey, resolveInternalUserId } from "@/lib/internal-auth";
import {
  resolveDefaultCalendarId,
  resolveGoogleAccountForCalendar,
} from "@/services/calendar/write-context";
import { createEvent } from "@/services/google-calendar/events";
import type { InternalCreateEventRequest, InternalCreateEventResponse } from "@/types/internal-api";

const TIME_KEY = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * サーバー間（AIDE）から予定を1件作成する（docs/internal-api.md）。
 *
 * 認証は読み取り用の `DAYSPAN_INTERNAL_API_KEY` とは別の `DAYSPAN_INTERNAL_EVENTS_API_KEY`。読み取り用の
 * キーが漏れても予定を書き込まれないようにするための分離（起点: guchi-apps/aide-bot#184）。
 *
 * 作成だけを持つ。編集・削除は無い（取り消せない操作をサーバー間経路へ出さないため）。
 */
export async function POST(request: Request) {
  const unauthorized = await requireInternalEventsApiKey(request);
  if (unauthorized) return unauthorized;

  let body: InternalCreateEventRequest;
  try {
    body = (await request.json()) as InternalCreateEventRequest;
  } catch {
    return json({ error: "invalid_json_body" }, 400);
  }

  const title = body.title?.trim();
  if (!title) {
    return json({ error: "title is required" }, 400);
  }

  if (!body.date || !isRealDateKey(body.date)) {
    return json({ error: "date must be a valid date in YYYY-MM-DD format" }, 400);
  }

  const timeCheck = validateTimes(body.startTime, body.endTime);
  if (timeCheck) return json(timeCheck, 400);

  try {
    const userId = await resolveInternalUserId(request);
    if (!userId) {
      // X-Target-Email が無い・不正、または指定ユーザーがまだログインしていない。
      return json({ error: "target_user_not_resolvable" }, 500);
    }

    const calendarId = body.calendarId?.trim() || (await resolveDefaultCalendarId(userId));
    if (!calendarId) {
      return json(
        {
          error: "no_writable_calendar",
          message:
            "書き込めるカレンダーがありません。設定 ▸ Google Calendar でカレンダーを接続し、使用をオンにしてください。",
        },
        404,
      );
    }

    const target = await resolveGoogleAccountForCalendar(userId, calendarId);
    if (!target.ok) {
      return calendarWriteError(target.reason);
    }

    const uiSetting = await db.uiSetting.findUnique({ where: { userId } });
    const timeZone = uiSetting?.timeZone ?? "Asia/Tokyo";

    const allDay = !body.startTime && !body.endTime;
    const { start, end } = allDay
      ? { start: body.date, end: body.date }
      : {
          start: localInputToIso(`${body.date}T${body.startTime}`, timeZone),
          end: localInputToIso(`${body.date}T${body.endTime}`, timeZone),
        };

    const created = await createEvent(target.account, calendarId, {
      title,
      allDay,
      start,
      end,
      location: body.location?.trim() || null,
      timeZone,
      tentative: body.tentative ?? false,
    });

    const response: InternalCreateEventResponse = { id: created.id, url: created.url };
    return json(response, 200);
  } catch (error) {
    return externalApiError("google", "予定の作成", error);
  }
}

/**
 * `startTime` / `endTime` は両方指定（時刻あり）か両方省略（終日）のどちらかのみを受け付ける。
 * 片方だけの指定では、終日と時刻ありのどちらの予定を作ればよいか決まらない。
 */
function validateTimes(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): { error: string; message?: string } | null {
  if (!startTime && !endTime) return null;

  if (!startTime || !endTime) {
    return { error: "startTime and endTime must be specified together, or both omitted" };
  }

  if (!TIME_KEY.test(startTime) || !TIME_KEY.test(endTime)) {
    return { error: "startTime and endTime must be in HH:MM format" };
  }

  if (endTime <= startTime) {
    return { error: "endTime must be after startTime" };
  }

  return null;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
