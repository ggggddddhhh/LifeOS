"""Phase 6：Finalize 极端场景。"""

from __future__ import annotations

from app.finalize import finalize_plan


def T(title, est, pri=2, **kw):
    return {"title": title, "priority": pri, "estMinutes": est, **kw}


class TestExtremeScenarios:
    def test_capacity_zero_keeps_minimal_p1(self):
        tasks, reason, fin = finalize_plan(
            [T("P1核心", 300, 1), T("P3可选", 120, 3)],
            kind="replan", days_left=3, deadline=None,
            old_open_titles={"P1核心", "P3可选"}, done_titles=set(),
            capacity_minutes=0, reason="原始理由",
        )
        assert len(tasks) >= 1
        assert all(t["estMinutes"] >= 15 for t in tasks)
        assert any(a["type"] == "minimal_plan_floor" for a in fin["adjustments"])
        assert fin["finalizeAdjusted"] is True
        assert "最终计划" in reason  # reason 描述最终计划

    def test_tiny_capacity_with_p1_scales_down(self):
        tasks, _, fin = finalize_plan(
            [T("A", 600, 1), T("B", 600, 1), T("C", 90, 3)],
            kind="replan", days_left=5, deadline=None,
            old_open_titles={"A", "B", "C"}, done_titles=set(),
            capacity_minutes=45, reason="r",
        )
        total = sum(t["estMinutes"] for t in tasks)
        assert total <= 45 + 15 * len(tasks)  # 每任务 15 下限容差
        assert "C" not in [t["title"] for t in tasks]  # P3 先砍
        assert any(a["type"] == "capacity_trim" for a in fin["adjustments"])

    def test_many_repeating_tasks_fit_capacity(self):
        # 周期任务：容量按 estMinutes 求和（与 TS enforceTimeBudget 对齐），不乘 durationDays
        tasks = [T(f"每日训练{i}", 30, 2, durationDays=10) for i in range(10)]  # 总 300
        out, _, fin = finalize_plan(
            tasks, kind="replan", days_left=7, deadline=None,
            old_open_titles={f"每日训练{i}" for i in range(10)}, done_titles=set(),
            capacity_minutes=200, reason="r",
        )
        assert sum(t["estMinutes"] for t in out) <= 200 + 15 * len(out)
        assert fin["finalizeAdjusted"] is True

    def test_dependency_chain_not_broken_by_cuts(self):
        # A→B→C→D 链：容量只够 2 个 → 必须从链尾砍，不得断链
        tasks = [
            T("A", 120, 1), T("B", 120, 1, dependsOn=["A"]),
            T("C", 120, 2, dependsOn=["B"]), T("D", 120, 3, dependsOn=["C"]),
        ]
        out, _, _ = finalize_plan(
            tasks, kind="replan", days_left=3, deadline=None,
            old_open_titles={"A", "B", "C", "D"}, done_titles=set(),
            capacity_minutes=250, reason="r",
        )
        titles = {t["title"] for t in out}
        for t in out:
            for d in t.get("dependsOn", []):
                assert d in titles, f"断链: {t['title']} 依赖 {d} 但 {d} 被砍"

    def test_one_day_deadline_dates_clamped(self):
        tasks = [T("A", 60, 1, startDate="2026-10-01", dueDate="2026-10-05")]
        out, reason, fin = finalize_plan(
            tasks, kind="replan", days_left=1, deadline=None,
            old_open_titles={"A"}, done_titles=set(), capacity_minutes=None, reason="r",
        )
        # deadline 未提供 → 窗口 = 今天+14；原始日期被钳入窗口
        from datetime import date as _date, timedelta as _td
        assert out[0]["dueDate"] <= (_date.today() + _td(days=14)).isoformat()
        assert any(a["type"] == "invalid_date" for a in fin["adjustments"])

    def test_completed_task_not_resurrected_and_annotated(self):
        tasks, reason, fin = finalize_plan(
            [T("已完成事项", 60, 1), T("未完成A", 120, 1)],
            kind="replan", days_left=5, deadline=None,
            old_open_titles={"未完成A"}, done_titles={"已完成事项"},
            capacity_minutes=None, reason="r",
        )
        titles = [t["title"] for t in tasks]
        assert "已完成事项" not in titles
        assert any(a["type"] == "completed_task_removed" for a in fin["adjustments"])

    def test_unadjusted_plan_keeps_reason_untouched(self):
        tasks, reason, fin = finalize_plan(
            [T("A", 100, 1)], kind="replan", days_left=5, deadline=None,
            old_open_titles={"A"}, done_titles=set(),
            capacity_minutes=2000, reason="LLM 原始理由",
        )
        assert reason == "LLM 原始理由"
        assert fin["finalizeAdjusted"] is False
        assert fin["llmProposedMinutes"] == fin["finalizedMinutes"] == 100

    def test_reason_reflects_final_numbers_when_adjusted(self):
        tasks, reason, fin = finalize_plan(
            [T("A", 600, 1), T("B", 600, 2)],
            kind="replan", days_left=2, deadline=None,
            old_open_titles={"A", "B"}, done_titles=set(),
            capacity_minutes=600, reason="原始",
        )
        total = sum(t["estMinutes"] for t in tasks)
        assert reason.startswith("原始（最终调整")
        assert f"共 {total} 分钟" in reason
        assert f"容量上限 600" in reason
        assert fin["finalizedMinutes"] == total
