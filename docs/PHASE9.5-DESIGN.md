# Phase 9.5 设计：Dogfood Observability & Stability

> 目标：不加产品功能，把 Phase 9 的观测设施补成"1-2 周真实使用后能用数据判稳"的体制。

## 0. 非目标

Calendar Update/Delete、Email、其他 Tool、任何 Agent 决策逻辑变更。

## 1. runId 贯穿（跨服务请求关联）

- **TS 侧**：replan / drafts / confirm 路由入口生成 `runId`（`crypto.randomUUID()` 前 8 位），
  随 agent 调用以 **`x-run-id` header** 透传；本路由 trace 行携带同一 runId。
- **agent 侧**：FastAPI 中间件读 `x-run-id` → `contextvars.ContextVar`；`trace()` 自动为
  每行注入 `runId`（缺失时省略）。零业务侵入。
- 价值：一次用户请求在 web-trace 与 agent-trace 中的多行事件可精确串联（replan →
  github_tool → calendar_tool → replan）。

## 2. token refresh 埋点

`GoogleOAuth._refresh_access` 成功/失败各一行 trace（`token_refresh`：ok、error_code、
latency_ms）。红线不变：零 token 值。

## 3. 一键 audit：`scripts/reliability-audit.py`

```
--db prisma/dev.db   SQLite 直读（CalendarWrite/CalendarDraft 表）
--provider google    凭据复用 agent/.google-token.json
--daily              输出并落盘 logs/reliability-summary-YYYY-MM-DD.json
--all-days           汇总全部历史 trace
```

**对账（五指标之三）**：
- Google 全量 lifeos 事件（按 `private.app=lifeos`，不限单 goal）vs DB
  `CalendarWrite(status ∈ {success, duplicate_skipped})`
- 断言：同 key 多事件 = duplicate；DB 无记录的 Google 事件 = orphan；
  externalEventId 不匹配 = mismatch

**指标（按日聚合）**：
| 维度 | 来源 |
|---|---|
| P50/P95/max latency | 双侧 trace（replan/plan/cal_*） |
| LLM fallback | web replan trace 的 agentFallbackReason |
| tool failure | github_tool/calendar_tool ok=false 按 error_code |
| token refresh | token_refresh trace |
| duplicate / stale / failed 写入 | cal_confirm summary + cal_execute statuses |
| invariant breach | web replan trace |
| runId 覆盖率 | 有 runId 行 / 总行数 |

**不可恢复错误口径**：`reauth_required`（需人工重授权）+ `timeout`（结果未知）+
`provider_5xx/network` 终态失败。

## 4. daily reliability summary

audit 脚本 `--daily` 模式：读当日 trace → 指标聚合 → 落盘 JSON + 控制台摘要。
自动运行：提供 Windows 计划任务一行命令（文档说明，不代装）。

## 5. 测试

- pytest：中间件 runId 注入（TestClient 带 header → trace 行携带）；token_refresh trace；
  统计纯函数（`agent/app/relstats.py`，喂假 trace 行断言 p95/按日聚合/覆盖率）
- vitest：TS runId 生成与 header 透传（stub server 捕获 header）
- 对账纯函数：假 Google 事件列表 + 假 DB 行断言 duplicate/orphan/mismatch 分类

## 6. 交付与判定

- 全量回归 + 对现有真实数据（Phase 9 长跑遗留）跑一次完整 audit 作 day-1 基线
- EVAL-PHASE-9.5.md 五指标判定：duplicate=0 / orphan=0 / breach=0 / 不可恢复≈0 /
  关键路径成功率（cal_confirm ok 率、replan ok 率）——注明"1-2 周持续数据需后续重跑本脚本"
