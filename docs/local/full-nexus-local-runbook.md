# Full Nexus Local Runbook

Date: 2026-04-29
Purpose: repeatable local full-product runtime behind the iOS app
Default mode: local SQLite, loopback only, deterministic fixtures, no production secrets, no real provider writes

## What This Runner Covers

The local runner is intended to validate the full Nexus product runtime before
staging or production:

- backend APIs
- auth/session
- tenant/user context
- permissions
- Chat
- Secretary
- Training
- Cooking
- Finance
- Content Creation
- shared context/orchestration
- model/provider fixture or bounded real-call mode
- workers/background jobs inside the backend process
- local SQLite database/cache
- local calendar/agenda mock paths
- iOS simulator connection
- portal/web diagnostics where relevant

## Repositories

Backend:

```text
/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot
```

iOS:

```text
/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub
```

## Quick Start

Use a clean local state directory when running a release-style local smoke:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"

FULL_NEXUS_STATE_DIR=.local/full-nexus-release-smoke \
DATABASE_PATH="$PWD/data/full-nexus-release-smoke.db" \
FULL_NEXUS_RESET_DB=1 \
scripts/full-nexus-local-engine.sh cleanup

FULL_NEXUS_STATE_DIR=.local/full-nexus-release-smoke \
DATABASE_PATH="$PWD/data/full-nexus-release-smoke.db" \
scripts/full-nexus-local-engine.sh doctor
```

Start the backend in attached mode when running under Codex/CI-style shells:

```bash
FULL_NEXUS_STATE_DIR=.local/full-nexus-release-smoke \
DATABASE_PATH="$PWD/data/full-nexus-release-smoke.db" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
scripts/full-nexus-local-engine.sh up
```

In a second shell:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"

FULL_NEXUS_STATE_DIR=.local/full-nexus-release-smoke \
DATABASE_PATH="$PWD/data/full-nexus-release-smoke.db" \
scripts/full-nexus-local-engine.sh auth-token

FULL_NEXUS_STATE_DIR=.local/full-nexus-release-smoke \
DATABASE_PATH="$PWD/data/full-nexus-release-smoke.db" \
scripts/full-nexus-local-engine.sh full-smoke
```

`full-smoke` currently runs:

1. public health check
2. local iOS auth-token creation when needed
3. authenticated iOS API smoke
4. Chat tenant-isolation smoke, including local test tenants and Chat context
5. deterministic Training/Secretary/Cooking/Finance/Content fixture checks
6. deterministic Chat evaluation fixtures
7. deterministic Chat day-to-day simulation fixtures

## Runner Commands

```bash
scripts/full-nexus-local-engine.sh doctor
scripts/full-nexus-local-engine.sh start
scripts/full-nexus-local-engine.sh up
scripts/full-nexus-local-engine.sh health
scripts/full-nexus-local-engine.sh auth-token
scripts/full-nexus-local-engine.sh smoke
scripts/full-nexus-local-engine.sh chat-tenant-smoke
scripts/full-nexus-local-engine.sh cross-skill-fixtures
scripts/full-nexus-local-engine.sh chat-eval
scripts/full-nexus-local-engine.sh full-smoke
scripts/full-nexus-local-engine.sh status
scripts/full-nexus-local-engine.sh stop
scripts/full-nexus-local-engine.sh cleanup
```

Use `start` for normal detached local development. Use `up` for Codex/CI or
when you need logs attached and guaranteed process lifetime.

## Start Full Local Product Engine

Detached:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
scripts/full-nexus-local-engine.sh start
```

Attached:

```bash
scripts/full-nexus-local-engine.sh up
```

Optional content-engine sidecar:

```bash
NEXUS_LOCAL_START_CONTENT_ENGINE=1 scripts/full-nexus-local-engine.sh start
```

Default backend URL:

```text
http://127.0.0.1:8200
```

## Seed Test Tenants And Users

Seed one iOS sandbox user/session:

```bash
scripts/full-nexus-local-engine.sh auth-token
```

This writes:

```text
.local/full-nexus/local-ios-auth.json
```

Seed two local Chat tenants/users and run isolation checks:

```bash
scripts/full-nexus-local-engine.sh chat-tenant-smoke
```

That command creates:

- Tenant A/User A
- Tenant B/User B
- tenant-specific Chat messages
- tenant-scoped shared memory markers
- scoped callback/tool references
- local attachment path probes

The smoke asserts that Tenant A cannot read Tenant B conversations, memory,
attachments, callbacks, or prompt context.

## Seed Chat Context

Preferred repeatable command:

```bash
scripts/full-nexus-local-engine.sh chat-tenant-smoke
```

For simple app-facing Chat smoke with the primary sandbox user:

```bash
AUTH=".local/full-nexus/local-ios-auth.json"
TOKEN="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).accessToken)" "$AUTH")"

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"show my tasks","clientMessageId":"local-chat-smoke-1"}' \
  http://127.0.0.1:8200/api/v1/chat/message
```

## Seed Secretary Agenda

Default local agenda validation should use local tasks and deterministic
fixtures, not real Google/Outlook writes.

Create a native Secretary/task item through the iOS API:

```bash
AUTH=".local/full-nexus/local-ios-auth.json"
TOKEN="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).accessToken)" "$AUTH")"

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title":"Local Secretary agenda smoke block",
    "listName":"Inbox",
    "dueDateTime":"2026-04-30T09:00:00.000Z",
    "importance":"high",
    "body":"Local-only Secretary fixture item. No provider write."
  }' \
  http://127.0.0.1:8200/api/v1/tasks
```

Important: `/api/v1/calendar/events` requires a writable real calendar
integration and must not be used for default local smoke. Real Google/Outlook
read-back remains a staging provider gate.

## Seed Training Plans And Cooking Context

Persisted local demo seed for one authenticated local user:

```bash
USER_ID="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('.local/full-nexus/local-ios-auth.json','utf8')).user.id))")"
DATABASE_PATH="$PWD/data/local-full-nexus-smoke.db" \
npx tsx scripts/seed-cooking-training-demo.ts --user-id "$USER_ID"
```

This seed clears and recreates the local user's Cooking/Training demo state:

- recipes
- meal plans
- shopping list
- two-week training plan
- running/cycling sessions
- high-leg-load Training signal

Use this when a UI/API smoke needs actual local SQLite rows.

For contract-only validation without DB mutation:

```bash
scripts/full-nexus-local-engine.sh cross-skill-fixtures
```

That fixture harness covers Secretary, Training, Cooking, Finance, Content, and
shared decision-context plumbing without staging or provider writes.

## Seed Finance Constraints

Use app-facing finance transactions for local budget constraints:

```bash
AUTH=".local/full-nexus/local-ios-auth.json"
TOKEN="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).accessToken)" "$AUTH")"
TODAY="$(TZ=Europe/Lisbon date +%F)"

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"date\":\"$TODAY\",\"category\":\"income\",\"amount\":1800,\"currency\":\"EUR\",\"description\":\"Local smoke salary\"}" \
  http://127.0.0.1:8200/api/v1/finance/transactions

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"date\":\"$TODAY\",\"category\":\"subscriptions\",\"amount\":1450,\"currency\":\"EUR\",\"description\":\"Local smoke fixed commitments\"}" \
  http://127.0.0.1:8200/api/v1/finance/transactions
```

Optional fiscal bundle demo seed:

```bash
USER_ID="$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('.local/full-nexus/local-ios-auth.json','utf8')).user.id))")"
DATABASE_PATH="$PWD/data/local-full-nexus-smoke.db" \
npx tsx scripts/seed-fiscal-bundle-demo.ts --user-id "$USER_ID"
```

## Seed Content References

Use app-facing Content reference APIs:

```bash
AUTH=".local/full-nexus/local-ios-auth.json"
TOKEN="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).accessToken)" "$AUTH")"

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Local Smoke Content Strategy","author":"Nexus Fixture"}' \
  http://127.0.0.1:8200/api/v1/content/books

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/@nexushub-local-smoke"}' \
  http://127.0.0.1:8200/api/v1/content/channels

curl -sS \
  -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"topics":["training progress","operator planning","local smoke"]}' \
  http://127.0.0.1:8200/api/v1/content/radar-preferences
```

## Run Local Smoke Tests

Baseline:

```bash
scripts/full-nexus-local-engine.sh smoke
```

Expanded local runner:

```bash
scripts/full-nexus-local-engine.sh full-smoke
```

Individual checks:

```bash
scripts/full-nexus-local-engine.sh chat-tenant-smoke
scripts/full-nexus-local-engine.sh cross-skill-fixtures
scripts/full-nexus-local-engine.sh chat-eval
```

Direct authenticated API smoke:

```bash
scripts/authenticated-api-smoke.sh \
  --base-url http://127.0.0.1:8200 \
  --token-file .local/full-nexus/local-ios-auth.json
```

## Run iOS Simulator Against Local Backend

Build the iOS app:

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build
```

Launch with local backend and local auth import:

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

Required iOS launch gates:

- `-nexus_debug_local_auth_import YES`
- `-nexus_allow_local_backend YES`
- `-nexus_base_url http://127.0.0.1:8200`
- `NEXUS_LOCAL_AUTH_IMPORT_PATH=<absolute path to local-ios-auth.json>`

If Xcode shows "Couldn't reach Nexus Hub", first confirm whether the app is
still intentionally pointed at local backend:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
scripts/full-nexus-local-engine.sh status
curl -sS http://127.0.0.1:8200/api/v1/
```

If the local backend is stopped, the banner is expected for a local launch. If
you want production, relaunch without the local base URL args.

## Stop Services And Clean Artifacts

Normal stop:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
scripts/full-nexus-local-engine.sh stop
```

Clean auth files and temporary artifacts:

```bash
scripts/full-nexus-local-engine.sh cleanup
```

Reset local DB:

```bash
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
```

Use the full shutdown checklist:

```text
docs/local/full-nexus-shutdown-checklist.md
```

## Provider Usage Rules

Default local validation must use fixtures/degraded paths:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh full-smoke
```

Only enable real provider calls for a bounded quality check:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=1 scripts/full-nexus-local-engine.sh chat-eval
```

When real calls are used, record provider/model/tier/category/fallback/cost
evidence in the relevant smoke result doc. Do not use production user data.

## Current Limitations

- Real Google/Outlook lifecycle proof is staging-only.
- True same-user multi-workspace switching is not represented by the default local seed.
- WebSocket streaming/reconnect is not part of `full-smoke`.
- Python content-engine sidecar is optional and depends on a local virtualenv.
- `seed-cooking-training-demo.ts` and `seed-fiscal-bundle-demo.ts` require `npx tsx`.
- iOS launch is still a separate simulator step, not fully driven by the backend runner.
