# Phase 9.5 评测报告：Dogfood Observability & Stability

日期：2026-09-09 · 设计 26ef530 · 前置：Phase 9（trace 基础 + 长跑修复）

## 一、交付了什么（不加产品功能）

| 项 | 实现 |
|---|---|
| runId 贯穿 | TS 四路由（goal_create/replan/drafts/confirm）生成 8 位 runId → `x-run-id` header → agent FastAPI 中间件 → ContextVar → **每行 trace 自动携带**；真实验证：web `cal_drafts runId=2bfea4e7` ↔ agent `cal_facts runId=2bfea4e7` 跨服务精确串联 |
| token refresh 埋点 | `_refresh_access` 成功/失败各一行（error_code 用最终语义码，与统计口径一致）；零 token 值（测试断言） |
| 一键 audit | `scripts/reliability-audit.py`：SQLite CalendarWrite ↔ Google 全量 lifeos 事件对账（按 DB goal 集过滤，冒烟/历史事件单列 out-of-scope）+ 全维度指标 + `--daily` 落盘 `logs/reliability-summary-YYYY-MM-DD.json` + 五指标判定（exit code 可挂 CI/计划任务） |
| 统计纯函数 | `agent/app/relstats.py`：P50/P95/max、fallback、tool 失败按码、token refresh、duplicate/orphan/stale/failed 写入、invariant breach、runId 覆盖率、**不可恢复错误（时序恢复判定：失败行之后同 event 出现成功行 = 已恢复，不计入）**、关键路径成功率 |

## 二、真实数据基线（day 1，audit 实跑输出）

**对账（全量）**：Google 26 事件 ↔ DB 26 写入 **1:1 全匹配，duplicate=0、orphan=0、mismatch=0**；
3 个 DB 外事件正确单列（goalId=smoke，历次冒烟遗留）。

**指标摘要**（trace 236 行，含 Phase 9 长跑历史）：
- 关键路径成功率：replan **100%**（13/13）、cal_confirm **88.7%**（7 次失败全部为 Phase 9 修复前的旧超时，当日新数据 100%）
- 写入结果累计：success 215 / duplicate_skipped 64 / stale_conflict 58 / failed 7（failed 均为演练注入）
- invariant breach：**0**
- token refresh：15 次（9 失败全部来自 tokenfail 演练，均恢复）
- 真实延迟：plan p95 116s（LLM 全链路）/ cal_execute p95 37s / calendar_tool p95 2.8s / github_tool p95 3.9s
- runId 覆盖率 11%（历史行无 runId；今日起新行全覆盖）

**判定：对账 ✅ clean · 当日不可恢复错误 0 ✅（exit=0）**

## 三、五指标判定（本阶段交付的判定能力 + day-1 基线）

| 指标 | 判定 | 依据 |
|---|---|---|
| 重复写入 = 0 | ✅ **达成** | 对账 duplicateKeys=0（全量真实数据） |
| orphan = 0 | ✅ **达成** | 对账 orphans=0（smoke 类单列不计入） |
| invariant breach = 0 | ✅ **达成** | 236 行 trace 全程 0 |
| 不可恢复错误 ≈ 0 | ✅ **达成**（当日 0）| 时序恢复判定：所有 reauth_required/timeout 故障（含演练）之后均有成功行 |
| 关键路径成功率可接受 | ✅ cal_confirm 88.7%（新代码后 100%）、replan 100% | 失败集中于修复前旧超时；**需 1-2 周持续数据确认** |

**总判定：观测体制就绪，day-1 基线五指标全绿。** "1-2 周真实使用后判稳"的数据采集
已完全自动化——每天跑一次 `reliability-audit.py --daily`（或挂 Windows 计划任务），
五指标任何一项劣化即 exit≠0。

## 四、过程发现并修复

1. goal 创建路由漏 runId/trace（plan 行无 runId）→ 已补（goal_create 事件）
2. token_refresh trace 首版记底层码 auth_rejected，与不可恢复口径不一致 → 统一为最终语义码
3. 不可恢复判定初版"出现即计"会把**已恢复的演练/处置故障**永远挂红 → 改为时序恢复判定
4. audit 对账初版不限范围 → 冒烟事件会误报 orphan → 按 DB goal 集过滤 + out-of-scope 单列

## 五、剩余风险与建议

- plan/replan 真实延迟 p95 ≈ 2 分钟（LLM 主导）——用户体验问题而非可靠性问题，
  后续可考虑流式/异步，属产品阶段决策
- runId 覆盖率从今日起 100%，历史行 11%——跨期统计时注意
- SQLite 直读假设单进程写（dogfood 规模成立）；多实例部署时 audit 需改为走 API

## 六、回归

pytest **170/170**（+8 观测：runId 注入 ×3、relstats ×4、refresh trace ×1）、
vitest **87/87**（+1 runId 透传）、build 通过。真实验证：新一轮 goal→drafts→confirm 5/5 成功，
audit exit=0，daily summary 落盘。
