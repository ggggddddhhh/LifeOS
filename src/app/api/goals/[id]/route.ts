import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const goal = await prisma.goal.findUnique({
    where: { id },
    include: { tasks: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] } },
  });
  if (!goal) return NextResponse.json({ ok: false, error: "目标不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, data: goal });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const goal = await prisma.goal.delete({ where: { id } }).catch(() => null);
  if (!goal) return NextResponse.json({ ok: false, error: "目标不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, data: null });
}
