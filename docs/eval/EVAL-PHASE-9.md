# Phase 9 评测报告：真实用户 Dogfood Reliability

日期：2026-09-09 · 环境：真实 Google Calendar（user@example.test）+ 真实 GitHub API（匿名）+
DeepSeek（deepseek-v4-flash）+ SQLite + Windows 单机 · 设计 fe867f8

## 一、执行了什么

结构化 trace 层（双侧 JSONL + 脱敏测试）+ 分段幂等长跑 harness（`scripts/dogfood-longrun.py`），
在真实环境完整走完同一 Goal 的多版本生命周期：

```
setup(v1 计划→草稿→确认→写入14条) → occupy(用户手动占用日历) → cycle2(完成任务→replan v2→
旧草稿作废→新草稿避让) → confirm2(写入4条+重复确认拒止) → [进程重启] → resume(跨进程幂等+v3 3条) →
[删token+重启] → tokenfail(降级断言) → [恢复token+重启] → ghfail(GitHub 404降级) → audit(对账+指标)
```

外加一次**真实超时故障**（首批 14 条写入超过旧 30s 预算）及其**真实恢复演练**。

## 二、真实故障抓到并修复的缺陷（Phase 9 核心产出）

| # | 缺陷 | 真实表现 | 修复 |
|---|---|---|---|
| 1 | execute 超时预算不足 | 14 条草稿串行幂等协议实测 37s > TS 30s 超时 → 502，TS 丢失结果未落库 | execute 超时 30s→180s（`AGENT_EXECUTE_TIMEOUT_MS`） |
| 2 | confirm 超时恢复入口被堵 | 超时后草稿停留 confirmed，但重试只认 pending → 只能重新生成草稿 | confirmed 草稿纳入重试集合（DB 门+pre-check 双层防重） |
| 3 | **幂等身份判定错源**（最严重） | executor 用 `Google事件ID==幂等键` 判"自己"→永不相等→重放时自己的事件被判为用户占用 → `stale_conflict`（安全但永不收敛） | Google 按 `private.idempotencyKey` 匹配 + duplicate 时真实验证 Instant；Phase 8 测试只断言副作用（create_calls==0）未断言恢复状态——盲区已补 |
| 4 | 无 token 写路径整批 500 | `read_events` 在循环外抛 reauth_required → AGENT_INTERNAL_ERROR，用户看不到"请重新授权" | 读阶段失败也逐条结构化 failed（hint 透传） |
| 5 | drafts 端点吞掉日历拉取失败 | fetch 失败静默 busy=[]，trace 无记录 | cal_facts trace（ok/error_code/latency） |
| 6 | confirm 落库 provider 硬编码 "ics" | Google 模式写入记录错标 | 从 executor 响应取真实 provider |
| 7 | api.test.ts 未隔离 AGENT_MODE | 真实 agent 在 8000 运行时测试请求真打 DeepSeek → 9 例超时 | 测试强制 local mock（测试环境隔离缺陷） |

真实恢复演练（修复后）：人为重现"agent 已写、TS 未落库"现场 → 重放 confirm →
**14/14 duplicate_skipped、verify 四项全过（真实 eventId + Instant 匹配）、零新事件**。

## 三、安全性与一致性结果

| 断言 | 结果 |
|---|---|
| Google 日历 lifeos 事件 idempotencyKey 无重复 | ✅（21 事件全唯一） |
| DB 写入记录 ↔ Google 事件 externalEventId | ✅ 全部 1:1 |
| DB 外孤儿 LifeOS 事件 | ✅ 0 |
| 重复确认 | ✅ 拒止（pending 清空）+ DB 门 + pre-check 三层 |
| 旧版本草稿误执行 | ✅ v1 未确认草稿在 v2 drafts 时作废，无可执行路径 |
| 用户事件优先 | ✅ 外部占用事件后新草稿全部避让（排期层+stale 层） |
| invariant breach（TS 守卫修改 Python 收敛计划） | ✅ 0 次 |
| token/code/敏感内容落 trace | ✅ 0（双侧脱敏测试 + 真实 trace 抽查） |

## 四、真实运行指标（trace 统计）

| 事件 | 次数 | 成功/失败 | p50 | max |
|---|---|---|---|---|
| replan（agent，DeepSeek 全链路） | 5 | 5/0 | 20.3s | 57.4s |
| plan（agent） | 6 | 5/1（1 次 PARSE_ERROR 重试后仍失败，被 TS fallback 兜住） | — | 53.3s |
| calendar_tool（Google 读） | 8 | 5/3（3 次为无 token 降级，如实记录） | ~1.7s | 2.8s |
| github_tool（匿名 API） | 9 | 4/5（5 次为 404/故障注入场景） | 1.3s | 5.7s |
| cal_confirm（web） | 15 | 13/2（2 次为旧 30s 超时，修复前） | 27ms | 36.9s |
| agent fallback | 2 次（http_502、timeout）→ local 兜底成功，用户请求无感 | | | |

## 五、五问回答

**1. 是否适合 ≤5 人真实 dogfood？——适合。**
安全红线（不重复写入、用户事件优先、确认制、敏感信息不泄露）在真实环境全程成立；
发现的 7 个缺陷全部修复并有回归测试；多轮多版本生命周期（v1→v2→v3）零不一致。

**2. 最大剩余可靠性风险？**
- **replan 全链路延迟 p50≈20s、max≈57s**：DeepSeek + 双工具 + finalize 串行，网络差时会逼近
  TS 侧 AGENT_TIMEOUT_MS（当前默认 30s——建议 dogfood 环境显式调大至 120s+，`.env` 一行）；
- LLM 输出偶发 PARSE_ERROR（1/6），靠重试 + local fallback 兜底——fallback 计划质量降级无用户提示；
- 单机 SQLite + 单进程 agent：无并发写热点问题（dogfood 规模），但重启期间请求失败需用户重试。

**3. 是否出现重复写入/错误写入？——否。**
修复前的超时事件也**没有**产生重复写入（安全语义一直正确），错的是恢复语义
（stale_conflict 不收敛 + DB 缺记录）；audit 终态零重复、零孤儿、1:1 对账通过。

**4. 是否存在无法自动恢复的故障？——两类需要人工，均已显式化：**
- refresh token 被拒（撤销/过期）：自动清库 + `reauth_required` 提示，但**重新授权必须人工**
  跑授权流程（设计如此，8.5 已验证）；
- `timeout`"结果未知"：自动收敛依赖用户稍后重试 confirm（幂等回查兜底），无后台自动对账。
其余（进程重启、网络超时、token 短暂缺失、GitHub 404、LLM 解析失败）全部自动恢复/降级。

**5. 是否值得进入 Update/Delete 或新增 Email Tool？——还不值得。**
本阶段暴露的问题说明**写路径的恢复语义仍需真实使用持续验证**（7 个缺陷里 5 个在写路径）。
建议先用 1-2 周真实 dogfood 积累 trace（工具已就绪），确认 invariant breach 与恢复类缺陷
归零后，再考虑：① Calendar Update/Delete（需先定义目标事件选择/冲突合并策略）② Email 只读。

## 六、遗留与清理

- Google 日历留有 `[DOGFOOD9]` lifeos 事件 21 个 + `[外部占用]` 事件 1 个，人工清理
- DB 留有两个 dogfood goal（`cmtto75r0…`、`cmttojygs…`），可经 UI 删除
- trace 文件 `logs/web-trace.jsonl`、`agent/logs/agent-trace.jsonl`（gitignored）持续追加

## 七、回归

pytest **162/162**（+5 trace、+1 批量重放收敛、+1 无 token 逐条失败；含盲区修复）、
vitest **86/86**（+4 trace、+1 超时恢复；含环境隔离修复）、build 通过。
