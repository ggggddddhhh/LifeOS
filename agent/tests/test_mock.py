"""MockLLM 与图行为：确定性、无 Key 降级、mock 输出通过完整 graph。"""

from __future__ import annotations

import json
from datetime import date, timedelta

from app.graph import run_plan, run_replan
from app.llm import MockLLM, get_llm


def iso_in(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


class TestMockLLM:
    def test_deterministic_plan(self):
        m = MockLLM()
        a = m.complete("sys", json.dumps({"title": "学 Rust", "deadline": iso_in(30)}))
        b = m.complete("sys", json.dumps({"title": "学 Rust", "deadline": iso_in(30)}))
        assert a == b

    def test_deterministic_replan(self):
        m = MockLLM()
        payload = json.dumps({
            "goalTitle": "g", "daysLeft": 3,
            "tasks": [{"title": "a", "status": "todo", "estMinutes": 120, "priority": 1}],
        })
        assert m.complete("REPLANNER...", payload) == m.complete("REPLANNER...", payload)

    def test_no_env_returns_mock(self, no_llm_env):
        assert isinstance(get_llm(), MockLLM)


class TestGraphWithMock:
    def test_plan_produces_5_tasks_with_contract_fields(self, mock_llm):
        state = run_plan({"title": "两周内上线博客", "deadline": iso_in(14)}, mock_llm)
        assert state.get("error_code") is None
        tasks = state["tasks"]
        assert len(tasks) == 5
        assert any(t.get("durationDays") for t in tasks), "应包含周期型任务"
        assert any(t.get("dependsOn") for t in tasks), "应包含依赖"
        assert all(t["estMinutes"] >= 10 for t in tasks)
        assert state["llm_calls"] == 1

    def test_replan_keeps_open_titles_only(self, mock_llm):
        req = {
            "goalTitle": "雅思 6.5",
            "daysLeft": 3,
            "tasks": [
                {"title": "买词汇书", "status": "done", "estMinutes": 30, "priority": 1},
                {"title": "口语训练", "status": "in_progress", "estMinutes": 300, "priority": 1},
                {"title": "全真模考", "status": "todo", "estMinutes": 200, "priority": 2},
            ],
        }
        state = run_replan(req, mock_llm)
        assert state.get("error_code") is None
        titles = [t["title"] for t in state["tasks"]]
        assert titles == ["口语训练", "全真模考"]
        assert "买词汇书" not in titles
        assert state["reason"].startswith("剩余 3 天")
        assert state["llm_calls"] == 1
