# Content Notification Deep-Link Resolver

Date: 2026-04-29
Branch: `feature/content-editorial-mutation-contracts`

## Audit Findings

- Content notifications were durable and user-scoped through `content_notifications`.
- The generic inbox supported list, mark-read, and resolve actions under `/api/v1/notifications`.
- iOS/portal clients did not have a Content-specific resolver to open the exact script, topic, approval, source-review, radar signal, reference, or workflow object from a notification.
- Existing notification data payloads are not consistent enough to rely on one artifact key, so the resolver needs a safe target-selection layer and fallback.

## Implementation Notes

Added `GET /api/v1/content/notifications/:id`.

The route:

- Enforces authenticated user scope before reading the notification.
- Uses `id + user_id` lookup, not title/date matching.
- Is read-only and does not mark the notification as read or resolved.
- Returns the original notification plus a `deepLink` object.
- Falls back to Content Home when no concrete artifact id is present.

Response contract:

```json
{
  "ok": true,
  "data": {
    "contractVersion": 1,
    "notification": {
      "id": 123,
      "userId": 501,
      "type": "script_ready",
      "title": "Script ready",
      "body": "Review draft",
      "data": { "scriptId": "script_42" },
      "status": "unread",
      "createdAt": "2026-04-29T21:30:00.000Z"
    },
    "deepLink": {
      "targetKind": "script",
      "targetId": "script_42",
      "screen": "contentScript",
      "route": "content/scripts/script_42",
      "action": "open_script",
      "canOpenConcreteTarget": true,
      "reasonCodes": ["script_target"],
      "fallback": {
        "screen": "contentHome",
        "route": "content/home"
      },
      "markReadEndpoint": "/api/v1/notifications/123/read",
      "resolveEndpoint": "/api/v1/notifications/123/resolve",
      "sourceDataKeys": ["scriptId"]
    }
  }
}
```

Supported target kinds:

- `approval`
- `source_review`
- `workflow_object`
- `script`
- `topic`
- `radar_signal`
- `reference`
- `pipeline_item`
- `weekly_package`
- `performance`
- `agent_insight`
- `content_home`

## Tests Added

- Service lookup is scoped to notification owner.
- Service resolver handles script notifications.
- Service resolver handles approval and source-review actions.
- Service resolver falls back to Content Home for unknown/legacy payloads.
- Service resolver denies cross-user notification lookup.
- API route returns resolver payload.
- API route denies cross-user notification access.
- API route rejects invalid ids and invalid user scope.
- Structural test verifies Content route registration.

## Local Smoke Results

Focused local backend checks were run with deterministic in-memory SQLite fixtures only. No production data, provider calls, iOS simulator, or deployment was used.

```bash
npm test -- --run __tests__/services/content-notifications.test.ts __tests__/api/content-notification-routes.test.ts
npm test -- --run __tests__/api/content-notification-routes.test.ts __tests__/api/content-editorial-routes.test.ts __tests__/api/content-home-route.test.ts
npm run typecheck
git diff --check
```

Results: PASS.

- Notification service/API resolver slice: 2 files / 31 tests passed.
- Content API registration/editorial/home slice: 3 files / 11 tests passed.
- Typecheck: passed.
- Diff whitespace check: passed.

## Open Blockers

- iOS still needs to call `GET /api/v1/content/notifications/:id` and route the returned `targetKind`/`screen` safely.
- Portal deep-link UX still needs to adopt the same resolver if portal notification cards should navigate to exact Content artifacts.
- Legacy notifications without artifact IDs intentionally fall back to Content Home; that is not a backend failure, but clients should present it as a broad destination.

## Release-Gate Verdict

PASS for the backend resolver contract.

PASS WITH CONDITIONS for end-to-end notification deep links because iOS/portal routing remains outside this backend-only change.
