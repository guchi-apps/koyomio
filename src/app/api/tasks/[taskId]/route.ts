import { NextResponse } from "next/server";

import { externalApiError } from "@/lib/api-error";

import { requireUserId } from "@/lib/auth-user";
import { getNotionConnection } from "@/services/calendar/write-context";
import { createNotionClient } from "@/services/notion/client";
import {
  completeTask,
  deleteTask,
  skipTask,
  TaskNotEditableError,
  updateTask,
  type TaskWriteInput,
} from "@/services/notion/tasks";
import { unlinkOverriddenTaskDateLinks, unlinkTaskByTaskId } from "@/services/task-links/links";

type Body = TaskWriteInput & { completeAction?: boolean; skipped?: boolean };

/**
 * タスクDB以外のページ（ゴミの日・勤務記録など）への書き込みは、経路によらず断る。
 * 応答は毎回作る（NextResponseの本文はストリームで、使い回すと2回目が空になる）。
 */
const notEditable = () =>
  NextResponse.json(
    { error: "not_editable", message: "この項目はYoteiFlowからは変更できません。" },
    { status: 403 },
  );

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const connection = await getNotionConnection(userId);
  if (!connection) {
    return NextResponse.json({ error: "not_connected" }, { status: 404 });
  }

  const { taskId } = await params;
  const body = (await request.json()) as Body;
  const notion = createNotionClient(connection);

  try {
    // 完了操作は繰り返しの次回作成を伴うため、単なるプロパティ更新とは経路を分ける
    // （docs/spec.md §13）。
    // 「対応しない」の付け外し（issue #750）。次回分は作らないため完了とも別に扱う。
    if (body.completeAction && body.skipped && body.done !== undefined) {
      await skipTask(notion, connection, taskId, body.done);
      return NextResponse.json({ ok: true, nextTaskId: null });
    }

    if (body.completeAction && body.done !== undefined) {
      const result = await completeTask(notion, connection, taskId, body.done);
      return NextResponse.json({ ok: true, nextTaskId: result.nextTaskId });
    }

    await updateTask(notion, connection, taskId, body);
    await unlinkOverriddenTaskDateLinks(userId, taskId, body);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TaskNotEditableError) return notEditable();
    return externalApiError("notion", "タスクの更新", error);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await requireUserId();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const connection = await getNotionConnection(userId);
  if (!connection) {
    return NextResponse.json({ error: "not_connected" }, { status: 404 });
  }

  const { taskId } = await params;

  try {
    await deleteTask(createNotionClient(connection), connection, taskId);
    // 消したタスクの紐づけは残しても指す先が無い。予定を動かすたびに、消えたページへ
    // 日付を書きにいくことにもなる。
    await unlinkTaskByTaskId(userId, taskId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TaskNotEditableError) return notEditable();
    return externalApiError("notion", "タスクの削除", error);
  }
}
