"use client";

import { useState } from "react";
import { CalendarClock, ChevronDown, Link2, Repeat2, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtRange, type TaskView } from "@/lib/ui-data";
import type { TaskStatus } from "@/lib/types";

/** 优先级用点的密度表达（P1 实心 / P2 空心 / P3 无），不占用颜色语义。 */
function PriorityDot({ level }: { level: number }) {
  if (level >= 3) return null;
  return (
    <span
      title={level === 1 ? "优先级 P1" : "优先级 P2"}
      className={cn("mt-1 size-1.5 shrink-0 rounded-full", level === 1 ? "bg-foreground" : "border border-muted-foreground/60")}
      aria-hidden
    />
  );
}

const STATUS_TITLE: Record<TaskStatus, string> = { todo: "待办", in_progress: "进行中", done: "已完成" };

/**
 * Kanban 任务卡（重写）：checkbox 三态、紧凑 meta 行（时长/周期/日期/依赖），
  notes 可折叠；点击 checkbox 顺序推进 todo→doing→done，回退走菜单防误触。
 */
export function TaskCard({
  task,
  onStatusChange,
}: {
  task: TaskView;
  onStatusChange: (id: string, status: TaskStatus) => void;
}) {
  const status = task.status as TaskStatus;
  const [expanded, setExpanded] = useState(false);
  const nextStatus: Record<TaskStatus, TaskStatus> = { todo: "in_progress", in_progress: "done", done: "todo" };

  return (
    <article
      className={cn(
        "group rounded-lg border bg-card p-2.5 transition-colors duration-150 hover:bg-muted/40",
        status === "done" && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <button
          aria-label={`标记为${STATUS_TITLE[nextStatus[status]]}`}
          title={`→ ${STATUS_TITLE[nextStatus[status]]}`}
          onClick={() => onStatusChange(task.id, nextStatus[status])}
          className={cn(
            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-150",
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
        <PriorityDot level={task.priority} />
        <div className="min-w-0 flex-1">
          <p className={cn("text-[13px] font-medium leading-snug", status === "done" && "line-through")}>{task.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="tabular inline-flex items-center gap-1">
              {task.durationDays && task.durationDays >= 1 ? (
                <>
                  <Repeat2 className="size-3" aria-hidden />
                  {task.durationDays} 天 × {task.estMinutes}m
                </>
              ) : (
                <>
                  <Timer className="size-3" aria-hidden />
                  {task.estMinutes}m
                </>
              )}
            </span>
            {(task.startDate || task.dueDate) && (
              <span className="tabular inline-flex items-center gap-1">
                <CalendarClock className="size-3" aria-hidden />
                {fmtRange(task.startDate, task.dueDate)}
              </span>
            )}
            {task.dependsOn && task.dependsOn.length > 0 && (
              <span
                className="inline-flex items-center gap-1"
                title={`依赖：${task.dependsOn.map((d) => d.title).join("、")}`}
              >
                <Link2 className="size-3" aria-hidden />
                {task.dependsOn.length}
              </span>
            )}
          </div>
          {task.notes && (
            <>
              <button
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-muted-foreground/80 hover:text-foreground"
              >
                <ChevronDown className={cn("size-3 transition-transform duration-150", expanded && "rotate-180")} aria-hidden />
                备注
              </button>
              {expanded && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{task.notes}</p>}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
