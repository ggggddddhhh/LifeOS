# Phase 6 设计 — Agent Finalization 一致性收口

## 1. 职责边界审计（现状 → 目标）

| 阶段 | 现状 | 问题 | 目标 |
|---|---|---|---|
| Python Validate | LLM 输出结构校验 + 一次重试 | 无产品语义约束 | 不变 |
| Python Finalize | 仅 camelCase 规范化（语义空转） | —— | **主动收敛**：依赖/日期/反扩散/容量/完成过滤全部前移至此，reason 同步重写 |
| TS plan.ts 路由侧 | sanitizeDependencies/sanitizeSchedule/enforceTaskBudget/enforceTimeBudget/done-filter + reason 拼接 | 实际最终生成者；python reason 描述的是裁剪前计划 | **defense-in-depth**：正常 no-op；若仍修改 python 输出 → 记录 invariant breach（仅 python 路径），绝不静默 |
| TS local fallback（src/lib/llm） | 无 python finalize，路由守卫链是唯一收敛 | —— | 不变（守卫链仍是 local 路径的主收敛器，行为与 Phase 5 完全一致） |

## 2. Python Finalize 收敛链（与 TS 路由顺序逐一对齐）

```
replan: sanitizeDeps → sanitizeSchedule → enforceTaskBudget(≤open+1)
        → enforceTimeBudget(capacityMinutes ?? max(480, daysLeft×480))
        → done-title filter
plan:   sanitizeDeps → sanitizeSchedule（与 TS 创建路由对齐，无容量/反扩散）
```

调整即记录（可观测）：
- `invalid_date`：日期钳制/交换/依赖推移
- `dependency_adjustment`：去自引用/未知引用/环
- `anti_expansion_trim`：任务数超 open+1 裁剪
- `capacity_trim`：容量裁剪（砍 P3/P2 → P1 等比压缩，下限 15min）
- `completed_task_removed`：与已完成任务同名条目移除
- `minimal_plan_floor`：capacity < 15 时保留单个最小 P1 任务（容量为 0 物理不可满足，显式记录而非空计划）

reason 重写：有任何调整时追加"（最终调整：…；最终计划 N 项共 X 分钟，容量上限 Y）"——reason 描述的是用户将看到的最终计划。

响应观测块（ReplanResponse.finalize）：
`{ llmProposedMinutes, finalizedMinutes, capacityMinutes, finalizeAdjusted, adjustments:[{type, detail}] }`

## 3. 双语言一致性维护方案（要求 #5：不养两套分叉算法）

**单一真源 + 共享向量防漂移**：

1. **语义真源**：`docs/constraints-vectors.json` —— 由固定输入（任务/容量/依赖/日期/deadline）与**期望输出**（存活任务集、总量、每任务下限、裁剪集合）组成的黄金向量集。**pytest 与 vitest 双侧加载同一文件并断言相同期望**——任何一侧语义漂移，它自己的套件立刻红。
2. **实现关系**：Python `finalize.py` 是主动收敛实现；TS `plan.ts` 是兜底实现。两者对同一向量必须产出相同结果（裁剪集合在确定性规则下可精确断言）。
3. **流程约定**：修改任何一侧的约束语义 → 先改向量（评审语义变更）→ 两侧实现同步 → 双套件绿。向量文件头部注明版本。
4. 版本：CONSTRAINTS_SPEC_VERSION = "1"（向量文件与双侧常量同步）。

## 4. TS invariant breach 检测（要求 #9）

replan 路由在 python 路径（响应带 finalize 块）时：
- `enforceTimeBudget` 产生 note、或 `enforceTaskBudget`/done-filter 实际修改了任务集 → `console.error("[invariant-breach] ...")`（含 python finalize 观测数据），响应照常（安全优先）。
- local fallback 路径（无 finalize 块）：守卫链是主收敛器，保持现有 note 拼接行为，不算 breach。

## 5. 验证计划

- 单测：finalize 各分支 + 极端场景（capacity=0 / 极低容量+P1 / 大量周期任务 / 依赖链 / 1 天 deadline）
- 共享向量：pytest + vitest 双消费
- 重验：Phase 5.5 十场景四臂重跑——D 臂 python 图级输出必须全部 ≤ 容量（TS 裁剪次数=0）；Phase 2 eval、Phase 4.5 重跑不回退
- 契约：agent-contract 增加 finalize 块透传断言
