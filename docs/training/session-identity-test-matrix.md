# Session Identity Test Matrix

| Case | Coverage | Result |
|---|---|---|
| Stable logical key excludes version/shape | `__tests__/services/training-session-identity.test.ts` | Passing |
| Cosmetic text does not change shape hash | `__tests__/services/training-session-identity.test.ts` | Passing |
| Material exercise/prescription change changes shape hash | `__tests__/services/training-session-identity.test.ts` | Passing |
| Migration adds identity/hash columns | `__tests__/services/training-plan-lifecycle.test.ts` | Passing |
| Ownership stores identity/hash | `__tests__/services/training-plan-lifecycle.test.ts` | Passing |
| Same identity + shape can be reused across plan versions | `__tests__/services/training-plan-lifecycle.test.ts` | Passing |
| Changed shape blocks reuse | `__tests__/services/training-plan-lifecycle.test.ts` | Passing |
| Persisted sessions receive identity/hash | `__tests__/api/training-plan-persistence.test.ts` | Passing |
| Calendar create payload includes Nexus identity marker | `__tests__/api/training-plan-persistence.test.ts` | Passing |
| Same-title/date unmarked event is not claimed | `__tests__/api/training-plan-calendar-sync.test.ts` | Passing |
| Marker-matched orphan event is linked without duplicate creation | `__tests__/api/training-plan-calendar-sync.test.ts` | Passing |
| Prior-version same-shape event is reused and updated | `__tests__/api/training-plan-calendar-sync.test.ts` | Passing |
| Same identity but changed shape creates replacement and deletes stale event | `__tests__/api/training-plan-calendar-sync.test.ts` | Passing |
| Cancellation deletes linked and ownership-table events | `__tests__/api/training-plan-cancellation.test.ts` | Passing |
| Cancellation deletes marker-identified orphan events | `__tests__/api/training-plan-cancellation.test.ts` | Passing |
| Cancellation refuses title/date-only orphan deletion | `__tests__/api/training-plan-cancellation.test.ts` | Passing |
| Type safety for changed contracts | `npm run typecheck` | Passing |

## Commands Run

```bash
npm test -- --run __tests__/services/training-session-identity.test.ts __tests__/services/training-plan-lifecycle.test.ts __tests__/api/training-plan-persistence.test.ts __tests__/api/training-plan-calendar-sync.test.ts __tests__/api/training-plan-cancellation.test.ts
npm run typecheck
```
