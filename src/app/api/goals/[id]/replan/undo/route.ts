import { NextRequest, NextResponse } from "next/server";
import { traceEvent } from "@/lib/trace";
import { undoLastReplan } from "@/lib/replan";
import { toStableConflictError } from "@/lib/conflict";

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
    const stable = toStableConflictError(e);
    if (stable) {
      return NextResponse.json({ ok: false, error: stable.message }, { status: stable.status });
    }
    return NextResponse.json(
      { ok: false, error: "撤销失败，请稍后重试" },
      { status: 500 },
    );
  }
}
