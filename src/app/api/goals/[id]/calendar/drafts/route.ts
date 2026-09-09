import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildCalendarDrafts } from "@/lib/agent/calendar";
import { DEFAULT_USER_TZ } from "@/lib/time";

/** POST /api/goals/:id/calendar/drafts —— 生成日历草稿（pending_confirmation，永不写日历） */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const goal = await prisma.goal.findUnique({
      where: { id },
      include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
    });
    if (!goal) return NextResponse.json({ ok: false, error: "目标不存在" }, { status: 404 });

    const openTasks = goal.tasks.filter((t) => t.status !== "done");
    if (openTasks.length === 0) {
      return NextResponse.json({ ok: false, error: "没有未完成任务，无需排期" }, { status: 400 });
    }
    // 重新生成 = 旧提案作废：未触达日历的草稿（待确认/已确认未执行）直接删除，
    // 释放 idempotencyKey（unique）供重试使用；已执行/冲突等终态保留为历史。
    await prisma.calendarDraft.deleteMany({
      where: { goalId: id, status: { in: ["pending_confirmation", "confirmed"] } },
    });
    // 已成功写入本版本的任务不再重复排期（幂等：其 idempotencyKey 已占用且事件已在日历）
    const executedTaskIds = new Set(
      (await prisma.calendarWrite.findMany({
        where: { goalId: id, planVersion: goal.revision, status: { in: ["success", "duplicate_skipped"] } },
        select: { taskId: true },
      })).map((w) => w.taskId),
    );
    const draftable = openTasks.filter((t) => !executedTaskIds.has(t.id));
    if (draftable.length === 0) {
      const drafts = await prisma.calendarDraft.findMany({
        where: { goalId: id, planVersion: goal.revision, status: "pending_confirmation" },
        orderBy: { proposedStart: "asc" },
      });
      return NextResponse.json({ ok: true, data: { drafts, unplacedTaskIds: [] } });
    }

    const daysLeft = goal.deadline
      ? Math.max(1, Math.ceil((goal.deadline.getTime() - Date.now()) / 86400000))
      : 14;

    const built = await buildCalendarDrafts({
      goalId: id,
      planVersion: goal.revision,
      daysLeft,
      timezone: DEFAULT_USER_TZ,
      tasks: draftable.map((t) => ({
        taskId: t.id,
        title: t.title,
        estMinutes: t.estMinutes,
        priority: t.priority,
        status: t.status,
        durationDays: t.durationDays,
      })),
    });

    if (built.drafts.length > 0) {
      await prisma.calendarDraft.createMany({
        data: built.drafts.map((d) => ({
          goalId: id,
          planVersion: goal.revision,
          taskId: d.taskId,
          taskTitle: d.taskTitle,
          proposedStart: new Date(d.startUtc), // Instant 存储（Prisma DateTime = UTC ms）
          proposedEnd: new Date(d.endUtc),
          timezone: d.timezone, // 时区语义显式持久化（存量迁移见 scripts/migrate-tz.mjs）
          calendarId: d.calendarId,
          actionType: d.actionType,
          reason: d.reason ?? null,
          status: "pending_confirmation",
          idempotencyKey: d.idempotencyKey,
        })),
      });
    }

    const drafts = await prisma.calendarDraft.findMany({
      where: { goalId: id, planVersion: goal.revision, status: "pending_confirmation" },
      orderBy: { proposedStart: "asc" },
    });
    return NextResponse.json({ ok: true, data: { drafts, unplacedTaskIds: built.unplacedTaskIds } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "生成日历草稿失败" },
      { status: 502 },
    );
  }
}

/** GET /api/goals/:id/calendar/drafts —— 查看当前草稿与写入记录 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const drafts = await prisma.calendarDraft.findMany({
    where: { goalId: id },
    orderBy: [{ createdAt: "desc" }, { proposedStart: "asc" }],
    take: 50,
  });
  const writes = await prisma.calendarWrite.findMany({ where: { goalId: id } });
  return NextResponse.json({ ok: true, data: { drafts, writes } });
}
