"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, History } from "lucide-react";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { PlanDiffView } from "@/components/goal-detail/plan-diff";
import { parseDiff, useGoals } from "@/lib/ui-data";
import { cn } from "@/lib/utils";
import type { PlanDiff } from "@/lib/types";

interface Item {
  id: string;
  goalId: string;
  goalTitle: string;
  revision: number;
  reason: string;
  diff: PlanDiff | null;
  createdAt: string;
}

/** Activity：跨目标的计划版本时间线（reason + 可展开 diff）。 */
export default function ActivityPage() {
  const { goals, loading, error, refresh } = useGoals();
  const [open, setOpen] = useState<string | null>(null);

  const items = useMemo<Item[]>(
    () =>
      goals
        .flatMap((g) => (g.versions ?? []).map((v) => ({
          id: v.id,
          goalId: g.id,
          goalTitle: g.title,
          revision: v.revision,
          reason: v.reason,
          diff: parseDiff(v.diffJson),
          createdAt: v.createdAt,
        })))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 50),
    [goals],
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-xs text-muted-foreground">计划版本与调整原因的时间线——AI 每次动了什么、为什么，全在这里。</p>
      </header>

      {error && <ErrorState message={error} onRetry={refresh} />}
      {loading ? (
        <ListSkeleton rows={5} />
      ) : items.length === 0 ? (
        <EmptyState icon={History} title="暂无活动" hint="创建目标或重新规划后，这里会记录每次计划调整。" />
      ) : (
        <ol className="space-y-0">
          {items.map((it, i) => {
            const expanded = open === it.id;
            return (
              <li key={it.id} className="relative">
                {i < items.length - 1 && <span className="absolute left-[5px] top-4 h-full w-px bg-border" aria-hidden />}
                <div className="pb-5 pl-5">
                  <span
                    className={cn("absolute left-0 top-1.5 size-[11px] rounded-full border-2", i === 0 ? "border-primary bg-primary" : "border-border bg-background")}
                    aria-hidden
                  />
                  <div className="flex items-baseline gap-2 text-[11px] text-muted-foreground/80">
                    <time className="tabular">{new Date(it.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                    <Link href={`/goals/${it.goalId}`} className="truncate hover:text-foreground hover:underline">
                      {it.goalTitle}
                    </Link>
                    <span className="tabular shrink-0">第 {it.revision} 版</span>
                  </div>
                  <button onClick={() => setOpen(expanded ? null : it.id)} aria-expanded={expanded} className="group mt-0.5 flex w-full items-start gap-1.5 text-left">
                    <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{it.reason}</p>
                    <ChevronRight className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground/50 transition-transform duration-150 group-hover:text-muted-foreground", expanded && "rotate-90")} aria-hidden />
                  </button>
                  {expanded && it.diff && (
                    <div className="animate-fade mt-2 rounded-lg border bg-muted/30 px-3 py-2.5">
                      <PlanDiffView diff={it.diff} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
