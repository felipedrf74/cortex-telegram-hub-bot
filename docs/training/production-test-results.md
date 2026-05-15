# Training Production Test Results

Updated: 2026-04-28  
Branch: `release/training-engine-production-hardening`

## Summary

Backend validation passed locally for the production-critical Training hardening changes. Real provider staging smokes remain blocked by missing staging credentials/environments and are not counted as passed.

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
- 26 tests passed

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
- 379 test files passed
- 5,977 tests passed

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
- JSON: `reports/training-eval/production-hardening-final/training-eval-2026-04-28T09-29-31-616Z.json`
- Markdown: `reports/training-eval/production-hardening-final/training-eval-2026-04-28T09-29-31-616Z.md`

### Calendar Staging Smoke

```bash
npm run smoke:training-calendar:staging
```

Result: **blocked safely**

- Run ID: `training-calendar-smoke-20260428093019-7xbyxn`
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
- Interpretation: real Google/Outlook lifecycle validation was **not run**.

### Final Calendar Staging Gate

```bash
TRAINING_CALENDAR_STAGING_RESULTS_PATH=docs/training/final-calendar-staging-results.md \
npm run smoke:training-calendar:staging
```

Result: **blocked safely / no-go**

- Run ID: `training-calendar-smoke-20260428094430-r9cyiu`
- Providers run: none
- Event IDs: none
- Cleanup failures: none
- Result doc: `docs/training/final-calendar-staging-results.md`
- Gate doc: `docs/training/final-calendar-staging-gate.md`
- Open blockers: `docs/training/final-calendar-staging-open-blockers.md`
- Interpretation: final Google/Outlook lifecycle staging proof is still missing.

### Cross-Skill Staging Smoke

```bash
npm run smoke:training-cross-skill:staging
```

Result: **local fixtures passed; staging blocked safely**

- Latest run ID: `training-cross-skill-smoke-20260428105013-bj5mtb`
- Local fixture contract checks: passed
- Staging runtime checks: blocked
- Missing:
  - `STAGING=true or NODE_ENV=staging`
  - `TRAINING_CROSS_SKILL_STAGING_SMOKE=1`
  - `TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id>`
  - `DATABASE_PATH=<staging database path>`
- Harness validation: `npx vitest run __tests__/tools/training-cross-skill-staging-smoke.test.ts` passed 7/7.
- Hardening note: runtime checks now block when the selected staging user lacks actual Secretary conflict, Cooking fueling, Finance constraint, or Content workload fixture data.

## Release Interpretation

The backend Training hardening code is locally validated and ready for staging validation. Production remains a no-go until:

- the branch is committed/reviewed cleanly;
- Google and Outlook staging smokes pass with real read-back/cleanup;
- migration rollback is rehearsed;
- iOS rich Training simulator smoke passes if the iOS release includes these richer states.
