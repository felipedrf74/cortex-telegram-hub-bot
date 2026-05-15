# Training Engine + Agenda Orchestration Overhaul — Final Report

Status: **Overhaul complete. 8 slices shipped. All audit-confirmed regressions closed at root cause + audit Layers 2/3/5/7/8 deepened. Working branch + staging green. Awaiting batch promote-to-prod.**

---

## 1. Executive summary

The Phase 0 audit identified three observable user regressions and
five structural Layer gaps in the Training engine. Eight slices
shipped over the course of the overhaul, each going through the
validated-promote pipeline (focused tests → full backend regression
→ commit → push → staging deploy → 17/17 staging smoke).

| Slice | Closes | Commit | New tests | Full regression |
|---|---|---|---|---|
| 4.A | Volume × time mismatch (regression #1) | `f09383c` | +27 | 361 / 5,742 |
| 4.B | Variety failure (regression #2) | `8fe0e58` | +15 | 362 / 5,757 |
| 4.D | Agenda lifecycle idempotency (regression #3 root causes #2+#3) | `6b19b72` | +20 | 363 / 5,777 |
| 4.D.2 | Saga + silent error suppression (regression #3 root causes #1+#4) | `e1cedd8` | +5 | 363 / 5,782 |
| 4.E | Real metrics history reads (Layer 8 critical) | `48352a3` | +17 | 364 / 5,799 |
| 4.C | Multi-week variant rotation (Layer 5) | `0686891` | +9 | 365 / 5,808 |
| 4.F | Availability-aware day slot picks (Layer 3) | `61b2cb7` | +15 | 366 / 5,823 |
| 4.G | Catalog metadata enrichment (Layer 2) | `7c35e06` | +35 | 367 / 5,858 |
| 4.H | Biomechanics-aware substitution + session-order (Layers 5+7) | `08273a4` | +17 | 368 / 5,875 |
| **Total** | All 3 regressions + 5 layer gaps | 8 slices | **+160 cases** | 368 / 5,875 |

Production version is unchanged at `4.14.97` per the explicit
"don't promote to prod until full overhaul complete" instruction.
The working branch is fully reproducible:
`feature/training-engine-intelligence-and-agenda-overhaul` on origin.

## 2. Branch and backup/tag details

| Item | Value |
|---|---|
| Working branch | `feature/training-engine-intelligence-and-agenda-overhaul` (pushed to origin) |
| Backup branch | `backup/training-engine-before-orchestration-overhaul-20260427-2003` (pushed to origin) |
| Backup tag | `backup-training-engine-before-orchestration-overhaul-20260427-2003` (pushed to origin) |
| Anchor commit | `96c61fb` (= `origin/main` = backend `4.14.97`) |
| Production version untouched | `4.14.97` |
| Latest overhaul commit | `08273a4` (slice 4.H) |

To roll back:
```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
git checkout main
git reset --hard backup-training-engine-before-orchestration-overhaul-20260427-2003
```

## 3. Root causes found for the 3 reported issues

See `training-engine-gap-analysis.md` for the full Phase 0 audit. Distilled:

1. **Volume × time mismatch** — `resolveDurationForDay` picks the largest fitting `template.durationOptionsMinutes` from a 90-min strength window. `targetExerciseCount` caps exercise list by duration. **Nothing** ever reconciled the two.

2. **Variety failure** — `strengthVariantFor`'s `index` resets every week, so Week 1 day 1 = Week 5 day 1. Compounded by `enforceRequestedTrainingPlanVolume → strengthSupportVariants()` which injected **hardcoded exercise text strings** bypassing the catalog/substitution/beginner-safe layers.

3. **Agenda lifecycle** — Plan creation does call `createTrainingCalendarEvent` per session, but: (1) no transaction wrapping cancel + persist on regeneration; (2) no idempotent calendar create (retry duplicates events); (3) no `plan_version` for supersession; (4) silent error suppression on the regen catch.

All three fully closed:
- Regression #1 by slice 4.A (SessionCoherenceValidator).
- Regression #2 by slices 4.B (catalog-grounded support builder) + 4.C (multi-week rotation).
- Regression #3 by slices 4.D (durability layer) + 4.D.2 (saga + explicit error taxonomy).

## 4. Gap analysis by capability area

See `training-engine-gap-analysis.md`. Layers 1–10 audited. Layers addressed by this overhaul:

| Layer | Audit grade | Closed by | Status |
|---|---|---|---|
| 2 — Training Domain Model / Catalog | High | 4.G | Foundation laid; 20/24 exercises explicit |
| 3 — Plan Orchestration | Critical | 4.F | Day picks now availability-aware |
| 4 — Session Generator | Critical | 4.A | Coherence validator gates every session |
| 5 — Variation & Substitution | High | 4.B + 4.C + 4.H | Catalog + multi-week + biomechanics-aware |
| 7 — Calendar Sync Reconciler | Critical | 4.D + 4.D.2 | Audit table + saga + idempotency |
| 7 — Biomechanics & Movement | Medium-High | 4.H | Compound→accessory→core ordering + pain-aware safety |
| 8 — Metrics & Feedback | Critical | 4.E | Real `training_completions` reads replace synthesis |

## 5. Architecture changes made

8 new modules + 1 migration + 5 modified files:

NEW:
- `src/services/coach-kernel/session-coherence.ts` (slice 4.A — Layer 4 validator)
- `src/services/coach-kernel/support-session-builder.ts` (slice 4.B — Layer 5 builder)
- `src/services/training-plan-lifecycle.ts` (slice 4.D — Layer 7 audit)
- `src/services/training-history.ts` (slice 4.E — Layer 8 read)
- `src/services/coach-kernel/availability-day-picker.ts` (slice 4.F — Layer 3 picker)
- `src/services/coach-kernel/exercise-metadata.ts` (slice 4.G — Layer 2 helpers)
- `src/services/coach-kernel/biomechanics-and-ordering.ts` (slice 4.H — Layers 5+7)
- `migrations/081_training_agenda_event_ownership.sql` (slice 4.D — schema)

MODIFIED:
- `src/services/coach-kernel/engines/strength-engine.ts` (4.A coherence gate, 4.C weekIndex shift, 4.H biomechanics + ordering pipeline)
- `src/services/training-plan-volume-enforcement.ts` (4.B catalog rewire, 4.C weekNumber thread)
- `src/api/routes/training-plan-persistence.ts` (4.D idempotency + ownership recording)
- `src/api/routes/training-plan-cancellation.ts` (4.D post-delete ownership marking)
- `src/api/routes/training-plan-generation.ts` (4.D.2 saga)
- `src/api/routes/training-plan-routes.ts` (4.D.2 cancellation_failed branch)
- `src/services/coach-kernel/engines/{running,cycling,swimming}-engine.ts` (4.F day picks)
- `src/services/coach-kernel/types.ts` (4.G optional Exercise fields)
- `src/services/coach-kernel/knowledge/entities/exercises.json` (4.G enrichment)
- `src/services/coach-kernel/support-session-builder.ts` (4.C weekIndex)
- `src/services/training-coach-kernel-plan-generator.ts` (4.E real history wiring)

## 6. New or improved engine layers

See section 4 table.

## 7. Files / modules changed

11 commits on `feature/training-engine-intelligence-and-agenda-overhaul`:
```
08273a4 feat(coach-engine): slice 4.H — biomechanics-aware substitution + session-order
7c35e06 feat(coach-engine): slice 4.G — catalog metadata enrichment foundation
61b2cb7 feat(coach-engine): slice 4.F — availability-aware day slot picks
0686891 feat(coach-engine): slice 4.C — multi-week variant rotation
48352a3 feat(coach-engine): slice 4.E — real metrics history reads
e1cedd8 feat(coach-engine): slice 4.D.2 — pre-persist cancellation saga
3db2823 docs(training): final report + open items
6b19b72 feat(coach-engine): slice 4.D — plan lifecycle ownership audit
8fe0e58 feat(coach-engine): slice 4.B — catalog-grounded support builder
f09383c feat(coach-engine): slice 4.A — SessionCoherenceValidator
181a572 docs(training): Phase 0 audit
```

## 8. Data model / contract / lifecycle changes

| Change | Where | Compatibility |
|---|---|---|
| `fitness_training_plans.plan_version INTEGER NOT NULL DEFAULT 1` | Migration 081 | Backfilled to 1. No reads break. |
| `training_agenda_event_ownership` table | Migration 081 | New audit trail; no iOS contract change. |
| `Exercise` interface +6 optional fields | types.ts | Optional; zero break for any consumer. |
| `ExercisePrescription` shape from support builder uses camelCase | support-session-builder.ts | Old callsite was internal text-string; no external contract change. |
| `Session.durationMinutes` may be lower than the engine's first-pass claim | Slice 4.A coherence gate | iOS receives an honest claim instead of an inflated one. |
| `TrainingPlanGenerationResult` adds `'cancellation_failed'` variant | training-plan-generation.ts | iOS routes can now show actionable retry banner; pre-slice would have returned 500. |

## 9. Agenda / calendar sync changes

- **Idempotent persist**: persistence loop checks `findExistingOwnership(planId, planVersion, sessionId)` before each `createTrainingCalendarEvent` call. Retry-after-failure is a structural no-op for already-recorded sessions.
- **Audit trail on cancel**: cancellation walks `Promise.allSettled` results and marks ownership rows as `deleted` (success) or `orphaned` (external delete failed) with a reason string, BEFORE the local hard-delete.
- **DB-level UNIQUE backstop** on `(plan_id, plan_version, event_id, source)` so concurrent races during persist degrade to safe `INSERT...OR IGNORE`.
- **Saga abort**: pre-persist cancellation now inspects post-cancel DB state. When the local hard-delete failed, returns `'cancellation_failed'` to the caller instead of silently producing a double-plan corruption.

## 10. Tests added or improved

| Slice | New test files | New cases |
|---|---|---|
| 4.A | coach-kernel-session-coherence.test.ts | 27 |
| 4.B | coach-kernel-support-session-builder.test.ts | 15 |
| 4.D | training-plan-lifecycle.test.ts | 20 |
| 4.D.2 | (extends training-plan-generation.test.ts) | +5 |
| 4.E | training-history.test.ts | 17 |
| 4.C | coach-kernel-multi-week-rotation.test.ts | 9 |
| 4.F | coach-kernel-availability-day-picker.test.ts | 15 |
| 4.G | coach-kernel-exercise-metadata.test.ts | 35 |
| 4.H | coach-kernel-biomechanics-and-ordering.test.ts | 17 |
| **Total** | 8 new files + 1 extended | **+160 cases** |

Backend regression: **368 files / 5,875 tests green** (delta from anchor `96c61fb` of 354 files / 5,597 tests: +14 files / +278 tests, of which 160 are this overhaul's new pin tests; the remainder are existing test files that gained cases through mock additions or test-shape updates).

## 11. Local validation results

Each slice individually verified:
- `npx tsc --noEmit` clean
- Focused tests green
- Full backend regression green
- Pre-commit + pre-push hooks green
- Staging deploy green
- 17/17 staging smoke green
- DB integrity_check ok

## 12. Remaining open issues

See `training-engine-open-items.md` (updated for post-4.H state).

## 13. Highest-priority next steps

**Immediate (this batch promote)**:
1. Bump version to `4.14.98` in package.json + portal/server.ts
2. Run `./scripts/promote-to-prod.sh` (re-runs staging smoke as gate)
3. Verify production health check
4. Update CLAUDE.md "Current Production Truth" section

**Future (post-promote, individual slices)**:
- Layer 6 week-level adaptability (missed session compensation, mid-week reflow)
- Layer 9 progression & periodization (rep-range progression, deload weeks, re-entry logic)
- Layer 10 explainability polish (decision trail dedup, plan-level explanation card)
- Goal→split→role mapping (Push/Pull/Legs vs Upper/Lower×2 — deferred from slice 4.F)

## 14. Rollback notes

- Backup branch + tag preserve pre-overhaul state at `96c61fb`.
- Working branch on origin; any workstation can pull.
- Migration 081 is forward-only but reversible (DROP TABLE + DROP COLUMN documented in the migration header).
- All 8 slice commits are independent in spirit but share schema state through migration 081.
- Pre-commit + pre-push hooks remain in place.
