"use client";

import { useCallback } from "react";
import Link from "next/link";
import { CalendarCheck2, ListTodo, Target } from "lucide-react";
import { GoalCreateDialog } from "@/components/goals/goal-create-dialog";
import { FocusGoal, OtherGoalRow, PlanHealth, focusScore } from "@/components/today/focus-goal";
import { TaskRow } from "@/components/today/task-row";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useGoals, type GoalView, type TaskView } from "@/lib/ui-data";
import type { TaskStatus } from "@/lib/types";

function todayStr(): string {
  return new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });
}

function dayOf(iso?: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Today 主页面——回答三个问题：今天做什么（Today Plan）· 计划还正常吗（Plan Health）·
 * 有什么变化（焦点目标 + 健康信号）。风险区只在有信号时出现。
 */
export default function TodayPage() {
  const { goals, policy, loading, error, refresh, setError } = useGoals();

  const onStatusChange = useCallback(
    async (taskId: string, status: TaskStatus) => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        if (!res.ok) throw new Error();
        refresh();
      } catch {
        setError("更新任务失败");
      }
    },
    [refresh, setError],
  );

  const active = goals.filter((g) => g.tasks.some((t) => t.status !== "done"));
  const focus = [...active].sort((a, b) => focusScore(a) - focusScore(b))[0];
  const others = [...active].filter((g) => g.id !== focus?.id);

  const todayMs = dayOf(new Date().toISOString()) ?? 0;
  const overdue: { task: TaskView; goal: GoalView }[] = [];
  const dueToday: { task: TaskView; goal: GoalView }[] = [];
  const doing: { task: TaskView; goal: GoalView }[] = [];
  for (const g of goals) {
    for (const t of g.tasks) {
      if (t.status === "done") continue;
      const due = dayOf(t.dueDate);
      if (due !== null && due < todayMs) overdue.push({ task: t, goal: g });
      else if (due === todayMs) dueToday.push({ task: t, goal: g });
      if (t.status === "in_progress") doing.push({ task: t, goal: g });
    }
  }
  const abbr = (g: GoalView) => (g.title.length > 10 ? `${g.title.slice(0, 10)}…` : g.title);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs text-muted-foreground">{todayStr()}</div>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Today</h1>
          {!loading && !error && goals.length > 0 && (
            <p className="tabular mt-1 text-xs text-muted-foreground">
              {dueToday.length > 0 && `今天到期 ${dueToday.length} 项`}
              {dueToday.length > 0 && doing.length > 0 && " · "}
              {doing.length > 0 && `进行中 ${doing.length} 项`}
              {overdue.length > 0 && ` · ${overdue.length} 项已过期`}
            </p>
          )}
        </div>
        <GoalCreateDialog onCreated={() => refresh()} />
      </header>

      {error && <ErrorState message={error} onRetry={refresh} />}
      {loading ? (
        <ListSkeleton rows={5} />
      ) : goals.length === 0 ? (
        <EmptyState
          icon={Target}
          title="从一个目标开始"
          hint="描述你想完成的事，PlanShift 会拆解成带估时与排期的计划，并观察 GitHub 与日历的真实进展。"
        />
      ) : (
        <>
          {focus ? (
            <section aria-label="今日焦点">
              <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Today&apos;s Focus
              </h2>
              <FocusGoal goal={focus} policy={policy} />
            </section>
          ) : (
            <EmptyState icon={CalendarCheck2} title="所有目标都已完成" hint="创建下一个目标，继续保持节奏。" />
          )}

          {others.length > 0 && (
            <section aria-label="其他进行中目标" className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">其他目标</h2>
                <Link href="/goals" className="text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                  查看全部 {active.length} 个 →
                </Link>
              </div>
              {others.slice(0, 2).map((g) => (
                <OtherGoalRow key={g.id} goal={g} />
              ))}
            </section>
          )}

          <PlanHealth goals={goals} policy={policy} />

          <section aria-label="今日计划">
            <h2 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ListTodo className="size-3.5" aria-hidden />
              Today Plan
            </h2>
            {overdue.length > 0 && (
              <div className="mb-1">
                <p className="mb-0.5 px-2 text-[11px] font-medium text-danger">已过期（{overdue.length}）</p>
                <div className="-mx-2">
                  {overdue.map(({ task, goal }) => (
                    <TaskRow key={task.id} task={task} goalAbbr={abbr(goal)} dueLabel="已过期" onStatusChange={onStatusChange} />
                  ))}
                </div>
              </div>
            )}
            {dueToday.length > 0 ? (
              <div className="-mx-2">
                {dueToday.map(({ task, goal }) => (
                  <TaskRow key={task.id} task={task} goalAbbr={abbr(goal)} dueLabel="今天" onStatusChange={onStatusChange} />
                ))}
              </div>
            ) : (
              <p className="px-2 py-2 text-xs text-muted-foreground">今天没有截止的任务。</p>
            )}
            {doing.length > 0 && (
              <div className="mt-2">
                <p className="mb-0.5 px-2 text-[11px] font-medium text-muted-foreground">进行中（{doing.length}）</p>
                <div className="-mx-2">
                  {doing.map(({ task, goal }) => (
                    <TaskRow key={task.id} task={task} goalAbbr={abbr(goal)} onStatusChange={onStatusChange} />
                  ))}
                </div>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
