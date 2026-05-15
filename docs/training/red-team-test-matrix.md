# Training Engine Red-Team Test Matrix

Date: 2026-04-28

## Automated Benchmark Matrix

| Stress Area | Coverage Mechanism | Result | Notes |
|---|---|---|---|
| Time-volume coherence | Eval dimension plus `coach-kernel-session-coherence.test.ts` | Pass, `100/100` dimension | Fixed red-readiness and feedback-duration overstuffing before final run. |
| Session-role differentiation | Eval dimension across 156 cases | Pass with open edge, `97/100` | Poor-recovery cyclist/travel cases still collapse too much into recovery variants. |
| Weekly structure quality | Eval dimension across 156 cases | Pass with open edge, `99/100` | Travel-week overloaded windows still produce max-session penalties. |
| Adaptation under messy changes | Reduced time, missed key, poor recovery, feedback, plateau scenarios | Pass, `100/100` dimension | One class of availability overflow remains in travel-heavy cases. |
| Agenda lifecycle correctness | Plan cancellation/regeneration scenarios plus API tests | Pass with open edge, `97/100` | Regenerated sessions can reuse ids after shape changes; missing calendar times remain when no safe window exists. |
| Stale-state prevention | `training-plan-lifecycle`, `training-agenda-reconciliation`, API cancellation tests | Pass | Lifecycle tests passed, but identity hash/versioning should be hardened next. |
| Repeated guidance/warnings | Decision-trail tests and eval warning dimension | Pass, `100/100` dimension | Dedupe rationale test added in prior pass and included in broader slice. |
| Gym quality | Persona bank plus strength/kernel tests | Pass | Time coherence and beginner/intermediate/advanced differentiation covered. |
| Running quality | Runner personas, reduced-time scenario, modality dimension | Pass with edge | Short windows now cap/reflow; poor-recovery strips long/quality runs by design but should explain better. |
| Cycling quality | Cyclist/hybrid-cycling personas and poor-recovery scenario | Pass with edge | Recovery mode needs more role-preserving cycling variation. |
| Hybrid quality | Gym+running and gym+cycling personas | Pass | Interference and availability stress covered; poor-recovery variety remains open. |
| Profile personalization | Profile model tests and profile-fit dimension | Pass, `100/100` dimension | Weak-profile notes need stronger surfacing in two low-score cases. |
| Feedback-driven changes | Feedback-analysis tests and scenario bank | Pass | Added coherence check after feedback/guardrail duration cuts. |
| Frontend compatibility | Backend shape/tags are produced and tests pass | Needs runtime validation | iOS simulator smoke was not run in this backend-only pass. |
| Cross-skill behavior | Shared decision context tests and fueling/missing coverage scenarios | Pass with caution | Noisy warnings score clean; richer UI/runtime validation remains separate. |

## Commands Run

### Targeted Coherence / Scheduler Regression

```bash
npm test -- --run __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-feedback-analysis.test.ts __tests__/services/coach-kernel-guardrails.test.ts __tests__/services/coach-kernel-session-coherence.test.ts __tests__/services/coach-kernel-evaluation.test.ts
```

Result: `5` files passed, `62` tests passed.

### Full Training Red-Team Slice

```bash
npm test -- --run __tests__/services/coach-kernel-session-coherence.test.ts __tests__/services/coach-kernel-planner.test.ts __tests__/services/coach-kernel-strength-engine.test.ts __tests__/services/coach-kernel-catalog-depth.test.ts __tests__/services/coach-kernel-biomechanics-and-ordering.test.ts __tests__/services/coach-kernel-feedback-analysis.test.ts __tests__/services/coach-kernel-decision-trail.test.ts __tests__/services/coach-kernel-evaluation.test.ts __tests__/services/training-profile-model.test.ts __tests__/services/training-plan-lifecycle.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/services/training-calendar-scope.test.ts __tests__/services/shared-decision-context.test.ts __tests__/services/training-signals.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/api/training-plan-cancellation.test.ts __tests__/api/training-routes.test.ts
```

Result: `17` files passed, `224` tests passed.

### Benchmark Harness

```bash
npm run eval:training -- --out-dir reports/training-red-team --week-start 2026-04-27 --fail-under 75
```

Result: `99/100`, `156` cases. Latest output:

- `reports/training-red-team/training-eval-2026-04-28T01-40-32-426Z.json`
- `reports/training-red-team/training-eval-2026-04-28T01-40-32-426Z.md`

## Added / Updated Regression Assertions

| Test File | New/Relevant Assertion |
|---|---|
| `__tests__/services/coach-kernel-guardrails.test.ts` | Red-readiness strength replacement remains truthful to a short technique slot. |
| `__tests__/services/coach-kernel-guardrails.test.ts` | Red-readiness endurance recovery titles preserve original role context. |
| `__tests__/services/coach-kernel-feedback-analysis.test.ts` | Reduced strength sessions remain time-volume coherent after feedback/guardrail duration cuts. |
| `__tests__/services/coach-kernel-planner.test.ts` | Scheduled sessions fit declared short availability windows and recompute end times honestly. |

## Manual Validation Still Needed

- iOS rendering smoke for richer session tags and alternatives.
- Calendar provider smoke for cancel/regenerate with regenerated shape ids once identity hardening is implemented.
- Travel-week UX review to decide whether overflow sessions should be deferred, offered as optional, or converted into home recovery placeholders.
