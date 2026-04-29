# Training Release Test Results

Date: 2026-04-29
Scope: focused backend Training hardening verification.

## Commands Run

### Focused Training Regression Suite

```bash
npm test -- __tests__/api/training-plan-persistence.test.ts __tests__/api/training-routes.test.ts __tests__/services/training-plans.test.ts __tests__/services/coach-kernel-constrained-week-capacity.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/services/training-plan-lifecycle.test.ts __tests__/services/coach-kernel-feedback-analysis.test.ts __tests__/services/coach-kernel-poor-recovery-variation.test.ts __tests__/services/training-profile-model.test.ts
```

Result:

- Test files: 9 passed
- Tests: 137 passed
- Duration: 5.64s

Coverage from this focused run:

- travel-week capacity reconciliation;
- constrained-week no-valid-slot handling;
- scheduled/reflowed/compressed/capped/unscheduled lifecycle persistence;
- iOS-facing rich lifecycle week payload;
- plan cancellation and precise provider cleanup targets;
- plan version / session identity / session shape hash lifecycle table behavior;
- stale agenda ownership handling;
- poor-recovery variation;
- weak-profile follow-up prompts;
- feedback ingestion and planning adaptation;
- schedule-compression explanations.

### Typecheck

```bash
npm run typecheck
```

Result: pass.

## Initial Command Issue

An initial test command used the old Jest-style `--runInBand` flag:

```bash
npm test -- --runInBand ...
```

Vitest rejected that flag with `Unknown option --runInBand`. No product test executed under that command. The suite was immediately rerun with the Vitest-compatible command above and passed.

## Tests Added Or Updated

### `__tests__/api/training-plan-persistence.test.ts`

Added/updated assertions that:

- generated active sessions default to `scheduled`;
- compressed sessions persist `status: "compressed"`;
- compressed schedule reasons are stored in the session description;
- compressed schedule reasons are included in calendar event descriptions;
- `scheduleAdjustments: ["reflowed", "compressed"]` persists `status: "reflowed"`;
- `scheduleAdjustments: ["capped"]` persists `status: "capped"`;
- unscheduled/deferred rows remain inactive and do not create calendar events.

### `__tests__/api/training-routes.test.ts`

Added week-payload coverage that:

- `reflowed` and `compressed` sessions expose rich `lifecycleState`;
- active rich lifecycle states still map to user-facing `status: "planned"`;
- `sessionShapeHash` remains exposed;
- `unscheduled` and `superseded` sessions remain visible as lifecycle states but do not count as active week load.

### `__tests__/services/training-plans.test.ts`

Added service-level coverage that:

- unscheduled/deferred/superseded sessions do not inflate weekly adherence totals;
- scheduled/reflowed/compressed sessions remain adherence-bearing;
- skipped sessions are excluded from cross-plan load;
- unscheduled sessions are excluded from cross-plan load.

## Release Blocker Checklist

| Area | Result | Evidence |
| --- | --- | --- |
| Constrained/travel-week reconciliation | Pass | `coach-kernel-constrained-week-capacity.test.ts` |
| Too many active sessions | Pass | capacity cap tests and active load filtering |
| Missing scheduled times | Pass | no-valid-slot tests persist `unscheduled` instead of creating fallback events |
| Scheduled/capped/reflowed/unscheduled state | Pass | persistence + route payload tests |
| Plan version | Pass | `training-plan-lifecycle.test.ts` |
| Session shape hash | Pass | lifecycle + route payload tests |
| Precise agenda cleanup on cancel/regenerate | Pass | `training-plan-cancellation.test.ts`, lifecycle ownership tests |
| Stale agenda cleanup | Pass at route/service level | cancellation and lifecycle ownership tests |
| Schedule-compression explanations | Pass | persistence test confirms durable description/calendar explanation |
| Poor-recovery variation | Pass | `coach-kernel-poor-recovery-variation.test.ts` |
| Weak-profile follow-up prompts | Pass | `training-profile-model.test.ts` |
| Feedback ingestion contract | Pass | `coach-kernel-feedback-analysis.test.ts` |
| iOS-facing rich state payloads | Pass at backend contract level | `training-routes.test.ts` |

## Not Run In This Pass

- Full `npm run verify`.
- iOS simulator build/test.
- Signed TestFlight/device validation.
- Real production calendar mutation proof.

Reason:

This was a focused backend Training production-hardening pass. The requested iOS-facing work was backend payload/contract support; no iOS repository files were changed.

## Final Verdict

Focused Training hardening verdict: **PASS WITH CONDITIONS**.

The local backend blockers addressed in this pass are fixed and verified. Remaining conditions are external release-gate items: signed-device validation, production-safe mutation/calendar proof, and release-copy restraint around runtime model and closed-loop feedback claims.
