---
work_order_id: WO-decision-center-ios-smoke-20260603
mode: implementation
branch: codex/decision-center-execution-20260603
worktree: /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-decision-center-execution-20260603
owned_paths:
  - docs/qa/work-orders/WO-decision-center-ios-smoke-20260603.md
  - docs/qa/final-handoffs/WO-decision-center-ios-smoke-20260603-final-handoff.md
  - docs/qa/peer-validation/WO-decision-center-ios-smoke-20260603-peer-validation.md
  - docker-compose.decision-center-ios-smoke.yml
  - scripts/decision-center-ios-smoke-seed.ts
  - scripts/decision-center-ios-smoke.sh
  - /Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Inbox/NotificationDecisionCenterView.swift
  - /Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj/xcshareddata/xcschemes/Nexus Hub Debug UI Smoke.xcscheme
  - /Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/NotificationDecisionCenterUITests.swift
status: locally_validated_l2
max_claim_level: L2
---

# Work Order - Decision Center iOS Smoke Harness

Status: locally validated to L2. This Work Order creates the local iOS simulator smoke gate for Decision Center. It does not change ChatV2, does not deploy, and does not claim production APNs or TestFlight/device behavior.

## Scope

Create a dedicated local Decision Center iOS smoke path that runs the real DEBUG iOS app against the local backend sandbox on `http://127.0.0.1:8200` with real debug auth, seeded Decision Center rows, simulator UI automation, push payload injection, backend route assertions, and SQLite post-action assertions.

## Mode

Implementation.

## Ownership

Owned paths are declared in frontmatter. This Work Order may read existing Decision Center, notification, auth, Docker, and iOS UI test code to wire the harness. It may edit the Decision Center iOS action dispatch path only to make the real smoke action use the idempotent `/api/v1/decisions/:id/actions` route. It must not edit `src/services/chat-core-v2/**` or any ChatV2 Work Order path.

## Non-Negotiables

- No ChatV2 files are edited or validated as part of this gate.
- Stub-server Decision Center UI tests remain regression coverage, not the 1:1 smoke proof.
- The 1:1 smoke path must use the real local backend and a real local iOS auth token imported by `DebugAuthTokenImporter`.
- APNs is disabled; simulator push injection is local simulator evidence only, not production APNs proof.
- `DECISION_CENTER_COMMAND_BUS_ENABLED` remains off unless a separate rollout Work Order explicitly targets it.
- No production, push, merge, deployment, or promotion is authorized by this Work Order.

## Acceptance Gates

- Lane check:
  - `node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-decision-center-ios-smoke-20260603.md`
- Backend sandbox:
  - `./scripts/decision-center-ios-smoke.sh --backend-only`
- iOS simulator:
  - `./scripts/decision-center-ios-smoke.sh`
- Focused no-ChatV2 ownership check:
  - `git diff --name-only -- src/services/chat-core-v2` returns no files.

## Evidence Rules

- Passing backend route and SQLite assertions prove only local backend behavior.
- Passing iOS XCUITest against the local sandbox proves local simulator behavior.
- Passing `xcrun simctl push` proves local simulator payload acceptance only; it is not production APNs evidence.
- Any L3 claim requires independent peer validation recorded under `docs/qa/peer-validation/WO-decision-center-ios-smoke-20260603-peer-validation.md`.

## Evidence Collected

- `node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-decision-center-ios-smoke-20260603.md` passed.
- `node scripts/verify-agent-lanes.mjs --registry docs/qa/AGENT_WORK_REGISTRY.md` passed after the registry was added.
- `git diff --name-only -- src/services/chat-core-v2` returned no files.
- `npx tsc --noEmit --pretty false` passed in the backend Decision Center worktree.
- `git diff --check` passed in the backend Decision Center worktree.
- `git diff --check` passed in the iOS repo.
- `IOS_SIM_UDID=4F72CBB1-1600-4821-AB9B-6A1DDFA43D8C IOS_XCODE_ACTION=build-for-testing IOS_DERIVED_DATA_PATH=/tmp/nexus-dc-ios-smoke-derived ./scripts/ios-single-simulator-test.sh` passed; Xcode reported `** TEST BUILD SUCCEEDED **` on SDK `iphonesimulator26.5`.
- `./scripts/decision-center-ios-smoke.sh --skip-fixture-suite` passed after the iOS action route patch.
  - Evidence: `.local/decision-center-ios-smoke/evidence/20260603-131920`
  - Focused result bundle: `DecisionCenterLocalEngineSmoke.xcresult`
  - Backend route assertions, simulator push injection, and SQLite action ledger assertion passed.
- `./scripts/decision-center-ios-smoke.sh` passed end-to-end.
  - Evidence: `.local/decision-center-ios-smoke/evidence/20260603-134101`
  - Selected simulator: iPhone 17 Pro, UDID `4F72CBB1-1600-4821-AB9B-6A1DDFA43D8C`, iOS 26.5.
  - Local sandbox health and `./scripts/local-smoke.sh` passed 5/5 checks against `http://127.0.0.1:8200`.
  - Seed script created authenticated local iOS auth at `.local/decision-center-ios-smoke/local-ios-auth.json` and seeded the Decision Center rows.
  - Backend assertions passed for `/api/v1/decisions/overview`, `/summary`, `/handled`, `/:id`, and `/:id/actions`.
  - Focused local-engine XCUITest `test_localEngineDecisionCenterSmokeMatchesSeededBackend` passed; result bundle: `DecisionCenterLocalEngineSmoke.xcresult`.
  - `xcrun simctl push` accepted the scoped local simulator push payload.
  - SQLite post-action ledger assertion passed with exactly one idempotent iOS action execution row.
  - Existing `NotificationDecisionCenterUITests` fixture suite passed 11/11 tests; result bundle: `NotificationDecisionCenterFixtureSuite.xcresult`.
- Independent peer validation passed the smoke harness.
  - Peer evidence: `.local/decision-center-ios-smoke/evidence/20260603-135756`
  - Peer focused result bundle: `DecisionCenterLocalEngineSmoke.xcresult`
  - Peer fixture result bundle: `NotificationDecisionCenterFixtureSuite.xcresult`
  - Peer findings are recorded in `docs/qa/peer-validation/WO-decision-center-ios-smoke-20260603-peer-validation.md`.

## Open Evidence Limits

- This Work Order still declares `max_claim_level: L2`; independent peer validation is complete but no higher claim is made here.
- `node scripts/verify-deliverable.mjs --claim L2 --handoff docs/qa/final-handoffs/WO-decision-center-ios-smoke-20260603-final-handoff.md` passed after the verifier was added.
- Production APNs, TestFlight/device, staging, and production behavior remain unclaimed.
