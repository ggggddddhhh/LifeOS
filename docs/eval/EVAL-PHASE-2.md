# Phase 2 验证报告 — 计划质量增强

- 日期：2026-09-09 · 模型：`deepseek-chat` · 设计：[PHASE2-DESIGN.md](../PHASE2-DESIGN.md)
- 验证：单测 40/40、`npm run build` 通过、真实 LLM 评测 40/40（`npm run test:eval`）
- 评测断言作用层说明：结构化断言作用于**生产管线之后**（sanitizeDependencies → sanitizeSchedule → enforceTaskBudget → enforceTimeBudget），即用户实际拿到的计划；LLM 裸输出合规率作为信息指标记录。

## 1. 五项需求落地情况

| # | 需求 | 实现 | 验证结果 |
|---|---|---|---|
| 1 | 时间预算 + 日历视图 | 目标卡预算条（剩余投入/可用容量，绿黄红三档）；月历视图（看板/日历切换，单次任务落截止日、周期任务跨天条带、日格超 8h 标红、未排期任务列表） | build/UI 集成通过 |
| 2 | 任务依赖 | `dependsOn` 自关联多对多；LLM 按标题输出、代码去自引用/未知引用/环（Kahn）；依赖顺序强制 `dueDate(B) ≥ dueDate(A)`；任务卡显示 ⏳ 依赖徽章 | 10/10 目标依赖引用全部有效 |
| 3 | Replan 版本 diff | `computePlanDiff` 按归一化标题匹配：新增/删除/保留 + 估时变化 + 延后/提前；每次 planning/replanning 落 `PlanVersion`（含 reason + diffJson）；UI 分组展示 | API 集成测试 + 评测 diff 指标一致 |
| 4 | estMinutes 语义区分 | `durationDays` 可空字段：单次型=总耗时；周期型=每次耗时×持续天数；预算按 `estMinutes × durationDays` | 减重 4/雅思 6/储蓄 2 个周期任务；Rust/博客/CI/分享会等交付型 0 个——语义区分准确 |
| 5 | 防止 Replan 扩大范围 | 三层防护：prompt 硬约束（默认压缩/合并/重排，新增须说明理由）→ `enforceTaskBudget`（任务数 ≤ 原未完成+1）→ `enforceTimeBudget`（总估时 ≤ 剩余天数×480，先砍 P3/P2 再等比压缩） | 延期场景 9/9 达标：搬家 0.54 压缩、日均恰好 480（guard 生效） |

## 2. 本轮发现并修复的问题

| # | 问题 | 层 | 修复 |
|---|---|---|---|
| 1 | `sanitizeSchedule` 对畸形 deadline 无防御，会抛 Invalid time value | 产品 | 非 `YYYY-MM-DD` 回退今天+14 天 + 单测 |
| 2 | 延期场景 prompt 容量约束不够硬（LLM 曾给出日均 495 分钟） | 产品 | `enforceTimeBudget` 代码级硬保证（P1 不砍只压缩）+ 单测 |
| 3 | LLM 偶尔"复活"已完成任务标题，造成同名重复 | 产品 | replan 路由过滤与 done 同名条目 |
| 4 | 评测自身两处 deadline 传参错误（完整 ISO 传入日期函数→NaN） | 评测 | 统一 `.slice(0,10)` |

## 3. Planner / Replanner 质量数据（本轮）

- Planner：10/10 通过，日期覆盖 100%（上一代 prompt 无日期），依赖自引用/未知引用 0，平均延迟 4.5s（较 Phase 1.5 的 2.7s 上升，因输出含日期与依赖，属预期）
- Replan 9/9：延期场景全部压缩（0.54-0.83），无过载（日均 ≤480），diff 结构正确；时间充裕场景以保留为主（留 5/5、留 2/2）

## 4. 结论

**Phase 2 通过。** 五项需求全部落地且有测试覆盖；单测 40/40（Phase 1 的 21 个用例全部保留未回退）；真实 LLM 评测 40/40（Phase 1.5 断言全部保留）。LLM 提议 + 代码强制的架构在评测中验证有效：LLM 裸输出仍有日期越界与容量超标，但全部被确定性管线矫正后才触达用户。

遗留观察（不阻塞）：LLM 裸输出日期合规率约 70%（3/10 曾越界，均被 sanitize 钳制）——若未来更换模型可直接复用本评测对比；周期型任务的日历"跨天条带"按 startDate~dueDate 渲染，超长周期（90 天减重）会占满月历，Phase 3 可考虑折叠展示。
