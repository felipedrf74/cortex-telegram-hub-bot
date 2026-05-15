# Codex Review Of Claude Training Work

Date: 2026-04-27
Reviewer: Codex
Reviewed range: `f09383c` through `08273a4`, merged to `main` by `384ab52` and documented at `a3f1b78`.

## Executive Verdict

Claude's work is directionally useful and should not be thrown away. It added important foundations: a session coherence validator, support-session builder, plan/event ownership table, cancellation saga, metrics history reads, variant rotation, availability-aware day picking, richer exercise metadata, and biomechanics ordering.

But it overclaimed completion. The most important issue: the sparse 48-minute strength-session failure was not actually fixed at engine level. The validator could detect an underfilled session, but the strength engine mostly responded by shrinking the duration label while leaving the session thin. That is safer than lying, but it is not a real coach-quality repair.

## Classification By Slice

| Slice | Codex verdict | Reason |
|---|---|---|
| 4.A SessionCoherenceValidator | KEEP WITH MODIFICATIONS | Good pure estimator/validator foundation, but original caller did not rebuild sparse sessions. Codex added catalog-aware repair in `strength-engine.ts`. |
| 4.B Support-session builder | KEEP WITH NOTES | Better than hardcoded support strings. Still static and not a full split model. |
| 4.D Lifecycle ownership | KEEP WITH MODIFICATIONS | Ownership table is the right shape. Sync/backfill paths did not always record or relink ownership. Codex patched `training-plan-calendar-sync.ts`. |
| 4.D.2 Cancellation saga | KEEP WITH MODIFICATIONS | Correct instinct to stop silent corruption. Missing a real orphan retry path. Codex added `training-agenda-reconciliation.ts` and saga calls. |
| 4.E Metrics history reads | KEEP | Real completion history is materially better than synthetic context. Still needs richer feedback modeling later. |
| 4.C Multi-week rotation | KEEP WITH NOTES | Reduces obvious repetition. Not yet a complete progression/split intelligence layer. |
| 4.F Availability-aware day picks | KEEP | Generalizable and directly addresses schedule nuance. |
| 4.G Catalog metadata | KEEP | Useful foundation for biomechanics/substitution. Catalog depth is still incomplete. |
| 4.H Biomechanics substitution/order | KEEP WITH NOTES | Useful safety and order layer. It is not a medical or deep biomechanics engine yet, and should not be presented as one. |

## Strong Parts

- `src/services/coach-kernel/session-coherence.ts` introduced a testable estimator/validator instead of more prose-only heuristics.
- `src/services/training-plan-lifecycle.ts` and migration 081 established stable plan/session/event ownership, which is the correct lifecycle direction.
- `src/services/training-history.ts` moved metrics history from synthetic claims to real completion reads.
- `src/services/coach-kernel/exercise-metadata.ts` and `biomechanics-and-ordering.ts` created a reusable metadata path for pain-aware substitutions and exercise ordering.
- The test count and focused test files are materially better than before.

## Weak Or Flawed Parts

| Finding | Evidence | Impact | Codex action |
|---|---|---|---|
| 4.A overclaimed root-cause fix | `strength-engine.ts` used validator correction but did not add enough real work before shrinking duration. | A 48-minute "session" could become a truthful shorter session, but not a credible 45-50 minute workout. | Added `repairUnderfilledStrengthSession` and sparse-session regression test. |
| Agenda sync/backfill lifecycle gap | `training-plan-calendar-sync.ts` could link or create events without ownership rows. | Backfilled calendar events could be invisible to later cancellation/replacement cleanup. | Added ownership recording and relinking across verified, matched, and created events. |
| Orphaned event rows were not a real retry queue | `markCalendarOwnershipDeleted` only updated active rows; status `orphaned` could not transition to `deleted`. | Failed provider deletes could stay permanently orphaned. | Allowed orphaned -> deleted and added precise reconciler service. |
| Docs overclaimed completion | `docs/training/training-engine-final-report.md` says overhaul complete and prod unchanged at 4.14.97, while main is 4.14.99 and `training-engine-test-matrix.md` still has TODO rows. | Release narrative can mislead operators about what was fully proven. | Documented the mismatch here and in open items. |
| Variety remains partly static | Variant rotation is table-driven and useful, but not a full goal/profile/split generator. | Advanced users can still outgrow the planner. | Left as explicit open item; did not fake full intelligence. |

## Security And Lifecycle Review

No tenant-leak regression was found in Claude's ownership approach. Ownership rows are user-scoped and keyed by plan/session/event. The main lifecycle weakness was not tenant isolation; it was incomplete use of the ownership table by sync/backfill and missing retry reconciliation.

## Test Quality Review

Claude's tests are not shallow overall, but some tests pin helper behavior rather than end-to-end product invariants. The most important missing tests were:

- Sparse high-duration session must become content-coherent, not merely relabeled.
- Calendar sync relinks from ownership without duplicate create.
- Orphaned external events can be retried and marked deleted.
- Route-level plan generation harness mocks reconciliation so future route tests stay honest.

Codex added those tests.

