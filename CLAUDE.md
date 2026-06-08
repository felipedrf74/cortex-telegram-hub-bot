# CLAUDE.md — Nexus Hub Backend

## Agent Bootloader - Read First

This file is a repo-local bootloader. Before creating or updating markdown,
read:

0. Start from the official workspace:
   `/Users/felipedominguez/Desktop/Nexus Hub`
1. `/Users/felipedominguez/Desktop/Nexus Hub/docs/DOCS_INDEX.md`
2. `/Users/felipedominguez/Desktop/Nexus Hub/docs/agent/OPERATING_CONTEXT.md`
3. `docs/DOCS_INDEX.md`
4. `docs/release/current-release-index.md`
5. `docs/qa/QA_BACKEND_REPORT.md`

Do not create a new scattered final report when a current/canonical doc already
exists. Update the current doc and link any one-off evidence from the current
index. Historical reports are evidence, not active truth, unless the current
release index links them. Run `npm run docs:audit` before creating release docs
or copying verdicts, commit hashes, or test counts.

**You are working directly on the single-source-of-truth backend for Nexus Hub, a multi-domain AI personal assistant.** Do not assume a multi-agent orchestration, queue system, or "role" — those files were removed in Phase 0 (April 2026). There is one codebase, one main branch, one human owner (Felipe), and one deploy path.

---

## Project

**Nexus Hub** — AI-powered personal operating system. TypeScript/Node.js backend (`@nexushub/core`), Python FastAPI content engine, Swift/SwiftUI iOS client, SQLite data, PM2 process manager, Cloudflare Tunnel for HTTPS.

**Domains**: secretary, triathlon (being split into gym/running/cycle/swim in Phase 1), content creator, finance, cooking.

**Providers**: Gemini primary (2.5-flash / 2.5-flash-lite), Anthropic fallback (Claude Sonnet 4.6 / Haiku 4.5), OpenAI as secondary fallback. See `src/config.ts > providerRouting`.

## Current Production Truth - 2026-06-06

- Canonical production state lives in `docs/release/CURRENT_RELEASE_STATE.md`
  and `docs/release/current-release-index.md`; read those before making
  release decisions.
- Last documented production backend is live at `4.14.202` on `main`.
- Current production deploy commit is
  `6438553d` (version bump for 4.14.202).
- Source scope now in production:
  - `870ca09f` — Training remediation round-3 fast-follow.
- Production promote completed through the standard gate. Promote-time staging
  smoke passed 19/19 before production was touched, backend `npm run verify`
  passed typecheck, science-policy, and full Vitest with 816 files / 11,951
  tests, and final `main` pre-push repeated typecheck, full Vitest, and build.
- Production health passed after deploy: content engine returned `status: ok`,
  authenticated status portal returned version `4.14.202`, and PM2 showed
  `nexus-hub` and `content-engine` online.
- The local package version can be ahead of production while release hardening
  or feature work is staged. Run `scripts/release-identity.sh markdown` for
  current local identity instead of hand-copying version/SHA fields.
- Cloudflare Tunnel is currently restored and serving traffic, but it was
  restarted as detached `cloudflared` user processes during incident recovery.
  Follow up by installing/enabling a supervised service for the tunnel so it
  survives host restarts cleanly.
- Current active local feature worktree:
  `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
  on `codex/chat_improvement_goal`, with uncommitted chat improvement changes.
  Do not clean or reset that worktree unless Felipe explicitly asks.

Current verification floor:

- Full backend verify: last documented production promote used 816 Vitest files
  / 11,951 tests. Regenerate current counts from CI/evidence instead of
  copying this number into release decisions.
- Main pre-push gate: typecheck + full Vitest + build.
- Promote gate: staging smoke 17/17 before production.
- Deploy script now restores the tracked registry shadow parity evidence before
  clean-tree checks that precede service stop.

Documentation hygiene:

- `docs/release/CURRENT_RELEASE_STATE.md` and
  `docs/release/current-release-index.md` are the canonical release state.
- One-off QA prompts should not be added to `main` as long-lived docs. Keep
  QA prompts in PR comments or temporary worktrees unless the active release
  index links them as durable evidence.

## Codex + Claude Operating Protocol

- Treat this file and `docs/agents/claude/handoff.md` as the backend
  cross-agent starting point. In the official workspace, read the iOS
  bootloaders plus `/Users/felipedominguez/Desktop/Nexus Hub/ios-specs/00-CURRENT-PRODUCT-TRUTH.md`
  and `/Users/felipedominguez/Desktop/Nexus Hub/ios-specs/27-CLAUDE-CODE-HANDOVER.md`.
- Codex has been working by verifying QA reports with code/runtime evidence,
  implementing scoped fixes, running focused and broad tests, deploying through
  staging smoke before production, and updating docs before handoff. Claude
  should follow the same loop.
- Backend production changes should follow: focused tests/typecheck,
  staging deploy, staging smoke, production promote, production health, docs
  update. Do not skip the staging smoke gate.
- Token-zero remains law for explicit iOS buttons, slash commands, and REST
  reads: operational surfaces use REST routes, not fake chat commands or
  prompt-driven lookups. Ordinary natural-language chat, especially write
  intents and ambiguous follow-ups, must flow through the chat
  reasoning/action path instead of being disguised as token-zero reads.
- Avoid single-tenant runtime assumptions in prompts, caches, background jobs,
  provider fallbacks, and user-facing copy. Hardcoded founder identity belongs
  only in docs, provenance notes, or explicit owner-only fixtures.
- If credentials, APNs, TestFlight, OAuth, HealthKit, Gmail/Outlook, or provider
  access are required, document the exact env/command and mark the item as
  manual verification required.
- **Agent model + effort policy.** This environment runs on Claude Opus 4.8 with
  the 1M context window at `xhigh` effort — for the main session and every
  subagent (enforced in global `~/.claude/settings.json` via
  `"model": "claude-opus-4-8[1m]"` plus `"effortLevel": "xhigh"`; subagents
  inherit the session model by default). `xhigh` is Anthropic's recommended
  setting for coding/agentic work; escalate to `/effort max` ad hoc for the
  hardest tasks. Opus 4.8 follows instructions literally and spawns fewer
  subagents than prior models, so state scope and any desired parallel fan-out
  explicitly.

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
5. **No hardcoded product behavior.** Chat, skills, routing, recipe parsing, task execution, and provider fixes must be capability/schema/policy driven. Do not add runtime branches for a specific user, email, tenant, dish, task title, screenshot example, or demo phrase. Regression examples belong in tests or corpora; production behavior must generalize.

### Testing

- Tests live in `__tests__/` mirroring `src/` structure.
- External APIs are ALWAYS mocked. Tests that hit real network fail CI.
- SQLite tests use `:memory:`.
- Bug fixes include a failing-test-before-fix whenever reasonable.
- `_resetDecryptCacheForTests()` in `beforeEach` if the test uses `oauth-store` — the decrypted-token LRU is module-scoped.

### Local-dev sandbox

Default loop for testing changes before staging:

1. **Boot:** `./scripts/local-up.sh` (Docker; idempotent — no-op if already running).
2. **Smoke:** `./scripts/local-smoke.sh` (5-check contract; matches `staging-smoke.sh` minus PM2 checks).
3. **iOS Simulator:** `./scripts/sim-local.sh` or select the "Nexus Hub Local Dev" Xcode scheme.
4. **Tear down:** `./scripts/local-down.sh` (keeps `data/`) or `./scripts/local-reset.sh --yes` (full wipe).

**Cockpit** — for button-driven sandbox control instead of typing
shell commands: `./scripts/cockpit.sh` opens a browser cockpit at
`http://127.0.0.1:8210` with all of the above plus live container
status, today's AI spend, container log streaming, dev JWT minting,
and a focused vitest runner. Details: `scripts/cockpit/README.md`.

The pre-commit hook prints a soft warning when the sandbox isn't running. It never blocks. Full runbook at `docs/local-dev/README.md`. Doesn't replace staging — runs in parallel to the `deploy-staging.sh` / `promote-to-prod.sh` chain.

### Forbidden

- ❌ Modifying `.env`, `data/`, `content-engine/.venv/`
- ❌ Adding real API calls in tests
- ❌ Committing secrets (pre-commit hook enforces via `detect-secrets`)
- ❌ Hardcoding absolute paths (`os.homedir()` or `config.*` instead)
- ❌ Hardcoding user/email/tenant/recipe/task-specific behavior to make one chat example pass
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
| `src/portal/health-routes.ts` | `/public-status` public heartbeat plus `/health` and `/health/detailed` |

### Edge protection posture (Cloudflare)

Two surfaces, two postures. Do not collapse them.

- `nexushub.me` (Cloudflare Pages, marketing) is intentionally permissive to
  AI crawlers and user-triggered fetchers for product discoverability. The
  application-level posture lives in `nexushub-landing-deploy/_headers`,
  `robots.txt`, and `llms.txt`.
- `api.nexushub.me` (VPS via Cloudflare Tunnel) stays strict. The only
  externally allowlisted path is `/public-status`, whose payload is limited to
  `{status, service, timestamp}` so the WAF exception can stay path-scoped and
  safe. Staging can use the same exception later, but only after
  `api-staging.nexushub.me` has a live DNS route.

Canonical dashboard steps and diagnostics live in
`/Users/felipedominguez/Desktop/Nexus Hub/docs/runbooks/cloudflared-tunnel.md`
under **Edge Protection And AI Crawler Policy**. Do not add diagnostic fields
to `/public-status`; its safety budget depends on the minimal payload.

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
