"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { GoalView } from "@/components/goal-board";

const DAY_MS = 86400000;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function fmtShort(ms: number): string {
  return new Date(ms).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

interface CalTask {
  id: string;
  title: string;
  goalTitle: string;
  status: string;
  estMinutes: number;
  durationDays?: number | null;
  startMs: number | null;
  dueMs: number | null;
}

export function CalendarView({ goals }: { goals: GoalView[] }) {
  const [monthOffset, setMonthOffset] = useState(0);

  const tasks = useMemo<CalTask[]>(
    () =>
      goals.flatMap((g) =>
        g.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          goalTitle: g.title,
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
  // 周一为首列：偏移 = (weekday + 6) % 7
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
      if (t.durationDays && t.durationDays >= 1 && t.startMs !== null) {
        return ms >= t.startMs && ms <= t.dueMs; // 周期型：条带覆盖每一天
      }
      return t.dueMs === ms; // 单次型：落在截止日
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">日历 · {monthLabel}</CardTitle>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setMonthOffset((v) => v - 1)}>
              ← 上月
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMonthOffset(0)}>
              今天
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMonthOffset((v) => v + 1)}>
              下月 →
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          单次任务显示在计划完成日；周期型任务（🔁）从开始日横跨到结束日；日格红色表示当日投入超过 8 小时。
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground">
          {WEEKDAYS.map((w) => (
            <div key={w} className="py-1">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((ms, i) => {
            if (ms === null) return <div key={i} className="min-h-24 rounded-md bg-muted/30" />;
            const dayTasks = tasksOnDay(ms);
            const load = dayTasks
              .filter((t) => t.status !== "done")
              .reduce((s, t) => s + t.estMinutes, 0);
            const overload = load > 480;
            return (
              <div
                key={i}
                className={`min-h-24 rounded-md border p-1 text-left ${ms === todayMs ? "border-primary" : ""}`}
              >
                <div className="flex items-center justify-between">
                  <span className={`text-xs ${ms === todayMs ? "font-bold text-primary" : "text-muted-foreground"}`}>
                    {new Date(ms).getDate()}
                  </span>
                  {dayTasks.length > 0 && (
                    <span className={`text-[10px] ${overload ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                      {load > 0 ? `${Math.round(load / 60)}h` : ""}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 space-y-0.5">
                  {dayTasks.slice(0, 3).map((t) => (
                    <div
                      key={t.id}
                      title={`${t.goalTitle} — ${t.title}`}
                      className={`truncate rounded px-1 py-0.5 text-[10px] ${
                        t.status === "done"
                          ? "bg-muted text-muted-foreground line-through"
                          : t.durationDays && t.durationDays >= 1
                            ? "bg-primary/10 text-primary"
                            : "bg-secondary"
                      }`}
                    >
                      {t.durationDays && t.durationDays >= 1 ? "🔁" : ""}
                      {t.title}
                    </div>
                  ))}
                  {dayTasks.length > 3 && (
                    <div className="text-[10px] text-muted-foreground">+{dayTasks.length - 3} 项</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {unscheduled.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-1 text-sm font-semibold text-muted-foreground">未排期任务（{unscheduled.length}）</h4>
            <div className="flex flex-wrap gap-1">
              {unscheduled.map((t) => (
                <Badge key={t.id} variant="outline" className="text-xs">
                  {t.goalTitle.slice(0, 8)} · {t.title}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
