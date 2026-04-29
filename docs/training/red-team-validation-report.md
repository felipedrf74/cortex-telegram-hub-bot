# Training Engine Red-Team Validation Report

Date: 2026-04-28  
Branch under test: `feature/training-engine-eval-harness`  
Head under test: `d0d0c41` plus local red-team fixes  
Backend package version observed: `4.14.99`  
Production deploy: not performed

## 1. Executive Summary

The red-team pass used the Training evaluation harness plus focused regression suites to attack the coach engine across time-volume coherence, short-window scheduling, poor recovery, plan cancellation/regeneration, feedback-driven changes, modality breadth, stale-state risk, agenda lifecycle, and explanation quality.

The engine is substantially stronger than the first screenshots showed. The final benchmark scored `99/100` across `156` persona-scenario cases. Time-volume coherence is now `100/100`, and the focused Training regression slice passed `224/224` tests.

The pass still found several credible edge weaknesses. Three were safe to fix in this pass:

1. Red-readiness strength replacements were claiming short technique sessions while retaining too much original strength volume.
2. Feedback/guardrail duration reductions could shorten a strength session without trimming its exercise content.
3. Short availability windows could still receive longer sessions, or preferred start times could push the session beyond the window.

Remaining open risks are mostly around travel-week overload, poor-recovery variety, and regeneration identity semantics. These are documented separately in `docs/training/red-team-open-issues.md`.

## 2. Validation Method

The red-team pass exercised:

- Canonical persona bank: beginner gym, intermediate hypertrophy, strength-focused, runner, cyclist, hybrid gym/running, hybrid gym/cycling, low-time, inconsistent-adherence, equipment-limited, travel-week, discomfort-limited, explicit cycle-aware user.
- Scenario bank: baseline, missed key session, reduced available time, plan cancellation/regeneration, plateau, poor recovery, travel/hotel gym, schedule changes, too hard/easy/long feedback, missing fueling, weak profile completeness, discomfort substitution.
- Focused backend tests for coach kernel, training profile, plan lifecycle, agenda reconciliation, calendar scope, shared decision context, API cancellation, API calendar sync, and training routes.

## 3. Fixes Applied During Red-Team Pass

| ID | Severity | Area | Root Cause | Fix | Tests |
|---|---|---|---|---|---|
| RT-FIX-001 | High | Red-readiness strength | `enforceReadiness` changed title/type/duration but kept the original heavy strength exercise list, producing false 20-minute technique prescriptions. | Red strength replacements now trim to at most two technique movements, cap sets/rest, raise RIR, and add technique-only notes. Endurance red titles now preserve original role context. | `coach-kernel-guardrails.test.ts` red-readiness coherence/title tests |
| RT-FIX-002 | High | Feedback/guardrail duration cuts | Duration mutations reduced `durationMinutes` while leaving overstuffed strength content intact. | Added reusable `trimOverstuffedStrengthSessionToDuration(...)` and invoked it from feedback/guardrail reduction paths. | `coach-kernel-feedback-analysis.test.ts`, `coach-kernel-session-coherence.test.ts` |
| RT-FIX-003 | High | Short-window scheduling | Scheduler trusted session duration and preferred start even when the window was shorter, causing sessions to exceed declared availability. | Scheduler now caps sessions to matching window capacity, preserves honest load, trims strength content when needed, reflows only during final scheduling, and falls back to the window start when preferred start would overflow. | `coach-kernel-planner.test.ts` short-window cap test |

## 4. Files Touched In This Pass

- `src/services/coach-kernel/guardrails.ts`
- `src/services/coach-kernel/session-coherence.ts`
- `src/services/coach-kernel/feedback-analysis.ts`
- `src/services/coach-kernel/planner-engine.ts`
- `__tests__/services/coach-kernel-guardrails.test.ts`
- `__tests__/services/coach-kernel-feedback-analysis.test.ts`
- `__tests__/services/coach-kernel-planner.test.ts`
- `docs/training/red-team-validation-report.md`
- `docs/training/red-team-open-issues.md`
- `docs/training/red-team-test-matrix.md`

## 5. Final Benchmark Result

Command:

```bash
npm run eval:training -- --out-dir reports/training-red-team --week-start 2026-04-27 --fail-under 75
```

Result:

- Overall score: `99/100`
- Cases: `156`
- JSON: `reports/training-red-team/training-eval-2026-04-28T01-40-32-426Z.json`
- Markdown: `reports/training-red-team/training-eval-2026-04-28T01-40-32-426Z.md`

Dimension averages:

| Dimension | Score |
|---|---:|
| profile_fit | 100 |
| plan_coherence | 98 |
| weekly_structure_quality | 99 |
| session_role_differentiation | 97 |
| variety_quality | 99 |
| time_volume_coherence | 100 |
| modality_quality | 99 |
| progression_quality | 97 |
| adaptability_quality | 100 |
| substitution_quality | 100 |
| biomechanics_quality | 100 |
| adherence_realism | 100 |
| explainability | 99 |
| agenda_lifecycle_correctness | 97 |
| warning_quality_deduplication | 100 |

## 6. Focused Regression Result

Command:

```bash
npm test -- --run __tests__/services/coach-kernel-session-coherence.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-strength-engine.test.ts __tests__/services/coach-kernel-catalog-depth.test.ts __tests__/services/coach-kernel-biomechanics-and-ordering.test.ts __tests__/services/coach-kernel-feedback-analysis.test.ts __tests__/services/coach-kernel-decision-trail.test.ts __tests__/services/coach-kernel-evaluation.test.ts __tests__/services/training-profile-model.test.ts __tests__/services/training-plan-lifecycle.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/training-calendar-scope.test.ts __tests__/services/shared-decision-context.test.ts __tests__/services/training-signals.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-routes.test.ts
```

Result: `17` test files passed, `224` tests passed.

## 7. Red-Team Verdict

The engine is credible enough to continue toward review/testing, but not perfect enough to call finished. The biggest remaining concern is not generic session quality; it is lifecycle and schedule resilience under overloaded travel/poor-recovery conditions, plus regenerated session identity when shape changes.

Recommended next action: fix the remaining open issues in `docs/training/red-team-open-issues.md` before any production promotion.
