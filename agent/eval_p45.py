"""Phase 4.5：GitHub Context 的 A/B 价值评测。

每场景三臂：
  A = 无 Context（描述去掉 repo 标识，其余逐字段一致）
  B = 有 Context（repo:eval/<场景名> 指向内嵌 stub，提供 fixture 事实）
  C = 降级臂（repo 存在但工具故障，仅部分场景）
真实 LLM（LLM_API_KEY 环境三件套），输出 docs/eval/p45-results.json。
ground truth 由场景 fixture 声明（世界状态，不是答案模板）。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.github import HttpGithubClient
from app.graph import run_replan
from app.llm import OpenAICompatLLM
from app.schemas import CIRunBrief, CommitBrief, GithubFacts, IssueBrief, PRBrief, RepoInfo

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "eval", "p45-results.json")
STUB_PORT = 8960


def days_ago(d: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=d)).isoformat(timespec="seconds")


def facts(
    open_titles: list[str] | None = None,
    closed_titles: list[str] | None = None,
    prs: list[str] | None = None,
    ci: str | None = None,
    pushed: float | None = 0.3,
) -> dict:
    """GitHub stub 数据（dict 形式，供 HTTP 端点直接返回）。"""
    return {
        "repo": {"full_name": "", "description": None, "default_branch": "main", "pushed_at": days_ago(pushed) if pushed is not None else None, "open_issues_count": len(open_titles or [])},
        "open": [{"number": i + 1, "title": t, "state": "open", "updated_at": days_ago(1)} for i, t in enumerate(open_titles or [])],
        "closed": [{"number": 100 + i, "title": t, "state": "closed", "closed_at": days_ago(2), "updated_at": days_ago(2)} for i, t in enumerate(closed_titles or [])],
        "prs": [{"number": 50 + i, "title": t, "draft": False, "updated_at": days_ago(12)} for i, t in enumerate(prs or [])],
        "runs": {"workflow_runs": ([{"name": "CI", "status": "completed", "conclusion": ci, "head_branch": "main", "created_at": days_ago(0.2)}] if ci else [])},
        "commits": [{"sha": "abcdef1", "commit": {"message": "chore: routine", "author": {"date": days_ago(0.3)}}}],
    }


T = lambda t, s, m, p, due=None: {"title": t, "status": s, "estMinutes": m, "priority": p, **({"dueDate": due} if due else {})}  # noqa: E731

# ---------------------------------------------------------------- 12 个固定场景（覆盖 7 类情况）

SCENARIOS = [
    {
        "key": "scn01_ci_fail", "type": "CI 失败",
        "goal": "7 天内完成项目 MVP 上线",
        "daysLeft": 6,
        "tasks": [
            T("实现用户登录", "in_progress", 240, 1), T("修复 CI 失败", "todo", 90, 2, "2026-09-11"),
            T("编写单元测试", "todo", 180, 2), T("部署到生产环境", "todo", 90, 2), T("编写用户文档", "todo", 90, 3),
        ],
        "gh": facts(open_titles=["实现用户登录", "修复 CI 失败", "支持暗黑模式"], ci="failure"),
        "gt_matches": {"实现用户登录": 1, "修复 CI 失败": 2}, "gt_done": [],
        "expect_reason": ["CI"],
    },
    {
        "key": "scn02_stale_pr", "type": "PR 长时间未合并",
        "goal": "两周内发布 v2.0 版本",
        "daysLeft": 5,
        "tasks": [
            T("重构鉴权中间件", "in_progress", 300, 1), T("更新 API 文档", "todo", 120, 2),
            T("回归测试", "todo", 180, 2), T("发布公告", "todo", 60, 3),
        ],
        "gh": facts(open_titles=["更新 API 文档"], prs=["重构鉴权中间件（关键变更）"], ci="success"),
        "gt_matches": {"更新 API 文档": 1}, "gt_done": [],  # PR 不参与 issue 匹配（设计如此），PR 风险经 signals 呈现
        "expect_reason": ["PR", "合并"],
    },
    {
        "key": "scn03_closed_done", "type": "Issue 已关但任务未完",
        "goal": "7 天内完成这个 GitHub 项目的 MVP",
        "daysLeft": 6,
        "tasks": [
            T("设计数据库 Schema", "todo", 120, 1), T("实现用户登录", "in_progress", 240, 1),
            T("修复 CI 失败", "todo", 90, 2), T("部署到生产环境", "todo", 90, 2), T("编写用户文档", "todo", 90, 3),
        ],
        "gh": facts(open_titles=["实现用户登录", "修复 CI 失败"], closed_titles=["设计数据库 Schema"], ci="success"),
        "gt_matches": {"设计数据库 Schema": 100, "实现用户登录": 1, "修复 CI 失败": 2}, "gt_done": ["设计数据库 Schema"],
        "expect_reason": ["#100|关闭"],
    },
    {
        "key": "scn04_untracked", "type": "新增计划外 Issue",
        "goal": "5 天内完成订单系统迭代",
        "daysLeft": 4,
        "tasks": [
            T("实现购物车功能", "in_progress", 240, 1), T("接入支付网关", "todo", 180, 1),
            T("编写集成测试", "todo", 120, 2),
        ],
        "gh": facts(open_titles=["实现购物车功能", "修复支付回调偶发失败", "订单导出内存溢出", "支持批量退款"], ci="success"),
        "gt_matches": {"实现购物车功能": 1}, "gt_done": [],
        "expect_reason": ["计划外|issue|开放"],
    },
    {
        "key": "scn05_conflict", "type": "用户声明与 GitHub 冲突",
        "goal": "一周内完成支付模块",
        "daysLeft": 5,
        "tasks": [
            T("实现支付回调", "done", 180, 1), T("接入退款流程", "todo", 240, 1),
            T("支付对账脚本", "todo", 120, 2),
        ],
        "gh": facts(open_titles=["实现支付回调", "接入退款流程"], ci="success"),
        "gt_matches": {"接入退款流程": 2}, "gt_done": [],  # done 任务不进 matches，走 conflicts 通道
        "conflict_gt": [("实现支付回调", 1)],
        "expect_reason": ["冲突"],
        "special": "conflict",
    },
    {
        "key": "scn06_no_info", "type": "无相关 GitHub 信息",
        "goal": "一周内完成公司官网改版",
        "daysLeft": 6,
        "tasks": [
            T("设计官网视觉稿", "in_progress", 300, 1), T("切图并搭建页面", "todo", 360, 1),
            T("SEO 基础优化", "todo", 90, 2),
        ],
        "gh": facts(open_titles=["内部工具字体加载问题", "会议室预订系统改版"], ci="success"),
        "gt_matches": {}, "gt_done": [],
        "expect_reason": [],
        "special": "no_interference",
    },
    {
        "key": "scn07_similar_not_same", "type": "标题相似实非同任务",
        "goal": "一周内完成发版准备",
        "daysLeft": 5,
        "tasks": [
            T("部署上线", "todo", 120, 1), T("准备发版说明", "todo", 60, 2),
            T("线上回归验证", "todo", 90, 1),
        ],
        "gh": facts(open_titles=["部署文档编写", "准备发版物料"], closed_titles=[], ci="success"),
        "gt_matches": {}, "gt_done": [],  # 相似但不同义：正确行为是全部不匹配
        "expect_reason": [],
        "special": "no_false_match",
    },
    {
        "key": "scn08_mixed", "type": "复合（CI+PR+已关+计划外）",
        "goal": "7 天内完成这个 GitHub 项目的 MVP",
        "daysLeft": 4,
        "tasks": [
            T("设计数据库 Schema", "todo", 120, 1), T("实现用户登录", "in_progress", 240, 1),
            T("修复 CI 失败", "todo", 90, 2), T("编写用户文档", "todo", 90, 3),
        ],
        "gh": facts(open_titles=["实现用户登录", "修复 CI 失败", "修复数据库连接池泄漏"], closed_titles=["设计数据库 Schema"], prs=["实现用户登录（含 OAuth）"], ci="failure"),
        "gt_matches": {"设计数据库 Schema": 100, "实现用户登录": 1, "修复 CI 失败": 2}, "gt_done": ["设计数据库 Schema"],
        "expect_reason": ["CI"],
    },
    {
        "key": "scn09_advance", "type": "进度领先（多 issue 已关）",
        "goal": "两周内完成搜索功能上线",
        "daysLeft": 8,
        "tasks": [
            T("实现搜索索引", "todo", 300, 1), T("搜索结果高亮", "todo", 120, 2),
            T("性能压测", "todo", 120, 2),
        ],
        "gh": facts(open_titles=[], closed_titles=["实现搜索索引", "搜索结果高亮"], ci="success"),
        "gt_matches": {"实现搜索索引": 100, "搜索结果高亮": 101}, "gt_done": ["实现搜索索引", "搜索结果高亮"],
        "expect_reason": [],
    },
    {
        "key": "scn10_normal", "type": "正常进度",
        "goal": "一周内完成通知服务",
        "daysLeft": 6,
        "tasks": [
            T("实现邮件通知", "in_progress", 180, 1), T("实现站内信", "todo", 180, 2),
            T("通知偏好设置", "todo", 120, 2),
        ],
        "gh": facts(open_titles=["实现邮件通知", "实现站内信"], ci="success"),
        "gt_matches": {"实现邮件通知": 1, "实现站内信": 2}, "gt_done": [],
        "expect_reason": [],
    },
    {
        "key": "scn11_zh_en", "type": "中英标题不互译",
        "goal": "一周内完成国际化改造",
        "daysLeft": 6,
        "tasks": [
            T("抽取界面文案", "in_progress", 180, 1), T("接入翻译平台", "todo", 240, 1),
            T("回归多语言页面", "todo", 120, 2),
        ],
        "gh": facts(open_titles=["Extract UI strings to i18n bundles", "Connect translation vendor API"], ci="success"),
        "gt_matches": {}, "gt_done": [],
        "expect_reason": [],
        "special": "no_interference",
    },
    {
        "key": "scn12_not_found", "type": "仓库不存在（降级）",
        "goal": "一周内完成内部工具重构",
        "daysLeft": 6,
        "tasks": [
            T("梳理现有模块", "in_progress", 120, 1), T("拆分服务边界", "todo", 300, 1),
            T("补充集成测试", "todo", 180, 2),
        ],
        "gh": None,  # 404
        "gt_matches": {}, "gt_done": [],
        "expect_reason": [],
        "special": "degradation",
    },
]

DEGRADATION_KEYS = {"scn12_not_found", "scn01_ci_fail", "scn05_conflict"}  # C 臂覆盖三种场景类型


# ---------------------------------------------------------------- stub GitHub 服务

class StubHandler(BaseHTTPRequestHandler):
    scenarios = {s["key"]: s for s in SCENARIOS}

    def log_message(self, *a):
        pass

    def _json(self, code: int, body):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_GET(self):
        m = re.match(r"^/repos/eval/([a-z0-9_]+)(.*)$", self.path.split("?")[0])
        if not m:
            return self._json(404, {"message": "Not Found"})
        scn = self.scenarios.get(m.group(1))
        if scn is None or scn["gh"] is None:
            return self._json(404, {"message": "Not Found"})
        g = dict(scn["gh"])
        g["repo"]["full_name"] = f"eval/{m.group(1)}"
        part = m.group(2)
        if part == "":
            return self._json(200, g["repo"])
        if part == "/issues":
            state = "state=closed" in self.path  # 精确匹配查询参数（场景名可能含 closed）
            return self._json(200, g["closed"] if state else g["open"])
        if part == "/pulls":
            return self._json(200, g["prs"])
        if part == "/actions/runs":
            return self._json(200, g["runs"])
        if part == "/commits":
            return self._json(200, g["commits"])
        return self._json(404, {"message": "Not Found"})


class ExplodingGithub:
    def fetch_facts(self, owner, repo):
        import httpx

        raise httpx.ConnectError("connection refused")


# ---------------------------------------------------------------- 指标

def titles_normalized(tasks):
    from app.github import _norm

    return {_norm(t["title"]) for t in tasks}


def check_reason(reason: str, patterns: list[str]) -> list[str]:
    missed = []
    for p in patterns:
        alts = p.split("|")
        if not any(a in reason for a in alts):
            missed.append(p)
    return missed


def run_arm(req, llm, github):
    t0 = time.monotonic()
    state = run_replan(req, llm, github)
    ms = round((time.monotonic() - t0) * 1000)
    return state, ms


def main():
    base = os.environ.get("LLM_BASE_URL")
    key = os.environ.get("LLM_API_KEY")
    model = os.environ.get("LLM_MODEL")
    if not (base and key and model):
        print("缺少 LLM 环境变量，跳过（需 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）")
        return 1
    llm = OpenAICompatLLM(base, key, model)

    server = ThreadingHTTPServer(("127.0.0.1", STUB_PORT), StubHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    gh = HttpGithubClient(base_url=f"http://127.0.0.1:{STUB_PORT}", timeout_s=10)

    results = []
    for scn in SCENARIOS:
        repo_tag = f"repo:eval/{scn['key']}"
        desc_with = f"{repo_tag} 相关项目"
        desc_without = "相关项目"
        base_req = {"goalTitle": scn["goal"], "daysLeft": scn["daysLeft"], "tasks": scn["tasks"]}
        row = {"key": scn["key"], "type": scn["type"]}

        # A 臂：无 Context
        state_a, ms_a = run_arm({**base_req, "goalDescription": desc_without}, llm, None)
        # B 臂：有 Context
        state_b, ms_b = run_arm({**base_req, "goalDescription": desc_with}, llm, gh)
        # C 臂：降级（repo 存在，工具故障）
        if scn["key"] in DEGRADATION_KEYS:
            state_c, ms_c = run_arm({**base_req, "goalDescription": desc_with}, llm, ExplodingGithub())
            row["degradation"] = {
                "ok": state_c.get("error_code") is None,
                "taskCount": len(state_c.get("tasks") or []),
                # 编造检测：只认 issue 编号引用（任务标题可能天然含 CI/PR 字样）
                "fabricatedGithub": bool(re.search(r"#\d+", state_c.get("reason", ""))),
                "latencyMs": ms_c,
            }

        tasks_a = state_a.get("tasks") or []
        tasks_b = state_b.get("tasks") or []
        progress = state_b.get("progress") or {}

        # 匹配误差（B 臂内部 matches vs ground truth）
        got_matches = {m["task_title"]: m["issue_number"] for m in progress.get("matches", [])}
        match_errors = [t for t, num in got_matches.items() if scn["gt_matches"].get(t) != num]
        missed_matches = [t for t in scn["gt_matches"] if t not in got_matches]
        got_done = set(progress.get("observed_done", []))
        done_errors = sorted(got_done - set(scn["gt_done"]))
        done_missed = sorted(set(scn["gt_done"]) - got_done)

        changed = titles_normalized(tasks_a) != titles_normalized(tasks_b)
        # 事实引用检测：只认 GitHub 专有词（避免"合并任务"这类常规 replan 用语误报）
        cited = bool(re.search(r"#\d+|issue|PR|CI|GitHub|仓库", state_b.get("reason", "")))
        reason_missed = check_reason(state_b.get("reason", ""), scn["expect_reason"])

        special_ok = True
        sp = scn.get("special")
        if sp == "no_interference":
            special_ok = titles_normalized(tasks_a) == titles_normalized(tasks_b)
        elif sp == "no_false_match":
            special_ok = "部署上线" not in got_matches
        elif sp == "conflict":
            conflicts = progress.get("conflicts", [])
            # 冲突被显式标注且 reason 提及冲突；done 任务未被无说明地复活为新任务
            resurrected_silently = "实现支付回调" in {t["title"] for t in tasks_b} and "冲突" not in state_b.get("reason", "")
            special_ok = len(conflicts) >= 1 and "冲突" in state_b.get("reason", "") and not resurrected_silently
        elif sp == "degradation":
            special_ok = state_b.get("error_code") is None

        row.update({
            "okA": state_a.get("error_code") is None, "okB": state_b.get("error_code") is None,
            "latencyA": ms_a, "latencyB": ms_b, "toolOverheadMs": ms_b - ms_a,
            "taskCountA": len(tasks_a), "taskCountB": len(tasks_b),
            "changed": changed, "citedFacts": cited,
            "reasonA": state_a.get("reason", ""), "reasonB": state_b.get("reason", ""),
            "verdict": progress.get("verdict"),
            "matchErrors": match_errors, "missedMatches": missed_matches,
            "doneErrors": done_errors, "doneMissed": done_missed,
            "reasonExpectMissed": reason_missed,
            "specialOk": special_ok,
        })
        results.append(row)
        print(
            f"[{scn['key']}] {scn['type']}: changed={changed} cited={cited} verdict={row['verdict']} "
            f"matchErr={len(match_errors)} doneErr={len(done_errors)} specialOk={special_ok} Δ{row['toolOverheadMs']}ms"
        )

    server.shutdown()
    summary = {
        "ranAt": datetime.now(timezone.utc).isoformat(),
        "model": model,
        "scenarios": len(results),
        "bOk": sum(r["okB"] for r in results),
        "changedRate": sum(r["changed"] for r in results) / len(results),
        "citedRate": sum(r["citedFacts"] for r in results) / len(results),
        "matchErrorTotal": sum(len(r["matchErrors"]) for r in results),
        "missedMatchTotal": sum(len(r["missedMatches"]) for r in results),
        "doneErrorTotal": sum(len(r["doneErrors"]) for r in results),
        "doneMissedTotal": sum(len(r["doneMissed"]) for r in results),
        "specialOkRate": sum(r["specialOk"] for r in results) / len(results),
        "reasonExpectMetRate": sum(not r["reasonExpectMissed"] for r in results) / len(results),
        "avgToolOverheadMs": sum(r["toolOverheadMs"] for r in results) / len(results),
        "degradation": [r["degradation"] for r in results if "degradation" in r],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "results": results}, f, ensure_ascii=False, indent=2)
    print("\n== summary ==")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
