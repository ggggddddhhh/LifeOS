import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** POST /api/goals/:id/calendar/cancel —— 取消全部待确认草稿（零写操作） */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const updated = await prisma.calendarDraft.updateMany({
    where: { goalId: id, status: "pending_confirmation" },
    data: { status: "cancelled" },
  });
  return NextResponse.json({ ok: true, data: { cancelled: updated.count } });
}
