"use client";

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { Envelope } from "@/lib/ui-data";
import type { GoalView } from "@/lib/ui-data";

/**
 * Goal 创建（重写）：入口是按钮，弹出对话框；提交后显示「AI 正在拆解」的进行态
 * （真实耗时可达 1 分钟），完成才关闭——而不是旧版表单常驻左侧。
 */
export function GoalCreateDialog({ onCreated }: { onCreated: (g: GoalView) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description: description || undefined, deadline: deadline || undefined }),
      });
      const json = (await res.json()) as Envelope<GoalView>;
      if (!json.ok || !json.data) {
        setError(json.error ?? "创建失败");
        return;
      }
      onCreated(json.data);
      setOpen(false);
      setTitle("");
      setDescription("");
      setDeadline("");
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="mr-1.5 size-3.5" aria-hidden />
            新目标
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>创建目标</DialogTitle>
          <DialogDescription>
            PlanShift 会把目标拆解成带估时、排期与依赖的任务计划。描述里可以写 repo:owner/name 接入 GitHub 进度观察。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3.5">
          <div className="space-y-1.5">
            <Label htmlFor="goal-title">目标</Label>
            <Input
              id="goal-title"
              placeholder="例如：两周内上线个人博客"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-desc">补充说明（可选）</Label>
            <Textarea
              id="goal-desc"
              placeholder="背景、验收标准、repo:owner/name……"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-deadline">截止日期（可选）</Label>
            <Input id="goal-deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />
                  AI 拆解中，约 1 分钟…
                </>
              ) : (
                "创建并拆解"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
