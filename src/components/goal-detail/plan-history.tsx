"use client";

import { useState } from "react";
import { ChevronRight, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/shared/states";
import { PlanDiffView } from "./plan-diff";
import { parseDiff, type PlanVersionView } from "@/lib/ui-data";

/** 计划版本时间线：vN + reason + 可展开结构化 diff（数据源 GET /api/goals.planVersions）。 */
export function PlanHistory({ versions }: { versions: PlanVersionView[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!versions || versions.length === 0) {
    return <EmptyState icon={History} title="暂无计划历史" hint="每次 Replan 都会在这里留档（reason + diff）" />;
  }
  return (
    <ol className="space-y-0">
      {versions.map((v, i) => {
        const diff = parseDiff(v.diffJson);
        const expanded = open === v.id;
        return (
          <li key={v.id} className="relative">
            {i < versions.length - 1 && <span className="absolute left-[5px] top-4 h-full w-px bg-border" aria-hidden />}
            <div className="pb-4 pl-5">
              <span
                className={cn(
                  "absolute left-0 top-1.5 size-[11px] rounded-full border-2",
                  i === 0 ? "border-primary bg-primary" : "border-border bg-background",
                )}
                aria-hidden
              />
              <button
                onClick={() => setOpen(expanded ? null : v.id)}
                aria-expanded={expanded}
                className="flex w-full items-start gap-2 text-left"
              >
                <span className="tabular mt-px text-xs font-semibold text-foreground">v{v.revision}</span>
                <span className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{v.reason}</span>
                <span className="mt-0.5 flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/70">
                  <time className="tabular">{new Date(v.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</time>
                  <ChevronRight className={cn("size-3 transition-transform duration-150", expanded && "rotate-90")} aria-hidden />
                </span>
              </button>
              {expanded && diff && (
                <div className="animate-fade mt-2 rounded-lg border bg-muted/30 px-3 py-2.5">
                  <PlanDiffView diff={diff} />
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
