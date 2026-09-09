"use client";

import { ArrowDown, ArrowUp, Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanDiff } from "@/lib/types";

/** 结构化 Plan Diff：added/removed/changed 三组，changed 含估时与日期变化。 */
export function PlanDiffView({ diff }: { diff: PlanDiff }) {
  const estDelta = diff.summary.estDelta;
  return (
    <div className="space-y-2 text-xs">
      <p className="tabular text-muted-foreground">
        新增 {diff.summary.added} · 删除 {diff.summary.removed} · 保留 {diff.summary.kept} · 估时{" "}
        <span className={cn(estDelta > 0 ? "text-warning" : estDelta < 0 ? "text-success" : "")}>
          {estDelta >= 0 ? "+" : ""}
          {estDelta}m
        </span>
      </p>
      <div className="space-y-1">
        {diff.added.map((a) => (
          <p key={`a-${a.title}`} className="flex items-start gap-1.5 text-foreground">
            <Plus className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
            <span className="leading-snug">
              {a.title}
              <span className="ml-1.5 tabular text-muted-foreground">{a.estMinutes}m</span>
            </span>
          </p>
        ))}
        {diff.removed.map((r) => (
          <p key={`r-${r.title}`} className="flex items-start gap-1.5 text-muted-foreground">
            <Minus className="mt-0.5 size-3 shrink-0 text-danger" aria-hidden />
            <span className="leading-snug line-through">{r.title}</span>
          </p>
        ))}
        {diff.changed.map((c) => (
          <p key={`c-${c.title}`} className="flex items-start gap-1.5 text-muted-foreground">
            {c.estMinutesTo !== undefined && c.estMinutesFrom !== undefined && c.estMinutesTo < c.estMinutesFrom ? (
              <ArrowDown className="mt-0.5 size-3 shrink-0 text-success" aria-hidden />
            ) : (
              <ArrowUp className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
            )}
            <span className="leading-snug text-foreground">{c.title}</span>
            {c.estMinutesFrom !== undefined && c.estMinutesTo !== undefined && c.estMinutesFrom !== c.estMinutesTo && (
              <span className="tabular">
                {c.estMinutesFrom}m→{c.estMinutesTo}m
              </span>
            )}
            {c.moved && c.moved !== "不变" && <span>{c.moved}</span>}
          </p>
        ))}
      </div>
    </div>
  );
}
