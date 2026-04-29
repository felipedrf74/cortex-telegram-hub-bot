# Content Secretary-Owned Scheduling Actions

Date: 2026-04-29
Branch: `feature/content-editorial-mutation-contracts`

## Audit Findings

- `requestContentScheduleThroughSecretary()` already created Secretary agenda ledger rows and stored `secretary_agenda_item_id` on Content workflow objects.
- The live app-facing editorial action route still treated `schedule_content` as a local lifecycle transition, so iOS/portal could call an action without proving Secretary placement, reflow, or feedback.
- Tenant-shared Content scheduling had an approval gate, but the route-level schedule path needed to preserve that gate before any Secretary placement.

## Implementation Notes

`POST /api/v1/content/workflow/:id/actions` now treats `action = "schedule_content"` as a Secretary-owned scheduling action.

Behavior:

- Reads the Content workflow object through the existing tenant/user scoped route guard.
- Preserves tenant-shared approval gating before Secretary placement.
- Submits a typed Content scheduling intent to Secretary.
- Persists the returned Secretary agenda item id on the Content object.
- Returns the Secretary decision, agenda item, and source-skill feedback to the client.
- Invalidates Content derived caches after a successful scheduling decision.

Request additions for `schedule_content`:

```json
{
  "action": "schedule_content",
  "durationMinutes": 75,
  "minimumDurationMinutes": 45,
  "preferredWindows": [
    {
      "start": "2026-05-01T10:00:00.000Z",
      "end": "2026-05-01T12:00:00.000Z",
      "label": "deep work"
    }
  ],
  "unavailableWindows": [
    {
      "start": "2026-05-01T10:00:00.000Z",
      "end": "2026-05-01T11:00:00.000Z",
      "label": "new meeting"
    }
  ],
  "deadline": "2026-05-03T17:00:00.000Z",
  "priority": "high",
  "flexibility": "flexible",
  "approvalConfirmed": true,
  "reason": "Schedule approved editorial production block."
}
```

Response includes:

```json
{
  "workflow": {
    "ok": true,
    "status": "scheduled",
    "reasonCodes": ["scheduled_in_available_window", "content_focus_request"],
    "secretaryIntentId": "content:42:schedule",
    "secretaryAgendaItemId": "agenda_..."
  },
  "object": {
    "editorialState": "scheduled",
    "secretaryIntentId": "content:42:schedule",
    "secretaryAgendaItemId": "agenda_..."
  },
  "scheduling": {
    "status": "scheduled",
    "selectedSlot": {
      "start": "2026-05-01T10:00:00.000Z",
      "end": "2026-05-01T11:15:00.000Z"
    },
    "feedback": {
      "sourceSkill": "content",
      "shouldRefreshSource": false
    }
  },
  "agendaItem": {
    "sourceSkill": "content",
    "lifecycleState": "scheduled",
    "providerSyncState": "not_synced"
  },
  "feedback": {
    "sourceSkill": "content",
    "status": "scheduled"
  }
}
```

Non-placement decisions such as `unscheduled`, `deferred`, or `needs_more_context` are returned as valid Secretary decisions with HTTP `202`, not as server failures.

## Tests Added

- Route-level `schedule_content` creates a Secretary agenda item and stores agenda identity on the Content object.
- Route-level `schedule_content` reflows when a newly supplied unavailable window conflicts with the previous placement.
- Route-level tenant-shared scheduling blocks before approval and creates the Secretary agenda item only after confirmation.
- Existing service-level Secretary handoff and Secretary arbitrator tests remain in the focused validation set.

## Local Smoke Results

Focused local backend smoke used deterministic in-memory SQLite fixtures. No production data, provider calls, iOS simulator, calendar provider, or deployment was used.

```bash
npm test -- --run __tests__/api/content-editorial-routes.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts
npm run typecheck
git diff --check
```

Results: PASS.

- Content editorial API/service/Secretary scheduling slice: 3 files / 28 tests passed.
- Typecheck: passed.
- Diff whitespace check: passed.

## Open Blockers

- Provider-backed Google/Outlook calendar staging smoke remains separate.
- iOS and portal still need to render the returned `scheduling`, `agendaItem`, and `feedback` states.
- This backend smoke does not claim full local full-product engine or iOS simulator coverage.

## Release-Gate Verdict

PASS for backend live Content scheduling actions through Secretary.

PASS WITH CONDITIONS for end-to-end product readiness until frontend rendering and provider calendar smoke are completed or explicitly scoped out.
