# Chat Full Nexus Local Smoke Runbook

Date: 2026-04-29
Branch: `feature/chat-tenant-safe-context-orchestration`
Backend commit at smoke start: `a3f1b78`
Mode: local-only, fixture-first, no production data

## Purpose

This smoke validates Chat as the main Nexus interaction layer against the full local backend runtime behind the iOS app. It is not a production deploy gate and does not use production calendars, production data, or real provider writes.

## Runtime Started

The local backend was started from:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
npm run build
env \
  NODE_ENV=development \
  STAGING=true \
  DATABASE_PATH=./data/chat-full-nexus-local-smoke.db \
  PORTAL_PORT=8200 \
  PORTAL_BIND=127.0.0.1 \
  PORTAL_ADMIN_TOKEN=local-chat-smoke-admin \
  PORTAL_ALLOW_LOCAL_BYPASS=false \
  HEALTH_ALLOW_UNAUTHENTICATED=true \
  IOS_API_ENABLED=true \
  IOS_API_JWT_SECRET=local-chat-smoke-secret-20260429 \
  IOS_INVITE_CODE=local-chat-smoke \
  OWNER_TELEGRAM_ID=1 \
  TELEGRAM_ALLOWED_USER_IDS=1 \
  OAUTH_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  SECRETARY_LOCAL_AGENDA_FIXTURES=1 \
  SECRETARY_LOCAL_CALENDAR_MOCK=1 \
  GEMINI_API_KEY= \
  OPENAI_API_KEY= \
  ANTHROPIC_API_KEY= \
  ANTHROPIC_ENABLED=false \
  AI_CALL_TIMEOUT_MS=10000 \
  npm start
```

Included local services and surfaces:

- iOS API under `/api/v1`
- auth/session registration through local invite code
- tenant/user scope from JWT
- Chat message and history routes
- Secretary fast paths and calendar/agenda local mock surfaces
- Training, Cooking, Finance, Content Creation REST surfaces
- reminders, tasks, dashboard, billing, notifications, plan routes
- local scheduler/workers started by the backend process
- portal read/admin diagnostics through explicit local admin token
- iOS simulator using DEBUG local auth import

## Provider Resource Controls

Real provider keys were intentionally blanked:

- `GEMINI_API_KEY=`
- `OPENAI_API_KEY=`
- `ANTHROPIC_API_KEY=`
- `ANTHROPIC_ENABLED=false`
- `AI_CALL_TIMEOUT_MS=10000`

Observed startup behavior:

- Domain routing initialized with Gemini routing enabled.
- Provider routing could not create an active pair because all provider keys were absent.
- The backend logged the expected local-smoke warning: no AI providers available.
- Token-zero routes and deterministic fixtures remained usable.
- Natural-language model-dependent chat returned an honest degraded response instead of spending provider calls.

Fixture-only evaluation commands:

```bash
npm run chat:eval
node dist/tools/chat-day-to-day-simulation.js
```

Provider usage policy for this smoke:

- Product health, auth, REST contracts, deterministic Chat paths, tenant/history checks, prompt-injection no-provider behavior, and iOS degraded rendering used local fixtures or deterministic backend logic.
- Provider fallback and operator-pinned model quality were not exercised with real model calls.
- A bounded real-provider smoke is still required before claiming live provider quality or fallback behavior.

## iOS Local Connection

iOS simulator target:

- project: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj`
- scheme: `Nexus Hub`
- simulator: `iPhone 17 Pro`
- bundle id: `me.nexushub.app`

The local auth file was minted from the local backend and passed to the simulator:

```bash
-nexus_debug_local_auth_import YES
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8200
NEXUS_LOCAL_AUTH_IMPORT_PATH=/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.local/chat-full-nexus/local-ios-auth.json
```

The local auth file was removed during cleanup.

## Shutdown

Shutdown and cleanup commands used:

```bash
kill <local-backend-pid>
xcrun simctl shutdown A0B13967-B5DE-4E6F-897D-F1E409093F94
rm -f .local/chat-full-nexus/local-ios-auth.json
rm -f data/chat-full-nexus-local-smoke.db data/chat-full-nexus-local-smoke.db-wal data/chat-full-nexus-local-smoke.db-shm
lsof -nP -iTCP:8200 -sTCP:LISTEN
xcrun simctl list devices booted
pgrep -fl "chat-full-nexus-local-smoke|local-chat-smoke|dist/index.js|npm start"
```

