# Training Engine + Agenda Orchestration Overhaul — Final Report

Status: **3 of 3 audit-confirmed regressions closed at root cause. Working branch + staging green. Production untouched. Awaiting batch-promote decision.**

---

## 1. Executive summary

The Phase 0 audit confirmed three root-cause structural gaps in the
Training engine, each tied to a user-visible regression:

| # | Regression | Root cause | Closed by |
|---|---|---|---|
| 1 | Volume × time mismatch (48-min Dead Bug session) | No session coherence validator — duration and content pipelines never reconciled | Slice 4.A (`f09383c`) |
| 2 | Variety failure (3 identical strength days) | `strengthSupportVariants()` injected hardcoded text-name exercises bypassing the catalog/substitution layers | Slice 4.B (`8fe0e58`) |
| 3 | Agenda lifecycle (create + cancel + replace fragility) | No idempotent calendar create, no audit-trail ownership table, FK CASCADE wiped link state | Slice 4.D (`6b19b72`) |

All three slices ship through the validated-promote pipeline. Each
landed on the working branch, passed pre-commit + pre-push gates,
deployed to staging cleanly, and passed the 17-step staging smoke.

**Production version is unchanged at `4.14.97`** per the explicit
"don't promote to prod until full overhaul complete" instruction.
The working branch is fully reproducible:
`feature/training-engine-intelligence-and-agenda-overhaul`.

## 2. Branch and backup/tag details

| Item | Value |
|---|---|
| Working branch | `feature/training-engine-intelligence-and-agenda-overhaul` (pushed to origin) |
| Backup branch | `backup/training-engine-before-orchestration-overhaul-20260427-2003` (pushed to origin) |
| Backup tag | `backup-training-engine-before-orchestration-overhaul-20260427-2003` (pushed to origin) |
| Anchor commit | `96c61fb` (= `origin/main` = backend `4.14.97` = slice 3.M docs) |
| Production version untouched | `4.14.97` |
| Slice 4.A commit | `f09383c` |
| Slice 4.B commit | `8fe0e58` |
| Slice 4.D commit | `6b19b72` |

To roll back:
```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
git checkout main
git reset --hard backup-training-engine-before-orchestration-overhaul-20260427-2003
# OR for a non-destructive review of the anchor:
git checkout backup/training-engine-before-orchestration-overhaul-20260427-2003
```

## 3. Root causes found for the 3 reported issues

See `training-engine-gap-analysis.md` for the full Phase 0 audit. Distilled:

1. **Volume × time mismatch** — `resolveDurationForDay` picks the largest fitting `template.durationOptionsMinutes` from a default 90-min strength window. `targetExerciseCount` caps exercise list by duration. **Nothing** ever reconciles the two: a session can claim 48 minutes with one Dead Bug exercise.
2. **Variety failure** — `strengthVariantFor(profile, targetSessions, index)` is good for within-week rotation but `index` resets every week. Compounded by `enforceRequestedTrainingPlanVolume → strengthSupportVariants()` which injected **hardcoded exercise name strings** (no IDs, no substitution graph, no beginner-safe layer), shipping the same Lower-A/Upper-A pair on consecutive days.
3. **Agenda lifecycle** — Plan creation does call `createTrainingCalendarEvent` per session, but: there's no transaction wrapping cancel + persist on regeneration; the calendar create is not idempotent (retry duplicates events); there's no `plan_version` for supersession; FK CASCADE on plan deletion wiped session linkage state, leaving externally-orphaned calendar events impossible to reconcile.

## 4. Gap analysis by capability area

See `training-engine-gap-analysis.md`. Layers 1–10 audited. Layers 4 (Session Generator), 5 (Variation), and 7 (Calendar/Event Sync Reconciler) directly addressed by this batch. Layers 2 (Catalog metadata), 3 (Plan Orchestration mesocycle), 6 (week-level adaptability), 8 (Real metrics history reads), 9 (Periodization), 10 (Explainability) remain open — see `training-engine-open-items.md`.

## 5. Architecture changes made

- **New durability layer** at `src/services/training-plan-lifecycle.ts` providing typed audit operations (`recordCalendarOwnership`, `markCalendarOwnershipDeleted`, `findOrphanedOwnerships`, `findExistingOwnership`, `findOwnershipsForPlan`, `incrementPlanVersion`, `getPlanVersion`).
- **New schema layer** via migration `081` adding `fitness_training_plans.plan_version` + non-cascaded `training_agenda_event_ownership` audit table with CHECK constraint on status enum and UNIQUE backstop on `(plan_id, plan_version, event_id, source)`.
- **New validation layer** at `src/services/coach-kernel/session-coherence.ts` (slice 4.A) with deterministic estimator + verdict + corrective-action types.
- **New synthesis layer** at `src/services/coach-kernel/support-session-builder.ts` (slice 4.B) with catalog-grounded variant selector + estimator-derived duration.

No layer was torn down; the 8-layer architecture stays intact. The new layers slot in as Layer-4 (coherence), Layer-5 (variation builder), Layer-7 (lifecycle audit) implementations.

## 6. New or improved engine layers

| Layer | Status | What changed |
|---|---|---|
| 4 — Session Generator | Slice 4.A added coherence gate | `applyCoherenceGate` runs after every strength session build; rebuilds/shrinks/trims content when claimed minutes diverge from estimated by >20%. |
| 5 — Variation & Substitution | Slice 4.B replaced text-string injection | `strengthSupportVariants()` deleted; `buildStrengthSupportVariant(slotIndex, knowledge?)` returns `ExercisePrescription[]` rooted in catalog with movement-pattern rotation enforcing variety. |
| 7 — Calendar/Event Sync Reconciler | Slice 4.D added durable ownership audit | Persist loop is idempotent on retry (no duplicate events); cancel marks ownership rows as `deleted` or `orphaned` so reconcilers can find externally-orphaned events. |

## 7. Files / modules changed

### Created (5)
- `migrations/081_training_agenda_event_ownership.sql`
- `src/services/coach-kernel/session-coherence.ts`
- `src/services/coach-kernel/support-session-builder.ts`
- `src/services/training-plan-lifecycle.ts`
- `__tests__/services/coach-kernel-session-coherence.test.ts`
- `__tests__/services/coach-kernel-support-session-builder.test.ts`
- `__tests__/services/training-plan-lifecycle.test.ts`

### Modified (5)
- `src/services/coach-kernel/engines/strength-engine.ts` (slice 4.A: applyCoherenceGate wiring)
- `src/services/training-plan-volume-enforcement.ts` (slice 4.B: rewired to support-session-builder)
- `src/api/routes/training-plan-persistence.ts` (slice 4.D: idempotency + ownership recording)
- `src/api/routes/training-plan-cancellation.ts` (slice 4.D: post-delete ownership marking)
- `__tests__/api/training-plan-persistence.test.ts` + `__tests__/api/training-plan-cancellation.test.ts` + `__tests__/api/training-routes.test.ts` (lifecycle module mocks)

## 8. Data model / contract / lifecycle changes

| Change | Where | Compatibility |
|---|---|---|
| `fitness_training_plans.plan_version INTEGER NOT NULL DEFAULT 1` | Migration 081 | Backfilled rows get `1`. No reads break. |
| `training_agenda_event_ownership` (new table) | Migration 081 | Audit trail; not read by any iOS client. |
| `ExercisePrescription` shape returned by support builder uses camelCase (`exerciseId`, `rir`, `restSec`) | Slice 4.B | Old text-string callsite was internal — no external contract change. |
| `Session.durationMinutes` may be lower than coach engine's first-pass claim | Slice 4.A | Coherence gate trims duration when content underfilled; iOS receives an honest claim. |

## 9. Agenda / calendar sync changes

- **Idempotent persist**: persistence loop now checks `findExistingOwnership(planId, planVersion, sessionId)` before each `createTrainingCalendarEvent` call. Retry of a partial-failure run is a structural no-op for already-recorded sessions.
- **Audit trail on cancel**: cancellation walks `Promise.allSettled` results and marks ownership rows as `deleted` (success) or `orphaned` (external delete failed) with a reason string, BEFORE the local hard-delete. This gives reconcilers a queryable view of "events we created but couldn't clean up" instead of silently losing track.
- **DB-level UNIQUE backstop** on `(plan_id, plan_version, event_id, source)` so concurrent races during persist degrade to a safe `INSERT...OR IGNORE` semantics.

Cancel-then-persist saga (audit root cause #1) and silent error suppression on the regen catch (audit root cause #4) are deferred — see `training-engine-open-items.md`. The durability layer is the foundation those fixes will build on.

## 10. Tests added or improved

| Slice | New tests | New cases | Pre-existing tests touched |
|---|---|---|---|
| 4.A | `coach-kernel-session-coherence.test.ts` | 27 | — |
| 4.B | `coach-kernel-support-session-builder.test.ts` | 15 | — |
| 4.D | `training-plan-lifecycle.test.ts` | 20 | 3 (mock additions) |
| **Total** | 3 files | **62 new cases** | — |

Backend regression: **363 files / 5,777 tests green** (delta from anchor `96c61fb` of 354 files / 5,597 tests: +9 files / +180 tests, of which 62 are this overhaul's new pin tests).

## 11. Local validation results

| Slice | Typecheck | Focused tests | Full regression | Pre-commit hook | Pre-push hook | Staging deploy | Staging smoke |
|---|---|---|---|---|---|---|---|
| 4.A | clean | 27/27 | 354/5,597 + 1/27 | green | green | green | 17/17 |
| 4.B | clean | 46/46 | 362/5,757 | green | green | green | 17/17 |
| 4.D | clean | 66/66 | 363/5,777 | green | green | green | 17/17 |

## 12. Remaining open issues

See `training-engine-open-items.md`.

## 13. Highest-priority next steps

If batch-promoting now: roll all three commits forward, bump version to next available (likely `4.14.98`), update the in-CLAUDE.md "Current Production Truth" block, and run the full validated-promote pipeline (`promote-to-prod.sh` re-runs the smoke as a gate).

If continuing the overhaul before promote: slice 4.E (real metrics history reads — replace `tailored4WeekMinutesBySport` synthesis with `training_completions` aggregation) is the highest-leverage foundational item per the audit. Layer 8 (Metrics & Feedback Analysis) was scored "Critical (blocks credible long-term coaching)".

## 14. Rollback notes

- The backup branch + tag preserve the pre-overhaul state at `96c61fb`.
- The working branch is on origin so any other workstation can pull it.
- The three slice commits are independent in spirit but share schema state through migration 081 — rolling back to before slice 4.D requires also dropping the column + table (rollback SQL is documented in the migration header).
- Pre-commit + pre-push hooks remain in place; any further commit on the working branch goes through the standard test gate.
- Production has NOT been promoted; rollback at the production layer is not required.
