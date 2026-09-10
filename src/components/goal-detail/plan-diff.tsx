"use client";

import { ShiftChanges } from "./shift-preview";
import type { PlanDiff } from "@/lib/types";

/** 结构化 Plan Diff（计划历史 / Activity 复用）：ShiftChanges 的 Before→After 行 + 摘要行。 */
export function PlanDiffView({ diff }: { diff: PlanDiff }) {
  const estDelta = diff.summary.estDelta;
  return (
    <div className="space-y-2 text-xs">
      <p className="tabular text-muted-foreground">
        新增 {diff.summary.added} · 删除 {diff.summary.removed} · 保留 {diff.summary.kept} · 估时{" "}
        <span className={estDelta > 0 ? "text-warning" : estDelta < 0 ? "text-success" : ""}>
          {estDelta >= 0 ? "+" : ""}
          {estDelta}m
        </span>
      </p>
      <ShiftChanges diff={diff} />
    </div>
  );
}
