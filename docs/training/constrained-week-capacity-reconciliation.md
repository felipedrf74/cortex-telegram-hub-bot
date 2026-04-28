# Constrained-Week Capacity Reconciliation

Date: 2026-04-28  
Branch: `feature/training-constrained-week-capacity-reconciliation`  
Backup: `backup/training-constrained-week-pre-reconciliation-20260428-0524` / `backup-training-constrained-week-pre-reconciliation-20260428-0524`

## Root Cause

The planner previously treated availability as a per-session placement hint. A session could be capped to the first matching window, but the week was never reconciled against a finite capacity model. In low-time or travel weeks this left several failure modes:

- leftover sessions could keep active training semantics after no slot remained
- missing `startTime` / `endTime` did not imply a clear unscheduled state
- hybrid sessions competed for the same few windows without priority rules
- calendar persistence only knew about `sessionType`, not capacity state
- evaluation treated rest/deferred placeholders as active sessions, hiding overload risk

## Architecture Change

Added an explicit capacity reconciliation layer at `src/services/coach-kernel/capacity-reconciliation.ts`.

The reconciler runs after feedback adaptation and guardrails, before the weekly plan is finalized. It builds capacity slots from declared availability, then places sessions by priority while enforcing:

- compatible sport/modality windows
- `maxSessionsPerDay`
- available duration per slot
- minimum executable duration by modality
- high-fatigue spacing when feasible
- travel/low-time compression instead of impossible scheduling
- explicit inactive states when no feasible slot remains

Triathlon brick sessions are allowed to share a cycling window when capacity remains, preserving the coaching intent of bike-to-run pairing while still requiring real minutes inside the window.

## Session States

The engine now exposes optional schedule metadata on `Session`:

| Field | Purpose |
|---|---|
| `scheduleState` | Primary state: `scheduled`, `compressed`, `reflowed`, `capped`, `deferred`, `unscheduled`, or `dropped`. |
| `scheduleAdjustments` | All applied schedule adjustments, for example `["reflowed", "compressed"]`. |
| `scheduleReason` | User-facing explanation for the adjustment. |
| `originalDayOfWeek` | Original intended day when a session is reflowed. |
| `capacityWindow` | Slot metadata used for final placement. |

Inactive states (`deferred`, `unscheduled`, `dropped`) are converted to non-calendar work before persistence.

## Calendar / Agenda Implications

- `syncCalendar(plan)` now filters through `isActiveTrainingSession`.
- Plan persistence skips generated sessions with `scheduleState` of `deferred`, `unscheduled`, or `dropped`.
- Existing `rest` and standalone mobility skip behavior remains intact.
- Reflowed/compressed/capped sessions remain schedulable and create calendar events only when they have valid times.
- This prevents stale or impossible agenda items from being created for constrained-week leftovers.

## Files Changed In This Slice

- `src/services/coach-kernel/capacity-reconciliation.ts`
- `src/services/coach-kernel/types.ts`
- `src/services/coach-kernel/planner-engine.ts`
- `src/services/coach-kernel/index.ts`
- `src/services/coach-kernel/tools.ts`
- `src/services/coach-kernel/evaluation/rubric.ts`
- `src/services/training-coach-kernel-plan-generator.ts`
- `src/services/training-plan-coordination.ts`
- `src/api/routes/training-plan-persistence.ts`
- `__tests__/services/coach-kernel-constrained-week-capacity.test.ts`
- `__tests__/api/training-plan-persistence.test.ts`

## Validation

- `npm run typecheck` passed.
- Focused tests passed: 28 tests across planner, constrained capacity, persistence, and evaluation.
- Training benchmark passed: `99/100` across `156` cases.

Benchmark output:

- JSON: `reports/training-eval/constrained-week-capacity/training-eval-2026-04-28T04-41-19-631Z.json`
- Markdown: `reports/training-eval/constrained-week-capacity/training-eval-2026-04-28T04-41-19-631Z.md`

