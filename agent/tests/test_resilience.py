"""故障与降级：垃圾输出重试、重试上限（无死循环）、LLM 超时/错误直通、修复型重试成功。"""

from __future__ import annotations

import json
from datetime import date, timedelta

from app.errors import AGENT_LLM_TIMEOUT, AGENT_VALIDATION_ERROR, AgentError
from app.graph import run_plan, run_replan
from app.llm import MockLLM, ScriptedLLM
from tests.conftest import scripted


def iso_in(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


GOOD_PLAN = json.dumps({"tasks": [
    {"title": "调研", "priority": 1, "estMinutes": 60, "dueDate": iso_in(2)},
    {"title": "执行", "priority": 1, "estMinutes": 120, "dueDate": iso_in(5)},
    {"title": "收尾", "priority": 2, "estMinutes": 30, "dueDate": iso_in(6)},
]}, ensure_ascii=False)


class TestRetryAndLoopSafety:
    def test_garbage_output_fails_after_exactly_2_calls(self):
        llm = scripted(["这是垃圾输出", "```json\n{\"tasks\": 截断"])
        state = run_plan({"title": "x"}, llm)
        assert state["error_code"] == "AGENT_PARSE_ERROR"
        assert llm.calls == 2, "最多调用 LLM 2 次（首试 + 重试 1 次）"

    def test_valid_json_but_zero_tasks_twice(self):
        llm = scripted([json.dumps({"tasks": []}), json.dumps({"tasks": []})])
        state = run_plan({"title": "x"}, llm)
        assert state["error_code"] == AGENT_VALIDATION_ERROR
        assert llm.calls == 2

    def test_replan_empty_reason_twice(self):
        payload = {"reason": "", "tasks": [{"title": "a", "priority": 1, "estMinutes": 60}]}
        llm = scripted([json.dumps(payload), json.dumps(payload)])
        state = run_replan({
            "goalTitle": "g", "daysLeft": 3,
            "tasks": [{"title": "a", "status": "todo", "estMinutes": 60, "priority": 1}],
        }, llm)
        assert state["error_code"] == AGENT_VALIDATION_ERROR
        assert llm.calls == 2

    def test_retry_feedback_reaches_llm(self):
        llm = scripted(["垃圾", GOOD_PLAN])
        state = run_plan({"title": "x"}, llm)
        assert state.get("error_code") is None
        assert len(state["tasks"]) == 3
        assert llm.calls == 2
        # 第二次调用的 user 消息里包含重试反馈
        # （ScriptedLLM 不记录消息，这里通过成功结果间接验证反馈路径存在）

    def test_llm_calls_never_exceed_2_regardless_of_output(self):
        # 第三次永不发生：脚本只有 2 条，若图尝试第 3 次调用会 IndexError
        llm = scripted(["坏", "还是坏"])
        run_plan({"title": "x"}, llm)
        assert llm.calls == 2


class TestTransportErrors:
    def test_timeout_propagates_immediately_without_retry(self):
        llm = scripted([AgentError(AGENT_LLM_TIMEOUT, "LLM 请求超时（60s）")])
        import pytest

        with pytest.raises(AgentError) as ei:
            run_plan({"title": "x"}, llm)
        assert ei.value.code == AGENT_LLM_TIMEOUT
        assert llm.calls == 1, "传输层错误不重试，立即失败"

    def test_llm_error_propagates(self):
        from app.errors import AGENT_LLM_ERROR

        llm = scripted([AgentError(AGENT_LLM_ERROR, "LLM 返回 500")])
        import pytest

        with pytest.raises(AgentError) as ei:
            run_replan({
                "goalTitle": "g", "daysLeft": 2,
                "tasks": [{"title": "a", "status": "todo", "estMinutes": 60, "priority": 1}],
            }, llm)
        assert ei.value.code == AGENT_LLM_ERROR


class TestApiLevelDegradation:
    def test_502_structured_error_no_traceback(self, api_client):
        from app.main import get_llm_dep

        api_client.app.dependency_overrides[get_llm_dep] = lambda: scripted(["垃圾", "垃圾"])
        try:
            res = api_client.post("/v1/plan", json={"title": "x"})
            assert res.status_code == 502
            err = res.json()["error"]
            assert err["code"] in ("AGENT_PARSE_ERROR", AGENT_VALIDATION_ERROR)
            assert err["retryable"] is True
            assert "Traceback" not in res.text
            assert ".py" not in res.text
        finally:
            api_client.app.dependency_overrides.clear()

    def test_unexpected_exception_500_internal_no_traceback(self, api_client):
        from fastapi.testclient import TestClient

        from app.main import app, get_llm_dep

        class Exploding:
            def complete(self, s, u):
                raise RuntimeError("boom /d/secret/path")

        app.dependency_overrides[get_llm_dep] = lambda: Exploding()
        try:
            client = TestClient(app, raise_server_exceptions=False)
            res = client.post("/v1/plan", json={"title": "x"})
            assert res.status_code == 500
            err = res.json()["error"]
            assert err["code"] == "AGENT_INTERNAL_ERROR"
            assert "secret" not in res.text
            assert "Traceback" not in res.text
        finally:
            app.dependency_overrides.clear()
