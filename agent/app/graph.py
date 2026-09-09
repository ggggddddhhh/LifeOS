"""LangGraph 装配（Phase 4）：
Analyze → [GitHub Tool → Progress Analysis |（无仓库时跳过）] → Plan/Replan → Validate → Finalize
唯一回边仍是 Validate→Plan/Replan 的重试边（attempts 门控），无死循环，LLM 调用 ≤ 2 次。"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from .github import GithubClient
from .llm import LLM
from .nodes import (
    AgentState,
    analyze_node,
    fail_node,
    finalize_node,
    make_github_tool_node,
    make_plan_node,
    make_replan_node,
    make_validate_node,
    progress_analysis_node,
)


def build_graph(llm: LLM, github: GithubClient | None = None):
    g: StateGraph = StateGraph(AgentState)
    g.add_node("analyze", analyze_node)
    g.add_node("github_tool", make_github_tool_node(github) if github else (lambda s: {}))
    g.add_node("progress_analysis", progress_analysis_node)
    g.add_node("plan", make_plan_node(llm))
    g.add_node("replan", make_replan_node(llm))
    g.add_node("validate", make_validate_node())
    g.add_node("finalize", finalize_node)
    g.add_node("fail", fail_node)

    g.add_edge(START, "analyze")

    def route_after_analyze(state: AgentState) -> str:
        if state.get("repo") and github is not None:
            return "github_tool"
        return "plan" if state["kind"] == "plan" else "replan"

    g.add_conditional_edges("analyze", route_after_analyze, ["github_tool", "plan", "replan"])
    g.add_edge("github_tool", "progress_analysis")

    def route_kind(state: AgentState) -> str:
        return "plan" if state["kind"] == "plan" else "replan"

    g.add_conditional_edges("progress_analysis", route_kind, ["plan", "replan"])
    g.add_edge("plan", "validate")
    g.add_edge("replan", "validate")

    def route_after_validate(state: AgentState) -> str:
        if state.get("error_code"):
            return "fail"
        if state.get("tasks") is not None:
            return "finalize"
        # 尚无 tasks 且无终态错误 → 重试（仅当未达上限；达到上限时 validate 已写 error_code）
        return "plan" if state["kind"] == "plan" else "replan"

    g.add_conditional_edges("validate", route_after_validate, ["finalize", "plan", "replan", "fail"])
    g.add_edge("finalize", END)
    g.add_edge("fail", END)
    return g.compile()


def run_plan(request: dict, llm: LLM, github: GithubClient | None = None) -> AgentState:
    graph = build_graph(llm, github)
    return graph.invoke({"kind": "plan", "request": request, "attempts": 0, "llm_calls": 0})


def run_replan(request: dict, llm: LLM, github: GithubClient | None = None) -> AgentState:
    graph = build_graph(llm, github)
    return graph.invoke({"kind": "replan", "request": request, "attempts": 0, "llm_calls": 0})
