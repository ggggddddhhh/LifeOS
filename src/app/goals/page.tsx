"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Search, Target } from "lucide-react";
import { GoalCreateDialog } from "@/components/goals/goal-create-dialog";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { daysLeftOf, useGoals } from "@/lib/ui-data";
import { cn } from "@/lib/utils";

type Filter = "all" | "active" | "done";

/** Goals：搜索 + 状态筛选 + 紧凑行式列表（进度细线 + 剩余天数），点击进 Detail。 */
export default function GoalsPage() {
  const { goals, loading, error, refresh } = useGoals();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return goals.filter((g) => {
      const done = g.tasks.filter((t) => t.status === "done").length;
      const active = done < g.tasks.length;
      if (filter === "active" && !active) return false;
      if (filter === "done" && active) return false;
      if (q && !g.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [goals, query, filter]);

  const activeCount = goals.filter((g) => g.tasks.some((t) => t.status !== "done")).length;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Goals</h1>
        <GoalCreateDialog onCreated={() => refresh()} />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索目标…"
            aria-label="搜索目标"
            className="h-8 w-full rounded-md border bg-background pl-8 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex gap-1" role="tablist" aria-label="目标状态筛选">
          {([
            { key: "all", label: `全部 ${goals.length}` },
            { key: "active", label: `进行中 ${activeCount}` },
            { key: "done", label: `已完成 ${goals.length - activeCount}` },
          ] as const).map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors duration-150",
                filter === f.key ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorState message={error} onRetry={refresh} />}
      {loading ? (
        <ListSkeleton rows={5} />
      ) : goals.length === 0 ? (
        <EmptyState icon={Target} title="还没有目标" hint="点击「新目标」，让 AI 帮你拆解成可执行的计划。" />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Search} title="没有匹配的目标" hint="换个关键词，或切换上面的状态筛选。" />
      ) : (
        <ul className="divide-y rounded-lg border">
          {filtered.map((g) => {
            const done = g.tasks.filter((t) => t.status === "done").length;
            const total = g.tasks.length;
            const pct = total > 0 ? (done / total) * 100 : 0;
            const daysLeft = daysLeftOf(g.deadline);
            const urgent = daysLeft !== null && daysLeft <= 2 && done < total;
            const active = done < total;
            return (
              <li key={g.id}>
                <Link
                  href={`/goals/${g.id}`}
                  className="group flex items-center gap-4 px-4 py-3 transition-colors duration-150 hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <span
                    aria-hidden
                    className={cn("size-1.5 shrink-0 rounded-full", active ? "bg-info" : "bg-success")}
                  />
                  <div className="min-w-0 flex-1">
                    <p className={cn("truncate text-[13px] font-medium", !active && "text-muted-foreground")}>{g.title}</p>
                    <div className="mt-1.5 flex items-center gap-3">
                      <div className="h-0.5 w-28 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="tabular text-[11px] text-muted-foreground">
                        {done}/{total}
                      </span>
                    </div>
                  </div>
                  {daysLeft !== null && (
                    <span className={cn("tabular shrink-0 text-[11px]", urgent ? "font-medium text-danger" : "text-muted-foreground")}>
                      剩 {daysLeft} 天
                    </span>
                  )}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
