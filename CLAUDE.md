# CLAUDE.md — Nexus Hub Backend

**You are working directly on the single-source-of-truth backend for Nexus Hub, a multi-domain AI personal assistant.** Do not assume a multi-agent orchestration, queue system, or "role" — those files were removed in Phase 0 (April 2026). There is one codebase, one main branch, one human owner (Felipe), and one deploy path.

---

## Project

**Nexus Hub** — AI-powered personal operating system. TypeScript/Node.js backend (`@nexushub/core`), Python FastAPI content engine, Swift/SwiftUI iOS client, SQLite data, PM2 process manager, Cloudflare Tunnel for HTTPS.

**Domains**: secretary, triathlon (being split into gym/running/cycle/swim in Phase 1), content creator, finance, cooking.

**Providers**: Gemini primary (2.5-flash / 2.5-flash-lite), Anthropic fallback (Claude Sonnet 4.6 / Haiku 4.5), OpenAI as secondary fallback. See `src/config.ts > providerRouting`.

## Current Production Truth - 2026-04-25

- Production backend is live at `4.14.66`.
- Current release branch for the beta hardening work:
  `beta/single-agent-rc`.
- Full backend verification passed after beta hardening:
  342 test files / 5,438 tests.
- Hardened staging operator-session smoke passed valid, expired, tampered,
  unauthorized role/scope, wrong-tenant, and static-token rejection paths.
- External webhook/on-call staging drill passed alert creation, delivery,
  acknowledgement, resolution, and audit verification.
- Founder accounts verified in production:
  `felipedrf74@gmail.com` and `vieira.jaqueline@gmail.com`.
- Deploy scripts now exclude worktree `.git` files so branch worktrees can
  deploy safely.
- Home-to-Inbox latency and task-list count truth were verified live on
  `4.14.66`; `/api/v1/tasks/lists` returns real `taskCount` values, not `-1`
  placeholders.
- Remaining public-beta gates are iOS distribution gates: signed TestFlight,
  APNs token/delivery proof, fresh auth/onboarding, true two-account switching,
  and real Gmail/Outlook/Health provider-state checks.

---

## Repository Layout

```
cortex-telegram-hub-bot/          # backend repo
├── src/
│   ├── agents/                   # 5 runtime content-creation agents
│   ├── api/                      # iOS REST API (/api/v1/*)
│   ├── bot.ts                    # Grammy Telegram bot composition root
│   ├── config.ts                 # All env-driven configuration
│   ├── domains/                  # secretary, triathlon, content, finance, cooking handlers
│   ├── handlers/                 # Telegram message + command dispatchers
│   ├── portal/                   # Express admin dashboard on :8200
│   ├── services/                 # ~80 service modules (DB, APIs, caching, routing)
│   ├── skills/                   # Skill catalog + user overrides + enable/disable
│   └── index.ts                  # Process entry point
├── migrations/                   # Numbered SQL migrations
├── __tests__/                    # Vitest tests mirroring src/
├── content-engine/               # Python FastAPI subprocess
├── prompts/                      # Hot-reloadable system prompts
└── scripts/                      # deploy.sh, rollback.sh, promote-to-prod.sh, ...
```

iOS app is a separate repo at `~/Desktop/Nexus Hub IOS/Nexus Hub/`.

---

## Tech Stack

- **Backend**: Node.js 20+, TypeScript (CommonJS), Grammy, Express, better-sqlite3, pino
- **AI**: `@google/generative-ai`, `@anthropic-ai/sdk`, `openai`
- **Content Engine**: Python 3.12, FastAPI, uvicorn
- **iOS**: Swift 5.9, SwiftUI, iOS 17+, `@Observable`, URLSession async/await, no third-party deps
- **Infra**: single Linux VPS, PM2, Cloudflare Tunnel, GitHub Actions CI
- **Observability**: pino JSON logs, SQLite `audit_trail` + `error_log`, Sentry (optional, Phase 0.F), distributed tracing via `reqId`

---

## Git Workflow

- **main** — production. Everything merges here directly via the validated promote pipeline.
- **feature/** or **fix/** — short-lived branches when doing risky work. Most changes can land on main directly.
- **develop** branch is NOT used. The workflow is single-branch + staging validation.

### Commit format
```
type(scope): description
```
Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `perf`. Scopes are free-form but usually match service names (`feat(garmin): ...`).

### Before committing
```bash
npx tsc --noEmit     # must pass
npx vitest run       # must pass
```
Pre-commit hook enforces both.

---

## Deploy Pipeline (validated promote)

```bash
# 1. Ship to staging (isolated install on :8201)
./scripts/deploy-staging.sh

# 2. Let staging soak (5 min minimum)

# 3. Run smoke tests
./scripts/staging-smoke.sh

# 4. Promote to prod (runs smoke test again as gate, then deploys)
./scripts/promote-to-prod.sh
```

Direct `./scripts/deploy.sh` exists for trivial hotfixes but the default is always promote-to-prod.

**Server**: `dominguez@serverdominguez` — local-network only (IPv6 via Cloudflare Tunnel). GitHub Actions cannot reach it; deploys run from Felipe's Mac.

**See**: `DEPLOY.md` (full runbook), `STAGING.md` (staging setup), `scripts/rollback.sh` (tested dry-run + apply path).

---

## Critical Rules

### Architecture

1. **Token-zero data reads.** Any operation that's a pure lookup (list tasks, get calendar, fetch readiness) MUST go through a REST route under `/api/v1/`, not through the chat pipeline. If you find yourself adding `chatViewModel.sendMessage()` for a data read, stop.
2. **Gemini-first, Anthropic-fallback.** `providerRouting` in `src/config.ts` controls this per-task-type. Don't hardcode `config.anthropic.model` in new code — use `getActiveProvider()` or `completeOneShotWithFallback()`.
3. **Token cache awareness.** `oauth-store.getTokens()` is cached for 10 min. Call `storeTokens()` or `disconnectProvider()` to invalidate. The audit_trail row is written once per cache-refill, not per call.
4. **Garmin auth safety.** `keepAlive()` must NEVER call `attemptReLogin()` — that triggers MFA emails. Full login is gated behind `serializedAuthRecovery` with a 15-min cooldown.

### Testing

- Tests live in `__tests__/` mirroring `src/` structure.
- External APIs are ALWAYS mocked. Tests that hit real network fail CI.
- SQLite tests use `:memory:`.
- Bug fixes include a failing-test-before-fix whenever reasonable.
- `_resetDecryptCacheForTests()` in `beforeEach` if the test uses `oauth-store` — the decrypted-token LRU is module-scoped.

### Forbidden

- ❌ Modifying `.env`, `data/`, `content-engine/.venv/`
- ❌ Adding real API calls in tests
- ❌ Committing secrets (pre-commit hook enforces via `detect-secrets`)
- ❌ Hardcoding absolute paths (`os.homedir()` or `config.*` instead)
- ❌ Direct `anthropic.messages.create` — route through `trackedCreate()` for cost logging
- ❌ `--amend` or `--no-verify` on commits without explicit user approval
- ❌ Re-adding the multi-agent orchestration scaffolding that was removed in Phase 0

---

## Key Files to Know

| File | Purpose |
|---|---|
| `src/config.ts` | All env vars, provider routing, feature flags |
| `src/services/provider-registry.ts` | TaskRoutingProvider init (primary/fallback per task type) |
| `src/services/gemini-provider.ts` | Gemini SDK wrapper + `completeOneShotWithFallback` |
| `src/services/anthropic.ts` | Anthropic SDK wrapper + tool dispatch (mostly fallback path now) |
| `src/services/oauth-store.ts` | Encrypted token storage + LRU cache |
| `src/services/garmin.ts` | Garmin Connect integration (MFA-aware, rate-limit-aware) |
| `src/services/unified-calendar.ts` | Google + Outlook calendar merge |
| `src/services/tool-executor.ts` | Cross-provider tool call execution |
| `src/services/scheduler.ts` | All cron jobs (28+) |
| `src/services/intelligence-bus.ts` | Cross-agent signal pub/sub |
| `src/skills/skill-config.ts` | Skill catalog + `SubSkillDefinition` with `dependencies` |
| `src/skills/skill-manager.ts` | Enable/disable with dependency enforcement + cascade |
| `src/api/routes/*.ts` | iOS REST endpoints (token-zero) |
| `src/portal/server.ts` | Admin dashboard + OAuth callbacks + Mission Control successor |
| `src/portal/portal.html` | Portal UI (SPA-ish, vanilla JS) |
| `src/utils/request-context.ts` | AsyncLocalStorage for distributed tracing reqId |
| `src/utils/logger.ts` | Pino logger with context mixin |
| `src/services/error-tracker.ts` | Sentry integration |
| `src/services/error-monitor.ts` | Local error capture → SQLite + Telegram + Sentry |

---

## Active Phase (April 2026)

**Beta release hardening is the active production context.** The backend beta
hardening branch has been deployed to production as `4.14.66`; do not treat the
older Phase 0/Phase 1 notes as the current release state.

Current backend follow-ups:

- keep tenant/founder/business-rule docs aligned with the beta tracker;
- run another production-safe alert drill only if the final receiver differs
  from the staging receiver;
- keep deploy scripts worktree-safe;
- avoid broad architecture rewrites until the signed TestFlight/device gates
  are complete.

Current iOS-dependent release gates:

- signed TestFlight smoke;
- fresh Apple/Google/email auth and interrupted onboarding;
- APNs token upload and safe delivery;
- true two-account switching between Felipe and Jaqueline test accounts;
- real Gmail/Outlook/Health provider-state validation.

See `DEPLOY.md`, `STAGING.md`, `docs/OBSERVABILITY-ONCALL.md`, and
`docs/beta/single-agent-status.md` for operational context.
