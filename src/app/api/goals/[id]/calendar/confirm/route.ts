import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { executeCalendarDrafts, type ExecuteResultItem } from "@/lib/agent/calendar";
import { getPlanningPolicy } from "@/lib/policy";
import { traceEvent } from "@/lib/trace";
import type { CalendarDraftItem } from "@/lib/types";

/** 本地墙钟已废除（Phase 7.5）：Instant 直接以 ISO Z 传输，墙钟转换只在 Python。 */

/**
 * POST /api/goals/:id/calendar/confirm —— 用户确认后执行写入。
 * 幂等：已 executed 的草稿不重复执行（DB 状态门 + Python UID 复检双层）。
 * 部分失败如实逐条上报，绝不假装整体成功。
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const t0 = Date.now();
  const runId = crypto.randomUUID().slice(0, 8);
  let goalId = "";
  try {
    const { id } = await ctx.params;
    goalId = id;
    const goal = await prisma.goal.findUnique({
      where: { id },
      include: { tasks: true, calWrites: { where: { goalId: id } } },
    });
    if (!goal) return NextResponse.json({ ok: false, error: "目标不存在" }, { status: 404 });

    // Phase 9 超时恢复：confirmed（执行中断/超时遗留）草稿一并纳入重试——
    // DB 幂等门 + provider pre-check 双层防护保证不重复写入。
    const pending = await prisma.calendarDraft.findMany({
      where: { goalId: id, status: { in: ["pending_confirmation", "confirmed"] } },
      orderBy: { proposedStart: "asc" },
    });
    if (pending.length === 0) {
      return NextResponse.json({ ok: false, error: "没有待确认的日历草稿" }, { status: 400 });
    }

    await prisma.calendarDraft.updateMany({
      where: { goalId: id, status: { in: ["pending_confirmation", "confirmed"] } },
      data: { status: "confirmed" },
    });

    // 只把「确认且从未成功执行过」的草稿发给执行器（DB 幂等门）
    const existingKeys = new Set(goal.calWrites.filter((w) => w.status === "success").map((w) => idempotencyKeyOf(w.idempotencyKey)));
    const policy = await getPlanningPolicy();
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
          startUtc: d.proposedStart.toISOString(), // Instant（UTC Z）
          endUtc: d.proposedEnd.toISOString(),
          timezone: d.timezone ?? policy.timezone,
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
    let writeProvider = "ics";

    if (toExecute.length > 0) {
      const executed = await executeCalendarDrafts({
        goalId: id,
        planVersion: goal.revision,
        timezone: policy.timezone,
        drafts: toExecute,
        tasks: [...new Set(toExecute.map((d) => d.taskId))].map((tid) => ({
          taskId: tid,
          estMinutes: estByTask.get(tid) ?? 60,
        })),
      }, runId);
      results = results.concat(executed.results);
      writeProvider = executed.provider; // 真实写目标（google|ics），不再硬编码
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
          provider: writeProvider,
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
    traceEvent("cal_confirm", {
      runId,
      goalId, ok: true, planVersion: goal.revision, summary,
      errors: results.filter((r) => r.error).map((r) => (r.error ?? "").split(":", 1)[0]),
      latencyMs: Date.now() - t0,
    });
    return NextResponse.json({ ok: true, data: { results, summary, drafts } });
  } catch (e) {
    traceEvent("cal_confirm", { runId, goalId, ok: false, error: e instanceof Error ? e.message : "confirm failed", latencyMs: Date.now() - t0 });
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
