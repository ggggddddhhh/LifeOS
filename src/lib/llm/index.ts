import type { PlanGoalInput, PlannedTask, ReplanInput, ReplanResult } from "../types";
import { extractJson, normalizePlannedTasks } from "./parse";

export interface LlmClient {
  complete(system: string, user: string): Promise<string>;
}

/**
 * 本地确定性 mock：无 LLM_API_KEY 时降级使用，保证闭环可运行。
 * 规则简单但稳定：按剩余天数均摊，生成 调研/执行/整合 三段任务。
 */
export class MockLlmClient implements LlmClient {
  async complete(_system: string, user: string): Promise<string> {
    if (_system.includes("REPLANNER")) return mockReplanText(user);
    return mockPlanText(user);
  }
}

function daysFromIso(iso?: string): number {
  if (!iso) return 14;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(1, Math.round(ms / 86400000));
}

function mockPlanText(user: string): string {
  const input = JSON.parse(user) as PlanGoalInput;
  const days = daysFromIso(input.deadline);
  return JSON.stringify({
    tasks: [
      { title: `调研：明确「${input.title}」的范围与关键产出`, priority: 1, estMinutes: 60 },
      { title: `拆解「${input.title}」为可执行步骤并确定优先级`, priority: 1, estMinutes: 90 },
      { title: `执行核心工作（建议 ${Math.max(2, Math.floor(days / 3))} 天内完成主体）`, priority: 1, estMinutes: Math.min(600, days * 60) },
      { title: "整合产出并自查质量", priority: 2, estMinutes: 60 },
      { title: "复盘与收尾", priority: 3, estMinutes: 30 },
    ],
  });
}

function mockReplanText(user: string): string {
  const input = JSON.parse(user) as ReplanInput;
  const open = input.tasks.filter((t) => t.status !== "done");
  const perDay = Math.max(30, Math.round(open.reduce((s, t) => s + t.estMinutes, 0) / Math.max(1, input.daysLeft)));
  return JSON.stringify({
    reason: `剩余 ${input.daysLeft} 天，未完成任务 ${open.length} 项，已按每日约 ${perDay} 分钟重新排期并压缩估时。`,
    tasks: open.map((t) => ({
      title: t.title,
      priority: t.priority,
      estMinutes: Math.max(15, Math.min(t.estMinutes, perDay)),
    })),
  });
}

/** OpenAI 兼容 Chat Completions 客户端 */
export class OpenAiCompatClient implements LlmClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
  ) {}

  async complete(system: string, user: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.3,
        }),
      });
    } catch (e) {
      // 网络层错误（DNS/断网/超时）统一包装，避免用户看到裸的 "fetch failed"
      throw new Error(`LLM 请求失败（网络错误）: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new Error(`LLM 请求失败: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM 返回为空");
    return content;
  }
}

export function getLlmClient(): LlmClient {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
  if (LLM_API_KEY && LLM_BASE_URL && LLM_MODEL) {
    return new OpenAiCompatClient(LLM_BASE_URL, LLM_API_KEY, LLM_MODEL);
  }
  return new MockLlmClient();
}

const PLANNER_SYSTEM = `你是项目管理专家。把用户目标拆解为 3-8 个可执行任务，输出严格的 JSON：
{"tasks":[{"title":"...","notes":"可选说明","priority":1,"estMinutes":60}]}
priority 取 1(高)/2(中)/3(低)，estMinutes 为预计分钟数(10-600)。只输出 JSON，不要任何其他文字。`;

const REPLANNER_SYSTEM = `REPLANNER. 你是项目复盘专家。根据目标、剩余天数和任务完成情况，为所有未完成任务生成新计划。硬性约束：新计划所有任务的 estMinutes 总和不得超过 剩余天数×480 分钟（每天最多按 8 小时有效工作时间排）；放不下时必须合并任务或砍掉低优先级任务，并在 reason 中说明放弃了什么。输出严格的 JSON：
{"reason":"一句话说明调整逻辑","tasks":[{"title":"...","priority":1,"estMinutes":60}]}
priority 取 1(高)/2(中)/3(低)。只输出 JSON，不要任何其他文字。`;

export async function planGoal(input: PlanGoalInput): Promise<PlannedTask[]> {
  const client = getLlmClient();
  const text = await client.complete(PLANNER_SYSTEM, JSON.stringify(input));
  const parsed = extractJson(text) as { tasks?: unknown };
  const tasks = normalizePlannedTasks(parsed?.tasks ?? parsed);
  if (tasks.length === 0) throw new Error("AI 未能生成有效任务");
  return tasks;
}

export async function replanGoal(input: ReplanInput): Promise<ReplanResult> {
  const client = getLlmClient();
  const text = await client.complete(REPLANNER_SYSTEM, JSON.stringify(input));
  const parsed = extractJson(text) as { reason?: unknown; tasks?: unknown };
  const tasks = normalizePlannedTasks(parsed?.tasks);
  if (tasks.length === 0) throw new Error("AI 未能生成有效的重新计划");
  return {
    reason: typeof parsed.reason === "string" ? parsed.reason : "根据剩余时间重新排期",
    tasks,
  };
}
