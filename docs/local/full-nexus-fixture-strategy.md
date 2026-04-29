# Full Nexus Fixture Strategy

Date: 2026-04-29
Default policy: deterministic local fixtures first, real providers only by explicit bounded opt-in

## Principle

Local full-product validation should use the real local backend, real local
auth/session, real tenant/user scoping, and deterministic local data.

Do not use production data. Do not use production calendars. Do not spend model
tokens unless the specific smoke requires reasoning-quality evidence.

## Fixture Types

| Fixture type | Use when | Command/source |
| --- | --- | --- |
| Local auth/user fixture | Any authenticated API or iOS simulator smoke | `scripts/full-nexus-local-engine.sh auth-token` |
| Chat tenant fixture | Tenant isolation, prompt context scope, tool callback scope, attachment path safety | `scripts/full-nexus-local-engine.sh chat-tenant-smoke` |
| Cross-skill contract fixture | Training/Secretary/Cooking/Finance/Content orchestration contract checks without DB/provider writes | `scripts/full-nexus-local-engine.sh cross-skill-fixtures` |
| Chat evaluation fixture | Chat routing, safety, day-to-day interaction rubric without provider calls | `scripts/full-nexus-local-engine.sh chat-eval` |
| Native task fixture | Secretary/task UI and due-date smoke | `POST /api/v1/tasks` with local auth token |
| Cooking/Training persisted demo | iOS/API rows for meal plan, recipes, shopping list, Training plan, sessions, and Training signals | `npx tsx scripts/seed-cooking-training-demo.ts --user-id <id>` |
| Finance persisted demo | Budget constraints and finance admin context | `POST /api/v1/finance/transactions` or `npx tsx scripts/seed-fiscal-bundle-demo.ts --user-id <id>` |
| Content references | Content books, channels, and radar preferences | `/api/v1/content/books`, `/api/v1/content/channels`, `/api/v1/content/radar-preferences` |
| Local calendar/agenda mock | Calendar lifecycle shape without Google/Outlook writes | Native task/agenda fixtures and service/unit tests |
| Staging provider fixture | Google/Outlook read-back, external mutation, provider retry | Staging-only smoke, never production calendars |
| Real model call | Response quality, fallback metadata, operator override proof | Explicit `NEXUS_LOCAL_ALLOW_MODEL_CALLS=1`, bounded run, usage recorded |

## What Must Be Real Locally

These should use the actual local backend, not static JSON:

- auth/session
- JWT validation
- user ID and tenant ID propagation
- route authorization
- Chat history persistence
- native task persistence
- finance transaction persistence
- content reference persistence
- iOS API decoding
- iOS local backend connection
- cache invalidation after local writes where route-supported

## What Can Be Deterministic Fixtures

These are acceptable as deterministic fixtures for local smoke:

- Chat day-to-day conversation evaluation
- Chat response sufficiency rubric
- Training/Secretary/Cooking/Finance/Content contract bundles
- rich iOS rendering states
- cross-skill priority/context examples
- prompt-injection attack strings
- provider failure simulations
- no-valid-slot / overloaded-day UI states

Fixture success must be described as fixture success, not production/provider
success.

## What Must Not Be Faked

These require staging or device validation:

- real Google Calendar create/update/delete/read-back
- real Outlook Calendar create/update/delete/read-back
- external provider deletion/move events
- Apple Health and Apple Watch data recognition
- APNs token upload and delivery
- production billing side effects
- unrestricted model-provider fallback behavior
- production tenant migration/backfill behavior

## Default Model/Provider Strategy

Default local smoke:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0
```

The runner blanks:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`

and sets:

```text
ANTHROPIC_ENABLED=false
```

This protects cost and avoids accidental production-like model traffic.

Bounded real-provider validation:

```bash
NEXUS_LOCAL_ALLOW_MODEL_CALLS=1 scripts/full-nexus-local-engine.sh chat-eval
```

Only use this when a release gate explicitly needs model-routing or
reasoning-quality evidence. Record:

- provider
- model
- tier
- task type
- category tag
- fallback used or not
- fallback reason
- latency
- token/cost estimate where available
- confirmation that no production data was sent

## Seed Coverage By Product Area

### Chat

Seed command:

```bash
scripts/full-nexus-local-engine.sh chat-tenant-smoke
```

Covers:

- Tenant A/User A
- Tenant B/User B
- tenant-specific conversation markers
- tenant-specific memory markers
- attachment probe
- scoped callback/tool probe
- prompt-construction scope probe
- prompt-injection no-leak probe

### Secretary

Local default:

- native tasks
- deterministic agenda/conflict fixtures
- cross-skill fixture checks

Seed command:

```bash
POST /api/v1/tasks
```

Real provider calendar writes:

- not local by default
- staging-only

### Training

Persisted demo:

```bash
npx tsx scripts/seed-cooking-training-demo.ts --user-id <id>
```

Fixture contract:

```bash
scripts/full-nexus-local-engine.sh cross-skill-fixtures
```

### Cooking

Persisted demo:

```bash
npx tsx scripts/seed-cooking-training-demo.ts --user-id <id>
```

This creates recipes, meal plans, shopping list, and training-adjacent fueling
signals.

### Finance

API seed:

```bash
POST /api/v1/finance/transactions
```

Fiscal bundle demo:

```bash
npx tsx scripts/seed-fiscal-bundle-demo.ts --user-id <id>
```

### Content Creation

API seeds:

```bash
POST /api/v1/content/books
POST /api/v1/content/channels
PUT  /api/v1/content/radar-preferences
```

### iOS

Use the real app with local backend URL and DEBUG local auth import:

```text
-nexus_debug_local_auth_import YES
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8200
NEXUS_LOCAL_AUTH_IMPORT_PATH=<absolute local auth JSON path>
```

## Fixture Quality Bar

Every fixture must be:

- deterministic
- tenant/user scoped
- local-only
- safe to delete
- documented with the product behavior it proves
- explicit about what it does not prove

Any fixture that creates records must be tied to a local user ID and should be
removed by deleting the local DB or running `FULL_NEXUS_RESET_DB=1
scripts/full-nexus-local-engine.sh cleanup`.

## Current Gaps

- No single persisted seed script creates every rich full-product persona.
- Same-user multi-workspace switching remains partial in local smoke.
- Calendar mock behavior is split between tasks/service tests and docs.
- WebSocket streaming/reconnect fixtures are not part of `full-smoke`.
- Portal/browser smoke is not automated.
- Real provider fallback/override validation is opt-in and not part of default smoke.

## Recommended Next Fixture Work

1. Add `scripts/full-nexus-seed-personas.ts`.
2. Seed a normal user, low-capacity user, travel user, multi-skill heavy user, and tenant admin.
3. Add persisted Secretary agenda/conflict fixtures that do not require Google/Outlook.
4. Add Content and Finance constraints to the same persona seed.
5. Add a same-user tenant-switch fixture if product support is expanded.
6. Add fixture IDs to smoke output so iOS screenshots and backend rows can be correlated.
