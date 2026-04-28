# Final Open Items Test Coverage

Date: 2026-04-28

## Coverage Summary

The open-item work has strong local automated coverage and the previously missing staging/runtime proof has now been run for the critical provider and cross-skill gates. Calendar and cross-skill staging harnesses passed after staging prerequisites were prepared, exercised, and cleaned up.

| Priority | Area | Automated Tests | Smoke / Runtime Evidence | Status |
|---:|---|---|---|---|
| 1 | Constrained-week capacity reconciliation | 28 focused backend tests; typecheck; Training benchmark `99/100` across 156 cases. | Secretary conflict path covered in seeded cross-skill staging smoke. | Local and staging pass; production post-deploy check still required. |
| 2 | Session identity / plan version / shape hash | 63 focused backend tests; typecheck. | Google and Outlook staging provider read-back passed. | Local and staging pass; production post-deploy check still required. |
| 3 | Google/Outlook calendar staging smoke | Harness/runbook created. | Google run `training-calendar-smoke-20260428165035-7ljwng`; Outlook run `training-calendar-smoke-20260428165107-7fsbbr`; cleanup passed. | Pass. |
| 4 | iOS rich payload smoke | 28 `TrainingPresentationTests`; 58 broader affected tests. | XcodeBuildMCP `build_run_sim`, Home snapshot, Training snapshot passed on live account. | Pass with synthetic visual gap. |
| 5 | Rich iOS feedback UI | `TrainingFeedbackPayloadTests`; targeted ViewModel/service tests. | Focused simulator unit tests passed. | Unit pass, backend persistence smoke missing. |
| 6 | Poor-recovery variation | Focused poor-recovery tests and broader guardrail/planner/adaptation tests. | No staging needed. | Backend pass. |
| 7 | Weak-profile follow-up prompts | 10 profile tests; 33 profile/planner tests; typecheck. | No iOS follow-up UX smoke. | Backend pass, product loop partial. |
| 8 | Schedule-compression explanations | 9 focused constrained-week/decision-trail tests; typecheck. | No route-level/iOS rendering smoke. | Backend pass, contract display partial. |
| 9 | Cross-skill staging smoke | Local fixture contract checks passed. | Real staging blocked. | Harness pass, staging blocked. |
| 10 | Catalog expansion | 9 catalog tests; 37 focused tests; 148 coach-kernel regression sweep; typecheck; full run cited at 371 files / 5,892 tests passing. | No staging needed. | Backend pass. |

## Backend Test Evidence

### Priority 1: Constrained-Week Capacity

Evidence files:

- `docs/training/constrained-week-capacity-reconciliation.md`
- `docs/training/constrained-week-test-matrix.md`
- `__tests__/services/coach-kernel-constrained-week-capacity.test.ts`

Commands documented:

```bash
npm test -- --run __tests__/services/coach-kernel-constrained-week-capacity.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-evaluation.test.ts
npm run typecheck
npm run eval:training -- --week-start 2026-04-27 --fail-under 95 --out-dir reports/training-eval/constrained-week-capacity
```

Result documented:

- `npm run typecheck` passed.
- 28 focused tests passed.
- Training benchmark passed at `99/100` across `156` cases.

### Priority 2: Session Identity

Evidence files:

- `docs/training/session-identity-plan-version-shape-hash.md`
- `docs/training/session-identity-test-matrix.md`
- `__tests__/services/training-session-identity.test.ts`
- `__tests__/services/training-plan-lifecycle.test.ts`
- `__tests__/api/training-plan-persistence.test.ts`
- `__tests__/api/training-plan-calendar-sync.test.ts`
- `__tests__/api/training-plan-cancellation.test.ts`

Commands documented:

```bash
npm test -- --run __tests__/services/training-session-identity.test.ts __tests__/services/training-plan-lifecycle.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/api/training-plan-cancellation.test.ts
npm run typecheck
```

Result documented:

- 63 focused tests passed.
- TypeScript typecheck passed.

### Priority 3: Calendar Staging Smoke

Evidence files:

- `scripts/training-calendar-staging-smoke.sh`
- `src/tools/training-calendar-staging-smoke.ts`
- `docs/training/calendar-staging-smoke-runbook.md`
- `docs/training/calendar-staging-smoke-results.md`

Run result:

- Google run ID: `training-calendar-smoke-20260428165035-7ljwng`
- Outlook run ID: `training-calendar-smoke-20260428165107-7fsbbr`
- Status: `passed`
- Google: create/update/same-shape regenerate/changed-shape replace/cancel/retry passed with read-back.
- Outlook: create/update/same-shape regenerate/changed-shape replace/cancel/retry passed with read-back.
- Cleanup: exact-event cleanup passed for both providers.

This is now a staging-provider pass. Production-safe post-deploy checks remain required.

### Priority 6: Poor-Recovery Variation

Evidence files:

- `docs/training/poor-recovery-variation.md`
- `docs/training/poor-recovery-test-matrix.md`
- `__tests__/services/coach-kernel-poor-recovery-variation.test.ts`

Commands documented:

```bash
npx vitest run '__tests__/services/coach-kernel-poor-recovery-variation.test.ts'
npx vitest run '__tests__/services/coach-kernel-guardrails.test.ts' '__tests__/services/coach-kernel-planner.test.ts' '__tests__/services/coach-kernel-adaptation-engine.test.ts' '__tests__/services/coach-kernel-poor-recovery-variation.test.ts'
```

Result documented:

- Focused validation passed.
- Covers cycling, hybrid, strength, travel, repeated poor-recovery outputs, intensity reduction, and warning dedupe.

### Priority 7: Weak-Profile Follow-Ups

Evidence files:

- `docs/training/weak-profile-followup-prompts.md`
- `docs/training/profile-confidence-model.md`
- `docs/training/followup-prompts-test-matrix.md`
- `__tests__/services/training-profile-model.test.ts`

Commands documented:

```bash
npx vitest run '__tests__/services/training-profile-model.test.ts'
npx vitest run '__tests__/services/training-profile-model.test.ts' '__tests__/services/training-coach-kernel-plan-generator.test.ts' '__tests__/services/coach-kernel-planner.test.ts' '__tests__/services/coach-kernel-decision-trail.test.ts'
npm run typecheck
```

Result documented:

- 10 profile tests passed.
- 33 focused profile/planner tests passed.
- TypeScript passed.

### Priority 8: Schedule-Compression Explanations

Evidence files:

- `docs/training/schedule-compression-explanations.md`
- `docs/training/decision-reason-model.md`
- `docs/training/compression-explanation-test-matrix.md`
- `__tests__/services/coach-kernel-decision-trail.test.ts`

Commands documented:

```bash
npx vitest run '__tests__/services/coach-kernel-constrained-week-capacity.test.ts' '__tests__/services/coach-kernel-decision-trail.test.ts'
npm run typecheck
```

Result documented:

- 2 test files passed.
- 9 tests passed.
- TypeScript passed.

### Priority 9: Cross-Skill Staging Smoke

Evidence files:

- `scripts/training-cross-skill-staging-smoke.sh`
- `src/tools/training-cross-skill-staging-smoke.ts`
- `docs/training/cross-skill-staging-smoke-runbook.md`
- `docs/training/cross-skill-staging-smoke-results.md`

Run result:

- Run ID: `training-cross-skill-smoke-20260428073331-b9p9y1`
- Local fixture contracts: passed.
- Staging prerequisites: blocked.

This is not a staging pass. It proves harness/contract behavior only.

### Priority 10: Catalog Expansion

Evidence files:

- `docs/training/catalog-expansion.md`
- `docs/training/catalog-schema-and-metadata.md`
- `docs/training/catalog-test-matrix.md`
- `__tests__/services/coach-kernel-catalog-depth.test.ts`

Commands documented:

```bash
npm run typecheck
npx vitest run __tests__/services/coach-kernel-catalog-depth.test.ts
npx vitest run __tests__/services/coach-kernel-catalog-depth.test.ts __tests__/services/coach-kernel-strength-engine.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-poor-recovery-variation.test.ts
npx vitest run __tests__/services/coach-kernel-evaluation.test.ts __tests__/services/coach-kernel-catalog-depth.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-strength-engine.test.ts __tests__/services/coach-kernel-strength-engine-target-exercise-count.test.ts __tests__/services/coach-kernel-session-coherence.test.ts __tests__/services/coach-kernel-biomechanics-and-ordering.test.ts __tests__/services/coach-kernel-exercise-metadata.test.ts __tests__/services/training-plan-lifecycle.test.ts
npm run eval:training -- --week-start 2026-04-27 --json /tmp/nexus-training-catalog-eval.json --markdown /tmp/nexus-training-catalog-eval.md --fail-under 0
npm test
```

Results documented:

- 9 catalog tests passed.
- 37 focused tests passed.
- 148 coach-kernel regression tests passed.
- `npm run typecheck` passed.
- Regenerated benchmark: `97/100`, 156 cases, 13 personas, 12 scenarios.
- Full regression cited: 371 test files / 5,892 tests passing.

## iOS Test Evidence

### Priority 4: Rich Payload Smoke

Evidence files:

- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/training-rich-payload-smoke.md`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/training-rich-payload-test-matrix.md`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/training-rich-payload-open-items.md`

Commands documented:

```bash
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" -only-testing:"Nexus HubTests/TrainingPresentationTests"

xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" -only-testing:"Nexus HubTests/TrainingPresentationTests" -only-testing:"Nexus HubTests/TrainingHomeViewStateContractDecodingTests" -only-testing:"Nexus HubTests/TrainingHomeViewStateBuilderTests" -only-testing:"Nexus HubTests/TrainingHomeContractResolverTests" -only-testing:"Nexus HubTests/TrainingSecondarySectionsPresentationTests"
```

Results documented:

- `TrainingPresentationTests`: 28 passed.
- Broader affected Training slice: 58 passed.
- XcodeBuildMCP `build_run_sim`: succeeded.
- Home snapshot, Training navigation, and Training snapshot succeeded on live backend data.

Limit:

- Rich synthetic lifecycle states were not screenshot-smoked because the app lacks debug fixture injection.

### Priority 5: Rich Feedback UI

Evidence files:

- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/training-rich-feedback-ui.md`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/training-feedback-contract.md`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/training-feedback-test-matrix.md`
- `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/training-feedback-open-items.md`

Command documented:

```bash
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" -only-testing:"Nexus HubTests/TrainingFeedbackPayloadTests" -only-testing:"Nexus HubTests/TrainingViewModelObservationTests/test_submitSessionFeedback_withoutLocalTodaySession_postsRichSentinelPayload" -only-testing:"Nexus HubTests/TrainingServiceTimeoutTests/test_completeTrainingCanSendRicherCoachFeedbackPayload"
```

Result documented:

- `TEST SUCCEEDED`.

Limit:

- Backend persistence/adaptation for every field still needs backend tests.
- Visual smoke with real active staging feedback storage remains open.

## Coverage Gaps That Still Matter

1. Real Google and Outlook provider lifecycle proof.
2. Real cross-skill staging proof with seeded Secretary/Cooking/Finance/Content data.
3. iOS screenshot/layout proof for synthetic rich Training lifecycle states.
4. Backend persistence/adaptation tests for rich feedback fields.
5. Route-level serialization tests for `profileQuality` and `decisionReasons`.
6. Direct engine capacity input from real Secretary busy windows.
7. Durable representation of deferred/unscheduled sessions if product wants them visible after reload.
