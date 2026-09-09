import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isTaskStatus } from "@/lib/types";
import { checkTaskEdit, describeEdit, TASK_ORIGIN, type TaskEditPatch } from "@/lib/task-edit";
import { snapshotOpenTasks } from "@/lib/replan";
import { getPlanningPolicy } from "@/lib/policy";
import { traceEvent } from "@/lib/trace";

/**
 * PATCH /api/tasks/:id —— 两类语义：
 * 1) 仅 status（看板勾选/今日列表）：快速路径，无版本化（高频、可逆）。
 * 2) 字段编辑（title/notes/priority/estMinutes/dueDate/dependsOnIds）：
 *    ?dryRun=1 → 校验 + 变更预览 + 容量警告 + 日历提示，不落库（Preview）；
 *    正式请求 → 守卫复验 + 乐观锁（expectedUpdatedAt）→ 落库 + 记 PlanVersion（可撤销）。
 *    已写入日历的任务：只返回 calendarHint，绝不自动改动日历事件。
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const body = (await req.json().catch(() => ({}))) as {
    status?: unknown;
    expectedUpdatedAt?: unknown;
  } & Partial<Record<keyof TaskEditPatch, unknown>>;

  // ---- 快速路径：仅改状态（保持 Phase 1 起的既有行为）----
  const keys = Object.keys(body).filter((k) => k !== "expectedUpdatedAt");
  const statusOnly = keys.length === 1 && keys[0] === "status";
  if (statusOnly) {
    if (!isTaskStatus(body.status)) {
      return NextResponse.json({ ok: false, error: "status 必须是 todo|in_progress|done" }, { status: 400 });
    }
    const task = await prisma.task
      .update({ where: { id }, data: { status: body.status } })
      .catch(() => null);
    if (!task) return NextResponse.json({ ok: false, error: "任务不存在" }, { status: 404 });
    return NextResponse.json({ ok: true, data: task });
  }

  // ---- 字段编辑路径 ----
  const task = await prisma.task.findUnique({
    where: { id },
    include: { dependsOn: { select: { id: true, title: true } }, goal: true },
  });
  if (!task) return NextResponse.json({ ok: false, error: "任务不存在" }, { status: 404 });

  const siblings = await prisma.task.findMany({
    where: { goalId: task.goalId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    include: { dependsOn: { select: { id: true, title: true } } },
  });

  // ---- 乐观锁（Vikunja v2 防静默覆盖的服务端化）：编辑期间任务被别人/别的页改过 → 409 ----
  if (!dryRun && typeof body.expectedUpdatedAt === "string") {
    if (new Date(body.expectedUpdatedAt).getTime() !== task.updatedAt.getTime()) {
      return NextResponse.json(
        { ok: false, error: "任务刚被修改过（可能在其他页面），请刷新后重试" },
        { status: 409 },
      );
    }
  }

  const patch: TaskEditPatch = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string") return NextResponse.json({ ok: false, error: "title 必须是字符串" }, { status: 400 });
    patch.title = body.title;
  }
  if (body.notes !== undefined) patch.notes = body.notes === null ? null : String(body.notes);
  if (body.priority !== undefined) patch.priority = Number(body.priority);
  if (body.estMinutes !== undefined) patch.estMinutes = Number(body.estMinutes);
  if (body.dueDate !== undefined) {
    if (body.dueDate !== null && typeof body.dueDate !== "string") {
      return NextResponse.json({ ok: false, error: "dueDate 必须是 YYYY-MM-DD 或 null" }, { status: 400 });
    }
    patch.dueDate = body.dueDate as string | null;
  }
  if (body.dependsOnIds !== undefined) {
    if (!Array.isArray(body.dependsOnIds) || body.dependsOnIds.some((v) => typeof v !== "string")) {
      return NextResponse.json({ ok: false, error: "dependsOnIds 必须是任务 id 数组" }, { status: 400 });
    }
    patch.dependsOnIds = body.dependsOnIds as string[];
  }

  // 守卫复验（dryRun 与正式请求同一套：schedule 硬拒 / cycle 硬拒 / 容量软警告）
  const policy = await getPlanningPolicy();
  const check = checkTaskEdit({ task, goal: task.goal, siblings, patch, policy });
  if (!check.ok) return NextResponse.json({ ok: false, error: check.error }, { status: 400 });

  // 已写入日历的任务（success/duplicate_skipped 均表示日历上存在）→ 只提示
  const written = await prisma.calendarWrite.findFirst({
    where: { taskId: id, status: { in: ["success", "duplicate_skipped"] } },
    select: { id: true },
  });
  const calendarHint = !!written;

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      data: { dryRun: true, changes: check.changes, warnings: check.warnings, calendarHint },
    });
  }
  if (check.changes.length === 0) {
    return NextResponse.json({ ok: false, error: "没有检测到字段变化" }, { status: 400 });
  }

  const reason = describeEdit(check.changes, task.title);
  const updated = await prisma.$transaction(async (tx) => {
    const t = await tx.task.update({
      where: { id },
      data: {
        ...(patch.title !== undefined ? { title: patch.title!.trim() } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes ?? null } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority! } : {}),
        ...(patch.estMinutes !== undefined ? { estMinutes: patch.estMinutes! } : {}),
        ...(patch.dueDate !== undefined
          ? { dueDate: patch.dueDate ? new Date(`${patch.dueDate}T00:00:00Z`) : null }
          : {}),
        origin: TASK_ORIGIN.USER, // 用户手动改过 → 重新规划不得改写（Phase 11 用户优先）
      },
      include: { dependsOn: { select: { id: true, title: true } } },
    });
    if (patch.dependsOnIds !== undefined) {
      await tx.task.update({
        where: { id },
        data: { dependsOn: { set: patch.dependsOnIds!.map((tid) => ({ id: tid })) } },
      });
    }
    const goalUpdated = await tx.goal.update({
      where: { id: task.goalId },
      data: { revision: { increment: 1 } },
    });
    await tx.planVersion.create({
      data: {
        goalId: task.goalId,
        revision: goalUpdated.revision,
        reason,
        diffJson: JSON.stringify(check.newDiff),
        snapshotJson: JSON.stringify(snapshotOpenTasks(siblings)),
      },
    });
    return tx.task.findUnique({
      where: { id },
      include: { dependsOn: { select: { id: true, title: true } } },
    });
  });

  traceEvent("task_edit", {
    goalId: task.goalId,
    taskId: id,
    ok: true,
    fields: check.changes.map((c) => c.field),
    calendarHint,
  });
  return NextResponse.json({ ok: true, data: { task: updated, calendarHint } });
}

/** DELETE /api/tasks/:id —— 手动删除任务（版本化留痕；pending 草稿随之作废；日历事件不动）。 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = await prisma.task.findUnique({ where: { id }, include: { goal: true } });
  if (!task) return NextResponse.json({ ok: false, error: "任务不存在" }, { status: 404 });

  const written = await prisma.calendarWrite.findFirst({
    where: { taskId: id, status: { in: ["success", "duplicate_skipped"] } },
    select: { id: true },
  });

  const siblings = await prisma.task.findMany({
    where: { goalId: task.goalId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    include: { dependsOn: { select: { id: true, title: true } } },
  });

  const deleted = await prisma.$transaction(async (tx) => {
    // 该任务的待确认草稿作废（避免确认时引用已删任务）；已执行/历史记录保留
    await tx.calendarDraft.updateMany({
      where: { taskId: id, status: { in: ["pending_confirmation", "confirmed"] } },
      data: { status: "cancelled" },
    });
    await tx.task.delete({ where: { id } });
    const goalUpdated = await tx.goal.update({
      where: { id: task.goalId },
      data: { revision: { increment: 1 } },
    });
    await tx.planVersion.create({
      data: {
        goalId: task.goalId,
        revision: goalUpdated.revision,
        reason: `手动删除任务「${task.title.slice(0, 40)}」`,
        diffJson: JSON.stringify({
          added: [], removed: [{ title: task.title, estMinutes: task.estMinutes }], changed: [],
          summary: { added: 0, removed: 1, kept: siblings.filter((s) => s.status !== "done" && s.id !== id).length, estDelta: -task.estMinutes },
        }),
        snapshotJson: JSON.stringify(snapshotOpenTasks(siblings)),
      },
    });
    return true;
  });

  traceEvent("task_delete", { goalId: task.goalId, taskId: id, ok: true, calendarHint: !!written });
  void deleted;
  return NextResponse.json({ ok: true, data: { calendarHint: !!written } });
}
