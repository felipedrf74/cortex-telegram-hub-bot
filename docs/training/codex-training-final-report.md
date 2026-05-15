# Codex Training Final Report

Date: 2026-04-27
Status: Local implementation complete, not deployed, not pushed.

## 1. Executive Summary

Codex performed a second-opinion audit of the Training/Coach engine and Claude's overhaul. Claude's work is valuable but not complete. Codex kept the good architecture and patched the weak production-trust points: sparse high-duration strength sessions now get rebuilt with real catalog-compatible work before duration shrink, and agenda lifecycle ownership now covers sync/backfill plus exact orphan reconciliation.

The branch is ready for local review. It should not be promoted until live staging provider smoke confirms Google/Outlook event creation, cancellation, and regeneration.

## 2. Branch, Tag, And Commit Details

| Item | Value |
|---|---|
| Codex branch | `feature/training-engine-codex-second-opinion` |
| Codex branch base | `a3f1b78a2dc543f285a14b2bdb9e5d602938d035` |
| Rollback branch | `backup/codex-pre-training-second-opinion-20260427-2246` |
| Rollback tag | `backup-codex-pre-training-second-opinion-20260427-2246` |
| Claude reviewed branch | `feature/training-engine-intelligence-and-agenda-overhaul` |
| Claude reviewed tip | `08273a4` |
| Claude merge to main | `384ab52` |
| Current package version | `4.14.99` |

## 3. Root Causes Found

| Failure | Root cause | Codex fix |
|---|---|---|
| Low volume + high reported time | Validator detected underfill but caller could satisfy it by shrinking duration instead of improving content. | `repairUnderfilledStrengthSession` adds movement-pattern coverage and densifies sets before accepting a duration correction. |
| Weak strength variety | Claude reduced repetition with rotations, but no full split-role planner exists. | Kept Claude foundation and documented split planner as open instead of faking intelligence. |
| Agenda lifecycle failure | Ownership table existed but sync/backfill did not consistently record/relink ownership, and orphaned rows had no exact retry path. | Added ownership recording/relinking in sync and a precise orphan reconciliation service. |

## 4. Baseline Audit Summary

The pre-Claude engine had real product value but relied too much on template flow. The biggest baseline risks were independent duration/content decisions, shallow variation, weak profile normalization, thin catalog metadata, synthetic metrics use, and no robust agenda ownership lifecycle.

## 5. Claude Audit Summary

Claude correctly identified the right architectural areas and shipped useful modules. The work was not rubber-stamped. Codex found overclaims in the final report and two important correctness gaps: sparse-session repair and orphan agenda reconciliation.

See `docs/training/codex-review-of-claude-training-work.md`.

## 6. Architecture Changes Made By Codex

| Area | Files |
|---|---|
| Strength sparse-session repair | `src/services/coach-kernel/engines/strength-engine.ts`, `src/services/coach-kernel/session-coherence.ts` |
| Calendar sync ownership recording and relinking | `src/api/routes/training-plan-calendar-sync.ts` |
| Orphan agenda event retry queue | `src/services/training-plan-lifecycle.ts`, `src/services/training-agenda-reconciliation.ts` |
| Pre-persist saga reconciliation | `src/api/routes/training-plan-generation.ts` |
| Tests and route harness updates | `__tests__/services/coach-kernel-strength-engine.test.ts`, `__tests__/api/training-plan-calendar-sync.test.ts`, `__tests__/services/training-plan-lifecycle.test.ts`, `__tests__/services/training-agenda-reconciliation.test.ts`, `__tests__/api/training-plan-generation.test.ts`, `__tests__/api/training-routes.test.ts` |

## 7. Data Model, Contract, And Lifecycle Changes

- No external iOS contract break.
- No migration added in Codex pass.
- Existing lifecycle rows with `status='orphaned'` can now be reconciled to `deleted`.
- Sync can relink sessions from active ownership and avoid duplicate event creation.
- Calendar sync records ownership for created, matched, and verified existing events.

## 8. Agenda / Calendar Sync Changes

Codex added a precise ownership path:

1. If a session lost its local `calendarEventId` but has active ownership, relink it.
2. If sync finds a matching provider event, record ownership before marking it linked.
3. If sync creates a new event, record ownership immediately.
4. If cancellation leaves provider deletes failed, keep exact orphan rows.
5. Retry exact orphan deletes by `calendar_event_id` and `calendar_source`, never broad date-range deletion.

## 9. Tests Added Or Improved

Focused suite:

```bash
npx vitest run __tests__/services/coach-kernel-strength-engine.test.ts \
  __tests__/api/training-plan-calendar-sync.test.ts \
  __tests__/services/training-plan-lifecycle.test.ts \
  __tests__/services/training-agenda-reconciliation.test.ts \
  __tests__/api/training-plan-generation.test.ts
```

Result: 5 files, 58 tests passed.

Full validation:

```bash
npm run typecheck
npm test
```

Result: typecheck passed; 369 files and 5,882 tests passed.

## 10. Local Validation Results

| Validation | Result |
|---|---|
| Generate plan route regression | Covered by `training-routes.test.ts` and generation tests. |
| Agenda creation ownership | Covered by calendar sync tests. |
| Cancel/replacement orphan cleanup | Covered by lifecycle and reconciliation tests. |
| Sparse high-duration gym session | Covered by strength-engine regression test. |
| Decision trail duplicates | Not directly changed; remains open. |
| Live Google/Outlook provider behavior | Not executed in this pass because user explicitly said no deploy/push. Required before release. |

## 11. Claude Review Verdict

| Category | Verdict |
|---|---|
| What was good | Correct direction: typed coherence, metadata, ownership, saga, history reads, day availability, biomechanics/order. |
| What was weak | Overclaimed completion, sparse session repair was shallow, agenda sync/backfill ownership incomplete, orphan retry missing. |
| What was rejected | Treating duration shrink alone as adequate coach-quality fix. Treating `orphaned` ownership as effectively handled without a retry path. |
| What was retained | Most Claude modules, with Codex patches layered on top. |

## 12. Final Merge Recommendation

Merge Codex branch as primary after review. This is a selective combination: Claude's foundation stays, Codex corrections close the gaps.

## 13. Remaining Open Issues

See `docs/training/codex-training-open-items.md`.

Highest priority:

1. Live provider agenda smoke on staging.
2. Background orphan reconciliation job.
3. iOS cache invalidation after plan cancel/regenerate.
4. Normalized athlete profile layer.
5. True split and periodization planner.
6. Endurance-specific coherence validation.
7. Decision-trail dedupe.

## 14. Rollback Notes

To return to pre-Codex state:

```bash
git checkout feature/training-engine-codex-second-opinion
git reset --hard backup-codex-pre-training-second-opinion-20260427-2246
```

No production rollback is needed because this branch was not deployed or pushed.

