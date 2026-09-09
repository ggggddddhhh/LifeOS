import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { traceEvent } from "@/lib/trace";

/**
 * POST /api/goals/:id/calendar/cancel —— 取消待确认草稿（零写操作）。
 * body 可选 { draftIds?: string[] }：只取消指定草稿；缺省取消全部待确认。
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { draftIds?: unknown };
  const ids = Array.isArray(body.draftIds)
    ? body.draftIds.filter((v): v is string => typeof v === "string")
    : null;

  const where =
    ids && ids.length > 0
      ? { goalId: id, status: "pending_confirmation", id: { in: ids } }
      : { goalId: id, status: "pending_confirmation" };
  const updated = await prisma.calendarDraft.updateMany({
    where,
    data: { status: "cancelled" },
  });
  traceEvent("cal_cancel", { goalId: id, cancelled: updated.count, scoped: !!(ids && ids.length > 0) });
  return NextResponse.json({ ok: true, data: { cancelled: updated.count } });
}
