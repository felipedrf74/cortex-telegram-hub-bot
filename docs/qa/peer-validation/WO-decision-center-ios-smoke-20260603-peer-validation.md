# Peer Validation - WO-decision-center-ios-smoke-20260603

Status: independent reviewer passed smoke harness; deliverable verifier blocked by missing script.

## Reviewer Brief

Validate the Decision Center iOS smoke harness without editing ChatV2 paths.

Run:

1. `node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-decision-center-ios-smoke-20260603.md`
2. `git diff --name-only -- src/services/chat-core-v2`
3. `./scripts/decision-center-ios-smoke.sh --backend-only`
4. If Docker and Xcode simulator are available, `./scripts/decision-center-ios-smoke.sh`

Challenge points:

- Confirm the smoke route uses the real local backend, not `AuthOnboardingStubServer`.
- Confirm `.local/decision-center-ios-smoke/local-ios-auth.json` is the exact `{ accessToken, refreshToken, expiresIn, user }` shape consumed by `DebugAuthTokenImporter`.
- Confirm seeded expired/internal smoke-only rows do not render to normal Decision Center list endpoints.
- Confirm primary action uses an idempotency key and creates exactly one action execution row for the iOS decision.
- Confirm simulator push payload is scoped to the seeded user/tenant and is only local simulator evidence, not APNs production evidence.

## Findings

Reviewer: `Linnaeus` (`019e8d8f-06df-7210-95c9-7033bde60fdf`)

Date: 2026-06-03

### Commands

- `node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-decision-center-ios-smoke-20260603.md` -> PASS, `[verify-agent-lanes] OK`
- `git diff --name-only -- src/services/chat-core-v2` -> PASS, no files
- `./scripts/decision-center-ios-smoke.sh` -> PASS
- `test -f docs/qa/final-handoffs/WO-decision-center-ios-smoke-20260603-final-handoff.md` -> PASS
- `node scripts/verify-deliverable.mjs --claim L2 --handoff docs/qa/final-handoffs/WO-decision-center-ios-smoke-20260603-final-handoff.md` -> FAIL/BLOCKED, `scripts/verify-deliverable.mjs` is missing in this checkout

### Evidence

- Smoke evidence: `.local/decision-center-ios-smoke/evidence/20260603-135756`
- Focused local-engine result bundle: `.local/decision-center-ios-smoke/evidence/20260603-135756/DecisionCenterLocalEngineSmoke.xcresult`
- Fixture suite result bundle: `.local/decision-center-ios-smoke/evidence/20260603-135756/NotificationDecisionCenterFixtureSuite.xcresult`
- Simulator push log: `.local/decision-center-ios-smoke/evidence/20260603-135756/simctl-push.log`

### Challenge Results

- Real local backend: PASS. Focused smoke uses `http://127.0.0.1:8200`, `NEXUS_DECISION_CENTER_SMOKE_BASE_URL`, and `NEXUS_LOCAL_AUTH_IMPORT_PATH`; it does not use `AuthOnboardingStubServer`.
- Auth JSON shape: PASS. `.local/decision-center-ios-smoke/local-ios-auth.json` has `{ accessToken, refreshToken, expiresIn, user }`, with string token fields and numeric `expiresIn`.
- Expired/internal list exclusion: PASS. Backend route assertions passed, including exclusion of the seeded expired row from overview; visible list code filters expired, hard-expired, and internal-only rows.
- Action ledger: PASS. SQLite showed exactly one `dismiss` action execution row for focused decision `nc_17beaf3c-6901-40f9-8cda-dd8143760013`, `status=succeeded`, and nonempty idempotency key length `104`.
- Simulator push scope: PASS. `simctl-push.log` contains local simulator acceptance only: `Notification sent to 'me.nexushub.app'`. This is not APNs production proof.

### Residual Risks

- `verify-deliverable.mjs` is absent, so the requested L2 handoff verifier cannot run in this checkout.
- Evidence is local Docker plus iOS simulator only; no TestFlight/device/staging/production/APNs claim is made.
- Peer validator made no source edits, commits, pushes, deploys, or ChatV2 validation beyond the empty diff boundary check.
