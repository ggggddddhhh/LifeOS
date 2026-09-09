"""共享 fixture：无 Key 环境 + Fake LLM 注入。"""

from __future__ import annotations

import pytest

from app.llm import MockLLM, ScriptedLLM


@pytest.fixture(autouse=True)
def no_llm_env(monkeypatch):
    """强制 mock 模式，测试永不依赖真实 LLM。"""
    monkeypatch.setenv("LLM_BASE_URL", "")
    monkeypatch.setenv("LLM_API_KEY", "")
    monkeypatch.setenv("LLM_MODEL", "")


@pytest.fixture
def mock_llm() -> MockLLM:
    return MockLLM()


@pytest.fixture
def api_client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


def scripted(steps: list) -> ScriptedLLM:
    return ScriptedLLM(steps)
