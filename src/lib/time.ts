/**
 * Phase 7.5：时间语义工具（TS 侧）。
 * 铁律：TS 不做 wall→Instant 转换（唯一实现在 Python times.py）；
 * 这里只有 Instant 的存储/传输与 Intl 显示（互逆性由共享向量锁定）。
 */

/** UTC Instant（ISO Z）→ 指定时区墙钟字符串（YYYY-MM-DDTHH:mm:ss）。 */
export function wallInZone(instantIso: string, timeZone: string): string {
  const d = new Date(instantIso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}:${get("second")}`;
}

/** 用户可读显示（含时区名）。 */
export function formatInZone(instantIso: string, timeZone: string): string {
  return new Date(instantIso).toLocaleString("zh-CN", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Instant 存储往返（Date → ISO Z → Date 不得漂移）。 */
export function instantRoundtrip(instantIso: string): string {
  return new Date(instantIso).toISOString();
}

export const DEFAULT_USER_TZ = process.env.LIFEOS_USER_TZ || "Asia/Shanghai";
