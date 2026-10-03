# セットアップチェックリスト（人手作業）

DaySpan を動かすために必要な、リポジトリ外の設定作業をまとめる。エージェントは 1Password・Google Cloud Console・Supabase・Notion・VPS・DNS・GitHub の Web 画面を操作できないため、以下はユーザーが実施する。

共通の手順は [m-guchi/docs](https://github.com/m-guchi/docs) の `guides/new-app-checklist.md` を一次情報源とし、ここには DaySpan 固有の値と、通常のチェックリストに無い項目だけを書く。

## 1. シークレットの管理先

| フィールド | 値 |
|---|---|
| `target-dir` | VPS上の配置先（例: `/apps/dayspan`） |
| `port` | `3113` |
| `db-name` | `app_dayspan` |
| `token-encryption-key` | `openssl rand -base64 32` で生成した32byte鍵 |
| `google-calendar-client-id` | 本番用のDaySpan専用OAuthクライアントID |
| `google-calendar-client-secret` | 同シークレット |
| （issue-deckの共有トークン） | `DAYSPAN_INTERNAL_API_KEY`（読み取り用）・`DAYSPAN_INTERNAL_EVENTS_API_KEY`（予定書き込み用）・`DAYSPAN_INTERNAL_TASKS_API_KEY`（タスク書き込み用）はissue-deckで管理する。3値は互いに別にし、呼び出し元のAIDEも同名の共有トークンから読む（docs/internal-api.md） |
| （`ops-dashboard` アイテムの `ops-api-token`） | ops-dashboardがAIの使用量（`GET /api/internal/ai-usage`）を読むときのBearer認証。**値の正は `op://apps/ops-dashboard/ops-api-token` で、`dayspan` アイテムへは複製しない**（ops-dashboard・issue-deckと同じ値を持つ。docs/internal-api.md） |
| （`issue-deck` アイテムの `typesafe-api-key`） | 買い物リストのカテゴリの自動判定（TypeSafeのJev・issue #725）。**値の正は `op://apps/issue-deck/typesafe-api-key` で、`dayspan` アイテムへは複製しない**。未設定でも判定以外は動く |
| `ci-webhook-url` | Signaly の DaySpan 用チャンネルWebhook URL |
| `vapid-public-key` | 通知（Web Push）の公開鍵。`node scripts/gen-vapid-keys.mjs mailto:自分のアドレス` の出力（docs/notifications.md） |
| `vapid-private-key` | 同・秘密鍵。上のコマンドが公開鍵と対で出す |
| `vapid-subject` | 同・連絡先。`mailto:` か `https://` で始める |
| （App Store Connect） | `ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`（TestFlight自動配信・#961）は専用の項目を持たず、`op://apps/AppStoreConnect/key-id`・`issuer-id`・`key-p8` を参照する（kurashioのCIと同じ。キーの正を1か所にする）。`key-p8` は `.p8` の中身をbase64の1行にした値。内部グループが複数あるときだけ GitHub の variable `TESTFLIGHT_GROUP` にグループ名を置く |
| （APNs） | `APNS_KEY_ID`・`APNS_TEAM_ID`・`APNS_PRIVATE_KEY` は専用の項目を持たず、kurashio（MyRoom）の `op://apps/MyRoom/apns-key-id`・`apns-team-id`・`apns-auth-key` をそのまま参照する。APNsの認証キー（.p8）はApple DeveloperのTeam単位で、同じTeamの全アプリに使えるため（#957）。`apns-auth-key` はPEMのままでよい（デプロイが改行を `\n` へ直して `.env` へ書く）。YoteiFlowのBundle IDはコード側の既定値（`com.gucchii.yoteiflow`）で分ける |

**`TRAINROUTE_TOKEN`（電車の所要時間を trainroute 経由で引くための共有シークレット）を撤去した。**
交通系APIの窓口を `guchi-apps/trainroute` に置き、`op://apps/trainroute/internal-api-key` を
参照する構成だったが、画面からは一度も呼ばれないまま電車の所要時間はYahoo!乗換案内からの
取り込みへ移行し、trainroute自体も廃止・VPSから撤去されることになったため、issue #591 で
DaySpan側の連携コード・`.github/secrets-manifest.tsv` の参照を削除した（詳細はdocs/spec.md §29）。
**1Password（`dayspan` アイテムは元々未使用）・GitHub Secrets・VPS上の `.env` に残っている値は、
このPRの対象外。人手で個別に消す。**

共通アイテム（`DB` / `Server` / `githubaction-sshkey` / `Supabase`）は既存のものをそのまま参照する（`.github/deploy.env.tpl` 参照）。

機械可読の正は `.github/secrets-manifest.tsv` で、この表はその人手作業ぶんを日本語で並べたもの。
1Passwordへ入れたあとは、GitHub Secretsへの同期まで行って初めて本番へ届く。

```bash
gh workflow run sync-secrets.yml -f only=VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY,VAPID_SUBJECT,APNS_KEY_ID,APNS_TEAM_ID,APNS_PRIVATE_KEY
```

内部API用の3鍵を新設・変更した場合は、issue-deckの共有トークン画面で値を登録・更新し、利用元に`dayspan`と呼び出し元が記録されたことを確かめる。GitHub Secretへの同期やVPSの`.env`への配布は不要である。

ASC_*（TestFlight自動配信）をマニフェストへ足した直後は、行がまだ `develop` に無いため、**足したブランチを指定して**同期する（ワークフローは起動したrefのマニフェストを読む。`--ref` が無いと対象が0件になる）。マージ後は上と同じ形でよい。

```bash
gh workflow run sync-secrets.yml --ref <ブランチ名> -f only=ASC_KEY_ID,ASC_ISSUER_ID,ASC_KEY_P8
```

（手元から `scripts/sync-github-secrets.sh` を叩く場合は個人アカウントのセッションが要る。
サービスアカウントのトークンが環境変数にあると `op` の書き込みだけが全部失敗する。）

**同期しないとデプロイは空の値をそのまま本番の `.env` へ書き、その機能だけが黙って使えないまま残る。**
実際に `vapid-*` の3つが登録されないまま、設定画面に「鍵が設定されていません」と出続けていた（#359）。
これを見つけるために、デプロイのたびに `secrets-check` ジョブがマニフェストの `repo` 項目と
突き合わせ、空のものがあればSignalyへ知らせる。

同期したあとは `gh secret list` に並んだことを確かめる。**ここまでやって初めて済んだことになる。**

**マニフェストへ `repo` 項目を足す変更は、同期まで済ませてからマージする。** CI（`ci.yml` の
`secrets-check`）が develop 向けのPR・pushで同じ突き合わせを行い、届いていない値があれば
**ジョブを落とす**。deploy側（`deploy.yml`）は warning を出すだけでデプロイを続けるため、
デプロイが緑であることは登録できた根拠にならない（#400 では #359 と同じ状態が気付かれずに残り、
同じ症状が再び報告された。#476 の `TRAINROUTE_TOKEN` も、1Passwordには入っているのに
同期されないままリリースをまたいでいた）。deploy側を落とさないのは、VAPID鍵のように
無くても他の機能は動く値が含まれるため。**気付ける場所をマージ前へ移すのがCI側の役割。**

## 2. Supabase（他アプリと共有のプロジェクト）

- Authentication > URL Configuration > Redirect URLs に以下を追加する
  - `https://dayspan.gucchii.com/auth/callback`
  - `http://localhost:3000/auth/callback`（ローカル開発用）
  - 実機確認をする場合は `http://<LAN IP>.sslip.io:3000/auth/callback`
  - iOSアプリ（`ios/`・issue #908）用に新しく足すURLは無い（戻り先は同じ `/auth/callback`。クエリ付きが弾かれたら実機確認で分かる。`ios/README.md`）
- Google プロバイダは既に有効化済みのものを使う。**カレンダーのスコープはここに追加しない**（他アプリのログインに影響するため。下記3で別クライアントを用意する）

## 3. Google Cloud Console（DaySpan専用のGCPプロジェクト）

Google Calendar API 用に、ログイン用（Supabase Auth）とは別の OAuth 2.0 クライアントを本番用・開発用の2つ作成する。

**このクライアントは他アプリと共有しているGCPプロジェクトではなく、DaySpan専用のGCPプロジェクトへ置く。** 同意画面のスコープ一覧はプロジェクト単位で、OAuthクライアントを分けても分離できない（共有知識 `knowledge/common-gotchas.md`）。共有プロジェクトのまま審査へ出すと、他アプリが登録したスコープまで審査対象に入り、DaySpanの都合で他アプリの認可を止めうる。

### 公開ステータスは「本番」にする

公開ステータスが「テスト」の間、**リフレッシュトークンは7日で失効する**（[Google公式](https://developers.google.com/identity/protocols/oauth2)。例外は name / email / profile だけを要求する場合で、カレンダーのスコープは当たらない）。失効するとカレンダー画面に「認可が失効しました」と出て、設定画面から再接続するまで予定を取得できない（`GoogleReauthRequiredError`）。

**7日失効の条件は「公開ステータスがテストであること」に紐づいており、審査が完了していることではない。** 「本番」へ切り替えた時点で解消するため、審査の結果を待つ間も7日ごとの再接続は要らない。審査を通す理由は、同意画面の「確認されていないアプリ」の警告を消すことと、未確認のまま本番で運用したときに掛かる**総計100ユーザーのハードキャップ**を外すことの2点。

### 手順

1. 新しいGCPプロジェクト（例: `dayspan`）を作成する
2. Google Calendar API を有効化する
3. Google Auth Platform（同意画面）を構成する
   - ユーザーの種類: 外部
   - アプリ名・ユーザーサポートメール・デベロッパーの連絡先
   - スコープは `https://www.googleapis.com/auth/calendar.events` と `https://www.googleapis.com/auth/calendar.readonly` に限定する（必要以上に広い権限を要求しない。仕様 §17）
4. OAuth 2.0 クライアント（ウェブアプリケーション）を本番用・開発用の2つ作成する
   - 本番の承認済みリダイレクトURI: `https://dayspan.gucchii.com/api/google/callback`
   - 開発の承認済みリダイレクトURI: `http://localhost:3000/api/google/callback`
5. 公開ステータスを「本番」にする（**この時点で7日失効は解消する**）
6. 審査を申請する（必要なものは下記）
7. 本番用のクライアントID・シークレットを 1Password（`op://apps/dayspan/google-calendar-client-id` / `google-calendar-client-secret`）へ入れ、GitHub Secrets へ同期する

   ```bash
   gh workflow run sync-secrets.yml -f only=GOOGLE_CALENDAR_CLIENT_ID,GOOGLE_CALENDAR_CLIENT_SECRET
   ```

8. 開発用は 1Password へ登録せず、本体チェックアウトの `.env.local` に直接記載する（README「本体チェックアウトの `.env.local` は worktree の前提」）
9. デプロイ後、設定画面から Google Calendar を**再接続する**。**旧クライアントで得たリフレッシュトークンは新クライアントでは使えない**ため、切り替えた直後は必ず1回の再接続が要る
10. 共有プロジェクト側に残っている DaySpan 用のOAuthクライアントを削除する

### 審査に必要なもの

センシティブスコープ（カレンダー）を要求するため、ブランド確認に加えて次が要る。

- **検証済みドメイン上のホームページ**。Search Console でドメイン（`gucchii.com`）の所有権を確認しておく
- **プライバシーポリシーのURL**。ホームページと同意画面の**両方から**リンクする必要がある。**DaySpanには現状このページが無いため、審査を出す前に用意する**
- **デモ動画**。OAuthの同意フローを含む、申請したアプリそのものの操作を端から端まで写したもの
- **各スコープの正当性の説明**。より狭いスコープでは足りない理由を書く

審査には数週間かかることがある。上記のとおり待っている間も「本番（未確認）」として動くため、7日ごとの再接続は発生しない。

## 4. Notion

- Notion側に DaySpan 用のタスクDBを用意する（DaySpanからは作成しない。仕様 §9）
- Internal Integration を作成し、そのタスクDBに接続を許可する
- 発行された Integration Token は、DaySpanの設定画面から入力する（1Password・環境変数には置かない。ユーザーごとにDBへ暗号化保存する）

必要なプロパティ構成（名前は接続時にDaySpan側でマッピングする）:

| 用途 | Notionのプロパティ型 |
|---|---|
| タイトル | title |
| 期限 | date（時刻あり / 日付のみ / 未設定を許容） |
| 完了状態 | checkbox または status |
| メモ | rich_text |
| 優先度 | select（高 / 中 / 低） |
| 繰り返し | select（なし / 毎日 / 毎週 / 毎月 / 毎年） |
| タグ | multi_select |

## 5. データベース（VPS）

```sql
CREATE DATABASE app_dayspan CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

アプリ用ユーザー・マイグレーション用ユーザーへの権限付与は既存アプリと同じ方針（共通 `DB` アイテムのユーザーを利用）。

## 6. GitHub

- デフォルトブランチを `develop` に変更する
- `main` の Branch protection を設定する（CI必須チェック + PR経由のみ）
- リポジトリ Secrets に `OP_SERVICE_ACCOUNT_TOKEN` を追加する
- Issueラベルを `m-guchi/docs` の `label-sync/` から同期する

## 7. VPS

- `/apps/dayspan/` を作成する
- Apache VirtualHost を追加する（`dayspan.gucchii.com` → `127.0.0.1:3113`）。DNS登録・Let's Encrypt証明書の取得を含む
- 本番プロセスを追加する前に、実機のメモリ余力を確認する（VPSは約2GB。仕様 §24）

## 8. 一覧への登録

- [m-guchi/vps](https://github.com/m-guchi/vps#アプリ一覧) の README のアプリ一覧に DaySpan を追加する
- `m-guchi/docs` の `standards/tech-stack.md` のスタック一覧に追加する
