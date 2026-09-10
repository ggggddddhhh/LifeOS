# PlanShift

**An adaptive AI planning agent: it re-plans continuously as your goals, real progress, and calendar change. Plans shift — PlanShift shifts with them.**

> **Public Alpha** — experimental, under active development. Expect rough edges; the core safety model is real and tested, the polish is not.

**English** · [简体中文](README.zh-CN.md)

<p align="center">
  <a href="#-demo">Demo</a> ·
  <a href="#-what-is-planshift">What is PlanShift?</a> ·
  <a href="#-getting-started">Getting Started</a> ·
  <a href="#-safety-model">Safety Model</a> ·
  <a href="#-known-limitations">Limitations</a>
</p>

## 🎬 Demo

Watch the full 90-second flow — **Goal → AI Plan → User Edit → Replan → Preview → Confirm → Calendar**:

**[▶ Watch the demo (MP4)](recordings/planshift-demo-alpha.mp4)**

Every step in the video is a real product run: real LLM planning, real Google Calendar writes through the confirmation flow. No mockups, no staged results.

## Screenshots

| Today | Goal & Kanban |
|---|---|
| ![Today](screenshots/today.png) | ![Kanban](screenshots/goal-kanban.png) |
| **Replan Preview** | **Calendar** |
| ![Replan Preview](screenshots/replan-preview.png) | ![Calendar](screenshots/calendar.png) |

## 🤔 What is PlanShift?

PlanShift is not a todo app. A todo app stores tasks you type. PlanShift runs an **agent loop** around them:

```
Goal
 → AI Plan (LLM decomposition)
 → User Edit (tasks are yours to change)
 → Execute (kanban + calendar)
 → Replan (when reality drifts)
 → Preview (see exactly what changes)
 → Confirm (nothing applies without you)
 → Calendar (draft → confirm → write → verify)
```

**AI proposes. User decides. Deterministic guards enforce constraints.**

The LLM never touches your calendar. It never silently rewrites a task you edited. Every plan change is diffed, previewed, versioned and undoable. Capacity math, dependency ordering and schedule clamping are enforced by plain code — not by hoping the model behaves.

## ✨ Core Features

- **Natural-language goal planning** — one sentence becomes an estimated, dependency-ordered task plan
- **AI task decomposition** — one-shot tasks and recurring habits (`durationDays`) with per-day estimates
- **User-controlled task editing** — create / edit / delete with validation, optimistic locking, cycle detection
- **User-priority Replan** — tasks you edited are marked `origin=user` and are never rewritten by the AI
- **Plan Preview / Confirm / Undo** — every replan shows a diff and applies only after explicit confirmation
- **PlanVersion history** — every revision snapshotted; multi-level undo
- **Dependency validation** — cycles are rejected at plan time and at edit time
- **Capacity-aware planning** — workdays × daily capacity; AI tasks compressed, your tasks protected
- **Personal Planning Settings** — daily minutes, workdays, work window, timezone, target calendar
- **GitHub read-only progress context** — `repo:owner/name` in a goal description pulls public issue/PR/CI signals
- **Calendar read context** — busy slots inferred from your calendar; user declarations win
- **Calendar Draft → Human confirmation → Idempotent write → Verify**
- **Google Calendar integration** (OAuth, PKCE, minimal scopes) with local ICS fallback
- **Idempotent write recovery** — interrupted batches converge on retry, zero duplicate events
- **Timezone-safe Instant model** — UTC internally, IANA wall-clock at the edges, DST-safe
- **Reliability / reconciliation audit** — one-shot DB ↔ calendar reconciliation + trace metrics

## 🏗 Architecture

```
Next.js 16 + TypeScript (App Router, Prisma, SQLite/PostgreSQL-ready)
        ↓  Agent Client (AGENT_MODE=auto: Python first, TS local fallback)
FastAPI  ·  Python 3.12  ·  stateless
        ↓
LangGraph: Analyze → [GitHub tool] → [Calendar tool] → Plan|Replan → Validate → Finalize
        ↓                                      ↘ deterministic guards (mirror of TS guards)
LLM (any OpenAI-compatible endpoint)
```

- **TS deterministic guards** (`src/lib/plan.ts`): dependency sanitize, schedule clamp, task budget, capacity budget — shared test vectors with Python (`docs/constraints-vectors.json`)
- **Python Agent Core** (`agent/app`): prompts, validation, finalize convergence, trace
- **Database**: SQLite via Prisma today; schema is PostgreSQL-ready (no SQLite-specific features)
- **Google Calendar Provider**: OAuth Desktop flow, token store (file dev / OS keyring prod), idempotent CREATE-only protocol
- **GitHub tool**: read-only, public data, anonymous or `GITHUB_TOKEN`

## 🛡 Safety Model

- **The AI cannot write calendar events.** Writes only happen through
  `Draft → user Confirm → Execute → Verify`. "The agent decided and wrote directly" is architecturally impossible.
- **User-origin tasks are protected.** Edit a task and it carries `origin=user`; Replan preserves it verbatim — title, estimate, priority, dates, dependencies.
- **Deterministic validation** — the LLM proposes; code enforces: dependency cleaning (cycles dropped), schedule clamping to `[today, deadline]`, task-count guard, capacity budget.
- **Dependency cycle protection** — rejected both in AI plans and in manual edits (with a visible reason).
- **Idempotency** — every calendar write carries a unique idempotency key; provider pre-check + DB gate + post-timeout re-query. Verified under fault injection: zero duplicate events.
- **Stale checks** — before writing, slot occupancy is re-checked with Instant comparison; occupied slots are skipped and flagged, never overwritten.
- **Optimistic locking** — concurrent task edits are detected (409) instead of silently overwriting.
- **PlanVersion / Undo** — every plan revision keeps an apply-before snapshot; undo walks the chain level by level.
- **Secret hygiene** — tokens/keys never enter prompts, logs, traces or error responses; trace redaction is tested.

## 🧰 Tech Stack

| Layer | Tech |
|---|---|
| Web / API | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · shadcn/ui |
| Data | Prisma 6 · SQLite (PostgreSQL-ready) |
| Agent Core | Python 3.12 · FastAPI · LangGraph · Pydantic · httpx |
| Integrations | Google Calendar API (OAuth+PKCE) · GitHub REST (read-only) |
| LLM | Any OpenAI-compatible endpoint (e.g. DeepSeek, OpenAI) + built-in deterministic mock |
| Tests | Vitest (117) · Pytest (178) |

## 🚀 Getting Started

### Requirements

- Node.js ≥ 20 + npm
- Python ≥ 3.12 (a venv is created below)
- Google Calendar is **optional** — the app runs fully without it (local ICS provider, and calendar features can simply stay unused)

### Install

```bash
# 1. Frontend dependencies
npm install

# 2. Python agent dependencies
cd agent
python -m venv .venv
.venv/Scripts/pip install -e .            # Windows
# .venv/bin/pip install -e .              # macOS/Linux
cd ..

# 3. Environment + database
cp .env.example .env                      # edit if you want a real LLM (see below)
npx prisma db push                        # creates prisma/dev.db
```

### Configure (optional) a real LLM

Edit `.env` — any OpenAI-compatible endpoint works:

```ini
LLM_BASE_URL="https://api.deepseek.com"   # or https://api.openai.com/v1
LLM_API_KEY="<your key>"
LLM_MODEL="deepseek-chat"
```

**Fallback semantics (read this):** with no key, both sides use a built-in deterministic mock — the full product loop still works, plans are just template-quality. With a key, `AGENT_MODE=auto` prefers the Python agent; if it is unreachable/times out/returns a contract mismatch, the web layer **does** fall back to a local planner — this fallback is being made observable in the UI; today check the agent log if plans look suspiciously templated.

### Run

```bash
# Terminal 1 — Python Agent Core (:8000)
npm run agent            # or: npm run agent:full (reads .env, auto-detects calendar)

# Terminal 2 — Next.js (:3000)
npm run dev

# Browser → http://localhost:3000
```

Startup order is not strict. Create a goal, and you are in the loop.

### Google Calendar (optional)

1. [Google Cloud Console](https://console.cloud.google.com/) → create an **OAuth client (Desktop app)**
2. Download the client secret JSON → save as `agent/google-credentials.json` (never commit)
3. In `.env`: `CALENDAR_PROVIDER=google`
4. Authorize once: `cd agent && .venv/Scripts/python smoke_google.py` (opens browser, state + PKCE one-shot session)
5. Token is stored in `agent/.google-token.json` (never commit)

Calendar writes **always** go through an explicit confirmation dialog — the app will show you the exact events before anything is created.

## 🧪 Tests

```bash
npm test                              # Vitest — core guards, API, calendar protocol (117 tests)
cd agent && .venv/Scripts/python -m pytest   # pytest — agent core (178 tests)
npm run build                         # production build (tsc strict)
agent/.venv/Scripts/python scripts/reliability-audit.py   # DB ↔ calendar reconciliation
```

## ⚠️ Known Limitations

- **Calendar writes on slow/restricted networks.** Confirmation is a synchronous batch; on very slow links (no direct Google access) a batch of more than a few events can exceed request budgets. Writes are idempotent, so **pressing confirm again converges safely** — no duplicates, no manual cleanup. A background execution queue is the planned fix.
- **Calendar Update/Delete not implemented** — writes are CREATE-only; replanning does not rewrite events already on your calendar (it tells you to regenerate drafts instead).
- **Email tool not implemented.**
- **Over-midnight work windows not supported** — settings reject a work window that crosses midnight.
- **Replan fallback visibility** — when the Python agent is unreachable, the local fallback engages automatically; its surfacing in the UI is still rough.
- **Single-user** — no auth/multi-tenancy; this is a personal tool by design, for now.

## 📌 Project Status

**Public Alpha.** Suitable for developers, experimentation and personal dogfooding.
No production SLA, no enterprise readiness promised. The data model may still change; exports are DIY (it's SQLite).

## 🗺 Roadmap (direction, no dates)

- Background calendar execution queue (removes the slow-network ceiling)
- Calendar event update/delete with the same confirm discipline
- Fallback/degradation surfacing in the UI
- PostgreSQL deployment story

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome — please read the safety model first; PRs that weaken the confirmation/idempotency guarantees will be declined.

## Security

See [SECURITY.md](SECURITY.md). In short: **never commit** `.env`, `google-credentials.json`, token files or any key. Report vulnerabilities privately.

## License

[MIT](LICENSE)
