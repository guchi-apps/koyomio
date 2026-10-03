# サーバー間参照用API（`/api/internal/*`）

同一VPS上で動く他アプリ（現状は [guchi-apps/aide](https://github.com/guchi-apps/aide)）が、その日の予定・タスク・日付リマインド・移動を参照するためのAPI（通知の送信を走らせる入口もここに置く）。ブラウザからの利用は想定しておらず、Supabaseのセッションではなく**共有シークレット1本**で守る。

- 経緯: guchi-apps/koyomio#236、guchi-apps/question#7
- 到達経路: DaySpanはVPS上で `127.0.0.1:3113`（`deploy/ecosystem.config.js` の `PORT`）で待ち受ける。呼び出し元も同じVPS上にいるため、**呼び出しにインターネットを経由する必要はない**
- ただし **`https://dayspan.gucchii.com/api/internal/...` として外部からも到達する。** Apacheがドメイン配下を丸ごと `127.0.0.1:3113` へ渡しており、このパスだけを閉じてはいない。守りは共有シークレット1本だけなので、**キーは推測できない長さの乱数にする**（`openssl rand -base64 32`）
- 同じ方式の先行事例: guchi-apps/subscription-lists の `docs/internal-api.md`（環境変数名・認証の作りを揃えてある）

## 認証

```
Authorization: Bearer <DAYSPAN_INTERNAL_API_KEY>
```

| 状況 | 応答 |
| --- | --- |
| `DAYSPAN_INTERNAL_API_KEY` が未設定 | `503`（機能として無効。設定漏れが「認証なしの公開」に化けないようにしている） |
| ヘッダなし・キー不一致 | `401` |
| 一致 | `200` |

キーの比較は `node:crypto` の `timingSafeEqual` で定数時間で行う（`src/lib/internal-auth.ts`）。トークンはクエリではなく `Authorization` ヘッダーで受ける。クエリに載せるとApacheのアクセスログにそのまま残る（iPhoneウィジェットのトークンと同じ理由。docs/spec.md §28）。

**書き込み系（`POST` / `PATCH` / `DELETE /api/internal/events`）は読み取りとは別の鍵（issue-deckの `DAYSPAN_INTERNAL_EVENTS_API_KEY`）で守る。** 読み取り用の `DAYSPAN_INTERNAL_API_KEY` が漏れても予定を書き込まれないようにするため（起点: guchi-apps/aide-bot#184「読み取りとは別の資格情報」）。未設定・不一致のときの応答（503 / 401）は読み取り用とまったく同じ形。

**タスクの作成・更新・状態変更はさらに別のissue-deck共有トークン `DAYSPAN_INTERNAL_TASKS_API_KEY` を使う。** 読み取り鍵・予定の書き込み鍵のいずれでもタスクは変更できない。3鍵は共有トークンAPIから実行時に取得し、ローカル開発・移行中に取得できないときだけ `INTERNAL_API_KEY`・`INTERNAL_EVENTS_API_KEY`・`INTERNAL_TASKS_API_KEY` へ順にフォールバックする。GitHub Secret、CI・deployの転送、VPSの`.env`へは配らない。

`/api/internal/` は `src/proxy.ts`（`src/lib/supabase/middleware.ts`）がSupabaseへ問い合わせずに素通しする。認証がキーで完結しており、呼ばれるたびにSupabase Authへ往復させる理由が無いため。matcherからは外さない（外すと詐称されたユーザーIDヘッダーが後段へ届く）。

**対象ユーザーは呼び出し元がヘッダー `X-Target-Email`（メール1件）で指定する**（issue #1012・#1048。旧 `ALLOWED_GOOGLE_EMAILS` は撤去）。ヘッダーが無い、そのメールの `User` が無い（まだログインしていない）、またはカンマ区切りなど形が不正なときは `500`（`target_user_not_resolvable`）で、別人へは落とさない。理由はサーバーログ（`[dayspan] internal target user: ...`・メールは出さない）に残る。

## `GET /api/internal/tasks`

タスクだけをNotionから読み、カレンダー・移動・天気・勤務の取得やスケジュール組み立ては行わない。`Authorization: Bearer <INTERNAL_API_KEY>` と `X-Target-Email` が必須。

| クエリ | 既定 | 内容 |
| --- | --- | --- |
| `status` | `open` | `open` / `completed` / `skipped`。対応しないは完了と別に返す |
| `dateField` | `due` | `due` / `planned` / `none`。期間比較に使う日付を明示する |
| `from`, `to` | なし | `YYYY-MM-DD` の包含範囲。`dateField=none` では使わない |
| `limit` | `50` | 1〜100。Notionの1ページ（`limit` 件）を取得してから絞り込むため、返る件数は `limit` 以下になる |
| `cursor` | なし | 前回の `nextCursor`。途中結果では `hasMore: true` になる |

**絞り込み（`status`・日付）はNotionから1ページ取得した後にメモリ上で行う。** 条件に合うタスクが0件でも `hasMore: true` と `nextCursor` が返りうるため、呼び出し側は `hasMore: false` になるまで `nextCursor` を辿ること（途中の空配列を「該当なし」と判断しない）。

`dateField=none` は期限・予定日の両方が未設定のタスクだけを返す。Notion接続・タスクDBが未設定なら `source: "not_configured"` と空配列を返し、取得に失敗した場合は `502 notion_request_failed` とする。空配列かつ `source: "ready"` は該当タスクが無いことを表す。

各タスクにはID、名称、`status`、期限、予定日、進捗、優先度、タグ、メモ、繰り返し、URL、`version` を含める。`version` は更新・状態変更時に必須で、古い値なら `409 task_version_conflict` とする。

## タスクの書き込み

`POST /api/internal/tasks`（作成）、`PATCH /api/internal/tasks/:taskId`（許可項目の部分更新）、`POST /api/internal/tasks/:taskId/actions`（`complete` / `reopen` / `skip` / `unskip`）は `Authorization: Bearer <DAYSPAN_INTERNAL_TASKS_API_KEY>` と `X-Target-Email` を必須とする。作成と状態変更には `Idempotency-Key` も必須で、同じキー・同じ要求は保存済みの結果を返す。実行中は `409 operation_in_progress`、外部書き込み後に結果を確認できない場合は `409 result_unknown` を返すため、同じキーで再照会する。

更新可能な項目は `title`、`due`、`planned`、`priority`、`memo`、`tags`、`recurrence`、`progress` だけである。`null` は期限・予定日・任意の選択肢・メモをクリアする。未知の項目・不正な日付・設定済みDBに対応プロパティが無い項目は `400` で拒否し、黙って成功とはしない。期限または予定日を直接変更したときは、その日付の紐づけだけを既存画面と同じ規則で外す。

`complete` は既存の繰り返し規則で次回を作り、`skip`・`unskip`・`reopen` は作らない。同じ回の完了を再送しても次回を二重作成しない。

## `GET /api/internal/schedule`

指定した日の予定・タスク・日付リマインド・移動を、日ごとに束ねて返す。

日ごとの振り分けと並び順は、カレンダー画面と同じ関数（`src/components/calendar/item-layout.ts` の `createCalendarDateUtils`）を通している。ここを書き直すと、同じ日を画面で見たときと違う結果が返る。

### クエリパラメータ

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `date` | 設定タイムゾーンでの今日 | `YYYY-MM-DD`。返す範囲の初日。形式が不正、または実在しない日付（`2026-02-30` のような繰り上がりを含む）なら `400` |
| `days` | `1` | 1〜31の整数。`date` から何日ぶん返すか。範囲外・整数でなければ `400` |
| `overdueDays` | `30` | 0〜90の整数。期限切れタスクを何日前まで遡るか。`0` で取りにいかない（Notionへの往復が1回減る）。範囲外・整数でなければ `400` |

> **基準日は渡さなくてよい。** VPSのタイムゾーンはUTCだが、DaySpanは日付の解釈に利用者の設定タイムゾーン（`UiSetting.timeZone`、既定 `Asia/Tokyo`）を使うため、省略時の「今日」もそのタイムゾーンで決まる。呼び出し側でJSTの日付を作る必要はない。

### レスポンス

```jsonc
{
  "generatedAt": "2026-08-19T21:00:00.000Z",
  "timeZone": "Asia/Tokyo",
  "range": { "from": "2026-08-19", "to": "2026-08-19" },
  "sources": {
    "googleConnected": true,   // Googleアカウントを1つ以上接続しているか
    "notionReady": true,       // NotionのタスクDBが設定済みか
    "reminderReady": true      // Notionの日付リマインドDBが設定済みか
  },
  "days": [
    {
      "date": "2026-08-19",
      "events": [
        {
          "id": "abc123",
          "title": "定例会",
          "allDay": false,
          "start": "2026-08-19T01:00:00Z",   // 終日は YYYY-MM-DD
          "end": "2026-08-19T02:00:00Z",
          "startTime": "10:00",               // 設定タイムゾーンでの HH:MM。終日は null
          "endTime": "11:00",
          "location": "渋谷オフィス",
          "description": null,
          "calendarId": "abc@group.calendar.google.com", // 更新・削除で対象を指すのに使う
          "calendarName": "仕事",
          "recurring": true,
          "tentative": false,                 // 仮の予定かどうか（Googleのstatus:tentative）
          "outcome": null,                    // 中止・不参加の記録。CANCELED | ABSENT | null
          "url": "https://www.google.com/calendar/event?eid=..."
        }
      ],
      "tasks": [
        {
          "id": "notion-page-id",
          "title": "請求書を出す",
          "field": "due",                     // due（期限）| planned（予定日）
          "date": "2026-08-19T05:00:00Z",
          "hasTime": true,
          "time": "14:00",                    // 時刻なしは null
          "priority": "高",
          "tags": ["仕事"],
          "memo": null,
          "url": "https://www.notion.so/..."
        }
      ],
      "reminders": [
        {
          "id": "notion-page-id:2026-08-19",  // 毎年の項目を展開した回は元ページのIDと異なる
          "title": "誕生日",
          "date": "2026-08-19",
          "hasTime": false,
          "time": null,
          "category": "記念日",
          "annual": true,                     // 判断できないときは null
          "source": "reminder",               // reminder | garbage（ゴミの収集日）| shopping（その日の買い物）
          "memo": null,
          "url": "https://www.notion.so/..."
        },
        {
          "id": "shopping:2026-08-19",        // 買い物はNotionページではなく、その日のぶんをまとめた1件
          "title": "買い物 3件",              // 件数はタイトルに含む（未購入のものだけを数える）
          "date": "2026-08-19",
          "hasTime": false,
          "time": null,
          "category": null,
          "annual": false,
          "source": "shopping",
          "memo": "・牛乳（2本）\n・卵\n・トイレットペーパー",  // その日に買う品目
          "url": null                         // 指す先のページが1つに決まらないため常に null
        }
      ],
      "travels": [
        {
          "id": "cuid",
          "title": "自宅 → 渋谷",
          "origin": "自宅",
          "destination": "渋谷",
          "mode": "PUBLIC_TRANSIT",            // CAR|PUBLIC_TRANSIT|WALK|OTHER（旧: TRAIN|CAR|BUS|WALK|BICYCLE|PLANE|OTHER。issue #538で公共交通へ統合）
          "start": "2026-08-19T00:30:00Z",
          "end": "2026-08-19T01:00:00Z",
          "startTime": "09:30",
          "endTime": "10:00",
          "estimated": true,                  // 所要時間が手入力ではないかどうか（AI / 経路検索 / Yahoo!乗換案内）
          "returnLeg": false,
          "note": null
        }
      ]
    }
  ],
  "overdueTasks": [
    {
      "id": "notion-page-id",
      "title": "先週の報告書",
      "due": "2026-08-14",
      "hasTime": false,
      "time": null,
      "daysOverdue": 5,                       // range.from から見て何日過ぎているか
      "priority": null,
      "tags": [],
      "url": "https://www.notion.so/..."
    }
  ],
  "errors": []                                // 空なら全て取れている
}
```

型は `src/types/internal-api.ts` にある。呼び出し元へそのまま写して使える。

### 並び順・振り分けの決まり

- **日ごとの並びは、その日に見えている開始時刻の順。** 終日が先頭、同時刻はタイトル順
- **日をまたぐ予定は、かかっている日すべてに出る。** その日の範囲へ切り詰め、前日から続いていれば `startTime` は `00:00`、翌日へ続くなら `endTime` は `24:00`。切り詰めずに元の時刻を返すと、呼び出し元が日付まで見比べないと当日の時間帯を決められない
- **終日予定は `startTime` / `endTime` が `null`。** `start` / `end` は `YYYY-MM-DD`
- **1つのタスクは期限と予定日で2枠に現れる**（`field` で区別する）。日時が完全に同じときは期限の1枠にまとめる（docs/spec.md §5）
- **完了済みのタスクは返らない。** 取得元（`listTasksInRange()`）が除いている
- **中止・不参加を記録した予定も返る**（`outcome` に `CANCELED` / `ABSENT` が入る。docs/spec.md §37）。黙って落とすと呼び出し元では「その予定は無かった」ことになるため、扱いは呼び出し元が決める
- **仮の予定も通常の予定と同じ枠に含まれる**（`tentative: true`。issue #688）。まだ本決まりでない予定として案内を変えるかは呼び出し元が決める

### 期限切れタスク（`overdueTasks`）

`range.from` より前に期限があり、範囲内の日には現れない未完了タスク。範囲内にも出るタスク（期限は過ぎているが予定日が今日、など）は `days` 側にだけ入れる。同じタスクを「今日やること」と「積み残し」の両方へ出しても、読む側で件数が水増しされるだけのため。

遡るのは既定で **30日**まで（`overdueDays` で0〜90に変えられる）。半年前に期限が過ぎたタスクを朝に読み上げても行動は変わらず、遡る範囲を広げるほどNotionの応答が重くなる。

**この遡りぶんは、カレンダーの取得とは別のNotionへの1回で取る。** カレンダーの取得範囲そのものを過去へ広げると、同じ範囲がGoogleと移動へも渡り、タスク1種類のために表示中のカレンダー全部の予定を毎回その日数ぶん取ることになる（docs/spec.md §20「外部APIへ過剰なアクセスを発生させない」）。予定の取得とは並行に投げるため、待ち時間は増えない。

### 連携が設定されていないとき（`sources`）

Google未接続・NotionのDB未設定は「失敗」ではないため `errors` には出ず、該当する配列が空で返る。**これだけでは「今日は何も無い」と区別が付かない**ため、連携そのものの状態を `sources` に添える。呼び出し元は `sources.googleConnected` が `false` なら「予定は取得できていない」と伝えられる。

### 外部サービスが落ちているとき

**取れたぶんを返し、失敗は `errors` に載せる（HTTPは200）。** 全体を失敗させると、Notionが落ちているだけの日にGoogleの予定まで読めなくなる。呼び出し元は `errors` を見て「予定は取れなかった」と伝えられる。

```jsonc
"errors": [
  { "source": "google", "reason": "example@gmail.com の「仕事」の予定を取得できませんでした。" },
  { "source": "notion", "reason": "Notionのタスク・日付リマインド・ゴミの日・勤務場所・買い物を取得できませんでした。" }
]
```

DaySpan自身のDBを引けなかったときだけは、取れたぶんという概念が無いため `503`（`internal_api_failed`）を返す。

## `POST /api/internal/events`

予定を1件作成する（起点: guchi-apps/aide-bot#184）。秘書（AIDE）が「明日10時に歯医者を入れて」のような発話から予定を登録できるようにするための入口で、更新・削除は次節（`PATCH` / `DELETE /api/internal/events/[id]`・issue #805）が別に持つ。

認証は `DAYSPAN_INTERNAL_EVENTS_API_KEY`（読み取り用の `DAYSPAN_INTERNAL_API_KEY` とは別の鍵。上記「認証」参照）。

既存の `POST /api/events`（ブラウザ用）と同じ作成処理（`src/services/google-calendar/events.ts` の `createEvent`）を通すため、書き込み可否の判定（`resolveGoogleAccountForCalendar`）も同じ経路を通る。「使用」がオフのカレンダー・書き込み不可のカレンダーへは書けない。

### リクエスト

```jsonc
{
  "title": "歯医者",
  "date": "2026-09-07",        // YYYY-MM-DD
  "startTime": "10:00",         // HH:MM。省略（endTimeも省略）で終日
  "endTime": "11:00",
  "location": "〇〇歯科",        // 任意
  "calendarId": "primary",      // 任意。省略で予定新規作成の既定の保存先（CalendarSetting.isCreateDefault）
  "tentative": false            // 任意。省略時 false（確定した予定）。true で仮の予定として作成する
}
```

| 項目 | 必須 | 内容 |
| --- | --- | --- |
| `title` | ○ | 空文字（trim後）は `400` |
| `date` | ○ | `YYYY-MM-DD`。形式不正・実在しない日付（`2026-02-30` 等）は `400` |
| `startTime` / `endTime` | - | `HH:MM`。**両方指定するか、両方省略するかのどちらかのみ。** 片方だけの指定、`endTime <= startTime`、形式不正はいずれも `400`（時刻ありか終日かが決まらない・所要時間が0以下になるため） |
| `location` | - | 省略可 |
| `calendarId` | - | 省略時は書き込み可能な既定のカレンダーを解決する。書き込めるカレンダーが1つも無ければ `404`（`no_writable_calendar`） |
| `tentative` | - | 省略時 `false`。`true` で仮の予定（Googleの `status: tentative`）として作成する（issue #688）。「多分この時間に」のような曖昧な発話のときだけ秘書側が付ける想定。後から確定へ変える・仮へ戻すのは下の `PATCH`（`tentative`）で行える |

日付の解釈は `GET /api/internal/schedule` と同じく `UiSetting.timeZone`（既定 `Asia/Tokyo`）で行う。呼び出し側でJSTの時刻へ変換する必要はない。

### レスポンス

```jsonc
{
  "id": "abc123",
  "url": "https://www.google.com/calendar/event?eid=..."   // 秘書が「入れました」の根拠として案内する用
}
```

### エラー

| 状況 | 応答 |
| --- | --- |
| 認証エラー | `401` / `503`（上記「認証」参照） |
| 入力不正 | `400` |
| 対象ユーザーを1人に決められない | `500`（`target_user_not_resolvable`。`X-Target-Email` が無い・不正、または指定ユーザーが無い） |
| 書き込めるカレンダーが無い（`calendarId` 省略時） | `404`（`no_writable_calendar`） |
| 指定した `calendarId` が存在しない / 使用オフ | `404`（`calendar_not_found`） / `403`（`calendar_not_writable`） |
| 指定した `calendarId` の「使用」がオフ | `403`（`calendar_not_writable`） |
| Googleへの書き込みが失敗 | `502`（`google_request_failed`。Googleが返したメッセージを含む） |

### 動作確認

```bash
curl -s -X POST -H "Authorization: Bearer $DAYSPAN_INTERNAL_EVENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"歯医者","date":"2026-09-07","startTime":"10:00","endTime":"11:00"}' \
  "http://127.0.0.1:3113/api/internal/events" | jq .

# 終日予定
curl -s -X POST -H "Authorization: Bearer $DAYSPAN_INTERNAL_EVENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"出張","date":"2026-09-10"}' \
  "http://127.0.0.1:3113/api/internal/events" | jq .

# 仮の予定（issue #688）
curl -s -X POST -H "Authorization: Bearer $DAYSPAN_INTERNAL_EVENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"多分この時間","date":"2026-09-07","startTime":"14:00","endTime":"15:00","tentative":true}' \
  "http://127.0.0.1:3113/api/internal/events" | jq .
```

## `PATCH /api/internal/events/[id]` / `DELETE /api/internal/events/[id]`

既存の予定1件を動かす・取り消す（起点: guchi-apps/aide-bot#372・issue #805）。認証は作成と同じ `DAYSPAN_INTERNAL_EVENTS_API_KEY`（書き込み用の鍵の分離を踏襲）。ブラウザ用の `PATCH` / `DELETE /api/events/[eventId]` と同じ処理（書き込み可否の判定・紐づけたタスクの日付の追随・記録／通知設定の掃除）を通す。

誤操作の影響を抑えるため、対象は必ず `calendarId` とIDで名指しさせる（`aide_schedule` の各予定の `id` / `calendarId` を使う。事前に確認してから呼ぶ想定）。繰り返しの親（シリーズ全体）は `409`（1回分のIDを指定する）。複数日にまたがる終日予定（出張など）もこの入口では扱えず `409`。日をまたぐ**時刻あり**の予定は `endDate`（issue #813）で終了日を指定すれば動かせる。

### `PATCH`

```jsonc
{
  "calendarId": "primary",     // 必須
  "title": "歯医者（変更）",    // 以下は全て任意。送った項目だけを変える。1つも無ければ400
  "date": "2026-09-08",         // 開始日
  "endDate": "2026-09-09",       // 終了日。日をまたぐときに date とセットで指定する（issue #813）
  "startTime": "14:00",         // startTime と endTime は両方指定
  "endTime": "15:00",
  "allDay": false,              // true で終日へ（時刻・endDateと同時指定は400）。終日→時刻ありは時刻が要る
  "location": "〇〇歯科",       // 空文字で消す
  "tentative": false            // 仮の予定⇄確定
}
```

応答は `{ "id": "...", "url": "..." }`。日付のみ・時刻のみの指定は、もう一方を今の値のまま保つ。`endDate` を省いたときは、`date`（開始日）を動かしたぶんだけ今のまたぎ幅（開始日から終了日までの日数。日をまたがない予定は0日）を保って一緒にずらし、`date` も送らなければ今の終了日のまま保つ。終了日時は開始日時より後であることを検証する（実際の日時どうしの比較で、`endTime` が `startTime` より前の時刻でも、日をまたいでいれば通る）。

### `DELETE`

`DELETE /api/internal/events/[id]?calendarId=...&title=...`

`title` に**予定の現在のタイトル**を必須で添える。一致しなければ `409`（`title_mismatch`、`currentTitle` を返す）で何も消えない。IDの取り違え・復唱と違う予定の削除を防ぐため。消せるのは1回分だけ（繰り返しの「これ以降・すべて」は無い）。応答は `{ "ok": true }`。

### エラー

| 状況 | 応答 |
| --- | --- |
| 認証エラー | `401` / `503` |
| 入力不正 | `400` |
| 予定が無い | `404`（`event_not_found`。Google側の存在しないIDも `502` ではなく外部エラーとして返る場合がある） |
| カレンダーが使用オフ・書き込み不可 | `403` / `404`（作成と同じ） |
| 繰り返しの親・複数日にまたがる終日予定・タイトル不一致 | `409` |

```bash
curl -s -X PATCH -H "Authorization: Bearer $DAYSPAN_INTERNAL_EVENTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"calendarId":"primary","startTime":"14:00","endTime":"15:00"}' \
  "http://127.0.0.1:3113/api/internal/events/EVENT_ID" | jq .

# 日をまたぐ時刻ありの予定（issue #813）
curl -s -X PATCH -H "Authorization: Bearer $DAYSPAN_INTERNAL_EVENTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"calendarId":"primary","date":"2026-09-07","endDate":"2026-09-08","startTime":"23:00","endTime":"06:00"}' \
  "http://127.0.0.1:3113/api/internal/events/EVENT_ID" | jq .

curl -s -X DELETE -H "Authorization: Bearer $DAYSPAN_INTERNAL_EVENTS_API_KEY" -G \
  --data-urlencode "calendarId=primary" --data-urlencode "title=歯医者" \
  "http://127.0.0.1:3113/api/internal/events/EVENT_ID" | jq .
```

## `POST /api/internal/notifications/dispatch`

通知の送信を1回ぶん走らせる（docs/spec.md §32・docs/notifications.md）。時刻が来た下書きを送り、
必要なら次の下書きを作り直す。

通常はアプリ内のタイマー（`src/instrumentation.ts`）が毎分呼ぶため、**外から叩く必要は無い。**
この入口を別に置いているのは、手で確かめられるようにするためと、将来VPSのcronから叩く形へ
移せるようにするため。二重に走っても、送信済みの印を送る前に立てているため同じ通知は2回送られない。

応答は `{ "ok": true }`。送った件数は返さない（呼び出し元がそれで分岐する場面が無く、
返すと「何件送られるはず」を呼び出し元が持つことになる）。

```bash
curl -s -X POST -H "Authorization: Bearer $INTERNAL_API_KEY" \
  "http://127.0.0.1:3113/api/internal/notifications/dispatch"
```

## `GET /api/internal/ai-usage`

ops-dashboard の「アプリ別のAI利用」（[guchi-apps/ops-dashboard#325](https://github.com/guchi-apps/ops-dashboard/issues/325)）が、
DaySpanのAI利用（どの機能が、どのモデルで、どれだけ使ったか）を読むための口（issue #680）。
連携の向きは **ops-dashboard のサーバーがDaySpanを読みにくる**形で、DaySpanから送りつけはしない。
応答の形の正は ops-dashboard の README「アプリ別のAI利用」と `src/lib/ai-app-usage/parse.ts`。

**認証は他の `/api/internal/*` と別の鍵（`OPS_API_TOKEN`）。** ops-dashboard と同じ値（1Password の
`op://apps/ops-dashboard/ops-api-token`）で、`Authorization: Bearer <OPS_API_TOKEN>` で受ける。
**`OPS_API_TOKEN` が未設定のときも、不一致と同じ `401` を返す**（他の鍵が未設定を `503` にしているのと違う。
呼び出し元との取り決めが「未設定・不一致は401」のため。未設定を素通りにしない点は同じで、空文字同士の一致も通さない）。
判定は `src/lib/ops-api-auth.ts`。

### 何を記録するか

Anthropic API を呼ぶ箇所は `src/lib/anthropic-messages.ts` の `requestAnthropicMessage` 1つに集約されている。
**成功した応答1件につき1行**を `AiUsageLog` へ書く（`src/lib/ai-usage-log.ts` の `saveAiUsage`）。

| 列 | 内容 |
| --- | --- |
| `feature` | 機能の識別子（下表）。表示名は集計時に引くので、名前を直しても過去の行が割れない |
| `model` | **応答が返したモデルID**（`claude-haiku-4-5-20251001` のように日付付きのことがある）。応答に無ければ要求したID |
| `inputTokens` | **キャッシュに載らなかった**入力トークン（`usage.input_tokens` をそのまま） |
| `outputTokens` | `usage.output_tokens` |
| `cacheReadTokens` | `usage.cache_read_input_tokens` |
| `cacheWriteTokens` | `usage.cache_creation_input_tokens` |
| `createdAt` | 記録時刻 |

| 識別子 | ops-dashboard に出す名前 | 呼び出し元 |
| --- | --- | --- |
| `place-suggest` | 場所の候補の提案 | `suggestPlaces`（`src/lib/ai-place-suggest.ts`。docs/spec.md §9） |
| `travel-estimate` | 移動の所要時間の見積もり | `estimateTravel`（`src/lib/ai-travel-estimate.ts`。docs/spec.md §29） |

- **記録するのは回数とトークン数だけ。** プロンプト本文・応答・入力した場所名・ユーザーは持たない（`userId` も無い。アプリ全体の使用量）
- **失敗した呼び出しは数えない。** HTTPエラー・通信不達には `usage` が無く、課金もされない前提のため。
  応答は返ったが解析に失敗した（JSONが壊れていた・テキストが無かった）呼び出しは、トークンを使っているので数える
- **記録に失敗しても、AIの結果は返す。** すでに課金された結果を、記録できなかっただけで捨てない。
  失敗はサーバーログに `[dayspan] AI usage log failed:` で出る（このとき使用量が実際より少なく出る）
- 呼び出し箇所を足すときは `src/lib/ai-usage.ts` の `AI_FEATURES` と `AI_FEATURE_LABELS` に足し、
  `requestAnthropicMessage` の `feature` を必ず指定する（型で漏れない）
- 行は消していない。1回の呼び出しが1行で、量は多くない（AIを呼ぶのはどちらもボタン操作だけ）

### レスポンス

```json
{ "features": [
  { "label": "場所の候補の提案", "model": "claude-haiku-4-5-20251001",
    "last24h": { "calls": 2, "inputTokens": 1500, "outputTokens": 150, "cacheReadTokens": 0, "cacheWriteTokens": 0 },
    "last7d":  { "calls": 3, "inputTokens": 2200, "outputTokens": 220, "cacheReadTokens": 0, "cacheWriteTokens": 0 } } ] }
```

- 機能×モデルごとに1行。同じ機能でモデルを切り替えていれば2行になる（日付付きのIDと日付なしのIDも別の行になる）
- 直近24時間・7日間は、**同じ「いま」を上限**に切った集計（`getAiUsageResponse`）
- 7日間にだけ呼び出しがある行は、24時間側を `0` で埋める（ops-dashboard は両方の期間を必須にしている）
- 呼び出しが無ければ `{ "features": [] }`（エラーにしない）
- 数値はすべて負でない整数。**1行でも形が違うと、ops-dashboard は応答全体を「取得不可」にする**ため、
  形を変えるときは ops-dashboard 側の `parse.ts` と突き合わせる
- `Cache-Control: no-store`。集計に失敗したときは `500`（`aggregation_failed`）

### 連携させるには

ops-dashboard の `AI_APP_USAGE_SOURCES`（JSON配列）に、DaySpanのURLを足す（ops-dashboard 側の設定）。
ops-dashboard は `url` に https か同じホスト内のループバックの http だけを受け付ける。

```json
[{"app":"dayspan","url":"https://dayspan.gucchii.com/api/internal/ai-usage"}]
```

### 動作確認

```bash
# 使用量（ローカルなら .env.local の OPS_API_TOKEN と同じ値）
curl -s -H "Authorization: Bearer $OPS_API_TOKEN" "http://127.0.0.1:3113/api/internal/ai-usage" | jq .

# 認証エラー（401 が返る。サーバー側の OPS_API_TOKEN が未設定でも同じ）
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3113/api/internal/ai-usage"
```

テストは `src/lib/ai-usage.test.mts`（集計・応答の形）、`src/lib/anthropic-messages.test.mts`
（記録・失敗時の扱い）、`src/lib/ops-api-auth.test.mts`（認証）。**テストは記録先を
`setAiUsageRecorder` で差し替える**。差し替え忘れると `fetch` をスタブしたテストが開発DBへ行を書く。

## 動作確認

```bash
curl -s -H "Authorization: Bearer $DAYSPAN_INTERNAL_API_KEY" \
  "http://127.0.0.1:3113/api/internal/schedule" | jq .

# 明日から3日ぶん
curl -s -H "Authorization: Bearer $INTERNAL_API_KEY" \
  "http://127.0.0.1:3113/api/internal/schedule?date=2026-08-20&days=3" | jq '.range, [.days[].date]'

# 期限切れタスクを取りにいかない（Notionへの往復が1回減る）
curl -s -H "Authorization: Bearer $INTERNAL_API_KEY" \
  "http://127.0.0.1:3113/api/internal/schedule?overdueDays=0" | jq '.sources, .overdueTasks'

# 認証エラー（401 が返る）
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3113/api/internal/schedule"
```

ローカル開発では共有トークンAPIを使うか、`.env.local` に `INTERNAL_API_KEY` をフォールバックとして設定する（本番の値は使わない）。ポートは `pnpm dev` の `PORT`。

## 環境変数の配線

| 場所 | 設定 |
| --- | --- |
| issue-deck | `DAYSPAN_INTERNAL_API_KEY`（読み取り用） / `DAYSPAN_INTERNAL_EVENTS_API_KEY`（予定書き込み用） / `DAYSPAN_INTERNAL_TASKS_API_KEY`（タスク書き込み用）の3共有トークンが**正**。それぞれ別の値にする |
| DaySpanの実行時 | `SHARED_TOKEN_API_SECRET` と `ISSUE_DECK_URL` で共有トークンAPIから取得する。ローカル開発・移行中に取得できない場合だけ同名の `INTERNAL_*_API_KEY` 環境変数へフォールバックする |
| GitHub Secret・本番 `.env` | 3鍵自体は置かない。共有トークンAPIへの接続情報だけを配る |

キーを更新するときはissue-deckの共有トークンを更新する。DaySpanは最大10分のキャッシュを使うため、反映まで待ってから呼び出し元（AIDE）側も同じ共有トークンを取得できることを確かめる。**3鍵の値を統合せず、読み取り・予定書き込み・タスク書き込みの分離を維持する。**
