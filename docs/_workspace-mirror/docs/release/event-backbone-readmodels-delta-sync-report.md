# Nexus Hub Event Backbone, Read Models, Delta Sync, Jobs, and iOS Cache report

Status: current
Owner: Codex
Last verified: 2026-05-07
Branch: `feature/event-backbone-readmodels-delta-sync`
Push/deploy: not performed

## Verdict

READY_WITH_CONDITIONS.

The modular-monolith foundation is implemented locally without Kafka, Redis,
Flink, Postgres migration, WebSockets-as-truth, or service splitting. Backend
event outbox, job queue, decision log, read-model summaries, delta sync,
resource budgets, retention cleanup, and classifier mappings are present and
covered by focused behavior tests. iOS now has a scoped delta-sync store/client
and account-switch cache clearing, covered by focused simulator tests.

The remaining conditions are product-integration and rollout work: wire a
long-running/scheduled worker process before relying on async jobs in release,
adopt the summary/delta client inside the main iOS surfaces, run real iOS
interaction smoke, and run a local full-product smoke against a started engine.

## Executive summary

- Biggest implementation: SQLite-backed event/job/read-model/sync foundation
  with tenant/user scoped tests and app-safe summary payloads.
- Biggest blocker: background worker lifecycle is a foundation only; no PM2 or
  scheduler loop has been enabled for production.
- Remaining risk: iOS surfaces still use their existing loaders; the new
  sync/cache client is ready but not the source path for Home/Week/Training.
- Backend readiness: foundation ready for local QA with focused tests green.
- iOS readiness: DTO/store/client ready, no launch-only claim made.
- Release readiness: not ready to deploy until worker lifecycle and iOS
  interaction smoke are validated.

## Architecture implemented

- `event_outbox`: migration `114_event_backbone_readmodels_delta_sync.sql` and
  `src/services/event-outbox.ts`.
- `background_jobs`: migration plus `src/services/background-job-queue.ts`.
- `product_decision_logs`: migration plus
  `src/services/product-decision-log.ts`.
- `app_summary_read_models`: migration plus
  `src/services/app-summary-read-models.ts`.
- Delta sync: `src/services/delta-sync.ts` and `GET /api/v1/sync/changes`.
- iOS cache/sync: `DeltaSyncStore`, `DeltaSyncService`, and AppState cache
  clearing.
- Budgets: `src/services/resource-budgets.ts`, first concrete budget on sync
  changes.
- Observability: request/correlation/causation IDs carried through events and
  jobs; budget degradation logs are scoped and PII-free.
- Cleanup/retention: `src/tools/event-backbone-cleanup.ts`, dry-run by default.
- Release classifier: event backbone file mappings added to changed-area
  classifier.

## Event Outbox

Schema includes event id, tenant/user scope, source skill, event/entity types,
entity and schema versions, bounded JSON payload, privacy class, idempotency
key, correlation/causation/request ids, status, lease fields, retry fields,
timestamps, and last error.

Implemented behavior:
- idempotent emit by scoped idempotency key
- pending claim with lock/lease
- retry with backoff
- dead-letter after max attempts
- privacy payload redaction for sensitive keys
- app-safe event listing for delta sync
- replay helper for event types

Initial emitters added:
- Training feedback/skipped session
- Content topic create/update/delete
- Cooking recipe create as a cooking projection trigger
- Finance transaction create
- Notification intent create plus source-skill projection events
- Chat message persistence without raw chat text in the payload

## Background Jobs

Schema includes tenant/user scope, type, payload, priority, status, attempts,
max attempts, lease fields, idempotency key, correlation/causation event, and
timestamps.

Implemented behavior:
- idempotent enqueue
- pending claim with lease
- retry/backoff/dead-letter
- cancel support
- feature flag kill switch: `EVENT_BACKBONE_JOBS_DISABLED=1`

Initial handlers:
- `project_read_models`
- `training_summary_projector`
- `deliver_notification` as a safe retry hook while synchronous notification
  delivery remains source behavior
- safe stubs for content radar, calendar sync, and memory summary jobs that do
  not call providers locally

Condition: a PM2/scheduler worker loop is not enabled yet.

## Decision Log

`product_decision_logs` records scoped decisions with source skill, entity,
decision type, bounded input summaries, constraints, decision payload,
explanation code, confidence, warnings, correlation id, and event id.

The read-model projector records a projection decision with reason code
`read_model_projection`. Sensitive input fields are redacted before storage.

## Read Models / Summaries

Backend summary route surface:
- `GET /api/v1/summaries`
- `GET /api/v1/summaries/:type`
- `POST /api/v1/summaries/project`

Summary types:
- Home
- Week/Semana
- Training
- Content
- Notifications

Summaries are tenant/user scoped, versioned, bounded, timestamped, and avoid raw
private titles/details in Home-style payloads. They use direct SQLite reads only;
focused tests verify summary reads do not call model/provider/calendar work.

Fallback behavior: if a materialized row is missing/stale, the service rebuilds
the summary deterministically from existing tables.

## Delta Sync / RAMEN-lite

Endpoint:
- `GET /api/v1/sync/changes?since=<cursor>&deviceId=<deviceId>&limit=<n>&skill=<skill>`

Behavior:
- cursor is monotonic from `event_outbox.sequence`
- invalid/stale cursors return `resetRequired`
- pagination is bounded
- tenant/user scope is derived from the authenticated request
- tenant-level events are allowed only when `user_id` is null for the same
  tenant
- response omits raw payload and returns app-safe summaries
- deletes/supersedes are represented by action mapping from event type/payload
- device cursor state is persisted in `sync_cursors`

## iOS Cache / Sync

Implemented:
- `DeltaSyncStore` actor stores cursors and changes by scope key and device id
- duplicate deltas are ignored by `changeId`
- `resetRequired` clears only the current scope and stores the reset cursor
- `clearAll()` is called from AppState process-wide cache clearing on logout or
  scope reconciliation
- `DeltaSyncService` fetches summary envelopes and delta changes through direct
  REST endpoints

Not claimed:
- Home/Week/Training/Content/Notifications UI adoption
- background task execution
- real iOS interaction smoke

## Budgets / Circuit Breakers

Implemented:
- reusable budget counter keyed by tenant/user/budget/window
- unique window counter index to avoid duplicate counters
- `sync_changes` route budget: 120 requests per user/minute
- page-size cap helper for sync changes
- safe 429/degraded response with no private payload

Follow-up candidates:
- provider calls per user/minute
- content radar scans per tenant/day
- notification attempts per user/minute
- calendar sync jobs per user/hour

## Observability

Implemented:
- event ids, job ids, correlation ids, causation ids, request ids
- worker result counts
- scoped budget degradation logs
- decision log reason codes

Privacy policy:
- no raw prompt/chat/content/finance/calendar/token fields are written to event
  payloads or decision input summaries by the new helpers
- delta sync exposes summaries only, not raw event payloads

## Cleanup / Retention

`src/tools/event-backbone-cleanup.ts` supports:
- dry-run default
- `--apply`
- `--retention-days`
- `--protect-newest`
- `--json`
- processed events, completed/canceled jobs, old decision logs, old sync cursors

Dead-letter events/jobs are intentionally retained for investigation.

## Release classifier

`scripts/changed-area-classifier.sh` now detects:
- event outbox
- job queue
- decision log
- read models
- delta sync
- resource budgets
- summary/sync routes
- event backbone migration/tests
- domain route changes for Training/Cooking/Content/Finance/Secretary

Classifier output for the current branch includes:
- cannot-skip: `event-backbone-jobs-sync-tenant-isolation`
- focused tests: event backbone service/API tests plus notification/security and
  affected domain globs
- T2/T4 coverage when event backbone files change

## Security and privacy

Validated by focused tests:
- event emit rejects invalid tenant/user scope
- delta sync does not return another tenant/user change
- summaries do not expose another user's notification item
- chat event payload records lengths/domain metadata, not raw user/assistant text
- budget keys are tenant/user scoped
- cleanup preserves dead letters

## Local full-product smoke

API-level flow is covered by focused tests:
1. emit event
2. worker enqueues read-model job
3. job projects summaries
4. summary endpoint returns scoped summary
5. delta sync returns scoped changes
6. duplicate deltas are handled by iOS store test
7. cleanup preserves dead-letter investigation rows

Blocked/not claimed:
- started-engine smoke
- iOS real interaction smoke
- portal/browser smoke

## Tests run

Backend:
- `npx tsc --noEmit` PASS
- `npm run verify` PASS, 478 files / 7054 tests
- `npx vitest run __tests__/services/event-backbone.test.ts __tests__/api/event-backbone-routes.test.ts --reporter=default` PASS, 11/11
- `npx vitest run __tests__/services/notification-orchestrator.test.ts __tests__/api/notifications-routes.test.ts __tests__/security/notification-orchestrator-security.test.ts --reporter=default` PASS, 37/37
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts --reporter=default` PASS, 23/23
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence` PASS, 23/23
- `node scripts/vi-mock-completeness-lint.mjs --strict` PASS, 826 partial mocks against the 827 ceiling

iOS:
- XcodeBuildMCP `test_sim -only-testing:Nexus HubTests/DeltaSyncStoreTests` PASS, 4/4 on iPhone 17 Pro simulator

Docs:
- `npm run docs:audit` PASS with current known ceiling state: 463 issues / 435 audited after workspace mirror refresh

Blocked:
- full local engine + iOS interaction smoke was not run in this pass
- production APNs/silent push/background sync not in scope

## Area status

| Area | Status |
|---|---|
| Workspace preservation | IMPLEMENTED_AND_VALIDATED |
| Architecture inventory | IMPLEMENTED_AND_VALIDATED |
| Event outbox | IMPLEMENTED_AND_VALIDATED |
| Background job queue foundation | IMPLEMENTED_AND_VALIDATED |
| Production worker loop | DEFERRED_WITH_OWNER_DECISION_REQUIRED |
| Decision log | IMPLEMENTED_AND_VALIDATED |
| Backend summaries/read models | IMPLEMENTED_AND_VALIDATED |
| Delta sync endpoint | IMPLEMENTED_AND_VALIDATED |
| iOS cache/sync DTO/store/client | IMPLEMENTED_AND_VALIDATED |
| iOS summary UI adoption | DEFERRED_WITH_OWNER_DECISION_REQUIRED |
| Resource budgets | IMPLEMENTED_AND_VALIDATED |
| Observability baseline | IMPLEMENTED_AND_VALIDATED |
| Retention cleanup | IMPLEMENTED_AND_VALIDATED |
| Release classifier mapping | IMPLEMENTED_AND_VALIDATED |
| Full-product local smoke | BLOCKED_WITH_EXACT_REASON: no local engine/iOS smoke run was started in this pass; API-level flow is covered by focused tests only |

## Open items

P0:
- none known from this implementation pass.

P1:
- Enable a controlled worker lifecycle for event/job processing before release
  depends on async jobs.
- Run local full-product smoke with a started engine and one simulator: create or
  update a domain entity, process event/job, verify summary and delta, verify no
  cross-user leakage.

P2:
- Adopt summaries and delta sync in Home, Week/Semana, Training, Content, and
  Notifications UI paths with request dedupe and account-switch checks.
- Expand resource budgets to provider, calendar, content radar, and notification
  attempts.
- Decide whether retention cleanup should be scheduled in `midnight_cleanup` or
  operator-run only.
- Add summary freshness telemetry to `/health/detailed` once worker loop is live.

P3:
- Add a compact operator runbook for event replay and dead-letter triage.
- Consider a tiny admin-only event/job diagnostics route after permissions are
  explicitly reviewed.

## Cleanup status

- No push performed.
- No deploy performed.
- No production data/calendars/push used.
- No long-running backend worker started.
- iOS simulator was used for focused tests only; no app-launch validation was
  claimed.

## Final recommendation

Keep this branch in local QA as a foundation branch, not a production deploy
candidate. The backend substrate is useful and test-backed; the iOS cache client
is ready for integration. Before release, wire the worker lifecycle, adopt the
summary/delta paths in user-facing surfaces, and run real interaction smoke.
