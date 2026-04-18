# iOS Integration — Multi-Skill Plan API

## Status

These endpoints are available only when `NEXUS_MULTISKILL_MESH=on`.
The current iOS app does not call them yet, so this is a backend contract for future integration.

## Endpoints

- `GET /api/v1/plan/week`
- `GET /api/v1/plan/today`
- `POST /api/v1/plan/recompute`
- `GET /api/v1/plan/week/explain` (`max` or `owner` only)

All success responses use:

```json
{ "ok": true, "data": { ... } }
```

All failures use:

```json
{ "error": { "code": "STRING_CODE", "message": "Human message", "details": {} } }
```

## `/api/v1/plan/week` shape

```json
{
  "ok": true,
  "data": {
    "weekStart": "2026-04-13",
    "weekEnd": "2026-04-19",
    "generatedAt": "2026-04-14T10:00:00.000Z",
    "variant": "steady",
    "degraded": false,
    "gated": { "skills": [] },
    "garmin_stale": false,
    "conflicts": [
      {
        "id": "2026-04-17:availability:1",
        "date": "2026-04-17",
        "target": "availability",
        "signalIds": [11, 12],
        "signalTypes": ["travel_window", "sponsor_deliverable_due"],
        "meshPriority": 1,
        "message": "Same-priority conflict on 2026-04-17: Travel blocks Friday vs Sponsor deliverable is due Friday"
      }
    ],
    "creativeCopy": {
      "headline": "This week stays balanced across training, focus, and recovery.",
      "note": "Training, cooking, and content align cleanly around Wednesday."
    },
    "summary": {
      "sessionCount": 4,
      "mealCount": 12,
      "activeConflictCount": 1
    },
    "days": [
      {
        "date": "2026-04-15",
        "weekday": "Wednesday",
        "headline": "Energy and calendar line up well for filming here.",
        "training": {
          "title": "Track intervals",
          "type": "run",
          "status": "planned",
          "durationMinutes": 60,
          "intensity": "Hard",
          "reason": "High adherence keeps the planned stimulus intact.",
          "decisions": [
            {
              "summary": "Recovery takes priority on this day",
              "signalId": 8,
              "signalType": "rest_day_scheduled",
              "meshPriority": 2
            }
          ]
        },
        "meals": [
          {
            "mealType": "dinner",
            "title": "High-protein bowl",
            "note": "Training load is high — keep this meal supportive for the harder session.",
            "decisions": []
          }
        ],
        "content": {
          "status": "scheduled",
          "title": "Filming block ready",
          "note": "Recovery and calendar line up for filming.",
          "blockStart": "2026-04-15T11:00:00.000Z",
          "blockEnd": "2026-04-15T13:00:00.000Z",
          "decisions": [
            {
              "summary": "Filming slot is ready to lock",
              "signalId": 12,
              "signalType": "shoot_day_locked",
              "meshPriority": 3
            }
          ]
        },
        "secretary": {
          "focusBlock": {
            "start": "2026-04-15T09:00:00.000Z",
            "end": "2026-04-15T10:30:00.000Z",
            "note": "Best focus block of the week."
          },
          "pendingTasks": 3,
          "overdueTasks": 1,
          "travel": false,
          "busy": false,
          "decisions": []
        },
        "finance": {
          "budgetNote": null,
          "taxNote": null,
          "subscriptionNote": null,
          "decisions": []
        }
      }
    ]
  }
}
```

## Notes for iOS

- `degraded=true` means the plan is still valid, but creative copy is intentionally blank.
- `gated.skills` lists domains withheld by tier.
- `garmin_stale=true` means wearable freshness is degraded and the plan leaned on the latest coach snapshot.
- `conflicts` must be rendered honestly; do not silently hide them in client logic.
