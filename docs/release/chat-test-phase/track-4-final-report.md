# Track 4 Reliability Final Report

Date: 2026-05-24
Suite: `track-4-reliability`

## Summary

Track 4 live Phase A initially failed, one course-correction iteration was completed, and the full suite then passed.

The Chat Core v2 confirmed-write stack was redeployed to staging at `6ee83074` on 2026-05-24 after the decision-dismiss/read-state QA fix, and the Track 4 automated gate remains green.

## Iterations

| Iteration | Result | Evidence | Notes |
|---|---:|---|---|
| Initial live Phase A | 2/5, pass rate `0.400` | `docs/release/chat-test-phase/chat-test-phase-results-track-4-reliability-2026-05-23T17-18-28-151Z.json` | See `track-4-divergence-1.md`. |
| Correction run | 5/5, pass rate `1.000` | `docs/release/chat-test-phase/chat-test-phase-results-track-4-reliability-2026-05-23T17-28-05-612Z.json` | Fixture updated for confirmation contract; agenda read and access-control injection gates fixed. |
| Post-merge staging run | 5/5, pass rate `1.000` | `docs/release/chat-test-phase/chat-test-phase-results-track-4-reliability-2026-05-23T18-21-43-161Z.json` | PR #51 merged into `codex/chat-action-fixer-worker-20260523`, deployed to staging at `f88744ae`, then re-run through the authenticated staging fixture user. |
| Chat Core v2 confirmed-write staging run | 5/5, pass rate `1.000` | `docs/release/chat-test-phase/chat-test-phase-results-track-4-reliability-2026-05-24T21-17-54-582Z.json` | Deployed stacked head `869f86ea` to staging, seeded synthetic fixture user `1000001`, ran via SSH tunnel to server-local staging port because `staging-api.nexushub.me` did not resolve from this shell, then cleaned up the fixture user. |
| Chat Core v2 status-policy QA fix staging run | 5/5, pass rate `1.000` | `docs/release/chat-test-phase/chat-test-phase-results-track-4-reliability-2026-05-24T22-02-07-642Z.json` | Deployed QA-fix head `6ee83074` to staging, seeded synthetic fixture user `1000001`, ran via SSH tunnel to server-local staging port, then cleaned up the fixture user. |

## Fixes

- Updated Track 4 reliability fixture to expect `needs_confirmation` for safe-write task creation, matching the beta-hardening confirmation contract.
- Fixed agenda summary deterministic planning to emit an ISO date so the read-only executor can derive a concrete day window.
- Expanded prompt-injection detection to refuse access-control bypass phrases such as “ignore all access checks”, “bypass access checks”, and “enable every skill”.
- Updated staging fixture seed rows to include tenant/owner scope fields now required by cooking and finance tables.

## Waivers

None for live Phase A.

## Staging Smoke

- `./scripts/deploy-staging.sh` passed from `d4642c83`.
- `./scripts/staging-smoke.sh` passed 21/21; evidence: `docs/release/smoke-evidence/staging-smoke-d4642c83-20260523T172751Z.json`.
- Post-merge `./scripts/deploy-staging.sh` passed from `f88744ae`.
- Post-merge `./scripts/staging-smoke.sh` passed 21/21; evidence: `docs/release/smoke-evidence/staging-smoke-f88744ae-20260523T182007Z.json`.
- Chat Core v2 confirmed-write `./scripts/deploy-staging.sh` passed from `869f86ea`.
- Chat Core v2 confirmed-write `./scripts/staging-smoke.sh` passed 21/21; evidence: `docs/release/smoke-evidence/staging-smoke-869f86ea-20260524T211637Z.json`.
- Chat Core v2 status-policy QA fix `./scripts/deploy-staging.sh` passed from `6ee83074`.
- Chat Core v2 status-policy QA fix `./scripts/staging-smoke.sh` passed 21/21; evidence: `docs/release/smoke-evidence/staging-smoke-6ee83074-20260524T215911Z.json`.

## Phase B App-Side Evidence

- Focused iOS unit/integration confirmation tests passed on simulator: `Nexus HubTests/ChatStructuredCardRenderingTests` plus `Nexus HubTests/IntegrationFlowTests/test_chatService_confirmAction_targetsDeterministicConfirmationEndpoint` passed 16/16.
- Focused iOS confirmation UI fixture passed on simulator: `Nexus HubUITests/ChatActionConfirmationUITests/test_fixtureRendersConfirmationCardsAndCancelDoesNotConfirm` passed 1/1 with `NEXUS_UI_TEST_MODE=1`.
- TestFlight smoke-matrix unit guard passed on simulator: `Nexus HubTests/BetaTestFlightSmokeMatrixTests` passed 4/4.
- These simulator checks validate card decoding/rendering, deterministic confirm endpoint targeting, visible confirmation-card variants, and the cancel path. They do not replace the signed-device/TestFlight smoke.

## Signed-Device Gate Status

- `xcrun xctrace list devices` shows physical devices `iPad Pro (26.5)` and `iPhone Felipe (26.5)` as offline from this shell.
- The iOS checkout has no Fastlane/TestFlight upload workflow or export-options automation available for Codex to run.
- Therefore, signed-device/TestFlight Phase B cannot be completed by this backend/iOS simulator session. It remains an operator gate: install a signed/TestFlight build, run the chat confirmation smoke on a physical device, capture screen/telemetry evidence, then continue to production promotion.

## Remaining Release Gates

- Phase B manual signed-iOS smoke still requires an operator-run signed device/TestFlight build with screen/telemetry capture. The simulator proxy and smoke-matrix guard passed, but signed-device evidence is impossible from this session because the physical devices are offline and no TestFlight automation is present.
- Production promote and Phase D post-deploy validation were not run because promotion must wait for Phase B plus operator-controlled release approval.
