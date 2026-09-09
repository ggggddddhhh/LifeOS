# LifeOS UI Redesign — 设计文档

> 先设计后实现。只动前端与纯展示性支撑（见 §6 数据边界），不改 Agent/API/DB/Calendar/GitHub
> 任何业务语义；confirmation/idempotency/stale/verify 交互保持不变，仅重新呈现。

## 1. 当前 UI 问题审计

**信息架构**
- 单页堆叠：所有 Goal 的完整看板（含 CalendarPanel）纵向塞进一个滚动页，3 个目标即失控；
  GoalForm 永占左侧 320px，与浏览场景冲突；看板/日历切换只是顶部两个小按钮
- 确认制日历写入（本项目最重要的安全交互）淹没在卡片流末尾，无独立视觉地位

**视觉**
- 满屏等距圆角 Card + shadow（典型 demo 感）；emoji 当功能图标（🤖📅⏱⛔✅），跨平台渲染
  不一致且无语义；无 dark mode 切换（变量存在但永远 light）；无 token 体系（radius/间距/
  动效各自为政）；优先级"高"用红色 destructive badge（红色被滥用为"危险"之外的含义）

**状态**
- loading/empty 都是一行灰字；error 是顶部常驻红字条，不随恢复消失；Replan 进行中仅按钮
  文案变化（真实耗时 20-60s，无进度感）；无 skeleton、无 offline、无冲突/fallback 信号

**交互**
- 任务状态靠循环点击（done 的"重开"紧邻"完成"，误触即回退）；删除 Goal 无确认直接执行
  （destructive 裸奔）；无键盘导航与 focus 规范；"Confirm all"英文按钮混入中文界面；
  确认写入（external write）没有明确的风险确认对话

**数据表达**
- BudgetBar 硬编码 480min/天——后端早已是真实 Calendar 容量（replan 响应含
  capacityMinutes/finalize），UI 语义漂移
- Plan diff 是纯文本堆行；GitHub/Calendar 工具状态、fallback、stale 完全没有 UI 出口；
  Activity/历史无处可看（replan 结果一刷新就没了）

## 2. 新 Information Architecture

```
App Shell（左侧 Sidebar + 主区，mobile 折叠为底部 Tab / 抽屉）
├── /            Today      日期 + 今日进度 + 当前 Goal 焦点 + 今日到期任务 + 风险信号
├── /goals       Goals      紧凑目标列表（行式，非大卡片）→ 进入 Detail
├── /goals/[id]  Goal Detail：header(进度/deadline/容量) · Kanban · 计划历史+Diff ·
│                          Calendar Draft→Confirm 专属区 · Replan（克制的 AI Action）
├── /calendar    Calendar   跨目标月历（负载/周期任务/未排期）
├── /activity    Activity   计划版本时间线 + 日历写入记录（状态徽章）
└── /settings    Settings   主题 · Google 连接状态/OAuth 引导/断开 · 配置说明
```

- **AI 是系统能力不是聊天**：全局无聊天框；Replan 是按钮 + 结果呈现
  （reason 摘要 + 结构化 diff + finalize 调整说明），只在动作后出现
- **GitHub/Calendar 不抢主界面**：仅在 Today/Detail 出现 contextual signal
  （如"容量不足/工具降级/存在冲突草稿"），详情进 Activity

## 3. Design System（Tokens）

**色**（oklch，双主题完整映射；中性骨架 + 单一克制 accent，无渐变无发光）
- 中性：背景 near-white/near-black（Linear 式），文字三级（primary/secondary/muted）
- Accent：`--primary` 蓝灰（light: oklch(0.55 0.12 250)，dark 反转亮度），仅用于主操作、
  选中态、今日标记
- Semantic（工具/状态专用，低饱和）：`--success` 绿 · `--warning` 琥珀 · `--danger` 红
  （仅 destructive/overload）· `--info`（工具观察色）
- 优先级表达：P1 实心小方点 accent / P2 空心点 / P3 无点——不用颜色块

**字**：系统栈 + 现有 next/font；标题 tracking-tight；数字全部 `tabular-nums`；
层级固定 6 档（page-title 20px / section 13px semibold / body 13px / meta 12px /
caption 11px / mono 用于时间戳与 ID）

**间距/密度**：4px 基数；任务卡 p-2.5、行高 snug、列表 gap-1.5（高密度）；
区块间距 24/32 二档；页面 max-w-6xl 居中，Sidebar 220px 固定

**Radius/Shadow**：`--radius: 0.5rem`；卡片 8px 仅一层 border 无 shadow（hover 只变
bg）；popover/dropdown 用 shadow-md；控件 6px。整体比现在收紧一档

**Motion**：全局 150–250ms `cubic-bezier(0.16,1,0.3,1)`；只用于出现/消失与 8px 内位移、
背景色过渡；`@media (prefers-reduced-motion: reduce)` 全量禁用（tw-animate-css 已有）

**States**：hover（bg-muted/50）· focus-visible（2px ring，全键盘可达）· active（scale 无，
bg 加深）· disabled（opacity-50 + cursor）· loading（按钮内 spinner + 文案，页面级 skeleton）

## 4. 页面结构（Desktop 优先，Mobile Responsive）

- **Today**：顶部一行（星期日期 · 今日完成 n/m · 新建按钮）→ 焦点 Goal 卡
  （标题/进度环/剩余天数/真实容量 chip/风险信号行）→「今天到期」「进行中」两组任务列表
  （紧凑行：checkbox + 标题 + goal 缩写 + 时长）
- **Goals**：行式列表（状态点 · 标题 · 进度条细线 · 剩余天数 · vN）→ 点击进 Detail
- **Goal Detail**：sticky header（标题、进度 n/m、deadline 倒计时、容量、Replan 按钮右置）；
  Tab 或分区：Kanban（Todo/Doing/Done，桌面三列、mobile 单列切换）· 计划历史
  （v1…vN 时间线，展开看结构化 diff + reason + finalize 说明）· 日历写入区
  （Draft 清单 → 「写入我的日历」destructive-warning 确认 Dialog → 逐条结果徽章）
- **Calendar**：月网格（现有逻辑保留）+ 日负载用文字+微条（不再整格变红），
  未排期收进底部折叠区
- **Activity**：时间线（计划版本 × 日历写入），每条含时间戳(mono)、类型徽章、
  reason 摘要、可展开 diff
- **Settings**：外观（Light/Dark/System 三选）· Google Calendar 连接卡
  （账号/日历/状态，Disconnect 带 confirm）· Agent 模式与工具只读状态 · 配置指引

## 5. 关键组件结构

```
src/components/
├── app/            app-shell.tsx · sidebar-nav.tsx · theme-provider.tsx · theme-toggle.tsx
├── shared/         empty-state.tsx · error-state.tsx · skeleton.tsx · page-skeleton.tsx
│                   status-badge.tsx（统一：写入状态/工具状态/冲突/fallback）·
│                   progress-ring.tsx · meta-chip.tsx · confirm-dialog.tsx
├── today/          today-header.tsx · focus-goal.tsx · task-row.tsx · risk-signals.tsx
├── goals/          goal-list.tsx · goal-row.tsx
├── goal-detail/    goal-header.tsx · kanban.tsx · task-card.tsx（重写）
│                   plan-history.tsx · plan-diff.tsx · calendar-draft-panel.tsx（重写）
│                   replan-action.tsx
├── calendar/       month-grid.tsx（增强自 calendar-view）
└── activity/       activity-timeline.tsx
```

Task Card 重写要点：左侧状态 checkbox（循环改为显式三态菜单/快捷键，
done 不可误触回退）；标题 + notes 一行截断；meta 行（优先级点 · 估时 tabular ·
起止 · 依赖 n）；整卡可点开 notes；键盘 Tab 顺序自然。

## 6. UI 改造文件清单（含数据边界声明）

**改**：`globals.css`（tokens 重写）· `layout.tsx`（shell/theme/字体）· `page.tsx`（→ Today）
· 5 个现有业务组件全部重写迁移 · `src/lib/types.ts`（补充前端视图类型）

**增**：上述组件树 + `/goals` `/goals/[id]` `/calendar` `/activity` `/settings` 页面

**后端支撑（零业务逻辑，仅数据透出/代理，需在报告中声明）**
1. `GET /api/goals` include `planVersions`（Activity/历史的数据源；不改既有字段）
2. `GET|POST /api/settings/calendar`（纯代理 agent `/v1/calendar/status|disconnect`，
   供 Settings 页；不触碰 OAuth 逻辑本身）

**禁改清单遵守**：Python Agent、LangGraph、Planner/Replanner、Finalize、GitHub Tool、
Calendar Provider、OAuth、confirmation/idempotency/stale/verify 全部不动；
所有既有 API 行为保持（测试回归兜底）。

**验证**：npm test · npm build · desktop/mobile × light/dark 截图 · 状态矩阵走查 ·
vitest 87 + pytest 170 无回归。
