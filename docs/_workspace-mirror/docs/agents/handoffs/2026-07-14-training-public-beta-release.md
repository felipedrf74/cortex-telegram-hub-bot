# Training Public Beta Release Candidate Handoff

## Session summary
Date: 2026-07-14 · Agent: Codex · status: source commits complete; nothing pushed, deployed, activated, or uploaded.
Branches: backend `codex/training-full-beta-release-20260714` at `fff8cd8e`; iOS `codex/training-exercise-media-ios-activation-20260714` at `58069db`.

## Ready locally
- Backend 4.14.218 adds authoritative all-calendar M4 capacity snapshots/migration 231, fail-closed public-beta gates, Decision revalidation, immutable revision protection, and legacy-writer guards.
- iOS build 55 / 1.5.0 enables the full Training revision, phase, typed-workout, adaptation, M4, and governed-media experience in signed Release while keeping fixtures DEBUG-only.
- Media approval is bound to package `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb`, release subject `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`, and `https://media.nexushub.me`.

## Verification and QA
- Backend: the commit-enforced final gate passed 928/928 files and 13,510/13,510 tests, migration safety for 222 migrations, typecheck, and build.
- iOS: 90/90 release-scope units, 4/4 M4/media UI, post-review 5/5 focused units, and final affected UI 1/1 passed; fresh Release build passed with 0 QA/prototype markers, 0 bundled Training PNGs, and 0 Training asset names.
- Independent backend verdict READY; independent iOS static verdict READY after all localization/accessibility findings were remediated.

## Verifiable Reward Summary
- Verdict/run: MANUAL_REQUIRED, score 88, run `a386b9ed-b45c-4080-a0a1-b9e7895604d0`; all local mandatory checks passed with no hard failure, while staging/provider/APNs/production/TestFlight/device evidence remains pending.
- Claim level: L2 local code/build/test evidence only; deployment, TestFlight, and physical-device proof remain separately gated.
- Evidence commands: `npm run typecheck`, `npm run build`, focused `vitest`, migration safety, `npm run docs:audit`, Swift parse/plutil, `scripts/ios-single-simulator-test.sh`, and fresh Release `xcodebuild`/isolation scans.
- Skipped checks: no local backend or iOS release-candidate check remains skipped; staging, provider/APNs, production health, TestFlight, and device proof remain mandatory operator evidence.

## Release limits and next actions
- Felipe authorized production/TestFlight sequencing, exact media activation, and backed-up/audited deletion of existing Training plans; the mandatory exact commit-plan confirmation is still required before the first commit.
1. Confirm the exact backend, iOS, and docs commit plan; then commit and push using free/local Git paths.
2. Deploy 4.14.218 to staging, apply migration 231, enable the exact bundle, and pass Training/calendar/APNs/media smoke.
3. Back up and purge authorized Training state, promote production, push iOS main, upload build 55, device-smoke, then expire build 54.
