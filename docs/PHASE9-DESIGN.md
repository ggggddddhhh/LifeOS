# Phase 9 设计：真实用户 Dogfood Reliability（观测 + 长跑验证）

> 目标：不加新功能。补一层**结构化运行 trace**，然后用真实 Google Calendar +
> GitHub + DeepSeek 环境跑一套多轮长场景，用数据回答"能不能交给 ≤5 个真实用户"。

## 0. 非目标

- 不新增产品功能、不改 Agent 决策逻辑、不做 Update/Delete、不接 Email
- Agent 仍绝不删除/修改用户事件（harness 运维脚本对**自己创建的测试数据**的清理除外，且显式标注）
- 不引入新依赖（trace 用标准库 fs/json）

## 1. 结构化 Trace（唯一代码改动，两侧对称）

### 1.1 Python `agent/app/trace.py`

- `trace(event: str, **fields)` → JSONL 追加写 `LIFEOS_TRACE_PATH`（默认 `agent/logs/agent-trace.jsonl`）
- **白名单 + 脱敏双保险**：
  - 字段值只允许 str/int/float/bool/None/list[标量]/dict[标量]；
  - `_redact()`：匹配 secret 模式（`ya29.`、`GOCSPX-`、`refresh-`、`4/0A`、`Bearer `）→ `[REDACTED]`；
  - 非枚举字符串一律截断 80 字符（防意外长内容/用户内容）；
  - 记录内容只含 id/计数/状态/错误码/延迟，**不含** goal 标题、任务标题、笔记等用户内容。
- 接入点（边界层，graph/nodes 内部仅工具节点一行）：
  - `main.py`：`/v1/plan`、`/v1/replan`（kind、ok、error_code、llm_calls、latency_ms、tasks_out、finalize_adjusted）、`/v1/calendar/execute`（per-item status/idempotencyKey/error_code）
  - `nodes.py`：`github_tool`/`calendar_tool`（tool、ok、error_code、latency_ms、events_seen）

### 1.2 TS `src/lib/trace.ts`

- `traceEvent(event, fields)` → JSONL 追加 `LIFEOS_TRACE_PATH`（默认 `logs/web-trace.jsonl`）
- 同样的 redact/截断规则；接入点：
  - replan 路由：`replan`（goalId、planVersion、tasksOut、diff{added,removed,changed}、finalizeAdjusted、**invariantBreach**、agentProvider、fallbackReason、latencyMs）
  - calendar drafts 路由：`cal_drafts`（goalId、draftCount、cancelledStale、unplaced）
  - confirm 路由：`cal_confirm`（goalId、planVersion、summary{success,failed,duplicateSkipped,staleConflict}、errors[]）
  - cancel 路由：`cal_cancel`（count）

### 1.3 测试（脱敏是硬断言）

- `agent/tests/test_trace.py`：JSON 行格式；注入各类 secret 模式断言 `[REDACTED]`；长串截断；env 路径覆写。
- `src/tests/trace.test.ts`：同上（vitest）。

## 2. Dogfood Harness：`scripts/dogfood-longrun.mjs`

分段幂等脚本（状态存 `logs/dogfood-state.json`），走**真实用户路径**（Next API → agent → Google/DeepSeek）：

| 段 | 动作 | 验证点 |
|---|---|---|
| `setup` | 创建 `[DOGFOOD9]` goal（带 repo: 引用→GitHub 工具真实调用）→ plan → drafts v1 → confirm v1 | 日历出现 v1 事件；DB CalendarWrite↔Google 事件 1:1 |
| `occupy` | 用 refresh token 直连 Google API 写一个外部占用事件（模拟用户手动加会）——**运维脚本行为，非 Agent 路径** | 占用事件就位 |
| `cycle2` | 完成任务 → replan（真实 DeepSeek + 真实日历容量）→ drafts v2 | v1 未确认草稿被 cancelled（幂等键释放）；v2 草稿避开占用事件；旧草稿 ID 强行 confirm → 被拒 |
| `confirm2` | confirm v2 → 重复确认（重放） | 无重复事件；重放全 duplicate_skipped |
| `resume` | **进程重启后**（重启动作在段间由外部执行）重放 confirm、再跑一轮 drafts+confirm | idempotency 跨进程成立；trace 跨进程追加 |
| `tokenfail` | 备份→删除 token 文件→断言 reauth_required 降级（fetch_facts ok=False，计划仍产出）→恢复备份→断言恢复 | 失效检测 + 无 token 降级 + 恢复（真实重授权已在 8.5 真实验证） |
| `ghfail` | goal 换 `repo:dogfood/nonexistent-xxxx` replan | GitHub ok=False 安全降级；无伪造引用 |
| `audit` | 读 Google 日历（lifeos 事件按 goalId 元数据）vs DB CalendarWrite | **零重复写入**（idempotencyKey 唯一映射）；输出指标汇总 |

统计输出（`audit` 段）：每段 latency 分位（p50/p95/max）、LLM 调用数、fallback 次数、失败率、invariant breach 数、重复写入数。

## 3. 进程与故障操作（外部执行，复用既有经验）

- 服务启动：agent（uvicorn，显式 `CALENDAR_PROVIDER=google` + GOOGLE_* env）+ Next dev
- 重启：netstat -ano 按端口找 PID + taskkill //F //PID（Windows 进程树坑）
- 429/网络中断/5xx 的进程级注入**不在真实环境强造**（无法让 Google 真限流）；这些路径的覆盖引用 Phase 8.5 的 22 类注入测试结论，报告如实区分"真实验证层"与"注入验证层"

## 4. 报告回答（EVAL-PHASE-9.md）

1. ≤5 人真实 dogfood 适配性
2. 最大剩余可靠性风险
3. 是否出现重复写入/错误写入（audit 段数据）
4. 是否存在无法自动恢复的故障
5. 是否值得进入 Update/Delete / Email Tool
