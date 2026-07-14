# Training Public Beta Release Handoff

## Release state

Date: 2026-07-14 · Agent: Codex · status: backend and governed media are live in production; iOS build 55 is available to internal and external TestFlight groups; physical-device smoke remains open.

- Backend `main`, staging, and production: `6a2811bcb65184ee2939f6db9de97cfb166c3433` (`4.14.218`).
- Backend release branch: `codex/training-full-beta-release-20260714` at the same commit.
- iOS `origin/main`: `58069db585ff5e69253ba33051dc779ce19703bf`, version `1.5.0` build `55`.
- TestFlight build 55 status: `Testing`, assigned to internal `Nexus Hub Betinha` and external `Betinhas`. App Store Connect showed zero build-55 installs at the final check, so build 54 remains active.

## Production scope

- M4 authoritative capacity snapshots, immutable plan revisions, phase-aware plans, typed workouts, adaptations, substitutions, Decision revalidation, conflict protection, and legacy-writer guards are deployed.
- The final compatibility fix preserves legacy-shaped allowlisted continuous-strength plans unless the request contains a complete M4-owned contract. Partial M4 requests still fail closed.
- The public-beta Training flags are globally active with no scoped overrides.
- Governed exercise media is active for the approved 158-exercise catalog and 200 selected mappings at `https://media.nexushub.me`.
- Media activation is bound to package `51c1089cceb8a916abf200b5cb3688b19f5f7553990467ee0f8ef01c7c4f74bb` and release subject `27b97ebc96e1b3bb1ee3612e63c5609b5572c9d4b58e59b8ea3e77642fb1cea3`.

## Verification evidence

- Owner authorization: Felipe authorized the backend/iOS commit plan, production promotion, exact governed-media activation, TestFlight distribution, and safe release-artifact cleanup. Build 54 expiry remains conditioned on a real build-55 device smoke.
- Final-source compatibility fix: 45 focused tests, 2,306 Training tests, 2,988 changed-area tests, and TypeScript checks passed. The immediately preceding release tree had passed the complete 13,512-test gate; Felipe explicitly approved moving forward without repeating that unchanged full layer.
- Staging: exact artifact digest `503b2e5072b6e7e78eb7a9a614aa77726db4fff4e2ac08e4b3d85f19f62ec2ed`; readiness and generic smoke passed. Owner-scoped Training flag parity was established before promotion.
- Production: health/readiness, SQLite integrity, PM2 identity, artifact parity, and global flag resolution passed on `4.14.218` at the full commit above.
- Production Training smoke passed through both loopback and `https://api.nexushub.me/api/v1`: owner/non-owner authorization, 28 plan combinations, four adaptation scopes, all three supported locales, media byte/checksum/cache checks, unknown fallback, ETags, and non-owner visibility.
- Owner write smoke passed: provider-unavailable fallback was honest, and the generated fixture exercised three phases, four weeks, busy/tired options, substitution, and immutable activation.
- iOS Release isolation remained intact: Phase 0 fixtures and prototype media are not bundled. Build 55 contains the production Training UI and points at the approved media origin.
- Independent code/operator reviews returned GO for the compatibility fix, activation operator, and owner write-smoke request shaping.

## Claim and limits

- Claim: **L5** for the backend production runtime and governed-media activation; **L4** for TestFlight distribution of iOS build 55.
- Limits: no physical build-55 install/open smoke is claimed, build 54 is not expired, and no destructive deletion of immutable revision-owned state was performed.

## Operational notes

- Promotion used the audited duplicate-full-suite skip only after the parent full gate and final focused/changed-area gates were green; staging smoke was not skipped.
- Production backup: `/home/dominguez/backups/nexushub/v4.14.218_20260714_183442.tar.gz`.
- Pre-activation env backup: `/home/dominguez/backups/nexushub/training-public-beta-flags/.env.before-global-20260714173908779`.
- The owner write smoke left one owner-only immutable revision plan (four weeks / 28 sessions). The canonical reset operator correctly refused to bypass revision ownership. No supported revision-cancellation contract exists, so the row was not deleted manually.
- Cross-skill smoke passed for Secretary, Cooking, Content workload, and shared scope. Finance constraint coverage and an active content-capture opportunity were unavailable fixture-data conditions, not Training regressions.
- Production Sentry DSN remains unset; production error reporting therefore uses local logs. This is a known platform observability gap, not a Training release blocker.

## Remaining gate

1. Install TestFlight build 55 on an owner/beta device and smoke Skills → Training, plan review, workout detail/media, and one adaptation proposal.
2. Confirm the device is on build 55 and no P0/P1 regression is observed.
3. Only then expire build 54. Build 54 must remain available until this evidence exists.

## Verifiable Reward Summary

- Verdict: PASS; score 100; run `b8801ed4-aaf1-44e6-8072-64a400562b07`.
- Area: release.
- Changed-area classifier: documentation-only closeout; no source/test/config/deploy files changed after the production commit.
- Hard failures: none observed.
- Mandatory checks: changed-area classifier and docs audit passed; release identity, staging smoke, production health, and owner authorization are recorded above.
- Skipped checks and reasons: none in the verifier. Build-55 physical-device smoke remains an explicitly unclaimed product-acceptance gate, and build 54 expiry is intentionally deferred.
- Evidence commands: `scripts/changed-area-classifier.sh --json`, `npm run docs:audit`, release smoke operators, production `/health`, PM2 identity, and TestFlight status inspection.
- Evidence artifacts: exact backend/iOS commits, release artifact digest, production/env backups, active media package/release subject, and App Store Connect build/group state recorded above.
- Export eligibility: ineligible pending manual human review; no raw production data is included.
- Prompt/process improvement: keep M4 selection bound to immutable M4 ownership rather than allowlist membership alone, and retain the compatibility regression tests.
