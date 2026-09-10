# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| v0.1.0-alpha (main) | ✅ security fixes only |

PlanShift is a Public Alpha. Security fixes are prioritized over features.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately via GitHub "Report a vulnerability" (Security tab → Advisories) on this repository. Include reproduction steps and affected paths. You will get a response within a few days; fixes land on `main`.

## What matters most in this repo

PlanShift integrates with Google Calendar and stores OAuth credentials locally.

**Never commit, paste or screenshot:**

- `.env` (LLM keys, database URL)
- `agent/google-credentials.json` (Google OAuth client secret)
- `agent/.google-token.json` / any token store files (refresh/access tokens)
- `prisma/*.db` (may contain your task data)
- `logs/` (trace output; redaction is tested, but do not attach raw logs publicly)

These paths are gitignored — keep them that way. If you accidentally leaked a credential: **revoke it first** (Google Cloud Console → Credentials / OAuth consent; LLM provider dashboard), then open an issue about the code path that caused it.

## Security model notes (for reviewers)

- Calendar writes are CREATE-only, draft → confirm → execute → verify, with idempotency keys and stale-slot checks. The LLM has no write capability by design.
- The agent runs locally (`127.0.0.1:8000`) and is not authenticated — do not expose it to a network.
- LLM prompts never contain tokens/keys; trace redaction covers secret-shaped strings and is unit-tested.

## Known limitations

See "Known Limitations" in the README. The repository history was scrubbed of personal information before going public; third-party copies (forks/caches) are outside this project's control.
