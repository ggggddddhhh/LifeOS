"""节点单测：Analyze 统计、extract_json 鲁棒性、normalize_tasks 规范化、Finalize 契约。"""

from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from app.nodes import (
    analyze_node,
    extract_json,
    finalize_node,
    normalize_tasks,
)


def iso_in(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


# ---------------------------------------------------------------- Analyze

class TestAnalyze:
    def test_plan_with_deadline(self):
        state = analyze_node({"kind": "plan", "request": {"title": "x", "deadline": iso_in(10)}})
        assert state["analysis"]["daysLeft"] == 10

    def test_plan_without_deadline_fallback_14(self):
        state = analyze_node({"kind": "plan", "request": {"title": "x"}})
        assert state["analysis"]["daysLeft"] == 14

    def test_plan_past_deadline_clamped_to_1(self):
        state = analyze_node({"kind": "plan", "request": {"title": "x", "deadline": iso_in(-3)}})
        assert state["analysis"]["daysLeft"] == 1

    def test_replan_stats_and_overload(self):
        req = {
            "goalTitle": "g",
            "daysLeft": 2,
            "declaredMinutesPerDay": [480, 480],  # Phase 12：声明层（策略）必传，容量 = 求和
            "tasks": [
                {"title": "a", "status": "done", "estMinutes": 100, "priority": 1},
                {"title": "b", "status": "todo", "estMinutes": 500, "priority": 1},
                {"title": "c", "status": "in_progress", "estMinutes": 600, "priority": 2},
            ],
        }
        state = analyze_node({"kind": "replan", "request": req})
        a = state["analysis"]
        assert a["daysLeft"] == 2
        assert a["openCount"] == 2
        assert a["doneCount"] == 1
        assert a["openTotalMinutes"] == 1100
        assert a["capacityMinutes"] == 960  # 480+480（声明层求和）
        assert a["overloaded"] is True

    def test_replan_zero_declared_capacity(self):
        # Phase 12：0 容量（用户明确不排期）→ 容量 0、必超载
        req = {
            "goalTitle": "g",
            "daysLeft": 2,
            "declaredMinutesPerDay": [0, 0],
            "tasks": [{"title": "a", "status": "todo", "estMinutes": 30, "priority": 1}],
        }
        state = analyze_node({"kind": "replan", "request": req})
        assert state["analysis"]["capacityMinutes"] == 0
        assert state["analysis"]["overloaded"] is True


# ---------------------------------------------------------------- extract_json

class TestExtractJson:
    def test_plain(self):
        assert extract_json('{"a":1}') == {"a": 1}

    def test_fenced(self):
        assert extract_json("说明\n```json\n[1,2]\n```\n结尾") == [1, 2]

    def test_noisy(self):
        assert extract_json('好的：{"tasks":[]} 完成') == {"tasks": []}

    def test_truncated_raises(self):
        with pytest.raises(ValueError):
            extract_json('{"tasks":[{"title":"a"')

    def test_no_json_raises(self):
        with pytest.raises(ValueError):
            extract_json("我认为分三步")


# ---------------------------------------------------------------- normalize_tasks

class TestNormalizeTasks:
    def test_clamps_and_defaults(self):
        out = normalize_tasks([
            {"title": "  任务一 ", "notes": "说明", "priority": 0, "estMinutes": 99999},
            {"title": "", "estMinutes": 30},
            "garbage",
            {"title": "任务二", "priority": 2, "estMinutes": "45"},
        ])
        assert out == [
            {"title": "任务一", "notes": "说明", "priority": 2, "estMinutes": 600},
            {"title": "任务二", "priority": 2, "estMinutes": 60},
        ]

    def test_duplicate_titles_dropped(self):
        out = normalize_tasks([
            {"title": "写测试", "priority": 1, "estMinutes": 60},
            {"title": "写测试", "priority": 2, "estMinutes": 90},
            {"title": "写 测试。", "priority": 3, "estMinutes": 30},
        ])
        assert len(out) == 1

    def test_dates_and_deps_validated(self):
        out = normalize_tasks([
            {
                "title": "t",
                "startDate": "2026-09-09",
                "dueDate": "2026-13-99",  # 非法日期
                "durationDays": 7,
                "dependsOn": ["前置", 42, ""],
            }
        ])
        assert out[0]["startDate"] == "2026-09-09"
        assert "dueDate" not in out[0]
        assert out[0]["durationDays"] == 7
        assert out[0]["dependsOn"] == ["前置"]

    def test_duration_invalid_dropped(self):
        out = normalize_tasks([{"title": "t", "durationDays": "abc"}])
        assert "durationDays" not in out[0]

    def test_non_list_returns_empty(self):
        assert normalize_tasks(None) == []
        assert normalize_tasks({"0": {"title": "a"}}) == []

    def test_reason_float_priority(self):
        out = normalize_tasks([{"title": "t", "priority": 1.7, "estMinutes": 45.6}])
        assert out[0]["priority"] == 2
        assert out[0]["estMinutes"] == 46


# ---------------------------------------------------------------- Finalize

class TestFinalize:
    def test_output_keys_are_exact_camelcase(self):
        from app.nodes import finalize_node

        state = finalize_node({
            "kind": "replan",
            "request": {
                "daysLeft": 7,
                "deadline": None,
                "tasks": [{"title": "b", "status": "todo", "estMinutes": 30, "priority": 2}],
            },
            "analysis": {"daysLeft": 7},
            "reason": "原始理由",
            "tasks": [
                {
                    "title": "a",
                    "notes": "n",
                    "priority": 1,
                    "estMinutes": 60,
                    "durationDays": 3,
                    "startDate": "2026-09-09",
                    "dueDate": "2026-09-11",
                    "dependsOn": ["x"],  # 悬空引用将被丢弃，但不影响键集合
                },
                {"title": "b", "priority": 2, "estMinutes": 30},
            ],
        })
        keys = {k for t in state["tasks"] for k in t.keys()}
        assert keys <= {"title", "notes", "priority", "estMinutes", "durationDays", "startDate", "dueDate", "dependsOn"}
        assert {"title", "priority", "estMinutes"} <= set(state["tasks"][0].keys())
        assert "finalize" in state and state["finalize"]["finalizeAdjusted"] in (True, False)
        # 可 JSON 序列化（契约出口）
        json.dumps(state["tasks"], ensure_ascii=False)
