# Nexus Hub Event Backbone, Read Models, Delta Sync, Jobs, and iOS Cache report

Status: current
Owner: Codex
Last verified: 2026-05-07
Branch: `feature/event-backbone-readmodels-delta-sync`
Engine commits:
- `887ada0eaf7e9e6ce09eab275a1c888f73916251` - foundation
- `25133368371dafb967dc7a4f89a7360ea464fb79` - worker lifecycle, retention hook, summary budgets
- `2e896435` - hostile QA remediation: transactional outbox, recursive redaction, atomic budgets, worker logs, sync/retention hardening
- `e82bbdae` - hostile QA v2 remediation: strict outbox transaction, event cancel-race guard, migration 115, admin tests
- `ca2e0cd9` - hostile QA v2 test-ratchet follow-up: complete mocks and chat event transaction unit contract
iOS commits:
- `2f3be83de91f3dae646ee9c49bda89f5eb73a315` - delta sync store/service foundation
- `9ff725dca44d1603c9dee82f6f1ef3b2d83be320` - app-surface summary/delta warmup
- `82abbea` - hostile QA remediation: reset cursor safety, duplicate handling, bounded cache, foreground TTL refresh, physical iPhone tests
- `12a9d95` - hostile QA v2 remediation: cancellation checkpoints, thread-safe URLProtocol test harness, scenePhase TTL guard
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
  signed test account session; physical-device behavior tests ran on iPhone
  Felipe, but no authenticated product-surface walkthrough is claimed here
- independent Claude hostile re-QA should re-run against `ca2e0cd9` and
  `12a9d95` before upgrading beyond READY_WITH_CONDITIONS
- production/staging must explicitly decide the worker and cleanup flags before
  deploy (`EVENT_BACKBONE_WORKER_DISABLED`, batch limits,
  `EVENT_BACKBONE_CLEANUP_APPLY`)
- future product work can gradually render from summary read models instead of
  only warming them in the background

## Executive summary

- Biggest implementation: SQLite-backed event/job/read-model/sync foundation
  with scheduled processing and scoped iOS cache readiness.
- Biggest blocker: no authenticated iOS product-screen interaction was
  available in this local/physical-device run.
- Remaining risk: summary read models are warmed and tested but not yet the
  primary visible source of truth for every screen.
- Backend readiness: implemented and validated for local QA.
- iOS readiness: store, repository, app-surface warmup, scope invalidation,
  URLProtocol tests, and physical-device delta-sync tests are green.
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

## Hostile QA remediation closeout

Claude hostile QA originally downgraded this workstream to NOT_READY in
`docs/archive/2026-05/event-backbone-readmodels-delta-sync/hostile-qa-report.md`.
That verdict was correct at the time of audit. The source branch closed the
promoted P0/P1 cluster in engine commit `2e896435` and iOS commit `82abbea`,
then closed the follow-up hostile v2 findings in engine commits `e82bbdae` /
`ca2e0cd9` and iOS commit `12a9d95`.

Closed in source:
- transactional outbox emit paths for Chat, Content, Cooking, Finance,
  Training, and Notification intent creation; the DB-unavailable fallback was
  removed, so business writes fail closed unless an initialized SQLite
  transaction is available
- recursive privacy sanitization for event payloads and decision-log summaries
- atomic SQLite resource budgets with 429 `Retry-After` metadata and structured
  budget-exceeded logs
- atomic event/job claiming, stuck-lock recovery, dead-letter/replay/cancel
  operator routes, and structured worker batch logs
- tenant-scoped event replay and same-tenant cross-user visibility rules
- sync device identity from authenticated request scope, not query-string
  device poisoning
- reset-required cursors no longer advance before client recovery
- retention cleanup protects dead-letter evidence and processed events still
  needed by active sync cursors
- iOS delta cache reset/duplicate/size/foreground-refresh hardening with
  physical-device tests
- event-side cancel races now mirror the job-side guard: late processed/failed
  updates do not overwrite `canceled`
- migration `115_event_outbox_canceled_status.sql` rebuilds `event_outbox` so
  already-migrated SQLite databases can accept the `canceled` status
- event-backbone admin routes now have behavioral tests for admin auth, tenant
  scope, replay, cancel, and attempts reset
- stale event/job lease reclaim paths are behavior-tested
- iOS summary refreshes add cancellation checkpoints and Dashboard scenePhase
  activation now uses the TTL-gated refresh path

Remaining condition:
- independent hostile re-QA should validate the remediation before this report
  is upgraded beyond READY_WITH_CONDITIONS.

### Hostile v2 closeout

Claude's second prompt,
`docs/archive/2026-05/event-backbone-readmodels-delta-sync/codex-validation-and-remediation-prompt-v2.md`,
listed 11 remaining findings. Source remediation status:

- `HOSTILE-OUTBOX-1A`: closed by removing `fallbackWhenDatabaseUnavailable`.
  `runOutboxTransaction` now always uses `getDb().transaction(...)` and throws
  if storage is unavailable.
- `HOSTILE-OUTBOX-1B`: closed with rollback tests proving business rows roll
  back when event emission fails and event rows roll back when the business
  callback throws.
- `HOSTILE-EVENT-CANCEL-RACE`: closed; `markEventProcessed` and
  `markEventFailed` preserve `canceled`.
- `HOSTILE-IOS-DS-NEW-1`: closed; URLProtocol mock state in
  `DeltaSyncRepositoryTests` is protected by `NSLock`.
- `HOSTILE-ADMIN-NO-TESTS`: closed with dedicated admin-route tests.
- `HOSTILE-IOS-DS-9`: closed; Dashboard scenePhase foreground refresh uses
  stale TTL gating.
- `HOSTILE-IOS-DS-3`: closed with `Task.checkCancellation()` checkpoints and
  a cancellation regression test.
- `HOSTILE-OUTBOX-1C`: closed; notification intent creation and Finance PATCH
  writes use the canonical outbox transaction wrapper.
- `HOSTILE-MIGRATION-114-EDITED`: closed by restoring migration 114 and adding
  migration 115 to rebuild `event_outbox` with `canceled`.
- `HOSTILE-ORPHAN-REAPER-NO-TEST`: closed with stale event/job lease reclaim
  tests.
- `HOSTILE-IOS-DS-5`: closed with a documented first-write-wins duplicate
  contract and store-level test.

## iOS validation

Behavior tests:
- `Nexus HubTests/DeltaSyncStoreTests`
- `Nexus HubTests/DeltaSyncRepositoryTests`
- Result: 11/11 passed on connected physical device `iPhone Felipe`

Physical-device validation:
- `xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -destination 'platform=iOS,id=00008150-000C0D5101D8401C' -only-testing:"Nexus HubTests/DeltaSyncStoreTests" -only-testing:"Nexus HubTests/DeltaSyncRepositoryTests"` PASS, 11/11
- APNs token upload emitted a local "couldn't load" warning during launch; no
  live APNs or push-delivery validation is claimed by this workstream

Blocked/not claimed:
- authenticated Home/Week/Training/Content/Notifications screen interaction was
  not performed because no valid local signed test account path was available in
  this run

## Tests run

Backend:
- `npx tsc --noEmit` PASS
- `npm run verify` PASS, 481 files / 7074 tests
- `npx vitest run __tests__/api/event-backbone-routes.test.ts __tests__/api/event-backbone-admin-routes.test.ts __tests__/services/event-backbone.test.ts __tests__/services/event-backbone-fallback-rejection.test.ts __tests__/migrations/migration-115-event-outbox-canceled-status.test.ts __tests__/security/p0-chat-identity-isolation.test.ts --reporter=default` PASS, 52/52
- `npx vitest run __tests__/api/chat-persistence.test.ts __tests__/api/event-backbone-admin-routes.test.ts --reporter=default` PASS, 9/9
- `npx vitest run __tests__/api/content-topic-routes.test.ts __tests__/api/training-routes.test.ts __tests__/api/finance-routes.test.ts __tests__/api/event-backbone-routes.test.ts __tests__/services/event-backbone.test.ts --reporter=default` PASS, 72/72
- pre-commit focused changed-area run PASS, 138 files / 1570 tests for `e82bbdae`; final test-only commit pre-commit focused run PASS, 2 files / 22 tests
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts --reporter=default` PASS, 23/23
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence` PASS, 23/23
- `node scripts/vi-mock-completeness-lint.mjs --strict` PASS, 827/827

Python:
- `cd content-engine && .venv313/bin/python -m pytest tests/ -q` PASS, 135/135
- A first invocation from the engine root failed with `tests/` not found; this
  was a command path mistake and was corrected by running from `content-engine`.

iOS:
- simulator focused DeltaSyncStore/DeltaSyncRepository PASS, 11/11
- physical iPhone test command above PASS, 11/11
- authenticated product-surface interaction not claimed

Local smoke:
- `scripts/full-nexus-local-engine.sh smoke` PASS, 13/13
- event backbone API probe PASS for summary projection, Home summary, and delta
  sync cursor response

Docs:
- `npm run docs:audit` PASS, 465 issues / 439 audited after report update and
  workspace mirror refresh.

## Open items

P0:
- None known from this workstream.

P1:
- Authenticated iOS product-surface interaction smoke remains required before
  treating summary/delta app integration as UI-validated.
- Independent Claude hostile re-QA remains required before upgrading beyond
  READY_WITH_CONDITIONS.
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
