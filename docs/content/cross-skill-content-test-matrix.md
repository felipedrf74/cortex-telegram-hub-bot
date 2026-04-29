# Cross-Skill Content Test Matrix

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Automated Tests

Command:

```bash
npm test -- --run __tests__/services/content-cross-skill-orchestration.test.ts
```

Result:

- PASS: 1 file / 8 tests.

## Coverage Matrix

| Scenario | Status | Evidence |
|---|---:|---|
| Training milestone becomes content idea with permission | Passed | Permitted Training milestone creates Content Radar signal and converts to workflow idea. |
| Secretary availability affects content cadence | Passed | Secretary availability signal lowers production feasibility and emits cadence implication. |
| Finance constraint affects content workflow | Passed | Finance budget constraint is summarized/anonymized and produces low-cost workflow implication. |
| Chat recurring question becomes Content Radar signal | Passed | Chat recurring question produces tenant-scoped Radar signal with source attribution. |
| Sensitive signal requires review | Passed | Training recovery signal without permission is `review_required`. |
| Cross-tenant signal rejected | Passed | Signal with mismatched `sourceTenantId` creates no Radar state. |
| Duplicate cross-skill warning prevented | Passed | Repeated source signal upserts to one Radar row. |
| Content emits Secretary/Chat signals | Passed | Secretary scheduling intents and Chat status signals include tenant/user scope. |

## Additional Validation Needed

| Scenario | Status | Notes |
|---|---:|---|
| Runtime Training hook | Pending | Service exists; source skill event hook still needs integration. |
| Runtime Cooking hook | Pending | Service exists; source skill event hook still needs integration. |
| Runtime Finance hook | Pending | Service exists; source skill event hook still needs integration and audit. |
| Runtime Secretary hook | Pending | Service exists; availability/cadence feed still needs integration. |
| Runtime Chat hook | Pending | Service exists; recurring-question extraction still needs integration. |
| Local full-product cross-skill smoke | Pending | Needs full local engine run with Chat, Secretary, Training, Cooking, Finance, and Content. |
| iOS/portal signal rendering | Pending | Clients need source/review/downstream implication DTOs and UI. |

## Release Gate

Backend foundation verdict: PASS WITH CONDITIONS.

Do not claim full production cross-skill Content orchestration until runtime hooks, approval UX, and full local smoke are complete.
