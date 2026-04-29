# Full Nexus Runtime Map

Date: 2026-04-29
Batch: 2 - local full-engine audit
Backend branch audited: `feature/chat-p0-tenant-security-audit`
Backend package version audited: `4.14.104`

## Purpose

This document maps what is required to run the full local Nexus product engine
behind the iOS app. In this context, "engine" means the whole local product
runtime, not a single skill or a Training-only backend.

The local runtime must support backend APIs, auth/session, tenant and user
context, permissions, Chat, Secretary, Training, Cooking, Finance, Content
Creation, shared context, orchestration, model/provider control or fixture
mode, workers, database/cache state, calendar/agenda mocks, and the iOS
simulator.

## Current Local Runtime Entry Point

The primary runner is:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
scripts/full-nexus-local-engine.sh doctor
scripts/full-nexus-local-engine.sh start
scripts/full-nexus-local-engine.sh auth-token
scripts/full-nexus-local-engine.sh smoke
```

For Codex/CI-style shells where detached child processes may be reaped, prefer
the attached mode in one terminal/session:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
scripts/full-nexus-local-engine.sh up
```

Then run `auth-token`, `health`, or `smoke` from another shell.

Default local API:

```text
http://127.0.0.1:8200
```

## Runtime Components

| Component | Local runtime status | Primary local surface |
| --- | --- | --- |
| Backend APIs | Included | Express app under `/api/v1`, started through `npm run build` + `node dist/index.js` via the runner. |
| Auth/session | Included | Local invite/device auth via `/api/v1/auth/register`; runner writes `.local/full-nexus/local-ios-auth.json`. |
| Tenant/user context | Included with current app model | Request user context is established by auth middleware. Local iOS sandbox auth creates a user-scoped tenant context. True same-user multi-workspace switching is still not fully represented by the default runner. |
| Permissions/access control | Included | Backend route middleware, entitlement checks, tool authorization, and portal admin checks remain active; local paywall is disabled. |
| Chat | Included | `/api/v1/chat/*`, chat history, callbacks, attachments, local deterministic responses, tool authorization, and recent P0 tenant-safety smoke support. |
| Secretary | Included | Plan, calendar, tasks, notifications, and agenda-facing APIs run through the local backend. Rich Secretary fixture/scenario seeding is not yet a single first-class runner command. |
| Training | Included | Training summary/today/plan routes and deterministic coach-kernel logic run locally. Model calls are disabled by default. |
| Cooking | Included | Cooking meal-plan API is part of the authenticated smoke set. Rich fueling/cooking persona seeding remains pending. |
| Finance | Included | Finance monthly summary and finance services run locally with finance encryption disabled for local-only smoke. |
| Content Creation | Included; sidecar optional | API routes run locally. Python content-engine sidecar is off by default and starts only with `NEXUS_LOCAL_START_CONTENT_ENGINE=1`. |
| Shared context/orchestration | Included | Plan, dashboard, signals, shared-memory/cache state, skill catalog, and mesh flags are available locally. |
| Model/provider layer | Controlled fixture/degraded mode by default | Provider keys are blanked unless `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1`; routing architecture remains configurable and provider-agnostic. |
| Workers/queues | Included inside backend process | Scheduler and background paths boot with the backend; external Telegram delivery and backups are disabled by local defaults. |
| Database/cache | Included | Isolated SQLite DB at `data/local-full-nexus-smoke.db` by default; migrations apply locally. API/cache tables are in the same local DB. |
| Calendar/agenda mock | Partially included | Local calendar/agenda state can be exercised without real provider writes. Real Google/Outlook read-back remains staging-only. |
| iOS simulator | Included | DEBUG launch args point the app to `127.0.0.1:8200`; DEBUG simulator auth importer consumes the runner-minted auth JSON. |
| Portal/web | Included where backend serves it | Portal binds to loopback on the same backend port. Admin/support diagnostics require local bypass or an explicit admin token. |

## Startup Commands

Baseline doctor:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
scripts/full-nexus-local-engine.sh doctor
```

Start detached:

```bash
scripts/full-nexus-local-engine.sh start
```

Start attached:

```bash
scripts/full-nexus-local-engine.sh up
```

Health check:

```bash
scripts/full-nexus-local-engine.sh health
```

Mint local iOS auth:

```bash
scripts/full-nexus-local-engine.sh auth-token
```

Run default authenticated API smoke:

```bash
scripts/full-nexus-local-engine.sh smoke
```

Run the lower-level authenticated route smoke directly:

```bash
scripts/authenticated-api-smoke.sh \
  --base-url http://127.0.0.1:8200 \
  --token-file .local/full-nexus/local-ios-auth.json
```

The authenticated route smoke currently covers:

- dashboard
- today plan
- week plan
- task lists
- today tasks
- Training summary
- Training today
- Content pipeline
- Content intelligence
- Cooking meal plan
- Finance monthly summary
- settings connections
- notifications inbox

Optional Python content-engine sidecar:

```bash
NEXUS_LOCAL_START_CONTENT_ENGINE=1 scripts/full-nexus-local-engine.sh start
```

## Required Environment

The runner supplies local-safe defaults. Do not source production or staging
`.env` files for local smoke.

| Variable | Default/local expectation | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Development runtime mode. |
| `ENV` | `development` | App environment label. |
| `STAGING` | `false` | Prevents staging/production semantics during local smoke. |
| `PORTAL_BIND` | `127.0.0.1` | Loopback-only local bind. |
| `PORTAL_PORT` | `8200` | Local backend port. |
| `PORTAL_ALLOW_LOCAL_BYPASS` | `true` | Allows local portal/admin loopback flows. |
| `HEALTH_ALLOW_UNAUTHENTICATED` | `true` | Allows simple local health probes. |
| `IOS_API_ENABLED` | `true` | Enables iOS API routes. |
| `IOS_API_JWT_SECRET` | local-only runner secret | Signs local iOS JWTs. |
| `IOS_INVITE_CODE` | `LOCAL-BETA-2026` | Local sandbox registration gate. |
| `IOS_OWNER_CODE` | `LOCAL-OWNER-2026` | Local owner-code path. |
| `DATABASE_PATH` | `data/local-full-nexus-smoke.db` | Isolated SQLite DB. |
| `OAUTH_ENCRYPTION_KEY` | local-only runner key | Allows OAuth-token table code paths without production secrets. |
| `FINANCE_ENCRYPTION_ENABLED` | `false` | Keeps local finance smoke simple and non-production. |
| `PAYWALL_ENABLED` | `false` | Avoids billing gates in local smoke. |
| `TELEGRAM_LEGACY_DELIVERY` | `false` | Prevents external Telegram delivery. |
| `BACKUP_ENABLED` | `false` | Prevents backup jobs during local smoke. |
| `CONTENT_ENGINE_ENABLED` | `false` by default | Sidecar only when explicitly requested. |
| `INTERNAL_API_SECRET` | local-only runner secret | Local internal API auth. |
| `NEXUS_MULTISKILL_MESH` | `on` | Keeps shared orchestration enabled. |
| `AI_CALL_TIMEOUT_MS` | `15000` | Short local model-call timeout if real calls are explicitly allowed. |
| `GLOBAL_DAILY_COST_LIMIT` | `1.00` | Cost guardrail for accidental local provider calls. |

Optional runner controls:

| Variable | Use |
| --- | --- |
| `FULL_NEXUS_STATE_DIR` | Override `.local/full-nexus`. Useful for isolated smoke batches. |
| `FULL_NEXUS_AUTH_FILE` | Override the runner-minted iOS auth JSON path. |
| `FULL_NEXUS_ENV_FILE` | Point at a local-only override env file. |
| `FULL_NEXUS_BASE_URL` | Override base URL/port, for example `http://127.0.0.1:8210`. |
| `FULL_NEXUS_DEVICE_ID` | Override local iOS device ID used for auth minting. |
| `FULL_NEXUS_RESET_DB=1` | Remove the local DB during cleanup. |
| `NEXUS_LOCAL_START_CONTENT_ENGINE=1` | Start the Python content engine sidecar. |
| `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1` | Preserve model-provider keys for a bounded real-provider smoke. |
| `NEXUS_LOCAL_RUN_AUTH_SMOKE=0` | Skip auth smoke where needed. |

## Secrets and Config Required

No production secrets are required for the default full local engine.

The runner intentionally supplies local-only placeholders for Telegram, JWT,
OAuth encryption, internal API, and invite-code values. Provider API keys are
blanked unless `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1`.

Real external-provider credentials are not part of default local smoke:

| External dependency | Local strategy |
| --- | --- |
| Google Calendar | Use local/mock calendar state locally; real read-back belongs to staging smoke. |
| Outlook Calendar | Use local/mock calendar state locally; real read-back belongs to staging smoke. |
| Apple Health / Apple Watch | Simulator cannot prove real HealthKit device data; requires signed device/TestFlight validation. |
| APNs | Requires signed device/TestFlight token flow. |
| Stripe/billing | Paywall is disabled by default; billing integration should use staging/test-mode paths when explicitly needed. |
| Model providers | Disabled by default; use fixture/degraded paths unless a bounded provider smoke is explicitly approved. |

## Local Database Setup

Default DB path:

```text
/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/data/local-full-nexus-smoke.db
```

The backend applies migrations on local start. The runner's `auth-token`
command creates a local sandbox iOS session and writes:

```text
.local/full-nexus/local-ios-auth.json
```

Reset local DB and auth state:

```bash
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
```

## Local Seed Data and Test Tenants

Currently automated by the base runner:

- local sandbox iOS user via invite-code auth
- local iOS auth session/device row
- default skill catalog and app-facing route state
- local SQLite cache/session state

Currently automated by the Chat P0 tenant smoke helper:

- two isolated local users/tenants for Chat tenant-isolation checks
- attachment denial checks
- callback/tool-scope checks
- prompt-injection/fallback-scope checks in fixture mode

Chat tenant smoke helper:

```bash
node scripts/chat-tenant-security-smoke.js
```

The helper expects a running local backend and can use `FULL_NEXUS_BASE_URL`.

Still needed for a complete full-product scenario bank:

- rich Secretary conflict persona
- Training/Cooking fueling-dependency persona
- Finance deadline/budget persona
- Content workload/cadence persona
- low-capacity/travel week persona
- multi-skill heavy user persona
- true same-user multi-tenant workspace switching where product-supported
- local tenant admin/platform admin fixture with explicit permissions

## Feature Flags and Runtime Gates

Local smoke should keep these principles:

- `PAYWALL_ENABLED=false` for basic product validation.
- `TELEGRAM_LEGACY_DELIVERY=false` to avoid external sends.
- `BACKUP_ENABLED=false` to avoid local backup churn.
- `NEXUS_LOCAL_ALLOW_MODEL_CALLS` omitted or `0` for default fixture/degraded runs.
- `ANTHROPIC_ENABLED=false` unless an explicit emergency-fallback test is being run.
- `NEXUS_LOCAL_START_CONTENT_ENGINE=1` only when validating the Python content sidecar.
- Any real provider smoke must record provider/model/tier/category/fallback/cost metadata and cleanup steps.

## Model/Provider Fixture Mode

Default local validation is model-call controlled:

- OpenAI, Gemini, and Anthropic API keys are blanked by the runner unless
  `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1`.
- Anthropic remains gated and disabled by default.
- Chat/skill tests should use deterministic fixtures and degraded-safe paths
  for contract, tenant, lifecycle, and iOS rendering checks.
- Bounded real-provider tests are release-quality checks, not the default
  local smoke path.

This preserves the live Nexus routing architecture: local setup must not pin
Chat or any skill to GPT, Gemini, Claude, or another fixed provider globally.

## iOS Local API Configuration

iOS repo:

```text
/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub
```

Build:

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build
```

The app defaults to:

```text
https://api.nexushub.me
```

Local backend URLs are ignored unless the DEBUG launch gate is present:

```text
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8200
```

The DEBUG simulator auth importer is:

```text
Nexus Hub/Core/DebugAuthTokenImporter.swift
```

It is compiled only for DEBUG simulator builds and requires all of:

- `-nexus_debug_local_auth_import YES`
- `-nexus_allow_local_backend YES`
- `NEXUS_LOCAL_AUTH_IMPORT_PATH=<absolute path to local-ios-auth.json>`
- a `.json` auth file path with no `..` traversal segments
- a file size under 16 KB

Simulator launch example:

```bash
AUTH="/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.local/full-nexus/local-ios-auth.json"
xcrun simctl launch booted \
  --console \
  --env NEXUS_LOCAL_AUTH_IMPORT_PATH="$AUTH" \
  me.nexushub.app \
  -nexus_debug_local_auth_import YES \
  -nexus_allow_local_backend YES \
  -nexus_base_url http://127.0.0.1:8200
```

If using `simctl spawn`/environment inheritance directly, pass:

```text
SIMCTL_CHILD_NEXUS_LOCAL_AUTH_IMPORT_PATH=<absolute path to local-ios-auth.json>
```

before launching.

Common iOS local failure modes:

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "Couldn't reach Nexus Hub" | Local backend is not running, wrong port, or app is pointed at a stale local URL. | Start `scripts/full-nexus-local-engine.sh up` or remove/replace local launch args. |
| Local URL ignored | Missing `-nexus_allow_local_backend YES`. | Add the local allow gate. |
| Auth screen appears | Missing/unreadable local auth JSON. | Run `scripts/full-nexus-local-engine.sh auth-token`; verify `NEXUS_LOCAL_AUTH_IMPORT_PATH`. |
| Doubled `/api/v1/api/v1` path | Base URL includes `/api/v1`. | Use `http://127.0.0.1:8200`, not an API-version URL. |

## Portal/Web Local Configuration

The portal/web surface is served by the same backend process on loopback:

```text
http://127.0.0.1:8200
```

Local portal/admin diagnostics should use local bypass only on loopback or an
explicit local `PORTAL_ADMIN_TOKEN`. Do not use production portal/admin tokens.

Portal/web chat support is still more audit-heavy than smoke-heavy: aggregate
diagnostics and admin/support controls exist in backend docs, but a complete
browser-driven portal smoke is not yet a required local runner step.

## Shutdown Process

Normal stop:

```bash
scripts/full-nexus-local-engine.sh stop
```

Cleanup auth state and optional DB:

```bash
scripts/full-nexus-local-engine.sh cleanup
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
```

Verification:

```bash
lsof -nP -iTCP:8200 -sTCP:LISTEN || true
lsof -nP -iTCP:8102 -sTCP:LISTEN || true
xcrun simctl list devices booted
pgrep -fl "dist/index.js|full-nexus-local-engine|content-engine/main.py" || true
```

Expected cleanup state:

- no backend listener on `8200`
- no content-engine listener on `8102` unless intentionally kept running
- no local auth token file when cleanup is complete
- no model-call loops
- no tunnels or provider write loops
- no booted simulator unless intentionally kept open

## Existing Evidence

Useful prior local evidence lives in:

- `docs/local/full-nexus-local-smoke-results.md`
- `docs/local/chat-full-nexus-local-smoke-results.md`
- `docs/local/chat-tenant-security-smoke-results.md`
- `docs/local/full-nexus-local-resource-control.md`
- `docs/local/gpt55-smoke-test-usage-notes.md`

## Current Audit Verdict

The repo has a usable full local Nexus runtime for backend/API/auth/iOS-route
validation, deterministic Chat and skill contract testing, local tenant-safety
smoke, and local iOS simulator connection.

It is not yet a single-command, fully seeded, every-skill day-in-the-life
simulator. The remaining work is primarily around richer local seed personas,
provider-free cross-skill scenarios, bounded model-provider checks, and
streaming/portal/iOS scenario automation.
