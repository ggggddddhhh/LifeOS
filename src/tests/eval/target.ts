/**
 * M3 评测目标分发器：按 LLM_EVAL_TARGET 把评测调用发往 local TS 路径或 Python Agent。
 * 两条路径使用相同模型 / temperature / prompt version / 输入数据；
 * Python 响应再过一次 TS normalize（与 local 输出同阶段，保证可比）。
 */
import { planGoal, replanGoal } from "@/lib/llm";
import { normalizePlannedTasks } from "@/lib/llm/parse";
import type { PlanGoalInput, PlannedTask, ReplanInput, ReplanResult } from "@/lib/types";

export type EvalTarget = "local" | "python";

export interface EvalCallMeta {
  latencyMs: number;
  llmCalls?: number; // python 路径：实际 LLM 调用次数（2 = 发生过重试）
}

export function getEvalTarget(): EvalTarget {
  return process.env.LLM_EVAL_TARGET === "python" ? "python" : "local";
}

function agentUrl(): string {
  return (process.env.LLM_EVAL_AGENT_URL ?? "http://127.0.0.1:8901").replace(/\/$/, "");
}

async function post(path: string, body: unknown): Promise<{ data: unknown; llmCalls: number; promptVersion: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${agentUrl()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`python ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return {
      data: await res.json(),
      llmCalls: Number(res.headers.get("x-llm-calls") ?? 0),
      promptVersion: res.headers.get("x-prompt-version") ?? "",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function evalPlanGoal(input: PlanGoalInput): Promise<{ tasks: PlannedTask[]; meta: EvalCallMeta }> {
  const start = Date.now();
  if (getEvalTarget() === "local") {
    return { tasks: await planGoal(input), meta: { latencyMs: Date.now() - start } };
  }
  const { data, llmCalls, promptVersion } = await post("/v1/plan", input);
  if (promptVersion !== "2") throw new Error(`prompt 版本不一致: ${promptVersion || "无"}`);
  const tasks = normalizePlannedTasks((data as { tasks?: unknown }).tasks);
  return { tasks, meta: { latencyMs: Date.now() - start, llmCalls } };
}

export async function evalReplanGoal(input: ReplanInput): Promise<{ result: ReplanResult; meta: EvalCallMeta }> {
  const start = Date.now();
  if (getEvalTarget() === "local") {
    return { result: await replanGoal(input), meta: { latencyMs: Date.now() - start } };
  }
  const { data, llmCalls, promptVersion } = await post("/v1/replan", input);
  if (promptVersion !== "2") throw new Error(`prompt 版本不一致: ${promptVersion || "无"}`);
  const r = data as { reason?: unknown; tasks?: unknown };
  if (typeof r.reason !== "string" || !r.reason.trim()) throw new Error("python 响应缺少 reason");
  const result: ReplanResult = { reason: r.reason.trim(), tasks: normalizePlannedTasks(r.tasks) };
  return { result, meta: { latencyMs: Date.now() - start, llmCalls } };
}
