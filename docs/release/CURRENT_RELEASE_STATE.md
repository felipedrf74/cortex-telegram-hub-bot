# Backend Current Release State

Status: canonical
Owner: backend release lead (Felipe)
Last verified: 2026-05-14
Update policy: update after backend deploy or staging change. Workspace-level entry point is docs/release/CURRENT_RELEASE_STATE.md.

Last updated: 2026-05-14

## Active Production Release

- Source branch: `main`
- Production HEAD: `633d37a6`
- Production version: `4.14.162`
- Source implementation commit: `feb1b022`
- iOS Chat card-hiding source changes remain local/TestFlight scope until a
  separate signed iOS release is cut.
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

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

- Cut a signed iOS/TestFlight build if the local Chat structured-card hiding
  changes should reach devices.
- Run an owner-approved live Google Calendar mutation/read-back smoke from an
  authenticated device/session before claiming live provider calendar creation
  end-to-end.
