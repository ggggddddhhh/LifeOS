"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export interface GoalFormValues {
  title: string;
  description: string;
  deadline: string;
}

export function GoalForm({ onSubmit }: { onSubmit: (v: GoalFormValues) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit({ title, description, deadline });
      setTitle("");
      setDescription("");
      setDeadline("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="space-y-1.5">
        <Label htmlFor="goal-title">目标</Label>
        <Input
          id="goal-title"
          placeholder="例如：两周内完成 LifeOS MVP"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="goal-desc">补充说明（可选）</Label>
        <Textarea
          id="goal-desc"
          placeholder="背景、验收标准……"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="goal-deadline">截止日期（可选）</Label>
        <Input id="goal-deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </div>
      <Button type="submit" disabled={busy || !title.trim()} className="w-full">
        {busy ? "AI 正在拆解任务…" : "创建目标并 AI 拆解"}
      </Button>
    </form>
  );
}
