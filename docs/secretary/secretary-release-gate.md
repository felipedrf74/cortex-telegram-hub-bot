# Secretary Release Gate

## Verdict

PASS WITH CONDITIONS.

Secretary now has a tested scheduling-arbitrator foundation, but it is not ready for an unconditional production release as the central scheduling authority until source-skill adapters, provider sync, and iOS-facing lifecycle APIs are wired and smoked.

## Evidence Summary

| Gate | Result | Evidence |
| --- | --- | --- |
| Scheduling intent contract | PASS | Implemented in `src/services/secretary-scheduling-arbitrator.ts`; documented in `secretary-scheduling-intent-model.md`. |
| Agenda item ownership | PASS | Persists into `secretary_agenda_items` with source skill, source intent, user/tenant scope, lifecycle, provider sync state, version, and decision reasons. |
| Source skill attribution | PASS | Tests cover Training, Cooking, Finance, Content, and Secretary-origin follow-up/reminder intents. |
| Lifecycle states | PASS | Tests cover `scheduled`, `compressed`, `unscheduled`, `reflowed`, and `superseded`. |
| Decision reasons | PASS | Reason codes include availability, reflow, compression, Finance deadline priority, Training/Cooking/Content source context, and no-valid-slot fallback. |
| Priority/capacity model | PASS | Batch arbitration orders competing intents by priority/deadline/source weight and prevents accepted slots from being reused. |
| Reflow/compression/unscheduled states | PASS | Focused tests prove all three. |
| Source skill feedback | PASS | Decisions return feedback with status, scheduled time, reason codes, downstream implications, and refresh requirement. |
| Duplicate retry prevention | PASS | Unchanged retry returns the same agenda item and does not duplicate ledger rows. |
| Stale agenda replacement | PARTIAL PASS | Changed-capacity reflow supersedes old rows; provider-deleted/provider-stale repair remains future work. |
| Local full-product backend smoke | PASS | Isolated runner build/start/authenticated API smoke passed 13/13 endpoints. |
| iOS render smoke for new states | BLOCKED | New ledger is not exposed through a live iOS-facing API yet. |

## Test Run

Focused tests:

```bash
npm test -- --run __tests__/services/secretary-scheduling-arbitrator.test.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       9 passed (9)
```

Typecheck:

```bash
npm run typecheck
```

Result: PASS.

Local full-product runner:

```bash
FULL_NEXUS_STATE_DIR="$PWD/.local/secretary-full-product-smoke-20260429T115832Z" \
DATABASE_PATH="$PWD/data/secretary-full-product-smoke-20260429T115832Z.db" \
PORTAL_PORT=8211 \
FULL_NEXUS_BASE_URL="http://127.0.0.1:8211" \
IOS_INVITE_CODE="local-secretary-smoke" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
NEXUS_LOCAL_RUN_AUTH_SMOKE=1 \
scripts/full-nexus-local-engine.sh smoke
```

Result: 13/13 authenticated API smoke endpoints passed.

## P0 Blockers

None found in the implemented Secretary arbitrator foundation.

## P1 Release Conditions

| ID | Condition | Required before unconditional release |
| --- | --- | --- |
| SEC-P1-01 | Wire source skills into the arbitrator. | Training sessions, Cooking prep/grocery/cooking blocks, Finance reminders/reviews, and Content writing/editing/publishing blocks must submit real scheduling intents in production paths. |
| SEC-P1-02 | Add provider sync/reconciliation. | Google/Outlook/local mock provider lifecycle must consume Secretary agenda rows, update provider ids/state, prevent duplicate event creation on retry, and repair provider stale/deleted events. |
| SEC-P1-03 | Expose Secretary ledger through API. | iOS-facing Secretary/calendar endpoints must return lifecycle state, source skill, decision reasons, reflow/compression/unscheduled status, and provider sync state. |
| SEC-P1-04 | Run iOS simulator smoke for new states. | After API exposure, iOS must render scheduled/reflowed/compressed/deferred/unscheduled/canceled/superseded states without flattening them. |
| SEC-P1-05 | Add end-to-end local Secretary runner scenario. | The local full-product runner should include a dedicated Secretary orchestration command, not just service tests plus generic API health. |

## P2 Follow-Ups

| ID | Item |
| --- | --- |
| SEC-P2-01 | Expand `splittable` intent behavior into multi-segment scheduling. |
| SEC-P2-02 | Expand recurrence into concrete reminder/follow-up occurrences. |
| SEC-P2-03 | Add observability counters for decision status, reason code, source skill, and provider sync failures. |
| SEC-P2-04 | Add repair tests for external provider deletion/move once provider sync exists. |

## Exact Release Recommendation

Do not market or ship Secretary as the full central scheduling authority yet.

Safe to continue to the next implementation batch:

1. Add adapters from Training/Cooking/Finance/Content into `submitSecretarySchedulingIntent` / `arbitrateSecretarySchedulingIntents`.
2. Expose read-only Secretary agenda ledger data through a scoped iOS API.
3. Add provider sync and stale/duplicate repair over `secretary_agenda_items`.
4. Run local full-product Secretary smoke again with real API scenarios.
5. Run iOS simulator smoke after the API can render the new states.
