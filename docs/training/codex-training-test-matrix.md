# Codex Training Test Matrix

Date: 2026-04-27

## Tests Added Or Extended By Codex

| Behavior | File | Status |
|---|---|---|
| Sparse high-duration strength session is rebuilt instead of only relabeled | `__tests__/services/coach-kernel-strength-engine.test.ts` | PASS |
| Calendar sync relinks a session from ownership without duplicate event creation | `__tests__/api/training-plan-calendar-sync.test.ts` | PASS |
| Calendar sync records ownership for newly created events | `__tests__/api/training-plan-calendar-sync.test.ts` | PASS |
| Calendar sync records ownership for matched existing events | `__tests__/api/training-plan-calendar-sync.test.ts` | PASS |
| Orphaned lifecycle row can transition to deleted after retry succeeds | `__tests__/services/training-plan-lifecycle.test.ts` | PASS |
| Reconciliation queue returns only status=`orphaned` rows | `__tests__/services/training-plan-lifecycle.test.ts` | PASS |
| Reconciler deletes exact orphaned event and marks row deleted | `__tests__/services/training-agenda-reconciliation.test.ts` | PASS |
| Reconciler leaves row retryable when provider delete fails | `__tests__/services/training-agenda-reconciliation.test.ts` | PASS |
| Plan generation saga calls reconciliation without touching real providers in tests | `__tests__/api/training-plan-generation.test.ts` | PASS |
| Route harness covers reconciliation dependency for plan-generation endpoints | `__tests__/api/training-routes.test.ts` | PASS |

## Required Regression Coverage

| Requirement | Coverage | Notes |
|---|---|---|
| Low-content 48-minute strength session no longer surfaces incoherently | Covered | Test asserts at least four exercises, `coherence_rebuilt`, credible estimate, and valid coherence verdict. |
| Multi-day strength plan should not be near-identical | Partially covered by Claude tests | Claude's multi-week rotation tests reduce repetition, but true split-role testing remains open. |
| Plan activation creates agenda events correctly | Covered by existing route/persistence/sync tests | Codex strengthened ownership recording in sync paths. |
| Plan cancellation/replacement removes correct agenda events | Covered for hard delete and ownership marking; strengthened by orphan retry tests | Background retry job still open. |
| Idempotent agenda sync | Covered by Claude + Codex sync tests | Codex added ownership relink case. |
| No stale/orphaned agenda events | Improved | Precise orphan retry exists. Needs scheduled worker and live provider smoke. |

## Validation Run

| Command | Result |
|---|---|
| `npx vitest run __tests__/services/coach-kernel-strength-engine.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/services/training-plan-lifecycle.test.ts __tests__/services/training-agenda-reconciliation.test.ts __tests__/api/training-plan-generation.test.ts` | 5 files, 58 tests passed |
| `npx vitest run __tests__/api/training-routes.test.ts` | 25 tests passed |
| `npm run typecheck` | Passed |
| `npm test` | 369 files, 5,882 tests passed |

## Still Missing Scenario Tests

These should be added before claiming a complete professional coach engine:

- Beginner gym user, 3 days/week, dumbbells only.
- Intermediate full-gym hypertrophy user with role-differentiated sessions.
- Hybrid gym + running user with morning run and lunch gym constraints.
- Cycling + gym user with fatigue and interference controls.
- Travel week with hotel gym substitutions.
- Low-time week requiring compression.
- Discomfort flag requiring substitutions across movement families.
- Poor adherence requiring simpler prescriptions.
- Fatigue/plateau metrics triggering plan adjustment.
- Questionnaire data materially changing the plan.
- Sex/gender-aware adjustments only when explicit, relevant, and policy-backed.

