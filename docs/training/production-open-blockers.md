# Training Production Open Blockers

Updated: 2026-04-28  
Branch: `release/training-engine-production-hardening`  
Backup: `backup/training-prod-hardening-pre-20260428-1004` / `backup-training-prod-hardening-pre-20260428-1004` at `d0d0c41`

This file is strict about evidence. Local tests and mocks count as code confidence; real Google/Outlook staging proof and iOS simulator proof remain separate release gates.

## Current Summary

Backend P0/P1 **code blockers addressed in this hardening pass**:

- constrained-week sessions with no valid calendar slot are persisted as explicit `unscheduled` rows instead of being forced into fallback times;
- inactive states (`unscheduled`, `deferred`, `dropped`, `cancelled`, `superseded`) no longer create calendar events or inflate active Training counts;
- calendar sync marks fully blocked sessions `unscheduled` instead of creating impossible events;
- same-shape event updates now pass refreshed Training identity markers/descriptions to Google/Outlook adapters;
- plan generation now returns `profileQuality` and structured `decisionReasons`.

Remaining blockers are now **release trust gates**, not known backend implementation gaps:

- real Google staging calendar lifecycle smoke is still blocked by missing staging credentials/env;
- real Outlook staging calendar lifecycle smoke is still blocked by missing staging credentials/env;
- iOS rich-payload simulator smoke is outside this backend-only pass and remains required before iOS release;
- database migration/rollback rehearsal still needs a staging clone;
- final merge hygiene still requires committing/reviewing the release branch before deployment.

## P0 Production Blockers

### P0-01 Clean Integration Candidate

- Status: **partially addressed / merge gate remains**
- Source: `docs/training/final-open-items-consolidation-report.md`, backend git status.
- What changed: backup branch/tag were created and work is isolated on `release/training-engine-production-hardening`.
- Evidence: full backend verify and Training eval passed on this branch working tree.
- Remaining requirement: commit intended Training changes into a clean reviewed candidate before staging/promotion. Do not deploy from an uncommitted dirty tree.

### P0-02 Full Backend Verification

- Status: **fixed for current branch working tree**
- Evidence:
  - `npm run verify` passed: 379 files / 5,977 tests.
  - Focused Training blocker suite passed: 13 files / 140 tests.
  - Training eval passed: 99/100, 156 cases.
- Remaining requirement: rerun after final commit/merge because the branch is not yet a clean immutable candidate.

### P0-03 Google Calendar Staging Lifecycle Smoke

- Status: **blocked externally; not fixed by local code**
- Latest final gate run: `training-calendar-smoke-20260428094430-r9cyiu`
- Result: blocked before writes; no production/staging calendar data touched.
- Missing prerequisites:
  - `STAGING=true` or `NODE_ENV=staging`
  - `TRAINING_CALENDAR_STAGING_SMOKE=1`
  - `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`
  - `TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>`
  - `OAUTH_ENCRYPTION_KEY`
  - `DATABASE_PATH=<staging database path>`
  - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- Required before production calendar claims: create/update/regenerate/cancel/retry with read-back and precise cleanup on a staging Google calendar.

### P0-04 Outlook Calendar Staging Lifecycle Smoke

- Status: **blocked externally; not fixed by local code**
- Latest final gate run: `training-calendar-smoke-20260428094430-r9cyiu`
- Result: blocked before writes; no calendar data touched.
- Missing prerequisites: same staging env/user/database/OAuth set as P0-03, plus Outlook client credentials.
- Required before production calendar claims: create/update/regenerate/cancel/retry with read-back and precise cleanup on a staging Outlook calendar.

### P0-05 iOS Simulator Rich Training Smoke

- Status: **open iOS release gate**
- Backend relevance: backend now preserves and serializes richer lifecycle states; this pass did not modify iOS.
- Required before iOS release:
  - run simulator against local backend or deterministic rich-payload fixtures;
  - verify capped/reflowed/unscheduled/cancelled/superseded states;
  - verify gym/running/cycling/hybrid multi-block rendering without clipping or first-item-only bugs.

### P0-06 Rich Feedback Persistence And Adaptation Proof

- Status: **downgraded to P1 for backend release, still required for adaptive-coach claim**
- Evidence:
  - `__tests__/services/coach-kernel-feedback-analysis.test.ts` passed.
  - Full `npm run verify` passed.
- Rationale: this pass did not find a failing backend feedback regression in the production blocker suite. The remaining gap is end-to-end proof that iOS rich feedback submission persists and changes future coaching.
- Required before marketing/product claims about adaptive learning from rich iOS feedback: iOS submit flow + backend persistence + future-plan adaptation proof.

### P0-07 Calendar Event Identity Marker Update Gap

- Status: **fixed in backend code; staging proof still required**
- Root cause: provider update APIs could update time/title but leave stale Training identity markers.
- Fix: unified calendar update supports `new_description`; Google and Outlook update adapters pass refreshed description/body markers.
- Tests:
  - `__tests__/api/training-plan-calendar-sync.test.ts` verifies same-shape regeneration updates the existing event with `planVersion` and session marker changes.
- Remaining requirement: real provider staging read-back for Google/Outlook.

## P1 Must-Fix Before Release

### P1-01 Cross-Skill Staging Smoke

- Status: **blocked externally**
- Latest run: `training-cross-skill-smoke-20260428105013-bj5mtb`
- Local fixture contracts: passed.
- Real staging runtime: blocked.
- Missing prerequisites:
  - `STAGING=true` or `NODE_ENV=staging`
  - `TRAINING_CROSS_SKILL_STAGING_SMOKE=1`
  - `TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id>`
  - `DATABASE_PATH=<staging database path>`
- Harness hardening added on 2026-04-28: runtime flow checks now require actual seeded Secretary/Cooking/Finance/Content signal data and cannot pass on empty context shells.
- Required before broad beta: seeded staging tenant proof for Secretary conflicts, Cooking fueling gaps, Finance constraints, and Content workload signals.

### P1-02 Secretary Busy Windows / Impossible Calendar Slots

- Status: **fixed for calendar-slot feasibility; deeper Secretary pre-generation adapter can move to P2**
- Root cause: a fully blocked day could fall back to a legacy 06:30 marker and create a fake valid Training event.
- Fix: `scheduleSessionWindow` now reports `noAvailableSlot`; persistence and calendar sync persist/mark the session `unscheduled` and skip event creation.
- Tests:
  - `__tests__/api/training-schedule-utils.test.ts`
  - `__tests__/api/training-plan-persistence.test.ts`
  - `__tests__/api/training-plan-calendar-sync.test.ts`
- Remaining non-blocking improvement: wire richer Secretary/task availability earlier into the weekly capacity model so fewer sessions reach sync unscheduled.

### P1-03 Inactive / Deferred / Unscheduled State Persistence

- Status: **fixed**
- Root cause: persistence skipped standalone `rest`/mobility-like rows before checking inactive schedule state, so unscheduled/deferred rows could vanish after reload.
- Fix: inactive schedule states are persisted as rows and excluded only from active counts/calendar creation.
- Tests:
  - `__tests__/api/training-plan-persistence.test.ts`
  - `__tests__/api/training-read-models.test.ts` covered by full verify.

### P1-04 GPT-5.5 Intelligence Routing

- Status: **release-copy/config gate, not fixed in code**
- Rationale: current Training hardening is deterministic engine work. This pass did not change provider/model routing.
- Required before claiming GPT-5.5 execution: explicit staging/prod config evidence of the selected high-intelligence model route, or avoid that claim in release copy.

### P1-05 Profile Quality And Follow-Up Prompts

- Status: **backend route fixed; iOS rendering still external**
- Fix: `POST /api/v1/training/plan/generate` response now includes `profileQuality` and `decisionReasons`.
- Tests:
  - `__tests__/api/training-routes.test.ts` verifies `profileQuality.followUpPrompts` and `decisionReasons` are serialized.
  - `__tests__/services/training-profile-model.test.ts` verifies profile quality logic.
- Remaining requirement: iOS must render/follow up on these fields before this is fully productized.

### P1-06 Decision Reasons And Schedule-Compression Explanations

- Status: **backend route fixed; iOS rendering still external**
- Fix: plan generation response serializes structured `decisionReasons`.
- Tests:
  - `__tests__/api/training-routes.test.ts`
  - `__tests__/services/coach-kernel-decision-trail.test.ts`
  - `__tests__/services/coach-kernel-constrained-week-capacity.test.ts`
- Remaining requirement: iOS must present grouped/deduped explanations for compressed/reflowed/unscheduled states.

### P1-07 iOS QA Critical Gates

- Status: **open iOS release gate**
- This backend-only pass did not touch iOS code.
- Required before public iOS beta: XcodeBuildMCP/local simulator smoke covering Home, Training plan lifecycle, rich payload states, feedback, and tab switching.

### P1-08 Training Identity Migration Rollback

- Status: **open release gate**
- Code/tests cover identity behavior; migration rollback still needs staging clone rehearsal.
- Required before production DB migration: apply migration to staging clone and document rollback/snapshot restore.

## P2 / P3 Remaining Work

- Legacy unmarked orphan event reconciliation dry-run.
- Outlook full-body marker read-back helper if body preview cannot verify markers.
- Debug-only iOS rich Training fixture injection.
- Repeatable staging seed/cleanup scripts for cross-skill smoke.
- Feedback offline draft/retry queue.
- Per-exercise set/load feedback capture.
- Recovery threshold calibration with beta telemetry.
- Continued catalog expansion under existing schema/test gates.
