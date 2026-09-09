import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { snapshotOpenTasks } from "@/lib/replan";
import { getPlanningPolicy } from "@/lib/policy";
import { traceEvent } from "@/lib/trace";

/**
 * POST /api/goals/:id/tasks —— 手动新增任务（origin=user：重新规划不得删改）。
 * 校验与手动编辑同一套语义：标题非空且不重复、估时 5–1440m、dueDate ∈ [today, deadline]。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    title?: unknown;
    notes?: unknown;
    priority?: unknown;
    estMinutes?: unknown;
    dueDate?: unknown;
  };

  const goal = await prisma.goal.findUnique({ where: { id } });
  if (!goal) return NextResponse.json({ ok: false, error: "目标不存在" }, { status: 404 });

  // Phase 12：默认时长/优先级来自策略（用户配置优先于系统默认）
  const policy = await getPlanningPolicy();

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length === 0) return NextResponse.json({ ok: false, error: "任务标题不能为空" }, { status: 400 });
  if (title.length > 120) return NextResponse.json({ ok: false, error: "任务标题过长（≤120 字）" }, { status: 400 });

  const estMinutes = body.estMinutes === undefined ? policy.defaultEstMinutes : Number(body.estMinutes);
  if (!Number.isInteger(estMinutes) || estMinutes < 5 || estMinutes > 1440) {
    return NextResponse.json({ ok: false, error: "预计时长需在 5–1440 分钟之间" }, { status: 400 });
  }
  const priority = body.priority === undefined ? policy.defaultPriority : Number(body.priority);
  if (![1, 2, 3].includes(priority)) {
    return NextResponse.json({ ok: false, error: "优先级必须是 1（高）/2（中）/3（低）" }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);
  let dueDate: Date | null = null;
  if (body.dueDate !== undefined && body.dueDate !== null && body.dueDate !== "") {
    const due = String(body.dueDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || isNaN(new Date(`${due}T00:00:00Z`).getTime())) {
      return NextResponse.json({ ok: false, error: "截止日期格式无效（应为 YYYY-MM-DD）" }, { status: 400 });
    }
    if (due < today) return NextResponse.json({ ok: false, error: `截止日期不能早于今天（${today}）` }, { status: 400 });
    if (goal.deadline) {
      const deadline = goal.deadline.toISOString().slice(0, 10);
      if (due > deadline) return NextResponse.json({ ok: false, error: `截止日期不能晚于目标截止日（${deadline}）` }, { status: 400 });
    }
    dueDate = new Date(`${due}T00:00:00Z`);
  }

  const siblings = await prisma.task.findMany({
    where: { goalId: id },
    include: { dependsOn: { select: { id: true, title: true } } },
  });
  if (siblings.some((s) => s.title.trim() === title)) {
    return NextResponse.json({ ok: false, error: `同名任务已存在：「${title}」` }, { status: 400 });
  }

  const created = await prisma.$transaction(async (tx) => {
    const order = siblings.reduce((m, s) => Math.max(m, s.order), -1) + 1;
    const task = await tx.task.create({
      data: {
        goalId: id,
        title,
        notes: typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : undefined,
        priority,
        estMinutes,
        order,
        origin: "user",
        ...(dueDate ? { dueDate } : {}),
      },
      include: { dependsOn: { select: { id: true, title: true } } },
    });
    const goalUpdated = await tx.goal.update({ where: { id }, data: { revision: { increment: 1 } } });
    await tx.planVersion.create({
      data: {
        goalId: id,
        revision: goalUpdated.revision,
        reason: `手动新增任务「${title.slice(0, 40)}」`,
        diffJson: JSON.stringify({
          added: [{ title, estMinutes }],
          removed: [],
          changed: [],
          summary: {
            added: 1, removed: 0,
            kept: siblings.filter((s) => s.status !== "done").length,
            estDelta: estMinutes,
          },
        }),
        snapshotJson: JSON.stringify(snapshotOpenTasks(siblings)),
      },
    });
    return task;
  });

  traceEvent("task_create", { goalId: id, taskId: created.id, ok: true });
  return NextResponse.json({ ok: true, data: created }, { status: 201 });
}
