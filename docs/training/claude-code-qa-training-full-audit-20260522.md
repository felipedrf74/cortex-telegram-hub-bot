# Claude Code QA Prompt - Training Skill Full Reliability Audit

You are Claude Code independently reviewing Codex's Training skill full reliability audit and fix pass.

## Original Goal

Felipe reported that the Training skill still has reliability issues creating and managing training sessions on calendars. The audit scope is end to end: backend, iOS button flows, calendar providers, event/email bodies, chat/Telegram entry points, staging calendar smoke, and coaching correctness. Do not narrow the review to the seed examples; use them as regressions.

Seed issues:

- Four-week plans still show deloads in week 4 even when the training cycle should not force one.
- Double-clicking "Preview 4 week plan" or related actions can create duplicated agenda entries.
- "Cancel Plan" does not delete duplicated training sessions.
- Calendar/email body starts with useless Nexus metadata instead of the session structure.
- Plan creation creates partial current/next weeks instead of starting cleanly.
- 6 run days plus 5 gym days under-generates running instead of creating 11 sessions/week with two-a-days where needed.
- Preferred gym time like 12:00 is shifted silently to 12:30.
- First and second weeks are not fully synchronized after creation.

Coaching baseline was refreshed from NSCA, ACSM, USA Triathlon, Sports Medicine, and JSCR sources documented in `docs/training/training-skill-full-audit-20260522.md`.

## What Was Implemented

- Created fresh branch/worktree `codex/training-skill-full-audit-20260522`.
- Added `startPolicy: "next_full_week" | "today"` to Training plan preview/generation. Default is `next_full_week`.
- Added explicit modality targets through the API path: `runSessionsPerWeek`, `bikeSessionsPerWeek`, `swimSessionsPerWeek`, and existing `strengthSessionsPerWeek`.
- Added `resolvedStartDate` and `weeklyTargets` to preview/generation responses.
- Added automatic short-lived server idempotency for `/api/v1/training/plan/generate` when the client omits an idempotency key.
- Added SQLite-backed Training calendar operation locks around plan-generation persistence, sync, reflow-confirm, and cancellation.
- Removed unconditional final-week / week-4 deload behavior from coach kernel, coordination, and guardrail code.
- Updated running+strength volume enforcement so 6 running + 5 gym sessions produces 11 sessions/week instead of dropping runs.
- Updated scheduling metadata so a non-exact preferred-time fallback marks `preferredTimeUnavailable=true`.
- Reordered Training session descriptions so warmup, main workout, cooldown, and tips/recommendations appear before internal metadata.
- Updated Secretary calendar provider adapter so Training-sourced Secretary agenda items include the Training session body before compact Secretary markers.
- Updated Training cancellation to identify duplicated provider events by Secretary Training source markers, not only Training identity markers.
- Added audit doc and blocked-smoke evidence.
- QA round 2 closures:
  - Replaced minute-bucket auto idempotency with a short-lived `auto:<requestHash>` sliding window so rapid duplicate plan generation dedupes even across `12:00:59.500` -> `12:01:00.500`.
  - Pinned Training event body order in tests.
  - Replaced stacked `MAIN WORKOUT:` plus `EXECUTION:` / `EXERCISES:` labels with one clean `MAIN WORKOUT — EXECUTION:` or `MAIN WORKOUT — EXERCISES:` heading.
- QA round 3 closures:
  - Automatic idempotency rows with `status='in_progress'` are never replaced, even after the 90-second auto window; duplicate requests keep returning `TRAINING_PLAN_GENERATION_IN_PROGRESS` until the original request completes or fails.
  - Memory-mode completion now preserves the original `created_at`, keeping the fallback freshness semantics aligned with the DB-backed path.
- Real-provider closure after Google full-flow smoke:
  - Fixed persisted plan slot dates so `startPolicy:"next_full_week"` schedules week 1 from the resolved plan start date, not the request date.
  - Added a full-flow staging smoke tool for preview -> generate -> provider read-back -> duplicate sync -> cancel.
  - Wrapped Google Calendar SDK errors into safe `GoogleCalendarApiError` objects so logger redaction cannot throw while logging provider errors.
  - Added rate-limit retries to Training calendar provider deletes in both direct plan cancellation and orphan reconciliation. The final Google full-flow smoke hit rate limits during cancel and still removed all 44 provider events.

## Files Changed

Core implementation:

- `src/api/routes/training-plan-generation.ts`
- `src/api/routes/training-plan-routes.ts`
- `src/api/routes/training-plan-cancellation.ts`
- `src/api/routes/training-schedule-utils.ts`
- `src/services/training-coach-kernel-plan-generator.ts`
- `src/services/training-plan-coordination.ts`
- `src/services/training-plan-volume-enforcement.ts`
- `src/services/training-session-description.ts`
- `src/services/training-plan-generation-idempotency.ts`
- `src/services/training-calendar-provider-retry.ts`
- `src/services/training-agenda-reconciliation.ts`
- `src/services/google-calendar.ts`
- `src/services/coach-kernel/guardrails.ts`
- `src/services/secretary-unified-calendar-provider-adapter.ts`
- `src/tools/training-full-flow-staging-smoke.ts`
- `scripts/training-full-flow-staging-smoke.sh`

Tests:

- `__tests__/api/training-plan-generation.test.ts`
- `__tests__/api/training-routes.test.ts`
- `__tests__/api/training-schedule-utils.test.ts`
- `__tests__/api/training-plan-cancellation.test.ts`
- `__tests__/services/coach-kernel-guardrails.test.ts`
- `__tests__/services/secretary-unified-calendar-provider-adapter.test.ts`
- `__tests__/services/training-coach-kernel-plan-generator.test.ts`
- `__tests__/services/training-plan-coordination.test.ts`
- `__tests__/services/training-plan-volume-enforcement.test.ts`
- `__tests__/services/training-session-description.test.ts`
- `__tests__/services/training-plan-generation-idempotency.test.ts`
- `__tests__/api/training-calendar-event-writer.test.ts`
- `__tests__/api/training-plan-persistence-slot-date.test.ts`
- `__tests__/services/training-agenda-reconciliation.test.ts`
- `__tests__/services/google-calendar-error-sanitization.test.ts`

Docs/evidence:

- `docs/training/training-skill-full-audit-20260522.md`
- `docs/training/calendar-staging-smoke-results.md`
- `docs/training/cross-skill-staging-smoke-results.md`
- `docs/release/smoke-evidence/training-calendar-staging-5f64ead7-20260522T011154Z.json`
- `docs/release/smoke-evidence/training-cross-skill-staging-5f64ead7-20260522T011201Z.json`
- `docs/training/claude-code-qa-training-full-audit-20260522.md`

## Expected Behavior

- Preview is non-mutating and must not create DB rows or provider calendar events.
- Generate creates/schedules exactly one plan for rapid duplicate submits, even if the client omits an idempotency key.
- A slow auto-keyed generation that remains `in_progress` past 90 seconds is not replaced by a second identical request.
- Memory-mode idempotency preserves the original `created_at` when completing a row, so the auto window is measured from claim time rather than completion time.
- Default 4-week plans start on the next full training week. `startPolicy:"today"` is the explicit opt-in for partial current-week starts.
- Week 4 is not automatically a deload. Recovery/deload/taper labeling must come from explicit phase design, readiness/fatigue/pain, return-to-training context, or race/taper context.
- 6 running + 5 gym means 11 sessions/week, allowing two-a-days instead of silently dropping running.
- Preferred time is exact unless a real conflict exists; if shifted, `preferredTimeUnavailable` and `scheduleReason` must tell the truth.
- Event/email body begins with useful session content: warmup, main workout, cooldown, tips/recommendations. Nexus markers remain a compact footer only.
- Main workout headings should be clean single labels: `MAIN WORKOUT — EXECUTION:` or `MAIN WORKOUT — EXERCISES:`. The old stacked `MAIN WORKOUT:\nEXECUTION:` and `MAIN WORKOUT:\nEXERCISES:` shapes should not appear.
- Cancel Plan deletes active linked events plus duplicates identified through Training identity markers, Secretary Training source markers, ownership table rows, and safe date/duration checks.
- Cancel Plan retries Google/Outlook rate-limit failures before giving up on provider event deletion, and leaves only explicitly unresolved provider failures for later reconciliation.
- First and second weeks should fully sync under default next-full-week behavior once real provider smoke passes.

## Tests And Checks Already Performed

Passed:

- `npx tsc --noEmit`
- QA round 2 required focused suite:
  - `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-session-description.test.ts`
  - 10 files passed, 153 tests passed.
- QA round 3 targeted idempotency regression check:
  - `npx vitest run __tests__/api/training-routes.test.ts __tests__/services/training-plan-generation-idempotency.test.ts`
  - 2 files passed, 41 tests passed.
- QA round 3 required focused suite:
  - `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-session-description.test.ts`
  - 10 files passed, 155 tests passed.
- Focused Training/API suite:
  - `npx vitest run __tests__/services/training-plan-volume-enforcement.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-session-description.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-plan-persistence.test.ts`
  - 12 files passed, 194 tests passed.
- Post-real-provider fix focused suite:
  - `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-calendar-event-writer.test.ts __tests__/api/training-plan-persistence-slot-date.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-plan-generation-idempotency.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-session-description.test.ts __tests__/services/google-calendar-error-sanitization.test.ts`
  - 15 files passed, 175 tests passed.
- QA round 4 follow-up focused suite:
  - `npx vitest run __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-calendar-event-writer.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/google-calendar-error-sanitization.test.ts`
  - 4 files passed, 37 tests passed.
- QA round 4 follow-up broad Training suite:
  - `npx vitest run __tests__/api/training-plan-generation.test.ts __tests__/api/training-routes.test.ts __tests__/api/training-schedule-utils.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-calendar-event-writer.test.ts __tests__/api/training-plan-persistence-slot-date.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/secretary-unified-calendar-provider-adapter.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/services/training-plan-generation-idempotency.test.ts __tests__/services/training-plan-volume-enforcement.test.ts __tests__/services/training-session-description.test.ts __tests__/services/google-calendar-error-sanitization.test.ts`
  - 15 files passed, 178 tests passed.
- `npm run verify`
  - Earlier run: 635 files passed, 9428 tests passed.
  - QA round 4 follow-up run: 635 files passed, 9431 tests passed.
- QA round 2 focused regression check:
  - `npx vitest run __tests__/api/training-routes.test.ts __tests__/services/training-session-description.test.ts`
  - 2 files passed, 51 tests passed.
- `git diff --check`

Earlier blocked evidence retained:

- Earlier blocked dry-run evidence is retained in `docs/release/smoke-evidence/training-calendar-staging-5f64ead7-20260522T011154Z.json` and `docs/release/smoke-evidence/training-cross-skill-staging-5f64ead7-20260522T011201Z.json`.

New 2026-05-22 staging/provider verification:

- `./scripts/deploy-staging.sh`
  - Passed from the Training audit tree; staging version 4.14.182.
- `./scripts/staging-smoke.sh`
  - Passed 21/21 checks.
  - Evidence: `docs/release/smoke-evidence/staging-smoke-5f64ead7-20260522T093913Z.json`
- `./scripts/deploy-staging.sh` and `./scripts/staging-smoke.sh` after the final delete-retry fix.
  - Passed 21/21 checks.
  - Evidence: `docs/release/smoke-evidence/staging-smoke-5f64ead7-20260522T104900Z.json`
- Real Google provider calendar smoke:
  - Passed against staging user `1000013`.
  - Evidence: `docs/release/smoke-evidence/training-calendar-staging-google-20260522T094025Z.json`
  - Results: `docs/training/calendar-staging-smoke-results.md`
  - Covered create/read-back, update-in-place, same-shape regeneration, changed-shape replacement, deletion of old shape, retry without duplicate, replacement-plan create, cancel/delete, scoped cleanup, and zero cleanup failures.
- Real Google full-flow Training smoke:
  - Passed against staging user `1000013`.
  - Evidence: `docs/release/smoke-evidence/training-full-flow-staging-google-20260522T104939Z.json`
  - Results: `docs/training/training-full-flow-staging-smoke-results.md`
  - Covered zero-mutation preview, duplicate generate replay, 44-session 4-week generation, week 1/week 2/week 3/week 4 full provider link counts, useful provider body content before metadata, exact 12:00 gym placement, duplicate sync with zero new provider events, and cancel deleting 44/44 provider events with `remainingProviderEvents=0`.
- Cross-skill staging smoke:
  - Results: `docs/training/cross-skill-staging-smoke-results.md`
  - Local fixture contract checks passed.
  - A dedicated staging fixture seed created temporary Finance pressure rows and a Training milestone plan/session for user `1000013`.
  - Staging runtime checks passed for Secretary conflict, Cooking fueling gap, Finance budget/equipment posture, Content workload, Training content milestone, and shared context scope.
  - Fixture cleanup removed the temporary plan and finance rows; follow-up status showed `activeFixturePlans=0` and `activeFixtureFinanceRows=0`.
  - Evidence: `docs/release/smoke-evidence/training-cross-skill-staging-seeded-20260522T094401Z.json`
- Outlook-only real-provider calendar smoke:
  - Blocked before writes because Outlook OAuth is not connected for staging user `1000013`.
  - Results: `docs/training/calendar-staging-smoke-outlook-blocked-results.md`
  - Evidence: `docs/release/smoke-evidence/training-calendar-staging-outlook-blocked-20260522T094451Z.json`

Not run:

- Outlook real-provider smoke.
- Production promote.

Reason: Google OAuth is now connected and passed, including the full 44-event lifecycle. Outlook still needs a dedicated Microsoft staging OAuth account before the full Google/Outlook provider gate can be called complete. Production promotion remains gated on that full real-provider smoke unless Felipe explicitly scopes the release to Google only.

## QA Round 4 Follow-Up Closures

Claude QA round 4 found three P3 observations after the real-provider Google smoke. This follow-up closes the code-level ones and keeps the remaining provider gate explicit:

| Item | Status | Closure |
|---|---|---|
| P3-R1 cancellation delete fan-out made `trainingCalendarWriteSpacingMs` inert for 44-event cancels | Fixed | `cancelTrainingPlanForUser` now serializes provider deletes when a cancellation has more than 20 targets. Small cancellations keep parallel all-settled behavior; large cancellations pace provider writes so the retry helper is not the only protection against a rate-limit storm. Pinned by `training-plan-cancellation.test.ts` with a 21-event cancellation asserting max concurrent provider deletes is 1. |
| P3-R2 rate-limit detector was mostly Google-shaped | Fixed | `isTrainingCalendarRateLimitError` now also recognizes Microsoft Graph-style `TooManyRequests` codes and `Retry-After` headers even when numeric status is absent. Pinned by `training-calendar-event-writer.test.ts` using an Outlook-shaped throttle error. |
| P3-R3 sanitizer pinned only one Google SDK shape | Improved | Google Calendar error sanitization now handles top-level `error` envelopes as well as `response.data.error`, preserving `code`, `reason`, and `errors` without copying raw response bodies. Pinned by `google-calendar-error-sanitization.test.ts`. |

New nearby scan result:

- Training calendar creation still uses bounded five-wide batches in `persistGeneratedTrainingPlan`. This is materially safer than the previous 44-wide cancel fan-out and is covered by create retry tests. A later follow-up made this width runtime-configurable via `TRAINING_CALENDAR_CREATE_BATCH_SIZE` so ops can reduce create concurrency without another deploy if provider smoke shows throttling.
- Outlook smoke remains blocked by missing Microsoft OAuth on staging user `1000013`; this follow-up improves Outlook-shaped error handling but does not replace real Outlook provider proof.

## QA Round 5 Follow-Up Closures

After Claude QA round 5, Felipe asked Codex to work on the remaining open items and nearby gaps beyond the report. This pass closes the backend-controllable parts and leaves only true provider/client rollout gates:

| Item | Status | Closure |
|---|---|---|
| Outlook provider release posture | Fixed / gated | Training Outlook calendar writes now require `TRAINING_CALENDAR_OUTLOOK_ENABLED=true`. With the flag absent or false, explicit Outlook requests fail closed with `CALENDAR_SOURCE_DISABLED`, auto-provider Training writes fall back to Google, and Outlook-pinned plans do not silently switch providers. Existing Outlook provider cleanup/delete paths remain available so old events can still be removed. Pinned by `training-operational-switches.test.ts`, `training-calendar-source.test.ts`, `training-calendar-event-writer.test.ts`, and `training-plan-calendar-sync.test.ts`. |
| Calendar create-side throttling | Improved | `persistGeneratedTrainingPlan` now reads `TRAINING_CALENDAR_CREATE_BATCH_SIZE`, defaulting to 5 and clamping 1..5. Setting it to 1 serializes provider creates for smoke or rate-limit-sensitive accounts. Pinned by `training-plan-persistence.test.ts`. |
| Bike/swim target passthrough | Improved | `bikeSessionsPerWeek` and `swimSessionsPerWeek` now reach the coach kernel and influence triathlon/cycling/swimming weekly targets, rather than stopping at API response metadata. Pinned by `training-plan-generation.test.ts` and `training-coach-kernel-plan-generator.test.ts`. |
| Durable multi-process sync lock | Fixed | Added `training_operation_locks` and SQLite-backed same-user Training calendar operation locking across generation persistence, sync, reflow-confirm, and cancellation. Pinned by `training-operation-locks.test.ts`; the old route-local sync map was removed. Follow-up hardening made TTL operation-aware: generate gets 20 minutes, sync/cancel 15 minutes, and reflow keeps 10 minutes. |
| iOS double-tap UI disable/idempotency | Fixed in iOS repo | The iOS Training plan builder and weekly plan sync/cancel controls now set local in-flight state before spawning async tasks. `TrainingService` forwards explicit run/bike/swim targets. ViewModel plan-generation feedback now also uses deferred cleanup and focused iOS tests passed 31/31. |

Round 5 verification:

- `npx tsc --noEmit` passed.
- Expanded Training suite passed after durable operation locks: 20 files, 243 tests.
- `npm run verify` passed after durable locks and docs refresh: 637 files, 9447 tests.
- iOS focused XcodeBuildMCP tests passed: `Nexus HubTests/TrainingServiceTwoADayPreferenceTests` and `Nexus HubTests/TrainingViewModelObservationTests`, 31 tests.
- `git diff --check` passed.

## Areas To Inspect Carefully

1. Verify that `startPolicy` defaulting to next full week is correct in timezone boundaries, especially Sunday/Monday in `config.app.timezone`.
2. Verify automatic idempotency key semantics: same request within the 90-second auto window should dedupe, including adjacent-minute clicks; legitimate later repeated generation should still be possible.
3. Verify `migrations/153_training_operation_locks.sql` applies in staging before multi-process rollout; Training calendar mutation locks now depend on that durable table.
4. Verify no preview path calls provider `createEvent`, writes training plan rows, or mutates calendar ownership.
5. Verify cancellation does not over-delete unrelated events when matching Secretary markers. It should require training skill marker, source intent plan/session match, date match, duration match, and not be owned by another active Training plan.
6. Verify the Secretary adapter does not introduce a circular import/runtime initialization problem by loading `getSessionById`.
7. Verify provider event body output on Outlook calendar after enabling `TRAINING_CALENDAR_OUTLOOK_ENABLED=true` in staging because Google provider lifecycle has passed, but Outlook can transform line breaks or descriptions differently.
8. Verify Google Calendar error wrapping preserves every provider-not-found and rate-limit signal other callers rely on.
9. Verify Training delete retry defaults are safe for production provider quotas; the final smoke proved correctness under staging rate limits but also showed bursty 44-event cancellation can hit provider throttles.
10. Verify the deload removal does not erase valid taper/recovery behavior for race plans, poor readiness, pain, low compliance, return-to-training, or explicit deload phase plans.
11. Verify full bike/swim session generation in live triathlon smoke. The app-facing targets now reach the coach kernel, but the current real-provider smoke still covers running+strength only.
12. Verify iOS can consume the new response fields and that the new run-session stepper fits the design on smaller phones.

## Edge Cases To Verify

- Generate on Monday with default start policy starts that same Monday.
- Generate on Tuesday/Sunday with default start policy starts next Monday.
- `startPolicy:"today"` preserves the old immediate-start behavior.
- Two generate clicks without client idempotency key return one plan, not two.
- Two generate clicks at `12:00:59.500` and `12:01:00.500` with the same body return identical response data and create only one plan/event set.
- Two sync clicks while provider link is stale do not duplicate provider events.
- 6 runs + 5 gym with long run selected on Saturday keeps the long run on Saturday and adds five strength sessions.
- 12:00 preferred gym creates 12:00 when no conflict exists.
- 12:00 preferred gym with a real conflict creates a safe fallback and flags the conflict.
- Cancellation removes two duplicated provider events for the same session.
- Cancellation retries provider delete rate limits and eventually removes every owned event from a 44-event plan.
- Cancellation ignores title/date-only lookalikes without Nexus identity/Secretary source markers.
- Secretary-created event with only `NEXUS_SECRETARY_SOURCE_INTENT:training:<planId>:<version>:<sessionId>` is deleted on cancel.
- Event body first lines are human-useful session content, not `NEXUS_SECRETARY_*`.
- Event body order is weekly progression, warmup, main workout, cooldown, tips/recommendations, notes, time when all sections are present.
- Event body does not contain the old `⚠️ IMPORTANT:` label.
- Portuguese and English Training chat routes still route to `triathlon`/training and do not perform calendar writes through chat.

## Known Risks / Assumptions

- iOS repo changes were made in `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub-test-infra`, outside this backend worktree. Keep backend and iOS branch provenance aligned when packaging the release.
- Google real-provider calendar smoke passed. Outlook real-provider calendar smoke is blocked by missing Microsoft OAuth for the selected staging user.
- Production promote must not happen until Outlook calendar smoke passes with `TRAINING_CALENDAR_OUTLOOK_ENABLED=true`, or Felipe explicitly scopes this release to Google-only calendar validation with the Outlook Training flag left disabled.
- SQLite-backed Training operation locks now cover calendar generation persistence, sync, reflow-confirm, and cancellation. Operation-aware TTLs reduce split-brain risk for slow full-provider writes. Remaining risk is migration rollout, not lock design.
- Bike/swim target passthrough into the coach kernel is now covered, but real-provider smoke has not yet proven bike/swim-heavy plans end to end.
- Calendar writes remain REST/deterministic. No chat-pipeline Training write path was added.

## Requested QA Output

Please produce:

- A verdict: pass / pass with issues / fail.
- Findings ordered by severity with file:line references.
- Confirmation of each original seed bug as fixed, still broken, or requiring real staging verification.
- Any new issues found outside the seed list.
- Whether the remaining Outlook smoke gate is correctly documented and truly unavoidable without a Microsoft staging OAuth account.
- Recommended next steps before production promotion.
