"use client";

import { cn } from "@/lib/utils";
import type { TaskView } from "@/lib/ui-data";
import type { TaskStatus } from "@/lib/types";

/** Today 紧凑任务行：checkbox + 标题 + goal 缩写 + 时长（+ 可选到期标记）。 */
export function TaskRow({
  task,
  goalAbbr,
  dueLabel,
  onStatusChange,
}: {
  task: TaskView;
  goalAbbr: string;
  dueLabel?: string;
  onStatusChange: (id: string, status: TaskStatus) => void;
}) {
  const status = task.status as TaskStatus;
  const nextStatus: Record<TaskStatus, TaskStatus> = { todo: "in_progress", in_progress: "done", done: "todo" };
  return (
    <div className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-muted/40">
      <button
        aria-label={status === "done" ? "重置为待办" : status === "in_progress" ? "标记完成" : "开始任务"}
        onClick={() => onStatusChange(task.id, nextStatus[status])}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-150",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          status === "todo" && "border-muted-foreground/40 hover:border-foreground",
          status === "in_progress" && "border-info bg-info/20 text-info",
          status === "done" && "border-success bg-success text-success-fg",
        )}
      >
        {status === "done" && (
          <svg viewBox="0 0 12 12" className="size-3" fill="none" aria-hidden>
            <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {status === "in_progress" && <span className="size-1.5 rounded-sm bg-info" />}
      </button>
      <span
        title={goalAbbr}
        className="hidden w-20 shrink-0 truncate text-[11px] text-muted-foreground/70 sm:block"
      >
        {goalAbbr}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-[13px]", status === "done" && "text-muted-foreground line-through")}>
        {task.title}
      </span>
      {dueLabel && (
        <span className={cn("tabular shrink-0 text-[11px]", dueLabel === "已过期" ? "font-medium text-danger" : "text-muted-foreground")}>
          {dueLabel}
        </span>
      )}
      <span className="tabular shrink-0 text-[11px] text-muted-foreground">
        {task.durationDays && task.durationDays >= 1 ? `${task.durationDays}d` : `${task.estMinutes}m`}
      </span>
    </div>
  );
}
