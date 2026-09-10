# PlanShift UI Redesign V2 — 设计与实施文档

> Reality → Plan → Shift。本次重构不改任何 Agent / Planner / Replanner / Calendar 写入 /
> OAuth / idempotency 业务语义；唯一后端增量是两个**纯只读**的观察面出口（见 §12 声明）。

## 1. Audit（重构前问题审计）

### 1.1 最成熟的部分（继承，不推翻）
- **确认制交互骨架**：Replan preview→审阅→apply→undo；日历草稿 draft→confirm→逐条结果徽章；
  任务编辑 dry-run→预览→保存。三条链路语义完整，本次只重呈现。
- App Shell（220px sidebar + mobile 底部 tab）、Goals 行式列表、状态组件
  （ErrorState/ListSkeleton/EmptyState）、focus-visible / progressbar / reduced-motion 等 a11y 基础。

### 1.2 主要问题（本次修复）
| 类别 | 问题 | 修复 |
|---|---|---|
| AI 味 | Sparkles 图标用于「新目标/重新规划/Today 导航」 | 全部移除：Today→Sun、新目标→Plus、Replan→RefreshCw |
| 死代码 | GoalHeader 的「日历实测」容量 override 从无数据来源 | ReplanAction onDone 回传 capacityMinutes，本会话内真实生效 |
| 信息层级 | Today 无主结构；「其他目标」打断主线；focus 取数组第一个 | Today's Focus → Today Plan → Plan Health 三段式；focus 按 deadline 紧迫度排序 |
| 信息层级 | Goal Detail 三区块等权堆叠，Replan 缩在角落 | 控制中心 header（统计条 + Replan 主操作）+ 任务/计划历史/日历 三 tab 渐进披露 |
| 产品语义 | Replan 结果 = 小确认框 + 文本 diff | Shift Preview：结构化 Move/Add/Remove 行 + Before→After + 原因分条 + 安全提示 |
| Calendar | 外部日历不可见；已写入仅绿色 ✓；proposed 不可见 | 四层来源体系 + legend + 时间维度 + mobile agenda |
| a11y | destructive 确认框默认焦点在危险操作 | 焦点改落「取消」 |
| 语义漂移 | Today 头部「累计完成 X/Y」是全库口径 | 改为「今天到期 n 项 · 进行中 m 项 · 过期 k 项」 |

## 2. 参考项目与借鉴原则

调研对象：shadcn/ui 官方 dashboard 生态、Cal.com（scheduling 语义）、Linear 式 productivity
信息密度、2026 年 shadcn/Next.js 16 dashboard 模板的通用实践（含 dark mode 与 a11y 评测维度）。

**只借方法，不抄视觉**（非 Cal.com/Linear/Notion clone）：
- **shadcn**：token 化语义色 + 少组件多组合；我们的 StatusBadge / states / dialog 沿用此思路。
- **Linear**：中性底 + 单 accent + tabular 数字 + 高密度行式列表 + 克制的 150–250ms 动效。
- **Cal.com**：日历事件的"来源与状态可扫读"——对应我们的四层事件体系（external / synced /
  proposed / planned）与顶部 legend。
- **成熟 task UI**：状态用显式控件而非循环点击；diff 用 Before→After 而非 JSON。

反面清单（全部遵守）：无大面积渐变 / 无毛玻璃滥用 / 无 glow / 无 emoji 图标 /
无 sparkle / 无 Ask-AI / 每区块不是独立 Card / 优先级不用红黄绿交通灯。

## 3. Information Architecture（不变部分 + 调整）

```
/            Today      = Today's Focus → (其他目标) → Plan Health* → Today Plan（今天到期/进行中/已过期）
/goals       Goals      行式列表（不变，token 跟进）
/goals/[id]  控制中心    = 面包屑 → 标题+统计条+Replan → [任务 | 计划历史 | 日历] tab
/calendar    Calendar   = 月历（桌面）/ 紧凑月+当日 agenda（手机）+ legend + 外部日历状态
/activity    Activity   时间线（+N 项调整徽章）
/settings    Settings   外观/策略不变；Google 连接区 V2.1 重做（四步引导 + 状态分类）
```
*Plan Health 只在有信号时出现：截止临近 / 容量超载（建议 Replan）/ 日历排期待确认。

## 4. Design System

- **Color**：中性骨架 + 单一 accent。`--primary` 从纯黑改为蓝灰
  `oklch(0.52 0.10 255)`（dark `0.71 0.09 255`）——这是 "Plan" 语义色（核心操作/选中/今日/计划任务）。
  `--accent` 同步微蓝。semantic 色（success/warning/danger/info）保持 V1 的低饱和定义。
- **Typography**：层级不变（page-title 20 / section 13 semibold / body 13 / meta 12 / caption 11）；
  数字全部 `tabular`。
- **Radius/Shadow**：`--radius 0.5rem` 不变；卡片一层 border 无 shadow；popover/dropdown 才有 shadow。
- **Motion**：150–250ms；仅用于出现/消失（animate-rise/fade）、进度条宽度、tab/展开过渡；
  `prefers-reduced-motion` 全量禁用（沿用 V1）。

## 5. Reality / Plan / Shift 视觉语义（本次核心）

| 层 | 语义 | 视觉 |
|---|---|---|
| **Reality·外部** | Google/ICS 里用户自己的安排（高数课/实验课） | 中性灰条目 + 左竖线 + 时间前缀，稳定低干扰 |
| **Reality·已写入** | PlanShift 确认写入日历的事件 | success 左竖线 + 绿色系淡底 |
| **Plan** | 当前计划任务（未进日历） | primary 淡蓝底 |
| **Shift·提案** | 待确认排期草稿 | primary 虚线边框（"这只是建议"） |
| **Shift·变化** | Replan 的 Move/Add/Remove | 结构化行 + 标签徽章 + Before→After（`9/17 → 9/20`） |

## 6. Today 设计

- 顶部：中文长日期 + `Today` + 今日口径统计（今天到期/进行中/已过期）+ 新目标。
- **Today's Focus**：按 `focusScore`（deadline 邻近 × 未完成量）选最紧迫目标，显示
  进度 %、截止、剩余投入、今日容量 chip、风险徽章、进度条；其余目标收为紧凑行。
- **Plan Health**：条件渲染，三类信号（danger 截止 / warning 超载建议 Replan / info 待确认排期）。
- **Today Plan**：已过期（红）→ 今天到期 → 进行中，紧凑行（checkbox + goal 缩写 + 标题 + 今天/过期标记 + 时长）。

## 7. Goal Detail 设计（执行控制中心）

- Header：面包屑 → 标题/描述 + 删除（ghost icon）→ **统计条**（进度 · 截止+剩余天数 ·
  计划版本 · 剩余工作量 vs 容量条）→ **Replan 主操作**（primary 按钮 + 说明文案 + undo）。
- Tab 区：`任务`（Kanban，含添加任务）/ `计划历史`（vN 时间线 + 展开 ShiftChanges diff）/
  `日历`（草稿清单→确认写入→结果徽章，流程不变）。
- Kanban/TaskCard/TaskFormDialog 交互不变；`capacityMinutes` 经 `onDone` 回传后标注「日历实测」。

## 8. Replan / Shift Preview 设计（`shift-preview.tsx` + 重写 `replan-action.tsx`）

弹窗（sm:max-w-2xl）结构：
1. 标题 `重新规划 · N 项调整` + 说明（"根据当前进度、截止时间与日历容量…"）。
2. **结构化变更列表**：`移动`（日期 `9/17 → 9/20` + 延后/提前）/ `调整`（`230m → 200m`）/
   `新增`（success）/ `移除`（danger + 删除线）——全部来自 PlanDiff 真实字段，不虚构时间。
3. **完整明细**（折叠）：摘要行（新增/删除/保留/估时 Δ）+ 全量行。
4. **原因**：reason 按句分条（≤5 条）+ finalize 调整说明。
5. Footer：安全提示（"确认只更新 PlanShift 的任务计划，不会改动你的 Google Calendar——
   写入日历需要单独确认"）+ `不采用` / `确认 N 项调整`。

分析中的按钮文案改为「正在分析进度与容量…」（真实耗时 20–60s 时有信息量）。
数据边界：任务日期粒度是「日」，Before→After 显示 `9/17 → 9/20`；具体时刻（19:00）只存在于
日历草稿/写入层——这是现有数据模型的真实粒度。

## 9. Calendar 设计

- **数据层**（业务逻辑零改动）：新增只读观察面（见 §12）读取 agent `fetch_facts` 的
  原始事件（含 `source: user|lifeos` 区分）；DB 草稿提供 proposed 层；agent 不可达时
  回退 DB executed 草稿表示已写入（即旧行为）。
- **呈现**：顶部 = 月份 + 前后翻 + 外部日历连接状态 chip；legend 一行五项
  （你的日历（现实）/ PlanShift 已写入 / 待确认排期 / 计划任务 / 日负载 n h 上限）。
- 桌面月格：条目按层渲染（时间前缀 + 标题），日负载 = `n h` 数字 + 微条（超载红字），
  每格最多 4 条 + 「还有 N 项」。
- **Mobile**：紧凑月（h-11 格：日期 + 负载点/计数）+ 点选日的 agenda 列表（完整条目带时刻），
  不硬塞 7 列桌面月历。
- 未排期任务折叠区保留。

## 10. Mobile 策略

- Sidebar → 底部 5 tab（不变）；顶栏 + 主题切换（不变）。
- Calendar：compact month + selected-day agenda（§9）。
- Kanban：tab 切换单列（V1 已有，保留）。
- Shift Preview：`max-h-[85dvh]` 内滚动区 + DialogFooter 常驻；footer 安全提示在窄屏折到按钮上方。
- mobile-today.png（390×844）已验证无横向溢出。

## 11. Accessibility

- destructive ConfirmDialog 默认焦点 → 「取消」（本次修复）。
- Tab 区 `role=tablist/tab + aria-selected`；Calendar legend `aria-label="图例"`；
  紧凑月日期按钮 `aria-label="n 日，m 项安排"` + `aria-pressed`；「还有 N 项」补 aria-label。
- ShiftChanges 列表 `aria-label="共 N 项调整"`；progressbar / focus-visible / reduced-motion 沿用 V1。
- 已知债务：dark 模式下部分 muted 文字对比度约 4.4:1（§15）。

## 12. 修改文件列表（+ 后端只读增量声明）

**前端改**（16 文件）：`globals.css`（accent token）· `layout.tsx` 未动 · `page.tsx`（Today 重构）·
`goals/[id]/page.tsx`（控制中心 + tab）· `calendar/page.tsx`（四层重设计）· `activity/page.tsx`
（调整计数徽章）· `sidebar-nav.tsx`（图标 + accent 选中态）· `goal-header.tsx`（统计条）·
`replan-action.tsx`（Shift Preview 接入）· `plan-diff.tsx`（复用 ShiftChanges）·
`focus-goal.tsx`（Focus/PlanHealth/OtherGoalRow/focusScore）· `task-row.tsx`（dueLabel）·
`goal-create-dialog.tsx`（去 Sparkles）· `confirm-dialog.tsx`（焦点安全）。

**前端增**：`components/goal-detail/shift-preview.tsx`（ShiftChanges/ShiftReason/ShiftDetails）·
`app/api/calendar/external/route.ts` · `components/settings/calendar-connect-guide.tsx`
（Google 连接四步引导 + 一键复制，V2.1）。

**V2.1 补充（用户反馈修复）**：
1. **乱码清理**：早前通过 Windows shell 驱动 replan 时 GBK 编码把两条 PlanVersion（v4/v5）
   的 reason/diffJson 写坏（任务本身已被 undo 恢复）——已删除这两条脏记录（demo 数据问题，
   非代码缺陷；经浏览器走 API 的正常路径不受影响）。
2. **Settings 连接引导重做**：①「未连接」时显示四步引导卡（Cloud Console 取凭据 →
   复制 .env 三行配置 → 复制授权命令 + 回贴回调 URL → 重启刷新），每段带一键复制；
   ② Agent 不可达时不再透出原始 `fetch failed`，改为「服务未启动」徽章 +
   「请先启动 npm run agent」提示；③ 断开按钮仅在 google 模式显示
   （ICS 模式断开会 409）。
3. **状态语义修正（V2.2）**：ICS 模式下 agent 的 `connected:true` 只表示「ICS 日历源可用」，
   之前被直接映射成 Google 卡片的绿色「已连接」徽章，与"连接 Google 后可…"文案自相矛盾。
   现在区块改名为「日历连接」并按 provider 区分：Google 已授权 → 绿「已连接」+ 账号信息；
   ICS 已配置 → 蓝色 info「ICS 只读接入」+ 只读语义文案 + 可展开的
   「连接 Google Calendar，获得确认制写入」引导（展开时隐藏多余的 ICS 备选提示）。

**后端只读增量（声明）**：
1. `agent/app/main.py` 新增 `GET /v1/calendar/facts`——对既有 `CalendarClient.fetch_facts`
   的纯透传（`source` 字段原本就存在），无任何写路径/OAuth/Provider 改动；
2. `src/app/api/calendar/external/route.ts`——上述端点的 TS 代理（15s 超时，失败静默降级）。

**测试**：`agent/tests/test_api.py` +2（未配置降级 / ICS 事件 source 区分）；
`agent/tests/test_finalize.py` 修复一条**存量时间炸弹**（硬编码 `2026-09-23` 过期，改为动态日期，
业务断言不变）。

**演示资产**：`scripts/demo-calendar.ics`（演示用课程表，配合
`CALENDAR_PROVIDER=ics CAL_ICS_PATH=scripts/demo-calendar.ics` 启动 agent）。

## 13. 测试结果

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 0 错误 |
| `npm test`（vitest） | ✅ 117 passed / 1 skipped（13 files） |
| `npm run build`（next build） | ✅ 编译 + 12 静态页生成成功 |
| `pytest`（agent，含 +2 新增） | ✅ 180 passed |
| `npm run lint` | 8 errors / 7 warnings —— **与重构前基线完全相同**（存量：react-hooks/set-state-in-effect 数据获取模式、logs/*.cjs、测试文件；本次未新增任何 lint 问题） |

## 14. Before / After 截图（screenshots/）

| 文件 | 内容 | 视觉验证 |
|---|---|---|
| `today.png`（1440×900） | Focus 卡（进度/截止/容量/版本）+ 其他目标 + Plan Health（待确认排期 info 信号）+ Today Plan（今天/进行中） | ✅ |
| `goal-detail.png`（1440×900） | 统计条 + Replan 主操作 + 任务/计划历史/日历 tab + Kanban | ✅ |
| `replan-preview.png`（1440×900） | Shift Preview：7 项调整（移动 9/17→9/20 等）+ 完整明细折叠 + 原因分条 + 安全提示 + 不采用/确认 | ✅ |
| `calendar.png`（1440×900） | 四层：灰色课程事件（10:00 高等数学课 / 14:00 物理实验课）、绿色已写入、虚线待确认、蓝色计划任务 + legend + ICS 状态 chip | ✅ |
| `mobile-today.png`（390×844） | 顶栏 + Focus 卡 + Today Plan + 底部 tab，无溢出 | ✅ |

深色模式抽检：accent 反转正常、选中态可辨、无未跟随主题元素（`--primary: oklch(0.71 0.09 255)`）。

## 15. 剩余 UI Debt（诚实清单）

1. **dark muted 对比度**：部分 11px muted 文字对比度 ≈4.4:1（AA 边缘），可在 dark token 微调
   `--muted-foreground` 至 0.73–0.75。
2. **任务粒度**：Shift Before→After 只有日期粒度；若要显示 `19:00` 级别需引入日历草稿时刻
   联动（需产品决策，未擅自扩字段）。
3. **Plan Health 的 GitHub 信号**：agent 的 GitHub 进度变化目前无对外事件流，UI 无法呈现
   "GitHub progress changed"；需要 agent 提供观察面后接入。
4. **Calendar 事件点击**：外部事件暂不可点（无 goalId 可链）；可加"查看来源日历"提示。
5. **replan 撤销时限**：undo 短期可用，UI 未提示撤销窗口过期后的表现（后端语义决定）。
6. **Kanban 无拖拽**：刻意保守（防误触，V1 决策）；若加拖拽需完整键盘可达方案。
7. **存量 lint**：8 个 error 为重构前既有（数据获取 effect 模式等），建议单独立项清理。
8. **goal-kanban.png（旧图）**：已被 goal-detail.png 取代，可在下次 release 清理。
