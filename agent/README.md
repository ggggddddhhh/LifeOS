# LifeOS Agent Core（Phase 3 · M1）

FastAPI + LangGraph 的 Planner/Replanner 服务。**无状态、不访问数据库**；持久化由 Next.js 业务层负责。

Graph：`Analyze → Plan/Replan → Validate → Finalize`（Validate 失败自动重试 1 次后失败，无死循环，LLM 调用 ≤ 2 次）。

## 环境

```bash
cd agent
python -m venv .venv            # 本机使用 D:\py312\python.exe
.venv/Scripts/python -m pip install -e ".[dev]"
```

## 运行

```bash
# mock 模式（无 Key，确定性输出）
.venv/Scripts/python -m uvicorn app.main:app --port 8000

# 真实 LLM（OpenAI 兼容）
LLM_BASE_URL=https://api.deepseek.com LLM_API_KEY=sk-... LLM_MODEL=deepseek-chat \
  .venv/Scripts/python -m uvicorn app.main:app --port 8000
```

## API

- `GET /health` → `{ok, service, version, promptVersion, mode, graph, maxLlmCalls}`
- `POST /v1/plan` `{title, description?, deadline?}` → `{tasks:[PlannedTask]}`
- `POST /v1/replan` `{goalTitle, goalDescription?, deadline?, daysLeft, tasks:[TaskSnapshot]}` → `{reason, tasks}`
- 错误：`{"error":{"code","message","retryable"}}`，code ∈ `AGENT_INPUT_INVALID(422)` / `AGENT_LLM_ERROR` / `AGENT_LLM_TIMEOUT` / `AGENT_PARSE_ERROR` / `AGENT_VALIDATION_ERROR`(502) / `AGENT_INTERNAL_ERROR(500)`。响应永不包含 traceback。

字段名与 TS `PlannedTask`（camelCase）严格对齐，见 `app/schemas.py`。

## 测试

```bash
.venv/Scripts/python -m pytest   # 37 个用例，全部离线（强制 mock）
```

## 约束（Phase 3 范围）

- 不做 RAG / Memory / 多 Agent / Tools / Web Search
- prompt 与 `src/lib/llm/index.ts` 保持同步（PROMPT_VERSION，双侧同改）
- 所有外部 LLM 调用带 timeout（`LLM_TIMEOUT_S`，默认 60s，连接 5s）
