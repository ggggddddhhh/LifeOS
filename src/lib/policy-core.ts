/**
 * Planning Policy 核心（Phase 12）：纯函数、无 IO —— 前后端共享的唯一策略形状。
 *
 * 默认值的唯一来源就在这里（TS）：与 Phase 11 及之前的行为逐字节一致（全周、
 * 08:00–20:00、480m/天、Asia/Shanghai、primary、60m/中优先级），旧用户零迁移成本。
 * Python 不再持有任何规划默认值：所有策略字段经 /v1 请求必传（缺字段 = 契约错误）。
 */

export interface PlanningPolicy {
  dailyCapacityMinutes: number; // 每日可投入分钟数；0 = 明确不排期
  workdays: number[]; // ISO 星期子集（1=一 … 7=日）
  workStartMinute: number; // 墙钟分钟（规划时区）
  workEndMinute: number;
  timezone: string; // IANA
  calendarId: string;
  defaultEstMinutes: number;
  defaultPriority: number;
}

export const DEFAULT_POLICY: PlanningPolicy = {
  dailyCapacityMinutes: 480,
  workdays: [1, 2, 3, 4, 5, 6, 7],
  workStartMinute: 8 * 60,
  workEndMinute: 20 * 60,
  timezone: "Asia/Shanghai",
  calendarId: "primary",
  defaultEstMinutes: 60,
  defaultPriority: 2,
};

export const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"]; // 下标 = ISO-1

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "1,2,3" → [1,2,3]；非法字符/越界/重复 → null */
export function parseWorkdays(raw: string): number[] | null {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const set = new Set<number>();
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1 || n > 7) return null;
    set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/** [今天, deadline] 内符合 workdays 的天数（无 deadline → null 由调用方决定回退）。 */
export function workdaysLeft(deadlineIso: string | null | undefined, workdays: number[], today = new Date()): number {
  if (!deadlineIso) return 0;
  const end = new Date(`${deadlineIso.slice(0, 10)}T00:00:00Z`).getTime();
  const startIso = today.toISOString().slice(0, 10);
  let cur = new Date(`${startIso}T00:00:00Z`).getTime();
  if (end < cur) return 0;
  const ws = new Set(workdays);
  let count = 0;
  while (cur <= end) {
    // getUTCDay: 0=Sun..6=Sat → ISO(1=Mon..7=Sun)
    const iso = ((new Date(cur).getUTCDay() + 6) % 7) + 1;
    if (ws.has(iso)) count++;
    cur += 86400000;
  }
  return count;
}

export interface PolicyValidationInput {
  dailyCapacityMinutes?: unknown;
  workdays?: unknown; // number[] 或 "1,2"
  workStartMinute?: unknown;
  workEndMinute?: unknown;
  timezone?: unknown;
  calendarId?: unknown;
  defaultEstMinutes?: unknown;
  defaultPriority?: unknown;
}

/** 校验并归一化一份部分更新；返回错误字符串（面向用户）或归一化后的字段。 */
export function validatePolicyPatch(
  patch: PolicyValidationInput,
  current: PlanningPolicy,
): { ok: true; policy: PlanningPolicy } | { ok: false; error: string } {
  const next: PlanningPolicy = { ...current };

  if (patch.dailyCapacityMinutes !== undefined) {
    const v = Number(patch.dailyCapacityMinutes);
    if (!Number.isInteger(v) || v < 0 || v > 1440) return err("每日可投入分钟数需在 0–1440 之间");
    next.dailyCapacityMinutes = v;
  }
  if (patch.workdays !== undefined) {
    let days: number[] | null = null;
    if (Array.isArray(patch.workdays)) {
      if (patch.workdays.length === 0) return err("至少选择一个工作日");
      const allValid = patch.workdays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7);
      if (!allValid) return err("工作日取值需在 1–7（周一至周日）");
      days = [...new Set(patch.workdays as number[])].sort((a, b) => a - b);
    } else if (typeof patch.workdays === "string") {
      days = parseWorkdays(patch.workdays);
      if (!days) return err("工作日格式无效");
    } else {
      return err("工作日格式无效");
    }
    next.workdays = days;
  }
  if (patch.workStartMinute !== undefined) {
    const v = Number(patch.workStartMinute);
    if (!Number.isInteger(v) || v < 0 || v > 1440) return err("工作开始时间无效");
    next.workStartMinute = v;
  }
  if (patch.workEndMinute !== undefined) {
    const v = Number(patch.workEndMinute);
    if (!Number.isInteger(v) || v < 0 || v > 1440) return err("工作结束时间无效");
    next.workEndMinute = v;
  }
  if (next.workStartMinute >= next.workEndMinute) {
    return err("工作开始时间必须早于结束时间（暂不支持跨午夜时段）");
  }
  if (patch.timezone !== undefined) {
    if (typeof patch.timezone !== "string" || !isValidTimeZone(patch.timezone.trim())) {
      return err("时区无效（需为 IANA 名称，如 Asia/Shanghai）");
    }
    next.timezone = patch.timezone.trim();
  }
  if (patch.calendarId !== undefined) {
    const v = String(patch.calendarId).trim();
    if (v.length === 0 || v.length > 120) return err("目标日历名称无效");
    next.calendarId = v;
  }
  if (patch.defaultEstMinutes !== undefined) {
    const v = Number(patch.defaultEstMinutes);
    if (!Number.isInteger(v) || v < 5 || v > 1440) return err("默认任务时长需在 5–1440 分钟之间");
    next.defaultEstMinutes = v;
  }
  if (patch.defaultPriority !== undefined) {
    const v = Number(patch.defaultPriority);
    if (![1, 2, 3].includes(v)) return err("默认优先级必须是 1（高）/2（中）/3（低）");
    next.defaultPriority = v;
  }
  return { ok: true, policy: next };
}

/** 策略 → 每日声明容量数组（Python ReplanRequest.declaredMinutesPerDay，长度=daysLeft）：
 *  工作日 = dailyCapacityMinutes，非工作日 = 0。用户策略 = 三层容量语义中的「声明层」。 */
export function declaredMinutesPerDay(daysLeft: number, policy: PlanningPolicy, today = new Date()): number[] {
  const ws = new Set(policy.workdays);
  const out: number[] = [];
  let cur = new Date(`${today.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  for (let i = 0; i < daysLeft; i++) {
    const iso = ((new Date(cur).getUTCDay() + 6) % 7) + 1;
    out.push(ws.has(iso) ? policy.dailyCapacityMinutes : 0);
    cur += 86400000;
  }
  return out;
}

function err(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
