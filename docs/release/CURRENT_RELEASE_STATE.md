# Backend Current Release State

Last updated: 2026-05-04

## Active Production Release

- Source branch: `main`
- Production HEAD: `cf1e5de`
- Release source commits:
  - `0fdbaa4 fix(beta): harden content identity gates for closed beta`
  - `6b72619 test(training): make same-day schedule route deterministic`
  - `cf1e5de chore: bump version to 4.14.126 [deploy]`
- iOS main shipped for this QA pass: `f327942 fix(ios): isolate training fixtures for closed beta QA`
- Production version: `4.14.126`
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

## Scope

Closed-beta identity, content-personalization, and iOS fixture-isolation hardening:

- removed founder-shaped defaults from Content Creation agent prompts, topic workflow, caption writer, orchestrator, Reddit search, and gap-finder paths
- extended the closed-beta identity scanner with broader founder/ideology/content-niche leak patterns
- promoted the closed-beta identity scan to a strict PR gate
- added content-agent neutrality and classifier regression coverage
- fixed the Training same-day route test so it is deterministic under the current same-day scheduling floor
- isolated iOS Training local-smoke fixture bootstrap from real account/session, subscription, task, dashboard, and HealthKit warmups
- added stable iOS accessibility identifiers for Skills and Training fixture workflows used in closed-beta QA

## Validation Before Promotion

- Backend `main` pre-push full validation: passed, 442 files / 6675 tests
- Deploy-time validation: typecheck passed; build passed
- Staging deploy: passed on `4.14.125`
- Generic staging smoke: 17/17 passed before promotion
- Production promote: completed at `4.14.126`
- Production health: content engine OK, status portal OK, bot online, PM2 `nexus-hub` and `content-engine` online
- iOS `main` push: completed at `f327942`
- iOS physical-device validation before push: build-for-testing passed on iPhone Felipe, `TrainingFixtureBypassUITests` passed 11/11, focused unit/cache/security suite passed with one expected device-sandbox skip

## Evidence

- Staging smoke evidence:
  - `docs/release/smoke-evidence/staging-smoke-6b72619-20260504T081941Z.json`
  - `docs/release/smoke-evidence/staging-smoke-6b72619-20260504T082011Z.json`
  - `docs/release/smoke-evidence/staging-smoke-6b72619-20260504T082156Z.json`
  - `docs/release/smoke-evidence/staging-smoke-6b72619-20260504T082234Z.json`
- Backend QA report: `docs/qa/QA_BACKEND_REPORT.md`
- iOS QA report: `/Users/felipedominguez/Desktop/Nexus Hub/ios/docs/qa/QA_IOS_REPORT.md`
- Release gate report: `docs/qa/QA_RELEASE_GATE_REPORT.md`
- Closed-beta runbook: `docs/release/closed-beta-runbook.md`
- Portal scope policy: `docs/release/portal-scope-policy.md`

## Required Post-Promotion Checks

Production-safe validation still recommended with Felipe, Jaqueline, and nexushubbot:

- readiness/body battery values do not cross users after cold start or tab switching
- Garmin shows connected only for users with real scoped Garmin session material
- Jaqueline's `Entrada` list opens with the same task truth as its list count
- TestFlight Training creation/review confirms the latest backend contract renders correctly on device
- Content Creation beta smoke confirms no founder/operator niche defaults appear for non-founder accounts
