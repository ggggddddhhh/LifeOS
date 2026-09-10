"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Plug, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { Skeleton } from "@/components/shared/states";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { PlanningPolicySection } from "@/components/settings/planning-policy-section";
import { CalendarConnectGuide } from "@/components/settings/calendar-connect-guide";
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
  /** 区分「Agent 服务没启动」与「已连上但未授权」——前者是运维状态，不是配置问题 */
  const [serviceDown, setServiceDown] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    setServiceDown(false);
    try {
      const res = await fetch("/api/settings/calendar");
      if (!res.ok) {
        setServiceDown(true);
        setError("Agent 服务未运行——请先启动（npm run agent），再点「刷新状态」");
        setStatus(null);
        return;
      }
      const json = (await res.json()) as Envelope<CalStatus>;
      if (json.ok && json.data) setStatus(json.data);
      else setError(json.error ?? "读取失败");
    } catch {
      setServiceDown(true);
      setError("网络不可达，请检查服务是否在运行");
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
  /** Google 已授权连接（真正的 Google OAuth）；ICS 模式的 connected 只表示日历源可用，不代表 Google */
  const googleOn = connected && status?.provider === "google";
  const icsOn = connected && status?.provider === "ics";
  const [showGoogleGuide, setShowGoogleGuide] = useState(false);

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

      <PlanningPolicySection />

      <section aria-label="日历连接" className="rounded-lg border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-semibold">日历连接</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {icsOn
                ? "PlanShift 正在读取本地 ICS 日历文件（只读）：观察忙碌时段与既有事件，用于容量推断与排期避让。"
                : "连接 Google Calendar：只读你的空闲容量；创建事件前需要你逐条确认。断开会撤销授权并清除本地凭据。"}
            </p>
          </div>
          {loading ? (
            <Skeleton className="h-6 w-20" />
          ) : serviceDown ? (
            <StatusBadge tone="warning" dot>
              服务未启动
            </StatusBadge>
          ) : googleOn ? (
            <StatusBadge tone="success" dot>
              已连接
            </StatusBadge>
          ) : icsOn ? (
            <StatusBadge tone="info" dot>
              ICS 只读接入
            </StatusBadge>
          ) : (
            <StatusBadge tone="neutral">未连接</StatusBadge>
          )}
        </div>

        {googleOn && (
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
        )}

        {error && <p className="mt-3 text-xs text-muted-foreground">{error}</p>}

        {!loading && !serviceDown && !error && (!connected || (icsOn && showGoogleGuide)) && (
          <CalendarConnectGuide showIcsHint={!icsOn} />
        )}
        {!loading && !serviceDown && !error && icsOn && !showGoogleGuide && (
          <button
            type="button"
            onClick={() => setShowGoogleGuide(true)}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            连接 Google Calendar，获得确认制写入 →
          </button>
        )}
        {icsOn && showGoogleGuide && (
          <button
            type="button"
            onClick={() => setShowGoogleGuide(false)}
            className="mt-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            收起，继续使用 ICS 只读
          </button>
        )}

        <div className="mt-4 flex items-center gap-2">
          {googleOn && (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="outline" className="text-danger">
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
            AI 只做分析与计划；调整任务计划、写入日历，都需要你在对应页面显式确认后才执行。
          </li>
          <li className="flex gap-1.5">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
            重复确认是安全的：已写入的事件不会重复创建；时段被占用会标记冲突，绝不覆盖已有安排。
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
