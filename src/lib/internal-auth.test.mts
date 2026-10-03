import assert from "node:assert/strict";
import test from "node:test";

import {
  requireInternalApiKey,
  requireInternalEventsApiKey,
  requireInternalTasksApiKey,
  resolveInternalUserId,
} from "@/lib/internal-auth";
import { resetSharedTokenCache } from "@/lib/shared-token";

test("対象メールが無いサーバー間API要求は対象ユーザーを解決しない", async () => {
  const originalError = console.error;
  console.error = () => {};

  try {
    const userId = await resolveInternalUserId(new Request("https://example.test/api/internal/schedule"));
    assert.equal(userId, null);
  } finally {
    console.error = originalError;
  }
});

test("内部API用の3鍵はissue-deckの共有トークンを環境変数より優先する", async () => {
  const originalFetch = globalThis.fetch;
  const keys = [
    "ISSUE_DECK_URL",
    "SHARED_TOKEN_API_SECRET",
    "INTERNAL_API_KEY",
    "INTERNAL_EVENTS_API_KEY",
    "INTERNAL_TASKS_API_KEY",
  ] as const;
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const names: string[] = [];

  try {
    process.env.ISSUE_DECK_URL = "https://deck.test";
    process.env.SHARED_TOKEN_API_SECRET = "shared-token-api-secret";
    process.env.INTERNAL_API_KEY = "fallback-read";
    process.env.INTERNAL_EVENTS_API_KEY = "fallback-events";
    process.env.INTERNAL_TASKS_API_KEY = "fallback-tasks";
    globalThis.fetch = (async (input: string | URL | Request) => {
      const name = new URL(String(input)).searchParams.get("name");
      assert.ok(name);
      names.push(name);
      return Response.json({ value: `shared-${name}` });
    }) as typeof fetch;
    resetSharedTokenCache();

    const requests = [
      [requireInternalApiKey, "DAYSPAN_INTERNAL_API_KEY"],
      [requireInternalEventsApiKey, "DAYSPAN_INTERNAL_EVENTS_API_KEY"],
      [requireInternalTasksApiKey, "DAYSPAN_INTERNAL_TASKS_API_KEY"],
    ] as const;
    for (const [requireKey, sharedName] of requests) {
      const response = await requireKey(
        new Request("https://example.test/api/internal", {
          headers: { authorization: `Bearer shared-${sharedName}` },
        }),
      );
      assert.equal(response, null);
    }

    assert.deepEqual(names, requests.map(([, sharedName]) => sharedName));
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    resetSharedTokenCache();
  }
});
