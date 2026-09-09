"""Phase 5 A/B 评测：仅 GitHub Context vs GitHub + Calendar Context。

同一批项目型目标（含重点场景：7 天上线但前 3 天每天仅 1h、后 4 天每天 4h），
两臂除 Calendar 工具外逐字段一致。真实 LLM，输出 docs/eval/p5-results.json。
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import date, timedelta

from app.calendar import DEFAULT_DAILY_WINDOW_MINUTES, StaticCalendarClient, analyze_capacity
from app.github import HttpGithubClient
from app.graph import run_replan
from app.llm import OpenAICompatLLM
from app.schemas import DayBusy
from tests.test_github import FakeGithub, make_facts as gh_facts

OUT = os.path.join(os.path.dirname(__file__), "..", "docs", "eval", "p5-results.json")
STUB_PORT = 8961
W = DEFAULT_DAILY_WINDOW_MINUTES  # 720


def day(i: int, busy: int, events: int = 0, all_day: bool = False) -> DayBusy:
    return DayBusy(date=(date.today() + timedelta(days=i)).isoformat(), busy_minutes=busy, event_count=events, all_day_event=all_day)


T = lambda t, m, p: {"title": t, "status": "todo", "estMinutes": m, "priority": p}  # noqa: E731

HEAVY_TASKS = [
    T("实现核心 API", 300, 1), T("实现前端页面", 300, 1), T("集成测试", 180, 2),
    T("修复 CI 失败", 90, 2), T("编写部署脚本", 120, 2), T("用户文档", 90, 3),
]  # 共 1080 分钟

SCENARIOS = [
    {
        "key": "focal_3x1h_4x4h", "type": "重点：前3天1h后4天4h",
        "goal": "7 天后上线这个 GitHub 项目", "repo": "repo:eval/focal",
        # 负载 ~1980min > 真实容量 1140 → G 臂（默认 3360）全保留，GC 臂必须压缩
        "daysLeft": 7, "tasks": HEAVY_TASKS + [T("性能优化", 300, 2), T("安全审计", 300, 2), T("监控接入", 300, 3)],
        "cal": [day(i, W - 60, 3) for i in range(3)] + [day(i, W - 240, 4) for i in range(3, 7)],
        "gh": gh_facts(open_issue_titles=["实现核心 API", "修复 CI 失败"], ci_conclusion="failure"),
    },
    {
        "key": "all_day_2days", "type": "前2天全天事件",
        "goal": "5 天内完成发版", "repo": "repo:eval/allday",
        "daysLeft": 5, "tasks": HEAVY_TASKS[:4],
        "cal": [day(0, W, 1, all_day=True), day(1, W, 1, all_day=True)] + [day(i, 120, 2) for i in range(2, 5)],
        "gh": gh_facts(open_issue_titles=["实现核心 API"], prs=["发版准备"]),
    },
    {
        "key": "busy_week", "type": "整周半忙",
        "goal": "7 天内完成订单迭代", "repo": "repo:eval/busy",
        "daysLeft": 7, "tasks": HEAVY_TASKS,
        "cal": [day(i, 420, 5) for i in range(7)],  # 每天推断 300
        "gh": gh_facts(open_issue_titles=["实现核心 API", "实现前端页面"], ci_conclusion="success"),
    },
    {
        "key": "free_week", "type": "完全空闲周（容量高于默认）",
        "goal": "7 天内完成搜索功能", "repo": "repo:eval/free",
        "daysLeft": 7, "tasks": HEAVY_TASKS,
        "cal": [day(i, 0, 0) for i in range(7)],
        "gh": gh_facts(open_issue_titles=["实现核心 API"], ci_conclusion="success"),
    },
    {
        "key": "conflict_declared", "type": "声明与日历冲突",
        "goal": "7 天内完成支付模块", "repo": "repo:eval/conflict",
        "daysLeft": 7, "tasks": HEAVY_TASKS[:5],
        "cal": [day(i, 600, 6) for i in range(7)],  # 推断 120/天
        "declared": [480] * 7,  # 声明 480/天
        "gh": gh_facts(open_issue_titles=["实现核心 API"], ci_conclusion="success"),
    },
    {
        "key": "dense_meetings", "type": "会议密集",
        "goal": "6 天内完成重构", "repo": "repo:eval/dense",
        "daysLeft": 6, "tasks": HEAVY_TASKS[:5],
        "cal": [day(i, 660, 7) for i in range(6)],  # 推断 60/天
        "gh": gh_facts(open_issue_titles=["实现核心 API"], ci_conclusion="failure"),
    },
]


def run(req, llm, gh, cal):
    t0 = time.monotonic()
    state = run_replan(req, llm, gh, cal)
    return state, round((time.monotonic() - t0) * 1000)


def main():
    base, key, model = os.environ.get("LLM_BASE_URL"), os.environ.get("LLM_API_KEY"), os.environ.get("LLM_MODEL")
    if not (base and key and model):
        print("缺少 LLM 环境变量")
        return 1
    llm = OpenAICompatLLM(base, key, model)

    from http.server import ThreadingHTTPServer

    # stub GitHub 不需要（直接用 FakeGithub 注入）

    results = []
    for scn in SCENARIOS:
        base_req = {"goalTitle": scn["goal"], "goalDescription": scn["repo"], "daysLeft": scn["daysLeft"], "tasks": scn["tasks"]}
        if scn.get("declared"):
            base_req["declaredMinutesPerDay"] = scn["declared"]

        gh = FakeGithub(scn["gh"])
        state_g, ms_g = run(base_req, llm, gh, None)              # A：仅 GitHub
        gh2 = FakeGithub(scn["gh"])
        cal = StaticCalendarClient(scn["cal"])
        state_gc, ms_gc = run(base_req, llm, gh2, cal)            # B：GitHub + Calendar

        cap = (state_gc.get("capacity") or {})
        capacity = cap.get("capacity_minutes")
        total_g = sum(t["estMinutes"] for t in state_g.get("tasks") or [])
        total_gc = sum(t["estMinutes"] for t in state_gc.get("tasks") or [])
        zero_days = {d["date"] for d in (state_gc.get("calendar") or {}).get("days", []) if d.get("all_day_event")}
        due_on_zero = [
            t["title"] for t in (state_gc.get("tasks") or [])
            if t.get("dueDate") and t["dueDate"] in zero_days
        ]
        reason_gc = state_gc.get("reason", "")

        row = {
            "key": scn["key"], "type": scn["type"],
            "okG": state_g.get("error_code") is None, "okGC": state_gc.get("error_code") is None,
            "latencyG": ms_g, "latencyGC": ms_gc,
            "capacityMinutes": capacity, "capacitySource": cap.get("source"),
            "totalEstG": total_g, "totalEstGC": total_gc,
            "taskCountG": len(state_g.get("tasks") or []), "taskCountGC": len(state_gc.get("tasks") or []),
            # 可执行性核心指标
            "gExceedsRealCapacity": capacity is not None and total_g > capacity,
            "gcWithinCapacity": capacity is not None and total_gc <= capacity + 30,  # 下限 15min/任务容差
            "reasonMentionsCapacity": bool(re.search(r"容量|空闲|可用|日历|分钟", reason_gc)),
            "conflicts": len(cap.get("conflicts") or []),
            "dueOnAllDayEvent": due_on_zero,
            "reasonG": state_g.get("reason", ""), "reasonGC": reason_gc,
        }
        results.append(row)
        print(
            f"[{scn['key']}] {scn['type']}: G={total_g}min GC={total_gc}min cap={capacity}({row['capacitySource']}) "
            f"G超真实容量={row['gExceedsRealCapacity']} GC合容量={row['gcWithinCapacity']} "
            f"reason提容量={row['reasonMentionsCapacity']} 冲突={row['conflicts']} Δ{ms_gc-ms_g}ms"
        )

    n = len(results)
    summary = {
        "ranAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "model": model,
        "scenarios": n,
        "okRate": sum(r["okG"] and r["okGC"] for r in results) / n,
        "gcWithinCapacityRate": sum(r["gcWithinCapacity"] for r in results if r["capacityMinutes"]) / n,
        "gExceedsRealCapacityRate": sum(r["gExceedsRealCapacity"] for r in results if r["capacityMinutes"]) / n,
        "reasonCapacityRate": sum(r["reasonMentionsCapacity"] for r in results) / n,
        "dueOnAllDayViolations": sum(len(r["dueOnAllDayEvent"]) for r in results),
        "avgExtraLatencyMs": sum(r["latencyGC"] - r["latencyG"] for r in results) / n,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "results": results}, f, ensure_ascii=False, indent=2)
    print("\n== summary ==")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
