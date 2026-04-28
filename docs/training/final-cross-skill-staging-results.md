# Training Cross-Skill Staging Smoke Results

Date: 2026-04-28
Backend staging path: `/home/dominguez/telegram-hub-bot-staging`
Staging user ID: `1`
Run ID: `training-cross-skill-smoke-20260428164946-829lm7`
Result: **PASS**

## Summary

The final Training-centered cross-skill staging smoke passed after seeding and then cleaning staging-only fixture data for the isolated staging user.

The first real staging attempt proved Secretary, Cooking, Content, and scope checks, but blocked on missing Finance constraint data and missing Training-to-Content milestone data for the staging user. To avoid a false green, a dedicated staging fixture tool was added:

- `src/tools/training-cross-skill-staging-fixtures.ts`

The tool refuses seed/cleanup writes unless all staging smoke guardrails are present:

- `STAGING=true`
- `NODE_ENV=staging`
- `TRAINING_CROSS_SKILL_STAGING_SMOKE=1`
- `TRAINING_CROSS_SKILL_STAGING_USER_ID=1`
- `TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE=1`
- staging-looking `DATABASE_PATH`

## Fixture Seed And Cleanup

Seed output:

| Field | Value |
| --- | --- |
| `financeRowsCreated` | `2` |
| `planIdCreated` | `1` |
| `weekIdCreated` | `1` |
| `sessionIdCreated` | `1` |
| `activeFixturePlans` after seed | `1` |
| `activeFixtureFinanceRows` after seed | `2` |

Cleanup output:

| Field | Value |
| --- | --- |
| `financeRowsRemoved` | `2` |
| `planIdsRemoved` | `[1]` |
| `activeFixturePlans` after cleanup | `0` |
| `activeFixtureFinanceRows` after cleanup | `0` |

Post-cleanup status check:

| Field | Value |
| --- | --- |
| `activeFixturePlans` | `0` |
| `activeFixtureFinanceRows` | `0` |

## Local Fixture Contract Checks

| Flow | Result |
| --- | --- |
| Local fixture contracts | Pass |
| Secretary conflict contract | Pass |
| Cooking fueling gap contract | Pass |
| Finance budget constraint contract | Pass |
| Content workload contract | Pass |
| Training content milestone contract | Pass |

## Staging Runtime Checks

| Flow | Result | Evidence |
| --- | --- | --- |
| Training + Secretary conflicts | Pass | `secretarySignals=calendar_busy_blocks, inbox_pressure, calendar_fragmentation, deadline_pressure`; `secretaryEvents=68`; `focusBlock=true`; `protectFocusDay=saturday`; `modularSessionBias=false` |
| Training + Cooking fueling gaps | Pass | `cookingSignals=meal_plan_window, fueling_support_status, meal_execution_readiness, grocery_spend_forecast`; `conservativeFirstWeek=true`; no duplicate active hybrid warning surfaced |
| Training + Finance constraints | Pass | `financeSignals=budget_remaining, expense_anomaly`; `affordability=tight`; `lowCostBias=true` |
| Training + Content workload | Pass | `nextExecution=My Hero Academia x Brawl Stars`; `protectFilmingDay=wednesday` |
| Training-to-Content milestone | Pass | `trainingSignals=training_load_forecast, recovery_state, session_prescription, session_immovability, fueling_requirements, content_capture_opportunity, rest_day_scheduled` |
| Shared context scope | Pass | `userIds=1,1,1,1,1` |

## Harness Fixes Applied

- `src/tools/training-cross-skill-staging-smoke.ts` now initializes the runtime database before loading cross-skill services.
- The same tool now wires the intelligence-bus DB provider before reading runtime mesh context, matching normal server startup so user-scoped Training signals are visible during smoke.
- `src/tools/training-cross-skill-staging-fixtures.ts` provides repeatable seed/status/cleanup for staging-only Finance constraint and Training-to-Content milestone proof.

## Commands

Seed:

```bash
STAGING=true \
NODE_ENV=staging \
TRAINING_CROSS_SKILL_STAGING_SMOKE=1 \
TRAINING_CROSS_SKILL_STAGING_USER_ID=1 \
TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE=1 \
node dist/tools/training-cross-skill-staging-fixtures.js
```

Smoke:

```bash
STAGING=true \
NODE_ENV=staging \
TRAINING_CROSS_SKILL_STAGING_SMOKE=1 \
TRAINING_CROSS_SKILL_STAGING_USER_ID=1 \
TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH=docs/training/final-cross-skill-staging-results-live-seeded.md \
node dist/tools/training-cross-skill-staging-smoke.js
```

Cleanup:

```bash
STAGING=true \
NODE_ENV=staging \
TRAINING_CROSS_SKILL_STAGING_SMOKE=1 \
TRAINING_CROSS_SKILL_STAGING_USER_ID=1 \
TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE=1 \
node dist/tools/training-cross-skill-staging-fixtures.js --cleanup
```

Status:

```bash
STAGING=true \
NODE_ENV=staging \
TRAINING_CROSS_SKILL_STAGING_SMOKE=1 \
TRAINING_CROSS_SKILL_STAGING_USER_ID=1 \
node dist/tools/training-cross-skill-staging-fixtures.js --status
```

## Validation

- `npx tsc --noEmit` passed.
- `npx vitest run __tests__/tools/training-calendar-staging-smoke.test.ts __tests__/tools/training-cross-skill-staging-smoke.test.ts __tests__/tools/training-cross-skill-staging-fixtures.test.ts` passed: 22 tests.
- The staged cross-skill smoke exited `0`.
- The cleanup tool exited `0`.
- The post-cleanup status check confirmed zero staging fixture rows remain.

## Verdict

Cross-skill staging gate: **PASS**.
