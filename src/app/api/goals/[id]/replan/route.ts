import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { replanGoal } from "@/lib/llm";
import type { TaskSnapshot } from "@/lib/types";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const goal = await prisma.goal.findUnique({
      where: { id },
      include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
    });
    if (!goal) return NextResponse.json({ ok: false, error: "目标不存在" }, { status: 404 });

    // 没有未完成任务时直接短路，避免 LLM 凭空发明新任务（Phase 1.5 评测发现）
    const openTasks = goal.tasks.filter((t) => t.status !== "done");
    if (openTasks.length === 0) {
      return NextResponse.json({ ok: false, error: "所有任务已完成，无需重新计划" }, { status: 400 });
    }

    const daysLeft = goal.deadline
      ? Math.max(1, Math.ceil((goal.deadline.getTime() - Date.now()) / 86400000))
      : 14;

    const snapshots: TaskSnapshot[] = goal.tasks.map((t) => ({
      title: t.title,
      status: t.status as TaskSnapshot["status"],
      estMinutes: t.estMinutes,
      priority: t.priority,
    }));

    const result = await replanGoal({
      goalTitle: goal.title,
      goalDescription: goal.description ?? undefined,
      deadline: goal.deadline?.toISOString(),
      daysLeft,
      tasks: snapshots,
    });

    const updated = await prisma.$transaction(async (tx) => {
      // 保留已完成任务，重写未完成任务
      await tx.task.deleteMany({ where: { goalId: goal.id, status: { not: "done" } } });
      const remaining = await tx.task.findMany({
        where: { goalId: goal.id },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      });
      const baseOrder = remaining.length;
      await tx.task.createMany({
        data: result.tasks.map((t, i) => ({
          goalId: goal.id,
          title: t.title,
          notes: t.notes,
          priority: t.priority,
          estMinutes: t.estMinutes,
          order: baseOrder + i,
        })),
      });
      return tx.goal.update({
        where: { id: goal.id },
        data: { revision: { increment: 1 } },
        include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
      });
    });

    return NextResponse.json({ ok: true, data: { reason: result.reason, goal: updated } });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Replan 失败" },
      { status: 500 },
    );
  }
}
