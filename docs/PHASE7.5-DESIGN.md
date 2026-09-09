# Phase 7.5 设计 — 统一时间与时区语义

## 1. 四类时间模型（内部表示）

| 类型 | 表示 | 用途 | 禁止 |
|---|---|---|---|
| **Instant** | UTC ISO-8601（`...Z`）/ epoch ms | 内部存储、比较、冲突检测、Verify | — |
| **ZonedDateTime** | Instant + IANA tz（如 `Asia/Shanghai`） | Calendar 事件、Draft、空闲窗口计算 | 用"去掉 Z 的字符串"传墙钟 |
| **LocalDate** | `YYYY-MM-DD` + 归属 tz | deadline（无时间成分）、all-day 事件 | 解释为 UTC 00:00 |
| **LocalTime/墙钟** | 仅存在于转换边界 | 工作窗口 [08:00,20:00]、显示 | 跨进程传输 |

**关键架构决策：wall↔Instant 转换只发生在 Python**（ICS 解析、Draft Builder、executor 写出）。TS 侧只持有 Instant（存储/传输/比较）与 Intl 格式化（显示）。跨语言的时区算法不可能漂移，因为只有一份实现。

## 2. Canonical 转换规则（ambiguous / nonexistent 不静默）

- **ambiguous**（秋季回拨，如 America/New_York 2027-11-07 01:30 出现两次）：取 **fold=0（较早的 Instant）**，事件/草稿标记 `ambiguous=true`（可观测，绝不静默二选一）。
- **nonexistent**（春季跳变，如 2027-03-14 02:30 不存在）：**前移到间隔结束**（02:30 → 03:30，按 gap 长度），标记 `nonexistent=true` 并记录原始墙钟。
- 两条规则在 `agent/app/times.py` 单点实现，配套共享向量锁定。

## 3. ICS 解析（TZID）

- `DTSTART:...Z` → UTC Instant 直接采用
- `DTSTART;TZID=Asia/Shanghai:20260910T090000` → 按 TZID 墙钟 → Instant（走 canonical 规则）
- `DTSTART;VALUE=DATE:20260910` → **LocalDate 语义**（all-day）：不转 Instant；空闲窗口按"该日期整天阻塞（规划时区日历日）"处理
- 浮动时间（无 TZID 无 Z）→ 按请求的规划时区解释，标记 `implicit_tz=true`
- LifeOS 写出事件：`DTSTART/DTEND` 用 **UTC Z 格式**（自建事件零歧义回读）

## 4. API 契约变更

CalendarEvent / CalendarDraftItem 统一为：
```
{ startUtc, endUtc, timezone, allDay?, localDate?, source, ... }
```
- drafts/execute 请求新增 `timezone`（IANA，来自 `LIFEOS_USER_TZ`，默认 `Asia/Shanghai`）
- Draft Builder 在规划时区墙钟空间计算 [08:00,20:00] 窗口（忙碌事件 Instant → 规划时区墙钟后做区间减法），落位后墙钟 → Instant（canonical 规则）
- Executor 冲突/Verify 全部 **Instant 比较**（当前是 naive 字符串比较，本阶段废除）
- Prisma DateTime 存 Instant（`new Date(startUtc)`）；`CalendarDraft/CalendarWrite` 新增 `timezone` 列

## 5. 服务器时区独立性

- Python：`date.today()`/`datetime.now()` 全部替换为规划时区参数化版本（`times.today_in(tz)`）
- TS：删除 `localWallClock`；任何 Date→字符串仅 `toISOString()`（UTC）或 Intl（显示）
- 验证：代码审计（grep 服务器本地时间 API）+ 向量在非本机时区用例上通过 + e2e 用户时区 ≠ 机器时区

## 6. 数据迁移（存量无 timezone 数据）

存量 `CalendarDraft/CalendarWrite.proposedStart/End` 是 Phase 7 的"服务器本地墙钟 → Prisma DateTime（Instant）"结果——**存储值本身是合法 Instant，无需重解释**。迁移 = `timezone` 列回填 `LIFEOS_LEGACY_TZ`（默认 `Asia/Shanghai`，即可用 `LIFEOS_USER_TZ` 覆盖前的开发环境时区），标记来源；**绝不把无 tz 的墙钟字符串错误解释为 UTC**（旧 naive 字符串已不存在于库中，均在写入时转为 DateTime）。

## 7. 共享时间向量

`docs/timezone-vectors.json`（specVersion=1）：Tokyo 用户/LA 服务器、+8 与 +9 混合日历、DST 开始/结束日、跨午夜、跨时区会议、all-day、deadline 日期、ambiguous 01:30、nonexistent 02:30、draft→verify Instant 相等。pytest（zoneinfo 实现）与 vitest（Intl 显示/存储 roundtrip）各消费自己的断言面（Python=转换与 Instant；TS=Instant 存储与格式化互逆），期望值在向量中预先固化。

## 8. 不回退项

confirmation gate / idempotency（UID+DB key）/ stale check（Instant 比较）/ verify / TS defense-in-depth（共享 constraints-vectors 继续双消费）全部保持，回归验证。

## 9. Google Calendar 就绪判据

Instant + IANA tz + LocalDate 语义 + all-day 日期语义齐备 = Google Calendar API（`dateTime`+`timeZone` / `date`）可直接映射；接真 provider 前仅需 provider 适配层。
