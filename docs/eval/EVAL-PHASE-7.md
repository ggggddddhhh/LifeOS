# Phase 7 验证报告 — Calendar 写入闭环（确认制）

- 日期：2026-09-09 · 设计：[PHASE7-DESIGN.md](../PHASE7-DESIGN.md)
- 回归：pytest 119/119（+22）、npm test 73/73（+9）、build、Phase 4.5（specialOk 100%、0 匹配误差）、Phase 5.5（expectMet 10/10、D 容量 10/10）、共享向量（双套件内含）

## 1. 闭环实现

```
Observe(GH+CAL facts) → Analyze → Replan → Finalize（Phase 6 收敛）
  → Draft Builder（事件级空闲窗口，只读，与 Planner 完全解耦）
  → CalendarDraft[pending_confirmation]（Prisma 落库）
  → UI「LifeOS 准备向日历创建以下 N 个事件」→ Confirm all / Cancel
  → Executor（写前重新读日历 → UID 幂等复检 → 冲突复检 → CREATE → 回读 Verify）
  → CalendarWrite（provider/externalEventId/status/idempotencyKey 持久化）
```

- v1 仅 CREATE；UID=`lifeos-{goalId}-v{planVersion}-{taskId}-o{occurrence}@lifeos`，SUMMARY 前缀 `LifeOS:`（事实来源区分：观察事件 user/lifeos、draft、write 三类物理分离）
- 幂等双层：DB unique idempotencyKey（confirm 入口拦截已成功 key）+ 执行器 UID 回读（跨进程兜底）
- 冲突：Draft 生成用事件级空闲窗口永不占用户时段；执行前重读，被占 → `stale_conflict` 不硬写
- 写路径无 fallback：python 不可达 → 502、草稿保留可重试；local 模式 replan 不产生任何草稿

## 2. 重点端到端场景（真实进程链路，验证通过）

输入：`5 天后上线这个 GitHub 项目的 MVP`（repo → stub GH：CI 失败 + PR #12 未合并 + 3 open issues；真实 ICS：未来 2 天每天 09-13/14-18 会议）+ 真实 DeepSeek + Next auto 模式。

1. Replan reason 引用全部事实："CI 失败已修复…PR #12 未合并且与 issue #41 重叠，合并为一项…"
2. 草稿 5 条，**精确避让会议**：两条排在会议日晚间空档 18:00，三条排在空闲日 08:00/11:00/14:00 连续排布
3. 确认写入：**5 success / 0 conflict / 0 failed**，Verify 回读全过，UID 落 ICS
4. 重复确认 → 400（无待确认）；ICS 中无重复事件

## 3. 安全场景验证（要求 #14 全过）

| 场景 | 结果 |
|---|---|
| 不确认 → 0 写 | ✓（drafts 端点从不触达 execute；集成测试断言 executeCalls=0） |
| 重复确认 → 不重复 | ✓（同 key 重置回 pending 再确认 → 全部 duplicate_skipped，python 只收到一次；UID 层 pytest） |
| 确认后占用 → 不写 | ✓（stale_conflict + CAL_CONFLICT，pytest + 集成） |
| API 中途失败 → 精确部分失败 | ✓（逐条 status，summary 如实；执行器单条异常不炸整批） |
| Python 挂 → 无写 | ✓（502、草稿停留、恢复后重试成功；用户日历零影响） |
| local fallback 不绕过 confirmation | ✓（local 模式连 drafts 都不调用，0 草稿 0 写入） |

## 4. e2e 驱动出的三个真实 bug（已修）

1. **执行器时区混比崩溃**：TS `toISOString()`（UTC）vs ICS naive 本地 → `offset-naive/aware` 崩溃。修复：统一本地墙钟语义（`localWallClock`，Python 侧 `_naive` 归一化）。
2. **Draft Builder 天级容量缺陷**：初版按"每日剩余分钟"排期，把 4h 任务排在 09:00 正撞用户会议（执行器会拒绝，但草稿本身不该这样生成）。修复：事件级空闲窗口（[08:00,20:00] 减去忙碌区间），永不与用户事件重叠——重跑后草稿精确落到晚间空档。
3. **重试路径幂等键冲突**：python 挂掉后重新生成草稿会撞 unique key。修复：未触达日历的草稿（pending/confirmed）重新生成时删除释放 key；已成功写入的任务跳过（事件已在日历）。

另：TS 集成测试暴露两个 DB 测试文件被 vitest 并行执行互相清表 → `fileParallelism: false`。

## 5. 六问回答

1. **Agent 是否形成 Observe→Reason→Act 闭环？** 是，且 Act 被切成 Draft（提案）与 Execute（受确认驱动的执行）两段——Observe（GH/CAL 只读）→ Reason（Analyze/Replan/Finalize）→ Draft（确定性派生，无 LLM）→ 用户确认 → Execute+Verify。这是带人类在环的完整感知-推理-行动闭环。
2. **Confirmation 是否真正不可绕过？** 是。结构上：写操作只存在于 python `/v1/calendar/execute` 一个端点，其唯一调用方是 Next.js confirm 路由，而该路由只消费 `pending_confirmation` 状态的草稿；drafts 端点与 replan 路径没有任何触达 execute 的代码路径（集成测试锁定 executeCalls=0）。LLM 在 Safety Gate 外——Draft 字段全部确定性派生，validator 逐条校验时长=任务估时、actionType=create、key 格式。
3. **幂等是否可靠？** 双层（DB unique key 门 + 执行器 UID 回读）覆盖了双击、重试竞态、跨进程/DB 丢失三类场景，各有专项测试；e2e ICS 中事件恰一份。
4. **Stale draft 是否安全处理？** 是：执行前强制重读日历，被占即 `stale_conflict` 不硬写，UI 提示"需重新生成草稿"；重新生成会作废旧提案并跳过已执行任务。已知保守行为：我们自己的其他 lifeos 事件也计入冲突（宁可保守，避免重叠假设）。
5. **是否适合支持 Update/Delete？** **架构已就绪，语义需先定义**。Draft/确认/幂等/Verify 通道全部复用，只差 executor 动作；但 update/delete 需要新增：目标事件选择（哪条用户事件？外部事件归属判定）、更细的冲突合并策略（用户改了我们要动的事件怎么办）、以及"删除我们创建的事件"与"动用户事件"的边界。建议作为独立 phase 先写设计。
6. **Email Tool 是否还有必要？** 有但优先级下调。Phase 5.5 判断 Email 是"第三类事实源"；现在双工具+写入闭环已覆盖"交付状态+真实时间+行动落地"主线，Email 的边际价值（沟通证据）仍成立，可在 Update/Delete 决策后或与其并行评估。

## 6. 遗留观察

- 时区：v1 全链路统一"本地墙钟"语义，跨时区用户（服务器与用户不同时区）会漂移——上 OAuth/CalDAV provider 时必须换 UTC+tz 数据库语义（记录在案，接真 provider 前必修）。
- ICS 追加写入无文件锁：并发写可能交错（单用户单进程场景可接受，cal 挂掉由 503 兜底）。
- 批量确认后 `summary` 数字与 UI 草稿状态一一对应，已验证一致。
