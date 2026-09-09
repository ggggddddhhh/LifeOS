import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isTaskStatus } from "@/lib/types";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { status?: unknown };
  if (!isTaskStatus(body.status)) {
    return NextResponse.json({ ok: false, error: "status 必须是 todo|in_progress|done" }, { status: 400 });
  }
  const task = await prisma.task
    .update({ where: { id }, data: { status: body.status } })
    .catch(() => null);
  if (!task) return NextResponse.json({ ok: false, error: "任务不存在" }, { status: 404 });
  return NextResponse.json({ ok: true, data: task });
}
