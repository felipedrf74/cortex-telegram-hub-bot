# Backend Current Release State

Last updated: 2026-05-04

## Active Production Release

- Source branch: `main`
- Production HEAD: `bc6e963`
- Release source commits:
  - `00a1d23 fix(auth): close beta replay and oauth state gaps`
  - `bc6e963 chore: bump version to 4.14.127 [deploy]`
- iOS main shipped for this QA pass: `50d2fa7 fix(ios): keep home populated after navigation warmup`
- Production version: `4.14.127`
- Official workspace root: `/Users/felipedominguez/Desktop/Nexus Hub`

## Scope

Closed-beta auth hardening and iOS navigation responsiveness:

- closed Apple Sign In nonce replay and mismatch paths
- rejected Telegram OAuth numeric-state callbacks by requiring nonce-backed state
- blocked Google account creation/linking when email verification is not proven
- capped email verification brute-force attempts
- routed auth-sensitive backend and iOS changes through release classifier security gates
- kept iOS tab transitions interaction-first and deferred heavy warmups
- preserved Home fallback card rendering after the first bootstrap attempt so Home does not look blank during navigation

## Validation Before Promotion

- Backend `main` pre-push full validation: passed, 445 files / 6691 tests
- Deploy-time validation: typecheck passed; build passed
- Staging deploy: passed on `4.14.126`
- Generic staging smoke: 17/17 passed before promotion
- Production promote: completed at `4.14.127`
- Production health: content engine OK, status portal OK, bot online, PM2 `nexus-hub` and `content-engine` online
- iOS `main` push: completed at `50d2fa7`
- iOS validation before push: focused Home/navigation tests passed; physical iPhone rapid-tab UI test passed on iPhone Felipe

## Evidence

- Staging smoke evidence:
  - `docs/release/smoke-evidence/staging-smoke-00a1d23-20260504T101706Z.json`
  - `docs/release/smoke-evidence/staging-smoke-00a1d23-20260504T101729Z.json`
  - `docs/release/smoke-evidence/staging-smoke-00a1d23-20260504T101805Z.json`
  - `docs/release/smoke-evidence/staging-smoke-00a1d23-20260504T101841Z.json`
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
