"use client";

import { cn } from "@/lib/utils";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground border-transparent",
  info: "bg-info/10 text-info border-info/20",
  success: "bg-success/10 text-success border-success/20",
  warning: "bg-warning/15 text-warning border-warning/25",
  danger: "bg-danger/10 text-danger border-danger/20",
};

/** 统一状态徽章：写入状态 / 工具状态 / 冲突 / fallback 全站唯一表达。 */
export function StatusBadge({
  tone = "neutral",
  dot = false,
  className,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none",
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

/** 写入状态 → 徽章 tone/文案（Phase 7 语义不变，仅呈现统一） */
export function writeStatusBadge(status: string): { tone: Tone; label: string } {
  switch (status) {
    case "pending_confirmation":
      return { tone: "info", label: "待确认" };
    case "confirmed":
      return { tone: "info", label: "执行中" };
    case "executed":
      return { tone: "success", label: "已写入日历" };
    case "duplicate_skipped":
      return { tone: "neutral", label: "幂等跳过" };
    case "stale_conflict":
      return { tone: "warning", label: "时段冲突" };
    case "failed":
      return { tone: "danger", label: "失败" };
    case "cancelled":
      return { tone: "neutral", label: "已取消" };
    default:
      return { tone: "neutral", label: status };
  }
}
