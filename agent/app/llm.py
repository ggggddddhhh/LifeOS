"""LLM 接入：OpenAI 兼容客户端（强制 timeout）+ 确定性 MockLLM。
MockLLM 行为镜像 src/lib/llm/index.ts 的 MockLlmClient，保证无 Key 可测试。"""

from __future__ import annotations

import json
import os
import time
from datetime import date, timedelta
from typing import Protocol

import httpx

from .errors import AGENT_LLM_ERROR, AGENT_LLM_TIMEOUT, AgentError

DEFAULT_TIMEOUT_S = 60.0


class LLM(Protocol):
    def complete(self, system: str, user: str) -> str: ...


class OpenAICompatLLM:
    """所有外部调用都带 timeout（读超时可配，连接超时固定 5s）。"""

    def __init__(self, base_url: str, api_key: str, model: str, timeout_s: float = DEFAULT_TIMEOUT_S):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout_s = timeout_s
        self._client = httpx.Client(
            timeout=httpx.Timeout(timeout_s, connect=5.0),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )

    def complete(self, system: str, user: str) -> str:
        try:
            res = self._client.post(
                f"{self.base_url}/chat/completions",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0.3,
                },
            )
        except httpx.TimeoutException as e:
            raise AgentError(AGENT_LLM_TIMEOUT, f"LLM 请求超时（{self.timeout_s}s）") from e
        except httpx.HTTPError as e:
            raise AgentError(AGENT_LLM_ERROR, f"LLM 网络错误: {type(e).__name__}") from e
        if res.status_code >= 400:
            raise AgentError(AGENT_LLM_ERROR, f"LLM 返回 {res.status_code}")
        data = res.json()
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
        if not content:
            raise AgentError(AGENT_LLM_ERROR, "LLM 返回为空")
        return content


class MockLLM:
    """确定性 mock：同输入同输出，不访问网络。镜像 TS MockLlmClient。"""

    def complete(self, system: str, user: str) -> str:
        if "REPLANNER" in system:
            return self._replan(user)
        return self._plan(user)

    def _days_from_iso(self, iso: str | None) -> int:
        if not iso:
            return 14
        try:
            target = date.fromisoformat(iso[:10])
        except ValueError:
            return 14
        return max(1, (target - date.today()).days)

    def _d(self, offset_days: int) -> str:
        return (date.today() + timedelta(days=offset_days)).isoformat()

    def _plan(self, user: str) -> str:
        req = json.loads(user)
        title = req.get("title", "")
        days = self._days_from_iso(req.get("deadline"))
        t1 = f"调研：明确「{title}」的范围与关键产出"
        t2 = f"拆解「{title}」为可执行步骤并确定优先级"
        return json.dumps(
            {
                "tasks": [
                    {"title": t1, "priority": 1, "estMinutes": 60, "startDate": self._d(0), "dueDate": self._d(1)},
                    {"title": t2, "priority": 1, "estMinutes": 90, "startDate": self._d(1), "dueDate": self._d(2), "dependsOn": [t1]},
                    {
                        "title": f"执行核心工作（建议 {max(2, days // 3)} 天内完成主体）",
                        "priority": 1,
                        "estMinutes": min(600, days * 60),
                        "startDate": self._d(2),
                        "dueDate": self._d(max(3, int(days * 0.7))),
                        "dependsOn": [t2],
                    },
                    {"title": "整合产出并自查质量", "priority": 2, "estMinutes": 60, "dueDate": self._d(max(4, days - 1))},
                    {"title": "每日复盘推进（周期型）", "priority": 3, "estMinutes": 15, "durationDays": min(days, 14), "startDate": self._d(0)},
                ]
            },
            ensure_ascii=False,
        )

    def _replan(self, user: str) -> str:
        req = json.loads(user)
        days_left = max(1, int(req.get("daysLeft", 14)))
        tasks = req.get("tasks", [])
        open_tasks = [t for t in tasks if t.get("status") != "done"]
        # 与 TS mock 一致：perDay = max(30, round(未完成总估时 / 剩余天数))
        per_day = max(30, round(sum(t.get("estMinutes", 0) for t in open_tasks) / max(1, days_left)))
        return json.dumps(
            {
                "reason": f"剩余 {days_left} 天，未完成任务 {len(open_tasks)} 项，已按每日约 {per_day} 分钟重新排期并压缩估时。",
                "tasks": [
                    {
                        "title": t["title"],
                        "priority": t.get("priority", 2),
                        "estMinutes": max(15, min(t.get("estMinutes", 60), per_day)),
                        "dueDate": self._d(min(days_left, 1 + ((i + 1) * days_left) // max(1, len(open_tasks)))),
                    }
                    for i, t in enumerate(open_tasks)
                ],
            },
            ensure_ascii=False,
        )


def get_llm() -> LLM:
    """环境三件套齐全走真实 LLM，否则降级 MockLLM（与 TS getLlmClient 同规则）。"""
    base_url = os.environ.get("LLM_BASE_URL", "")
    api_key = os.environ.get("LLM_API_KEY", "")
    model = os.environ.get("LLM_MODEL", "")
    if base_url and api_key and model:
        timeout_s = float(os.environ.get("LLM_TIMEOUT_S", DEFAULT_TIMEOUT_S))
        return OpenAICompatLLM(base_url, api_key, model, timeout_s)
    return MockLLM()


def llm_mode() -> str:
    return "llm" if os.environ.get("LLM_BASE_URL") and os.environ.get("LLM_API_KEY") and os.environ.get("LLM_MODEL") else "mock"


class CountingLLM:
    """测试用：包装任意 LLM 并统计调用次数（验证重试上限/无死循环）。"""

    def __init__(self, inner: LLM):
        self.inner = inner
        self.calls = 0

    def complete(self, system: str, user: str) -> str:
        self.calls += 1
        return self.inner.complete(system, user)


class ScriptedLLM:
    """测试用：按脚本顺序返回/抛错。"""

    def __init__(self, script: list):
        self.script = list(script)
        self.calls = 0

    def complete(self, system: str, user: str) -> str:
        self.calls += 1
        step = self.script.pop(0) if self.script else self.script
        if isinstance(step, Exception):
            raise step
        return step


def monotonic_ms() -> float:
    return time.monotonic() * 1000
