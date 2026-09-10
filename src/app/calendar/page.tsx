"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useGoals } from "@/lib/ui-data";
import { cn } from "@/lib/utils";

const DAY_MS = 86400000;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 规划时区下的日 key（YYYY-MM-DD）——外部 Instant 事件与本地日期统一归日。 */
function dayKeyInTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function timeInTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

interface ExtEvent {
  title: string;
  startUtc: string;
  endUtc: string;
  all_day: boolean;
  local_date: string | null;
  source: string; // user = 外部现实 | lifeos = PlanShift 写入
}

interface CalTask {
  id: string;
  goalId: string;
  title: string;
  status: string;
  estMinutes: number;
  durationDays?: number | null;
  startMs: number | null;
  dueMs: number | null;
}

/** 一天里的条目（四种来源层，样式见 Legend）。 */
interface DayItem {
  key: string;
  kind: "external" | "synced" | "proposed" | "planned";
  title: string;
  time?: string;
  goalId?: string;
  done?: boolean;
  span?: boolean; // 周期任务横跨
}

const ITEM_CLS: Record<DayItem["kind"], string> = {
  // Reality · 外部现实（Google/ICS 里你自己的安排）：中性灰 + 竖线，稳定低干扰
  external: "border-l-2 border-muted-foreground/40 bg-muted/60 text-foreground",
  // Reality · PlanShift 已写入：success 语义
  synced: "border-l-2 border-success/60 bg-success/10 text-success",
  // Shift · 待确认提案（尚未写入日历）：虚线 + accent
  proposed: "border border-dashed border-primary/60 bg-primary/5 text-primary",
  // Plan · 计划任务（还没进日历）
  planned: "bg-primary/10 text-primary",
};

function LegendSwatch({ kind }: { kind: DayItem["kind"] }) {
  return <span aria-hidden className={cn("inline-block h-2.5 w-4 shrink-0 rounded-[3px]", ITEM_CLS[kind])} />;
}

/**
 * 全局月历：Reality（外部事件 / 已写入）与 Plan（计划任务 / 待确认提案）分层呈现。
 * 桌面月网格；手机 = 紧凑月 + 选中日 agenda（业务逻辑不变，只换呈现）。
 */
export default function CalendarPage() {
  const { goals, policy, loading, error, refresh } = useGoals();
  const [monthOffset, setMonthOffset] = useState(0);
  const [showUnscheduled, setShowUnscheduled] = useState(false);
  const [ext, setExt] = useState<{ ok: boolean; events: ExtEvent[] } | null>(null);
  const [calStatus, setCalStatus] = useState<{ provider?: string; connected?: boolean } | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // YYYY-MM-DD（mobile agenda）
  const tz = policy.timezone;
  const dailyCap = policy.dailyCapacityMinutes;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/calendar/external?days=45&tz=${encodeURIComponent(tz)}`);
        const json = (await res.json()) as { ok: boolean; data?: { ok: boolean; events: ExtEvent[] } };
        if (alive && json.ok && json.data) setExt({ ok: json.data.ok, events: json.data.events ?? [] });
        else if (alive) setExt({ ok: false, events: [] });
      } catch {
        if (alive) setExt({ ok: false, events: [] });
      }
      try {
        const res2 = await fetch("/api/settings/calendar");
        const j2 = (await res2.json()) as { ok: boolean; data?: { provider?: string; connected?: boolean } };
        if (alive && j2.ok && j2.data) setCalStatus(j2.data);
      } catch {
        /* 状态 chip 缺席即可，不阻断页面 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [tz]);

  const tasks = useMemo<CalTask[]>(
    () =>
      goals.flatMap((g) =>
        g.tasks.map((t) => ({
          id: t.id,
          goalId: g.id,
          title: t.title,
          status: t.status,
          estMinutes: t.estMinutes,
          durationDays: t.durationDays,
          startMs: t.startDate ? startOfDay(new Date(t.startDate)) : null,
          dueMs: t.dueDate ? startOfDay(new Date(t.dueDate)) : null,
        })),
      ),
    [goals],
  );

  const todayKey = useMemo(() => dayKeyInTz(new Date().getTime(), tz), [tz]);
  const view = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  }, [monthOffset]);
  const monthStart = startOfDay(view);
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const leading = (new Date(monthStart).getDay() + 6) % 7;
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => monthStart + i * DAY_MS),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const unscheduled = tasks.filter((t) => t.dueMs === null && t.status !== "done");
  const monthLabel = view.toLocaleDateString("zh-CN", { year: "numeric", month: "long" });

  // 待确认提案（pending_confirmation / confirmed = 已确认未执行）
  const proposed = useMemo(
    () =>
      goals.flatMap((g) =>
        (g.calDrafts ?? [])
          .filter((d) => d.status === "pending_confirmation" || d.status === "confirmed")
          .map((d) => ({ ...d, goalId: g.id, ms: new Date(d.proposedStart).getTime() })),
      ),
    [goals],
  );

  // agent 不可读时回退：用 DB 的 executed/duplicate_skipped 草稿表示「已写入」
  const executedFallback = useMemo(
    () =>
      goals.flatMap((g) =>
        (g.calDrafts ?? [])
          .filter((d) => d.status === "executed" || d.status === "duplicate_skipped")
          .map((d) => ({ ...d, goalId: g.id, ms: new Date(d.proposedStart).getTime() })),
      ),
    [goals],
  );
  const useFallbackSynced = ext === null || !ext.ok;

  function itemsOnDay(key: string): DayItem[] {
    const items: DayItem[] = [];
    if (ext?.ok) {
      for (const e of ext.events) {
        const k = e.all_day && e.local_date ? e.local_date : e.startUtc ? dayKeyInTz(new Date(e.startUtc).getTime(), tz) : null;
        if (k !== key) continue;
        if (e.source === "lifeos") items.push({ key: `x-${e.title}-${k}`, kind: "synced", title: e.title.replace(/^PlanShift:?\s*/, ""), time: e.all_day ? "全天" : timeInTz(new Date(e.startUtc).getTime(), tz) });
        else items.push({ key: `e-${e.title}-${k}`, kind: "external", title: e.title, time: e.all_day ? "全天" : timeInTz(new Date(e.startUtc).getTime(), tz) });
      }
    }
    if (useFallbackSynced) {
      for (const d of executedFallback) {
        if (dayKeyInTz(d.ms, tz) === key) items.push({ key: `f-${d.id}`, kind: "synced", title: d.taskTitle, time: timeInTz(d.ms, tz), goalId: d.goalId });
      }
    }
    for (const d of proposed) {
      if (dayKeyInTz(d.ms, tz) === key) items.push({ key: `p-${d.id}`, kind: "proposed", title: d.taskTitle, time: timeInTz(d.ms, tz), goalId: d.goalId });
    }
    for (const t of tasks) {
      if (t.dueMs === null) continue;
      const dueKey = dayKeyInTz(t.dueMs, tz);
      const span = !!(t.durationDays && t.durationDays >= 1 && t.startMs !== null);
      const hit = span ? key >= dayKeyInTz(t.startMs!, tz) && key <= dueKey : key === dueKey;
      if (hit) items.push({ key: `t-${t.id}-${key}`, kind: "planned", title: t.title, goalId: t.goalId, done: t.status === "done", span });
    }
    return items;
  }

  function loadOnDay(key: string): number {
    return tasks
      .filter((t) => t.status !== "done" && t.dueMs !== null && dayKeyInTz(t.dueMs, tz) === key)
      .reduce((s, t) => s + t.estMinutes, 0);
  }

  const selectedItems = selected ? itemsOnDay(selected) : [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{monthLabel}</h1>
          {calStatus && (
            <span
              className="inline-flex items-center gap-1.5 rounded border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground"
              title={
                calStatus.connected
                  ? "外部日历已连接：只读你的空闲容量，事件在下方以灰色呈现"
                  : "未连接外部日历（可在 Settings 连接 Google Calendar）"
              }
            >
              <span className={cn("size-1.5 rounded-full", calStatus.connected ? "bg-success" : "bg-muted-foreground/40")} aria-hidden />
              {calStatus.provider === "google" ? "Google Calendar" : calStatus.provider === "ics" ? "ICS 日历" : "外部日历"}
              {calStatus.connected ? "" : " 未连接"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" onClick={() => setMonthOffset((v) => v - 1)} aria-label="上个月">
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setMonthOffset(0);
              setSelected(todayKey);
            }}
          >
            今天
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => setMonthOffset((v) => v + 1)} aria-label="下个月">
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </header>

      {/* Legend：四层来源语义，一行可扫读 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground" aria-label="图例">
        <span className="inline-flex items-center gap-1.5">
          <LegendSwatch kind="external" /> 你的日历（现实）
        </span>
        <span className="inline-flex items-center gap-1.5">
          <LegendSwatch kind="synced" /> PlanShift 已写入
        </span>
        <span className="inline-flex items-center gap-1.5">
          <LegendSwatch kind="proposed" /> 待确认排期
        </span>
        <span className="inline-flex items-center gap-1.5">
          <LegendSwatch kind="planned" /> 计划任务
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-[3px] bg-muted" aria-hidden /> 日负载{" "}
          <span className="tabular">{Math.round(dailyCap / 60)}h/天上限</span>
        </span>
      </div>

      {error && <ErrorState message={error} onRetry={refresh} />}
      {loading ? (
        <ListSkeleton rows={6} />
      ) : goals.length === 0 ? (
        <EmptyState icon={CalendarDays} title="还没有排期" hint="创建目标后，任务计划会出现在这里。" />
      ) : (
        <>
          {/* 桌面：完整月网格 */}
          <div className="hidden md:block">
            <div className="grid grid-cols-7 border-l border-t text-center text-[11px] font-medium text-muted-foreground">
              {WEEKDAYS.map((w) => (
                <div key={w} className="border-b border-r py-1.5">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 border-l border-t">
              {cells.map((ms, i) => {
                if (ms === null) return <div key={i} className="min-h-24 border-b border-r bg-muted/20" />;
                const key = dayKeyInTz(ms, tz);
                const items = itemsOnDay(key).slice(0, 4);
                const more = itemsOnDay(key).length - 4;
                const load = loadOnDay(key);
                const over = load > dailyCap;
                return (
                  <div key={i} className={cn("min-h-24 border-b border-r p-1.5", key === todayKey && "bg-accent/40")}>
                    <div className="flex items-center justify-between">
                      <span
                        className={cn(
                          "tabular inline-flex size-5 items-center justify-center rounded-full text-[11px]",
                          key === todayKey ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground",
                        )}
                      >
                        {new Date(ms).getDate()}
                      </span>
                      {load > 0 && (
                        <span
                          className={cn("tabular text-[10px]", over ? "font-semibold text-danger" : "text-muted-foreground")}
                          title={`当天计划完成 ${itemsOnDay(key).filter((x) => x.kind === "planned").length} 项任务，预估共 ${Math.round(load / 60)} 小时（上限 ${Math.round(dailyCap / 60)}h/天，可在设置中调整）`}
                        >
                          {over ? "超载 " : ""}
                          {Math.round(load / 60)}h
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 space-y-0.5">
                      {items.map((it) =>
                        it.goalId ? (
                          <Link
                            key={it.key}
                            href={`/goals/${it.goalId}`}
                            title={it.title}
                            className={cn(
                              "flex items-center gap-1 truncate rounded px-1 py-0.5 text-[10px] leading-tight transition-colors duration-150 hover:brightness-95",
                              ITEM_CLS[it.kind],
                              it.done && "opacity-50 line-through",
                            )}
                          >
                            {it.time && <span className="tabular shrink-0 opacity-70">{it.time}</span>}
                            <span className="truncate">{it.title}</span>
                          </Link>
                        ) : (
                          <div
                            key={it.key}
                            title={it.title}
                            className={cn("flex items-center gap-1 truncate rounded px-1 py-0.5 text-[10px] leading-tight", ITEM_CLS[it.kind])}
                          >
                            {it.time && <span className="tabular shrink-0 opacity-70">{it.time}</span>}
                            <span className="truncate">{it.title}</span>
                          </div>
                        ),
                      )}
                      {more > 0 && (
                        <span className="block px-1 text-[10px] text-muted-foreground" aria-label={`还有 ${more} 项`}>
                          还有 {more} 项
                        </span>
                      )}
                    </div>
                    {load > 0 && (
                      <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <div
                          className={cn("h-full rounded-full", over ? "bg-danger" : load / dailyCap > 0.75 ? "bg-warning" : "bg-success")}
                          style={{ width: `${Math.min(100, (load / dailyCap) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 手机：紧凑月（点选日期）+ 当日 agenda */}
          <div className="md:hidden">
            <div className="grid grid-cols-7 border-l border-t text-center text-[10px] font-medium text-muted-foreground">
              {WEEKDAYS.map((w) => (
                <div key={w} className="border-b border-r py-1">
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 border-l border-t">
              {cells.map((ms, i) => {
                if (ms === null) return <div key={i} className="h-11 border-b border-r bg-muted/20" />;
                const key = dayKeyInTz(ms, tz);
                const count = itemsOnDay(key).length;
                const load = loadOnDay(key);
                const over = load > dailyCap;
                return (
                  <button
                    key={i}
                    onClick={() => setSelected(key)}
                    aria-label={`${new Date(ms).getDate()} 日，${count} 项安排`}
                    aria-pressed={selected === key}
                    className={cn(
                      "flex h-11 flex-col items-center justify-center gap-1 border-b border-r p-1 transition-colors duration-150",
                      key === todayKey && "bg-accent/40",
                      selected === key && "ring-1 ring-inset ring-primary",
                    )}
                  >
                    <span
                      className={cn(
                        "tabular text-[11px] leading-none",
                        key === todayKey ? "font-semibold text-primary" : "text-foreground/80",
                      )}
                    >
                      {new Date(ms).getDate()}
                    </span>
                    {count > 0 && (
                      <span className="flex items-center gap-0.5" aria-hidden>
                        <span className={cn("h-1 w-1 rounded-full", over ? "bg-danger" : "bg-primary/70")} />
                        {count > 1 && <span className="tabular text-[8px] leading-none text-muted-foreground">{count}</span>}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <section aria-label="选中日期安排" className="mt-4">
              <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {selected
                  ? new Date(`${selected}T00:00:00`).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })
                  : "选择一天查看安排"}
              </h2>
              {selected && selectedItems.length === 0 ? (
                <p className="px-1 py-3 text-xs text-muted-foreground">这一天没有安排。</p>
              ) : (
                <ul className="space-y-1">
                  {selectedItems.map((it) =>
                    it.goalId ? (
                      <li key={it.key}>
                        <Link
                          href={`/goals/${it.goalId}`}
                          className={cn("flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] transition-colors duration-150", ITEM_CLS[it.kind])}
                        >
                          {it.time && <span className="tabular w-10 shrink-0 text-[11px] opacity-70">{it.time}</span>}
                          <span className={cn("min-w-0 flex-1 truncate", it.done && "line-through opacity-50")}>{it.title}</span>
                        </Link>
                      </li>
                    ) : (
                      <li key={it.key} className={cn("flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px]", ITEM_CLS[it.kind])}>
                        {it.time && <span className="tabular w-10 shrink-0 text-[11px] opacity-70">{it.time}</span>}
                        <span className="min-w-0 flex-1 truncate">{it.title}</span>
                      </li>
                    ),
                  )}
                </ul>
              )}
            </section>
          </div>

          {unscheduled.length > 0 && (
            <section>
              <button
                onClick={() => setShowUnscheduled((v) => !v)}
                aria-expanded={showUnscheduled}
                className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                未排期任务（{unscheduled.length}）{showUnscheduled ? "−" : "＋"}
              </button>
              {showUnscheduled && (
                <ul className="animate-fade mt-2 space-y-1">
                  {unscheduled.map((t) => (
                    <li key={t.id} className="rounded border px-3 py-1.5 text-xs text-muted-foreground">
                      {t.title}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
