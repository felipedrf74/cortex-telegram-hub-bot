# Streamlined Release Process V2

Date: 2026-05-01

## 1. Change Classification

Run:

```bash
git status --short
git diff --name-only origin/main...HEAD
scripts/release-identity.sh markdown
```

Classify changed areas using `risk-based-release-gate-matrix.md`.

## 2. Focused Local Validation

Run only required focused checks:

- backend source: typecheck + focused Vitest;
- iOS source: focused XCTest/XCUITest on one UDID;
- portal: route tests + browser smoke;
- calendar/provider: lifecycle/idempotency tests;
- docs-only: doc sanity only.

## 3. Risk-Based CI

CI runs:

- changed-area focused jobs;
- migration check if migrations changed;
- iOS tests if iOS changed;
- full verify only for shared/high-risk/RC/nightly.

## 4. RC Identity Lock

Create one release identity artifact:

- backend branch/SHA/version/migration count;
- iOS branch/SHA/build number if applicable;
- dirty state;
- test artifact paths.

## 5. Staging Deploy And Focused Smoke

Deploy exact RC to staging.

Run generic staging health plus changed-domain smoke:

- Cooking smoke only for Cooking changes;
- Training/provider smoke only for Training/calendar changes;
- portal smoke only for portal changes;
- tenant smoke for auth/data/retrieval/admin changes.

## 6. Production Preflight

- DB snapshot decision;
- migration rollback caveats;
- monitoring plan;
- rollback command;
- owner approval.

## 7. Production Deploy

Use `promote-to-prod.sh`. Do not skip smoke unless owner explicitly approves.

## 8. Postdeploy

- production health;
- safe test tenant/user smoke;
- monitor tenant/security/provider/calendar/model-routing error signals;
- preserve rollback window.

## 9. Retro And Docs

Update one current release summary.

Move detailed reports to historical references after release. Do not copy verdicts into multiple active docs.
