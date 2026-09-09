"use client";

import { useMemo, useState } from "react";
import { CalendarClock, Loader2, TriangleAlert, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Envelope, GoalView, TaskView } from "@/lib/ui-data";

interface FieldChange {
  field: string;
  from: string;
  to: string;
}

interface DryRunResult {
  dryRun: true;
  changes: FieldChange[];
  warnings: string[];
  calendarHint: boolean;
}

const PRIORITY_OPTIONS = [
  { value: 1, label: "高" },
  { value: 2, label: "中" },
  { value: 3, label: "低" },
];

const EST_QUICK = [30, 60, 120];

function isoDate(v?: string | null): string {
  return v ? new Date(v).toISOString().slice(0, 10) : "";
}

/**
 * 任务表单对话框（Phase 11 用户控制权）：
 * - 编辑：先在表单里改 → 「检查修改」服务端校验（环/越界硬拒、容量软警告）→
 *   预览变更（含警告与日历提示）→ 「确认保存」才落库。保存后任务标记为用户设定。
 * - 新建：表单即预览，点「创建任务」校验并落库（origin=user）。
 */
export function TaskFormDialog({
  mode,
  goal,
  task,
  open,
  onOpenChange,
  onSaved,
}: {
  mode: "edit" | "create";
  goal: GoalView;
  task?: TaskView | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: (notice: string | null) => void;
}) {
  const editing = mode === "edit" && task;
  // 状态在挂载时由 props 初始化（调用方条件渲染 + key 保证每次打开都是新实例）
  const [title, setTitle] = useState(task?.title ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [priority, setPriority] = useState(task?.priority ?? 2);
  const [estMinutes, setEstMinutes] = useState(task?.estMinutes ?? 60);
  const [dueDate, setDueDate] = useState(isoDate(task?.dueDate));
  const [depIds, setDepIds] = useState<string[]>((task?.dependsOn ?? []).map((d) => d.id));
  const [step, setStep] = useState<"form" | "preview">("form");
  const [preview, setPreview] = useState<DryRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const siblings = useMemo(
    () => goal.tasks.filter((t) => t.id !== task?.id && t.status !== "done"),
    [goal.tasks, task],
  );

  function buildPayload() {
    return {
      title: title.trim(),
      notes: notes.trim() || null,
      priority,
      estMinutes,
      dueDate: dueDate || null,
      dependsOnIds: depIds,
    };
  }

  async function runDryRun() {
    if (!editing || !task) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}?dryRun=1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const json = (await res.json()) as Envelope<DryRunResult>;
      if (!json.ok || !json.data) {
        setError(json.error ?? "校验失败");
        return;
      }
      if (json.data.changes.length === 0) {
        setError("没有检测到字段变化");
        return;
      }
      setPreview(json.data);
      setStep("preview");
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing || !task) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildPayload(),
          expectedUpdatedAt: task.updatedAt,
        }),
      });
      const json = (await res.json()) as Envelope<{ calendarHint: boolean }>;
      if (!json.ok) {
        setError(json.error ?? "保存失败");
        if (res.status !== 409) setStep("form");
        return;
      }
      onSaved(
        json.data?.calendarHint
          ? `已保存「${title.trim() || task.title}」。它此前已写入日历——日历上的事件不会自动更新，需要的话请重新生成排期草稿。`
          : `已保存「${title.trim() || task.title}」的调整（第 ${goal.revision + 1} 版留痕，可撤销）`,
      );
      onOpenChange(false);
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function createTask() {
    if (!title.trim()) {
      setError("任务标题不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goal.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const json = (await res.json()) as Envelope<TaskView>;
      if (!json.ok) {
        setError(json.error ?? "创建失败");
        return;
      }
      onSaved(`已添加任务「${title.trim()}」——它由你手动设定，重新规划不会改动它`);
      onOpenChange(false);
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  const deadlineStr = goal.deadline ? isoDate(goal.deadline) : "";

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑任务" : "添加任务"}</DialogTitle>
          <DialogDescription>
            {editing
              ? step === "form"
                ? "修改后先检查，再确认保存。保存后这项任务标记为「你手动设定」，重新规划不会改动它。"
                : "确认后将替换任务的这些字段（可随时撤销）。"
              : "手动添加的任务同样进入排期与看板，且不会被重新规划改写。"}
          </DialogDescription>
        </DialogHeader>

        {step === "form" || mode === "create" ? (
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label htmlFor="task-title">标题</Label>
              <Input
                id="task-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="要做什么"
                maxLength={120}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="task-est">预计时长（分钟）</Label>
                <Input
                  id="task-est"
                  type="number"
                  min={5}
                  max={1440}
                  step={5}
                  value={estMinutes}
                  onChange={(e) => setEstMinutes(Number(e.target.value))}
                />
                <div className="flex gap-1 pt-0.5">
                  {EST_QUICK.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setEstMinutes(m)}
                      className={cn(
                        "rounded border px-1.5 py-0.5 text-[11px] transition-colors",
                        estMinutes === m ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      {m}m
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>优先级</Label>
                <div className="flex gap-1">
                  {PRIORITY_OPTIONS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setPriority(p.value)}
                      aria-pressed={priority === p.value}
                      className={cn(
                        "flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
                        priority === p.value ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-due">
                截止日期{deadlineStr ? `（不晚于 ${deadlineStr.slice(5).replace("-", "/")}）` : "（可选）"}
              </Label>
              <div className="flex items-center gap-2">
                <Input id="task-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                {dueDate && (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setDueDate("")}>
                    清除
                  </Button>
                )}
              </div>
            </div>
            {siblings.length > 0 && (
              <div className="space-y-1.5">
                <Label>依赖（需要先完成的事项）</Label>
                <div className="max-h-32 space-y-1 overflow-auto rounded-md border p-2">
                  {siblings.map((s) => (
                    <label key={s.id} className="flex cursor-pointer items-start gap-2 text-xs leading-snug">
                      <input
                        type="checkbox"
                        checked={depIds.includes(s.id)}
                        onChange={(e) =>
                          setDepIds((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)))
                        }
                        className="mt-0.5 accent-foreground"
                      />
                      <span className="min-w-0 flex-1">{s.title}</span>
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">不能选出循环依赖（例如 A→B→A），保存前会自动检查。</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="task-notes">备注（可选）</Label>
              <Textarea id="task-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="补充说明" />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <ul className="space-y-1.5 rounded-md border p-2.5 text-xs">
              {preview?.changes.map((c) => (
                <li key={c.field} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="w-16 shrink-0 font-medium text-foreground">{c.field}</span>
                  <span className="text-muted-foreground line-through decoration-muted-foreground/40">{c.from}</span>
                  <span aria-hidden className="text-muted-foreground">→</span>
                  <span className="font-medium text-foreground">{c.to}</span>
                </li>
              ))}
            </ul>
            {preview?.warnings.map((w) => (
              <p key={w} className="flex items-start gap-1.5 rounded-md border border-warning/25 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed text-foreground">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                {w}
              </p>
            ))}
            {preview?.calendarHint && (
              <p className="flex items-start gap-1.5 rounded-md border border-info/25 bg-info/10 px-2.5 py-2 text-xs leading-relaxed text-foreground">
                <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
                这项任务已写入你的日历。保存不会改动日历上的事件；如需新时间，保存后重新生成排期草稿。
              </p>
            )}
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <UserCheck className="size-3.5 shrink-0" aria-hidden />
              保存后标记为「你手动设定」，重新规划不会改动它。
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        <DialogFooter>
          {step === "form" || mode === "create" ? (
            <>
              <DialogClose render={<Button variant="outline" disabled={busy} />}>取消</DialogClose>
              {mode === "create" ? (
                <Button onClick={createTask} disabled={busy || !title.trim()}>
                  {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />}
                  {busy ? "创建中…" : "创建任务"}
                </Button>
              ) : (
                <Button onClick={runDryRun} disabled={busy || !title.trim()}>
                  {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />}
                  {busy ? "检查中…" : "检查修改"}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep("form")} disabled={busy}>
                返回编辑
              </Button>
              <Button onClick={saveEdit} disabled={busy}>
                {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />}
                {busy ? "保存中…" : "确认保存"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
