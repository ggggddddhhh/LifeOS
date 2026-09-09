"""API 契约测试：schema、camelCase 字段、健康检查、422/502 结构化错误。"""

from __future__ import annotations

from datetime import date, timedelta

from app.llm import MockLLM


def iso_in(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


class TestHealth:
    def test_shape(self, api_client):
        res = api_client.get("/health")
        assert res.status_code == 200
        body = res.json()
        assert body["ok"] is True
        assert body["service"] == "lifeos-agent"
        assert body["mode"] == "mock"
        assert body["promptVersion"] == "2"
        assert body["graph"] == "analyze->[github_tool->progress_analysis|]plan|replan->validate->finalize"
        assert body["tools"] == ["github(readonly)"]
        assert body["maxLlmCalls"] == 2


class TestPlanContract:
    def test_mock_plan_fields(self, api_client):
        res = api_client.post("/v1/plan", json={"title": "两周内上线博客", "deadline": iso_in(14)})
        assert res.status_code == 200
        body = res.json()
        assert len(body["tasks"]) == 5
        allowed = {"title", "notes", "priority", "estMinutes", "durationDays", "startDate", "dueDate", "dependsOn"}
        for t in body["tasks"]:
            assert set(t.keys()) <= allowed, "不允许出现契约外字段"
            assert isinstance(t["title"], str) and t["title"]
            assert t["priority"] in (1, 2, 3)
            assert isinstance(t["estMinutes"], int)
        assert any("durationDays" in t for t in body["tasks"])

    def test_empty_title_422_stable_code(self, api_client):
        res = api_client.post("/v1/plan", json={"title": ""})
        assert res.status_code == 422
        err = res.json()["error"]
        assert err["code"] == "AGENT_INPUT_INVALID"
        assert err["retryable"] is False
        assert "traceback" not in res.text.lower()

    def test_missing_title_422(self, api_client):
        assert api_client.post("/v1/plan", json={}).status_code == 422

    def test_prompt_version_header(self, api_client):
        res = api_client.post("/v1/plan", json={"title": "x"})
        assert res.status_code == 200
        assert res.headers["x-prompt-version"] == "2"
        assert res.headers["x-llm-calls"] == "1"  # mock 一次成功

    def test_replan_prompt_version_header(self, api_client):
        res = api_client.post("/v1/replan", json={
            "goalTitle": "g", "daysLeft": 2,
            "tasks": [{"title": "a", "status": "todo", "estMinutes": 60, "priority": 1}],
        })
        assert res.status_code == 200
        assert res.headers["x-prompt-version"] == "2"


class TestReplanContract:
    def test_mock_replan(self, api_client):
        res = api_client.post("/v1/replan", json={
            "goalTitle": "雅思 6.5",
            "daysLeft": 3,
            "tasks": [
                {"title": "口语训练", "status": "in_progress", "estMinutes": 300, "priority": 1},
                {"title": "全真模考", "status": "todo", "estMinutes": 200, "priority": 2},
            ],
        })
        assert res.status_code == 200
        body = res.json()
        assert body["reason"]
        assert [t["title"] for t in body["tasks"]] == ["口语训练", "全真模考"]

    def test_empty_tasks_422(self, api_client):
        res = api_client.post("/v1/replan", json={"goalTitle": "g", "daysLeft": 3, "tasks": []})
        assert res.status_code == 422
        assert res.json()["error"]["code"] == "AGENT_INPUT_INVALID"

    def test_invalid_status_422(self, api_client):
        res = api_client.post("/v1/replan", json={
            "goalTitle": "g", "daysLeft": 3,
            "tasks": [{"title": "a", "status": "blocked", "estMinutes": 60, "priority": 1}],
        })
        assert res.status_code == 422
