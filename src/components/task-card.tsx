"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TaskStatus } from "@/lib/types";

export interface TaskItem {
  id: string;
  title: string;
  notes?: string | null;
  status: string;
  priority: number;
  estMinutes: number;
  startDate?: string | null;
  dueDate?: string | null;
  durationDays?: number | null;
  dependsOn?: { id: string; title: string }[];
}

const PRIORITY_LABEL: Record<number, string> = { 1: "高", 2: "中", 3: "低" };
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};
const ACTION_LABEL: Record<TaskStatus, string> = {
  todo: "开始",
  in_progress: "完成",
  done: "重开",
};

function fmtDate(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

export function TaskCard({
  task,
  onStatusChange,
}: {
  task: TaskItem;
  onStatusChange: (id: string, status: TaskStatus) => void;
}) {
  const status = task.status as TaskStatus;
  return (
    <div className="rounded-md border bg-card p-3 text-sm shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium leading-snug">{task.title}</p>
        <Badge variant={task.priority === 1 ? "destructive" : task.priority === 2 ? "default" : "secondary"}>
          {PRIORITY_LABEL[task.priority] ?? "中"}
        </Badge>
      </div>
      {task.notes && <p className="mt-1 text-xs text-muted-foreground">{task.notes}</p>}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {task.durationDays && task.durationDays >= 1 ? (
          <Badge variant="outline" className="text-[11px]">
            🔁 {task.durationDays} 天 × {task.estMinutes}min
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[11px]">
            ⏱ {task.estMinutes}min
          </Badge>
        )}
        {task.dueDate && (
          <Badge variant="outline" className="text-[11px]">
            📅 {fmtDate(task.startDate)}~{fmtDate(task.dueDate)}
          </Badge>
        )}
        {task.dependsOn && task.dependsOn.length > 0 && (
          <Badge variant="outline" className="max-w-full truncate text-[11px]" title={task.dependsOn.map((d) => d.title).join("、")}>
            ⏳ 依赖 {task.dependsOn.length} 项
          </Badge>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {task.durationDays && task.durationDays >= 1 ? "周期型" : "单次型"}
        </span>
        <Button
          size="sm"
          variant={status === "done" ? "outline" : "secondary"}
          onClick={() => onStatusChange(task.id, NEXT_STATUS[status])}
        >
          {ACTION_LABEL[status]}
        </Button>
      </div>
    </div>
  );
}
