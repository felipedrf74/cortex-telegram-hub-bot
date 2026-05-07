# Nexus Hub Event Backbone, Read Models, Delta Sync, Jobs, and iOS Cache report

Status: current
Owner: Codex
Last verified: 2026-05-07
Branch: `feature/event-backbone-readmodels-delta-sync`
Engine commits:
- `887ada0eaf7e9e6ce09eab275a1c888f73916251` - foundation
- `25133368371dafb967dc7a4f89a7360ea464fb79` - worker lifecycle, retention hook, summary budgets
iOS commits:
- `2f3be83de91f3dae646ee9c49bda89f5eb73a315` - delta sync store/service foundation
- `9ff725dca44d1603c9dee82f6f1ef3b2d83be320` - app-surface summary/delta warmup
Push/deploy: not performed

## Verdict

READY_WITH_CONDITIONS.

The Nexus-sized modular-monolith foundation is implemented locally without
Kafka, Redis, Flink, Postgres migration, WebSockets-as-truth, or service
splitting. Backend event outbox, job queue, decision log, read-model
summaries, delta sync, resource budgets, scheduled worker processing,
retention cleanup, and classifier mappings are present and covered by
behavior tests. iOS now has a scoped delta-sync repository/cache and warms
summary/delta state from Home, Training, Content, Notifications, AppState
bootstrap, and foreground refresh paths.

The remaining conditions are validation and rollout conditions, not missing
foundation code:
- authenticated iOS product-screen interaction still needs a valid local or
  signed test account session; simulator validation reached onboarding/auth
  and did not claim app-surface QA
- production/staging must explicitly decide the worker and cleanup flags before
  deploy (`EVENT_BACKBONE_WORKER_DISABLED`, batch limits,
  `EVENT_BACKBONE_CLEANUP_APPLY`)
- future product work can gradually render from summary read models instead of
  only warming them in the background

## Executive summary

- Biggest implementation: SQLite-backed event/job/read-model/sync foundation
  with scheduled processing and scoped iOS cache readiness.
- Biggest blocker: no authenticated iOS product-screen interaction was
  available in this local simulator run.
- Remaining risk: summary read models are warmed and tested but not yet the
  primary visible source of truth for every screen.
- Backend readiness: implemented and validated for local QA.
- iOS readiness: store, repository, app-surface warmup, scope invalidation, and
  URLProtocol tests are green.
- Release readiness: source is QA-ready; no push/deploy performed.

## Architecture implemented

- `event_outbox`: migration `114_event_backbone_readmodels_delta_sync.sql` and
  `src/services/event-outbox.ts`.
- `background_jobs`: migration plus `src/services/background-job-queue.ts`.
- `product_decision_logs`: migration plus
  `src/services/product-decision-log.ts`.
- `app_summary_read_models`: migration plus
  `src/services/app-summary-read-models.ts`.
- Delta sync: `src/services/delta-sync.ts` and `GET /api/v1/sync/changes`.
- Worker lifecycle: `src/services/event-backbone-worker.ts` invoked by
  scheduler every minute with bounded batch limits.
- Retention cleanup: `src/tools/event-backbone-cleanup.ts`, dry-run by default,
  scheduled at 00:10 with explicit apply flag.
- iOS cache/sync: `DeltaSyncStore`, `DeltaSyncService`,
  `DeltaSyncRepository`, and AppState cache clearing.
- Budgets: `src/services/resource-budgets.ts`, concrete budgets on sync and
  summary routes.
- Observability: request/correlation/causation IDs carried through events and
  jobs; budget degradation logs are scoped and PII-free.
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
- scheduler kill switch: `EVENT_BACKBONE_WORKER_DISABLED=1`
- scheduler batch controls:
  `EVENT_BACKBONE_EVENT_BATCH_LIMIT` and `EVENT_BACKBONE_JOB_BATCH_LIMIT`

Initial handlers:
- `project_read_models`
- `training_summary_projector`
- `deliver_notification` as a safe retry hook while synchronous notification
  delivery remains source behavior
- safe stubs for content radar, calendar sync, and memory summary jobs that do
  not call providers locally

Scheduler lifecycle:
- `event_backbone_worker` runs every minute
- no-op runs return `skipped` so `job_history` does not churn
- dead-letter rows are logged as warnings

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

Budget behavior:
- summary list: 240 requests per user/minute
- summary get: 300 requests per user/minute
- summary project: 30 requests per user/minute
- budget-denied requests return safe `RATE_LIMITED` errors with reset metadata

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
- `DeltaSyncRepository` coalesces in-flight summary/delta refreshes by scope
- stale async responses are dropped after scope changes
- device id is stable per app install
- `clearAll()` runs from AppState process-wide cache clearing on logout/scope
  reconciliation
- Home/AppState bootstrap warms Home, Week, Training, Content, and
  Notifications summaries
- Dashboard foreground refresh warms Home, Week, Notifications, and delta
  changes
- Training, Content, and Notification Inbox entry points warm their own summary
  plus delta changes

Not claimed:
- visible product surface QA after authenticated login
- background task execution
- replacing existing screen source-of-truth loaders with read-model-only UI

## Budgets / Circuit Breakers

Implemented:
- reusable budget counter keyed by tenant/user/budget/window
- unique window counter index to avoid duplicate counters
- `sync_changes` route budget: 120 requests per user/minute
- summary route budgets listed above
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
- scheduler logs for processed event/job counts and cleanup targets

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

Scheduler integration:
- midnight cleanup is dry-run unless `EVENT_BACKBONE_CLEANUP_APPLY=1`
- `EVENT_BACKBONE_CLEANUP_DISABLED=1` disables the scheduled pass
- `sync_cursors` cleanup uses the real `last_seen_at` column

Dead-letter events/jobs are intentionally retained for investigation.

## Release classifier

`scripts/changed-area-classifier.sh` detects:
- event outbox
- job queue
- decision log
- read models
- delta sync
- resource budgets
- summary/sync routes
- event backbone migration/tests
- domain route changes for Training/Cooking/Content/Finance/Secretary

Classifier output for this branch includes:
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
- scheduler worker and cleanup hooks are test-wired without needing real
  provider calls

## Local full-product smoke

Started-engine local smoke was run against the loopback-only harness with local
SQLite data and model-provider keys disabled.

Validated:
1. backend built and started on `127.0.0.1:8200`
2. local sandbox iOS auth token created
3. authenticated app-facing smoke passed 13/13:
   Dashboard, Plan today, Plan week, Task lists, Today tasks, Training summary,
   Training today, Content pipeline, Content intelligence summary, Current meal
   plan, Finance monthly summary, Connections, Inbox
4. `POST /api/v1/summaries/project` projected 5/5 summaries:
   Home, Week, Training, Content, Notifications
5. `GET /api/v1/summaries/home` returned `summaryType=home`, version 1,
   `isStale=false`
6. `GET /api/v1/sync/changes?deviceId=local-smoke-device&limit=10` returned a
   scoped cursor, empty changes for the fresh local user, `hasMore=false`, and
   `resetRequired=false`
7. harness cleanup stopped the backend and cleared the auth token

Focused tests cover the deeper emit-event -> worker -> job -> summary -> delta
chain.

## iOS validation

Behavior tests:
- `Nexus HubTests/DeltaSyncStoreTests`
- `Nexus HubTests/DeltaSyncRepositoryTests`
- Result: 6/6 passed on iPhone 17 Pro simulator, iOS 26.4.1

Simulator interaction:
- built and launched `me.nexushub.app`
- tapped `onboarding-start-button`
- verified the simulator reached the account creation/auth screen

Blocked/not claimed:
- authenticated Home/Week/Training/Content/Notifications screen interaction was
  not performed because the simulator session stopped at auth and no valid
  local signed test account path was available in this run

## Tests run

Backend:
- `npx tsc --noEmit` PASS
- `npm run verify` PASS, 478 files / 7057 tests
- `npx vitest run __tests__/services/event-backbone.test.ts __tests__/api/event-backbone-routes.test.ts __tests__/services/scheduler-user-scope.test.ts --reporter=default` PASS, 25/25
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts --reporter=default` PASS, 23/23
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence` PASS, 23/23
- `node scripts/vi-mock-completeness-lint.mjs --strict` PASS, 827/827

Python:
- `cd content-engine && .venv313/bin/python -m pytest tests/ -q` PASS, 135/135
- A first invocation from the engine root failed with `tests/` not found; this
  was a command path mistake and was corrected by running from `content-engine`.

iOS:
- `xcodebuildmcp test_sim -only-testing:Nexus HubTests/DeltaSyncStoreTests -only-testing:Nexus HubTests/DeltaSyncRepositoryTests` PASS, 6/6
- `xcodebuildmcp build_run_sim` PASS
- `xcodebuildmcp snapshot_ui` PASS for onboarding and auth screen snapshots

Local smoke:
- `scripts/full-nexus-local-engine.sh smoke` PASS, 13/13
- event backbone API probe PASS for summary projection, Home summary, and delta
  sync cursor response

Docs:
- `npm run docs:audit` must be rerun after this report update and workspace
  mirror refresh.

## Open items

P0:
- None known from this workstream.

P1:
- Authenticated iOS product-surface interaction smoke remains required before
  treating summary/delta app integration as UI-validated.
- Release/deploy operator must explicitly confirm event-backbone worker and
  cleanup env flags before staging/prod.

P2:
- Gradually render Home/Week/Training/Content/Notifications from summaries
  where UX/product value is clear; current work warms summaries/deltas without
  changing visible source-of-truth behavior.
- Expand resource budgets to provider, calendar, content radar, and
  notification-delivery attempts.
- Add a longer local smoke fixture that creates a real domain entity through
  API, observes event/job projection, and verifies iOS cache with an
  authenticated app session.

P3:
- Consider exposing read-model freshness diagnostics in an internal portal
  surface after first QA pass.

## Cleanup status

- Local full Nexus backend: stopped by harness cleanup.
- Content engine: not started.
- Auth token: removed by cleanup.
- Port 8200: no listener after cleanup.
- iOS simulator: app launch used for onboarding/auth interaction; stop app
  before handing off if no further simulator validation is needed.
- Push/deploy: not performed.

## Prompt/process improvements

- For future product-engineering prompts, include a local app-auth setup step so
  Codex/Claude can validate authenticated iOS surfaces against the local engine
  without relying on production credentials.
- Treat local smoke response-shape assertions as contract tests; the first
  projection probe used the wrong response field and caught that assumption.
- Keep this foundation modular: events project state and support sync; direct
  REST writes and durable DB rows remain source of truth.

## Final recommendation

READY_WITH_CONDITIONS for Claude hostile QA and local engineering QA.

Do not push or deploy from this branch yet. The backend foundation, scheduled
worker lifecycle, local API smoke, and iOS cache/sync implementation are in
place and tested. The main unresolved evidence gap is authenticated iOS
product-surface interaction against a local or signed test account; that should
be closed before release-readiness is upgraded beyond conditions.
