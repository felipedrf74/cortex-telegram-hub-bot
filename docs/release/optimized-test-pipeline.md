# Optimized Test Pipeline

Date: 2026-05-01

## Recommended Lanes

| Lane | Runs | Purpose | Typical commands |
| --- | --- | --- | --- |
| Pre-commit local | Changed files only | Fast feedback before commit | Focused Vitest/XCTest, `git diff --check`, typecheck for source changes |
| PR risk-based CI | Changed area matrix | Merge confidence | Backend typecheck, focused tests, migration check, iOS focused tests if iOS changed |
| Nightly regression | Broad product regression | Catch slow/deep regressions off the critical path | Full backend verify, full iOS suite, eval harnesses, static security sweeps |
| Release candidate | Exact artifact confidence | Lock identity and run broad enough checks | Full backend verify once, iOS full suite once if iOS included, release identity |
| Staging | Deployed artifact confidence | Prove deployed exact RC | `deploy-staging.sh`, generic staging smoke, changed-domain smoke |
| Production | Safe promotion | Owner-approved deploy and health | DB snapshot decision, `promote-to-prod.sh`, production health, monitoring |

## Backend Pipeline

Run in parallel where possible:

- `npx tsc --noEmit`
- focused `npx vitest run <changed-domain-files>`
- migration sequence/syntax check
- Python content-engine compile if content-engine changed
- portal browser smoke only if portal/UI routes changed

Run `npm run verify`:

- before release candidate lock;
- after source/test/package/migration changes that affect shared behavior;
- nightly;
- not after docs-only edits.

## iOS Pipeline

Use explicit simulator UDID for all simulator tests:

```bash
xcodebuild test \
  -project "Nexus Hub.xcodeproj" \
  -scheme "Nexus Hub" \
  -destination "id=$SELECTED_UDID" \
  -parallel-testing-enabled NO \
  -maximum-concurrent-test-simulator-destinations 1 \
  -only-testing:"Nexus HubTests/<FocusedTests>"
```

Run full iOS tests:

- on iOS release candidate;
- after shared model/decoder/cache/navigation changes;
- nightly;
- not for backend-only or docs-only changes.

## Smoke Pipeline

- Local full-product smoke validates fixture/runtime integration before staging.
- Staging smoke validates the deployed artifact and environment.
- Provider smoke validates real provider behavior only when provider/calendar/model-routing paths changed.
- TestFlight/device smoke validates native capabilities only when shipping iOS release candidates or native/auth/Health/APNs/account changes.
