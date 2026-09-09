import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { executeCalendarDrafts, type ExecuteResultItem } from "@/lib/agent/calendar";
import type { CalendarDraftItem } from "@/lib/types";

/** 本地墙钟字符串（YYYY-MM-DDTHH:mm:ss，无时区后缀）——与 Python Draft Builder/ICS 的 naive 本地语义一致。
 *  绝不能用 toISOString()：会转 UTC，跨时区比较必然漂移。 */
function localWallClock(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * POST /api/goals/:id/calendar/confirm —— 用户确认后执行写入。
 * 幂等：已 executed 的草稿不重复执行（DB 状态门 + Python UID 复检双层）。
 * 部分失败如实逐条上报，绝不假装整体成功。
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const goal = await prisma.goal.findUnique({
      where: { id },
      include: { tasks: true, calWrites: { where: { goalId: id } } },
    });
    if (!goal) return NextResponse.json({ ok: false, error: "目标不存在" }, { status: 404 });

    const pending = await prisma.calendarDraft.findMany({
      where: { goalId: id, status: "pending_confirmation" },
      orderBy: { proposedStart: "asc" },
    });
    if (pending.length === 0) {
      return NextResponse.json({ ok: false, error: "没有待确认的日历草稿" }, { status: 400 });
    }

    await prisma.calendarDraft.updateMany({
      where: { goalId: id, status: "pending_confirmation" },
      data: { status: "confirmed" },
    });

    // 只把「确认且从未成功执行过」的草稿发给执行器（DB 幂等门）
    const existingKeys = new Set(goal.calWrites.filter((w) => w.status === "success").map((w) => idempotencyKeyOf(w.idempotencyKey)));
    const estByTask = new Map(goal.tasks.map((t) => [t.id, t.estMinutes]));
    const toExecute: CalendarDraftItem[] = [];
    const skippedAsExecuted: string[] = [];
    for (const d of pending) {
      if (existingKeys.has(d.idempotencyKey)) {
        skippedAsExecuted.push(d.idempotencyKey);
        await prisma.calendarDraft.update({ where: { id: d.id }, data: { status: "duplicate_skipped" } });
      } else {
        toExecute.push({
          taskId: d.taskId,
          taskTitle: d.taskTitle,
          proposedStart: localWallClock(d.proposedStart),
          proposedEnd: localWallClock(d.proposedEnd),
          calendarId: d.calendarId,
          actionType: "create",
          reason: d.reason,
          idempotencyKey: d.idempotencyKey,
        });
      }
    }

    let results: ExecuteResultItem[] = skippedAsExecuted.map((k) => ({
      idempotencyKey: k,
      status: "duplicate_skipped" as const,
      verify: { found: true, startOk: true, endOk: true, unique: true },
    }));

    if (toExecute.length > 0) {
      const executed = await executeCalendarDrafts({
        goalId: id,
        planVersion: goal.revision,
        drafts: toExecute,
        tasks: [...new Set(toExecute.map((d) => d.taskId))].map((tid) => ({
          taskId: tid,
          estMinutes: estByTask.get(tid) ?? 60,
        })),
      });
      results = results.concat(executed.results);
    }

    // 逐条落库：draft 状态 + write 记录
    const summary = { success: 0, duplicate_skipped: 0, stale_conflict: 0, failed: 0 };
    for (const r of results) {
      const draft = pending.find((d) => d.idempotencyKey === r.idempotencyKey);
      const finalStatus =
        r.status === "success" ? "executed" : r.status === "duplicate_skipped" ? "duplicate_skipped" : r.status;
      summary[r.status] += 1;
      if (draft) {
        await prisma.calendarDraft.update({ where: { id: draft.id }, data: { status: finalStatus } });
      }
      await prisma.calendarWrite.upsert({
        where: { idempotencyKey: r.idempotencyKey },
        create: {
          draftId: draft?.id ?? `${r.idempotencyKey}:unknown`,
          goalId: id,
          planVersion: goal.revision,
          taskId: r.idempotencyKey.split(":")[2] ?? "",
          provider: "ics",
          externalEventId: r.externalEventId ?? null,
          idempotencyKey: r.idempotencyKey,
          status: r.status,
          error: r.error ?? null,
        },
        update: { status: r.status, error: r.error ?? null },
      });
    }

    const drafts = await prisma.calendarDraft.findMany({
      where: { goalId: id, planVersion: goal.revision },
      orderBy: { proposedStart: "asc" },
    });
    return NextResponse.json({ ok: true, data: { results, summary, drafts } });
  } catch (e) {
    // Python 不可达等：草稿停留 confirmed，可重试（幂等保证安全）
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "日历写入失败（草稿保留，可重试确认）" },
      { status: 502 },
    );
  }
}

/** 幂等 key 归一化（DB 存储可能与执行器返回的格式一致，此处防漂移） */
function idempotencyKeyOf(k: string): string {
  return k.trim();
}
