# Training Schedule Compression Explanations

Date: 2026-04-28  
Branch: `feature/training-schedule-compression-explanations`  
Rollback branch: `backup/training-schedule-compression-explanations-pre-20260428-0806`  
Rollback tag: `backup-training-schedule-compression-explanations-pre-20260428-0806`

## Executive Summary

The Training engine already reconciled constrained weeks into `compressed`, `capped`, `reflowed`, and `unscheduled` session states. The missing piece was explanation quality: users could see a smaller or moved plan without a structured reason that tied the change to the actual capacity decision.

This pass adds first-class `decisionReasons` to sessions, guardrails, and weekly plans. These reasons are structured, evidence-based, deduped, and surfaced into weekly decision notes as `Plan adjustment:` lines.

## What Changed

| Area | Change | Why |
| --- | --- | --- |
| Decision reason model | Added `TrainingDecisionReason` and reason codes to the coach-kernel types. | Gives API/UI a durable contract instead of parsing free text. |
| Capacity reconciliation | Emits structured reasons for compressed, capped, reflowed, unscheduled, and weekly-cap decisions. | Explains why a session moved, shrank, or was left unscheduled. |
| Guardrails | Readiness, deload, volume-growth, interference, and schedule-density guardrails can emit decision reasons. | Recovery and volume drops now have explicit cause/evidence. |
| Decision trail | Weekly notes include deduped `Plan adjustment:` lines derived from decision reasons. | Users can understand plan changes without reading raw guardrails. |
| API payload | Coordinated plan/week/session payloads can carry `decisionReasons`. | iOS can render explanations with code, severity, source, and before/after values. |

## Example Explanations

| Situation | Example |
| --- | --- |
| Session compression | `Threshold Run was compressed from 45 to 30 minutes because only 30 minutes were available in the selected window.` |
| Reflowed session | `Threshold Run moved from wednesday to monday because the selected short run window was the valid slot for this week.` |
| Unscheduled session | `Marked unscheduled because no feasible slot remained after preserving higher-priority sessions.` |
| Weekly cap | `2 of 3 planned sessions fit this constrained week; the rest were deferred or marked unscheduled instead of being forced into invalid slots.` |
| Recovery downshift | `High-stress work was downgraded before prescription because recovery signals are strained.` |

## User Trust Behavior

The engine no longer only says "what changed." It now also exposes:

- source constraint
- affected session or week
- before and after values
- training intent preserved
- decision evidence

This means a lower-volume week can be explained as a capacity or recovery decision instead of looking like a weak plan.

## Files Changed

- `src/services/coach-kernel/types.ts`
- `src/services/coach-kernel/capacity-reconciliation.ts`
- `src/services/coach-kernel/guardrails.ts`
- `src/services/coach-kernel/decision-trail.ts`
- `src/services/coach-kernel/planner-engine.ts`
- `src/services/training-plan-coordination.ts`
- `src/services/training-coach-kernel-plan-generator.ts`
- `__tests__/services/coach-kernel-constrained-week-capacity.test.ts`
- `__tests__/services/coach-kernel-decision-trail.test.ts`

## Validation

```bash
npx vitest run '__tests__/services/coach-kernel-constrained-week-capacity.test.ts' '__tests__/services/coach-kernel-decision-trail.test.ts'
npm run typecheck
```

Initial focused result:

- 2 test files passed
- 9 tests passed
- TypeScript passed

