# Cooking + Training Next-Task Execution

Date: 2026-05-01

## Selected Task

Selected task: P2 release evidence/doc drift.

Reason: Current validation found no safe P0/P1 code issue in Cooking or Training. The next highest-priority safe task was preventing release confusion by updating stale Cooking evidence and creating consolidated Cooking/Training readiness docs.

## Reproduction / Evidence

- `docs/cooking/cooking-final-report.md` still said full `npm run verify` passed `427 files / 6398 tests`.
- Current branch evidence from commit `c8dca78` and this pass says full backend verify passed `429 files / 6426 tests`.
- The same file described the portal runtime smoke before the forged-tenant stale-data clear was added.
- The requested consolidated release docs under `docs/release/cooking-training-*` did not exist.

## Implementation

Files created/updated:

- `docs/cooking/cooking-final-report.md`
- `docs/release/cooking-training-readiness-summary.md`
- `docs/release/cooking-training-open-items.md`
- `docs/release/cooking-training-next-task-execution.md`
- `docs/release/cooking-training-main-prod-go-no-go.md`

No product code changed in this task.

## Validation Before Docs

| Check | Result |
| --- | --- |
| Cooking backend typecheck | PASS |
| Cooking focused backend tests | PASS, 6 files / 61 tests |
| Cooking full backend verify | PASS in pre-commit for `c8dca78`, 429 files / 6426 tests |
| Training iOS build-for-testing | PASS |
| Training focused iOS tests | PASS, 59 unit + 4 UI tests |
| Cooking iOS focused tests | PASS, 13 tests |

## Validation After Docs

- `git diff --check`: PASS.
- Ports `8200` and `8326`: clear.
- Simulators: `xcrun simctl shutdown all` run; no booted devices remain.
- DB files: no `cooking-*.db` files remain.
- Runtime retest: not required for docs-only edits.

## Not Selected

- Cooking substitution apply workflow: P2 product feature, not a release-safety fix.
- Portal deep recipe/meal-plan/grocery editors: P2 product feature.
- Training provider-backed calendar smoke: requires non-production external provider credentials and should run on the exact RC/staging environment, not as a local code patch.
- Signed TestFlight/device smoke: requires physical/device distribution context, not a local code patch.
