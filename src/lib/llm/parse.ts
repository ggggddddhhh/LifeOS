import type { PlannedTask } from "../types";

/** 校验并规范化 LLM 返回的任务列表：坏条目丢弃，重复标题（归一化后）只保留首条 */
export function normalizePlannedTasks(raw: unknown): PlannedTask[] {
  if (!Array.isArray(raw)) return [];
  const out: PlannedTask[] = [];
  const seenTitles = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.title !== "string" || r.title.trim().length === 0) continue;
    const title = r.title.trim().slice(0, 200);
    const normalized = normalizeTitle(title);
    if (seenTitles.has(normalized)) continue;
    seenTitles.add(normalized);
    const estMinutes =
      typeof r.estMinutes === "number" && Number.isFinite(r.estMinutes)
        ? Math.min(600, Math.max(10, Math.round(r.estMinutes)))
        : 60;
    const priorityRaw = Number(r.priority);
    const priority =
      Number.isFinite(priorityRaw) && priorityRaw >= 1 && priorityRaw <= 3
        ? Math.round(priorityRaw)
        : 2;
    // Phase 2 新字段：周期、日期、依赖（全部可选，非法值丢弃）
    const durationDays =
      Number.isFinite(Number(r.durationDays)) && Number(r.durationDays) >= 1
        ? Math.min(365, Math.round(Number(r.durationDays)))
        : undefined;
    const startDate = parseDateStr(r.startDate);
    const dueDate = parseDateStr(r.dueDate);
    const dependsOn =
      Array.isArray(r.dependsOn) && r.dependsOn.length > 0
        ? r.dependsOn.filter((d): d is string => typeof d === "string" && d.trim().length > 0).map((d) => d.trim().slice(0, 200))
        : undefined;
    out.push({
      title,
      ...(typeof r.notes === "string" && r.notes.trim() ? { notes: r.notes.trim().slice(0, 500) } : {}),
      priority,
      estMinutes,
      ...(durationDays ? { durationDays } : {}),
      ...(startDate ? { startDate } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
    });
  }
  return out.slice(0, 20);
}

/** 只接受 YYYY-MM-DD，返回原字符串或 undefined */
export function parseDateStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const d = new Date(`${v.trim()}T00:00:00Z`);
  return isNaN(d.getTime()) ? undefined : v.trim();
}

/** 标题归一化：小写 + 去空白与常见标点，用于判重与 diff 匹配 */
export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[\s，。、,.:：;；!！?？·\-—_/\\()（）\[\]【】"'"']+/g, "");
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
