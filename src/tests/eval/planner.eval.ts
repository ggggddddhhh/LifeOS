import { describe, expect, it } from "vitest";
import { planGoal, getLlmClient, OpenAiCompatClient } from "@/lib/llm";
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
        const totalMin = tasks.reduce((s, t) => s + t.estMinutes, 0);
        rec.minutesPerDay = Math.round(totalMin / daysLeft);
        rec.overload = rec.minutesPerDay > 480; // 日均超过 8 小时视为排期过载
        records.push(rec);

        // 结构化断言（与具体内容无关）
        expect(tasks.length, "任务数应在 3-8").toBeGreaterThanOrEqual(3);
        expect(tasks.length).toBeLessThanOrEqual(8);
        expect(rec.duplicateTitles, "不应出现重复任务").toEqual([]);
        expect(rec.priorityRangeOk).toBe(true);
        expect(rec.hasHighPriority, "应至少有一个高优先级").toBe(true);
        expect(rec.estRangeOk).toBe(true);
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
      console.log(`  [${r.ok ? "OK" : "FAIL"}] ${r.goal} → ${r.taskCount} 任务, 日均 ${r.minutesPerDay}min${r.overload ? " ⚠️过载" : ""}`);
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
