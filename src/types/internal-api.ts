// サーバー間参照用API（`/api/internal/*`）が返す形（docs/internal-api.md）。
//
// 画面用の型（types/calendar.ts）をそのまま返さない。あちらは描画の都合で持っている項目
// （readOnly・列の並び・展開した回のID）を含んでおり、呼び出し元にDaySpanの画面の事情を
// 持ち込ませることになる。ここは呼び出し元がそのまま読める形に絞って写す。
//
// このファイルは呼び出し元（guchi-apps/aide）へ写して使える形にしてある。

import type { TravelEstimateSource, TravelMode } from "@/types/calendar";

/** 予定。時刻は設定タイムゾーンでの HH:MM で、終日のときは null。 */
export type InternalEvent = {
  id: string;
  /** 更新・削除（`PATCH` / `DELETE /api/internal/events/[id]`）で対象を指すのに要る */
  calendarId: string;
  title: string;
  allDay: boolean;
  /** allDay なら YYYY-MM-DD、それ以外は ISO 8601 */
  start: string;
  end: string;
  /** 設定タイムゾーンでの HH:MM。終日は null。日をまたぐ予定はその日の範囲へ切り詰める */
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  description: string | null;
  calendarName: string;
  /** 繰り返し予定の1回分かどうか */
  recurring: boolean;
  /**
   * 仮の予定かどうか（issue #688）。Google Calendarの status フィールド（tentative）を
   * そのまま使う。落とさず添えるのは、AIDE側が「まだ確定していない予定」として
   * 案内を変えられるようにするため。
   */
  tentative: boolean;
  /**
   * 中止・不参加の記録（docs/spec.md §37）。付いていなければ null。
   *
   * 落とさず添えるのは、記録の付いた予定を黙って消すと呼び出し元では「その予定は無かった」
   * ことになるため。起こらないと分かっている予定かどうかは、呼び出し元が決める。
   */
  outcome: "CANCELED" | "ABSENT" | null;
  url: string | null;
};

/** タスクがカレンダーに現れる枠の種類。期限は締切、予定日は片付けるつもりの日。 */
export type InternalTaskField = "due" | "planned";

export type InternalTask = {
  id: string;
  title: string;
  field: InternalTaskField;
  /** 時刻なしは YYYY-MM-DD、時刻ありは ISO 8601 */
  date: string;
  hasTime: boolean;
  /** 設定タイムゾーンでの HH:MM。時刻なしは null */
  time: string | null;
  priority: string | null;
  tags: string[];
  memo: string | null;
  url: string | null;
};

/** タスク専用内部APIの意味上の状態。対応しないは完了と混同しない。 */
export type InternalTaskStatus = "open" | "completed" | "skipped";

export type InternalTaskDetail = {
  id: string;
  title: string;
  status: InternalTaskStatus;
  due: string | null;
  planned: string | null;
  priority: string | null;
  progress: string | null;
  tags: string[];
  memo: string | null;
  recurrence: string | null;
  /** 更新時にそのまま返す楽観ロック用のNotion最終更新時刻。 */
  version: string;
  url: string | null;
};

/** 期限切れの未完了タスク。要求した範囲より前に期限があるもの。 */
export type InternalOverdueTask = {
  id: string;
  title: string;
  /** 期限。時刻なしは YYYY-MM-DD、時刻ありは ISO 8601 */
  due: string;
  hasTime: boolean;
  time: string | null;
  /** 範囲の初日から見て何日過ぎているか（1以上） */
  daysOverdue: number;
  priority: string | null;
  tags: string[];
  url: string | null;
};

export type InternalReminder = {
  /** 表示上のID。毎年の項目を年ごとに展開した回は元ページのIDと異なる */
  id: string;
  title: string;
  /** 日付のみは YYYY-MM-DD、時刻ありは ISO 8601 */
  date: string;
  hasTime: boolean;
  time: string | null;
  category: string | null;
  /** 毎年の項目かどうか。プロパティ未設定で判断できないときは null */
  annual: boolean | null;
  /**
   * garbage は外部アプリ（myroom）が書くゴミの収集日。DaySpanからは読むだけ。
   * shopping はその日に買う予定の買い物を1件へまとめたもの（docs/spec.md §36）。
   */
  source: "reminder" | "garbage" | "shopping";
  memo: string | null;
  url: string | null;
};

export type InternalTravel = {
  id: string;
  /** 「自宅 → 渋谷」の形 */
  title: string;
  origin: string;
  destination: string;
  mode: TravelMode;
  /** ISO 8601。移動は必ず時刻を持つ */
  start: string;
  end: string;
  startTime: string | null;
  endTime: string | null;
  /** 所要時間が手入力でないかどうか（目安であることを示すために持つ） */
  estimated: boolean;
  /** 所要時間の出どころ。MANUAL / AI / TRANSIT（旧trainroute経由の経路検索。撤去済み・過去データのみ）/ YAHOO（Yahoo!乗換案内）/ GOOGLE_MAPS（Googleマップで調べた所要時間） */
  estimateSource: TravelEstimateSource;
  returnLeg: boolean;
  note: string | null;
};

/** 1日ぶんの中身。並び順はカレンダー画面と同じ（終日→時刻順→同時刻はタイトル順）。 */
export type InternalScheduleDay = {
  /** YYYY-MM-DD（設定タイムゾーン） */
  date: string;
  events: InternalEvent[];
  tasks: InternalTask[];
  reminders: InternalReminder[];
  travels: InternalTravel[];
};

/**
 * 連携そのものが設定されているか。
 *
 * 未接続のときGoogle・Notionは「失敗」ではなく空で返るため、これが無いと呼び出し元には
 * 「今日は何も無い」と区別が付かない。
 */
export type InternalSources = {
  /** Googleアカウントを1つ以上接続しているか */
  googleConnected: boolean;
  /** NotionのタスクDBが設定済みか */
  notionReady: boolean;
  /** Notionの日付リマインドDBが設定済みか */
  reminderReady: boolean;
};

export type InternalScheduleResponse = {
  generatedAt: string;
  /** 日付の解釈に使ったタイムゾーン（UiSetting.timeZone、既定 Asia/Tokyo） */
  timeZone: string;
  range: { from: string; to: string };
  sources: InternalSources;
  days: InternalScheduleDay[];
  overdueTasks: InternalOverdueTask[];
  /**
   * 連携ごとの取得失敗。片方が落ちていても取れたぶんは返すため、
   * 呼び出し元は「予定は取れなかった」と伝えられる。空配列なら全て取れている。
   */
  errors: { source: "google" | "notion"; reason: string }[];
};

/**
 * `POST /api/internal/events` の入力（docs/internal-api.md）。更新・削除は
 * `PATCH` / `DELETE /api/internal/events/[id]`（issue #805）が別に持つ。
 */
export type InternalCreateEventRequest = {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM。両方省略で終日、片方だけの指定は不正 */
  startTime?: string | null;
  endTime?: string | null;
  location?: string | null;
  /** 省略時は予定新規作成の既定の保存先（CalendarSetting.isCreateDefault） */
  calendarId?: string | null;
  /**
   * 仮の予定として作成するか（issue #688）。省略時は false（確定した予定）。
   * 「多分この時間に」のような曖昧な発話のときだけ true を指定する想定。
   */
  tentative?: boolean;
};

/** 秘書（AIDE）が「入れました」の根拠として案内できるよう、作成した予定のURLを返す。 */
export type InternalCreateEventResponse = {
  id: string;
  url: string | null;
};

/**
 * `PATCH /api/internal/events/[id]` の入力（issue #805）。`calendarId` 以外は全て任意で、
 * 送った項目だけを変える。1項目も無ければ400。
 */
export type InternalUpdateEventRequest = {
  /** 予定のあるカレンダー（`aide_schedule` の各予定の `calendarId`）。必須 */
  calendarId?: string;
  title?: string | null;
  /** 開始日（YYYY-MM-DD） */
  date?: string | null;
  /**
   * 終了日（YYYY-MM-DD、issue #813）。日をまたぐ時刻ありの予定を動かすときに `date`（開始日）と
   * セットで指定する。省略時は、`date` を動かしたぶんだけ今のまたぎ幅（開始日から終了日までの
   * 日数）を保って一緒にずらし、`date` も送らなければ今の終了日のまま。`allDay: true` とは
   * 組み合わせられない（終日で複数日にまたがる予定はこの入口では扱わない）
   */
  endDate?: string | null;
  /** HH:MM。両方指定するか両方省略 */
  startTime?: string | null;
  endTime?: string | null;
  /** true で終日へ変える（時刻は同時に指定できない）。false で時刻ありへ（時刻の指定が要る） */
  allDay?: boolean;
  /** 空文字で消す */
  location?: string | null;
  tentative?: boolean;
};
