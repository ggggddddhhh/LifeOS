# LifeOS v0.1.0-alpha (Release Candidate)

**Public Alpha** — first release candidate. Experimental; core safety model is real and tested.

## Highlights

The core agent loop: describe a goal, get an estimated dependency-ordered plan,
edit it by hand, and when reality drifts, the AI replans — with a visible diff and
your explicit confirmation before anything changes. Calendar scheduling goes through
the same discipline: draft → confirm → write → verify, idempotent and safe to retry.

## Features

- Natural-language goal planning (any OpenAI-compatible LLM; deterministic mock without a key)
- Kanban execution with status flow, notes, dependency badges
- Manual task create / edit / delete with validation, optimistic locking, cycle rejection
- User-priority replan: tasks you edited are never rewritten by the AI
- Replan preview → confirm → apply → undo (multi-level, snapshot-based)
- PlanVersion history for every revision
- Capacity-aware scheduling from Personal Planning Settings (daily minutes, workdays, work window, timezone, target calendar)
- Calendar draft generation against your real free/busy, per-day capacity caps, weekend awareness
- Human confirmation before any calendar write; per-draft opt-out
- Google Calendar integration (OAuth + PKCE, minimal scopes) and local ICS provider
- Idempotent write recovery (retry-safe, zero duplicate events — fault-injection tested)
- GitHub read-only progress context (`repo:owner/name`)
- Trace with runId end-to-end + one-shot reliability/reconciliation audit

## Reliability

- Continuous real-scenario verification (10 scenarios): goal → manual edits → policy
  change → replan → calendar write → day-2 replan → multi-level undo → service restart
  → drift monitoring → audit. See `docs/RELIABILITY-VERIFICATION.md`.
- Fault injection: "calendar written but result lost" converges on retry via idempotency
  keys — zero duplicates, DB ↔ calendar 1:1.
- Deterministic guards shared between TypeScript and Python with common test vectors.
- Timezone-safe: UTC Instant internally, IANA wall-clock at the edges.
- Test baseline at packaging: Vitest 117 passed / 1 skipped · Pytest 178 passed ·
  production build (tsc strict) green · `npm audit` 0 vulnerabilities.
- Reconciliation audit at packaging: DB ↔ Google 1:1 clean. Two historical trace rows
  (`reauth_required` blips during a demo session) are recorded as recovered-requiring
  attention; they are stale artifacts — current credentials verify healthy (fresh
  reconcile clean).

## Known Limitations

- **Slow/restricted networks**: calendar confirm is a synchronous batch; more than a
  few events can exceed request budgets on such links. Idempotency makes retry safe
  (press confirm again to converge). A background execution queue is planned.
- Calendar Update/Delete not implemented (CREATE-only; no event rewriting).
- Email tool not implemented.
- Over-midnight work windows are rejected in settings.
- Replan fallback (Python agent down → local planner) is not yet surfaced in the UI.
- Single-user; no auth.

## Demo

`recordings/lifeos-demo-alpha.mp4` (90 seconds, real product run, real Google writes)
— also linked from the README.

## Repository note

Before going public, the git history was rewritten to replace a personal email
address with `user@example.test`. The rewritten history is what `main` now contains.
Because the repository was briefly public before the rewrite, old clones, forks or
cached SHAs held by third parties may still contain the original address; contacting
GitHub Support to purge unreachable commits is advisable. **No API keys, tokens or
OAuth credentials were ever committed** (verified by full-history scan).
