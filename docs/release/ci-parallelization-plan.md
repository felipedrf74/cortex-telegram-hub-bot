# CI Parallelization Plan

Date: 2026-05-01

## Current Backend CI Shape

`.github/workflows/ci.yml` runs:

1. lint/typecheck;
2. tests after lint;
3. build after tests;
4. Python compile after lint;
5. migration check after lint.

This is safe but serializes test and build behind typecheck. It also runs a full coverage test command for every PR into `main`/`develop`, regardless of changed files.

## Recommended Backend CI Shape

| Job | Parallelization | Notes |
| --- | --- | --- |
| install/cache | shared setup or per-job cache | Keep npm cache; avoid shared workspace mutation. |
| typecheck | parallel with focused tests? | Can run independently after install. |
| focused-tests | parallel | Use changed-file classifier to select domain tests. |
| migration-check | parallel | No runtime services needed. |
| python-compile | conditional parallel | Only when `content-engine/**` changed, otherwise nightly. |
| build | parallel after typecheck or with typecheck | Build can fail independently; no need to wait for full test suite. |
| full-verify | nightly/RC | Keep out of every small PR unless high-risk shared code changed. |

## iOS CI Shape

Current iOS workflow runs only config hardening. Add a second workflow lane later:

- docs/config-only: `scripts/ios-release-hardening-validate.sh`;
- iOS source changed: focused xcodebuild tests by changed area;
- RC/nightly: full `Nexus HubTests`;
- UI tests: single simulator UDID, no parallel destinations.

## Unsafe Parallelism

Do not parallelize:

- multiple iOS UI test destinations on the same local machine;
- provider staging smokes using the same calendar account;
- smoke scripts sharing the same SQLite DB path;
- scripts that mutate PM2 staging services;
- production deploy/promote steps.

## Safe Parallelism

Safe to parallelize:

- backend typecheck, migration check, Python compile, focused Vitest;
- independent pure unit-test shards using in-memory DBs;
- static doc/lint checks;
- iOS unit tests and backend tests in separate repos when simulator count is controlled.
