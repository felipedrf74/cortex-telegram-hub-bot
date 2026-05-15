# Codex Merge Recommendation

Date: 2026-04-27

## Recommendation

**Merge Codex branch as primary.**

Claude's overhaul should remain as the foundation because most slices are useful and already merged to `main`, but Codex's second-opinion patches should be applied before any further production promotion.

## Why

Claude's branch moved the architecture in the right direction but still had two production-trust gaps:

1. The most visible strength-session bug could be "fixed" by making the duration label truthful while leaving the session thin.
2. The agenda ownership table was not fully used by sync/backfill and did not have a working orphan retry loop.

Codex patched those gaps without replacing useful Claude layers.

## Keep From Claude

| Module | Decision |
|---|---|
| `session-coherence.ts` | Keep as pure validator/estimator. |
| `support-session-builder.ts` | Keep as support-session foundation. |
| `training-plan-lifecycle.ts` | Keep ownership model, with Codex reconciliation additions. |
| `training-history.ts` | Keep real history reads. |
| `availability-day-picker.ts` | Keep. |
| `exercise-metadata.ts` | Keep and expand later. |
| `biomechanics-and-ordering.ts` | Keep with careful product framing. |
| multi-week rotation | Keep as short-term variety improvement. |

## Replace Or Modify From Claude

| Area | Decision | Reason |
|---|---|---|
| Sparse strength-session handling | Modify | Must repair content before shrinking duration. |
| Calendar sync/backfill ownership | Modify | Every linked/created training event needs ownership for cancellation. |
| Orphan handling | Modify | `orphaned` must be a retryable state, not a terminal leak. |
| Final docs claims | Modify | Do not claim full coach intelligence or complete test matrix while TODOs remain. |

## Files To Merge From Codex Branch

- `src/services/coach-kernel/engines/strength-engine.ts`
- `src/services/coach-kernel/session-coherence.ts`
- `src/api/routes/training-plan-calendar-sync.ts`
- `src/api/routes/training-plan-generation.ts`
- `src/services/training-plan-lifecycle.ts`
- `src/services/training-agenda-reconciliation.ts`
- `__tests__/services/coach-kernel-strength-engine.test.ts`
- `__tests__/api/training-plan-calendar-sync.test.ts`
- `__tests__/api/training-plan-generation.test.ts`
- `__tests__/api/training-routes.test.ts`
- `__tests__/services/training-plan-lifecycle.test.ts`
- `__tests__/services/training-agenda-reconciliation.test.ts`
- `docs/training/codex-*.md`

## Merge Conditions

Before merging to `main`:

1. Confirm branch diff excludes unrelated `docs/qa/` untracked files.
2. Run `npm run typecheck`.
3. Run `npm test`.
4. Run a live staging agenda smoke against Google and Outlook.
5. Confirm iOS Training/Home caches clear after cancel/regenerate.

## Rollback

Rollback branch and tag both point at pre-Codex commit `a3f1b78a2dc543f285a14b2bdb9e5d602938d035`:

- Branch: `backup/codex-pre-training-second-opinion-20260427-2246`
- Tag: `backup-codex-pre-training-second-opinion-20260427-2246`

