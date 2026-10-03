# DaySpan

Google Calendar の予定、Notion のタスクと日付リマインドを、1つのカレンダーUIで統合して確認するWebアプリです。

## 概要

- Google Calendar の複数カレンダーを統合表示
- Google Calendar の予定を作成・編集・削除
- Notion をタスクの一次情報源として利用
- Notion タスクを作成・編集・完了・期限変更
- Notion の記念日・更新日など、完了を持たない日付リマインドを月カレンダーと専用一覧に表示
- 月表示と、0:00〜24:00 の時間グリッド表示
- スマートフォンは月 / 1日表示、PCは月 / 3日 / 7日表示
- Supabase Auth + Google OAuth による認証
- PWA対応。オフライン時は取得済みデータの閲覧のみ可能

詳細仕様は [docs/spec.md](docs/spec.md) を参照してください。

## 構成

| 項目 | 内容 |
|---|---|
| フレームワーク | Next.js 16（App Router）/ React 19 / TypeScript |
| スタイリング | Tailwind CSS v4 + shadcn/ui |
| DB | MariaDB + Prisma（`app_dayspan`） |
| 認証 | Supabase Auth + Google OAuth（他アプリと共有のSupabaseプロジェクト） |
| 本番URL | `https://dayspan.gucchii.com` |
| 本番ポート | `3113`（PM2、プロセス名 `dayspan`） |

共通の開発標準・運用知識は [guchi-apps/docs](https://github.com/guchi-apps/docs) を一次情報源とします。

### データの一次情報源

予定本体は Google Calendar、タスク本体は Notion が一次情報源で、DaySpan の DB へは恒久的に保存しません。DaySpan の DB が保持するのは連携設定・表示設定・連携メタデータのみです（`prisma/schema.prisma`）。

### 認可の分離

ログイン用の Google OAuth（Supabase Auth 側、他アプリと共有）と、Google Calendar API 用の OAuth（DaySpan 専用の GCP プロジェクトのクライアント）を分けています。共有 Supabase / Google Cloud プロジェクトの同意画面にカレンダーのセンシティブスコープを追加せずに済ませるためです。同意画面のスコープ一覧と審査はプロジェクト単位のため、カレンダー側は専用の GCP プロジェクトへ置き、公開ステータスを「本番」にして運用します（「テスト」のままだとリフレッシュトークンが7日で失効します。[docs/spec.md](docs/spec.md) §17・[docs/setup-checklist.md](docs/setup-checklist.md) §3）。カレンダー連携は設定画面から個別に接続し、リフレッシュトークンは AES-256-GCM で暗号化して DaySpan の DB に保存します。

### 他アプリからの参照

同じ VPS 上で動く他アプリ（AIDE）が、その日の予定・タスク・日付リマインド・移動をまとめて読むための読み取り専用 API（`GET /api/internal/schedule`）があります。認証は共有シークレット 1 本で、外部公開はしていません。詳細は [docs/internal-api.md](docs/internal-api.md) を参照してください。

## ローカル開発

```bash
pnpm install
pnpm env:init        # .env.local.example を .env.local へコピー（初回のみ）
# .env.local を編集（DATABASE_URL / Supabase / 許可メール / 暗号鍵）
pnpm db:setup        # ローカルMariaDBにDB・ユーザーを作成
pnpm db:migrate:dev --name init
pnpm dev             # http://localhost:3000
```

暗号鍵は `openssl rand -base64 32` で生成します。

Googleログインを通すには、共有Supabaseプロジェクトの Redirect URLs に `http://localhost:3000/auth/callback` を登録し、StatusHubの共通アクセス設定（宛先は `https://admin.gucchii.com` が既定で、別の宛先へ向けるときだけ `ACCESS_API_URL`。トークンは管理画面の「トークン発行」がissue-deckの共有トークン `YOTEIFLOW_ACCESS_APP_TOKEN` へ自動で書き込む。ローカルでは `ISSUE_DECK_URL`・`SHARED_TOKEN_API_SECRET` が無ければ環境変数 `ACCESS_APP_TOKEN` に直接入れる。管理画面でyoteiflowに自分のGoogleアカウントを許可する）が必要です（未設定だと全員拒否）。

### 本体チェックアウトの `.env.local` は worktree の前提

**Issueごとのworktree・確認環境へ配られる `.env.local` の元は、本体チェックアウト（`~/apps/dayspan`）の `.env.local` です。** `scripts/start-issue.sh` と issue-deck の `supply_env_files` はどちらも本体側のファイルをコピーする作りで、本体に無ければworktreeへは何も配りません。

配られないまま起動すると、`src/proxy.ts` の `updateSession()` が毎リクエストで `createServerClient()` を呼ぶため、`/login` を含む**全ページが500**になります（`Your project's URL and Key are required to create a Supabase client!`）。画面には出ず、原因が読めるのはサーバーログだけです。

サブPC（Ubuntu Server・SSH越し）では、本体チェックアウトに一度だけ次を行っておきます。以後のworktreeと確認環境へは自動で配られます。

```bash
cd ~/apps/dayspan
pnpm env:init        # .env.local.example を .env.local へコピー

# Supabaseの開発用値だけを1Passwordから入れる（本番の値は入れない）
u() { bash scripts/update-env-file.sh .env.local "$1" "$2"; }
u NEXT_PUBLIC_SUPABASE_URL "$(op read 'op://apps/Supabase/personal-apps-dev/dev-project-url')"
u NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY "$(op read 'op://apps/Supabase/personal-apps-dev/dev-publishable-key')"
u TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32)"   # ローカル専用。本番の鍵は持ち込まない
u INTERNAL_API_KEY "$(openssl rand -hex 32)"          # 内部APIをローカル確認するときだけ使うフォールバック
u INTERNAL_EVENTS_API_KEY "$(openssl rand -hex 32)"   # 同上。読み取り用とは別の値
u INTERNAL_TASKS_API_KEY "$(openssl rand -hex 32)"    # 同上。予定書き込み用とも別の値
chmod 600 .env.local

bash scripts/setup-db.sh   # ローカルMariaDBにDB・ユーザーを作成（sudo mysql が通ること）
```

本体には `node_modules` を置いていないため、マイグレーションはworktree側で `pnpm exec prisma migrate deploy` を実行します（DBは本体・worktreeで共通の `app_dayspan`）。

`GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET` は開発用のOAuthクライアントで1Passwordには無く、空のままで構いません。空だとカレンダー連携の接続だけができず、画面は開きます。VAPID鍵も同様に任意です。

すでに作成済みのworktreeには、`scripts/start-issue.sh <issue番号>`（または issue-deck の「ローカルで開始」）をもう一度通すと配られます。手で置く場合は本体の `.env.local` をコピーし、`PORT` を `6000 + Issue番号` に直します。

### スマートフォンからの確認

`pnpm dev` を実行すると、`scripts/setup-lan-access.sh` がWindows側のポートフォワーディングとファイアウォール許可を設定し（UACダイアログが出るので許可する）、アクセスURLを表示します。WSL以外（サブPCのUbuntu Serverなど）では `powershell.exe` が無いため何もせず、devサーバーの起動だけが続きます。

```
LAN経由でのアクセスURL（同一LAN上の別端末から）:
  http://192.168.2.114.sslip.io:3000
Supabaseの Redirect URLs に未登録なら追加してください:
  http://192.168.2.114.sslip.io:3000/auth/callback
```

**生のLAN IPではGoogleログインが必ず失敗します。** Supabase Auth はホスト名がIPアドレスとして解釈できる場合、許可リストの照合より前にループバック以外を拒否するためです（設定では回避できない実装上の仕様）。`sslip.io` はDNSを引くとホスト名に含まれるIPをそのまま返すため、通信はLAN内で完結したままホスト名としてアクセスできます。

表示されたURLの `/auth/callback` をSupabaseの Redirect URLs に登録してからアクセスしてください。Windows側のLAN IPが変わった場合は、新しいURLの登録が必要です。

`next.config.mjs` の `allowedDevOrigins` は `**.sslip.io` を指定しています。`*` は1ラベルにしか一致せず、`192.168.2.114.sslip.io` のようにIPがラベルとして並ぶホスト名には届きません。ここが一致しないと dev サーバーがJavaScriptチャンクをブロックし、画面は表示されるのにボタンが一切反応しない状態になります。

### 検証コマンド

```bash
pnpm lint        # ESLint
pnpm typecheck   # tsc --noEmit
pnpm test        # lint + typecheck
pnpm build       # 本番ビルド
```

## デプロイ

`main` への push で `.github/workflows/deploy.yml` が VPS へ SSH デプロイし、PM2（プロセス名 `dayspan`、ポート 3113）を再起動します。通常のシークレットはGitHub Secretsから注入し、内部API用の3鍵は実行時にissue-deckの共有トークンから取得します。

初回デプロイ前に必要な手作業は [docs/setup-checklist.md](docs/setup-checklist.md) を参照してください。

## 開発ルール

このリポジトリ固有のルールは [CLAUDE.md](CLAUDE.md) を参照してください。
共通の開発標準・運用知識は `guchi-apps/docs` を一次情報源とします。
