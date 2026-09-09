# Phase 8 设计 — Google Calendar Provider（真实日历接入）

状态：设计定稿后实施。第一版只读 + 创建 LifeOS 事件；**禁止 Update/Delete/Move/修改用户事件**。

## 1. Provider 抽象（不变更上层架构）

```
CalendarProvider（抽象能力，由两个协议承载：读 CalendarClient / 写 CalendarWriteProvider）
├─ IcsCalendarProvider     （现有实现，保留；CALENDAR_PROVIDER=ics，默认）
└─ GoogleCalendarProvider  （新增；CALENDAR_PROVIDER=google）
```

Google API 逻辑**只存在于** `agent/app/google_calendar.py`。Planner / Graph / Finalize / Next.js 路由对 provider 零感知（它们只看到 CalendarFacts、DraftItem、ExecuteResult）。日历选择：`GOOGLE_CALENDAR_ID`（默认 `primary`），由用户显式配置，**LLM 永远不猜日历**。

## 2. OAuth 设计（最小权限）

- **Scope**：仅 `https://www.googleapis.com/auth/calendar.events`。这是覆盖"读事件 + 创建事件"的最小 scope（Google 无更细的 create-only scope）；代码层自我限制只调用 `events.list / events.insert / events.get`，绝不调用 update/patch/delete/move。
- **流程**：Authorization Code + PKCE（desktop 类型客户端）：
  1. 生成 code_verifier/challenge → 拼 `accounts.google.com/o/oauth2/v2/auth` 授权 URL（用户手动打开授权）
  2. 回调码 → `oauth2.googleapis.com/token` 换 access_token（~3600s）+ refresh_token（首次授权获得）
  3. refresh_token 持久化到本地 token 文件（`GOOGLE_TOKEN_FILE`，默认 `agent/.google-token.json`，gitignore）
- **生命周期**：
  - access 过期 → 401 触发**单飞刷新**（并发只刷一次）→ 重放原请求
  - refresh 返回 `invalid_grant`（用户撤销授权）→ `auth_required`（需重新授权），绝不循环重试
- **Token 隔离（铁律）**：access/refresh/client_secret 只存在于 provider 内存与 token 文件；**永不**进入 prompt、AgentState、日志、错误响应（错误映射为统一码，原始 Google 响应体不出 provider）。

## 3. 时间语义（Phase 7.5 模型直映）

| Google | LifeOS |
|---|---|
| `start.dateTime`（RFC3339，含偏移或 Z）+ `start.timeZone` | `startUtc`（Instant）+ `timezone`（IANA） |
| `start.date = YYYY-MM-DD` | `allDay=true` + `localDate`（LocalDate 语义，不造 00:00 Instant） |
| 创建 | `dateTime`（UTC Z）+ `timeZone`（规划时区） |

禁止任何 wall-clock shortcut；canonical 转换复用 `times.py`。

## 4. LifeOS 事件标识（不只靠标题）

创建事件携带：
```
summary: "LifeOS: <任务标题>"
description: "LifeOS 计划块 goal=<goalId> task=<taskId> v<planVersion> key=<idempotencyKey>"
extendedProperties.private: { app:"lifeos", goalId, taskId, planVersion, idempotencyKey }
```
读取时 `source=lifeos` 判定优先看 private 扩展属性，标题前缀只作后备。

## 5. 幂等 CREATE 协议（防"timeout 但服务端已成功"）

```
pre-check: events.list?privateExtendedProperty="idempotencyKey=<key>"
  命中 → 直接进入 Verify（duplicate 路径）
create: events.insert
  超时/网络/5xx/429 → 不盲重试：
    ① 重新 pre-check（按 idempotencyKey 查询）→ 命中则 Verify 收敛
    ② 未命中 → 仅对 429/5xx 做一次有界退避重试（重试前同样 pre-check）
```
DB 幂等门（Phase 7）不变；provider 层再加这道外部事件防重复。同一 idempotencyKey 结构上不可能产生第二个外部 Event。

## 6. Stale Check / Verify

- Stale：执行前 `events.list` 重读目标窗口（timeMin/timeMax），Instant 重叠 → `stale_conflict`，不写（复用 executor 逻辑，Google 侧只提供按窗口读取）。
- Verify（创建成功≠完成）：`events.get(externalEventId)` 回读并校验：
  - 存在且未取消
  - start/end **Instant 相等**
  - calendarId 一致
  - extendedProperties.private 的 goalId/taskId/planVersion/idempotencyKey 全部匹配
  任一失败 → `verify_failed`，绝不标记 success。

## 7. 错误分类（统一码，原始错误不出 provider）

`auth_required | token_expired（已自动刷新后仍失败时归并 auth_required） | permission_denied(403) | rate_limited(429) | timeout | network | provider_5xx | event_not_found(404@verify) | stale_conflict | verify_failed`

## 8. 测试与冒烟

- Fake Google 服务（本地 HTTP，可注入故障）覆盖：正常读 / all-day / 多时区 / token 失效→刷新 / 撤销 / 403 / 429 / timeout / 5xx / create 成功 / **create timeout 但服务端实际成功** / stale / verify 失败 / 重复确认 / 重复 idempotencyKey。
- 真实冒烟：`scripts/smoke-google.py`——需要 `GOOGLE_CREDENTIALS_FILE` + 授权一次；创建 `[LifeOS Test]` 事件 → Verify → **不自动删除**（输出 event id 供人工清理）。本机当前无凭据：如实标注"未真实冒烟，凭据就绪后运行"。
- 回归：pytest / npm test / build / timezone-vectors / constraints-vectors / p55 / Phase 7 安全场景全部保持。
