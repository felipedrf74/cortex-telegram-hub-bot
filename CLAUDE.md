# CLAUDE.md — Nexus Hub Backend

**You are working directly on the single-source-of-truth backend for Nexus Hub, a multi-domain AI personal assistant.** Do not assume a multi-agent orchestration, queue system, or "role" — those files were removed in Phase 0 (April 2026). There is one codebase, one main branch, one human owner (Felipe), and one deploy path.

---

## Project

**Nexus Hub** — AI-powered personal operating system. TypeScript/Node.js backend (`@nexushub/core`), Python FastAPI content engine, Swift/SwiftUI iOS client, SQLite data, PM2 process manager, Cloudflare Tunnel for HTTPS.

**Domains**: secretary, triathlon (being split into gym/running/cycle/swim in Phase 1), content creator, finance, cooking.

**Providers**: Gemini primary (2.5-flash / 2.5-flash-lite), Anthropic fallback (Claude Sonnet 4.6 / Haiku 4.5), OpenAI as secondary fallback. See `src/config.ts > providerRouting`.

## Current Production Truth - 2026-04-26

- Production backend is live at `4.14.87`; staging remains at `4.14.86`.
- Current deployed branch: `main`.
- Historical beta recovery branch: `beta/single-agent-rc`.
- Full backend verification passed before the latest production deploy:
  349 test files / 5,539 tests.
- Production deploy health passed for content engine, status portal, and bot
  online at deploy commit `d383936`; code commit `1885607` is the Secretary
  audit closeout release. It makes task completion idempotent, reconciles task
  creation after transient provider failures, uses per-user task due-date
  windows instead of a Lisbon default, cascades remote task-list deletion where
  supported, invalidates provider-derived task caches after OAuth reauth, uses
  monotonic SWR cache freshness, expands recurring tasks into operational
  reads, recognizes focus-time blocks, and normalizes Cooking shopping units
  before aggregation.
- The preceding `4.14.86` Secretary hardening release made calendar reads
  honest about degraded/unavailable providers, normalized
  all-day/cancelled/declined events, fixed configured-timezone and
  cross-midnight calendar windows, escalated repeated SWR refresh misses, and
  routed Todoist through the Todoist adapter instead of Microsoft To Do.
- The preceding Training plan-cancel hard-delete + rich session description
  release deployed migration `079_training_session_description.sql`.
- Hardened staging operator-session smoke passed valid, expired, tampered,
  unauthorized role/scope, wrong-tenant, and static-token rejection paths.
- External webhook/on-call staging drill passed alert creation, delivery,
  acknowledgement, resolution, and audit verification.
- Founder accounts verified in production:
  `felipedrf74@gmail.com` and `vieira.jaqueline@gmail.com`.
- Deploy scripts exclude worktree `.git` files and local agent/worktree
  artifacts so branch worktrees can deploy safely.
- Home-to-Inbox latency and task-list count truth were verified live on
  `4.14.66` and remain live through `4.14.74`; `/api/v1/tasks/lists` returns
  real `taskCount` values, not `-1` placeholders.
- Latest Content + Training TestFlight bugfix pass on 2026-04-25 is deployed
  in backend `4.14.74` and pushed in iOS `main`:
  `/api/v1/content/script` accepts `scriptStyle` (`detailed` or `bullets`),
  derives user-scoped Voice DNA from content knowledge, forwards it into the
  Python script engine, includes style in the script cache key, and returns
  `scriptStyle` in the API response. Python degraded fallback distinguishes
  YouTube vs short-form and detailed vs bullet outputs.
  iOS also fixed topic-list cache invalidation after topic writes, athlete
  profile finish actions from Training, and Training complete/skip fallback to
  the `"today"` sentinel.
- Follow-up Content scheduling/pipeline + Training readiness pass on
  2026-04-25 is deployed in backend `4.14.74` and pushed in iOS `main`:
  `POST/PATCH /api/v1/content/topics` now accepts
  `scheduledDateTime`; date-only topics create/update Secretary tasks;
  date+time topics also create/update calendar agenda/events through unified
  calendar; Content Tasks reads scheduled topics directly and surfaces
  task/calendar sync status; Pipeline Detail ignores benign superseded-load
  cancellation; Training keeps renderable Home/Training data visible during
  refresh; Home secondary previews fan out in parallel after the primary
  dashboard render. Migration `078_content_topic_secretary_artifacts.sql` is
  deployed with `4.14.74`; fresh signed TestFlight/device validation is still
  required before closing user-facing QA.
- Second Training TestFlight bugfix pass on 2026-04-25 is deployed in backend
  `4.14.74` and pushed in iOS `main` at `7f722da`: setup prompts are gated by
  real pending training questionnaires, started sport profiles count as usable
  objective context, skipped optional questionnaire steps persist safe
  placeholders, deterministic coach adjustment IDs are humanized, recovery/easy
  run sessions marked `rest` remain openable when they contain real session
  detail, new plan generation refreshes plan/calendar caches before showing the
  week, coach briefing has an active-plan deterministic fallback, and workout
  adjustment actions refresh instead of silently no-oping. Verification:
  focused backend Training tests passed 4 files / 63 tests, staging
  signed-session smoke passed 17/17, and iOS simulator build passed. The
  latest full production deploy gate passed 345 files / 5,468 tests during the
  `4.14.74` Training coach engine promotion. Signed TestFlight/device validation
  remains required.
- Content script AI delivery hotfixes on 2026-04-25 remain live in backend
  `4.14.74`. `4.14.71` fixed the TS AI bridge/json-mode degradation
  path. `4.14.73` carries the deeper script-quality architecture: the Python
  script writer no longer imports a global creator profile or a module-level
  system prompt, no longer hardcodes a founder/operator persona, and builds the
  script system prompt per request from the authenticated user's scoped creator
  profile/Voice DNA. The prompt now uses outcome-based creative guidance
  instead of literal hook/setup/body/CTA templates; `ask_claude` sets an
  explicit script temperature; degraded fallback drafts are topic-aware,
  deterministic-jittered, and free of founder hashtags or generic
  speed-vs-judgment hooks; and `/api/v1/content/script` supports
  `forceRefresh`/`regenerate` with a regeneration seed so "generate again"
  bypasses the cache. The script generation cache key is now `script-v7`.
  Production must keep returning `degraded=false` for normal script generation
  unless a real provider outage occurs.
- Training coach engine hardening on 2026-04-25 is deployed in backend
  `4.14.74`. It removes
  founder-specific Felipe/carnivore/high-volume defaults from the Training
  prompts, makes daily coach briefing generation iterate every active canonical
  tenant instead of owner-only users, fixes ACWR to use actual training-load
  values with a 14-day sample guard, changes no-wearable readiness from
  `full_intensity` to a conservative recommendation, combines sleep quality
  with duration as a safety floor, and makes orange/red/injury coach-kernel
  states downshift deterministically. Handoff:
  `docs/beta/training-coach-engine-hardening-handoff.md`. Verification passed:
  staging smoke = 17/17, production deploy gate = 345 files / 5,468 tests,
  and production health checks passed for content engine, status portal, and
  bot online.
- Remaining public-beta gates are iOS distribution gates: signed TestFlight,
  APNs token/delivery proof, fresh auth/onboarding, true two-account switching,
  real Gmail/Outlook/Health provider-state checks, and device proof for the
  latest Secretary, Health, Content script/topic scheduling/pipeline, and
  Training action/readiness fixes.

---

## Codex + Claude Operating Protocol

- Treat this file and `docs/agents/claude/handoff.md` as the backend
  cross-agent starting point. In the iOS workspace, read `AGENTS.md`,
  `CLAUDE.md`, `specs/00-CURRENT-PRODUCT-TRUTH.md`, and
  `specs/27-CLAUDE-CODE-HANDOVER.md`.
- Codex has been working by verifying QA reports with code/runtime evidence,
  implementing scoped fixes, running focused and broad tests, deploying through
  staging smoke before production, and updating docs before handoff. Claude
  should follow the same loop.
- Backend production changes should follow: focused tests/typecheck,
  staging deploy, staging smoke, production promote, production health, docs
  update. Do not skip the staging smoke gate.
- Token-zero remains law for iOS: ordinary operational flows use REST routes,
  not fake chat commands or prompt-driven lookups.
- Avoid single-tenant runtime assumptions in prompts, caches, background jobs,
  provider fallbacks, and user-facing copy. Hardcoded founder identity belongs
  only in docs, provenance notes, or explicit owner-only fixtures.
- If credentials, APNs, TestFlight, OAuth, HealthKit, Gmail/Outlook, or provider
  access are required, document the exact env/command and mark the item as
  manual verification required.

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
hardening work has been deployed to production as `4.14.74` from `main`; do not treat the
older Phase 0/Phase 1 notes as the current release state.

Current backend follow-ups:

- keep tenant/founder/business-rule docs aligned with the beta tracker;
- validate the latest Content scheduling, high-quality AI script generation, Training readiness,
  Secretary recurrence, and Health fixes in a signed TestFlight device build;
- device-validate the Training coach engine hardening pass;
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
