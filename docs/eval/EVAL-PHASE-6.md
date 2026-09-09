# Phase 6 验证报告 — Agent Finalization 一致性收口

- 日期：2026-09-09 · 设计：[PHASE6-DESIGN.md](../PHASE6-DESIGN.md)
- 实现：`agent/app/finalize.py`（约束链前移）+ 共享向量 `docs/constraints-vectors.json`（pytest 与 vitest 双侧消费）+ TS invariant breach 检测
- 回归：pytest 94/94（+15）、npm test 64/64（+8）、build、Phase 2 eval 40/40、Phase 4.5 重验、Phase 5.5 重验

## 1. 边界重构结果

| 层 | 职责 | 状态 |
|---|---|---|
| Python Finalize | **主动收敛**：依赖去环 → 日期钳制/依赖顺序 → 反扩散（≤open+1）→ 容量（≤capacityMinutes，P1 不砍只等比压缩，下限 15min）→ 完成任务过滤；reason 同步重写 | 新增 |
| Python reason | 有任何调整时追加"（最终调整：…。最终计划 N 项共 X 分钟，容量上限 Y 分钟）"——描述用户实际看到的计划 | 新增 |
| 可观测 | `finalize` 块：llmProposedMinutes / finalizedMinutes / capacityMinutes / finalizeAdjusted / adjustments[{type, detail}]，type ∈ capacity_trim / invalid_date / dependency_adjustment / anti_expansion_trim / completed_task_removed / minimal_plan_floor | 新增 |
| TS plan.ts | **defense-in-depth**：python 路径（带 finalize 块）下若守卫仍修改输出 → `[invariant-breach]` 显式日志（绝不静默）；local fallback 路径守卫链仍是主收敛器（行为不变） | 调整 |

## 2. 双语言一致性：共享黄金向量（要求 #5 的落地）

`docs/constraints-vectors.json`（specVersion=1，6 个向量）由 **pytest（test_vectors.py）与 vitest（plan-vectors.test.ts）加载同一文件、断言相同期望**。流程约定：改任何一侧约束语义 → 先改向量（评审）→ 双侧同步实现 → 双套件绿。

**向量的第一次运行就抓到了真问题**：
1. 我的向量期望写错（以为 960 容量会保留 P1+P2=1100——违反容量不变式；两侧实现一致地砍到 600）——期望被纠正，证明向量在真实工作；
2. **真实语义缺口**：`capacity=0` 在两侧都被当作"非法覆写→回退默认 3360"，与要求 #11 冲突。双侧同步修正为"0 是合法的零容量 → 最小可行计划（单个任务 15min，记录 minimal_plan_floor）"，向量锁定该语义。

## 3. Phase 5.5 十场景重验（要求 #10）

| 指标 | Phase 5.5（前） | Phase 6 重验（后） |
|---|---|---|
| D 臂图级输出满足真实容量 | 9/10（s4 图级 720>660） | **10/10（s4 精确 660/660）** |
| expectMetRate_D | 0.8 | **1.0** |
| B 臂超真实容量（对照盲区仍在） | 5/10 | 5/10（不变，符合预期） |
| ok 率 | 100% | 100% |

TS 二次裁剪次数 = 0 的证据链：① D 臂图级输出 10/10 ≤ 容量（python 已收敛，TS 守卫无事可做）；② 共享向量证明两侧算法同语义；③ 万一发生 → `[invariant-breach]` 日志（不会再静默）。

reason 一致性证据：s4 的 reason 现以"容量上限 660 分钟，原总估时 1170 超限，故合并…压缩…排期至可用量高的 9/12、9/13"描述**最终** 660 分钟计划；finalize 调整时还会追加最终数字。

## 4. 过程中的两个产品修正（评测驱动）

1. **capacity=0 语义**（见 §2）：双侧统一为零容量→最小可行计划。
2. **冲突任务改名复活**：Phase 6 重验发现 LLM 把用户标记完成的任务加"（待确认）"后缀重新塞回计划，绕过标题精确匹配的 done-filter。修正 prompt 冲突规则（"禁止重新加入计划，包括改名/加后缀变体"）后 p55 恢复 10/10。残余风险：done-filter 是标题精确匹配，极端改名仍可能绕过——由 prompt 约束 + invariant 监控兜底，记录在案。

## 5. 极端场景测试（要求 #11，全部通过）

capacity=0（最小可行计划+minimal_plan_floor 标注）/ 极低容量+P1（P3 先砍、P1 等比压到下限）/ 大量周期任务（容量按 estMinutes 求和，与 TS 对齐不乘 durationDays）/ 依赖链（砍任务不断链，专项断言）/ 1 天 deadline（日期钳入窗口）。

## 6. 五问回答

1. **Python 是否已成为真正的计划最终生成者？** 是。reason/任务/最终落库计划三者同源于 Python Finalize 的输出；容量收敛、反扩散、完成过滤、日期/依赖合法化全部在 Agent 侧完成，且附完整收敛观测块。
2. **TS 是否只承担安全兜底？** 是。python 路径下 TS 守卫正常为 no-op（本轮 10/10 场景零二次裁剪），一旦修改即触发 `[invariant-breach]` 显式告警；local fallback 路径 TS 仍是主收敛器（该路径无 Python Finalize，行为与 Phase 5 完全一致）。
3. **是否还存在 reason 与最终计划不一致？** 常规路径已消除（reason 描述收敛后计划并附最终数字）。已知残余：done-filter 的标题精确匹配对极端改名变体不设防（prompt 已约束 + 监控），以及 LLM 在无调整时 reason 中偶发的数字口误（finalize 不动计划时不重写 reason，属 LLM 表述噪声，可观测但低危）。
4. **双语言约束如何避免漂移？** 共享黄金向量是唯一语义真源，双侧套件消费同一文件；改语义必须先改向量再同步双侧实现。本轮向量首次运行即捕获一处真实分歧（capacity=0），机制已被证明有效。风险：向量覆盖有限（6 条），持续扩展向量是长期义务（每次修约束 bug 先加向量）。
5. **是否适合进入 Calendar 写操作？** **已经适合**。Phase 5.5 提出的前置条件"容量收敛精度"已在本轮解决（图级 10/10 精确满足，reason 一致），唯一遗留的 done-filter 改名绕过有 prompt+监控双层缓解。写操作仍建议按 Phase 5.5 顺序：Email 只读优先（若走邮件路线），Calendar 写操作需要确认机制设计（草稿→用户确认→执行），但已无技术债阻塞。

## 7. 测试清单

- pytest 94/94（新增 test_finalize.py 8 个极端/一致性 + test_vectors.py 7 个共享向量）
- npm test 64/64（新增 plan-vectors 7 个 + finalize 透传契约 1 个 + capacity=0 语义更新）
- build 通过；Phase 2 eval 40/40；Phase 4.5 重验（0 匹配误差、0 完成误判、reasonExpect 100%；specialOk 11/12——唯一未达是 scn11 中英场景 LLM 自行微调任务结构，属已记录的跨语言语义观察，确定性匹配仍零误差）；Phase 5.5 重验（expectMet 10/10、D 容量满足 10/10、ok 100%）
