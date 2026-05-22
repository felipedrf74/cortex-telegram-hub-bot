# Training Skill Full Reliability Audit - 2026-05-22

Branch: `codex/training-skill-full-audit-20260522`

Worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-training-full-audit-20260522`

## Goal

Audit and harden the Training skill end to end so plan preview, generation, scheduling, calendar sync, cancellation, event descriptions, and chat/Telegram-triggered training operations behave safely and predictably. The seed bugs were calendar duplication, week-4 deload overuse, incomplete first/second week sync, poor event email bodies, preferred-time drift, and modality under-generation when run and gym targets both need to fit the week.

## Coaching Baseline Refreshed

Sources reviewed:

- [NSCA: Hierarchical Structure of Periodization Cycles](https://www.nsca.com/education/articles/kinetic-select/hierarchical-structure-of-periodization-cycles/)
- [ACSM Health and Fitness Journal: Periodization A Thoughtful Approach to Your Exercise Training Program](https://journals.lww.com/acsm-healthfitness/fulltext/2016/01000/shareable_resource__periodization_a_thoughtful.3.aspx)
- [USA Triathlon: The General Phase of Training](https://www.usatriathlon.org/articles/training-tips/the-general-phase-of-training)
- [Sports Medicine: The Role of Intra-Session Exercise Sequence in the Interference Effect](https://link.springer.com/article/10.1007/s40279-017-0784-1)
- [JSCR: Concurrent Training, A Meta-Analysis Examining Interference of Aerobic and Resistance Exercises](https://journals.lww.com/nsca-jscr/fulltext/2012/08000/concurrent_training__a_meta_analysis_examining.35.aspx)

Implementation implications:

- A four-week plan is not automatically a three-up/one-down mesocycle. Recovery weeks can exist, but they must come from the mesocycle design, fatigue/readiness/pain flags, return-to-training context, or taper/race context.
- General/base training should prioritize repeatable aerobic frequency, technique, and sustainable progression before aggressive intensity.
- Concurrent strength and endurance training can require two-a-days when the requested weekly counts exceed available single-session days. The scheduler should orchestrate this explicitly instead of silently dropping a modality.
- When strength and endurance happen close together, sequence matters most for some strength outcomes. The system should prefer separation where possible, and when same-day stacking is needed, keep the reason visible in `scheduleReason`.
- Deload, recovery, maintenance, base, build, and taper labels should mean different things. "Deload" should not be a catch-all for easy week 4.

## Entry Points Audited

- iOS REST Training API mounted through `src/api/router.ts` and `src/api/routes/training.ts`.
- Plan preview/generation/sync/reflow/cancel routes in `src/api/routes/training-plan-routes.ts`.
- Plan build and persistence path in `src/api/routes/training-plan-generation.ts`.
- Scheduling utilities in `src/api/routes/training-schedule-utils.ts` and `src/api/routes/training-plan-calendar-sync.ts`.
- Cancellation and orphan reconciliation in `src/api/routes/training-plan-cancellation.ts`, `src/services/training-plan-lifecycle.ts`, `src/services/training-calendar-scope.ts`, and `src/services/training-agenda-reconciliation.ts`.
- Training plan, week, session, completion, and read-model helpers in `src/services/training-plans.ts` and `src/api/routes/training-read-models.ts`.
- Coach kernel plan generation, coordination, volume enforcement, and guardrails in `src/services/training-coach-kernel-plan-generator.ts`, `src/services/training-plan-coordination.ts`, `src/services/training-plan-volume-enforcement.ts`, and `src/services/coach-kernel/guardrails.ts`.
- Calendar provider event descriptions through `src/services/training-session-description.ts`, `src/services/unified-calendar.ts`, and `src/services/secretary-unified-calendar-provider-adapter.ts`.
- Chat and Telegram training routes through `src/router/classifier.ts`, `src/domains/domain-handler.ts`, `src/domains/triathlon.ts`, and `src/handlers/message.ts`.
- WebSocket training mapping through `src/api/websocket.ts`.
- Cross-skill Training interactions through Secretary agenda/cancellation cascade and training smoke tools.
- iOS Training plan builder and weekly plan controls in `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub-test-infra`.

## Findings And Fixes

| ID | Severity | Finding | Root Cause | Status | Fix / Evidence |
|---|---|---|---|---|---|
| TRN-01 | High | Four-week plans were biased toward a final week deload. | Plan generator and coordination layer treated final week or week-4 cadence as deload without enough athlete context. | Fixed | Removed unconditional final-week/week-4 deloads from coach kernel, coordination, and guardrail logic. Tests cover green-readiness week 4 staying build/base unless there is a real recovery reason. |
| TRN-02 | High | Preview/generate double taps could create duplicate state. | Preview/generate semantics existed, but generate relied on client-provided idempotency. | Fixed | Preview remains non-mutating. Generate now derives a short-lived automatic idempotency key from request hash when the client omits one. A route test covers rapid duplicate generate without a client key. |
| TRN-03 | High | Double sync could race provider calendar creates. | Sync had idempotent repair semantics but no durable per-user provider operation lock. | Fixed | Added SQLite-backed Training operation locks for generate calendar persistence, sync, reflow-confirm, and cancel. The old route-local in-process sync lock was removed. Tests cover durable lock rows, same-user queueing, and operation-aware TTLs so full provider writes are not stolen too early. |
| TRN-04 | High | Cancel Plan missed duplicates created through Secretary agenda items. | Duplicate detection relied on Training identity markers and ownership rows; Secretary-created events may only carry `NEXUS_SECRETARY_SOURCE_*` markers. | Fixed | Cancellation now matches `NEXUS_SECRETARY_SOURCE_SKILL:training` plus `NEXUS_SECRETARY_SOURCE_INTENT:training:<planId>:<version>:<sessionId>` with date/duration guardrails. Regression test covers the screenshot-shaped event. |
| TRN-05 | High | Calendar/email body started with internal Nexus markers. | Secretary adapter generated provider descriptions from Secretary metadata without enriching Training source items with the original session body. | Fixed | Secretary provider descriptions now load the referenced Training session, put the warmup/main/cooldown/tips content first, strip Training identity marker from the visible body, and append Secretary markers as a compact footer. |
| TRN-06 | High | Six run sessions plus five gym sessions could under-generate running. | Volume enforcement used `sessionsPerWeek` as the primary-modality target instead of explicit run target, and capped total too aggressively for running+strength requests. | Fixed | Added explicit `runSessionsPerWeek` propagation and allowed requested run plus strength totals, including two-a-days. Unit test covers 6 run + 5 gym producing 11 sessions. |
| TRN-07 | Medium | Preferred 12:00 gym slot could shift silently to 12:30. | Scheduling result only marked preference unavailable when no slot was found, not when a nearby fallback was used. | Fixed | `preferredTimeUnavailable` is now true whenever the exact requested time was not used. The response carries schedule reason so the client can surface conflicts. |
| TRN-08 | Medium | First/current week could be partial while later weeks were complete. | Default generation started on the current date, so mid-week generation produced a partial first week. | Fixed | Added `startPolicy: "next_full_week" | "today"` with default `next_full_week`; response returns `resolvedStartDate`. Tests lock default behavior to the next Monday/full training week. |
| TRN-09 | Medium | Calendar sync responses did not expose enough scheduling/accounting metadata for client QA. | Response shape carried counts but not enough user-facing schedule semantics. | Partially fixed | Generation responses now include `resolvedStartDate` and `weeklyTargets`; schedule sessions already carry `preferredTimeRespected`, `preferredTimeUnavailable`, and `scheduleReason`. A fuller per-session sync summary is still a staging-smoke acceptance check. |
| TRN-10 | Medium | iOS rapid-tap protection could still let duplicate requests enter before SwiftUI re-rendered disabled state. | Buttons depended mainly on view-model async flags that flip after the `Task` begins. | Fixed in iOS repo | Added local in-flight guards for plan preview/confirm, sync, and cancel before spawning async work. ViewModel plan-generation feedback now also uses deferred cleanup so new success/error branches cannot strand the loading state. iOS focused tests passed in `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub-test-infra`. |
| TRN-11 | Medium | Auto idempotency used a minute bucket, so duplicate taps across `12:00:59.500` -> `12:01:00.500` could bypass dedupe. | Auto key included `Math.floor(now/60000)`. | Fixed in QA round 2 | Auto keys now use `auto:<requestHash>` with a 90-second sliding freshness window. Regression test covers the adjacent-minute click boundary. |
| TRN-12 | Low | Training body had stacked `MAIN WORKOUT:` and `EXECUTION:` / `EXERCISES:` headings. | The first pass inserted a new section heading without replacing legacy labels. | Fixed in QA round 2 | Body now uses one clean label: `MAIN WORKOUT — EXECUTION:` or `MAIN WORKOUT — EXERCISES:`. Serializer tests pin ordering and old-label removal. |
| TRN-13 | Medium | A stale automatic idempotency row could be replaced while still `in_progress`. | The 90-second freshness window did not check row status, so slow provider work could be overtaken by a second identical request. | Fixed in QA round 3 | Auto rows with `status='in_progress'` are never replaced. They continue to return `TRAINING_PLAN_GENERATION_IN_PROGRESS` even after the freshness window. DB-backed and memory-mode tests pin this. |
| TRN-14 | Low | Memory-mode completion reset `created_at`, extending the auto-idempotency freshness window by work duration. | The memory fallback rewrote the whole row on completion; the DB path preserved `created_at`. | Fixed in QA round 3 | Memory completion now preserves the original `created_at` and only updates `updated_at`. Regression test proves a row completed at T+10s still expires from T=0. |
| TRN-15 | High | Real full-flow Google smoke initially created a full local plan but linked only 3 sessions in week 1. | Persistence scheduled week-1 slots relative to request `now` instead of the resolved `startPolicy` start date, so Monday-Thursday of the next full week were treated as past from a Friday run. | Fixed after real-provider smoke | `training-plan-persistence` now resolves slots from the persisted plan start date. Regression test covers a Friday `next_full_week` plan creating all week-1 sessions from the next Monday. |
| TRN-16 | High | Real full-flow cancel could leave provider events behind under Google rate limits. | Google SDK errors carried redaction-hostile response objects, and Training cancellation/orphan reconciliation delete calls were single-shot while create calls had retries. | Fixed after real-provider smoke | Google errors are wrapped into safe `GoogleCalendarApiError` objects. Training provider deletes now retry sanitized Google rate-limit errors before marking events orphaned. Full-flow Google smoke proved 44/44 provider events were removed after rate-limit retries. |
| TRN-17 | Medium | Outlook provider paths were code-ready but real-provider smoke remained blocked. | Staging user `1000013` only has Google OAuth connected, so Outlook event body/write/delete behavior is still unproven. | Fixed by runtime gate, smoke still required | Training Outlook calendar writes now require `TRAINING_CALENDAR_OUTLOOK_ENABLED=true`. When disabled, explicit Outlook requests fail closed, auto Training writes use Google, and Outlook-pinned plans do not silently switch providers. Enable the flag only for staging Outlook smoke or after Felipe explicitly accepts Google-only rollout scope. |
| TRN-18 | Medium | Calendar create-side throttling was hardcoded to five-wide batches. | Provider create fan-out was bounded, but ops could not lower it without a code change if staging showed Google/Outlook throttling. | Fixed | `TRAINING_CALENDAR_CREATE_BATCH_SIZE` now controls create concurrency, defaulting to 5 and clamping 1..5. Tests pin both default five-wide behavior and serial create behavior with value `1`. |
| TRN-19 | Medium | `bikeSessionsPerWeek` and `swimSessionsPerWeek` were accepted by the API but did not affect coach-kernel targets. | The route normalized and returned those fields, but the coach-kernel input and weekly target resolver only consumed total sessions, run sessions, and strength. | Improved | Coach-kernel input now accepts explicit bike/swim targets and uses them for triathlon/cycling/swimming weekly target resolution. Real-provider smoke for bike/swim-heavy plans remains a future acceptance gate. |
| TRN-20 | Medium | iOS could not explicitly distinguish total schedule days from run-session count. | The app sent only `sessionsPerWeek` and `strengthSessionsPerWeek`, leaving run count implicit. | Fixed in iOS repo | iOS Training plan builder now has an explicit Run sessions stepper and forwards `runSessionsPerWeek`; `TrainingService` also supports run/bike/swim targets. Unit test pins modality target serialization. |

## Public Interface Changes

Plan preview and generation now accept:

- `startPolicy: "next_full_week" | "today"`; omitted defaults to `next_full_week`.
- `runSessionsPerWeek`, `bikeSessionsPerWeek`, and `swimSessionsPerWeek` alongside existing `sessionsPerWeek` and `strengthSessionsPerWeek`.
- `idempotencyKey`; recommended for clients, but the server derives a short-lived key for missing-key double taps.
- `calendarSource: "google" | "outlook"`; Outlook Training writes are currently guarded by `TRAINING_CALENDAR_OUTLOOK_ENABLED=true` until Outlook real-provider smoke passes.

Plan preview and generation now return:

- `resolvedStartDate`
- `weeklyTargets`
- existing calendar sync accounting, plus per-session schedule metadata where sessions are returned.

## iOS Closure

Patched in `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub-test-infra`:

1. `Preview 4 week plan` continues to call only `/api/v1/training/plan/preview`; confirm/schedule continues to call `/api/v1/training/plan/generate`.
2. Preview/confirm, sync, and cancel buttons now set local in-flight state before spawning async work, closing the rapid double-tap window before SwiftUI re-renders disabled state.
3. `TrainingViewModel.previewPlan` and `TrainingViewModel.generatePlan` now use deferred loading-feedback cleanup, matching the view-level guard pattern and preventing future branches from forgetting to reset `isGeneratingPlan`.
4. Confirm uses the existing stable `planCreationIdempotencyKey`; the key is only regenerated after a new preview or successful generation.
5. The plan builder now exposes explicit Run sessions and sends `runSessionsPerWeek`; `TrainingService` also supports `bikeSessionsPerWeek` and `swimSessionsPerWeek` for future UI.
6. iOS still needs a full simulator UI smoke against a staged backend once the Training backend branch is promoted into the iOS test environment.

## Test Evidence

Completed locally:

- `npx tsc --noEmit` passed.
- `npx vitest run __tests__/services/training-plan-volume-enforcement.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-session-description.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts`
  - 7 files passed, 73 tests passed.
- `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-plan-persistence.test.ts`
  - 5 files passed, 120 tests passed.
- `npx vitest run __tests__/api/training-plan-cancellation.test.ts`
  - 1 file passed, 18 tests passed, including Secretary-marker duplicate cancellation.
- Combined focused command across the 12 Training/API files above passed.
  - 12 files passed, 194 tests passed.
- QA round 2 focused regression check passed.
  - `npx vitest run __tests__/api/training-routes.test.ts __tests__/services/training-session-description.test.ts`
  - 2 files passed, 51 tests passed.
- QA round 2 required focused suite passed.
  - `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-session-description.test.ts`
  - 10 files passed, 153 tests passed.
- QA round 3 targeted idempotency regression check passed.
  - `npx vitest run __tests__/api/training-routes.test.ts __tests__/services/training-plan-generation-idempotency.test.ts`
  - 2 files passed, 41 tests passed.
- QA round 3 required focused suite passed.
  - `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-session-description.test.ts`
  - 10 files passed, 155 tests passed.
- Post-real-provider fix focused suite passed.
- `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-calendar-event-writer.test.ts __tests__/api/training-plan-persistence-slot-date.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-plan-generation-idempotency.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-session-description.test.ts __tests__/services/google-calendar-error-sanitization.test.ts`
  - 15 files passed, 175 tests passed.
- QA round 5 backend follow-up focused suite passed.
  - `npx vitest run __tests__/services/training-operational-switches.test.ts __tests__/services/training-calendar-source.test.ts __tests__/api/training-calendar-event-writer.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/api/training-plan-generation.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts`
  - 7 files passed, 105 tests passed.
- QA round 5 expanded Training suite passed.
  - `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-calendar-event-writer.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/api/training-plan-persistence-slot-date.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/services/training-operational-switches.test.ts __tests__/services/training-calendar-source.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-plan-generation-idempotency.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-session-description.test.ts __tests__/services/google-calendar-error-sanitization.test.ts`
  - 19 files passed, 241 tests passed.
- Final open-item Training suite passed after durable operation locks.
  - `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-calendar-event-writer.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/api/training-plan-persistence-slot-date.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/services/training-operational-switches.test.ts __tests__/services/training-calendar-source.test.ts __tests__/services/training-operation-locks.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-plan-generation-idempotency.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-session-description.test.ts __tests__/services/google-calendar-error-sanitization.test.ts`
  - 20 files passed, 243 tests passed.
- `npm run verify` passed after the real-provider fixes.
  - 635 files passed, 9428 tests passed.
- `npm run verify` passed after QA round 5 backend follow-up.
  - 636 files passed, 9444 tests passed.
- Final `npm run verify` passed after durable Training operation locks and iOS handoff docs.
  - 637 files passed, 9447 tests passed.
- iOS focused service test passed in `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub-test-infra`.
  - XcodeBuildMCP `test_sim -only-testing:Nexus HubTests/TrainingServiceTwoADayPreferenceTests`
  - 16 tests passed, including explicit run/bike/swim target serialization.
- iOS focused Training service/ViewModel tests passed after deferred ViewModel cleanup.
  - XcodeBuildMCP `test_sim -only-testing:Nexus HubTests/TrainingServiceTwoADayPreferenceTests -only-testing:Nexus HubTests/TrainingViewModelObservationTests`
  - 31 tests passed, including explicit modality target serialization and plan-generation feedback reset assertions.
- `./scripts/deploy-staging.sh` passed on 2026-05-22 from this Training audit tree.
- `./scripts/staging-smoke.sh` passed after the staging warm-up.
  - Evidence: `docs/release/smoke-evidence/staging-smoke-5f64ead7-20260522T093913Z.json`
  - Result: 21/21 staging smoke checks passed on staging version 4.14.182.
- `./scripts/deploy-staging.sh` passed again after the real-provider Google error/delete retry fixes.
- `./scripts/staging-smoke.sh` passed again after the required warm-up.
  - Evidence: `docs/release/smoke-evidence/staging-smoke-5f64ead7-20260522T104900Z.json`
  - Result: 21/21 staging smoke checks passed on staging version 4.14.182.
- Real Google provider calendar smoke passed against staging user `1000013`.
  - Evidence: `docs/release/smoke-evidence/training-calendar-staging-google-20260522T094025Z.json`
  - Results file: `docs/training/calendar-staging-smoke-results.md`
  - Provider: Google only.
  - Result: create, read-back, update-in-place, same-shape regeneration, changed-shape replacement, old-shape delete, retry no-duplicate, replacement-plan create, cancel/delete, scoped cleanup, and cleanup-failure checks all passed.
- Real Google full-flow Training smoke passed against staging user `1000013`.
  - Evidence: `docs/release/smoke-evidence/training-full-flow-staging-google-20260522T104939Z.json`
  - Results file: `docs/training/training-full-flow-staging-smoke-results.md`
  - Provider: Google only.
  - Result: preview created zero rows/events; generate replayed the duplicate claim; each of 4 weeks had 11 active sessions, 6 run, 5 gym, and 11 provider links; provider bodies were useful before metadata; exact 12:00 gym time had no mismatches; two syncs created no duplicate events; cancel removed 44/44 provider events with `remainingProviderEvents=0`.
- Cross-skill staging smoke executed against staging user `1000013`.
  - Results file: `docs/training/cross-skill-staging-smoke-results.md`
  - Local fixture contract checks passed.
  - A dedicated staging fixture seed created temporary Finance pressure rows and a Training milestone plan/session for the selected test user.
  - Staging runtime checks passed for Secretary conflict, Cooking fueling gap, Finance budget/equipment posture, Content workload, Training content milestone, and shared context scope.
  - Temporary fixture rows were cleaned up after the pass; follow-up status showed `activeFixturePlans=0` and `activeFixtureFinanceRows=0`.
  - Evidence: `docs/release/smoke-evidence/training-cross-skill-staging-seeded-20260522T094401Z.json`
- Outlook-only calendar smoke executed against staging user `1000013` and blocked before any write because Outlook OAuth is not connected for that user.
  - Results file: `docs/training/calendar-staging-smoke-outlook-blocked-results.md`
  - Evidence: `docs/release/smoke-evidence/training-calendar-staging-outlook-blocked-20260522T094451Z.json`

Blocked real-environment gates before production:

- Outlook provider smoke is still blocked until a Microsoft/Outlook staging account is connected for staging user `1000013` or an equivalent dedicated test user. Until then, leave `TRAINING_CALENDAR_OUTLOOK_ENABLED` disabled for Training writes.
- Production promote is intentionally not run because the plan requires the full real-provider calendar gate, and only Google has passed so far.

## Staging Smoke Checklist

Run against a real staging calendar account:

1. Create a 4-week running plus gym plan with default start policy. Verify week 1 starts on the next full Monday and week 1/week 2 both sync fully.
2. Select 6 run days and 5 gym days. Verify 6 run sessions and 5 gym sessions are created each week, with long run on the selected day.
3. Set gym preference to `12:00`. Verify exact 12:00 placement when no conflict exists; when a real conflict exists, verify the response flags `preferredTimeUnavailable` and explains the shift.
4. Open provider event/email body. Verify warmup, main workout, cooldown, tips/recommendations appear before compact Nexus metadata.
5. Double tap preview. Verify zero DB rows and zero provider events from preview.
6. Double tap confirm/generate. Verify one active plan and one provider event set.
7. Double tap sync. Verify no duplicate provider events.
8. Create or seed duplicated Secretary-marker Training events. Cancel plan and verify all owned duplicate provider events disappear.
9. Run reconciliation. Verify zero orphaned Training events.

## Remaining Risks

- Training calendar mutation locks are now SQLite-backed for generation persistence, sync, reflow-confirm, and cancellation. Verify the migration applies before multi-process deployment.
- The default `next_full_week` policy intentionally changes mid-week user experience. Users who truly want to start today must choose `startPolicy: "today"`.
- Run targets are now explicit from iOS to backend; bike/swim targets reach the coach kernel. Bike/swim-heavy real-provider smoke is still needed before calling multisport calendar quality complete.
- Google staging calendar smoke now proves the core provider lifecycle and cleanup path. Outlook smoke is still required because Microsoft can transform event body/description fields differently.
- Google full-flow smoke now proves the complete preview -> generate -> sync -> cancel lifecycle with 44 provider events and rate-limit delete retries. Outlook smoke remains the only real-provider gap.
