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
- Training generation, Training calendar writes/sync, and Training-originated cross-skill signal publishing now have explicit env-controlled operational kill switches.
- calendar and cross-skill staging smoke dry-runs now report runtime proof as `blocked`, preventing false-green release evidence.

Remaining blockers are now **release trust gates**, not known backend implementation gaps:

- real Google staging calendar lifecycle smoke is still blocked by missing staging credentials/env;
- real Outlook staging calendar lifecycle smoke is still blocked by missing staging credentials/env;
- iOS rich-payload simulator smoke has now run against a local backend listener with deterministic Training fixtures, and the DEBUG-only auth importer enabled a fully authenticated local simulator journey across major iOS-facing endpoints;
- migration 082 local clone apply/restore rehearsal passed; a true staging DB clone rehearsal is still required before any production DB migration;
- final merge hygiene is now closed and the backend/iOS candidate branches have been pushed for review; human review and remaining external trust gates are still required before any deployment process.

## P0 Production Blockers

### P0-01 Clean Integration Candidate

- Status: **fixed and pushed for review**
- Source: `docs/training/final-open-items-consolidation-report.md`, backend git status.
- What changed: intended backend Training code changes were packaged into `b8f9be7`, release-evidence docs were committed at `2f14acb`, and the latest staging/migration evidence docs are tracked at `b99098e` on `release/training-engine-production-hardening` and `release/training-engine-production-candidate`; intended iOS companion code changes were packaged into `537abf6`, then smoke-evidence docs were committed at `b1aad7f` on `release/ios-training-engine-local-smoke-candidate`.
- Evidence: backend and iOS worktrees were clean after the packaging commits; backend commit hook ran `npm run typecheck` and `npm test`; full backend verify/eval and full iOS scheme evidence are recorded below.
- Remaining requirement: human review. Do not deploy from an unreviewed candidate branch.

### P0-02 Full Backend Verification

- Status: **fixed for packaged local candidate**
- Evidence:
  - `npm run verify` passed: 382 files / 5,994 tests on the packaged release-candidate code.
  - Focused Training blocker suite passed: 14 files / 139 tests.
  - Affected operational-switch/smoke-harness suite passed: 4 files / 23 tests.
  - Training eval passed: 99/100, 156 cases.
- Remaining requirement: rerun after any further code changes or after merge conflict resolution. No rerun is required for the already-packaged `b8f9be7` candidate unless it changes.

### P0-03 Google Calendar Staging Lifecycle Smoke

- Status: **blocked externally; not fixed by local code**
- Latest final gate run: `training-calendar-smoke-20260428142908-61fokl`
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
- Latest final gate run: `training-calendar-smoke-20260428142908-61fokl`
- Result: blocked before writes; no calendar data touched.
- Missing prerequisites: same staging env/user/database/OAuth set as P0-03, plus Outlook client credentials.
- Required before production calendar claims: create/update/regenerate/cancel/retry with read-back and precise cleanup on a staging Outlook calendar.

### P0-05 iOS Simulator Rich Training Smoke

- Status: **addressed for local rich-payload rendering and authenticated local E2E**
- Evidence:
  - `xcodebuild test` focused Training rich-payload/feedback suites passed on iPhone 17 Pro simulator.
  - `scripts/beta-smoke-local.sh` passed.
  - XcodeBuildMCP launched the app with `-NEXUSQATrainingFixture rich-v1`, `NEXUS_SKIP_AUTH=1`, and `http://127.0.0.1:8200`.
  - Training screen rendered strength, running, cycling, hybrid week, superseded, canceled, explanations, confidence/readiness, and weekly strip content.
  - DEBUG-only iOS local auth import bootstrap passed 15/15 policy tests.
  - Authenticated simulator launch against the full local backend produced 43 authenticated REST calls across 19 iOS-facing endpoints, all with the local runner's user ID and HTTP 200 responses.
- Remaining non-blocking gap: this remains local pre-release proof. Signed TestFlight/device provider validation is still required for public beta, especially real provider auth, APNs, and HealthKit.

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
- Latest run: `training-cross-skill-smoke-20260428142925-1lc554`
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

### P1-04b Training Operational Kill Switches

- Status: **fixed in code; production env runbook must use these exact switches if needed**
- Fix:
  - `TRAINING_ENGINE_ENABLED=false` or `TRAINING_ENGINE_DISABLED=1` globally disables Training generation, calendar writes, and Training-originated cross-skill signal publishing.
  - `TRAINING_PLAN_GENERATION_ENABLED=false` or `TRAINING_PLAN_GENERATION_DISABLED=1` disables `/api/v1/training/plan/generate` with a 503 `TRAINING_GENERATION_DISABLED` response.
  - `TRAINING_CALENDAR_WRITES_ENABLED=false`, `TRAINING_CALENDAR_WRITES_DISABLED=1`, `TRAINING_CALENDAR_SYNC_ENABLED=false`, or `TRAINING_CALENDAR_SYNC_DISABLED=1` disables provider calendar writes and `/api/v1/training/plan/sync-calendar`.
  - `TRAINING_CROSS_SKILL_SIGNALS_ENABLED=false` or `TRAINING_CROSS_SKILL_SIGNALS_DISABLED=1` skips Training-originated signal writes while preserving reads.
- Tests:
  - `__tests__/services/training-operational-switches.test.ts`
  - `__tests__/api/training-calendar-event-writer.test.ts`
  - `__tests__/api/training-routes.test.ts`
  - `__tests__/services/training-signals.test.ts`
- Latest validation: affected operational-switch suite passed, 70 tests; typecheck passed.

### P1-05 Profile Quality And Follow-Up Prompts

- Status: **backend route fixed; iOS local rendering proof exists, production proof still external**
- Fix: `POST /api/v1/training/plan/generate` response now includes `profileQuality` and `decisionReasons`.
- Tests:
  - `__tests__/api/training-routes.test.ts` verifies `profileQuality.followUpPrompts` and `decisionReasons` are serialized.
  - `__tests__/services/training-profile-model.test.ts` verifies profile quality logic.
- Remaining requirement: signed/post-deploy iOS validation must prove these fields render correctly against live backend payloads before this is fully productized.

### P1-06 Decision Reasons And Schedule-Compression Explanations

- Status: **backend route fixed; iOS local rendering proof exists, production proof still external**
- Fix: plan generation response serializes structured `decisionReasons`.
- Tests:
  - `__tests__/api/training-routes.test.ts`
  - `__tests__/services/coach-kernel-decision-trail.test.ts`
  - `__tests__/services/coach-kernel-constrained-week-capacity.test.ts`
- Remaining requirement: signed/post-deploy iOS validation must confirm grouped/deduped explanation rendering against live backend payloads.

### P1-07 iOS QA Critical Gates

- Status: **fixed for local pre-release compatibility; external device/provider validation remains**
- Evidence:
  - local iOS Training rich-payload smoke ran through XcodeBuildMCP with the local backend listener online;
  - focused Training DTO/presentation/feedback/view-model tests passed;
  - `scripts/beta-smoke-local.sh` passed;
  - DEBUG-only local-auth importer policy tests passed 15/15;
  - authenticated simulator launch against the full local backend produced 43 authenticated REST calls across 19 iOS-facing endpoints, all with the local runner's user ID and HTTP 200 responses;
  - full iOS scheme passed on `iPhone 17 Pro` after the stale dashboard hero presentation tests were aligned with the localized calendar display contract.
- Remaining requirement before public iOS beta: signed TestFlight/device smoke for real auth/provider state and post-deploy production-safe Training validation.

### P1-08 Training Identity Migration Rollback

- Status: **partially closed; true staging clone still required**
- Evidence: `docs/training/migration-082-rollback-rehearsal.md`
- Local result: a copied local DB was migrated through 081, snapshotted, migrated with `082_training_session_identity_shape_hash.sql`, verified for identity columns/indexes, exercised with old-style and new-style Training inserts, and restored from the pre-082 snapshot.
- Remaining requirement before production DB migration: repeat on a true staging database clone or explicitly capture the production pre-deploy snapshot/restore procedure in the deployment gate. The local rehearsal must not be represented as real staging proof.

## P2 / P3 Remaining Work

- Legacy unmarked orphan event reconciliation dry-run.
- Outlook full-body marker read-back helper if body preview cannot verify markers.
- Debug-only iOS rich Training fixture injection.
- Repeatable staging seed/cleanup scripts for cross-skill smoke.
- Feedback offline draft/retry queue.
- Per-exercise set/load feedback capture.
- Recovery threshold calibration with beta telemetry.
- Continued catalog expansion under existing schema/test gates.
