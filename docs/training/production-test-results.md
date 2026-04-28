# Training Production Test Results

Updated: 2026-04-28  
Branch: `release/training-engine-production-hardening`

## Summary

Backend validation passed locally for the production-critical Training hardening changes. iOS local compatibility also passed, including the full iOS test scheme after updating stale dashboard timezone expectations. Real provider staging smokes remain blocked by missing staging credentials/environments and are not counted as passed.

## Commands Run

### Focused Persistence / Capacity Regression

```bash
npx vitest run \
  __tests__/api/training-plan-persistence.test.ts \
  __tests__/services/coach-kernel-constrained-week-capacity.test.ts
```

Result: **pass**

- 2 files passed
- 12 tests passed

### Training Route Contract Regression

```bash
npx vitest run __tests__/api/training-routes.test.ts
```

Result: **pass**

- 1 file passed
- 28 tests passed

### Operational Switch And Smoke-Harness Safety Regression

```bash
npm run typecheck
npx vitest run \
  __tests__/tools/training-calendar-staging-smoke.test.ts \
  __tests__/tools/training-cross-skill-staging-smoke.test.ts \
  __tests__/services/training-operational-switches.test.ts \
  __tests__/api/training-calendar-event-writer.test.ts
```

Result: **pass**

- TypeScript passed.
- 4 files passed.
- 23 tests passed.
- Verifies Training generation/calendar/cross-skill kill-switch behavior and prevents dry-run smoke reports from being treated as staging proof.

### Focused Training Production Blocker Suite

```bash
npx vitest run \
  __tests__/services/coach-kernel-constrained-week-capacity.test.ts \
  __tests__/services/training-session-identity.test.ts \
  __tests__/services/training-agenda-reconciliation.test.ts \
  __tests__/services/training-plan-lifecycle.test.ts \
  __tests__/services/coach-kernel-decision-trail.test.ts \
  __tests__/services/coach-kernel-poor-recovery-variation.test.ts \
  __tests__/services/training-profile-model.test.ts \
  __tests__/services/coach-kernel-feedback-analysis.test.ts \
  __tests__/api/training-schedule-utils.test.ts \
  __tests__/api/training-plan-calendar-sync.test.ts \
  __tests__/api/training-plan-cancellation.test.ts \
  __tests__/api/training-plan-persistence.test.ts \
  __tests__/api/training-routes.test.ts
```

Result: **pass**

- 13 files passed
- 140 tests passed

### Full Backend Verify

```bash
npm run verify
```

Result: **pass**

- `tsc --noEmit` passed
- 382 test files passed
- 5,994 tests passed

### Training Evaluation Harness

```bash
npm run eval:training -- \
  --week-start 2026-04-27 \
  --fail-under 95 \
  --out-dir reports/training-eval/production-hardening-final
```

Result: **pass**

- Score: 99/100
- Cases: 156
- Latest post-packaging rerun output was written outside the repo to avoid committing generated artifacts:
  - `/tmp/nexus-training-eval-production-candidate/training-eval-2026-04-28T13-09-20-605Z.json`
  - `/tmp/nexus-training-eval-production-candidate/training-eval-2026-04-28T13-09-20-605Z.md`
- Curated committed baseline remains in `docs/training/eval-baseline-results.md` and `docs/training/eval-baseline-results.json`.

### iOS Local Compatibility

```bash
xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" \
  -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" \
  -only-testing:"Nexus HubTests/TrainingLocalSmokeFixtureTests" \
  -only-testing:"Nexus HubTests/TrainingFeedbackPayloadTests" \
  -only-testing:"Nexus HubTests/TrainingHomeViewStateContractDecodingTests" \
  -only-testing:"Nexus HubTests/TrainingPresentationTests" \
  -only-testing:"Nexus HubTests/TrainingViewModelObservationTests" \
  -only-testing:"Nexus HubTests/DebugAuthTokenImporterPolicyTests"

xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" \
  -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro"
```

Result: **pass**

- Focused Training/importer suites passed.
- Full iOS scheme passed after updating `DashboardHeroPresentationTests` to assert against the localized `CalendarEvent` display contract instead of pre-timezone-fix UTC strings.
- Authenticated local simulator journey passed separately through the full local product runner: 43 authenticated REST calls across 19 endpoints, all `userId: 2`, all HTTP 200.
- Post-packaging full iOS scheme result bundle:
  `/Users/felipedominguez/Library/Developer/Xcode/DerivedData/Nexus_Hub-gsoqdyrpqmkkotdmfddhuhobycvu/Logs/Test/Test-Nexus Hub-2026.04.28_14-09-36-+0100.xcresult`

### Calendar Staging Smoke

```bash
npm run smoke:training-calendar:staging -- --dry-run
```

Result: **blocked safely**

- Latest dry-run ID: `training-calendar-smoke-20260428124302-69m2w3`
- Providers run: none
- Missing:
  - `STAGING=true or NODE_ENV=staging`
  - `TRAINING_CALENDAR_STAGING_SMOKE=1`
  - `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1`
  - `TRAINING_CALENDAR_STAGING_USER_ID=<staging user id>`
  - `OAUTH_ENCRYPTION_KEY`
  - `DATABASE_PATH=<staging database path>`
  - `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET`
  - `OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET`
- Cleanup failures: none
- Interpretation: real Google/Outlook lifecycle validation was **not run**. Dry-run provider rows are marked `blocked`, not `pass`.

### Final Calendar Staging Gate

```bash
TRAINING_CALENDAR_STAGING_RESULTS_PATH=docs/training/final-calendar-staging-results.md \
npm run smoke:training-calendar:staging
```

Result: **blocked safely / no-go**

- Run ID: `training-calendar-smoke-20260428142908-61fokl`
- Providers run: none
- Event IDs: none
- Cleanup failures: none
- Result doc: `docs/training/final-calendar-staging-results.md`
- Gate doc: `docs/training/final-calendar-staging-gate.md`
- Open blockers: `docs/training/final-calendar-staging-open-blockers.md`
- Interpretation: final Google/Outlook lifecycle staging proof is still missing.

### Cross-Skill Staging Smoke

```bash
npm run smoke:training-cross-skill:staging -- --dry-run
```

Result: **local fixtures passed; staging blocked safely**

- Latest dry-run ID: `training-cross-skill-smoke-20260428124119-8wyjtt`
- Local fixture contract checks: passed
- Staging runtime checks: blocked
- Missing:
  - `STAGING=true or NODE_ENV=staging`
  - `TRAINING_CROSS_SKILL_STAGING_SMOKE=1`
  - `TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id>`
  - `DATABASE_PATH=<staging database path>`
- Harness validation: `npx vitest run __tests__/tools/training-cross-skill-staging-smoke.test.ts` passed 8/8.
- Hardening note: runtime checks now block when the selected staging user lacks actual Secretary conflict, Cooking fueling, Finance constraint, or Content workload fixture data.
- Dry-run hardening note: dry-run is explicitly reported as blocked and is not staging proof.

## Release Interpretation

The backend Training hardening code is locally validated and ready for staging validation. Production remains a no-go until:

- the branch is committed/reviewed cleanly;
- Google and Outlook staging smokes pass with real read-back/cleanup;
- migration rollback is rehearsed;
- iOS local smoke remains green after the worktree is packaged into the final clean candidate.
