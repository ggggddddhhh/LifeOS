# Contributing to LifeOS

Thanks for looking at LifeOS. It's a Public Alpha — the fastest way to help right now is to **use it and report what breaks**.

## Before you start

Read the [Safety Model](README.md#-safety-model) in the README. The core guarantees are:

- Calendar writes only ever happen through Draft → Confirm → Execute → Verify
- User-edited tasks (`origin=user`) are never rewritten by the AI
- Every calendar write is idempotent and verified

**PRs that weaken these guarantees will be declined**, no matter how convenient they are.

## Ground rules

- **Never commit** `.env`, `agent/google-credentials.json`, token files, or `prisma/*.db` (they are gitignored — keep it that way)
- No new product features without an issue discussion first; bug fixes and docs welcome directly
- Keep the确定性 guard contract: TS (`src/lib/plan.ts`) and Python (`agent/app/finalize.py`) share test vectors (`docs/constraints-vectors.json`) — if you touch one, mirror the other and extend the vectors

## Workflow

```bash
npm install
npm run test          # Vitest
cd agent && .venv/Scripts/python -m pytest   # Pytest
npm run build         # must pass tsc strict
```

1. Fork / branch from `main`
2. Make the change with tests (bug fix = a regression test that fails before your fix)
3. `npm test && pytest && npm run build` all green
4. Open a PR with a short description of the behavior change

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, and the relevant trace line from `logs/` (redacted — it should already be, but double-check for personal data before pasting).
