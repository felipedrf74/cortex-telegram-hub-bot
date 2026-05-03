# Backend Current Release State

Last updated: 2026-05-03

## Active Production Release

- Source branch: `main`
- Production HEAD: `9f503a0`
- Release source commit: `3bf9a37 fix(training): harden local coach profile and equipment planning`
- Production version: `4.14.124`
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

## Scope

Training reliability and release-pipeline promotion:

- persisted Training onboarding profile wrapper rows are unwrapped before plan generation
- strength planning supports up to 6 weekly strength sessions where feasible
- weekly session capping removes exact excess instead of over-removing sessions
- no-equipment/bodyweight profiles map to bodyweight-safe prescriptions
- Romanian deadlift aliases are equipment-adapted consistently
- `/api/v1/training/plan/weeks` exposes read-only all-week plan state with sync summaries
- v2 risk-based release pipeline is now on `main` and used for this promotion

## Validation Before Promotion

- `npm run verify`: passed, 432 files / 6565 tests
- Deploy-time full validation: passed, 432 files / 6565 tests
- Build: passed
- Staging deploy: passed on `4.14.123`
- Generic staging smoke: 17/17 passed
- Training cross-skill staging smoke: passed against staging user `24`
- Staging fixture cleanup: verified `activeFixturePlans=0`, `activeFixtureFinanceRows=0`
- Production promote: completed at `4.14.124`
- Production health: content engine OK, status portal OK, bot online, PM2 `nexus-hub` and `content-engine` online

## Evidence

- Generic staging smoke evidence: `docs/release/smoke-evidence/staging-smoke-3bf9a37-20260503T151559Z.json`
- Training cross-skill smoke evidence: `docs/release/smoke-evidence/training-cross-skill-staging-remote-3bf9a37-20260503T151447Z.json`
- Training smoke markdown: `docs/training/cross-skill-staging-smoke-results.md`

## Required Post-Promotion Checks

Production-safe validation still recommended with Felipe, Jaqueline, and nexushubbot:

- readiness/body battery values do not cross users
- Garmin shows connected only for users with real scoped Garmin session material
- Jaqueline's `Entrada` list opens with the same task truth as its list count
- TestFlight Training creation/review confirms the new backend contract renders correctly on device
