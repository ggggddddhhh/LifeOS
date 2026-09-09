"""GitHub 只读进度工具（Phase 4 第一版）。

- 只做 GET，绝不写仓库（不创建/关闭 Issue、不合并 PR）
- 与 Planner 解耦：独立模块 + 依赖注入，返回稳定 Pydantic Schema
- 任何失败都转换为 ok=False 的事实对象，绝不使 graph 失败
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Protocol

import httpx

from .schemas import (
    CIRunBrief,
    CommitBrief,
    GithubFacts,
    IssueBrief,
    PRBrief,
    ProgressReport,
    RepoInfo,
    TaskMatch,
)

DEFAULT_TIMEOUT_S = 10.0
RECENT_CLOSED_DAYS = 14


class GithubClient(Protocol):
    def fetch_facts(self, owner: str, repo: str) -> GithubFacts: ...


_REPO_URL_RE = re.compile(r"github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?=[\s/)'\"，。]|$)")
_REPO_TAG_RE = re.compile(r"repo:([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)")


def extract_repo(*texts: str | None) -> tuple[str, str] | None:
    """从目标标题/描述解析仓库标识：github.com URL 或 repo:owner/name。"""
    for text in texts:
        if not text:
            continue
        m = _REPO_TAG_RE.search(text) or _REPO_URL_RE.search(text)
        if m:
            owner, repo = m.group(1), m.group(2).rstrip(".")
            if repo and repo.lower() not in ("git", ""):
                return owner, repo
    return None


def _parse_dt(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


class HttpGithubClient:
    """真实 GitHub REST 客户端（只读）。GITHUB_API_BASE 可指向测试 stub。"""

    def __init__(self, token: str | None = None, base_url: str | None = None, timeout_s: float | None = None):
        self.base_url = (base_url or os.environ.get("GITHUB_API_BASE") or "https://api.github.com").rstrip("/")
        self.timeout_s = timeout_s or float(os.environ.get("GITHUB_TIMEOUT_S", DEFAULT_TIMEOUT_S))
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "LifeOS-Agent"}
        if token or os.environ.get("GITHUB_TOKEN"):
            headers["Authorization"] = f"Bearer {token or os.environ['GITHUB_TOKEN']}"
        self._client = httpx.Client(timeout=self.timeout_s, headers=headers)

    def _get(self, path: str) -> dict | list | None:
        res = self._client.get(f"{self.base_url}{path}")
        if res.status_code >= 400:
            raise GithubToolError(f"GET {path} → {res.status_code}")
        return res.json()

    def fetch_facts(self, owner: str, repo: str) -> GithubFacts:
        fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        try:
            base = self._get(f"/repos/{owner}/{repo}")
            assert isinstance(base, dict)
            open_raw = self._get(f"/repos/{owner}/{repo}/issues?state=open&per_page=100")
            closed_raw = self._get(f"/repos/{owner}/{repo}/issues?state=closed&per_page=30")
            prs_raw = self._get(f"/repos/{owner}/{repo}/pulls?state=open&per_page=50")
            runs_raw = self._get(f"/repos/{owner}/{repo}/actions/runs?per_page=20")
            commits_raw = self._get(f"/repos/{owner}/{repo}/commits?per_page=10")
        except (httpx.HTTPError, GithubToolError) as e:
            return GithubFacts(ok=False, error=f"{type(e).__name__}: {e}", repo=None, fetched_at=fetched_at)

        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=RECENT_CLOSED_DAYS)

        open_issues = [
            IssueBrief(number=i["number"], title=i.get("title", ""), updated_at=i.get("updated_at"))
            for i in (open_raw or []) if isinstance(i, dict) and "pull_request" not in i
        ][:50]
        closed_recent = [
            IssueBrief(number=i["number"], title=i.get("title", ""), updated_at=i.get("updated_at"))
            for i in (closed_raw or [])
            if isinstance(i, dict) and "pull_request" not in i and (_parse_dt(i.get("closed_at")) or now) >= cutoff
        ][:30]
        open_prs = [
            PRBrief(number=p["number"], title=p.get("title", ""), merged=False, draft=bool(p.get("draft")), updated_at=p.get("updated_at"))
            for p in (prs_raw or []) if isinstance(p, dict)
        ][:30]
        # 每个 workflow 的最新一次运行
        latest: dict[str, CIRunBrief] = {}
        for r in (runs_raw or {}).get("workflow_runs", []):
            name = r.get("name", "")
            if name and name not in latest:
                latest[name] = CIRunBrief(
                    name=name,
                    status=r.get("status", ""),
                    conclusion=r.get("conclusion"),
                    branch=r.get("head_branch", ""),
                    created_at=r.get("created_at"),
                )
        commits = [
            CommitBrief(
                sha=(c.get("sha") or "")[:7],
                message=(c.get("commit", {}).get("message") or "").splitlines()[0][:120],
                date=c.get("commit", {}).get("author", {}).get("date"),
            )
            for c in (commits_raw or []) if isinstance(c, dict)
        ][:10]

        return GithubFacts(
            ok=True,
            error=None,
            repo=RepoInfo(
                full_name=base.get("full_name", f"{owner}/{repo}"),
                description=base.get("description"),
                default_branch=base.get("default_branch", ""),
                pushed_at=base.get("pushed_at"),
                open_issues_count=base.get("open_issues_count", len(open_issues)),
            ),
            open_issues=open_issues,
            closed_recent=closed_recent,
            open_prs=open_prs,
            ci_runs=list(latest.values()),
            commits=commits,
            fetched_at=fetched_at,
        )


class GithubToolError(Exception):
    pass


# ---------------------------------------------------------------- 匹配与进度分析（确定性，无 LLM）

def _norm(s: str) -> str:
    return re.sub(r"[\s，。、,.:：;；!！?？·\-—_/\\()（）\[\]【】\"'']+", "", s.lower())


def _tokens(s: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9\u4e00-\u9fff]+", _norm(s)) if t}


def title_confidence(task_title: str, issue_title: str) -> tuple[float, str] | None:
    """归一化后：精确 1.0 / 子串 0.75 / 词元 Jaccard≥0.5。低于阈值不匹配（宁缺勿错）。"""
    a, b = _norm(task_title), _norm(issue_title)
    if not a or not b:
        return None
    if a == b:
        return 1.0, "exact"
    if a in b or b in a:
        return 0.75, "substring"
    ta, tb = _tokens(task_title), _tokens(issue_title)
    if ta and tb:
        j = len(ta & tb) / len(ta | tb)
        if j >= 0.5:
            return round(j, 2), "jaccard"
    return None


def match_tasks_to_issues(
    tasks: list[dict],
    issues: list[IssueBrief],
    min_confidence: float = 0.5,
) -> list[TaskMatch]:
    out: list[TaskMatch] = []
    for t in tasks:
        best: tuple[float, str, IssueBrief] | None = None
        for issue in issues:
            hit = title_confidence(t.get("title", ""), issue.title)
            if hit and hit[0] >= min_confidence:
                if best is None or hit[0] > best[0]:
                    best = (hit[0], hit[1], issue)
        if best:
            out.append(TaskMatch(
                task_title=t["title"], issue_number=best[2].number, issue_title=best[2].title,
                confidence=best[0], method=best[1],
            ))
    return out


def analyze_progress(facts: GithubFacts, tasks: list[dict]) -> ProgressReport:
    """确定性进度分析：signals=事实观察，inference=明确标注的推断。"""
    if not facts.ok or facts.repo is None:
        return ProgressReport(
            available=False, signals=[],
            matches=[], observed_done=[],
            verdict="unknown", reasons=[f"GitHub 数据不可用: {facts.error or '未知原因'}"],
        )

    signals: list[str] = []
    open_tasks = [t for t in tasks if t.get("status") != "done"]
    open_issue_titles = {i.number: i.title for i in facts.open_issues}
    closed_issue_titles = {i.number: i.title for i in facts.closed_recent}

    signals.append(f"仓库 {facts.repo.full_name}：{len(facts.open_issues)} 个 open issue，{len(facts.open_prs)} 个未合并 PR")
    if facts.open_issues:
        recent = sorted(facts.open_issues, key=lambda i: i.updated_at or "", reverse=True)
        signals.append(f"最近更新的 open issue: #{recent[0].number} {recent[0].title[:60]}")
    if facts.closed_recent:
        signals.append(f"近 {RECENT_CLOSED_DAYS} 天关闭了 {len(facts.closed_recent)} 个 issue")
    for run in facts.ci_runs:
        if run.conclusion and run.conclusion != "success":
            signals.append(f"CI「{run.name}」最新运行结论为 {run.conclusion}")
    for p in facts.open_prs:
        age_hint = f"（草稿）" if p.draft else ""
        signals.append(f"PR #{p.number}「{p.title[:60]}」未合并{age_hint}")
    if facts.repo.pushed_at:
        pushed = _parse_dt(facts.repo.pushed_at)
        if pushed:
            days = (datetime.now(timezone.utc) - pushed).days
            signals.append(f"最近一次 push 距今 {days} 天")
    if facts.commits:
        signals.append(f"最近提交: {facts.commits[0].sha} {facts.commits[0].message[:60]}")

    matches = match_tasks_to_issues(open_tasks, facts.open_issues) + match_tasks_to_issues(open_tasks, facts.closed_recent)
    # observed_done：未完成任务匹配到已关闭 issue（置信度 ≥0.75 才认）
    observed_done: list[str] = []
    closed_matches = match_tasks_to_issues(open_tasks, facts.closed_recent, min_confidence=0.75)
    observed_done = [m.task_title for m in closed_matches]
    if observed_done:
        signals.append(f"以下未完成任务在 GitHub 已有对应 issue 关闭（观察事实）: {'、'.join(observed_done)}")
    _ = open_issue_titles, closed_issue_titles  # 保留给调试

    # 推断（verdict）
    reasons: list[str] = []
    behind = False
    ci_fail = any(r.conclusion and r.conclusion != "success" and r.branch in ("", "main", "master") for r in facts.ci_runs)
    if ci_fail:
        behind = True
        reasons.append("默认分支 CI 最新运行失败，交付质量风险")
    untracked = len(facts.open_issues) - len(matches) + len(observed_done)
    if len(facts.open_issues) > len(open_tasks) and untracked > 0:
        behind = True
        reasons.append(f"仓库有 {len(facts.open_issues)} 个 open issue，而计划未完成任务仅 {len(open_tasks)} 个，存在计划外工作")
    if facts.open_prs:
        behind = True
        reasons.append(f"{len(facts.open_prs)} 个 PR 待处理，关键变更尚未合入")
    if observed_done:
        reasons.append(f"{len(observed_done)} 个任务 GitHub 显示已完成，用户声明可能滞后")
    if not behind:
        reasons.append("无 CI 失败、无积压 PR、issue 规模与任务量相当")
    verdict = "behind" if behind else "on_track"
    return ProgressReport(
        available=True, signals=signals, matches=matches, observed_done=observed_done,
        verdict=verdict, reasons=reasons,
    )
