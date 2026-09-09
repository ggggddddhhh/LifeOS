import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { planGoal } from "@/lib/llm";

export async function GET() {
  const goals = await prisma.goal.findMany({
    where: { status: "active" },
    include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ ok: true, data: goals });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      title?: string;
      description?: string;
      deadline?: string;
    };
    const title = body.title?.trim();
    if (!title) {
      return NextResponse.json({ ok: false, error: "title 必填" }, { status: 400 });
    }
    const deadline = body.deadline ? new Date(body.deadline) : undefined;
    if (deadline && isNaN(deadline.getTime())) {
      return NextResponse.json({ ok: false, error: "deadline 格式无效" }, { status: 400 });
    }

    const planned = await planGoal({
      title,
      description: body.description?.trim() || undefined,
      deadline: deadline?.toISOString(),
    });

    const goal = await prisma.$transaction(async (tx) => {
      const goal = await tx.goal.create({
        data: {
          title,
          description: body.description?.trim() || undefined,
          deadline: deadline ?? undefined,
        },
      });
      await tx.task.createMany({
        data: planned.map((t, i) => ({
          goalId: goal.id,
          title: t.title,
          notes: t.notes,
          priority: t.priority,
          estMinutes: t.estMinutes,
          order: i,
        })),
      });
      return tx.goal.findUnique({ where: { id: goal.id }, include: { tasks: true } });
    });

    return NextResponse.json({ ok: true, data: goal }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "创建目标失败" },
      { status: 500 },
    );
  }
}
