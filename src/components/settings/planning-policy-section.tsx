"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Settings2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/shared/states";
import { WEEKDAY_LABELS, type PlanningPolicy } from "@/lib/policy-core";
import type { Envelope } from "@/lib/ui-data";
import { cn } from "@/lib/utils";

interface PolicyImpact {
  affectedGoals: { id: string; title: string; openMinutes: number; capacityMinutes: number }[];
  pendingDrafts: number;
}

function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function timeToMinutes(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 24 || mm > 59) return null;
  return h * 60 + mm;
}

/** 常用时区（选择器选项；非全量列表——任何 IANA 名称都可手输） */
const COMMON_TZS = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Australia/Sydney",
  "UTC",
];

/**
 * 规划策略（Phase 12）：每日可投入 / 工作日 / 工作时段 / 时区 / 目标日历 / 任务默认值。
 * 保存前先「检查影响」——超容量目标与待确认草稿数量；确认后才落库。
 * 保存不会改动日历上已有的事件。
 */
export function PlanningPolicySection() {
  const [policy, setPolicy] = useState<PlanningPolicy | null>(null);
  const [capacity, setCapacity] = useState("480");
  const [workdays, setWorkdays] = useState<number[]>([]);
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("20:00");
  const [tz, setTz] = useState("Asia/Shanghai");
  const [calendarId, setCalendarId] = useState("primary");
  const [defaultEst, setDefaultEst] = useState("60");
  const [defaultPriority, setDefaultPriority] = useState(2);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<PolicyImpact | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/planning");
        const json = (await res.json()) as Envelope<PlanningPolicy>;
        if (json.ok && json.data) {
          setPolicy(json.data);
          setCapacity(String(json.data.dailyCapacityMinutes));
          setWorkdays(json.data.workdays);
          setStart(minutesToTime(json.data.workStartMinute));
          setEnd(minutesToTime(json.data.workEndMinute));
          setTz(json.data.timezone);
          setCalendarId(json.data.calendarId);
          setDefaultEst(String(json.data.defaultEstMinutes));
          setDefaultPriority(json.data.defaultPriority);
        } else {
          setError(json.error ?? "读取失败");
        }
      } catch {
        setError("网络不可达");
      }
    })();
  }, []);

  const payload = useMemo(
    () => ({
      dailyCapacityMinutes: Number(capacity),
      workdays,
      workStartMinute: timeToMinutes(start),
      workEndMinute: timeToMinutes(end),
      timezone: tz,
      calendarId,
      defaultEstMinutes: Number(defaultEst),
      defaultPriority,
    }),
    [capacity, workdays, start, end, tz, calendarId, defaultEst, defaultPriority],
  );

  async function checkImpact() {
    setBusy(true);
    setError(null);
    setSavedNote(null);
    try {
      const res = await fetch("/api/settings/planning?impact=1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as Envelope<{ preview: true; impact: PolicyImpact }>;
      if (!json.ok || !json.data) {
        setError(json.error ?? "校验失败");
        return;
      }
      setImpact(json.data.impact);
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/planning", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as Envelope<{ policy: PlanningPolicy }>;
      if (!json.ok) {
        setError(json.error ?? "保存失败");
        return;
      }
      setPolicy(json.data.policy);
      setImpact(null);
      setSavedNote(
        payload.calendarId !== "primary"
          ? `已保存。新事件将写入日历「${payload.calendarId}」；已写入日历的事件保持不变。`
          : "已保存。重新规划与排期草稿即刻按新策略计算；已写入日历的事件保持不变。",
      );
    } catch {
      setError("网络不可达，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  if (error && !policy) {
    return (
      <section aria-label="规划策略" className="rounded-lg border p-4">
        <h2 className="text-[13px] font-semibold">规划策略</h2>
        <p className="mt-2 text-xs text-muted-foreground">{error}</p>
      </section>
    );
  }
  if (!policy) {
    return (
      <section aria-label="规划策略" className="rounded-lg border p-4">
        <Skeleton className="mb-2 h-4 w-24" />
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }

  return (
    <section aria-label="规划策略" className="rounded-lg border p-4">
      <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
        <Settings2 className="size-3.5" aria-hidden />
        规划策略
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        重新规划、容量估算与排期草稿都按这份策略计算。保存不会改动日历上已有的事件。
      </p>

      <div className="mt-3 space-y-3.5">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pp-capacity">每日可投入（分钟）</Label>
            <Input
              id="pp-capacity"
              type="number"
              min={0}
              max={1440}
              step={15}
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">0 = 暂停一切排期</p>
          </div>
          <div className="space-y-1.5">
            <Label>工作日</Label>
            <div className="flex flex-wrap gap-1">
              {WEEKDAY_LABELS.map((label, i) => {
                const day = i + 1;
                const on = workdays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    title={`星期${label}`}
                    onClick={() =>
                      setWorkdays((prev) => (on ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b)))
                    }
                    className={cn(
                      "size-7 rounded-md border text-xs font-medium transition-colors",
                      on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pp-start">工作开始</Label>
            <Input id="pp-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-end">工作结束</Label>
            <Input id="pp-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pp-tz">时区</Label>
            <Input id="pp-tz" list="pp-tz-list" value={tz} onChange={(e) => setTz(e.target.value)} />
            <datalist id="pp-tz-list">
              {COMMON_TZS.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <p className="text-[11px] text-muted-foreground">排期按此时区的墙钟计算（IANA 名称）</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pp-cal">目标日历</Label>
            <Input id="pp-cal" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} />
            <p className="text-[11px] text-muted-foreground">排期草稿默认写入的日历（如 primary）</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="pp-est">默认任务时长（分钟）</Label>
            <Input
              id="pp-est"
              type="number"
              min={5}
              max={1440}
              step={5}
              value={defaultEst}
              onChange={(e) => setDefaultEst(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>默认优先级</Label>
            <div className="flex gap-1">
              {[
                { v: 1, label: "高" },
                { v: 2, label: "中" },
                { v: 3, label: "低" },
              ].map((p) => (
                <button
                  key={p.v}
                  type="button"
                  aria-pressed={defaultPriority === p.v}
                  onClick={() => setDefaultPriority(p.v)}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
                    defaultPriority === p.v ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {error && policy && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      {savedNote && (
        <p className="animate-rise mt-3 rounded-md border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-foreground">
          {savedNote}
        </p>
      )}

      {impact ? (
        <div className="mt-3 space-y-2.5 rounded-md border p-3">
          <p className="text-xs font-medium">保存后的影响</p>
          {impact.affectedGoals.length === 0 ? (
            <p className="text-xs text-muted-foreground">所有进行中目标的剩余工作量都在新容量之内。</p>
          ) : (
            <ul className="space-y-1.5">
              {impact.affectedGoals.slice(0, 5).map((g) => (
                <li key={g.id} className="flex items-start gap-1.5 text-xs leading-relaxed">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                  <span>
                    「{g.title.length > 20 ? `${g.title.slice(0, 20)}…` : g.title}」剩余 {Math.round(g.openMinutes / 60)}h
                    将超出新容量 {Math.round(g.capacityMinutes / 60)}h，建议重新规划
                  </span>
                </li>
              ))}
              {impact.affectedGoals.length > 5 && (
                <li className="text-[11px] text-muted-foreground">…以及其他 {impact.affectedGoals.length - 5} 个目标</li>
              )}
            </ul>
          )}
          {impact.pendingDrafts > 0 && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              有 {impact.pendingDrafts} 条待确认的排期草稿仍按旧策略生成；重新生成后才会按新策略排期。
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            日历上已有的事件不会被改动（系统不会自动改期或删除）。
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setImpact(null)} disabled={saving}>
              返回编辑
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden />}
              {saving ? "保存中…" : "确认保存"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Button size="sm" onClick={checkImpact} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> : null}
            {busy ? "检查中…" : "检查影响并保存"}
          </Button>
        </div>
      )}
    </section>
  );
}
