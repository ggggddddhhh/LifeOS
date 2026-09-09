import type { PlannedTask } from "../types";

/** 校验并规范化 LLM 返回的任务列表，坏条目直接丢弃 */
export function normalizePlannedTasks(raw: unknown): PlannedTask[] {
  if (!Array.isArray(raw)) return [];
  const out: PlannedTask[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.title !== "string" || r.title.trim().length === 0) continue;
    const estMinutes =
      typeof r.estMinutes === "number" && Number.isFinite(r.estMinutes)
        ? Math.min(600, Math.max(10, Math.round(r.estMinutes)))
        : 60;
    const priorityRaw = Number(r.priority);
    const priority =
      Number.isFinite(priorityRaw) && priorityRaw >= 1 && priorityRaw <= 3
        ? Math.round(priorityRaw)
        : 2;
    out.push({
      title: r.title.trim().slice(0, 200),
      ...(typeof r.notes === "string" && r.notes.trim()
        ? { notes: r.notes.trim().slice(0, 500) }
        : {}),
      priority,
      estMinutes,
    });
  }
  return out.slice(0, 20);
}

/** 从 LLM 文本输出中提取 JSON 数组/对象（兼容 ```json 包裹） */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("LLM 输出中未找到 JSON");
  const substr = candidate.slice(start);
  // 从最后一个完整的 JSON 结束符回退解析
  for (let end = substr.length; end > 0; end--) {
    const ch = substr[end - 1];
    if (ch === "]" || ch === "}") {
      try {
        return JSON.parse(substr.slice(0, end));
      } catch {
        /* 继续回退 */
      }
    }
  }
  throw new Error("无法解析 LLM 输出的 JSON");
}
