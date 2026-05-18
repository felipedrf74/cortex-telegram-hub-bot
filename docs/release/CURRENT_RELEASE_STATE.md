# Backend Current Release State

Status: canonical
Owner: backend release lead (Felipe)
Last verified: 2026-05-18
Update policy: update after backend deploy or staging change. Workspace-level entry point is docs/release/CURRENT_RELEASE_STATE.md.

Last updated: 2026-05-18

## Active Production Release

- Source branch: `main`
- Production HEAD: `1587fc5d`
- Production version: `4.14.171`
- Source implementation commit: `0df40622`
- iOS Chat card-hiding source changes are pushed to iOS `main` at `e7cfc8b`;
  a separate signed iOS/TestFlight release is still required to reach devices.
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

## 2026-05-18 Beta Registry And Stripe Billing Promote

- Scope: double opt-in beta registry, waitlist email validation, confirmed-only
  portal approval, 30-day DB invite emails, DB invite redemption, long-lived
  static reviewer-code expiry, expired beta-trial paywall handling, public
  website Stripe Checkout routes, webhook idempotency, verified-user checkout
  claim flow, and Pro/Max monthly USD/BRL Stripe price mapping.
- Production version: `4.14.171`.
- Production deploy commit: `1587fc5d`.
- Source implementation commit before deploy bump: `0df40622`.
- Staging deploy passed, followed by a five-minute soak and staging smoke
  **18/18** at
  `docs/release/smoke-evidence/staging-smoke-0df40622-20260518T194456Z.json`;
  promote-time staging smoke passed **18/18** again at
  `docs/release/smoke-evidence/staging-smoke-0df40622-20260518T194531Z.json`.
- Deploy-time validation passed: backend `npm run verify` passed
  **618 test files / 9,172 tests**, deploy-time build passed, production env
  validation passed, production backup included `bot.db`, dependencies updated,
  native modules rebuilt, owner bootstrap preflight passed, and production PM2
  showed both `nexus-hub` and `content-engine` online after restart.
- Production health passed after deploy: `https://api.nexushub.me/health`
  returned `status: healthy`, `server.status: online`, and
  `database: connected`.
- Operator note: the Cloudflare Pages direct upload for `https://nexushub.me`
  did not run in this shell because Wrangler has no non-interactive
  `CLOUDFLARE_API_TOKEN`. The synced static files are present under
  `/Users/felipedominguez/Desktop/nexushub-landing-deploy`.

## Scope

Chat General Action Intelligence production promote:

- Natural-language Chat action candidates now go through a canonical action
  registry and planner before Gmail/email/read-only fast paths.
- The Portuguese regression command
  `Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo`
  resolves to Google Calendar event creation, not Gmail unread count.
- Durable action state uses `chat_action_runs` idempotency with provider/local
  read-back before verified success.
- Deterministic executors cover Calendar, Tasks, Content, Cooking, Finance,
  Connections, Training, Notifications, and Decision Center paths where a safe
  verified contract exists. Unsupported mutation surfaces fail closed.
- Model-assisted planner arguments recursively strip user/tenant/account/owner
  identity aliases from nested objects and arrays before dispatch.

## Validation Before Promotion

- Pre-promote staging deploy: PASS.
- Pre-promote staging smoke: 17 passed / 0 failed / 17 total.
- Deploy-time validation: full vitest PASS, 533 files / 7534 tests.
- Deploy-time build: PASS.
- Production promote: completed at `4.14.162`.
- Production health: API health healthy, portal snapshot version `4.14.162`,
  PM2 `nexus-hub` and `content-engine` online at `4.14.162`.
- Real Google Calendar provider mutation/read-back from TestFlight remains
  blocked until an authenticated device/session with Calendar write scope is
  available and owner approval is given to create/delete a live provider event.

## Evidence

- Final staging smoke:
  - `docs/release/smoke-evidence/staging-smoke-feb1b022-20260514T172558Z.json`
  - `docs/release/smoke-evidence/staging-smoke-feb1b022-20260514T172629Z.json`
- Deployment transcript showed production content engine OK, status portal OK,
  bot online, and PM2 online for production `nexus-hub` and `content-engine`.

## Required Post-Promotion Checks

Production-safe follow-ups:

- Cut a signed iOS/TestFlight build from iOS `main` if the Chat
  structured-card hiding changes should reach devices.
- Run an owner-approved live Google Calendar mutation/read-back smoke from an
  authenticated device/session before claiming live provider calendar creation
  end-to-end.
