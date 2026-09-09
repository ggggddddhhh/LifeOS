import { describe, expect, it } from "vitest";
import { planGoal, getLlmClient, OpenAiCompatClient } from "@/lib/llm";
import { normalizeTitle } from "@/lib/llm/parse";
import { budgetMinutes, sanitizeDependencies, sanitizeSchedule } from "@/lib/plan";
import { daysUntil, findDuplicates, writeReport, type PlannerRecord } from "./helpers";

const day = 86400000;
function isoIn(days: number) {
  return new Date(Date.now() + days * day).toISOString();
}

// 10 个不同类型的真实用户目标
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

const records: PlannerRecord[] = [];

describe("真实 LLM：Planner 拆解质量（10 个目标）", () => {
  for (const g of GOALS) {
    it(`拆解「${g.title}」`, async () => {
      expect(process.env.LLM_API_KEY, "需要 DEEPSEEK_API_KEY").toBeTruthy();
      const deadline = isoIn(g.deadlineDays);
      const start = Date.now();
      let tasks: Awaited<ReturnType<typeof planGoal>> | null = null;
      let error: string | undefined;
      try {
        tasks = await planGoal({ title: g.title, description: g.description, deadline });
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const latencyMs = Date.now() - start;
      const daysLeft = daysUntil(deadline);

      const rec: PlannerRecord = { goal: g.title, deadline, daysLeft, ok: !!tasks, error, latencyMs };
      if (tasks) {
        const titles = tasks.map((t) => t.title);
        rec.tasks = tasks;
        rec.taskCount = tasks.length;
        rec.duplicateTitles = findDuplicates(titles);
        rec.priorityRangeOk = tasks.every((t) => t.priority >= 1 && t.priority <= 3);
        rec.hasHighPriority = tasks.some((t) => t.priority === 1);
        rec.estRangeOk = tasks.every((t) => t.estMinutes >= 10 && t.estMinutes <= 600);
        const totalMin = tasks.reduce((s, t) => s + budgetMinutes(t), 0);
        rec.minutesPerDay = Math.round(totalMin / daysLeft);
        rec.overload = rec.minutesPerDay > 480; // 日均超过 8 小时视为排期过载

        // Phase 2：日期/依赖/周期检查。
        // rawDatesInRange 衡量 LLM 裸输出合规率；用户实际拿到的结果是路由清洗后的，
        // 因此断言作用在与生产相同的 sanitize 管线之后。
        const today = new Date().toISOString().slice(0, 10);
        const todayMs = new Date(`${today}T00:00:00Z`).getTime();
        const deadlineMs = new Date(`${deadline.slice(0, 10)}T00:00:00Z`).getTime();
        const dated = tasks.filter((t) => t.dueDate);
        rec.datesCoverage = dated.length / tasks.length;
        const rawInRange = dated.every((t) => {
          const s = t.startDate ? new Date(`${t.startDate}T00:00:00Z`).getTime() : null;
          const d = new Date(`${t.dueDate}T00:00:00Z`).getTime();
          return d >= todayMs && d <= deadlineMs && (s === null || s <= d);
        });
        const titleSet = new Set(tasks.map((t) => normalizeTitle(t.title)));
        const rawDepsValid = tasks.every(
          (t) =>
            !t.dependsOn ||
            t.dependsOn.every((d) => normalizeTitle(d) !== normalizeTitle(t.title) && titleSet.has(normalizeTitle(d))),
        );
        rec.periodicCount = tasks.filter((t) => t.durationDays && t.durationDays >= 1).length;

        // 与生产路由相同：清洗后再断言（用户视角）
        const { deps: depsClean } = sanitizeDependencies(tasks);
        sanitizeSchedule(tasks, depsClean, { today, deadline: deadline.slice(0, 10) });
        rec.datesInRange = tasks
          .filter((t) => t.dueDate)
          .every((t) => {
            const s = t.startDate ? new Date(`${t.startDate}T00:00:00Z`).getTime() : null;
            const d = new Date(`${t.dueDate}T00:00:00Z`).getTime();
            return d >= todayMs && d <= deadlineMs && (s === null || s <= d);
          });
        rec.depsValid = rawDepsValid; // 引用有效性不受清洗影响（清洗只丢弃，不新增）
        rec.rawDatesInRange = rawInRange;
        records.push(rec);

        // 结构化断言（与具体内容无关）
        expect(tasks.length, "任务数应在 3-8").toBeGreaterThanOrEqual(3);
        expect(tasks.length).toBeLessThanOrEqual(8);
        expect(rec.duplicateTitles, "不应出现重复任务").toEqual([]);
        expect(rec.priorityRangeOk).toBe(true);
        expect(rec.hasHighPriority, "应至少有一个高优先级").toBe(true);
        expect(rec.estRangeOk).toBe(true);
        // Phase 2 断言
        expect(rec.datesInRange, "日期应在 [今天, 截止日] 且 start ≤ due").toBe(true);
        expect(rec.depsValid, "依赖引用应存在且无自引用").toBe(true);
        expect(rec.datesCoverage ?? 0, "至少 60% 任务带日期").toBeGreaterThanOrEqual(0.6);
        // 习惯型目标（减重/备考/储蓄）必须用周期型任务表达，而非一次性大估时
        if (/减重|雅思|存下|跑步|背单词/.test(g.title)) {
          expect(rec.periodicCount ?? 0, "习惯型目标应包含周期型任务(durationDays)").toBeGreaterThanOrEqual(1);
        }
      } else {
        records.push(rec);
        expect.fail(`Planner 失败: ${error}`);
      }
    });
  }

  it("汇总报告落盘", () => {
    writeReport("planner-results.json", {
      model: process.env.LLM_MODEL,
      ranAt: new Date().toISOString(),
      records,
    });
    const overloads = records.filter((r) => r.overload);
    console.log(
      `planner: ${records.filter((r) => r.ok).length}/${records.length} ok, ` +
        `avg latency ${Math.round(records.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / records.length)}ms, ` +
        `过载目标数 ${overloads.length}`,
    );
    for (const r of records) {
      console.log(
        `  [${r.ok ? "OK" : "FAIL"}] ${r.goal} → ${r.taskCount} 任务, 日均 ${r.minutesPerDay}min, ` +
          `日期覆盖 ${Math.round((r.datesCoverage ?? 0) * 100)}%, 周期型 ${r.periodicCount}, ` +
          `依赖${r.depsValid ? "✓" : "✗"}${r.overload ? " ⚠️过载" : ""}`,
      );
    }
  });
});

describe("LLM 客户端边界", () => {
  it("无 Key 时降级 mock（生产安全网）", async () => {
    const saved = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = "";
    const client = getLlmClient();
    expect(client.constructor.name).toBe("MockLlmClient");
    const tasks = await planGoal({ title: "降级测试" });
    expect(tasks.length).toBeGreaterThan(0);
    process.env.LLM_API_KEY = saved;
  });

  it("端点不可用时抛出明确错误而非静默成功", async () => {
    const bad = new OpenAiCompatClient("http://127.0.0.1:9", "sk-x", "m");
    await expect(bad.complete("s", "u")).rejects.toThrow(/LLM 请求失败/);
  });
});
