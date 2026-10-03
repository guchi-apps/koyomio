import assert from "node:assert/strict";
import test from "node:test";

import {
  InternalTaskInputError,
  matchesInternalDate,
  parseInternalTaskWrite,
  parseTaskAction,
} from "@/services/internal/task-contract";

test("内部タスク更新は許可外のプロパティを拒否する", () => {
  assert.throws(() => parseInternalTaskWrite({ title: "x", arbitrary: "value" }), InternalTaskInputError);
});

test("内部タスク作成はタイトルと正しい日付だけを受け付ける", () => {
  assert.deepEqual(parseInternalTaskWrite({ title: "  タスク  ", due: "2026-10-04" }, { create: true }), {
    title: "タスク",
    due: "2026-10-04",
  });
  assert.throws(() => parseInternalTaskWrite({ title: "x", due: "2026-02-30" }, { create: true }), InternalTaskInputError);
});

test("状態遷移は列挙値に限定する", () => {
  assert.equal(parseTaskAction("complete"), "complete");
  assert.throws(() => parseTaskAction("done"), InternalTaskInputError);
});

test("日付絞り込み: none は期限・予定日が両方無いタスクだけで from/to を無視する", () => {
  const range = { from: "2026-10-01", to: "2026-10-31" };
  assert.equal(matchesInternalDate({ due: null, planned: null }, { dateField: "none", ...range }), true);
  assert.equal(matchesInternalDate({ due: "2026-10-04", planned: null }, { dateField: "none" }), false);
  assert.equal(matchesInternalDate({ due: null, planned: "2026-10-04" }, { dateField: "none" }), false);
});

test("日付絞り込み: due/planned は両端を含み、値が無いタスクは除く", () => {
  const input = { dateField: "due" as const, from: "2026-10-01", to: "2026-10-31" };
  assert.equal(matchesInternalDate({ due: "2026-10-01", planned: null }, input), true);
  assert.equal(matchesInternalDate({ due: "2026-10-31T09:00:00+09:00", planned: null }, input), true);
  assert.equal(matchesInternalDate({ due: "2026-11-01", planned: null }, input), false);
  assert.equal(matchesInternalDate({ due: null, planned: "2026-10-05" }, input), false);
  assert.equal(matchesInternalDate({ due: null, planned: "2026-10-05" }, { ...input, dateField: "planned" }), true);
});
