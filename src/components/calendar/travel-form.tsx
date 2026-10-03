"use client";

import { useOffline } from "next/offline";
import { CheckCircle2, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";

import { OFFLINE_WRITE_MESSAGE } from "@/components/offline/offline-notice";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { GoogleMapsRoute } from "@/lib/google-maps-route";
import type { PlaceCatalog } from "@/services/notion/places";
import {
  TRAVEL_MODES,
  TRAVEL_MODE_LABELS,
  type TravelEstimateSource,
  type TravelItem,
  type TravelMode,
} from "@/types/calendar";

import { DateTimeInput } from "./date-time-input";
import { DeleteItemDialog } from "./delete-item-dialog";
import { isoToLocalInput, localInputToIso } from "./datetime-fields";
import { ItemFormActions } from "./item-form-actions";
import { LocationInput } from "./location-input";
import { readErrorMessage } from "./response-error";
import type { TouchedRange } from "./use-calendar-chunks";

export type TravelDraft = {
  travel?: TravelItem;
  origin: string;
  destination: string;
  mode: TravelMode;
  /** 入力欄の形式（YYYY-MM-DDTHH:mm）。 */
  departAt: string;
  arriveAt: string;
  note?: string;
  /**
   * 元になった予定。復路の起点（予定の終了時刻）と、移動と予定の紐づけに使う。
   * 「＋」から作った移動には無く、そのときは復路も作らない（帰りの起点が決まらないため）。
   */
  linkedEvent?: { id: string; calendarId: string; endAt: string } | null;
  /** 往復を作るかの初期値。設定の既定値が入る。 */
  roundTrip?: boolean;
};

type GoogleRouteStatus =
  | { kind: "idle" }
  | { kind: "analyzing" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/**
 * 移動の入力欄（docs/spec.md §29）。ダイアログの枠と種類の切り替えは ItemDialog が持つ。
 *
 * 出発地・目的地は予定の「場所」欄と同じ入力を使う。候補の一次情報源はNotionの場所DBで、
 * 移動のためにもう1つ候補の置き場所を作らない。
 */
export function TravelForm({
  draft,
  placeCatalog,
  timeZone,
  onSaved,
}: {
  draft: TravelDraft;
  /** 出発地・目的地の入力候補。Notionの場所DBに登録済みのもの。 */
  placeCatalog: PlaceCatalog;
  timeZone: string;
  onSaved: (touched: TouchedRange[] | null) => void;
}) {
  const editing = draft.travel;

  const [origin, setOrigin] = useState(draft.origin);
  const [destination, setDestination] = useState(draft.destination);
  const [mode, setMode] = useState<TravelMode>(draft.mode);
  const [departAt, setDepartAt] = useState(draft.departAt);
  const [arriveAt, setArriveAt] = useState(draft.arriveAt);
  const [note, setNote] = useState(draft.note ?? "");
  // 所要時間の出どころ。手で入れた値・AIの目安・経路検索の結果を保存先にも残す。
  const [estimateSource, setEstimateSource] = useState<TravelEstimateSource>(
    editing?.estimateSource ?? "MANUAL",
  );
  const [roundTrip, setRoundTrip] = useState(Boolean(draft.roundTrip && draft.linkedEvent));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 保存はできたが、Googleカレンダーへ書き出せなかったとき。黙って閉じると気付けない。
  const [exportNotice, setExportNotice] = useState<{ message: string; touched: TouchedRange[] } | null>(
    null,
  );
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Googleマップから取り込んだ結果の報せ。入力全体の保存エラーとは別に、URL欄の近くで経過を伝える。
  const [googleRouteStatus, setGoogleRouteStatus] = useState<GoogleRouteStatus>({ kind: "idle" });
  const [googleRouteUrl, setGoogleRouteUrl] = useState("");
  // 貼り直したあとに先行リクエストが返っても、古い経路で入力欄を上書きしないための世代番号。
  const googleRouteRequestRef = useRef(0);

  const offline = useOffline();

  const rangeError = (() => {
    if (!departAt || !arriveAt) return "出発時刻と到着時刻を入力してください。";
    return arriveAt <= departAt ? "到着時刻が出発時刻より後になるようにしてください。" : null;
  })();

  const inputError =
    rangeError ??
    (origin.trim() && destination.trim() ? null : "出発地と目的地を入力してください。");

  /**
   * 時刻を手で直したとき。出どころを手入力へ戻す。
   *
   * 直した値はもう経路検索・AIが出したものではない。戻さないと、手で入れた時刻に
   * 「経路検索の平均」と付いたまま保存され、Googleの予定の説明にもその断りが残る。
   * 候補を押したときは applyEstimate が直接 setDepartAt / setArriveAt を呼ぶため、
   * この経路は通らない（出どころが押した候補のまま残る）。
   */
  const editDepartAt = (value: string) => {
    setDepartAt(value);
    setEstimateSource("MANUAL");
  };

  const editArriveAt = (value: string) => {
    setArriveAt(value);
    setEstimateSource("MANUAL");
  };

  /** Googleマップの共有URLを貼り付けたとき、読めた経路だけを入力欄へ反映する。 */
  const applyGoogleMapsRoute = (route: GoogleMapsRoute) => {
    setOrigin(route.origin);
    setDestination(route.destination);
    setMode(route.mode);
    setEstimateSource("GOOGLE_MAPS");

    const imported = route.departAt ? isoToLocalInput(route.departAt, timeZone) : departAt;
    // 予定に紐づく移動は予定の日を動かさない。単独の新規移動は、Googleマップで選んだ日も採用する。
    const depart = route.departAt && draft.linkedEvent ? `${departAt.slice(0, 10)}${imported.slice(10)}` : imported;
    const base = new Date(`${depart}:00Z`);
    if (depart && !Number.isNaN(base.getTime())) {
      setDepartAt(depart);
      setArriveAt(new Date(base.getTime() + route.minutes * 60_000).toISOString().slice(0, 16));
    }

    setError(null);
  };

  const importGoogleMapsRoute = async (value: string) => {
    const requestId = googleRouteRequestRef.current + 1;
    googleRouteRequestRef.current = requestId;
    const isCurrentRequest = () => googleRouteRequestRef.current === requestId;
    setGoogleRouteStatus({ kind: "analyzing" });
    setError(null);
    try {
      const response = await fetch("/api/travels/google-maps-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      if (!response.ok) {
        const message = await readErrorMessage(response, "Googleマップの経路URLを読み取れませんでした。");
        if (isCurrentRequest()) setGoogleRouteStatus({ kind: "error", message });
        return;
      }
      const body = (await response.json()) as { route: GoogleMapsRoute };
      if (!isCurrentRequest()) return;
      applyGoogleMapsRoute(body.route);
      setGoogleRouteStatus({
        kind: "success",
        message: `Googleマップの経路を反映しました（${TRAVEL_MODE_LABELS[body.route.mode]}・所要時間${body.route.minutes}分）。`,
      });
    } catch {
      if (isCurrentRequest()) {
        setGoogleRouteStatus({ kind: "error", message: "Googleマップの経路URLを読み取れませんでした。" });
      }
    }
  };

  const changeGoogleRouteUrl = (value: string) => {
    // 手入力でURLを直した時点で、前の解析結果は対象外にする。貼り付け時は直後に新しい解析を始める。
    googleRouteRequestRef.current += 1;
    setGoogleRouteUrl(value);
    setGoogleRouteStatus({ kind: "idle" });
  };

  const save = async () => {
    if (offline) {
      setError(OFFLINE_WRITE_MESSAGE);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const departIso = localInputToIso(departAt, timeZone);
      const arriveIso = localInputToIso(arriveAt, timeZone);

      // 復路は予定の終了時刻に出発し、行きと同じだけかかるものとして置く。
      const durationMs = new Date(arriveIso).getTime() - new Date(departIso).getTime();
      const returnTrip =
        roundTrip && draft.linkedEvent
          ? {
              departAt: draft.linkedEvent.endAt,
              arriveAt: new Date(new Date(draft.linkedEvent.endAt).getTime() + durationMs).toISOString(),
            }
          : null;

      const payload = {
        origin: origin.trim(),
        destination: destination.trim(),
        mode,
        departAt: departIso,
        arriveAt: arriveIso,
        note: note.trim() || null,
        estimateSource,
        ...(editing
          ? {}
          : {
              linkedEventId: draft.linkedEvent?.id ?? null,
              linkedCalendarId: draft.linkedEvent?.calendarId ?? null,
              returnTrip,
            }),
      };

      const response = await fetch(
        editing ? `/api/travels/${encodeURIComponent(editing.id)}` : "/api/travels",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        setError(await readErrorMessage(response, "保存できませんでした。"));
        return;
      }

      const body = (await response.json()) as { exports?: { status: string; reason?: string }[] };

      const touched: TouchedRange[] = [{ start: departIso, end: arriveIso }];
      if (returnTrip) touched.push({ start: returnTrip.departAt, end: returnTrip.arriveAt });
      if (editing) touched.push({ start: editing.start, end: editing.end });

      const message = exportWarning(body.exports ?? []);
      if (message) {
        // 移動そのものは保存できている。閉じてよいことも伝えたうえで理由を残す。
        setExportNotice({ message, touched });
        return;
      }

      onSaved(touched);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存に失敗しました。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {editing && confirmingDelete && (
        <DeleteItemDialog
          item={{ kind: "travel", travel: editing }}
          onCancel={() => setConfirmingDelete(false)}
          onDeleted={onSaved}
        />
      )}

      <div className="flex min-w-0 flex-col gap-4">
        <LocationInput
          id="travel-origin"
          label="出発地"
          value={origin}
          onChange={setOrigin}
          places={placeCatalog.places}
          eventTitle={destination}
          placeDatabaseReady={placeCatalog.ready}
        />

        <LocationInput
          id="travel-destination"
          label="目的地"
          value={destination}
          onChange={setDestination}
          places={placeCatalog.places}
          eventTitle={destination}
          placeDatabaseReady={placeCatalog.ready}
        />

        <div className="flex flex-col gap-2">
          <span className="type-label-small px-1 text-on-surface-variant">交通手段</span>
          <div className="flex flex-wrap gap-2">
            {TRAVEL_MODES.map((option) => (
              <Button
                key={option}
                type="button"
                variant={option === mode ? "secondary" : "outline"}
                size="sm"
                className={cn(
                  "rounded-full",
                  option === mode && "bg-travel-container text-on-travel-container",
                )}
                onClick={() => setMode(option)}
              >
                {TRAVEL_MODE_LABELS[option]}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-2">
          <DateTimeInput
            id="travel-depart"
            dateLabel="出発日"
            timeLabel="出発時刻"
            value={departAt}
            onChange={editDepartAt}
          />
          <DateTimeInput
            id="travel-arrive"
            dateLabel="到着日"
            timeLabel="到着時刻"
            value={arriveAt}
            onChange={editArriveAt}
          />
        </div>

        {/* Googleマップの共有URLは、現在選んでいる交通手段によらず貼り付けられる。
            読めた交通手段へ切り替えるため、公共交通から車の経路を貼る場合も入口を隠さない。 */}
        <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
          <Textarea
            id="travel-google-route-url"
            label="Googleマップの経路URL"
            rows={2}
            placeholder="共有した経路URLを貼り付ける"
            value={googleRouteUrl}
            disabled={offline}
            onChange={(e) => changeGoogleRouteUrl(e.target.value)}
            onPaste={(event) => {
              const value = event.clipboardData.getData("text").trim();
              if (!value) return;
              event.preventDefault();
              changeGoogleRouteUrl(value);
              void importGoogleMapsRoute(value);
            }}
            onClear={() => changeGoogleRouteUrl("")}
          />
          {googleRouteStatus.kind === "idle" && (
            <p className="text-xs text-muted-foreground">Googleマップの経路URLを貼り付けると、AIが解析して入力欄へ反映します。</p>
          )}
          {googleRouteStatus.kind === "analyzing" && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
              <LoaderCircle className="size-4 animate-spin" />
              AIが経路を解析しています…
            </p>
          )}
          {googleRouteStatus.kind === "success" && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" aria-live="polite">
              <CheckCircle2 className="size-4 text-travel" />
              {googleRouteStatus.message}
            </p>
          )}
          {googleRouteStatus.kind === "error" && (
            <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
              <CircleAlert className="size-4 shrink-0" />
              <span>{googleRouteStatus.message}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto"
                disabled={offline || !googleRouteUrl.trim()}
                onClick={() => void importGoogleMapsRoute(googleRouteUrl)}
              >
                <RefreshCw />
                再試行
              </Button>
            </div>
          )}
        </div>

        {/* 往復は元になった予定があるときだけ。単独の移動では帰りの起点が決まらない。 */}
        {!editing && draft.linkedEvent && (
          <label className="-my-1 flex min-h-11 items-center gap-3 px-4 text-base select-none md:text-sm">
            <Checkbox checked={roundTrip} onCheckedChange={(v) => setRoundTrip(v === true)} />
            帰りの移動も作る（予定の終了時刻に出発）
          </label>
        )}

        <Textarea
          id="travel-note"
          label="メモ"
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onClear={() => setNote("")}
        />

        {inputError && <p className="text-sm text-destructive">{inputError}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {exportNotice && <p className="text-sm text-on-surface-variant">{exportNotice.message}</p>}
      </div>

      {/* 書き出しの報せを出している間は、閉じる以外にすることが無い（移動そのものは保存済み）。 */}
      {exportNotice ? (
        <ItemFormActions saveLabel="閉じる" onSave={() => onSaved(exportNotice.touched)} />
      ) : (
        <ItemFormActions
          saveDisabled={busy || offline || inputError !== null}
          onSave={save}
          onDelete={editing ? () => setConfirmingDelete(true) : undefined}
          deleteDisabled={busy || offline}
        />
      )}
    </>
  );
}

/** Googleへ書き出せなかった理由。移動そのものは保存できているため、断りではなく報せとして出す。 */
function exportWarning(exports: { status: string; reason?: string }[]): string | null {
  if (exports.some((result) => result.status === "failed")) {
    return "移動は保存しましたが、Googleカレンダーへ書き出せませんでした。もう一度保存すると書き出しをやり直します。";
  }
  if (exports.some((result) => result.reason === "write_disabled")) {
    return "移動は保存しましたが、書き出し先のカレンダーが使用しない設定のため、Googleカレンダーには出ません。設定 ▸ 移動 で書き出し先を確認してください。";
  }
  if (exports.some((result) => result.reason === "no_calendar")) {
    return "移動は保存しましたが、書き出し先のカレンダーが無いためGoogleカレンダーには出ません。設定 ▸ Google Calendar でカレンダーを接続してください。";
  }
  return null;
}

/** 編集用の初期値。ISO 8601 を入力欄の形式へ直す。 */
export function toTravelDraft(travel: TravelItem, timeZone: string): TravelDraft {
  return {
    travel,
    origin: travel.origin,
    destination: travel.destination,
    mode: travel.mode,
    departAt: isoToLocalInput(travel.start, timeZone),
    arriveAt: isoToLocalInput(travel.end, timeZone),
    note: travel.note ?? "",
  };
}
