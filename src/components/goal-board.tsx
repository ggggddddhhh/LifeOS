"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TaskCard, type TaskItem } from "@/components/task-card";
import type { PlanDiff, TaskStatus } from "@/lib/types";

export interface GoalView {
  id: string;
  title: string;
  description?: string | null;
  deadline?: string | null;
  revision: number;
  tasks: TaskItem[];
}

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: "todo", title: "待办" },
  { status: "in_progress", title: "进行中" },
  { status: "done", title: "已完成" },
];

function budgetOf(t: TaskItem): number {
  return t.durationDays && t.durationDays >= 1 ? t.estMinutes * t.durationDays : t.estMinutes;
}

function BudgetBar({ goal }: { goal: GoalView }) {
  const open = goal.tasks.filter((t) => t.status !== "done");
  const totalMin = open.reduce((s, t) => s + budgetOf(t), 0);
  const daysLeft = goal.deadline
    ? Math.max(0, Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / 86400000))
    : null;
  const capacity = (daysLeft ?? 14) * 480;
  const ratio = Math.min(1.5, totalMin / capacity);
  const level = ratio > 1 ? "over" : ratio > 0.75 ? "tight" : "ok";
  const color = level === "over" ? "bg-destructive" : level === "tight" ? "bg-amber-500" : "bg-emerald-500";
  const label =
    level === "over"
      ? `超载 ${Math.round((ratio - 1) * 100)}%，建议 Replan 压缩`
      : level === "tight"
        ? "偏紧"
        : "充裕";
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          剩余投入 {Math.round(totalMin / 60)}h / 可用 {Math.round(capacity / 60)}h
          {daysLeft !== null && `（剩 ${daysLeft} 天 × 8h）`}
        </span>
        <span className={level === "over" ? "font-medium text-destructive" : ""}>{label}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: PlanDiff }) {
  return (
    <div className="mt-2 rounded-md bg-muted px-3 py-2 text-xs">
      <p className="mb-1 font-medium">
        计划变更：新增 {diff.summary.added} · 删除 {diff.summary.removed} · 保留 {diff.summary.kept} · 估时{" "}
        {diff.summary.estDelta >= 0 ? "+" : ""}
        {diff.summary.estDelta}min
      </p>
      {diff.added.length > 0 && (
        <p className="text-emerald-600">＋新增：{diff.added.map((a) => a.title).join("、")}</p>
      )}
      {diff.removed.length > 0 && (
        <p className="text-destructive">－删除：{diff.removed.map((r) => r.title).join("、")}</p>
      )}
      {diff.changed.length > 0 && (
        <div className="mt-1 space-y-0.5 text-muted-foreground">
          {diff.changed.map((c) => (
            <p key={c.title}>
              ⚙ {c.title}
              {c.estMinutesFrom !== undefined && c.estMinutesTo !== undefined && c.estMinutesFrom !== c.estMinutesTo && (
                <> 估时 {c.estMinutesFrom}→{c.estMinutesTo}min</>
              )}
              {c.moved && c.moved !== "不变" && <> · {c.moved}</>}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalBoard({
  goal,
  onStatusChange,
  onReplan,
  onDelete,
  replanReason,
  replanDiff,
  busy,
}: {
  goal: GoalView;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onReplan: (goalId: string) => void;
  onDelete: (goalId: string) => void;
  replanReason?: string | null;
  replanDiff?: PlanDiff | null;
  busy: boolean;
}) {
  const done = goal.tasks.filter((t) => t.status === "done").length;
  const total = goal.tasks.length;
  const daysLeft = goal.deadline
    ? Math.max(0, Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / 86400000))
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-lg">{goal.title}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              进度 {done}/{total} · 计划 v{goal.revision}
              {daysLeft !== null && ` · 剩余 ${daysLeft} 天`}
              {goal.deadline && ` · 截止 ${new Date(goal.deadline).toLocaleDateString("zh-CN")}`}
            </p>
            <BudgetBar goal={goal} />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => onReplan(goal.id)} disabled={busy}>
              {busy ? "Replan 中…" : "AI Replan"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDelete(goal.id)}>
              删除
            </Button>
          </div>
        </div>
        {replanReason && (
          <div className="mt-2">
            <p className="rounded-md bg-muted px-3 py-2 text-xs">🤖 {replanReason}</p>
            {replanDiff && <DiffView diff={replanDiff} />}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => (
            <div key={col.status} className="space-y-2">
              <h3 className="text-sm font-semibold text-muted-foreground">
                {col.title}（{goal.tasks.filter((t) => t.status === col.status).length}）
              </h3>
              <div className="space-y-2">
                {goal.tasks
                  .filter((t) => t.status === col.status)
                  .map((t) => (
                    <TaskCard key={t.id} task={t} onStatusChange={onStatusChange} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
