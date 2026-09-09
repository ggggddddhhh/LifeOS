"""Phase 6：共享黄金向量（docs/constraints-vectors.json）—— 与 vitest 消费同一文件。
任何一侧约束语义漂移，它自己的套件变红。"""

from __future__ import annotations

import json
import os

import pytest

from app.finalize import norm_title  # noqa: F401（保持与实现同源）

VECTORS = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "docs", "constraints-vectors.json"), encoding="utf-8"))


def _run_case(case: dict):
    """按向量输入走 python finalize 链（与 finalize_plan 相同顺序，便于精确断言）。"""
    from app.finalize import enforce_task_budget, enforce_time_budget, sanitize_dependencies, sanitize_schedule

    tasks = [dict(t) for t in case["tasks"]]
    deps, dep_notes = sanitize_dependencies(tasks)
    sched_notes = sanitize_schedule(tasks, deps, case.get("deadline"), case.get("today"))
    notes: list[str] = [x.split(":")[0] for x in dep_notes + sched_notes]
    if "oldOpenTitles" in case:
        tasks, n = enforce_task_budget(tasks, {norm_title(t) for t in case["oldOpenTitles"]})
        notes += [x.split(":")[0] for x in n]
    cap = case.get("capacityOverride")
    tasks, n = enforce_time_budget(tasks, case["daysLeft"], cap if cap is not None else None)
    notes += [x.split(":")[0] for x in n]
    if cap == 0 and tasks:
        notes.append("minimal_plan_floor")
    return tasks, notes


@pytest.mark.parametrize("case", VECTORS["cases"], ids=[c["name"] for c in VECTORS["cases"]])
def test_vector(case):
    tasks, notes = _run_case(case)
    exp = case["expect"]
    titles = [t["title"] for t in tasks]
    for want in exp.get("titles", []):
        assert want in titles, f"{case['name']}: 缺少 {want}，实际 {titles}"
    for banned in exp.get("notContains", []):
        assert banned not in titles, f"{case['name']}: 不应包含 {banned}"
    if "total" in exp:
        total = sum(t["estMinutes"] for t in tasks)
        assert total == exp["total"], f"{case['name']}: 总量 {total} != {exp['total']}"
    if "totalAtMost" in exp:
        total = sum(t["estMinutes"] for t in tasks)
        assert total <= exp["totalAtMost"] + 15 * len(tasks), f"{case['name']}: {total} 超容量+下限容差"
    if "minPerTask" in exp:
        assert all(t["estMinutes"] >= exp["minPerTask"] for t in tasks)
    for d, want in exp.get("dueDateOf", {}).items():
        got = next(t.get("dueDate") for t in tasks if t["title"] == d)
        assert got == want, f"{case['name']}: {d} 的 dueDate {got} != {want}"
    for typ in exp.get("adjustmentTypes", []):
        assert typ in notes, f"{case['name']}: 缺少调整类型 {typ}，实际 {notes}"


def test_spec_version_pinned():
    assert VECTORS["specVersion"] == "1"
