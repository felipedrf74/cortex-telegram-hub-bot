# Training Release Blocker Audit

Date: 2026-04-29
Branch observed: `feature/secretary-scheduling-arbitrator-batch4`
Scope: audit only. No Training code was changed in this pass.

## Executive Summary

No new open P0 Training code blocker was found in this audit.

The current Training release posture is best described as **pass with conditions for production hardening**:

- Real Google and Outlook staging calendar lifecycle proof is documented as passed.
- Cross-skill staging smoke is documented as passed.
- Migration 082 and session identity/shape-hash work is implemented and documented with local plus staging clone rehearsal evidence.
- iOS has decode and presentation coverage for rich Training lifecycle states such as `reflowed`, `unscheduled`, `superseded`, and `canceled`.
- Remaining concerns are mostly P1/P2 productization, evidence freshness, documentation drift, and claim discipline.

The biggest audit finding is not a single code defect. It is **release-evidence drift**: several older open-item docs still describe gates as blocked after newer production/readiness docs say those gates were closed. Before any next Training release, the Training docs should be reconciled so operators do not rely on stale blockers or stale "go" assumptions.

## Sources Reviewed

Primary Training release docs:

- `docs/training/production-open-blockers.md`
- `docs/training/final-production-go-no-go.md`
- `docs/training/production-readiness-criteria.md`
- `docs/training/release-candidate-risk-register.md`
- `docs/training/release-candidate-test-coverage-gaps.md`
- `docs/training/final-open-items-remaining-risks.md`

Focused open-item docs:

- `docs/training/constrained-week-open-items.md`
- `docs/training/session-identity-open-items.md`
- `docs/training/agenda-open-items.md`
- `docs/training/feedback-open-items.md`
- `docs/training/poor-recovery-open-items.md`
- `docs/training/followup-open-items.md`
- `docs/training/compression-explanation-open-items.md`
- `docs/training/catalog-open-items.md`

Backend code/tests sampled:

- `src/api/routes/training-plan-persistence.ts`
- `src/api/routes/training-plan-calendar-sync.ts`
- `src/api/routes/training-plan-cancellation.ts`
- `src/services/training-plans.ts`
- `src/services/training-plan-lifecycle.ts`
- `src/services/training-profile-model.ts`
- `src/services/training-plan-coordination.ts`
- `src/services/coach-kernel/poor-recovery-variation.ts`
- `__tests__/services/coach-kernel-constrained-week-capacity.test.ts`
- `__tests__/services/coach-kernel-feedback-analysis.test.ts`
- `__tests__/services/coach-kernel-poor-recovery-variation.test.ts`
- `__tests__/services/training-profile-model.test.ts`
- `__tests__/services/training-plan-lifecycle.test.ts`
- `__tests__/api/training-routes.test.ts`

iOS contract evidence sampled read-only:

- `Nexus Hub/Models/TrainingSession.swift`
- `Nexus Hub/Views/Training/WeeklyPlanView.swift`
- `Nexus Hub/Views/Training/TrainingSessionFeedbackSheet.swift`
- `Nexus Hub/Core/Repositories/TrainingRepository.swift`
- `Nexus Hub/Core/TrainingLocalSmokeFixtures.swift`
- `Nexus HubTests/TrainingPresentationTests.swift`
- `Nexus HubTests/TrainingLocalSmokeFixtureTests.swift`
- `Nexus HubTests/TrainingFeedbackPayloadTests.swift`

## Audit Findings By Focus Area

### 1. Constrained And Travel-Week Reconciliation

Current state:

- The coach-kernel constrained-week tests cover travel strength weeks, constrained cycling/strength density, no-valid-slot behavior, and evidence-backed reflow/compression explanations.
- Generated sessions can be persisted as `unscheduled` when no valid slot exists instead of inventing missing times.
- Training coordination consumes Secretary travel/context signals in the current backend, and shared decision context includes travel/focus/availability pressure.
- Existing release docs say "Secretary busy windows / impossible calendar slots" was fixed for calendar-slot feasibility and that deeper pre-generation Secretary adapter work can move to P2.

Remaining gap:

- Secretary busy windows are not yet a single first-class pre-generation capacity input into the coach-kernel. The current model handles declared constraints and later calendar/persistence feasibility, but it is not yet the full "Secretary is the pre-generation calendar oracle" architecture.
- Slot-sharing is still simple. Transition buffers and "do not stack sessions even if the slots technically fit" are not fully modeled.
- Some older docs still say inactive schedule states are not persisted, while newer code/docs indicate `unscheduled` persistence is implemented. This is evidence drift and should be reconciled.

Release classification:

- P1 only if release copy claims fully Secretary-aware calendar planning before generation.
- P2 for normal production hardening, because impossible calendar slots now have an `unscheduled` path and staging evidence exists.

### 2. Too Many Active Sessions

Current state:

- Capacity reconciliation tests assert that active sessions are capped/reflowed/compressed and leftover sessions become inactive/unscheduled.
- `__tests__/services/coach-kernel-constrained-week-capacity.test.ts` explicitly covers "too many sessions for feasible windows" and no-valid-slot behavior.
- The evaluator includes active-session scoring pressure.

Remaining gap:

- Audit evidence is strong at unit/eval level, but full user-facing read-model and iOS reload proof should remain in the regression matrix whenever scheduler/capacity logic changes.
- Older docs should be updated to stop implying this is still an open P0/P1 blocker.

Release classification: P2 regression watch.

### 3. Missing Scheduled Times

Current state:

- `training-plan-persistence.ts` stores no-slot sessions as `unscheduled`.
- `training-plan-calendar-sync.ts` skips/marks no-slot sessions rather than creating invalid provider events.
- iOS `TrainingSession` decodes lifecycle state and `WeeklyPlanView` renders `unscheduled` explicitly.
- `TrainingPresentationTests` and `TrainingLocalSmokeFixtureTests` cover unscheduled Training sessions.

Remaining gap:

- Continue testing read-model reconstruction after persistence and calendar sync, because this is where "missing scheduled time" bugs tend to reappear.

Release classification: P2 regression watch, not a current P0/P1 blocker.

### 4. Plan Versioning

Current state:

- Training lifecycle code tracks plan/session ownership through lifecycle tables and session identity markers.
- Cancellation/replacement code has moved away from broad title/date cleanup and toward exact identity/provider mapping.
- Real staging Google and Outlook lifecycle proofs are documented as passed.

Remaining gap:

- `agenda-open-items.md` still calls out a future first-class `superseded` plan status. Today, canceled/replaced plans and ownership rows are safe enough for cleanup, but lifecycle reporting is not as expressive as it could be.
- A scheduled background reconciler for old/orphaned Training agenda events is still not documented as live.

Release classification:

- P2 for first-class superseded plan status.
- P2 for scheduled orphan reconciliation.

### 5. Session Shape Hash

Current state:

- `session_shape_hash` exists in Training persistence and read models.
- Calendar sync and cancellation compute/fallback to `sessionShapeHash`.
- Migration 082 is documented as additive and rehearsed on both local and true staging clone paths.
- iOS decodes `sessionShapeHash`, and tests verify shape hash propagation in rich payload fixtures.

Remaining gap:

- Legacy unmarked provider events cannot be safely deleted by title/date. This is the right safety choice, but it leaves a reporting/reconciliation need for historical orphan events.
- Before any future DB migration touching this surface, confirm a fresh predeploy production snapshot rather than relying on old release evidence.

Release classification:

- P2 for legacy orphan reporting/reconciliation.
- Deployment-process condition for future migrations.

### 6. Agenda Cleanup

Current state:

- Cleanup is identity-based and provider-event-id based, not broad date/title matching.
- Staging Google and Outlook lifecycle smokes are documented as passed with provider read-back and cleanup proof.
- Calendar release docs indicate no unrelated event deletion.

Remaining gap:

- No scheduled production reconciler is documented for `reconcileOrphanedTrainingAgendaEvents`.
- User/manual provider moves are not fully specified. If a user moves a Training event directly in Google/Outlook, product semantics for Training are still a design gap.
- iOS can render richer agenda lifecycle state, but app-level surfacing of reconciliation status is still a polish/diagnostics gap.

Release classification: P2.

### 7. iOS Rich Payload States

Current state:

- iOS `TrainingSession` decodes `sessionShapeHash`, `lifecycleState`, and `lifecycleStatus`.
- iOS presentation tests cover `reflowed`, `unscheduled`, `superseded`, `canceled`, and `capped/compressed` states.
- Local smoke fixtures include rich Training payloads with scheduled, reflowed, unscheduled, poor-recovery, superseded, and canceled sessions.
- Calendar/Secretary presentation tests also cover lifecycle labels and decision reason codes.

Remaining gap:

- Signed TestFlight/device validation is still the practical closure path for user-facing Training, auth, provider-state, and HealthKit behavior. Simulator/local fixture proof is strong but not a substitute for signed-device validation.

Release classification:

- P1 for public beta/user-facing release confidence.
- P2 for backend-only release.

### 8. Rich Feedback UI

Current state:

- iOS has `TrainingSessionFeedbackSheet` and structured `TrainingCompletionFeedback`.
- iOS tests cover feedback payload generation and repository submission paths.
- Backend feedback analysis tests cover too hard/easy/long, soreness/pain, skipped travel, deload, progression, and duration-coherence behavior.

Remaining gap:

- End-to-end adaptive-coach proof is still incomplete as a product claim: iOS feedback -> backend persistence -> future plan adaptation -> user-visible explanation.
- Explicit skipped-session reasons, durable follow-up prompt resolution, per-lift progression reporting, and run/cycle progression reports remain open in feedback docs.

Release classification:

- P1 if release copy claims closed-loop adaptive feedback.
- P2 if framed as structured feedback foundation plus partial adaptation.

### 9. Poor-Recovery Variation

Current state:

- Major poor-recovery issues are marked closed in `poor-recovery-open-items.md`: hybrid flattening, cycling repetition, travel off-bike fallback, strength mobility fallback, and readiness metadata.
- Tests cover modality-aware poor-recovery variation and deterministic rotation.

Remaining gap:

- Running-only red-readiness regression still needs dedicated coverage.
- Orange-readiness nuance is not as rich as red-readiness adaptation.
- Swim recovery has only one option.
- Poor-recovery minimum-dose sessions are still the lowest-scoring eval cases, mainly from minute-level duration estimator precision.
- Capacity reconciliation can still override/defer recovery sessions, so combined constrained-week plus poor-recovery coverage should stay in the release matrix.

Release classification: P2.

### 10. Weak-Profile Follow-Up Prompts

Current state:

- Backend `training-profile-model.ts` emits `profileQuality`, missing-critical-data, planning risk flags, and targeted follow-up questions.
- Backend tests cover low-confidence profile detection, targeted follow-up questions, and confidence improvement after answers.
- iOS local/rich Training surfaces have support for richer Training state, and current iOS code includes profile setup/resolver coverage.

Remaining gap:

- Durable prompt resolution/history is not fully closed. Without it, repeated prompts across devices remain possible.
- Direct profile answer write routes and localization/vocabulary polish remain open.

Release classification:

- P1 if release claims a finished profile-interview loop.
- P2 as an ongoing personalization improvement.

### 11. Schedule-Compression Explanations

Current state:

- Backend constrained-week tests assert `decisionReasons` for reflow/compression.
- Training API route tests cover `decisionReasons` and `profileQuality` in response payloads.
- iOS and calendar presentation tests can render lifecycle/decision reason concepts.

Remaining gap:

- Route-level regression after persistence/read-model reconstruction should remain explicit.
- iOS structured rendering of Training-specific compression explanations should be validated from live/local API payloads, not only fixtures.
- Cross-skill source attribution and localization remain open polish.

Release classification:

- P1 if release copy promises fully explainable Training scheduling in the app.
- P2 for backend foundation.

### 12. Catalog Gaps Causing Bad Outputs

Current state:

- Catalog depth tests cover travel treadmill easy runs, hotel spin, hybrid support, and limited equipment tags.
- Evaluation baseline is high overall.

Remaining gap:

- Hybrid interference remains a known second-pass area.
- Running public taxonomy is compressed for iOS compatibility.
- Strength machine/barbell depth still needs expansion.
- Cycling event-specific specialization and richer warmup/cooldown structure remain open.
- Runtime schema validation/substitution ranking by equipment confidence would reduce bad-output risk.

Release classification:

- P2 for output quality.
- P3 for deeper catalog breadth/localization unless a specific bad-output regression is found.

## Documentation Drift

The audit found multiple stale or superseded blocker statements:

- `docs/training/final-open-items-remaining-risks.md` still describes real provider and cross-skill staging proof as blocked, while newer docs list Google, Outlook, and cross-skill staging smokes as passed.
- `docs/training/production-readiness-criteria.md` contains newer release status text, but some older checklist-style language remains easy to misread.
- Open-item docs for session identity, calendar description updates, inactive state persistence, and calendar lifecycle still include items that newer production blocker docs say are closed or downgraded.

Recommendation: make `docs/training/production-open-blockers.md` and `docs/training/production-readiness-criteria.md` the canonical release truth, then update or mark older open-item docs as historical.

## Tests Added Or Run In This Audit

No new tests were added and no test suite was executed in this audit pass. This was a documentation and evidence audit only.

Evidence came from existing docs, code inspection, and test inventory. Before merging any code changes in these areas, rerun the focused Training suites plus the relevant iOS rich-payload tests.

Suggested focused commands for the next code-changing pass:

```bash
npm test -- --runInBand __tests__/services/coach-kernel-constrained-week-capacity.test.ts
npm test -- --runInBand __tests__/services/coach-kernel-feedback-analysis.test.ts
npm test -- --runInBand __tests__/services/coach-kernel-poor-recovery-variation.test.ts
npm test -- --runInBand __tests__/services/training-profile-model.test.ts
npm test -- --runInBand __tests__/services/training-plan-lifecycle.test.ts
npm test -- --runInBand __tests__/api/training-routes.test.ts
```

iOS focused commands:

```bash
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" "-only-testing:Nexus HubTests/TrainingPresentationTests" "-only-testing:Nexus HubTests/TrainingLocalSmokeFixtureTests" "-only-testing:Nexus HubTests/TrainingFeedbackPayloadTests"
```

## Release-Gate Verdict

Verdict from this audit: **PASS WITH CONDITIONS**.

Conditions:

1. Reconcile stale Training release docs before the next operator release action.
2. Keep release copy restrained: do not claim GPT-5.5 runtime execution, finished rich-feedback adaptation, or fully Secretary-precomputed calendar intelligence unless new evidence is added.
3. Keep production-safe post-deploy validation and monitoring active for Training read/create, calendar cleanup, and logs.
4. Treat signed-device/TestFlight Training validation as required for public-beta confidence.
