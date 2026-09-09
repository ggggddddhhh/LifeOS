# Phase 7 设计 — Calendar 写入闭环（确认制）

## 1. 核心原则与总体流程

**绝对禁止 Agent 自决写入**。确认权威在 Next.js（用户 UI 交互 + DB 状态），Python 只是被驱动的"手"。

```
Observe(GitHub/Calendar facts) → Analyze → Replan → Python Finalize（合法计划）
  → Draft Builder（确定性排期，只读日历）→ 落库 CalendarDraft[pending_confirmation]
  → UI 展示「将创建 N 个事件」→ 用户 Confirm all / Cancel
  → Executor（写前冲突复检 + 幂等检查 + CREATE）→ Verify（回读校验）
  → 落库 CalendarWrite → UI 显示 Scheduled / 部分失败明细
```

## 2. 分层与职责

| 层 | 位置 | 职责 | 明确不做 |
|---|---|---|---|
| Finalize | python graph | 收敛出合法计划 | 不产生任何写操作（Draft 层独立于 Finalize） |
| Draft Builder | python `/v1/calendar/drafts` | 输入**已收敛**任务+当前日历事实，确定性贪心排期到空闲窗口；只读 | 不写、不调用 LLM |
| Deterministic Validator | python drafts 端点内 | 逐条校验：actionType=create、start<end、时长=任务 est、窗口内、不与用户事件重叠 | LLM 字段不进入 Draft（全部派生） |
| Confirmation | Next.js + DB | status: pending_confirmation → confirmed/cancelled；唯一能把状态推向执行的入口 | — |
| Executor | python `/v1/calendar/execute` | 重新读日历（冲突复检）→ 幂等复检（DB key + 事件 UID 双层）→ CREATE → 回读 Verify | 不做 update/delete；不覆盖用户事件；冲突标 stale 不硬写 |
| Provider | python `CalendarWriteProvider` | v1 = ICS 文件追加（UID=`lifeos-<goalId>-<v>-<taskId>@lifeos`，SUMMARY 前缀 `LifeOS:`）；测试注入 fake | — |

Safety Gate（要求 #12）：drafts 只消费 Finalize 输出 + 日历事实，字段全部确定性派生；即使 LLM 输出被污染，也无法越过 Finalize 约束 → Draft 校验 → 确认 → 执行器复检四道门。

## 3. 数据模型（Next.js/Prisma；python 无状态）

```prisma
model CalendarDraft {
  id             String   @id @default(cuid())
  goalId         String
  planVersion    Int
  taskId         String   // LifeOS 任务 id
  taskTitle      String
  proposedStart  DateTime
  proposedEnd    DateTime
  calendarId     String   @default("primary")
  actionType     String   @default("create")   // v1 仅 create
  reason         String?
  status         String   @default("pending_confirmation")
  // pending_confirmation|confirmed|executed|failed|stale_conflict|duplicate_skipped|cancelled
  idempotencyKey String   @unique  // {goalId}:{planVersion}:{taskId}:{occurrence}
  createdAt/updatedAt
  @@index([goalId, status])
}
model CalendarWrite {   // ExternalEventLink 语义并入本表（provider+externalEventId+taskId+planVersion）
  id              String   @id @default(cuid())
  draftId         String   @unique
  goalId          String
  planVersion     Int
  taskId          String
  provider        String   @default("ics")
  externalEventId String?  // UID
  idempotencyKey  String   @unique
  status          String   // success|failed|stale_conflict|duplicate_skipped
  error           String?
  createdAt       DateTime @default(now())
}
```

## 4. 幂等（要求 #4）

双层：①DB `idempotencyKey` 唯一约束（goalId:planVersion:taskId:occurrence），confirm 入口对已 executed 的草稿直接返回既有结果不再执行；②执行器写前按事件 UID 回读（`lifeos-…@lifeos`），已存在 → `duplicate_skipped`（覆盖跨进程/DB 丢失场景）。重复点击确认 → 第二次全部 duplicate_skipped，Calendar 中恰一份。

## 5. 冲突与用户事件优先（要求 #5 #6）

- Draft 生成时：只排入空闲窗口（可用分钟 ≥ 任务时长），永不与任何观察到的忙碌重叠；
- Execute 时**重新读取**日历：若 Draft 生成后用户安排了新事件（含全天事件）→ 该草稿标 `stale_conflict`，不写，提示重新生成草稿；LifeOS 自建事件（UID 前缀识别）不计入阻挡（允许我们占满自己的连续块）。

## 6. 事实来源区分（要求 #7）

四类物理分离：`CalendarFacts.events[].source ∈ user|lifeos`（观察，ICS UID 解析）；`CalendarDraft`（提案，未落日历）；`CalendarWrite`（已确认写入记录）；prompt 只接收观察事实与推断容量，永远不接收 Draft/Write。日历容量推断对 user+lifeos 事件一视同仁（都占时间）。

## 7. API 契约

- `POST /v1/calendar/drafts` `{daysLeft, tasks:[{taskId,title,estMinutes,durationDays?}]}` → `{drafts:[DraftItem]}`（永不写）
- `POST /v1/calendar/execute` `{drafts:[DraftItem&taskId…], goalId, planVersion}` → `{results:[{idempotencyKey, status: success|duplicate_skipped|stale_conflict|failed, externalEventId?, verify?: {found, startOk, endOk, unique}, error?}]}`（逐条结果，部分失败如实上报）
- 错误码：CAL_AUTH_INVALID / CAL_RATE_LIMIT / CAL_TIMEOUT / CAL_SERVER / CAL_CONFLICT / CAL_INVALID_DRAFT

## 8. 失败处理（要求 #9）

Provider 抛错映射到上述错误码并落到该条 draft 的 failed（含 error 摘要）；批量逐条独立执行，聚合结果如实呈现（部分成功≠整体成功）。python 不可达 → TS calendar client 报错（**写路径无 fallback**），草稿停留 confirmed，可重试确认（幂等保证安全）。OAuth 场景 v1 由 ICS 规避，代码路径保留。

## 9. UI（要求 #11）

GoalBoard 内：`生成日历草稿` 按钮 → 面板列出 N 条（日期/起止/任务/时长/原因）→ `Confirm all` / `Cancel`；执行后逐条状态（✅已排期 / ⛔冲突 / ⚠️失败+错误 / 🔁重复跳过）与汇总。无逐项编辑。

## 10. 验证计划

- pytest：排期/校验/幂等（双执行一次事件）/冲突 stale/部分失败/verify/user 优先/source 区分/极端（无空闲日）
- TS 集成（stub python）：drafts 落库 pending；confirm 成功/重复确认不二次执行；python 挂 → 无写；不确认 → execute 永不被调；local fallback replan 不产生任何草稿/写入
- 全栈 e2e（真实进程）：见要求 #13 场景（stub GitHub + 密集日历 ICS + 真实 LLM + Next auto 模式）
- 回归：pytest / npm test / build / p45 / p55 / 共享向量
