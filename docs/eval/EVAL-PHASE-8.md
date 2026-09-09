# Phase 8 验证报告 — Google Calendar Provider

- 日期：2026-09-09 · 设计：[PHASE8-DESIGN.md](../PHASE8-DESIGN.md)
- 实现：`agent/app/google_calendar.py`（OAuth + 读 + 幂等 CREATE + Verify）；`CALENDAR_PROVIDER=ics|google` 选择；ICS Provider 完整保留
- 回归：pytest 126/126（+14 Google 场景）、npm test 81/81、build、timezone/constraints 双向量（套件内含）、Phase 5.5（10/10）、Phase 7 确认/幂等安全（套件内含）

## 1. 架构保持

Google API 逻辑 100% 收敛在 `google_calendar.py`；Planner/Graph/Finalize/Next.js 路由零改动（TS 侧本阶段**零代码变更**）。Provider 经 `CALENDAR_PROVIDER` 切换；`GOOGLE_CALENDAR_ID` 由用户显式配置，LLM 永不猜日历。第一版仅调用 `events.list / events.insert / events.get`（代码层禁止 update/patch/delete/move）。

## 2. OAuth / Token（按要求 #2 #3）

- Authorization Code + PKCE（S256），scope 仅 `calendar.events`（读+建的最小 scope）
- access ~3600s；401 → 单飞刷新 → 重放一次；refresh `invalid_grant`（撤销）→ `auth_required`，不循环
- **Token 隔离验证**：专项测试断言错误信息不含 refresh/access/secret 子串；token 只在 provider 与 `GOOGLE_TOKEN_FILE`（gitignore）之间流动

## 3. 时间与标识语义

- `dateTime(+偏移/Z)+timeZone → startUtc+timezone`；`date → allDay+localDate`（LocalDate，不造 00:00 Instant）——Phase 7.5 模型直映，零 wall-clock shortcut
- LifeOS 事件：`summary="LifeOS: …"` + `description`（goal/task/version/key）+ `extendedProperties.private{app,goalId,taskId,planVersion,idempotencyKey}`——识别优先看私有扩展属性，标题前缀仅后备

## 4. 幂等 CREATE / Stale / Verify（要求 #5-#9 #11）

- **幂等**：DB 门（Phase 7）+ provider 层 `privateExtendedProperty=idempotencyKey=<key>` 预查。**create timeout 且服务端实际成功** → 异常路径先回查命中 → 收敛为同一事件（专项测试断言 insert 只发生一次、lifeos 事件数恒为 1）；盲重试在结构上不存在。429/5xx → 统一错误码，可安全重试整个 confirm（幂等保证）。
- **Stale**：执行前重读窗口，Instant 重叠 → `stale_conflict` 不写（测试：精确占用草稿时段的用户事件 → 不产生任何新事件）。
- **Verify**：`events.get` 回读，校验存在/未取消、start/end Instant 相等、LifeOS metadata 全匹配；错误 start → `verify_failed`；404 → `event_not_found`；失败绝不标 success（executor 层拒绝）。

## 5. 错误分类（要求 #10）

`auth_required / token_expired(并入 auth_required) / permission_denied(403) / rate_limited(429) / timeout / network / provider_5xx / event_not_found(404@verify) / stale_conflict / verify_failed`。原始 Google 响应体不出 provider（测试锁定）。

## 6. 测试覆盖（要求 #12 的 13 类，Fake Google 服务）

正常读 / all-day / 多时区 ✓；token 失效→刷新→重放 ✓；撤销→auth_required ✓；403 ✓；429 ✓；timeout ✓；5xx ✓；create 成功+metadata+Verify ✓；**create timeout 但服务端实际成功（单事件收敛）** ✓；stale conflict ✓；verify 失败（错 start / 404）✓；重复确认（TS 套件）✓；重复 idempotencyKey（insert 零调用）✓。

## 7. 真实冒烟状态（要求 #13，如实）

本机无 Google OAuth 凭据 → **未做真实冒烟，不伪造通过**。`agent/smoke_google.py` 已就绪：授权引导（PKCE URL）→ 创建 `[LifeOS Test]` 事件 → Verify → 幂等复验 → 输出 event id（不自动删除）。配置 `GOOGLE_CREDENTIALS_FILE` 后一条命令即可执行。

## 8. 六问回答

1. **Google 真实读写是否跑通？** 未用真实账号验证（无凭据，如实标注）；对 Fake Google 的契约覆盖 13/13 场景全绿，真实冒烟脚本就绪待凭据。
2. **OAuth/token 生命周期是否安全？** 是：最小 scope、PKCE、单飞刷新、撤销显式退出、token 不入 prompt/日志/错误（测试锁定）、token 文件 gitignore。
3. **create timeout 是否可能产生重复事件？** 结构上不会：异常路径必先按 idempotencyKey 回查（Google 原生支持 privateExtendedProperty 查询），命中即收敛；未命中也只对 429/5xx 做有界重试且重试前再预查。测试证明了"服务端实际成功"场景下事件数恒为 1。
4. **stale/verify 是否仍然可靠？** 是：stale=执行前重读+Instant 比较（不写）；verify=GET 回读四项校验（Instant/calendarId 隐含于同 calendar GET/metadata/存在），失败不标 success。Phase 7 安全场景全部保持绿。
5. **ICS 与 Google 是否真正可替换？** 是：同一对协议（读 CalendarClient / 写 CalendarWriteProvider），executor 对两者统一工作（Google 走 metadata+verify_event 分支，ICS 走 UID+read_events 分支），`CALENDAR_PROVIDER` 一键切换；全量回归在默认 ics 下不变。
6. **是否具备上线给真实用户测试的条件？** 架构与安全层面具备（确认门/幂等/stale/verify/token 隔离/错误分类全绿）；上线前剩两件事：①真实 OAuth 凭据 + 一次真冒烟（脚本就绪）；②多用户 token 存储（当前单 token 文件，单用户够用，多用户需 per-user token store——记录为接入项）。
