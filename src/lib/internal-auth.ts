import { timingSafeEqual } from "node:crypto";

import { db } from "@/lib/db";
import { TARGET_EMAIL_HEADER, parseTargetEmail } from "@/lib/internal-target";
import { getSharedToken } from "@/lib/shared-token";

/**
 * サーバー間参照用API（`/api/internal/*`）の認証（docs/internal-api.md）。
 *
 * 呼び出し元は同一VPS上のAIDE（`127.0.0.1`）だけを想定しており、共有シークレット1本で守る。
 * ブラウザからの利用が無いためSupabaseのセッションは見ない（このパスは src/proxy.ts が
 * Supabaseへ問い合わせずに素通しする）。
 *
 * 通過した場合は null を返す。既存ルートの `if (!userId) return ...` と同じ書き味に合わせ、
 * 呼び出し側が「返り値があればそのまま返す」だけで済むようにする。
 */
export async function requireInternalApiKey(request: Request): Promise<Response | null> {
  return requireBearerKey(request, "DAYSPAN_INTERNAL_API_KEY", "INTERNAL_API_KEY", "internal_api_not_configured");
}

/**
 * 書き込み系（`POST /api/internal/events` 等）の認証。読み取り用の `INTERNAL_API_KEY` とは
 * 別の共有トークン（`DAYSPAN_INTERNAL_EVENTS_API_KEY`）で守る（docs/internal-api.md「認証」）。
 *
 * 読み取り用のキーが漏れても予定を書き込まれないようにするための分離で、比較・未設定時の
 * 扱いは読み取り用とまったく同じ。
 */
export async function requireInternalEventsApiKey(request: Request): Promise<Response | null> {
  return requireBearerKey(
    request,
    "DAYSPAN_INTERNAL_EVENTS_API_KEY",
    "INTERNAL_EVENTS_API_KEY",
    "internal_events_api_not_configured",
  );
}

/** タスクの作成・更新・状態遷移専用の認証。予定の書き込み鍵とも共有しない。 */
export async function requireInternalTasksApiKey(request: Request): Promise<Response | null> {
  return requireBearerKey(
    request,
    "DAYSPAN_INTERNAL_TASKS_API_KEY",
    "INTERNAL_TASKS_API_KEY",
    "internal_tasks_api_not_configured",
  );
}

async function requireBearerKey(
  request: Request,
  sharedTokenName:
    | "DAYSPAN_INTERNAL_API_KEY"
    | "DAYSPAN_INTERNAL_EVENTS_API_KEY"
    | "DAYSPAN_INTERNAL_TASKS_API_KEY",
  fallbackEnvName: "INTERNAL_API_KEY" | "INTERNAL_EVENTS_API_KEY" | "INTERNAL_TASKS_API_KEY",
  notConfiguredError: string,
): Promise<Response | null> {
  // 正は issue-deck の共有トークン。取得できないときだけ従来の環境変数へ落ちる（issue #860）。
  const expected = await getSharedToken(sharedTokenName, fallbackEnvName);

  // 未設定を「素通り」にはしない。設定漏れがそのまま認証なしの公開に化けるのを防ぐ。
  if (!expected) {
    return json({ error: notConfiguredError }, 503);
  }

  const header = request.headers.get("authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!presented || !isEqualConstantTime(presented, expected)) {
    return json({ error: "unauthorized" }, 401);
  }

  return null;
}

/**
 * サーバー間参照APIが対象とするユーザーのIDを返す。引けなければ null。
 *
 * 対象は呼び出し元（AIDE）がヘッダー `X-Target-Email` で指定する（issue #1012）。ログインの
 * 許可はStatusHubが決めており、このAPIはログインを通らないため「誰の予定か」だけをここで決める。
 * ヘッダーが無い・不正・引けない場合は、別人を返さないよう null にする。
 */
export async function resolveInternalUserId(request: Request): Promise<string | null> {
  const target = parseTargetEmail(request.headers.get(TARGET_EMAIL_HEADER));

  if (target.kind === "invalid") {
    console.error("[dayspan] internal target user: invalid header");
    return null;
  }

  if (target.kind === "email") {
    const user = await db.user.findUnique({ where: { email: target.email }, select: { id: true } });
    if (!user) console.error("[dayspan] internal target user: not found");
    return user?.id ?? null;
  }

  console.error("[dayspan] internal target user: missing header");
  return null;
}

/** 応答は経路上に残さない。認証結果も内容も、その時点の値だけが意味を持つ。 */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** 文字列を定数時間で比較する（長さが違うと timingSafeEqual が例外を投げるため先に弾く）。 */
function isEqualConstantTime(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
