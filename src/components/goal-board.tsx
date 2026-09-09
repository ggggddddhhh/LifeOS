"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TaskCard, type TaskItem } from "@/components/task-card";
import type { TaskStatus } from "@/lib/types";

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

export function GoalBoard({
  goal,
  onStatusChange,
  onReplan,
  onDelete,
  replanReason,
  busy,
}: {
  goal: GoalView;
  onStatusChange: (taskId: string, status: TaskStatus) => void;
  onReplan: (goalId: string) => void;
  onDelete: (goalId: string) => void;
  replanReason?: string | null;
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
          <p className="mt-2 rounded-md bg-muted px-3 py-2 text-xs">🤖 {replanReason}</p>
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
