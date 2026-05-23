# Track 4 Reliability Final Report

Date: 2026-05-23
Suite: `track-4-reliability`

## Summary

Track 4 live Phase A initially failed, one course-correction iteration was completed, and the full suite then passed.

## Iterations

| Iteration | Result | Evidence | Notes |
|---|---:|---|---|
| Initial live Phase A | 2/5, pass rate `0.400` | `docs/release/chat-test-phase/chat-test-phase-results-track-4-reliability-2026-05-23T17-18-28-151Z.json` | See `track-4-divergence-1.md`. |
| Correction run | 5/5, pass rate `1.000` | `docs/release/chat-test-phase/chat-test-phase-results-track-4-reliability-2026-05-23T17-28-05-612Z.json` | Fixture updated for confirmation contract; agenda read and access-control injection gates fixed. |

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

## Remaining Release Gates

- Phase B manual signed-iOS smoke was not run in this backend shell because it requires a signed iOS build, device/simulator walkthrough, and screen/telemetry capture.
- Production promote and Phase D post-deploy validation were not run because this work is still on a stacked PR branch and promotion must wait for review/merge plus operator-controlled release approval.
