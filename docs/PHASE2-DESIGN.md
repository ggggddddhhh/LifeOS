# Phase 2 设计 — 计划质量增强（最小改动方案）

## 0. 现状审计

| 模块 | 现状 | Phase 2 缺口 |
|---|---|---|
| `prisma/schema.prisma` | Goal（title/deadline/revision…）+ Task（title/status/priority/estMinutes/order） | 无任务日期、无依赖、无版本记录 |
| `src/lib/types.ts` | PlannedTask{title,notes,priority,estMinutes} | 无 startDate/dueDate/durationDays/dependsOn；无 PlanDiff 类型 |
| `src/lib/llm/parse.ts` | normalizePlannedTasks 校验+去重 | 不解析新字段 |
| `src/lib/llm/index.ts` | planGoal/replanGoal prompt + mock | prompt 无日期/依赖/反扩散约束 |
| API | POST goals（无依赖处理）；POST replan（无 diff、无版本） | 全部需要扩展 |
| UI | 三列看板 | 无日历、无预算条、无依赖展示 |

兼容性约束：现有 21 个单测与 Phase 1.5 评测不得回退。策略：所有新字段**可空/可选**，旧断言不感知新字段；replan 响应只增不改（`reason`、`goal` 保留，新增 `diff`）。

## 1. Schema 改动（3 项）

```prisma
model Task {
  // 新增：日历与预算
  startDate    DateTime?   // 执行窗口起点（当日零点）
  dueDate      DateTime?   // 计划完成日
  durationDays Int?        // 持续周期（天），≥1；设置后为「周期型任务」
  // 新增：依赖（自关联多对多，隐式 join 表）
  dependsOn    Task[]      @relation("TaskDependencies")
  dependents   Task[]      @relation("TaskDependencies")
}

model PlanVersion {        // 新增：每次 planning/replanning 落一条
  id        String   @id @default(cuid())
  goalId    String
  goal      Goal     @relation(fields: [goalId], references: [id], onDelete: Cascade)
  revision  Int
  reason    String
  diffJson  String   // JSON.stringify(PlanDiff)
  createdAt DateTime @default(now())
  @@unique([goalId, revision])
}
```

不改动 Goal 字段含义；`revision` 语义不变（replan 递增）。

## 2. 语义定义（要求 #4）

- **单次型任务**（durationDays=null）：`estMinutes` = 完成任务的总耗时；`startDate~dueDate` 是执行窗口。
- **周期型任务**（durationDays≥1）：`estMinutes` = **每次**投入（如每天跑步 30 分钟），`durationDays` = 持续天数。日历上显示为 `startDate` 起跨 `durationDays` 天的条带；时间预算按 `estMinutes × durationDays` 计总投入。
- LLM prompt 明确要求：习惯/训练类任务必须用周期型，一次性交付物用单次型。

## 3. 核心逻辑：`src/lib/plan.ts`（新文件，纯函数可测）

1. **`sanitizeSchedule(tasks, {today, deadline})`**：LLM 提议、代码强制。
   - 日期钳制：`startDate/dueDate ∈ [today, deadline]`；`startDate ≤ dueDate`（反了则交换）。
   - 周期一致性：有 durationDays 且有 startDate 时，`dueDate = min(deadline, startDate + durationDays - 1)`。
   - 依赖顺序：B dependsOn A ⇒ `dueDate(B) ≥ dueDate(A)`（拓扑序传播 max）。
2. **`sanitizeDependencies(deps)`**：去自引用/去未知标题/DFS 去环（关闭环的边直接丢弃）。
3. **`computePlanDiff(oldOpen, new)`**：按归一化标题匹配。
   - `added`（新标题）、`removed`（旧标题消失）、`changed`（保留但 estMinutes/dueDate 变化；dueDate 变化标注 `延后/提前`）。
   - done 任务不参与 diff（永不删除）。
4. **`enforceTaskBudget(newTasks, oldOpenCount)`**（要求 #5 的代码侧 guard）：
   - 上限 `oldOpenCount + 1`（允许一次合法拆分）；超限时先移除「无被依赖者」的**新增**任务（低优先级优先），仍超限再移除低优先级保留任务；移除会破坏依赖链时跳过。
   - 与 prompt 约束（"默认压缩/合并/重排，新增必须说明理由"）双保险。

## 4. LLM 层改动

- `PlannedTask` 增加可选 `startDate/dueDate/durationDays/dependsOn: string[]`（依赖引用其他任务标题）。
- Planner prompt：输出含日期（YYYY-MM-DD）与 dependsOn；先做完的前置任务才能被依赖；习惯型任务用 durationDays。
- Replanner prompt 追加两条硬规则（要求 #5）：
  1. 默认只做压缩/合并/重排/估时调整，**优先沿用现有任务标题**（需要合并时说明来源）；
  2. 新增任务必须在 reason 中逐条说明必要性，且总数不得超过原未完成任务数。
- mock 同步升级：planner 输出含日期+一条依赖+一个周期任务；replanner 严格保留标题（diff 大多为「不变/估时调整」）。

## 5. API 改动

- `POST /api/goals`：planner 结果 → sanitizeDependencies → sanitizeSchedule → 事务建任务 → 按标题连依赖 → 落 PlanVersion(revision=1, reason="初始计划", diff=全部 added)。
- `POST /api/goals/:id/replan`：
  1. 读取（含 done）→ 无未完成任务仍 400；
  2. replanGoal（LLM）→ sanitize* → enforceTaskBudget；
  3. `computePlanDiff(oldOpen, new)`；
  4. 事务：删未完成 → 建新任务（含日期/周期）→ 连依赖（新任务之间 + 对 done 任务的依赖）→ revision+1 → 落 PlanVersion；
  5. 响应 `{ok, data:{reason, diff, goal}}`（`reason`/`goal` 字段保留，向后兼容）。
- `GET /api/goals`：include `dependsOn:{id,title}`。

## 6. UI 改动

- GoalBoard 头部：**时间预算条**（未完成任务总投入 / 剩余天数×480min），绿/黄/红三档；显示 `剩余 X 天 · 日均 Y 分钟`。
- TaskCard 徽章：`📅 9/12`（dueDate）、`🔁 30 天 × 45min`（周期型）、`⏳ 依赖「标题」`。
- 新增 `CalendarView`：月历网格（上月/下月切换），按 dueDate 放任务条，日格显示当日投入，>480min 标红；周期型任务条带横跨 startDate→dueDate；无日期任务单独列表。主页 看板/日历 切换。
- Replan 弹层升级：显示 diff（新增/删除/延后/提前/估时变化）分组列表。

## 7. 测试计划

- 单测（plan.test.ts）：diff 匹配/分类、日期钳制与依赖传播、环检测、enforceTaskBudget 各分支；parse 新字段规范化。
- API 集成：创建后任务有日期且顺序合法；replan 落 PlanVersion 且 diff 结构正确；反扩散 guard 生效（mock 场景可控）。
- 评测扩展（真实 LLM）：planner 输出日期均在 [今天, deadline] 且依赖无环；replan diff 中 added ≤ removed+2（时间充裕场景）；Phase 1.5 原有断言全部保留。
