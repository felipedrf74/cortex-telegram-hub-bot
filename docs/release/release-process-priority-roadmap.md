# Release Process Priority Roadmap

Date: 2026-05-01

## One-Day Fixes

1. Use `scripts/release-identity.sh` in every current release summary.
2. Add a current-release index template that links active evidence and marks historical reports.
3. Stop requiring `npm run verify` after docs-only commits.
4. Require explicit simulator UDID in every iOS release prompt/checklist.
5. Add skipped-check reason field to release docs.

## One-Week Improvements

1. Build changed-file risk classifier for backend and iOS.
2. Add CI matrix that runs focused backend/iOS/portal jobs by changed area.
3. Add structured JSON artifact output to staging and local smoke scripts.
4. Add local service cleanup checker.
5. Add iOS single-simulator wrapper script.
6. Add stale-doc SHA checker for active release docs.

## Deeper Release Platform Work

1. Build a release dashboard that reads identity, test artifacts, smoke artifacts, and blockers.
2. Shard backend tests by domain with fixture-isolated DBs.
3. Add automated portal interaction smokes for each portal domain.
4. Add provider smoke sandbox accounts with deterministic cleanup.
5. Add TestFlight/device smoke checklist capture with artifact upload.

## Top 10 Quick Wins

1. Generate RC identity instead of typing it.
2. Docs-only release class skips full verify.
3. UDID-only simulator test standard.
4. Local service cleanup preflight.
5. Staging smoke JSON artifacts.
6. Current-release index.
7. Changed-file risk classifier.
8. CI parallel typecheck/test/build/migration jobs.
9. Provider smoke only when provider/calendar candidate changed.
10. Historical doc marker to stop reopening superseded findings.
