# Backend runtime iOS usability audit

Date: 2026-05-02

Branch: `feature/backend-runtime-ios-usability-performance-audit`

Base commit: `53f580a chore: bump version to 4.14.112 [deploy]`

Rollback marker: `backup/backend-runtime-ios-usability-before-audit-20260502-0218`

## Scope

This pass audited the backend/runtime paths used by the iOS app during:

- Home
- Chat
- Tasks / Secretary
- Areas / Skills catalog
- More / settings / connections
- Week / Semana
- Training
- Cooking / Finance / Content read surfaces

The primary question was whether backend/runtime behavior can make iOS navigation feel slow, frozen, or unreliable.

## Runtime map

Local runner:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh up
```

Local API: `http://127.0.0.1:8200`

Local DB: `data/local-full-nexus-smoke.db`

Fixture/model gate: `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`

The local engine initialized provider routing in fixture mode:

- classify: `fixture -> none`
- chat: `fixture -> none`
- tool-use: `fixture -> none`

No production data or production calendars were used.

## Key finding

Individual app-facing endpoints were fast locally, but all authenticated routes previously shared one 60 request/minute per-user bucket. The iOS app can legitimately exceed that during rapid tab switching, first-load bootstrap, Home + Week/Semana navigation, and repeated screen appearances.

That means the backend could return `429 RATE_LIMITED` during normal read-heavy app usage, making screens look stuck even though the underlying route handlers are fast.

## Fix applied

Authenticated `GET` and `HEAD` requests now use a separate read bucket:

- non-read authenticated requests: `IOS_API_RATE_LIMIT`, default `60/min`
- authenticated read requests: `IOS_API_READ_RATE_LIMIT`, default `300/min`

Mutation, chat, and model-triggering POST routes remain on the tighter bucket.

## Safety

The fix does not weaken:

- JWT authentication
- tenant scoping
- mutation limits
- unauthenticated/IP limits
- internal route limits
- model/provider routing

The read bucket only changes authenticated idempotent `GET`/`HEAD` request capacity.

