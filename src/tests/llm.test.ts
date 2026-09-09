import { describe, expect, it } from "vitest";
import { MockLlmClient, planGoal, replanGoal } from "@/lib/llm";
import type { ReplanInput } from "@/lib/types";

describe("MockLlmClient", () => {
  it("planner 输出可被解析且任务有效", async () => {
    const tasks = await planGoal({ title: "学 Rust", deadline: new Date(Date.now() + 7 * 86400000).toISOString() });
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    for (const t of tasks) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.priority).toBeGreaterThanOrEqual(1);
      expect(t.priority).toBeLessThanOrEqual(3);
      expect(t.estMinutes).toBeGreaterThanOrEqual(10);
    }
  });

  it("replanner 保留未完成任务、剔除已完成", async () => {
    const input: ReplanInput = {
      goalTitle: "上线网站",
      daysLeft: 3,
      tasks: [
        { title: "买域名", status: "done", estMinutes: 30, priority: 1 },
        { title: "写首页", status: "in_progress", estMinutes: 300, priority: 1 },
        { title: "部署", status: "todo", estMinutes: 120, priority: 2 },
      ],
    };
    const result = await replanGoal(input);
    expect(result.reason).toContain("3");
    const titles = result.tasks.map((t) => t.title);
    expect(titles).toContain("写首页");
    expect(titles).toContain("部署");
    expect(titles).not.toContain("买域名");
    // 估时被压缩到每日可承受范围内
    for (const t of result.tasks) {
      expect(t.estMinutes).toBeLessThanOrEqual(300);
    }
  });

  it("mock 输出确定性（同输入同结果）", async () => {
    const c = new MockLlmClient();
    const a = await c.complete("sys", JSON.stringify({ title: "x" }));
    const b = await c.complete("sys", JSON.stringify({ title: "x" }));
    expect(a).toBe(b);
  });
});
