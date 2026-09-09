"""Phase 4：GitHub 只读工具测试（解析/匹配/进度分析/图分支/降级/闭环 fixture）。"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.github import (
    GithubToolError,
    HttpGithubClient,
    analyze_progress,
    extract_repo,
    match_tasks_to_issues,
    title_confidence,
)
from app.graph import run_plan, run_replan
from app.llm import MockLLM, ScriptedLLM
from app.schemas import (
    CIRunBrief,
    CommitBrief,
    GithubFacts,
    IssueBrief,
    PRBrief,
    RepoInfo,
)
from tests.conftest import scripted


def now_iso(days_ago: float = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat(timespec="seconds")


# ---------------------------------------------------------------- Fake 工具

def make_facts(
    open_issue_titles: list[str],
    closed_issue_titles: list[str] | None = None,
    prs: list[str] | None = None,
    ci_conclusion: str | None = None,
    commits: list[str] | None = None,
    ok: bool = True,
    error: str | None = None,
) -> GithubFacts:
    return GithubFacts(
        ok=ok,
        error=error,
        repo=RepoInfo(full_name="lifeos/demo", default_branch="main", pushed_at=now_iso(0.2), open_issues_count=len(open_issue_titles)) if ok else None,
        open_issues=[IssueBrief(number=i + 1, title=t, updated_at=now_iso(i)) for i, t in enumerate(open_issue_titles)],
        closed_recent=[IssueBrief(number=100 + i, title=t, updated_at=now_iso(1 + i)) for i, t in enumerate(closed_issue_titles or [])],
        open_prs=[PRBrief(number=50 + i, title=t, updated_at=now_iso(4)) for i, t in enumerate(prs or [])],
        ci_runs=[CIRunBrief(name="CI", status="completed", conclusion=ci_conclusion, branch="main", created_at=now_iso(0.1))] if ci_conclusion else [],
        commits=[CommitBrief(sha="abc1234", message=m, date=now_iso(0.1)) for m in (commits or ["feat: x"])],
        fetched_at=now_iso(0),
    )


class FakeGithub:
    def __init__(self, facts: GithubFacts):
        self.facts = facts
        self.calls = 0

    def fetch_facts(self, owner: str, repo: str) -> GithubFacts:
        self.calls += 1
        if isinstance(self.facts, Exception):
            raise self.facts
        return self.facts


class ExplodingGithub:
    def __init__(self):
        self.calls = 0

    def fetch_facts(self, owner: str, repo: str) -> GithubFacts:
        self.calls += 1
        raise httpx.ConnectError("connection refused")


# ---------------------------------------------------------------- 仓库解析

class TestExtractRepo:
    def test_url_in_description(self):
        assert extract_repo("上线 MVP", "仓库 https://github.com/acme/web-app 欢迎") == ("acme", "web-app")

    def test_url_with_trailing_path(self):
        assert extract_repo("见 github.com/acme/web-app/issues", None) == ("acme", "web-app")

    def test_repo_tag(self):
        assert extract_repo("repo:lifeos/demo 的 MVP", None) == ("lifeos", "demo")

    def test_none(self):
        assert extract_repo("7 天内完成这个 GitHub 项目的 MVP", "没有地址") is None


# ---------------------------------------------------------------- 匹配与置信度

class TestMatching:
    def test_exact(self):
        assert title_confidence("实现用户登录", "实现用户登录") == (1.0, "exact")

    def test_substring(self):
        assert title_confidence("实现用户登录", "实现用户登录（含 OAuth）")[0] == 0.75

    def test_jaccard(self):
        c = title_confidence("add login page", "add login page tests")
        assert c is not None and 0.5 <= c[0] < 1.0

    def test_no_false_positive_adversarial(self):
        # 相似但不同义的任务/issue，不允许匹配
        assert title_confidence("部署上线", "部署文档编写") is None
        assert title_confidence("写技术方案文档", "写 API 文档") is None or title_confidence("写技术方案文档", "写 API 文档")[0] < 0.75

    def test_match_tasks_zero_false_positive(self):
        facts = make_facts(
            open_issue_titles=["实现用户登录", "修复登录页样式", "支持暗黑模式"],
            closed_issue_titles=[],
        )
        tasks = [
            {"title": "实现用户登录", "status": "todo"},
            {"title": "编写用户文档", "status": "todo"},  # 不应匹配任何 issue
        ]
        matches = match_tasks_to_issues(tasks, facts.open_issues)
        assert [m.task_title for m in matches] == ["实现用户登录"]
        assert matches[0].confidence == 1.0

    def test_best_match_selected(self):
        facts = make_facts(open_issue_titles=["实现用户登录", "实现用户登录模块重构"])
        matches = match_tasks_to_issues([{"title": "实现用户登录", "status": "todo"}], facts.open_issues)
        assert matches[0].issue_title == "实现用户登录"  # 精确匹配优先于子串


# ---------------------------------------------------------------- 进度分析

class TestAnalyzeProgress:
    def test_behind_verdict_on_ci_failure_and_pr(self):
        facts = make_facts(
            open_issue_titles=[f"任务{i}" for i in range(8)],
            closed_issue_titles=[],
            prs=["重构鉴权中间件"],
            ci_conclusion="failure",
        )
        report = analyze_progress(facts, [{"title": f"任务{i}", "status": "todo"} for i in range(3)])
        assert report.available
        assert report.verdict == "behind"
        assert any("CI" in s for s in report.signals)
        assert any("PR" in s for s in report.signals)
        assert any("8 个 open issue" in s for s in report.signals)
        assert any(r.startswith(("默认分支 CI", "计划外")) for r in report.reasons)

    def test_on_track_when_clean(self):
        facts = make_facts(open_issue_titles=["任务A", "任务B"], closed_issue_titles=[], prs=[], ci_conclusion="success")
        report = analyze_progress(facts, [{"title": "任务A", "status": "todo"}, {"title": "任务B", "status": "todo"}])
        assert report.verdict == "on_track"
        assert report.observed_done == []

    def test_observed_done_via_closed_issue(self):
        facts = make_facts(
            open_issue_titles=["实现用户登录"],
            closed_issue_titles=["设计数据库 Schema"],
        )
        tasks = [
            {"title": "设计数据库 Schema", "status": "todo"},  # 用户声明未完成
            {"title": "实现用户登录", "status": "todo"},
        ]
        report = analyze_progress(facts, tasks)
        assert report.observed_done == ["设计数据库 Schema"]
        assert any("issue 关闭" in s for s in report.signals)

    def test_unavailable_facts(self):
        facts = make_facts([], ok=False, error="HTTPError: 404")
        report = analyze_progress(facts, [{"title": "x", "status": "todo"}])
        assert not report.available
        assert report.verdict == "unknown"
        assert "404" in report.reasons[0]


# ---------------------------------------------------------------- 图分支与降级

REPLAN_REQ = {
    "goalTitle": "7 天内完成 MVP",
    "goalDescription": "仓库 https://github.com/lifeos/demo",
    "daysLeft": 5,
    "tasks": [
        {"title": "设计数据库 Schema", "status": "todo", "estMinutes": 120, "priority": 1},
        {"title": "实现用户登录", "status": "todo", "estMinutes": 240, "priority": 1},
        {"title": "编写用户文档", "status": "todo", "estMinutes": 90, "priority": 3},
    ],
}


class TestGraphBranches:
    def test_with_repo_runs_tool_and_analysis(self):
        gh = FakeGithub(make_facts(open_issue_titles=["实现用户登录"], closed_issue_titles=["设计数据库 Schema"], prs=["关键PR"], ci_conclusion="failure"))
        state = run_replan(REPLAN_REQ, MockLLM(), gh)
        assert gh.calls == 1
        assert state["github"]["ok"] is True
        assert state["progress"]["verdict"] == "behind"
        assert state["progress"]["observed_done"] == ["设计数据库 Schema"]
        assert state["llm_calls"] == 1  # 工具不占 LLM 调用
        assert state.get("error_code") is None

    def test_without_repo_skips_tool_payload_unchanged(self):
        captured = {}

        class Capturing(ScriptedLLM):
            def complete(self, system, user):
                captured["user"] = user
                return super().complete(system, user)

        good = json.dumps({"reason": "按剩余时间重排", "tasks": [{"title": "实现用户登录", "priority": 1, "estMinutes": 60}]})
        llm = Capturing([good])
        req = dict(REPLAN_REQ, goalDescription="没有仓库地址")
        state = run_replan(req, llm, FakeGithub(make_facts(["x"])))
        assert state.get("error_code") is None
        payload = json.loads(captured["user"])
        assert "github_context" not in payload  # 无仓库路径 payload 与 Phase 3 一致
        assert "github_usage" not in payload

    def test_with_repo_payload_contains_context(self):
        captured = {}

        class Capturing(ScriptedLLM):
            def complete(self, system, user):
                captured["user"] = user
                return super().complete(system, user)

        good = json.dumps({"reason": "CI 失败导致落后", "tasks": [{"title": "实现用户登录", "priority": 1, "estMinutes": 60}]})
        llm = Capturing([good])
        run_replan(REPLAN_REQ, llm, FakeGithub(make_facts(["实现用户登录"], ci_conclusion="failure")))
        payload = json.loads(captured["user"])
        assert payload["github_context"]["ok"] is True
        assert payload["progress_report"]["verdict"] == "behind"
        assert "github_usage" in payload

    def test_tool_exception_degrades_not_fails(self):
        gh = ExplodingGithub()
        state = run_replan(REPLAN_REQ, MockLLM(), gh)
        assert gh.calls == 1
        assert state["github"]["ok"] is False, "工具异常必须转为 ok=False 而非让 graph 失败"
        assert state["progress"]["verdict"] == "unknown"
        assert state.get("error_code") is None
        assert len(state["tasks"]) == 3  # 3 个任务均为 open，mock replan 正常完成
        assert state["llm_calls"] == 1

    def test_plan_kind_also_gets_context(self):
        gh = FakeGithub(make_facts(["现有问题A"], ci_conclusion="failure"))
        state = run_plan({"title": "MVP", "description": "github.com/lifeos/demo", "deadline": None}, MockLLM(), gh)
        assert state["progress"]["verdict"] == "behind"
        assert state["llm_calls"] == 1


# ---------------------------------------------------------------- HttpGithubClient 降级（不发真实网络）

class TestHttpClientDegradation:
    def test_404_becomes_ok_false(self, no_llm_env, monkeypatch):
        client = HttpGithubClient(base_url="http://127.0.0.1:9")  # 不可达端口
        facts = client.fetch_facts("lifeos", "demo")
        assert facts.ok is False
        assert facts.repo is None
        assert facts.error

    def test_timeout_becomes_ok_false(self, monkeypatch):
        def slow_get(path):
            raise httpx.ReadTimeout("timed out")

        client = HttpGithubClient.__new__(HttpGithubClient)
        client._get = slow_get
        facts = client.fetch_facts("lifeos", "demo")
        assert facts.ok is False
        assert "Timeout" in facts.error
