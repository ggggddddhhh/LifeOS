"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useGoals } from "@/lib/ui-data";
import { cn } from "@/lib/utils";

const DAY_MS = 86400000;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

interface CalTask {
  id: string;
  goalId: string;
  title: string;
  status: string;
  estMinutes: number;
  durationDays?: number | null;
  startMs: number | null;
  dueMs: number | null;
}

/** 全局月历：任务排期 + 日负载微条；周期任务横跨；未排期折叠区。 */
export default function CalendarPage() {
  const { goals, loading, error, refresh } = useGoals();
  const [monthOffset, setMonthOffset] = useState(0);
  const [showUnscheduled, setShowUnscheduled] = useState(false);

  const tasks = useMemo<CalTask[]>(
    () =>
      goals.flatMap((g) =>
        g.tasks.map((t) => ({
          id: t.id,
          goalId: g.id,
          title: t.title,
          status: t.status,
          estMinutes: t.estMinutes,
          durationDays: t.durationDays,
          startMs: t.startDate ? startOfDay(new Date(t.startDate)) : null,
          dueMs: t.dueDate ? startOfDay(new Date(t.dueDate)) : null,
        })),
      ),
    [goals],
  );

  const base = new Date();
  const view = new Date(base.getFullYear(), base.getMonth() + monthOffset, 1);
  const monthStart = startOfDay(view);
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const leading = (new Date(monthStart).getDay() + 6) % 7;
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => monthStart + i * DAY_MS),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const todayMs = startOfDay(new Date());
  const unscheduled = tasks.filter((t) => t.dueMs === null && t.status !== "done");
  const monthLabel = view.toLocaleDateString("zh-CN", { year: "numeric", month: "long" });

  function tasksOnDay(ms: number): CalTask[] {
    return tasks.filter((t) => {
      if (t.dueMs === null) return false;
      if (t.durationDays && t.durationDays >= 1 && t.startMs !== null) return ms >= t.startMs && ms <= t.dueMs;
      return t.dueMs === ms;
    });
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">{monthLabel}</h1>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setMonthOffset((v) => v - 1)} aria-label="上个月">
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMonthOffset(0)}>
            今天
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMonthOffset((v) => v + 1)} aria-label="下个月">
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </header>

      {error && <ErrorState message={error} onRetry={refresh} />}
      {loading ? (
        <ListSkeleton rows={6} />
      ) : goals.length === 0 ? (
        <EmptyState icon={CalendarDays} title="还没有排期" hint="创建目标后，任务计划会出现在这里。" />
      ) : (
        <>
          <div className="grid grid-cols-7 border-l border-t text-center text-[11px] font-medium text-muted-foreground">
            {WEEKDAYS.map((w) => (
              <div key={w} className="border-b border-r py-1.5">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 border-l border-t">
            {cells.map((ms, i) => {
              if (ms === null) return <div key={i} className="min-h-20 border-b border-r bg-muted/20 md:min-h-24" />;
              const dayTasks = tasksOnDay(ms);
              const load = dayTasks.filter((t) => t.status !== "done").reduce((s, t) => s + t.estMinutes, 0);
              const loadPct = Math.min(100, (load / 480) * 100);
              const over = load > 480;
              return (
                <div key={i} className={cn("min-h-20 border-b border-r p-1.5 md:min-h-24", ms === todayMs && "bg-accent/40")}>
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        "tabular inline-flex size-5 items-center justify-center rounded-full text-[11px]",
                        ms === todayMs ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground",
                      )}
                    >
                      {new Date(ms).getDate()}
                    </span>
                    {load > 0 && (
                      <span className={cn("tabular text-[10px]", over ? "font-semibold text-danger" : "text-muted-foreground")}>
                        {Math.round(load / 60)}h
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 space-y-0.5">
                    {dayTasks.slice(0, 2).map((t) => (
                      <Link
                        key={t.id}
                        href={`/goals/${t.goalId}`}
                        title={t.title}
                        className={cn(
                          "block truncate rounded px-1 py-0.5 text-[10px] leading-tight transition-colors duration-150 hover:bg-muted",
                          t.status === "done"
                            ? "text-muted-foreground/60 line-through"
                            : t.durationDays && t.durationDays >= 1
                              ? "bg-info/10 text-info"
                              : "bg-muted text-foreground",
                        )}
                      >
                        {t.title}
                      </Link>
                    ))}
                    {dayTasks.length > 2 && (
                      <span className="block px-1 text-[10px] text-muted-foreground">+{dayTasks.length - 2}</span>
                    )}
                  </div>
                  {load > 0 && (
                    <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                      <div className={cn("h-full rounded-full", over ? "bg-danger" : loadPct > 75 ? "bg-warning" : "bg-success")} style={{ width: `${loadPct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            单次任务显示在计划完成日；周期任务从开始日横跨到结束日；每日负载按 8h 基准着色。
          </p>

          {unscheduled.length > 0 && (
            <section>
              <button
                onClick={() => setShowUnscheduled((v) => !v)}
                aria-expanded={showUnscheduled}
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                未排期任务（{unscheduled.length}）{showUnscheduled ? "−" : "＋"}
              </button>
              {showUnscheduled && (
                <ul className="animate-fade mt-2 space-y-1">
                  {unscheduled.map((t) => (
                    <li key={t.id} className="rounded border px-3 py-1.5 text-xs text-muted-foreground">
                      {t.title}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
