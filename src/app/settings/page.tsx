"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Plug, PlugZap, Settings as SettingsIcon, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/shared/states";
import { ThemeToggle } from "@/components/app/theme-toggle";
import type { Envelope } from "@/lib/ui-data";

interface CalStatus {
  provider: string;
  connected?: boolean;
  accountEmail?: string;
  calendarId?: string;
  store?: string;
  reason?: string;
}

/** Settings：外观 · Google Calendar 连接（agent 运维面代理）· 系统说明。 */
export default function SettingsPage() {
  const [status, setStatus] = useState<CalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/settings/calendar");
      const json = (await res.json()) as Envelope<CalStatus>;
      if (json.ok && json.data) setStatus(json.data);
      else setError(json.error ?? "读取失败");
    } catch {
      setError("Agent 不可达（需要先启动 agent 服务）");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function disconnect() {
    setBusy(true);
    try {
      await fetch("/api/settings/calendar", { method: "POST" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.connected === true;

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      </header>

      <section aria-label="外观" className="rounded-lg border p-4">
        <h2 className="text-[13px] font-semibold">外观</h2>
        <p className="mt-1 text-xs text-muted-foreground">浅色 / 深色 / 跟随系统，即时生效并记忆。</p>
        <div className="mt-3">
          <ThemeToggle />
        </div>
      </section>

      <section aria-label="Google Calendar 连接" className="rounded-lg border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-semibold">Google Calendar</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              只读你的空闲容量 + 经你确认后创建事件；断开会撤销授权并清除本地凭据。
            </p>
          </div>
          {loading ? (
            <Skeleton className="h-6 w-20" />
          ) : error ? (
            <StatusBadge tone="warning">状态未知</StatusBadge>
          ) : connected ? (
            <StatusBadge tone="success" dot>
              已连接
            </StatusBadge>
          ) : (
            <StatusBadge tone="neutral">未连接</StatusBadge>
          )}
        </div>

        <dl className="mt-3 space-y-1.5 text-xs">
          {status?.accountEmail && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">账号</dt>
              <dd className="truncate">{status.accountEmail}</dd>
            </div>
          )}
          {status?.calendarId && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">日历</dt>
              <dd className="truncate">{status.calendarId}</dd>
            </div>
          )}
          {status?.store && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">凭据存储</dt>
              <dd className="truncate">{status.store === "FileTokenStore" ? "本地文件（开发模式）" : status.store}</dd>
            </div>
          )}
        </dl>

        {error && <p className="mt-3 text-xs text-muted-foreground">{error}</p>}

        <div className="mt-4 flex items-center gap-2">
          {connected ? (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline" className="text-danger">
                  <Unplug className="mr-1.5 size-3.5" aria-hidden />
                  断开连接
                </Button>
              }
              title="断开 Google Calendar 连接？"
              description="将撤销授权并清除本地凭据；已写入日历的事件保持不变。重新连接需要再次授权。"
              confirmLabel="断开"
              destructive
              busy={busy}
              onConfirm={disconnect}
            />
          ) : (
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <PlugZap className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              连接方式：在 agent/.env 设 CALENDAR_PROVIDER=google 与 GOOGLE_CREDENTIALS_FILE，
              然后运行 agent/smoke_google.py 完成一次授权（state + PKCE）。
            </p>
          )}
          <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}>
            刷新状态
          </Button>
        </div>
      </section>

      <section aria-label="关于系统" className="rounded-lg border p-4">
        <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
          <SettingsIcon className="size-3.5" aria-hidden />
          系统说明
        </h2>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          <li className="flex gap-1.5">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
            AI 只做分析与计划（Analyze → Plan → Replan → Explain）；所有日历写入都需要你在 Goal 页显式确认。
          </li>
          <li className="flex gap-1.5">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
            重复确认是安全的：已写入的事件会被幂等机制跳过，时段被占用会标记冲突而非覆盖。
          </li>
          <li className="flex gap-1.5">
            <Plug className="mt-0.5 size-3.5 shrink-0 text-info" aria-hidden />
            GitHub 工具只读：在目标描述里写 repo:owner/name 即可接入进度观察，无需授权。
          </li>
        </ul>
      </section>
    </div>
  );
}
