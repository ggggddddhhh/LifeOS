import { NextRequest, NextResponse } from "next/server";
import { traceEvent } from "@/lib/trace";
import { undoLastReplan } from "@/lib/replan";

/** POST /api/goals/:id/replan/undo —— 撤销最近一次重排（恢复应用前快照，revision 继续前进留痕）。 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const runId = crypto.randomUUID().slice(0, 8);
  const { id } = await ctx.params;
  try {
    const result = await undoLastReplan(id, runId);
    if ("error" in result) {
      traceEvent("replan_undo", { runId, goalId: id, ok: false, error: result.error });
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, data: { goal: result.goal } });
  } catch (e) {
    traceEvent("replan_undo", { runId, goalId: id, ok: false, error: e instanceof Error ? e.message : "undo failed" });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "撤销失败" },
      { status: 500 },
    );
  }
}
