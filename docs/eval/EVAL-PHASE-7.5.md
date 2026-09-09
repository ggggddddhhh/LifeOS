# Phase 7.5 验证报告 — 统一时间与时区语义

- 日期：2026-09-09 · 设计：[PHASE7.5-DESIGN.md](../PHASE7.5-DESIGN.md)
- 回归：pytest 112/112、npm test 81/81、build、Phase 5.5（expectMet 10/10、D 容量 10/10）、constraints-vectors（双套件内含）
- 共享时间向量：[timezone-vectors.json](../timezone-vectors.json)（specVersion=1，7 用例，双语言消费）

## 1. 模型落地

| 类型 | 实现 | 验证 |
|---|---|---|
| Instant | 全链路 UTC ISO-Z（API 契约 `startUtc/endUtc`、Prisma DateTime、冲突/Verify 比较） | e2e 回读 Instant 完全相等 |
| ZonedDateTime | Instant + IANA（事件 `timezone`、规划时区 `timezone`/`LIFEOS_USER_TZ`） | TZID 解析测试 + e2e |
| LocalDate | deadline（date-only 原样传递）、all-day（`local_date`，**不用 00:00 模拟**，startUtc 为空串） | pytest |
| 墙钟 | 仅存在于 Python `times.py` 转换边界与 Intl 显示 | 架构决策：**TS 零 wall→Instant 转换**，跨语言漂移在结构上不可能 |

**Canonical 规则（不静默）**：ambiguous（NY/London 回拨 01:30）→ fold=0 较早 Instant + `ambiguous=true`；nonexistent（NY 2027-03-14 02:30）→ 前移 03:30 + `nonexistent=true` + `adjustedWall` 记录。判别式为**双 fold 回程校验**——开发中抓到并修复了初版"u0≠u1 即 ambiguous"的误判（gap 也满足该条件），共享向量锁定了正确语义。

## 2. 覆盖矩阵（要求全部落地）

| 场景 | 载体 | 结果 |
|---|---|---|
| 用户 Asia/Shanghai、服务器 UTC | 服务器时区独立性审计：Python `date.today()/now()` 全部 tz 参数化（finalize/nodes/calendar_write）；TS 删除 `localWallClock` | ✓（仅 mock llm.py 的确定性 fixture 残留 date.today，非产品语义，已注明） |
| 用户 Tokyo / 服务器 +8（LA 用例由向量覆盖） | e2e：机器 +8、`LIFEOS_USER_TZ=Asia/Tokyo` | ✓ |
| UTC+8 与 UTC+9 日历混存 | e2e ICS：TZID=Asia/Shanghai 会议 + Tokyo 规划 | ✓（9/10 14:00 Tokyo 恰在上海会议结束后开始） |
| DST 开始日 / 结束日 | 向量 ny_dst_start_morning / ny_ambiguous_0130 / london_ambiguous_0130 | ✓ |
| ambiguous 01:30 ×2 / nonexistent 02:30 | 向量 + 标记字段 + adjustedWall | ✓ |
| 跨午夜事件 | pytest cross_midnight + builder 跨午夜阻塞测试 | ✓ |
| 跨时区会议 | TZID 解析 → Instant → 规划时区墙钟窗口减法 | ✓ |
| all-day | LocalDate 语义，整天阻塞，executor 不参与 Instant 比较 | ✓ |
| deadline 仅日期 | date-only 原样传递（LocalDate），不转 UTC 00:00 语义 | ✓（daysLeft 按日历日差） |
| Draft 后用户切换时区 | 草稿持久化 `timezone` + Instant 不变；显示按草稿自身时区（UI `fmt(dt, d.timezone)`）——切区只影响显示不影响已确认 Instant | ✓（设计性解决） |
| 数据迁移 | `scripts/migrate-tz.mjs`：存量 Instant 合法不动，timezone 回填 legacy 标记；已执行（Draft 14 / Write 10 条） | ✓ |

## 3. 端到端验证（要求场景）

用户时区 **Asia/Tokyo**，服务运行在 **+8 机器**，日历含 `TZID=Asia/Shanghai` 会议（明天 09:00-13:00 上海 = Tokyo 10:00-14:00）与全天事件（后天），真实 DeepSeek：

- 草稿 5 条全部 Tokyo 排期：9/9 08:00（= 前日 23:00Z，跨 UTC 日正确）、9/10 14:00（**精确贴着上海会议结束**）、9/11 零排期（全天事件日）、9/12 恢复
- 确认 **5/5 success / 0 conflict / 0 failed**；ICS 结构合法（事件在 VCALENDAR 内）；Verify Instant 完全相等

## 4. e2e 驱动出的两个真实 bug（已修）

1. **canonical 判别式错误**（见 §1）：gap 误判为 ambiguous —— 共享向量首跑捕获。
2. **ICS 追加粘连**：直接 append 使首事件粘上 `END:VCALENDAR`（真实导出无尾随换行）→ Verify **正确地**报了 failed（验证机制的价值实证）→ 重写为"插入 END:VCALENDAR 之前 + 换行保健"，专项测试（无尾换行/无 VCALENDAR 两形态）。

## 5. 六问回答

1. **服务器时区已不影响行为**：Python 全部时间 API tz 参数化（审计 grep 锁定），TS 仅 Instant+Intl；e2e 以用户≠机器时区通过。
2. **跨时区事件安全**：TZID→Instant→规划时区墙钟窗口减法→落位→canonical 回 Instant；e2e 上海会议/Tokyo 规划/跨 UTC 日草稿全对；冲突与 Verify 全 Instant 比较。
3. **DST 策略明确且非静默**：fold=0（较早）/ gap 前移 + 三字段标记（ambiguous/nonexistent/adjustedWall），向量锁定两个时区的 DST 边界。
4. **all-day 保持日期语义**：LocalDate 存储、不生成 00:00 Instant、阻塞按日历日、executor 不做 Instant 比较。
5. **满足 Google Calendar API 时间模型**：`dateTime`(Instant) + `timeZone`(IANA) / `date`(LocalDate) 一一对应；接真 provider 只差适配层（OAuth + HTTP）。
6. **适合进入真实 Provider 集成**：时间模型、确认门、幂等、stale/verify、TS defense-in-depth 全部不回退（本阶段回归全绿），且 e2e 已在"用户≠服务器时区 + TZID 混合日历"下验证。
