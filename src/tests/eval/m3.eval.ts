/**
 * M3 双路径评测（LLM_EVAL_TARGET=local|python 驱动；未设置时自动 skip，
 * 不会混入常规 test:eval）。
 *
 * 固定输入：10 个 Planner 目标 + 9 个 Replan 场景（3 目标 × 正常/延期/部分完成），
 * 每场景 LLM_EVAL_ROUNDS 轮（默认 3），量化 LLM 非确定性。
 * 指标定义与采集见 docs/eval/EVAL-PHASE-3-M3.md。
 */
import { describe, expect, it } from "vitest";
import { normalizeTitle } from "@/lib/llm/parse";
import { budgetMinutes, computePlanDiff, sanitizeDependencies, sanitizeSchedule } from "@/lib/plan";
import type { PlannedTask, TaskSnapshot } from "@/lib/types";
import { writeReport } from "./helpers";
import { evalPlanGoal, evalReplanGoal, getEvalTarget } from "./target";

const ROUNDS = Math.max(1, Number(process.env.LLM_EVAL_ROUNDS ?? 3));
const DAY = 86400000;
const isoIn = (d: number) => new Date(Date.now() + d * DAY).toISOString();
const dateIn = (d: number) => isoIn(d).slice(0, 10);

const GOALS: { title: string; description?: string; deadlineDays: number }[] = [
  { title: "30 天内学会 Rust 基础并写出一个 CLI 待办事项工具", deadlineDays: 30 },
  { title: "三个月内减重 8 公斤", description: "目前 78 公斤，久坐办公，每周可运动 4 次", deadlineDays: 90 },
  { title: "两周内上线个人博客网站", description: "已有域名，希望用 Next.js + Vercel 部署", deadlineDays: 14 },
  { title: "准备数据分析师岗位面试并拿到 offer", deadlineDays: 45 },
  { title: "一年内存下 5 万元", description: "月收入 1.5 万，目前几乎无储蓄", deadlineDays: 365 },
  { title: "一个月内完成一部 3 万字中篇小说初稿", deadlineDays: 30 },
  { title: "两周内完成跨城搬家并安顿好新家", deadlineDays: 14 },
  { title: "为团队 10 人项目的 GitHub 仓库搭建 CI/CD 流水线", deadlineDays: 21 },
  { title: "100 天内雅思总分考到 6.5", description: "上次模考 5.5，口语和写作较弱", deadlineDays: 100 },
  { title: "一个月后组织一场 50 人参加的公司内部技术分享会", deadlineDays: 30 },
];

type Fix = { title: string; status: string; estMinutes: number; priority: number; dueDate?: string };
const REPLAN_FIXTURES: { goalTitle: string; goalDescription?: string; scenario: string; daysLeft: number; tasks: Fix[] }[] = [
  {
    goalTitle: "两周内上线个人博客网站",
    goalDescription: "已有域名，希望用 Next.js + Vercel 部署",
    scenario: "正常进度", daysLeft: 8,
    tasks: [
      { title: "规划博客内容与设计风格", status: "done", estMinutes: 120, priority: 1 },
      { title: "搭建 Next.js 项目框架", status: "done", estMinutes: 90, priority: 1 },
      { title: "实现核心页面与组件", status: "done", estMinutes: 300, priority: 1 },
      { title: "集成 Markdown 内容管理", status: "in_progress", estMinutes: 180, priority: 2, dueDate: dateIn(3) },
      { title: "SEO 与性能优化", status: "todo", estMinutes: 120, priority: 2, dueDate: dateIn(5) },
      { title: "配置域名与 Vercel 部署", status: "todo", estMinutes: 90, priority: 1, dueDate: dateIn(8) },
      { title: "测试与内容填充", status: "todo", estMinutes: 180, priority: 2, dueDate: dateIn(10) },
      { title: "上线前最终检查", status: "todo", estMinutes: 60, priority: 3, dueDate: dateIn(12) },
    ],
  },
  {
    goalTitle: "两周内上线个人博客网站",
    goalDescription: "已有域名，希望用 Next.js + Vercel 部署",
    scenario: "延期", daysLeft: 2,
    tasks: [
      { title: "规划博客内容与设计风格", status: "done", estMinutes: 120, priority: 1 },
      { title: "实现核心页面与组件", status: "in_progress", estMinutes: 300, priority: 1, dueDate: dateIn(1) },
      { title: "集成 Markdown 内容管理", status: "todo", estMinutes: 180, priority: 2 },
      { title: "SEO 与性能优化", status: "todo", estMinutes: 120, priority: 2 },
      { title: "配置域名与 Vercel 部署", status: "todo", estMinutes: 90, priority: 1 },
      { title: "测试与内容填充", status: "todo", estMinutes: 180, priority: 2 },
      { title: "上线前最终检查", status: "todo", estMinutes: 60, priority: 3 },
    ],
  },
  {
    goalTitle: "两周内上线个人博客网站",
    goalDescription: "已有域名，希望用 Next.js + Vercel 部署",
    scenario: "部分完成", daysLeft: 4,
    tasks: [
      { title: "规划博客内容与设计风格", status: "done", estMinutes: 120, priority: 1 },
      { title: "搭建 Next.js 项目框架", status: "done", estMinutes: 90, priority: 1 },
      { title: "实现核心页面与组件", status: "done", estMinutes: 300, priority: 1 },
      { title: "集成 Markdown 内容管理", status: "done", estMinutes: 180, priority: 2 },
      { title: "SEO 与性能优化", status: "done", estMinutes: 120, priority: 2 },
      { title: "配置域名与 Vercel 部署", status: "todo", estMinutes: 90, priority: 1 },
      { title: "测试与内容填充", status: "todo", estMinutes: 180, priority: 2 },
      { title: "上线前最终检查", status: "todo", estMinutes: 60, priority: 3 },
    ],
  },
  {
    goalTitle: "100 天内雅思总分考到 6.5",
    goalDescription: "上次模考 5.5，口语和写作较弱",
    scenario: "正常进度", daysLeft: 15,
    tasks: [
      { title: "基础词汇与语法强化", status: "done", estMinutes: 600, priority: 1 },
      { title: "听力专项训练", status: "todo", estMinutes: 600, priority: 2, dueDate: dateIn(10) },
      { title: "阅读提速与技巧训练", status: "todo", estMinutes: 600, priority: 2, dueDate: dateIn(10) },
      { title: "口语强化训练", status: "in_progress", estMinutes: 600, priority: 1, dueDate: dateIn(12) },
      { title: "写作系统提升", status: "todo", estMinutes: 600, priority: 1, dueDate: dateIn(12) },
      { title: "全真模考与复盘", status: "todo", estMinutes: 300, priority: 1, dueDate: dateIn(14) },
      { title: "错题复盘与弱项补漏", status: "todo", estMinutes: 120, priority: 3, dueDate: dateIn(15) },
    ],
  },
  {
    goalTitle: "100 天内雅思总分考到 6.5",
    goalDescription: "上次模考 5.5，口语和写作较弱",
    scenario: "延期", daysLeft: 2,
    tasks: [
      { title: "听力专项训练", status: "todo", estMinutes: 600, priority: 2 },
      { title: "阅读提速与技巧训练", status: "todo", estMinutes: 600, priority: 2 },
      { title: "口语强化训练", status: "in_progress", estMinutes: 600, priority: 1, dueDate: dateIn(1) },
      { title: "写作系统提升", status: "todo", estMinutes: 600, priority: 1 },
      { title: "全真模考与复盘", status: "todo", estMinutes: 300, priority: 1 },
      { title: "错题复盘与弱项补漏", status: "todo", estMinutes: 120, priority: 3 },
    ],
  },
  {
    goalTitle: "100 天内雅思总分考到 6.5",
    goalDescription: "上次模考 5.5，口语和写作较弱",
    scenario: "部分完成", daysLeft: 8,
    tasks: [
      { title: "基础词汇与语法强化", status: "done", estMinutes: 600, priority: 1 },
      { title: "听力专项训练", status: "done", estMinutes: 600, priority: 2 },
      { title: "阅读提速与技巧训练", status: "done", estMinutes: 600, priority: 2 },
      { title: "口语强化训练", status: "in_progress", estMinutes: 600, priority: 1, dueDate: dateIn(6) },
      { title: "写作系统提升", status: "todo", estMinutes: 600, priority: 1, dueDate: dateIn(6) },
      { title: "全真模考与复盘", status: "todo", estMinutes: 300, priority: 1, dueDate: dateIn(7) },
    ],
  },
  {
    goalTitle: "两周内完成跨城搬家并安顿好新家",
    scenario: "正常进度", daysLeft: 8,
    tasks: [
      { title: "制定搬家计划与预算", status: "done", estMinutes: 120, priority: 1 },
      { title: "处理旧居退租与押金回收", status: "in_progress", estMinutes: 180, priority: 1, dueDate: dateIn(2) },
      { title: "整理打包物品", status: "todo", estMinutes: 480, priority: 1, dueDate: dateIn(4) },
      { title: "预约并协调搬家公司", status: "todo", estMinutes: 90, priority: 2, dueDate: dateIn(4) },
      { title: "办理地址变更与生活服务迁移", status: "todo", estMinutes: 150, priority: 2, dueDate: dateIn(6) },
      { title: "新家清洁与基础布置", status: "todo", estMinutes: 240, priority: 2, dueDate: dateIn(7) },
      { title: "安顿新家并适应环境", status: "todo", estMinutes: 360, priority: 3, dueDate: dateIn(8) },
    ],
  },
  {
    goalTitle: "两周内完成跨城搬家并安顿好新家",
    scenario: "延期", daysLeft: 2,
    tasks: [
      { title: "处理旧居退租与押金回收", status: "in_progress", estMinutes: 180, priority: 1, dueDate: dateIn(1) },
      { title: "整理打包物品", status: "todo", estMinutes: 480, priority: 1 },
      { title: "预约并协调搬家公司", status: "todo", estMinutes: 90, priority: 2 },
      { title: "办理地址变更与生活服务迁移", status: "todo", estMinutes: 150, priority: 2 },
      { title: "新家清洁与基础布置", status: "todo", estMinutes: 240, priority: 2 },
      { title: "安顿新家并适应环境", status: "todo", estMinutes: 360, priority: 3 },
    ],
  },
  {
    goalTitle: "两周内完成跨城搬家并安顿好新家",
    scenario: "部分完成", daysLeft: 5,
    tasks: [
      { title: "制定搬家计划与预算", status: "done", estMinutes: 120, priority: 1 },
      { title: "处理旧居退租与押金回收", status: "done", estMinutes: 180, priority: 1 },
      { title: "整理打包物品", status: "done", estMinutes: 480, priority: 1 },
      { title: "预约并协调搬家公司", status: "done", estMinutes: 90, priority: 2 },
      { title: "办理地址变更与生活服务迁移", status: "todo", estMinutes: 150, priority: 2, dueDate: dateIn(3) },
      { title: "新家清洁与基础布置", status: "todo", estMinutes: 240, priority: 2, dueDate: dateIn(4) },
      { title: "安顿新家并适应环境", status: "todo", estMinutes: 360, priority: 3, dueDate: dateIn(5) },
    ],
  },
];

// ---------------------------------------------------------------- 指标计算（与生产/既有评测同源算法）

function plannerMetrics(tasks: PlannedTask[], daysLeft: number, deadline: string) {
  const titles = tasks.map((t) => t.title);
  const seen = new Set<string>();
  let dupCount = 0;
  for (const t of titles) {
    const k = normalizeTitle(t);
    if (seen.has(k)) dupCount++;
    seen.add(k);
  }
  const today = new Date().toISOString().slice(0, 10);
  const todayMs = new Date(`${today}T00:00:00Z`).getTime();
  const deadlineMs = new Date(`${deadline.slice(0, 10)}T00:00:00Z`).getTime();
  const dated = tasks.filter((t) => t.dueDate);
  const rawOutOfRange = dated.filter((t) => {
    const s = t.startDate ? new Date(`${t.startDate}T00:00:00Z`).getTime() : null;
    const d = new Date(`${t.dueDate}T00:00:00Z`).getTime();
    return !(d >= todayMs && d <= deadlineMs && (s === null || s <= d));
  }).length;
  const titleSet = new Set(titles.map(normalizeTitle));
  const depsInvalid = tasks.filter(
    (t) => t.dependsOn && !t.dependsOn.every((d) => normalizeTitle(d) !== normalizeTitle(t.title) && titleSet.has(normalizeTitle(d))),
  ).length;
  const totalMin = tasks.reduce((s, t) => s + budgetMinutes(t), 0);
  const minutesPerDay = Math.round(totalMin / daysLeft);
  // 清洗后（与生产路由同管线）
  const sanitized = structuredClone(tasks);
  const { deps } = sanitizeDependencies(sanitized);
  sanitizeSchedule(sanitized, deps, { today, deadline: deadline.slice(0, 10) });
  const sanitizedOutOfRange = sanitized
    .filter((t) => t.dueDate)
    .filter((t) => {
      const s = t.startDate ? new Date(`${t.startDate}T00:00:00Z`).getTime() : null;
      const d = new Date(`${t.dueDate}T00:00:00Z`).getTime();
      return !(d >= todayMs && d <= deadlineMs && (s === null || s <= d));
    }).length;
  return {
    taskCount: tasks.length,
    dupCount,
    rawOutOfRange,
    sanitizedOutOfRange,
    depsInvalid,
    overload: minutesPerDay > 480,
    minutesPerDay,
    periodicCount: tasks.filter((t) => t.durationDays && t.durationDays >= 1).length,
    minimal: tasks.length <= 2,
  };
}

function replanMetrics(result: { reason: string; tasks: PlannedTask[] }, open: Fix[], daysLeft: number, doneTitles: string[]) {
  const titles = result.tasks.map((t) => t.title);
  const diff = computePlanDiff(
    open.map((t) => ({ title: t.title, estMinutes: t.estMinutes, dueDate: t.dueDate ?? null })),
    result.tasks,
  );
  const totalMin = result.tasks.reduce((s, t) => s + t.estMinutes, 0);
  return {
    taskCount: result.tasks.length,
    openCount: open.length,
    expansion: +(result.tasks.length / Math.max(1, open.length)).toFixed(2),
    added: diff.summary.added,
    removed: diff.summary.removed,
    kept: diff.summary.kept,
    estDelta: diff.summary.estDelta,
    overload: Math.round(totalMin / daysLeft) > 480,
    minutesPerDay: Math.round(totalMin / daysLeft),
    doneLeak: titles.filter((t) =>
      doneTitles.some((d) => normalizeTitle(d) === normalizeTitle(t)),
    ).length,
    reasonOk: result.reason.trim().length >= 10,
    minimal: result.tasks.length <= 2,
  };
}

// ---------------------------------------------------------------- 运行

interface PlannerRow extends ReturnType<typeof plannerMetrics> {
  goal: string; round: number; ok: boolean; error?: string; latencyMs: number; llmCalls?: number;
}
interface ReplanRow extends ReturnType<typeof replanMetrics> {
  goalTitle: string; scenario: string; round: number; ok: boolean; error?: string; latencyMs: number; llmCalls?: number;
}

const skip = process.env.LLM_EVAL_TARGET === undefined;

describe.skipIf(skip)(`M3 双路径评测（target=${getEvalTarget()}, rounds=${ROUNDS}）`, () => {
  const plannerRows: PlannerRow[] = [];
  const replanRows: ReplanRow[] = [];

  it("Planner：10 目标 × N 轮", async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      for (const g of GOALS) {
        const deadline = isoIn(g.deadlineDays);
        let row: PlannerRow;
        try {
          const { tasks, meta } = await evalPlanGoal({ title: g.title, description: g.description, deadline });
          row = { goal: g.title, round, ok: true, latencyMs: meta.latencyMs, llmCalls: meta.llmCalls, ...plannerMetrics(tasks, g.deadlineDays, deadline) };
        } catch (e) {
          row = { goal: g.title, round, ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: 0 } as PlannerRow;
        }
        plannerRows.push(row);
        console.log(`  [P${round}] ${row.ok ? "OK " : "ERR"} ${g.title.slice(0, 14)} → ${row.taskCount ?? "?"} 任务 ${row.latencyMs}ms`);
      }
    }
    const failRate = plannerRows.filter((r) => !r.ok).length / plannerRows.length;
    expect(failRate, `Planner 失败率 ${failRate * 100}%（基础设施异常）`).toBeLessThan(0.3);
  }, 6_000_000);

  it("Replanner：9 场景 × N 轮", async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      for (const fx of REPLAN_FIXTURES) {
        const open = fx.tasks.filter((t) => t.status !== "done");
        const doneTitles = fx.tasks.filter((t) => t.status === "done").map((t) => t.title);
        const snapshots: TaskSnapshot[] = fx.tasks.map((t) => ({
          title: t.title, status: t.status as TaskSnapshot["status"], estMinutes: t.estMinutes, priority: t.priority, dueDate: t.dueDate ?? null,
        }));
        let row: ReplanRow;
        try {
          const { result, meta } = await evalReplanGoal({
            goalTitle: fx.goalTitle, goalDescription: fx.goalDescription, deadline: isoIn(fx.daysLeft), daysLeft: fx.daysLeft, tasks: snapshots,
          });
          row = { goalTitle: fx.goalTitle, scenario: fx.scenario, round, ok: true, latencyMs: meta.latencyMs, llmCalls: meta.llmCalls, ...replanMetrics(result, open, fx.daysLeft, doneTitles) };
        } catch (e) {
          row = { goalTitle: fx.goalTitle, scenario: fx.scenario, round, ok: false, error: e instanceof Error ? e.message : String(e), latencyMs: 0 } as ReplanRow;
        }
        replanRows.push(row);
        console.log(`  [R${round}] ${row.ok ? "OK " : "ERR"} ${fx.scenario}·${fx.goalTitle.slice(0, 10)} → ${row.taskCount ?? "?"}/${row.openCount ?? "?"} ${row.latencyMs}ms`);
      }
    }
    const failRate = replanRows.filter((r) => !r.ok).length / replanRows.length;
    expect(failRate, `Replanner 失败率 ${failRate * 100}%（基础设施异常）`).toBeLessThan(0.3);
  }, 6_000_000);

  it("落盘原始数据", () => {
    writeReport(`m3-${getEvalTarget()}-results.json`, {
      target: getEvalTarget(),
      model: process.env.LLM_MODEL || "deepseek-chat",
      temperature: 0.3,
      promptVersion: "2",
      rounds: ROUNDS,
      ranAt: new Date().toISOString(),
      planner: plannerRows,
      replan: replanRows,
    });
  });
});
