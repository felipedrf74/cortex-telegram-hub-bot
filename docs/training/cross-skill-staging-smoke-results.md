# Training Cross-Skill Staging Smoke Results

Last updated: 2026-05-03

## Production Promotion Evidence

- Release source commit: `3bf9a37 fix(training): harden local coach profile and equipment planning`
- Production deploy commit: `9f503a0 chore: bump version to 4.14.124 [deploy]`
- Staging host/version during smoke: `4.14.123`
- Staging test user: `24`
- Fixture/provider mode: staging test fixtures only; no production data or production calendars
- Evidence JSON: `docs/release/smoke-evidence/training-cross-skill-staging-remote-3bf9a37-20260503T151447Z.json`

## Local Attempt

The first local invocation was intentionally treated as blocked because local shell prerequisites were not configured for staging DB access:

- Missing `STAGING=true` or `NODE_ENV=staging`
- Missing `TRAINING_CROSS_SKILL_STAGING_SMOKE=1`
- Missing `TRAINING_CROSS_SKILL_STAGING_USER_ID`
- Missing `DATABASE_PATH`

Blocked evidence is retained at:

- `docs/release/smoke-evidence/training-cross-skill-staging-3bf9a37-20260503T150605Z.json`

## Remote Staging Runtime Smoke

The smoke was rerun on the staging host with staging DB access and `TRAINING_CROSS_SKILL_STAGING_USER_ID=24`.

| Flow | Result | Evidence |
| --- | --- | --- |
| Prerequisites | PASS | staging-mode process, staging DB, and isolated staging user configured |
| Local fixture contracts | PASS | Secretary, Cooking, Finance, Content, and signal-prompt fixture contracts passed |
| Secretary conflict | PASS | staging Secretary context exposed schedule pressure and Training produced reflow/modular guidance |
| Cooking fueling gap | PASS | Cooking meal/fueling signals were visible and deduped for Training constraints |
| Finance budget constraint | PASS | Finance affordability/spend posture constrained paid equipment and supplement pressure |
| Content workload | PASS | Content workload/filming signal was visible as schedule friction |
| Training content milestone | PASS | `content_capture_opportunity` was exposed as a user-scoped Training mesh signal |
| Shared context scope | PASS | all peer contexts were scoped to staging user `24`; no unrelated tenant/user data appeared |

## Cleanup

Staging fixture cleanup was verified after the remote smoke:

- `financeRowsRemoved: 4`
- `planIdsRemoved: [4]`
- `activeFixturePlans: 0`
- `activeFixtureFinanceRows: 0`

## Interpretation

All requested Training cross-skill staging runtime flows passed after running the smoke in the correct staging context. The earlier local blocked evidence remains useful because it documents why the smoke must run with staging DB prerequisites rather than from an unconfigured local shell.
