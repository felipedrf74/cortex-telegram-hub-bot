# Nexus Hub Agent Technical Mastery Pack

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-05-04
Update policy: update when a new top-level area is added (new domain, new
provider, new release gate), when an architectural rule changes, or when a
recurring agent failure mode produces a new anti-pattern. Do not duplicate
material from `engine/docs/engineering/*-standard.md` — link instead. The
companion docs are `OPERATING_CONTEXT.md` (workspace bootloader) and
`AGENT_PROCESS_STANDARD.md` (how agents operate).

This file is the cross-repo technical onboarding pack. It is what Claude Code
and Codex should read once before touching code, and refer back to when
deciding which standard / which test / which file is load-bearing.

It is **not** a generic Node/TypeScript primer. Every claim is anchored in a
file path inside `/Users/felipedominguez/Desktop/Nexus Hub/`.

---

## 1. Five-minute orientation

**Workspace root**: `/Users/felipedominguez/Desktop/Nexus Hub`
- `engine/` — Node/TypeScript backend, Python content-engine subprocess, SQLite, prompts, migrations
- `ios/` — iOS app (symlink to `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`)
- `ios-specs/` — backend↔iOS contract specs
- `docs/` — workspace-level canonical docs (this file, OPERATING_CONTEXT, release state, archive)

**Production truth (last verified 2026-05-04)**:
- Backend deployed via `engine/scripts/promote-to-prod.sh`. Live version,
  branch, commit, and migration count are auto-generated into
  `docs/release/release-identity.md` by the pre-commit hook — never hand-type
  those values.
- For active release scope, see `docs/release/CURRENT_RELEASE_STATE.md`.
- Source-tree shape (counts that change rarely): roughly 100+ migrations,
  80+ route files, 180+ service files in `engine/`. Use `ls engine/migrations
  | wc -l` etc. to verify when relevant.

**Process model**:
- Production PM2: two processes — `nexus-hub` (TS bot + iOS REST) and
  `content-engine` (Python FastAPI on `:8100`, loopback only). Staging adds
  the sibling `nexus-hub-staging` and `content-engine-staging` processes on
  `:8201` / `:8101` when deployed.
- Cloudflare Tunnel exposes `api.nexushub.me` → backend; marketing landing on Cloudflare Pages at `nexushub.me`
- Single Linux VPS, `dominguez@serverdominguez`, local-network deploy from Felipe's Mac

**Tech stack (versions pinned in `engine/package.json`)**:
- Node `>=20 <26`, TypeScript `^5.9.3` (CommonJS), Express `^5.2.1`, better-sqlite3 `^12.6.2`
- Vitest `^3.1.1` with `pool: 'forks'`, `singleFork: false`, 10s default timeout
- pino `^10.3.1` with 80+ redaction paths and ALS-driven `reqId/userId` mixin
- Sentry `@sentry/node ^10.47.0`, init at boot before DB
- AI SDKs: `@google/generative-ai ^0.24.1` (primary), `@anthropic-ai/sdk ^0.78.0` (fallback), `openai ^6.33.0` (secondary fallback)
- Python content-engine: FastAPI 0.115.6, uvicorn 0.34.0, pydantic 2.10.4, aiosqlite 0.20.0, httpx 0.28.1 — **NO direct AI SDKs**

**Read in order before editing**:
1. `docs/DOCS_INDEX.md`
2. `docs/agent/OPERATING_CONTEXT.md`
3. `docs/agent/AGENT_PROCESS_STANDARD.md`
4. **This file**
5. `docs/release/CURRENT_RELEASE_STATE.md`
6. `docs/release/OPEN_ITEMS.md`
7. `engine/CLAUDE.md` or `ios/CLAUDE.md`
8. The relevant engineering standard from
   `engine/docs/engineering/ENGINEERING_STANDARDS_INDEX.md`

---

## 2. Architecture map

```
┌───────────────────────────────────────────────────────────────────────┐
│                         Cloudflare Tunnel (api.nexushub.me)           │
└─────────────────────┬─────────────────────────────┬───────────────────┘
                      │                             │
              ┌───────▼─────────┐           ┌───────▼───────┐
              │  Express :8200  │           │  Telegram bot │
              │ (nexus-hub PM2) │           │  (legacy gated)│
              └───────┬─────────┘           └───────────────┘
                      │
        ┌─────────────┼─────────────────────────────┐
        │             │                             │
        ▼             ▼                             ▼
   ┌─────────┐  ┌──────────┐                 ┌────────────┐
   │ /api/v1/│  │ /portal  │                 │ /webhooks  │
   │ (iOS)   │  │ (admin)  │                 │ (signed)   │
   │ JWT     │  │ token    │                 │ raw bytes  │
   └────┬────┘  └────┬─────┘                 └────────────┘
        │            │
        ▼            ▼
   ┌─────────────────────────────────────────────────────┐
   │           src/services/* (~188 modules)             │
   │  - database.ts (better-sqlite3, WAL, FK on)         │
   │  - provider-registry / domain-provider-router       │
   │  - tool-executor (allowlist + tenant gate)          │
   │  - unified-calendar / microsoft-todo / garmin       │
   │  - intelligence-bus (cross-skill signals)           │
   │  - oauth-store (AES-256-GCM at rest)                │
   │  - scheduler.ts (28+ cron jobs)                     │
   └───────────┬─────────────────────────────────────────┘
               │
       ┌───────┴────────────┬────────────────────────────┐
       ▼                    ▼                            ▼
   ┌────────┐       ┌────────────┐               ┌──────────────┐
   │ SQLite │       │ AI providers│               │ content-engine│
   │ bot.db │       │ Gemini/Anth │               │ FastAPI :8100 │
   │  WAL   │       │ /OpenAI     │               │ (loopback)    │
   └────────┘       └─────────────┘               └──────────────┘
                                                        │
                                                        ▼
                                                ┌──────────────────┐
                                                │ /api/v1/internal/│
                                                │  ai-complete     │
                                                │ (proxies back to │
                                                │  TS provider     │
                                                │  registry)       │
                                                └──────────────────┘
```

**Three load-bearing rules to memorize**:
1. **Token-zero**: operational data lookups go through REST routes, never through
   the chat pipeline. Spec: `ios-specs/08-TOKEN-ZERO-ARCHITECTURE.md`. Code:
   `engine/src/api/routes/chat-message-local-responses.ts` has fast-paths that
   intercept identity / slash-command / training-plan reads BEFORE any AI call.
2. **`req.userId === req.tenantId`**: the JWT `userId` is hard-mirrored to
   `tenantId` at `engine/src/api/auth-middleware.ts:207-208`. Any
   `x-nexus-active-tenant-id` header that disagrees → 403 + `recordTenantScopeAnomaly`.
3. **Live model routing**: never hardcode `config.anthropic.model` /
   `gemini-1.5-flash` / GPT model names in new code. Use
   `getActiveProvider()`, `completeOneShotWithFallback`, or domain handlers
   that route via `engine/src/services/domain-provider-router.ts`.

---

## 3. Source tree guide (`engine/src/`)

| Dir | Purpose | Tenant boundary | Tests |
|---|---|---|---|
| `adapters/` | Thin shims over external SDKs (googleapis, Graph) | n/a | minimal — adapter shape pinned via service tests |
| `agents/` | 5 cron-driven content agents (`pipeline-tracker`, `seo`, `reaction-radar`, `performance`, `voice-evolution`) | tenant-scoped writes only | `__tests__/agents/` |
| `api/` | iOS REST router (`router.ts:44 createApiRouter`), `auth-middleware.ts:61 authMiddleware`, `rate-limiter.ts:78 rateLimitMiddleware`, `entitlement-middleware.ts:57 requireEntitlement`, `response-helpers.ts apiSuccess/apiError/apiPaginated` | JWT-gated; `req.userId === req.tenantId` invariant | `__tests__/api/` |
| `commands/` | Telegram slash-command handlers | only when `TELEGRAM_LEGACY_DELIVERY=true` | `__tests__/commands/` |
| `domains/` | secretary / triathlon / content / finance / cooking handlers | should not import `api/` | `__tests__/domains/` |
| `handlers/` | Telegram dispatcher | legacy-only | `__tests__/handlers/` |
| `portal/` | Express admin + status portal on `:8200`, `landing.html`, `auth/password-reset.html`, `portal.html` SPA | gated by `requirePortalTokenByMethod` on `/api/*` (NOT `/api/v1/*`) | `__tests__/portal/` |
| `router/` | Legacy/non-HTTP classification helpers for message and sport routing (`classifier.ts`, `sport-classifier.ts`) | should stay deterministic and side-effect-free | covered indirectly by chat/domain tests |
| `sdk/` | Local skill/plugin authoring helpers (`create-skill`, `define-tools`, `define-agents`, examples) | no runtime tenant access; used for developer ergonomics | add focused tests when SDK shapes change |
| `services/` | ~188 service modules — database, scheduler, oauth-store, providers, calendar, training, cooking, finance, content, signals | the ground truth for tenant safety lives here | `__tests__/services/` |
| `skills/` | Skill catalog (`skill-config.ts:30-40 SubSkillDefinition` with `dependencies`), `skill-manager.ts seedDefaultSkills + isCronJobEnabled`, `prompt-validator.ts runStartupPromptValidation` (boot-blocker, `index.ts:108-113`) | single source of truth for domain → sub-skill → tool mapping | `__tests__/skills/` |
| `state/` | DB-row repositories (reminders, conversation, fiscal-collection-profiles, saved-ideas, content-references, shared-memory) | tenant-scoped queries only; no HTTP/AI | `__tests__/state/` |
| `tools/` | Eval harnesses (`training-eval-harness.ts`, `content-evaluation-harness.ts`, `chat-evaluation-harness.ts`), preflights | run as `node dist/tools/*.js` | `__tests__/tools/` |
| `utils/` | logger, request-context (ALS), encryption, telegram-formatter, date-parser, i18n | NEVER import `services/database.ts` from here (cycle) | `__tests__/utils/` |

**Top-level boot sequence** (`engine/src/index.ts`):
1. `import './boot'` FIRST — installs process error handlers (`engine/src/services/error-monitor.ts`)
2. `initSentry()` → `initDatabase()` → migrations → `runStartupPromptValidation()` → start scheduler → start Express → optional Telegram bot when `TELEGRAM_LEGACY_DELIVERY=true`
3. `process.on('SIGTERM')` / `'SIGINT')` → graceful shutdown with `Sentry.flush(2000)`

---

## 4. API + contract guide

**Mount tree** (`engine/src/api/router.ts`, `engine/src/portal/server.ts`):
- `/api/v1/auth/*` — public (rate-limited by IP), routes for register / refresh / login / logout / google / apple / password-reset
- `/api/v1/internal/*` — Python content-engine reaches in here; auth via `x-internal-secret: ${INTERNAL_API_SECRET}` (NOT JWT)
- `/api/v1/billing/apple-notifications` — Apple App Store Server Notifications, JWS-validated, returns 200 always
- `/api/v1/admin/content-dashboard`, `/api/v1/admin/content` — portal-token-gated
- Everything else under `/api/v1/*` — JWT-gated by `authMiddleware` + rate-limited + entitlement-gated where required (`/content`, `/cooking`, `/finance`, `/invoices`)
- `/portal/*` and `/api/*` (NOT `/api/v1/*`) — admin portal, gated by `requirePortalTokenByMethod`
- `/webhooks/todoist`, `/webhooks/telegram` — public, signature-verified, mounted BEFORE `express.json()` so raw bytes are preserved
- `/auth/password-reset` — static HTML page (added 2026-05-04, AUTH-O2 follow-up)

**Standard response envelope** (`engine/src/api/response-helpers.ts`):
```ts
// Success: { ok: true, data: T, cached?, timestamp }
apiSuccess<T>(data, { cached })
sendSuccess(res, data, { status })

// Error: { ok: false, error: { code, message, details? }, timestamp }
sendError(res, code, message, status, details?)
sendInternalError(res, err, userMessage, logTag)  // never leaks err.message

// Paginated
apiPaginated<T>(data, page, total, perPage)

// Async wrapper
asyncHandler(handler)  // catches throws, captures to Sentry+error_log, emits stable INTERNAL/500
```

Standard error codes: `BAD_REQUEST` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403,
`NOT_FOUND` 404, `CONFLICT` 409, `RATE_LIMITED` 429, `INTERNAL` 500,
`SERVICE_UNAVAILABLE` 503, `TIER_REQUIRED` (entitlement gate), plus typed auth
codes (`AUTH_FAILED`, `REGISTRATION_REJECTED`, `INVALID_TOKEN`,
`TOO_MANY_ATTEMPTS`, `WEAK_PASSWORD`, `EMAIL_NOT_VERIFIED`,
`GOOGLE_EMAIL_NOT_VERIFIED`, `ACCOUNT_LINK_REQUIRES_VERIFICATION`,
`PRIVATERELAY_LINK_REFUSED`, `INVALID_INVITE`).

**DTO compatibility**: additive fields only. iOS clients ignore unknown keys
per `ios/docs/engineering/ios-architecture-and-swiftui-performance-standard`.
Removing or renaming a field requires a coordinated dual-write phase. See
§13 below for the full deprecation pattern.

**Rate limiter** (`engine/src/api/rate-limiter.ts`):
- 1-min sliding window
- Authenticated: write 60/min, read 300/min (or `config.ios.rateLimit`)
- Unauthenticated (auth/register/refresh): keyed by `req.socket.remoteAddress`, 30/min — proxy chain explicitly distrusted
- Internal shared-secret routes: 180/min default, `INTERNAL_AI_COMPLETE_RATE_LIMIT` 60/min

**iOS contract spec**: `ios-specs/02-API-SPECIFICATION.md`. Token-zero rule:
`ios-specs/08-TOKEN-ZERO-ARCHITECTURE.md`.

---

## 5. Storage + SQLite + migrations guide

**Database init** (`engine/src/services/database.ts:60-141 initDatabase()`):
1. `new SQLiteStorage()` + `open(path)` → `journal_mode=WAL`, `foreign_keys=ON`,
   `busy_timeout=5000`
2. `setStorageProvider(storage)`, `db = storage.raw()`
3. `runMigrations()` (lines 144-190)
4. `backfillLegacyRefreshTokenHashes()` (AUTH-O4 backfill)
5. `loadModelOverrides()` from `kv_store`
6. `DatabaseConfigProvider.loadPersistedSettings()`
7. `seedOwnerUser()` + `assertOwnerBootstrapReadyForRuntime()` (P0 audit fix —
   throws on ambiguity)
8. `assertOAuthEncryptionConfigured()` — boot DIES if `OAUTH_ENCRYPTION_KEY`
   missing (`engine/src/services/database.ts:109-127`)
9. `migrateOwnerTokens()`, `seedDefaultSkills()`

**Migration convention** (`engine/migrations/`, currently 115 files):
- Naming: `NNN_descriptive-name.sql`
- Runner reads `migrations/*.sql` sorted alphabetically; warns on prefix
  collisions (`engine/src/services/database.ts:160-168`); records in
  `_migrations(filename UNIQUE, applied_at)`
- Idempotent: use `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`
- SQLite has no `ALTER COLUMN` — table-rebuild pattern (see migration 110 for
  the canonical example: rebuild `ios_devices` to add hash columns)

**Transactions** (synchronous, better-sqlite3):
```ts
import { storage } from './services/storage-provider';
storage.transaction(() => {
  // sync ops only — NO await inside
});
// auto-commit on return; rollback on throw
```

**Tenant ownership pattern**: `users.id` is the canonical tenant key today.
Three representative tables:
- `users` (`migrations/030_users.sql:3-19`) — `id` PK
- `ios_devices` (rebuilt in `migrations/110_…sql:43-65`) — `user_id NOT NULL`,
  `device_id UNIQUE`, hashed refresh tokens
- `password_reset_tokens` (`migrations/109_…sql:34-42`) — `user_id PRIMARY KEY`
  (UPSERT collapses prior active token)

**Test setup**: `engine/__tests__/setup.ts` sets `DATABASE_PATH=':memory:'`,
mocks Anthropic SDK + grammy + pino. Re-run `_resetDecryptCacheForTests()`
in `beforeEach` if your test uses `oauth-store`.

**Standard**: `engine/docs/engineering/backend-api-contract-standard.md`.

---

## 6. Model routing + AI provider guide

**Three independent dimensions** that compose at call time:
1. Per **task type** (`classify | chat | tool-use`) — `engine/src/config.ts:164-187`
2. Per **domain** (`secretary | triathlon | content | finance | cooking`) —
   `engine/src/services/domain-provider-router.ts:40-58`
3. Per **role/provider model** — `engine/src/services/model-config.ts:155-191`

**Production routing today** (`domain-provider-router.ts:40-58`):

| Domain | Primary | Fallback |
|---|---|---|
| secretary | `openai` (GPT-5.4 nano) | `gemini` |
| triathlon | `gemini` | `anthropic` |
| content | `gemini` | `anthropic` |
| finance | `gemini` | `anthropic` |
| cooking | `gemini` | `anthropic` |

**Two kill-switches**:
- `GEMINI_ROUTING_ENABLED=false` → every domain falls back to Anthropic
- `GEMINI_INCLUDE_SECRETARY=false` → only secretary is emergency-routed

Both are dual-source: env at boot AND `kv_store` row override (live-mutable
via portal).

**Default fallback chain across task types**: `gemini → openai → anthropic
(only if ANTHROPIC_ENABLED=true)`. Circuit breaker
(`engine/src/services/provider-fallback.ts:243-330`):
- `failureThreshold=3` consecutive retryable errors → OPEN
- `cooldownMs=60000` → HALF_OPEN probe → success closes
- `isRetryableError` only counts 429/5xx/network/`overloaded_error`; 4xx auth
  errors throw immediately and never trip the breaker

**Where provider calls are ALLOWED**:
- Chat router (`engine/src/api/routes/chat-message-routes.ts`)
- Domain handlers (`engine/src/domains/*/handler.ts`)
- Tool continuation loop (`engine/src/api/routes/chat-message-execution.ts`)
- One-shot wrappers in `engine/src/services/gemini-provider.ts` (`completeOneShot`,
  `completeOneShotWithFallback`, `completeVisionOneShot*`)
- Python content-engine via `/api/v1/internal/ai-complete` (proxied back here)

**Where provider calls are FORBIDDEN** (token-zero):
- Anything in `engine/src/api/routes/*` that returns operational data
- Tasks (`tasks-routes.ts`), calendar agenda (`calendar-*.ts`), training plan
  reads (`training-*.ts`), cooking lookups (`cooking-routes.ts`), finance
  reads (`finance-*.ts`)

**`trackedCreate` is the ONLY valid Anthropic entry point**
(`engine/src/portal/anthropic-hook.ts:78-185`):
- Kill-switch: throws unless `ANTHROPIC_ENABLED=true`
- Cost ledger: writes `api_usage(category, model, tenant_id, user_id,
  input/output/cache tokens, cost_usd, duration_ms)`
- Direct `anthropic.messages.create(...)` bypasses both — DO NOT use

**`completeOneShotWithFallback` signature** (`gemini-provider.ts:481-528`):
```ts
completeOneShotWithFallback(
  systemPrompt: string,
  userPrompt: string,
  category: string,
  anthropicFallback: () => Promise<string>,
  options?: OneShotOptions,
): Promise<{ text: string; provider: 'gemini' | 'openai' | 'anthropic' }>
```

**Model whitelist**: `engine/src/services/model-config.ts:285-301
MODEL_OPTIONS` is authoritative. Adding an aspirational model name (e.g.
`gemini-3-flash`) silently 404s every call (the v4.9.22 incident).

**Standard**: read the comments at the top of `provider-fallback.ts` and
`model-config.ts`. There is no separate "model routing standard" doc — the
runtime IS the spec.

---

## 7. Skill runtime guide

**Skill registry** (`engine/src/skills/skill-config.ts:493-495`):
- Seeded from `DEFAULT_SKILLS` (lines 480-486)
- Each domain is a `SkillDefinition` (lines 54-61)
- Each `SubSkillDefinition` (lines 30-40) has: name, description, tools,
  enabledByDefault, cronJobs?, dependencies?, requiredTier?, promptFile?,
  coachPersona?

**Dependency cascade** (`engine/src/skills/skill-manager.ts:198-258`):
- Enable: `checkSubSkillToggle` walks `getSubSkillDependencies` and refuses if
  any dep is unmet
- Disable: cascade-disables every dependent (e.g. disabling `training-plans`
  cascades to `gym`, `running`, `cycle`, `swim` because all sport personas
  depend on it)
- Cron jobs: `isCronJobEnabled(jobId)` refuses to run a cron whose owning
  sub-skill is disabled
- Any toggle invalidates the per-domain tool cache

**Per-domain quick reference**:

| Domain | Routes | Services | Prompts | Critical invariant |
|---|---|---|---|---|
| **Chat** | `engine/src/api/routes/chat-message-routes.ts` | `chat-context-engine`, `chat-skill-orchestrator`, `chat-tenant-scope`, `chat-tool-authorization` | (none — orchestration shell) | System prompt MUST NOT carry founder identity. Identity questions answered deterministically from JWT BEFORE any AI call (`chat-message-local-responses.ts:tryBuildAuthenticatedIdentityResponse`). |
| **Secretary** | `tasks-routes.ts`, `calendar-*.ts`, `notes-routes.ts`, `reminders-routes.ts` | `microsoft-todo`, `unified-calendar`, `task-store/*`, `scheduler.ts` (28+ crons) | `prompts/secretary.md`, `src/skills/secretary/prompts/system.md` | `taskCount` is a real number, never `-1`. Calendar reads honor degraded-provider markers and timezone windows. |
| **Training** | `training-*.ts`, `training-plan-generation.ts` | `coach-kernel/*` (strength-engine, support-session-builder, session-coherence, mobility-recovery-builder, adaptation-engine), `training-coach-kernel-plan-generator`, `training-plans` | `prompts/triathlon/gym`, `running`, `cycling`, `swim` (markdown) | Plan persistence is idempotent on retry via `training_agenda_event_ownership(plan_id, plan_version, event_id, source)` UNIQUE. Pre-persist cancellation saga returns `cancellation_failed` (HTTP 409) on local hard-delete failure — never produces double-plan corruption. |
| **Cooking** | `cooking-routes.ts` | `cooking-chef`, `cooking-preferences` (user-private), `cooking-cache-invalidator` | `prompts/cooking.md` | Pantry is tenant-scoped; preferences are user-private. Shopping unit normalization MUST run before aggregation. |
| **Finance** | `finance-*.ts` | `finance-tracker`, `finance-cache-invalidator`, encryption via `config.financeEncryption` | `prompts/finance.md` | Encryption defaults on (`FINANCE_ENCRYPTION_ENABLED=true`); transaction currency must be preserved. |
| **Content** | `content-routes.ts`, `content-script.ts`, `content-topics.ts`, `content-pipeline.ts` | `state/content-references` (Voice DNA), `state/saved-ideas`, `agents/voice-evolution-agent`, Python content-engine bridge | `prompts/content.md`, `prompts/topic-generation.md`, `prompts/creator-config.md` (NEUTRAL TEMPLATE) | `buildKnowledgePromptBlock(userId, tenantId)` MUST scope by tenant. `prompts/creator-config` MUST be neutral — no founder identity defaults. |

**Memory + retrieval**:
- `engine/src/services/context-engine.ts:getDailyContext` — domain-aware daily snapshot
- `engine/src/services/chat-context-engine.ts` — priority-ranked `ChatContextItem[]`, 2,600-char budget; authenticated-user item at priority 98 with `critical: true`
- `engine/src/state/saved-ideas.ts:getIdeasBySource(source, userId)` — `userId` is REQUIRED
- `engine/src/state/content-references.ts:buildKnowledgePromptBlock(userId, tenantId)` — Voice DNA + content_knowledge synthesizer

**Tool dispatch flow** (`engine/src/services/tool-executor.ts`):
1. Allowlist check (`assertToolAllowlistIsConsistent` runs at module load) →
   `TOOL_NOT_ALLOWED` rejects unlisted names
2. `authorizeChatToolCall` checks tool risk × tenant scope × pending confirmations
3. `requireTenantToolUserId` resolves canonical user_id; refuses if `input.user_id`
   disagrees with the chat-context userId
4. Switch dispatch to underlying service
5. Cache invalidation after mutations
6. Signal publication for sport-load detection (writes `agent_signals`)

**Intelligence-bus** (`engine/src/services/intelligence-bus.ts`):
- Cross-skill SQLite-backed pub/sub
- Global signals (`user_id IS NULL`): `hook_effectiveness`, `pillar_performance`,
  `voice_pattern`, `book_knowledge`, `trending_spike`, `content_published`
- Per-user signals (REQUIRE `user_id > 0`): `gym_load_today`, `low_sleep`,
  `low_hrv`, `low_readiness`, `planned_hard_run`, `low_adherence`, `plan_drift`,
  `training_plan_canceled`
- `meshPriority=1` signals invalidate planning caches

**Standard**: `engine/docs/SKILL_ARCHITECTURE.md`.

---

## 8. Python content-engine guide

**Process model**:
- Uvicorn on `127.0.0.1:8100` — loopback only, NOT externally exposed
- PM2 process `content-engine`; deploy starts content-engine BEFORE nexus-hub
  so health checks succeed
- Venv at `engine/content-engine/.venv/`; deploy preserves venv, only re-runs
  `pip install -q -r requirements.txt`
- Python venv is NEVER touched by tests or normal local work; modify only via
  `requirements.txt`

**No direct AI SDK access**. The content-engine has only 6 dependencies (none
are `anthropic` / `openai` / `google-generativeai`). `content-engine/config.py`
still exposes a legacy `anthropic_api_key` setting, but the dependency and call
path are intentionally absent; do not treat that env reader as permission to
add a Python provider client. Every AI call goes through
`/api/v1/internal/ai-complete` on the TS backend with
`x-internal-secret: ${INTERNAL_API_SECRET}`. See
`engine/content-engine/services/claude_client.py:1-22` for the architectural
note. The TS proxy enforces provider cascade, usage metering, and the kill
switch.

**Bridge** (`engine/src/services/content-engine.ts`):
- Base URL: `http://localhost:${config.contentEngine.port}/api/v1`
- `engineFetch<T>` with 30s default timeout (180s for `/deepsearch`, 300s for
  deep-mode scripts)
- Circuit breaker: 3 consecutive failures → OPEN, 5min cooldown
- `/health` cached 60s
- `X-Request-Id` propagated via `getCurrentRequestId()`

**Endpoints exposed**: `/api/v1/{deepsearch, sources, hotnews, trending,
reaction, hooks, script, titles, thumbnail, caption, competitor, gaps, seo,
repurpose, feedback, report, books/extract}`.

**Identity safety** (4.14.118 P0 closeout): `creator_profile.py:_FALLBACK_PROFILE`
is NEUTRAL — no name, no worldview, no audience. Real creator identity is
loaded per-request from the authenticated user's tenant-scoped DB rows. Never
add specific creator identity to `creator_profile.py`.

**Boundary characterization**: trusted-loopback model. Compromised
content-engine can lie about `userId`, but can't make AI calls without the
shared secret and can't reach external network from production behind the
firewall.

---

## 9. Security + tenant guide

The full standard is `engine/docs/engineering/security-and-data-isolation-standard.md`.
Highlights:

**Auth chain** (`engine/src/api/auth-middleware.ts`):
1. JWT extracted from `Authorization: Bearer <jwt>`; payload validated as
   integer via `isValidTenantUserId`
2. User row must exist and `status === 'active'`; fails closed on DB error
3. `ios_devices` row must exist for `(user_id, device_id)` — closes the
   post-logout window
4. `req.userId === req.tenantId` at lines 207-208; mismatching
   `x-nexus-active-tenant-id` header → 403 + anomaly recorded

**Auth provider link guards**:
- AUTH-O8 Apple privaterelay: `auth.ts:435-477` refuses to link a
  `@privaterelay.appleid.com` email to an existing email-matched user without
  `apple_user_id`
- Google `email_verified`: `services/google-sign-in.ts:54-220` —
  `validateGoogleIdentityPayload` normalizes string/boolean/numeric to strict
  bool; `resolveGoogleIdentityUser` throws `GoogleEmailNotVerifiedError` /
  `GoogleAccountLinkRequiresVerificationError` for the unverified-merge case
- AUTH-O4 refresh-token theft: `ios_devices.{refresh_token_hash,
  previous_refresh_token_hash}` — replay of `previous_refresh_token_hash`
  triggers `DELETE FROM ios_devices WHERE user_id = ?` (revoke all sessions)

**AUTH-O7 account lockout** (`engine/src/services/account-lockout.ts`):
- 10 failed attempts in a 15-minute sliding window → 15-minute lockout
- `assertNotLocked(userId)` BEFORE bcrypt to avoid CPU burn
- Locked accounts return generic `AUTH_FAILED 401` (anti-enumeration); lockout
  hint persists ONLY in audit row

**AUTH-O11 portal-beta hardening** (`engine/src/portal/security.ts:130-193`):
- Refuses to boot with `PORTAL_BETA_HARDENED=true` AND non-beta-safe exposure
  mode (beta-safe = `disabled | loopback_only | session_only | signed_static`)
- Refuses to boot with `PORTAL_BETA_HARDENED=true` AND empty `PORTAL_ADMIN_TOKEN`
  (legacy `PORTAL_TOKEN` would double as admin)

**Hashing policy**:
- Passwords: bcrypt cost 12 (`engine/src/api/routes/auth.ts:771`)
- Refresh tokens at rest: SHA-256 (rationale: 512-bit token entropy makes bcrypt
  cost factor irrelevant; SHA-256 enables O(1) indexed lookup)
- Password-reset tokens: 32 random bytes URL-safe base64, SHA-256 at rest, 1h
  TTL, 5-attempt cap, single-use enforced via `used_at IS NULL` predicate
- OAuth refresh tokens: AES-256-GCM via `OAUTH_ENCRYPTION_KEY`; boot dies if
  unset

**Anti-enumeration**:
- `/auth/register` returns `REGISTRATION_REJECTED 400` for both "email exists"
  and "validation failed" (same status as malformed-request)
- `/auth/login/email` returns `AUTH_FAILED 401` for user-not-found AND
  wrong-password AND locked-account
- `/auth/password-reset/request` returns the same envelope on every path with
  a 150ms response floor (`waitForPasswordResetRequestFloor`) to defeat timing
  oracles

**Memory scope**:
- `WHERE user_id IN (0, ?)` is BANNED — every scoped read uses explicit
  `WHERE user_id = ?`
- Fixtures get `is_fixture: 1` and are gated by `NEXUS_STAGING=1` /
  `NEXUS_FIXTURE_MODE=1`
- `getIdeasBySource(source, userId)` requires explicit `userId`
- `buildKnowledgePromptBlock(userId, tenantId)` requires explicit scope; pinned
  by `__tests__/security/p0-chat-identity-isolation.test.ts`

**Prompt cleanliness**:
- Five domain prompts neutral (secretary, content, cooking, finance,
  topic-generation); skill prompts neutral; `prompts/creator-config` is a NEUTRAL
  TEMPLATE
- Pinned by `__tests__/services/prompt-cleanliness.test.ts` (72 cases) and
  `__tests__/security/p0-chat-identity-isolation.test.ts` (23 cases)

**Audit logging** (`engine/src/services/audit-trail.ts`):
- Action type union: `export | delete | access | encrypt | decrypt | admin_mutation`
- `logAudit({ userId, tenantId?, actorId, action, resource, details?, ipAddress? })`
- `tenant_id = entry.tenantId ?? entry.userId` — preserves the
  `req.userId === req.tenantId` invariant on the audit table
- `audit_trail` rows are exempt from user-deletion (GDPR Art. 17(3)(e))

**Single-tenant cron gating**: `fossa_email` cron in `scheduler.ts` gated
behind `FOSSA_EMAIL_ENABLED=1` IN ADDITION to OUTLOOK availability. Any new
single-tenant flow MUST follow the same dual-gate pattern.

---

## 10. Testing + release guide

**Hierarchy of evidence**:
- E1 — unit/contract test (vitest, XCTest)
- E2 — simulator workflow
- E3 — physical-device interaction
- E4 — staging smoke + production health
- E5 — signed TestFlight or two-account walk-through

E5 is the only level requiring manual operator entry via
`engine/scripts/testflight-evidence.sh --apply`.

**Decision tree for "what tests do I run?"**:
1. Run `engine/scripts/changed-area-classifier.sh --base origin/main --format json`
   first. The classifier is the source of truth.
2. If classifier returns `mode=skip` → docs-only diff, no vitest
3. If `mode=focused` → run the listed globs
4. If `mode=changed-only` → `npx vitest run --changed origin/main`
5. If `mode=full` → `npx vitest run`

**When the full sweep is required**:
- `vitest.config.ts` or `package*.json` is staged
- Pre-push to `main | release/* | rc/* | feature/p0-* | feature/release-*`
- `NEXUS_PRECOMMIT_FULL_VITEST=1` operator override

**Pre-commit hook** (`engine/.husky/pre-commit`):
1. `set -e`, `tsc --noEmit` ALWAYS
2. Auto-refresh release-identity artifact if a current-verdict doc is staged
3. Vitest gated by classifier (`skip | focused | changed-only | full`)

**Pre-push hook** (`engine/.husky/pre-push`):
- RC-class branch regex auto-escalates to full vitest

**Release pipeline**:
1. Focused tests/typecheck (`npm run verify` for full sweep)
2. Push to `main`
3. `./scripts/deploy-staging.sh`
4. Soak 5 min minimum
5. `./scripts/staging-smoke.sh` — 17-check generic + classifier-driven domain probes
6. `./scripts/promote-to-prod.sh` — re-runs staging smoke as a HARD gate;
   refuses to deploy if smoke fails
7. Production health checks
8. Update `docs/release/CURRENT_RELEASE_STATE.md`

**Cannot-skip gates** (23 total, validated by
`engine/scripts/cannot-skip-gate-dashboard.sh`):
`tenant-auth-security`, `memory-retrieval-isolation`, `prompt-injection-defense`,
`calendar-agenda-lifecycle`, `provider-routing-fallback`,
`migration-rollback-review`, `deploy-script-promotion-rehearsal`,
`hook-validation-on-feature-branch`, `ci-workflow-validation-on-PR`,
`test-config-mock-completeness-audit`, `attachment-tenant-isolation`,
`model-routing-cost-attribution`, `personalization-scope-isolation`,
`content-agent-neutrality`, `logger-redaction-pii-scan`,
`scheduler-tenant-scope-and-failure`,
`notification-apns-delivery-and-tenant`,
`health-integration-tenant-isolation`, `auth-rate-limit-and-lockout`,
`audit-trail-emission-and-scope`, `deploy-config-health-rehearsal`,
`ios-navigation-responsiveness`, `ios-contract-decoder-resilience`.

**Smoke evidence**:
- Wrap any smoke command via
  `engine/scripts/with-smoke-evidence.sh <name> <cmd>`
- JSON evidence lands in `engine/docs/release/smoke-evidence/<smoke-name>-<sha>-<utc>.json`

**Release identity**: `engine/scripts/release-identity.sh --persist` writes
`docs/release/release-identity.{json,md}` — never hand-type branch / commit /
version / migration counts.

**Docs drift**: run `npm run docs:audit` before copying any verdict / commit /
test count into markdown. Interpret the result using
`engine/docs/release/docs-audit-baseline-policy.md`; the historical frozen
baseline started at 486 issues, and any run above 491 requires a per-class diff
instead of a blanket "green" claim.

**Standards**:
- `engine/docs/engineering/testing-and-qa-harness-standard.md`
- `engine/docs/release/risk-based-release-gate-matrix.md`
- `engine/docs/release/production-promotion-checklist-v2.md`
- `engine/docs/release/closed-beta-runbook.md`

---

## 11. Common anti-patterns

Each entry cites the file:line that proves the anti-pattern was real.

1. **Direct `anthropic.messages.create(...)`**. Bypasses the kill switch
   (`engine/src/portal/anthropic-hook.ts:85-97`) AND the cost ledger.
   Always use `trackedCreate` or `completeOneShotWithFallback`.
2. **Hardcoded `config.anthropic.model`**. Bypasses live model routing. Use
   `getActiveProvider()` / domain handlers / `getEffectiveDomainModel(provider, domain)`.
3. **Partial `vi.mock(modulePath, factory)`**. Factory must return ALL exports.
   Run `engine/scripts/vi-mock-completeness-lint.mjs` before merge. Past
   incident: `c84001f` (16 deterministic failures in full sweep, green in
   isolation, caused by partial mock of `unified-calendar`).
4. **Re-enabling `singleFork: true`** without measuring. `engine/vitest.config.ts:34-44`
   documents 7.22× speedup with per-fork isolation. Only re-enable if
   `vi.mock` partial-pollution returns and the lint catches it.
5. **Skipping `boot.ts` import order**. `engine/src/index.ts:6` imports
   `./boot` FIRST. Adding imports above that line means boot-phase config
   errors will skip `error_log`.
6. **Calling `getDb()` from `utils/`**. The logger's mixin pattern and the
   ALS request-context have ZERO project imports beyond `request-context`.
   Adding a DB read here creates a cycle and breaks `boot.ts` ordering.
7. **Mounting `express.json()` before `/webhooks`**. `engine/src/portal/server.ts:128-133`
   mounts webhooks first because Todoist HMAC needs raw bytes. Reordering
   silently breaks signature verification — server happily parses body, then
   verifier sees `{}` instead of canonical bytes.
8. **Trusting `req.ip` for rate-limit keys**. `engine/src/api/rate-limiter.ts:69-76`
   uses `req.socket.remoteAddress` because the Cloudflare Tunnel deliberately
   doesn't trust the proxy chain. A rewrite to `req.ip` makes the IP bucket
   spoofable.
9. **Returning `err.message` to the client**. `engine/src/api/response-helpers.ts:240-279`
   already routes uncaught throws to `captureError` + Sentry. Returning the
   raw error leaks internals — keep the stable `INTERNAL` envelope.
10. **Adding a second owner-bootstrap source**. `engine/src/services/database.ts:98-107`
    runs `seedOwnerUser()` ONLY from `OWNER_TELEGRAM_ID` and then
    `assertOwnerBootstrapReadyForRuntime()` which throws on ambiguity. Adding
    an env-var fallback reverses a P0 audit fix.
11. **Bypassing the migration prefix collision lint**. `engine/src/services/database.ts:160-168`
    warns on duplicate `NNN_*` prefixes — apply order is filesystem-locale
    dependent. Use unique prefixes (or timestamp `YYYYMMDD_`).
12. **Reading `users.refresh_token` plaintext**. Migration 110 keeps the
    column for legacy rows but marks it non-authoritative. `hashRefreshToken`
    is the only valid path. Querying plaintext re-introduces AUTH-O4.
13. **`WHERE user_id IN (0, ?)` "global + per-user" lookups**. `4.14.118`
    audit closed every site. Use `WHERE user_id = ?` with explicit scope.
14. **Writing scattered `*-final-report.md` files**. The DOCS_INDEX rules
    explicitly disallow this. Update `docs/release/CURRENT_RELEASE_STATE.md`
    or `docs/release/OPEN_ITEMS.md` instead.
15. **Hand-typing branch / commit / version / test counts in markdown**.
    They drift. Use `release-identity.sh --persist`-generated artifacts.
16. **Creating chat fast-paths for data reads**. Token-zero rule. Add a REST
    route under `/api/v1/*` instead.
17. **Hardcoding "Felipe" / founder identity in prompts or fallbacks**.
    Pinned by 72-case `prompt-cleanliness.test.ts` + 23-case
    `p0-chat-identity-isolation.test.ts` + identity-scan strict mode.
18. **Skipping the staging smoke gate**. `promote-to-prod.sh:186-191` re-runs
    smoke and refuses to deploy on failure. The only legitimate
    `--skip-smoke` is owner-acknowledged with the reason captured in release
    state.
19. **Adding a partial `vi.mock` of `unified-calendar`** (or any module with
    multiple exports) without listing every export. The class of bug above.
20. **Adding a Python module that imports `anthropic` / `openai` /
    `google-generativeai`** directly. Python proxies through TS at
    `/api/v1/internal/ai-complete`. Direct provider calls bypass the kill
    switch and the cost ledger.

---

## 12. Safe-modification checklist (all areas)

Before opening a PR, verify:

- [ ] `git status` shows only files you intended to change
- [ ] `npx tsc --noEmit` clean
- [ ] `engine/scripts/changed-area-classifier.sh --base origin/main --format json`
      returns the expected scope; you ran the recommended tests
- [ ] If you touched a current-verdict doc (workspace
      `docs/release/CURRENT_RELEASE_STATE` / `OPEN_ITEMS`, engine
      `docs/qa/QA_BACKEND_REPORT`, iOS `docs/qa/QA_IOS_REPORT`, engine
      `docs/qa/QA_RELEASE_GATE_REPORT`): pre-commit auto-refreshed
      `release-identity.{json,md}`
- [ ] `npm run docs:audit` completed, and any count above the frozen-baseline
      buffer was classified by warning type per
      `engine/docs/release/docs-audit-baseline-policy.md`
- [ ] No literal SHA / version / test count typed by hand into markdown
- [ ] No new `*-final-report.md` / `*-audit.md` / `*-open-items.md` outside
      DOCS_INDEX-approved paths
- [ ] If touched auth/tenant/memory/prompt: extended
      `__tests__/security/p0-chat-identity-isolation.test.ts` AND
      `__tests__/services/prompt-cleanliness.test.ts`
- [ ] If touched migrations: unique numeric prefix; idempotent SQL; tested
      under `:memory:`
- [ ] If touched provider/model routing: tested fallback path under
      `GEMINI_ROUTING_ENABLED=false`; verified `MODEL_OPTIONS` whitelist update
- [ ] If touched iOS contract: additive only OR coordinated dual-write
      deprecation; `ios-specs/02-API-SPECIFICATION.md` updated
- [ ] No simulator / DB / tunnel / provider loop left running

---

## 13. What to read before editing each area

| If you're touching… | Read first |
|---|---|
| `engine/src/api/routes/*` | `engine/docs/engineering/backend-api-contract-standard.md` + `engine/src/api/router.ts` + `engine/src/api/auth-middleware.ts` |
| Auth, session, OAuth, tenant scope | `engine/docs/engineering/security-and-data-isolation-standard.md` + `engine/src/api/auth-middleware.ts` + `engine/src/api/routes/auth.ts` |
| Migrations | `engine/migrations/` (recent 3 files for pattern) + `engine/src/services/database.ts:144-190` |
| Model routing | `engine/src/config.ts:164-187` + `engine/src/services/provider-fallback.ts` + `engine/src/services/domain-provider-router.ts` + `engine/src/portal/anthropic-hook.ts` |
| Skills / sub-skills | `engine/docs/SKILL_ARCHITECTURE.md` + `engine/src/skills/skill-config.ts` + `engine/src/skills/skill-manager.ts` |
| Tools / tool dispatch | `engine/src/services/tool-executor.ts` + `engine/src/services/intelligence-bus.ts` |
| Training / coach kernel | `engine/src/services/coach-kernel/` (start at `session-coherence.ts`) + `engine/src/services/training-coach-kernel-plan-generator.ts` |
| Calendar / unified-calendar | `engine/src/services/unified-calendar.ts` + `engine/src/services/microsoft-todo.ts` |
| Python content-engine | `engine/content-engine/main.py` + `engine/content-engine/services/claude_client.py:1-22` (loopback / proxy contract) + `engine/src/services/content-engine.ts` (TS bridge) |
| Prompts (`prompts/*.md`) | `__tests__/services/prompt-cleanliness.test.ts` + `__tests__/security/p0-chat-identity-isolation.test.ts` |
| Tests / classifier / smokes | `engine/docs/engineering/testing-and-qa-harness-standard.md` + `engine/scripts/changed-area-classifier.sh` |
| Release / deploy | `engine/docs/release/production-promotion-checklist-v2.md` + `engine/scripts/promote-to-prod.sh` + `engine/scripts/deploy.sh` |
| iOS auth / sessions | `ios/Nexus Hub/Core/AuthManager.swift` + `engine/src/services/ios-auth-session.ts` + `ios-specs/02-API-SPECIFICATION.md` |
| iOS data flows | `ios-specs/08-TOKEN-ZERO-ARCHITECTURE.md` + `ios/docs/engineering/ios-architecture-and-swiftui-performance-standard` |
| Logger / observability | `engine/src/utils/logger.ts` + `engine/docs/OBSERVABILITY-ONCALL.md` + `engine/docs/engineering/runtime-and-observability-standard.md` |

---

## 14. Which tests to run for which changed area

The classifier is authoritative — this is the human-readable mirror.

| Changed area | Tests / smokes |
|---|---|
| `engine/src/api/routes/auth*`, `engine/src/services/{ios-auth-session, password-reset, account-lockout, google-sign-in, oauth-store}*` | `__tests__/api/auth-*.test.ts`, `__tests__/security/**/*.test.ts`, `__tests__/services/{password-reset, account-lockout, oauth-store, google-sign-in}.test.ts`, `__tests__/scope/**/*.test.ts` |
| `engine/src/api/auth-middleware.ts` | every test above PLUS full `npm run verify` |
| `engine/src/services/coach-kernel/*`, `engine/src/services/training-*` | `__tests__/services/coach-kernel-*.test.ts`, `__tests__/services/training-*.test.ts`, `__tests__/api/training-*.test.ts` |
| `engine/src/services/unified-calendar.ts` | `__tests__/api/calendar-*.test.ts`, `__tests__/services/microsoft-todo*.test.ts`, plus the calendar staging smoke |
| `engine/src/services/{cooking-*, finance-*}` | `__tests__/services/{cooking, finance}-*.test.ts` |
| `engine/src/services/{provider-registry, provider-fallback, domain-provider-router, model-config, anthropic, gemini-provider, openai-provider}*` | `__tests__/services/provider*.test.ts`, `__tests__/portal/anthropic-hook.test.ts`, `__tests__/portal/portal-cost-breakdown.test.ts` |
| `engine/migrations/*.sql` | full `npm run verify` (migration runner is exercised by every test that opens an in-memory DB) |
| `engine/src/skills/*` | `__tests__/skills/*.test.ts`, plus the test for any domain that owns the toggled sub-skill |
| `engine/prompts/*.md` | `__tests__/services/prompt-cleanliness.test.ts`, `__tests__/security/p0-chat-identity-isolation.test.ts` |
| `engine/content-engine/services/*` | TS-side integration tests that mock `engineFetch`; `engine/content-engine` Python is exercised via TS smoke |
| `engine/scripts/*` | `__tests__/scripts/changed-area-classifier.test.ts`, `__tests__/scripts/cannot-skip-gate-dashboard.test.ts` |
| `engine/.husky/*`, `engine/.github/workflows/*`, `engine/vitest.config.ts`, `engine/package.json` | full vitest sweep + `engine/scripts/cannot-skip-gate-dashboard.sh --json` |
| `ios/Nexus Hub/*.swift` | `xcodebuild test` for the focused class set; classifier returns `xctest.classes[]` |

---

## 15. Self-check before finalizing an answer

Before delivering an answer that involves code/docs changes, Claude/Codex must:

1. **Verify intent vs effect**: re-read the diff, not the commit message. Does
   the code do what the prose claims?
2. **Re-run the classifier**: `engine/scripts/changed-area-classifier.sh
   --base origin/main --format json`. Did you run every test it suggested?
3. **Verify the cannot-skip set**: anything in `cannotSkip[]` that wasn't
   exercised needs an explicit `skipped_by_risk_matrix` justification in the
   release state.
4. **Verify the docs audit**: run `npm run docs:audit`; if the total is above
   the frozen-baseline buffer, inspect `node scripts/audit-docs.mjs --json |
   jq '.summary.issuesByType'`. Treat broken-link and duplicate-current-verdict
   growth as actionable; treat outside-approved-location / commit-hash /
   test-count drift as frozen-baseline unless the policy says otherwise
   (`engine/docs/release/docs-audit-baseline-policy.md`).
5. **Verify the workspace mirror**: `engine/scripts/workspace-docs-mirror.sh
   --check` should exit 0. Refresh via `--snapshot` if not.
6. **Verify the release-identity artifact**: if you touched a current-verdict
   doc, the pre-commit hook auto-refreshed the artifact. Check
   `docs/release/release-identity.json` is consistent with `git log -1`.
7. **Verify no production data was used**: smokes/probes target staging or
   `:memory:` only. Production reads are limited to `/api/snapshot`,
   `/health`, and admin-safe paths.
8. **Cite, don't claim**: every load-bearing assertion in your final answer
   should reference a file path (and ideally a line number). "I think the
   classifier handles this" is forbidden — quote the line.
9. **Stop conditions** (from `AGENT_PROCESS_STANDARD.md §2`): only halt when
   task is complete, hard-blocker hit, P0/P1 risk uncovered, or risky broad
   redesign required. Halting for a progress update is not legitimate.

---

## 16. Future-prompt boilerplate for Nexus Hub

Reusable prompt header for Claude/Codex on this workspace:

```
You are working in the Nexus Hub workspace at
/Users/felipedominguez/Desktop/Nexus Hub. Use Claude Opus 4.7 with xhigh
effort by default; max effort for security, architecture, and release work.

Read in order before editing:
1. docs/DOCS_INDEX.md
2. docs/agent/OPERATING_CONTEXT.md
3. docs/agent/AGENT_PROCESS_STANDARD.md
4. docs/agent/AGENT_TECHNICAL_MASTERY.md
5. docs/release/CURRENT_RELEASE_STATE.md
6. docs/release/OPEN_ITEMS.md
7. The repo-local CLAUDE.md and the relevant engineering standard from
   engine/docs/engineering/ENGINEERING_STANDARDS_INDEX.md.

Hard rules:
- Token-zero: data lookups go through REST, never chat fast-paths.
- req.userId === req.tenantId. Never weaken.
- Live model routing — never hardcode provider names or model IDs.
- Bcrypt cost 12 for passwords; SHA-256 for opaque tokens; AES-256-GCM for
  OAuth tokens.
- Anti-enumeration: byte-identical responses + 150ms timing floor on auth
  flows.
- Do not push, deploy, or use production data without explicit owner approval.
- Run scripts/changed-area-classifier.sh before deciding test scope.
- Run npm run docs:audit before staging current-verdict docs; if the audit is
  above the frozen-baseline buffer, inspect the per-class delta instead of
  calling it green.

Stop conditions: task complete, hard blocker, P0/P1 risk discovered, risky
broad redesign required. Otherwise proceed autonomously.
```

---

## 17. Glossary (Nexus-specific terms)

- **Token-zero** — operational data reads go through REST, not chat fast-paths
- **Tenant** — today, equal to `users.id`. Will become a separate entity if/when
  membership-backed multi-tenant ships
- **Cannot-skip gate** — a class of test/probe that the risk matrix forbids
  skipping for the corresponding changed area; 23 gates total
- **E1–E5** — evidence levels: unit / simulator / device / staging+health /
  signed TestFlight
- **Smoke evidence** — JSON artifact written by `with-smoke-evidence.sh`
  during a smoke run, retained in `engine/docs/release/smoke-evidence/`
- **Release identity** — auto-generated branch / commit / version / migration
  count for both repos, persisted to `docs/release/release-identity.{json,md}`
  by the pre-commit hook
- **Workspace mirror** — one-way snapshot of workspace docs into
  `engine/docs/_workspace-mirror/` so engine git history captures the
  workspace state at each commit
- **Closed-beta runbook** — `engine/docs/release/closed-beta-runbook` —
  operator playbook for closed-beta cohorts
- **Live model routing** — runtime-overridable provider/model selection per
  task type and per domain via `kv_store`
- **`trackedCreate`** — the only valid Anthropic entry point; writes
  `api_usage` cost ledger and enforces the kill switch
- **AUTH-Ox** — issue tracker IDs from the auth-hardening pass; useful as
  search terms when reading commit messages or `docs/release/OPEN_ITEMS`

---

## Appendix A — Files essential to mastery

This list is curated; not every file every agent needs to read, but the
canonical entry points for each area.

**Workspace docs** (workspace-relative, all `.md`):
- `docs/DOCS_INDEX`
- `docs/agent/OPERATING_CONTEXT`
- `docs/agent/AGENT_PROCESS_STANDARD`
- `docs/agent/AGENT_TECHNICAL_MASTERY` (this file)
- `docs/release/CURRENT_RELEASE_STATE`
- `docs/release/OPEN_ITEMS`
- `docs/release/release-identity.json` and `docs/release/release-identity` (markdown)

**Backend bootloader**:
- `engine/CLAUDE.md`
- `engine/docs/DOCS_INDEX.md`
- `engine/docs/engineering/ENGINEERING_STANDARDS_INDEX.md`
- `engine/docs/engineering/backend-api-contract-standard.md`
- `engine/docs/engineering/security-and-data-isolation-standard.md`
- `engine/docs/engineering/runtime-and-observability-standard.md`
- `engine/docs/engineering/testing-and-qa-harness-standard.md`

**Backend code (must-read)**:
- `engine/package.json`, `engine/tsconfig.json`, `engine/vitest.config.ts`
- `engine/.husky/pre-commit`, `engine/.husky/pre-push`
- `engine/src/index.ts`, `engine/src/boot.ts`, `engine/src/config.ts`
- `engine/src/api/router.ts`, `engine/src/api/auth-middleware.ts`,
  `engine/src/api/rate-limiter.ts`, `engine/src/api/response-helpers.ts`
- `engine/src/portal/server.ts`, `engine/src/portal/security.ts`,
  `engine/src/portal/anthropic-hook.ts`, `engine/src/portal/static-routes.ts`
- `engine/src/services/database.ts`, `engine/src/services/storage-provider.ts`,
  `engine/src/services/oauth-store.ts`, `engine/src/services/scheduler.ts`,
  `engine/src/services/intelligence-bus.ts`,
  `engine/src/services/error-monitor.ts`, `engine/src/services/error-tracker.ts`
- `engine/src/services/provider-registry.ts`,
  `engine/src/services/provider-fallback.ts`,
  `engine/src/services/domain-provider-router.ts`,
  `engine/src/services/model-config.ts`, `engine/src/services/anthropic.ts`,
  `engine/src/services/gemini-provider.ts`,
  `engine/src/services/openai-provider.ts`
- `engine/src/services/tool-executor.ts`,
  `engine/src/services/chat-context-engine.ts`,
  `engine/src/services/chat-skill-orchestrator.ts`,
  `engine/src/services/chat-tenant-scope.ts`
- `engine/src/services/account-lockout.ts`,
  `engine/src/services/password-reset.ts`,
  `engine/src/services/google-sign-in.ts`,
  `engine/src/services/ios-auth-session.ts`,
  `engine/src/services/audit-trail.ts`
- `engine/src/skills/skill-config.ts`, `engine/src/skills/skill-manager.ts`
- `engine/src/utils/logger.ts`, `engine/src/utils/request-context.ts`
- `engine/src/api/routes/auth.ts`, `engine/src/api/routes/chat-message-routes.ts`,
  `engine/src/api/routes/chat-message-local-responses.ts`
- `engine/migrations/030_users.sql`,
  `engine/migrations/109_password_reset_tokens.sql`,
  `engine/migrations/110_auth_hardening_refresh_hash_and_lockout.sql`

**Backend scripts**:
- `engine/scripts/changed-area-classifier.sh`
- `engine/scripts/cannot-skip-gate-dashboard.sh`
- `engine/scripts/with-smoke-evidence.sh`
- `engine/scripts/staging-smoke.sh`
- `engine/scripts/promote-to-prod.sh`
- `engine/scripts/deploy.sh`
- `engine/scripts/release-identity.sh`
- `engine/scripts/release-doc-drift-check.sh`
- `engine/scripts/audit-docs.mjs`
- `engine/scripts/workspace-docs-mirror.sh`
- `engine/scripts/testflight-evidence.sh`

**Python content-engine**:
- `engine/content-engine/main.py`
- `engine/content-engine/requirements.txt`
- `engine/content-engine/services/claude_client.py` (the proxy contract)
- `engine/content-engine/services/orchestrator.py`
- `engine/content-engine/services/scorer.py`
- `engine/content-engine/services/creator_profile.py` (NEUTRAL fallback)
- `engine/src/services/content-engine.ts` (TS bridge)

**iOS**:
- `ios/CLAUDE.md`, `ios/AGENTS.md`
- `ios-specs/00-CURRENT-PRODUCT-TRUTH.md`
- `ios-specs/02-API-SPECIFICATION.md`
- `ios-specs/08-TOKEN-ZERO-ARCHITECTURE.md`
- `ios/docs/engineering/ios-architecture-and-swiftui-performance-standard`
- `ios/docs/engineering/ios-frontend-validation-checklist`
- `ios/Nexus Hub/Core/AuthManager.swift`
- `ios/Nexus Hub/Core/NexusConfig.swift`
- `ios/Nexus Hub/Core/AuthErrorTranslator.swift`

**Tests (representative, by class)**:
- Tenant identity: `engine/__tests__/security/p0-chat-identity-isolation.test.ts`
- Prompt cleanliness: `engine/__tests__/services/prompt-cleanliness.test.ts`
- Auth routes: `engine/__tests__/api/auth-routes.test.ts`,
  `engine/__tests__/api/auth-password-reset.test.ts`,
  `engine/__tests__/api/auth-session-revocation.test.ts`
- Account lockout: `engine/__tests__/services/account-lockout.test.ts`
- Tenant scope: `engine/__tests__/scope/`
- Coach kernel: `engine/__tests__/services/coach-kernel-*.test.ts`,
  `engine/__tests__/services/session-coherence.test.ts`
- Mobility: `engine/__tests__/services/coach-kernel-mobility-recovery-builder.test.ts`
- Static routes: `engine/__tests__/portal/portal-static-routes.test.ts`,
  `engine/__tests__/portal/password-reset-page-route.test.ts`
- iOS auth: `ios/Nexus HubTests/AuthManagerPersistenceTests.swift`,
  `ios/Nexus HubTests/AuthErrorTranslatorTests.swift`,
  `ios/Nexus HubTests/AppleSignInNonceTests.swift`
