# Duplicate, Novelty, And Reuse Test Matrix

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Automated Tests

Command:

```bash
npm test -- --run __tests__/services/content-novelty-reuse.test.ts
```

Result:

- PASS: 1 file / 8 tests.

## Coverage Matrix

| Scenario | Test Status | Evidence |
|---|---:|---|
| Duplicate idea detection | Passed | Exact duplicate idea returns `duplicate` with high duplication risk. |
| Near-duplicate hook detection | Passed | Similar hook wording returns `near_duplicate` and reason `near_duplicate_hook`. |
| Intentional repurpose allowed | Passed | YouTube long-form to Shorts returns `allowed_reuse` and records `content_repurpose_history`. |
| Unauthorized tenant content excluded | Passed | Tenant A does not match Tenant B's content even with identical title/topic. |
| Repeated stale radar signal suppressed | Passed | Same scoped radar signal returns `stale_repetition`. |
| Successful content pattern reused with new angle | Passed | Explicit successful-pattern variation returns `allowed_reuse`. |
| Content series allows related ideas | Passed | Same series with new angle returns `series_related`, not duplicate. |
| Overused reference warning | Passed | Fourth use of same scoped reference emits `overused_reference`. |

## Additional Validation Planned

| Scenario | Status | Notes |
|---|---:|---|
| Full Content service slice | Pending | Run before release candidate. |
| Route-level artifact write-through | Pending | Artifact creation routes need consistent `recordContentNoveltyCandidate()` calls. |
| Generation prompt behavior with novelty constraints | Partially covered | `content-generation-quality` tests should be included in broader slice. |
| iOS rendering of duplicate/reuse warnings | Pending | Requires DTO and UI work. |
| Portal editorial review of reuse lineage | Pending | Requires portal policy and UI work. |
| Legacy artifact backfill | Pending | Needs migration/backfill plan with quarantine for ambiguous records. |

## Release Gate

Backend foundation verdict: PASS WITH CONDITIONS.

This closes the deterministic novelty/reuse foundation, but not the full product release gate.
