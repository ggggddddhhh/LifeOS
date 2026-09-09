"use client";

import { useState } from "react";
import { KanbanSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/shared/states";
import { TaskCard } from "./task-card";
import type { TaskView } from "@/lib/ui-data";
import type { TaskStatus } from "@/lib/types";

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: "todo", title: "Todo" },
  { status: "in_progress", title: "Doing" },
  { status: "done", title: "Done" },
];

/**
 * Goal 三列看板：桌面（md+）三列并排（纯 CSS），窄屏用 tab 切换单列。
 * 状态变更只经 TaskCard 的显式 checkbox，无拖拽误触。
 */
export function Kanban({
  tasks,
  onStatusChange,
  onEdit,
  onDelete,
}: {
  tasks: TaskView[];
  onStatusChange: (id: string, status: TaskStatus) => void;
  onEdit?: (task: TaskView) => void;
  onDelete?: (task: TaskView) => void;
}) {
  const [mobileCol, setMobileCol] = useState<TaskStatus>("todo");
  if (tasks.length === 0) {
    return <EmptyState icon={KanbanSquare} title="还没有任务" hint="点上面的「重新规划」生成计划" />;
  }
  return (
    <div>
      {/* 窄屏列切换（md+ 隐藏，三列全展示） */}
      <div className="mb-3 flex gap-1 md:hidden" role="tablist" aria-label="看板列">
        {COLUMNS.map((c) => (
          <button
            key={c.status}
            role="tab"
            aria-selected={mobileCol === c.status}
            onClick={() => setMobileCol(c.status)}
            className={cn(
              "flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors duration-150",
              mobileCol === c.status ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            {c.title}（{tasks.filter((t) => t.status === c.status).length}）
          </button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
          return (
            <section key={col.status} aria-label={col.title} className={cn(col.status === mobileCol ? "block" : "hidden", "md:block")}>
              <header className="mb-2 flex items-center gap-2 px-0.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{col.title}</h3>
                <span className="tabular text-xs text-muted-foreground/70">{items.length}</span>
              </header>
              <div className="space-y-1.5">
                {items.map((t) => (
                  <TaskCard key={t.id} task={t} onStatusChange={onStatusChange} onEdit={onEdit} onDelete={onDelete} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
