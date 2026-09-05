# Scalability And Optimistic Mutation Roadmap

Status: canonical
Owner: backend architecture lead
Last verified: 2026-09-04
Update policy: update when a roadmap phase lands, a trigger threshold changes,
or a finding below is closed by code. Findings cite `origin/main` at the
verification date; re-verify file references before acting on them.

This document is the single roadmap for taking Nexus Hub from a single-owner
runtime to many concurrent users without adding infrastructure the product
does not yet need. It covers the backend engine, the content engine, the iOS
client, and the single-VPS container runtime. It records verified findings,
the design decisions that keep the engineering simple, a dependency-ordered
phase plan with gates, and the measured signals that would justify Redis or
Postgres later.

Scope boundaries:

- Security fail-opens found during this audit are tracked in
  `../security/security-hardening-implementation-status.md` under
  "Multi-user hardening backlog"; this roadmap references them but does not
  own them.
- Release mechanics are owned by `../release/continuous-deployment.md` and
  `../../ops/nexus-release/README.md`. Nothing here changes the signed release
  lifecycle.
- The Tasks offline-first contract is owned by
  `offline-first-tasks-architecture.md`. This roadmap generalizes that pattern
  to other domains; it does not redefine Tasks.

## 1. Verdict

| Concurrent users | Verdict | Binding constraint |
|---|---|---|
| ~10 | Comfortable. | None. Reads and non-chat writes are fast; SQLite WAL, the SQLite-backed SWR cache, and index coverage are ahead of need. |
| ~100 | Degrades on chat, on scheduler fan-out, and on two silent cliffs. | One active local inference slot by design; 68 cron jobs in the request process with sequential all-user loops and no jitter; no PM2/container log rotation on the fallback path; several hot tables with no retention. |
| ~1000 | Not viable on the current topology. | The backend container is one Node process by design (single SQLite writer, scheduler, in-memory rate limiter, in-memory confirmation and OAuth state). Running two backend replicas today would double-fire crons and multiply rate limits. |

Optimistic rendering: the backend already has the right primitives in two
domains (Tasks: offline-first mutations with idempotency keys and
`local_version`; Decision Center: `expectedVersion` plus a mandatory
idempotency key and outbox emission). They are not a platform contract. Tasks
still emit no outbox events, so the delta-sync feed cannot converge the hottest
domain. iOS is optimistic only for task complete/delete and chat send; Decision
Center, Cooking, Finance, Notes, and Calendar wait for the server before the UI
moves, and stale-while-revalidate is implemented but never enabled.

## 2. Findings

Each finding names the file and, where useful, the line on `origin/main` at
verification time. Lines drift; the symbol names do not.

### 2.1 Write path and optimistic-client contract (backend)

- Reference pattern. `createOfflineFirstTask` in
  `src/services/task-store/offline-first-task-service.ts` dedupes on
  `task_mutations` by `clientMutationId`/`idempotencyKey`, bumps
  `local_version`, defers provider sync to `task-mutation-sync-worker` (15-min
  cron, bounded concurrency, circuit breakers), and returns the full task with
  its server id. `local_version` is not enforced on PATCH.
- Decision Center. `POST /decisions/:id/actions` in
  `src/api/routes/decisions.ts` accepts `expectedVersion` and requires an
  `idempotencyKey`; `DECISION_VERSION_CONFLICT` exists; the repository emits
  outbox events. Execution is still synchronous in the request:
  `maybeExecuteDecisionActionViaCommandBus` in
  `src/services/decision-center/command-service.ts` routes through
  `decision-command-adapter` to `executeChatCoreV2Command` in
  `src/services/chat-core-v2/command-executor.ts`, which awaits provider
  `createTask` and `addChecklistItem` calls inline.
- Domain coverage of the contract is uneven. Calendar and Content routes read
  an `Idempotency-Key` header and Content/Training keep their own receipt
  tables (`content_mutation_receipts`, `travel_window_mutation_receipts`,
  `health_data_mutation_receipts`). Cooking, Finance, Notes, and Reminders have
  no version field on writes; Notes and Reminders have no idempotency at all.
- Event outbox and delta sync. `runOutboxTransaction`/`emitDomainEvent` in
  `src/services/event-outbox.ts` feed `GET /api/v1/sync/changes`
  (`src/api/routes/sync.ts` → `src/services/delta-sync.ts`, cursor per device).
  Emitters include finance, content, training, cooking (recipe), chat
  persistence, notifications, secretary agenda, and Decision Center. The task
  store and `src/api/routes/tasks.ts` emit nothing, so Tasks are invisible to
  delta sync.
- Chat. `POST /chat/message` returns one blocking JSON body; server-sent events
  exist only for the portal (`src/portal/sse.ts`). The local-primary scheduler
  (`src/services/local-inference-scheduler.ts`) admits one active generation
  with a bounded waiting queue and rejects with `LOCAL_CAPACITY_BUSY`; the
  legacy gate in `src/services/chat-core-v2/local-inference-concurrency-gate.ts`
  still holds an unbounded FIFO for traffic it owns. The per-user AI cost lock
  in `src/services/cost-guardrail.ts` waits up to 30 s with a 10-minute lease.
  No `server.headersTimeout`/`requestTimeout`/`keepAliveTimeout` is set.
  Chat idempotency (client message id replay, in-flight claim, 409 on key
  reuse) is solid. The background command job handler is registered in
  `src/services/event-backbone-worker.ts`; completion delivery is APNs-only
  with no job-status endpoint.
- Already multi-process safe: `intelligence-bus` (table-backed),
  `event_outbox` and `background_jobs` (lease claims with `lockOwner` and
  stale reclaim).

### 2.2 Runtime, data growth, memory, realtime

- Retention. `retentionTargets` in `src/services/scheduler.ts` prunes nine
  tables. There is no retention for `notification_center_items` (the home
  read model counts over it on every summary fetch), `task_mutations`,
  `resource_budget_counters`, `issues`, `decision_lifecycle_events`, or chat
  `messages`. There is no `VACUUM` or `auto_vacuum`; the database file only
  grows, and encrypted backups scale with the high-water mark.
- Logs. `ecosystem.config.js` and `ecosystem.release.config.js` define PM2
  log files without `max_size`, and no log-rotation module is installed. This
  applies to the PM2 first-cutover fallback; the container path uses Docker
  logging. Roughly one `logger.info` per route handler plus one row per request
  in both `http_request_log` and `runtime_logs`.
- Memory. Per-user module-level `Map`s with no eviction:
  `src/api/rate-limiter.ts` buckets, `lastActiveDomain` in
  `src/api/routes/chat-message-context.ts`, `knownSharedTaskIdsByUser` in
  `scheduler.ts`, list and category caches in `src/services/microsoft-todo.ts`
  and `src/services/outlook-calendar.ts`, `_stateContextCache` in
  `src/domains/secretary.ts`. `src/utils/lru-map.ts` exists with three
  consumers. The backend container runs with a 1 GB memory limit.
- Realtime. `src/api/websocket.ts` keys its per-IP connection cap on
  `request.socket.remoteAddress`; behind cloudflared inside the container every
  client shares one address, so the per-IP cap is a global cap. The REST rate
  limiter resolves `cf-connecting-ip` correctly when the peer is private, so
  only the WebSocket path is affected. There is no per-user connection cap, no
  `bufferedAmount` backpressure check on send, and no user→socket registry, so
  the server cannot fan out to a user's connections and the WebSocket layer is
  single-process by construction.
- Push. `sendPushToUsers` and `sendPushNotification` in
  `src/services/apns-sender.ts` use unbounded `Promise.all` across users and
  tokens; retriable 429/5xx responses are logged and dropped.
- Attachments. `src/api/routes/attachments.ts` accepts base64 through
  `express.json({ limit: '8mb' })` and holds the decoded buffer in heap; there
  is no persisted file store or per-user quota. Invoices already have an
  object-storage path (`src/tools/invoice-object-storage-backfill.ts`).
- List routes. Tasks list/filtered/working-set/snapshot, notifications,
  decisions, and `GET /calendar/events` have no result cap or maximum span.
  Response compression is configured.
- Provider I/O. No shared keep-alive HTTPS agent (each Graph/Google/Garmin
  call negotiates TLS); `Retry-After` is parsed in four separate places;
  bounded concurrency exists only in `task_sync` (5), the training calendar
  sync (5), and `secretary_agenda_sync` (4); no cron applies jitter, so
  due-tick crons burst. At 100 active users the daily briefing tick issues
  on the order of hundreds of provider calls and the Garmin coach tick close
  to a thousand in one minute. `decision_daily_attention` iterates users
  without a per-user try/catch. The minute-cadence reminders tick has an
  overlap guard that converts "too slow" into silently skipped ticks.
- Garmin silent mode. `runWithContext` in `src/utils/request-context.ts`
  replaces the AsyncLocalStorage frame instead of merging it, so passive
  readers that omit `garminSilent` (`src/api/routes/dashboard-data-fetchers.ts`,
  `src/api/routes/training-read-models.ts`, `src/services/focus-planner.ts`,
  `src/services/content-scheduler.ts`) can still trigger MFA passcode emails.
- Feature flags. `src/services/runtime-flags.ts` supports per-user, per-tenant,
  and stable percentage cohorts but reads only `process.env`, so changing a
  cohort requires a release. `/api/v1/dashboard` already returns a
  `featureFlags` block built by `buildHomeFeatureFlags`; the iOS
  `TaskRedesignFlags` are local `UserDefaults` and ignore it.
- Observability. Per-route p50/p95/p99 ring (`src/api/request-timer.ts`),
  persisted slow-request log, `Server-Timing`, Sentry errors only
  (`SENTRY_TRACES_SAMPLE_RATE` defaults to 0). No Prometheus or OpenTelemetry
  export, no event-loop lag gauge, no `SQLITE_BUSY` counter, no slow-statement
  log.

### 2.3 Container runtime and release path

- `docker-compose.release.yml` runs `backend` (2 CPU, 1 GB), `content-engine`
  (1 CPU, 512 MB), `ollama-gateway` (0.5 CPU, 256 MB), and a one-shot
  `migrator`. Published ports bind to loopback; Cloudflare Tunnel is the only
  ingress. `ops/cloudflared/systemd/nexus-cloudflared.service` supervises the
  connector.
- Continuous deployment is automatic on green protected `main`
  (`../release/continuous-deployment.md`): signed image pair, staging
  migrate/up/health/smoke, production backup/migrate/up/observe with a
  120-second restore objective. Migrations run in the migrator, never at
  application startup. Container replacement has no traffic-drain primitive
  yet (owner-gated per the CD doc), so each production release has a short
  unavailable window.
- Backups are hourly, encrypted with `age`, integrity-checked, retained as
  24 hourly / 30 daily / 4 weekly points, and restore-verified on a timer
  (`ops/local-backup/README.md`). They stay on the same host; off-host
  durability is an accepted residual risk in the security status doc.
- The content engine is a single uvicorn worker with per-mode timeouts up to
  300 s and no queue in front of it; a deep run occupies the worker.
- One backend process is a hard architectural assumption: single SQLite
  writer, scheduler, in-memory rate limiter, in-memory pending confirmations
  and OAuth state. `ecosystem.*.config.js` pins `instances: 1` for that reason.

### 2.4 iOS (nexus-hub-ios `origin/main`, 2026-09-03)

- Optimistic today: task complete/uncomplete/delete in `TaskRepository.swift`
  (snapshot, apply, enqueue outbox, restore on failure); instant task capture
  behind `TaskRedesignFlags` while the default `createTask` blocks on the POST;
  chat user message append; onboarding step advance; push toggles.
- Pessimistic hotspots, by user impact: Decision Center accept/dismiss and
  snooze in `DecisionCenterViewModel.swift` (POST, then an exact detail
  readback via `DecisionCenterMutationCoordinator.swift`, two serial round
  trips before the card moves); Cooking `setMealPlan`/`deleteMealPlan` (write,
  then full-week refetch); Finance transaction create/update/delete (write,
  then monthly summary refetch); Notes `deleteNote` in
  `ContentRepository.swift` (comment claims optimistic, code awaits first);
  Calendar `createEvent`; task list create (full list refetch).
- `CachedResource.swift` has TTL, in-flight coalescing, ETag/304, and an
  `allowStaleWhileRevalidate` option with zero call sites. Shimmer skeletons
  exist and are used on a handful of screens; the tasks, sync-center, and
  content-workspace screens show full-screen spinners.
- Request volume. Cold start fires roughly two dozen distinct endpoints plus
  one `tasks?listId=` call per prioritized list; `/dashboard` and
  `/dashboard/home` are both requested unconditionally; both home calendar
  reads pass `forceRefresh: true`; five separate `/summaries/{type}` reads; a
  60-second dashboard timer issues four requests per minute per foregrounded
  device and is not stopped on scene background; `ClientErrorReporter` posts
  one request per event with no batching; background refresh offsets carry no
  jitter.
- Strong: `AuthRequestScope` epoch validation on every response, refresh
  coalescing, full sign-out reset, `TaskMutationOutbox` with
  `BackgroundSyncManager` drain, `DecisionCenterActionJournal`, JSON decoding
  off the main actor. Gaps: idempotency keys on roughly one in ten POST call
  sites while POST is never transport-retried (a timed-out POST is lost, not
  duplicated); no silent-push handler; no SwiftData; view models that own the
  optimistic/pessimistic sequencing have almost no tests.

### 2.5 Security and abuse under multi-user (summary)

Verified fail-opens and abuse surfaces are itemized with scores in
`../security/security-hardening-implementation-status.md`. The three that
matter the moment a second user exists: the portal admin scope check in
`src/portal/admin-target-user.ts` allows any target user when no operator
scopes are configured; `resolveTenantToolUserId` in
`src/services/tool-executor.ts` accepts a model-supplied `user_id` when the
request context carries none; `portal.nexushub.me` is publicly routed to the
same origin as the API with no Cloudflare Access in front of it. Cost
guardrails check budget before the provider call and release reservations in
`finally`, which is correct, but the global daily cap denies every user once
exceeded, before per-user checks.

## 3. Design decisions

The rule for every decision: reuse a primitive that already exists in the
repo, and add a shared boundary instead of per-call-site fixes.

1. One platform mutation contract for every write route. Request carries
   `Idempotency-Key` (body `idempotencyKey`/`clientMutationId` accepted for
   existing clients) and, for update/delete, `If-Match` or body
   `expectedVersion`. The server runs one `runOutboxTransaction` that checks a
   shared `mutation_receipts` table (replay the stored response on hit; 409
   `IDEMPOTENCY_PAYLOAD_MISMATCH` on a different body), compares the entity
   version (409 `VERSION_CONFLICT` carrying `current`), writes `version + 1`,
   and emits a domain event. Response is the full entity with `id`, `version`,
   `updatedAt`, plus `meta: { mutationId, replayed, providerSync }` and an
   `ETag` equal to the version. Provider side effects never run in the request;
   they are `background_jobs` and report back through `providerSync` and a
   later outbox event. `task_mutations` dedupe is generalized into
   `src/services/mutation-contract.ts`; the three existing per-domain receipt
   tables migrate onto it over time. Adoption order by traffic times risk:
   Tasks → Decision Center → Notes/Reminders → Calendar → Cooking → Finance.
   The contract is recorded in `backend-api-contract-standard.md` section 7
   and in `../contracts/openapi-v1.yaml` when it lands.
2. iOS gets one `OptimisticMutation<Entity>` primitive first, extracted from
   the existing task complete/delete path, with a generalized `MutationOutbox`
   built from `TaskMutationOutbox`. Domains convert in the same order as the
   backend. One primitive means one rollback/conflict/replay test suite and no
   more per-repository hand-rolled snapshots.
3. Chat gets job-status polling before streaming. `POST /chat/message` may
   return 202 with a job id when the scheduler wait exceeds a threshold or the
   client sends `Prefer: respond-async`; `GET /chat/jobs/:id` reads
   `background_jobs`; APNs stays the wake-up. Streaming on the API reuses the
   portal SSE emitter afterwards. Polling fixes correctness (no silent blocking
   fallback, recoverable after backgrounding); streaming is UX.
4. Process split before any horizontal scaling: `backend` (HTTP and
   WebSocket), `worker` (cron scheduler, outbox worker, sync workers,
   background commands), and the Telegram poller as its own process. Rate
   limiter buckets, pending confirmations, OAuth state, and the scheduler
   `inFlightJobs` set move into SQLite tables using the lease pattern already
   in `background_jobs`. Only after this can the backend container run with
   more than one replica.
5. Provider discipline lives at the client boundary, not per cron: one shared
   keep-alive HTTPS agent, one `Retry-After` policy, per-provider token
   buckets, a `forEachUserBounded(targets, n, fn)` helper, and tenant-hash
   jitter for due-tick crons. Every future cron is safe by construction.
6. Storage stays SQLite as long as writes leave the request path. Off-host
   encrypted backup copies are the next durability step, not a database
   change. Redis is warranted only when the backend runs more than one replica
   and the SQLite-table rate limiter cannot keep up. Postgres is warranted only
   on measured signals: `SQLITE_BUSY` above 0.1 % of writes over seven days,
   write-lock wait p95 above 50 ms, database file above 20 GB, or a second
   host. None of these can be measured today; Phase 1 adds the gauges.
7. Edge stays Cloudflare Tunnel on one host. Add one rate-limiting rule on
   `/api/v1/auth/*`, Cloudflare Access in front of the portal hostname, and a
   Cloudflare health check on `/public-status`. A second `cloudflared` replica
   only helps once a second host exists; replicas are high availability, not
   load balancing. Native-app bot gating uses Apple App Attest; Turnstile is
   for web forms only.
8. Feature flags become data. `runtime-flags` reads `config-provider`
   kv_store first with `process.env` as fallback, and the existing
   `/dashboard` `featureFlags` block carries the rollout cohorts so iOS follows
   the server. Every optimistic or asynchronous change in this roadmap ships
   behind a percentage cohort that can be changed without a release.
9. Load testing runs on staging with `NEXUS_PROVIDER_MODE=stub`: the provider
   router and task adapters swap Graph, Todoist, Google, Ollama, Anthropic, and
   APNs for latency- and error-injecting fakes; users are seeded with the
   existing smoke-seed tooling; k6 runs from the operator machine. Scenarios:
   mixed reads, same-entity concurrent writes, chat with stub inference, cron
   storm at a seeded user count, and a release during load.

## 4. Roadmap

Phases are dependency-ordered. Each has a gate that must pass before the next
phase starts; gates are measurements, not counts.

### Phase 0: cliffs and fail-opens (each item under one day)

Do these before any capacity work; they are the failures that would arrive
first.

- Infra: install log rotation for the PM2 fallback path and confirm Docker
  log limits on the container path; Cloudflare health check on
  `/public-status`; verify the `nexus-cloudflared` unit is installed and
  enabled on the host; schedule an off-host copy of the encrypted hourly
  backup artifact.
- Security (tracked in the security status doc): portal admin scope check
  fails closed unless single-owner mode is explicit; remove the model-supplied
  `user_id` fallback in the tool executor; Cloudflare Access on the portal
  hostname; edge rate-limiting rule on `/api/v1/auth/*`; resend cooldown and
  daily cap on `/auth/send-verification`; keep the verification attempt
  counter across resends; apply the existing disposable-email validator at
  registration; put `rateLimitMiddleware` in front of `/legal`; add `helmet()`
  at app level.
- Backend runtime: resolve the WebSocket client IP with the same
  `cf-connecting-ip` logic as the rate limiter; set `headersTimeout`,
  `requestTimeout`, `keepAliveTimeout` on the HTTP server; bound the legacy
  inference gate (max depth plus wait timeout, 503 with `Retry-After`); add
  `notification_center_items`, `task_mutations`, `resource_budget_counters`,
  `issues`, and `decision_lifecycle_events` to `retentionTargets` with batched
  deletes, and run `PRAGMA incremental_vacuum` at the end of the midnight
  cleanup; batch `sendPushToUsers`; per-user try/catch in
  `decision_daily_attention`; make `garminSilent` sticky by merging context
  frames and defaulting readiness reads to silent; replace owner-only targets
  (`warmTaskCache`, `getOwnerUserIds`, the literal `'owner'` cache-key
  fallbacks in the Microsoft To Do and Outlook adapters) with
  `getActiveUserTargets`; add an event-loop-lag gauge and a slow-statement log
  (statements over 100 ms); set `SENTRY_TRACES_SAMPLE_RATE` to a small
  non-zero value.
- iOS: enable `allowStaleWhileRevalidate` on the dashboard, tasks, decisions,
  calendar-week, and chat-history resources; drop `forceRefresh: true` on the
  two home calendar reads; request `/dashboard/home` only when `/dashboard`
  fails; stop the dashboard timer when the scene is not active; add jitter to
  `BackgroundSyncManager` offsets; make Notes delete match its comment.

Gate: `midnight_cleanup` completes within its window on a production-sized
database copy; the WebSocket per-IP cap no longer trips for two clients behind
one egress on staging; no Garmin passcode email from passive reads over a
72-hour staging soak.

### Phase 1: platform mutation contract and metrics (backend)

- `src/services/mutation-contract.ts` plus a `mutation_receipts` migration
  with a seven-day prune. Tasks: `If-Match` on PATCH/DELETE and `task.*` outbox
  events. Decision Center: record state, then enqueue
  `decision.execute_provider`; the command-executor provider path becomes the
  job handler. Notes and Reminders: `version`, idempotency, outbox. Calendar
  create: local shadow row with `pending_provider` status, provider job,
  outbox event on completion. `GET /sync/changes` covers Tasks, Decision
  Center, Notes, Reminders, Calendar.
- Result caps on tasks, notifications, and decisions lists; a maximum span on
  `GET /calendar/events`.
- Shared keep-alive HTTPS agent, one `Retry-After` policy, per-provider token
  buckets, `forEachUserBounded`, and tenant-hash jitter applied to every
  per-user cron. Unbounded per-user `Map`s converted to `LRUMap`.
- Prometheus-style `/metrics` on the loopback interface: HTTP latency histogram
  by route, `SQLITE_BUSY` count, outbox lag, job queue depth, inference queue
  depth, event-loop lag, provider 429 count. kv_store-backed runtime flags.

Gate: a contract test suite runs against every write route (replay, payload
mismatch, version conflict, outbox emitted); the same-entity concurrent-write
k6 scenario shows zero lost updates and zero duplicate provider jobs; the cron
storm at a seeded 100-user count shows no skipped minute ticks; `/metrics`
answers on staging.

### Phase 2: iOS OptimisticMutation, chat job model, client efficiency

- iOS: `OptimisticMutation`, `MutationOutbox`, and a 409 conflict handler that
  applies `current`. Convert default task create (retire the flag), Decision
  Center accept/dismiss/snooze (drop the exact readback, reuse
  `DecisionCenterActionJournal` as the outbox), and Notes. Skeletons replace
  full-screen spinners on the tasks and sync-center screens. Batched
  `tasks?listIds=` and multi-type `/summaries?types=` reads. `ClientErrorReporter`
  batching (flush on a timer or event count, dedupe by message and surface).
  `TaskRedesignFlags` read the server `featureFlags` block. Tests for
  `DecisionCenterViewModel` and `TasksViewModel` sequencing.
- Backend: 202 plus job id from `POST /chat/message` when the scheduler wait
  exceeds a threshold or on `Prefer: respond-async`; `GET /chat/jobs/:id`;
  per-user WebSocket connection cap and a `bufferedAmount` guard on send; a
  reflective drift test that fails when a table with a `user_id` column is
  missing from `ACCOUNT_DELETION_TABLES`.

Gate: iOS rollback, replay, and conflict tests pass; the k6 chat scenario with
stub inference shows no request over 30 s and a bounded queue with zero dropped
messages; airplane-mode smoke on Decision Center converges after reconnect;
cold-start request count per device (from `http_request_log`) drops by at least
a third against the Phase 0 baseline.

### Phase 3: process split, streaming, remaining domains, release drain

- Move the rate limiter buckets, pending confirmations, OAuth state, and
  `inFlightJobs` into SQLite tables. Split into `backend`, `worker`, and the
  Telegram poller with a role guard; Compose and the PM2 fallback both express
  the three roles.
- SSE on `POST /chat/message` behind `Accept: text/event-stream`, reusing the
  portal emitter; iOS reads it with `URLSession.bytes` while keeping the
  WebSocket path.
- Cooking (meal-plan version, prep-event via job) and Finance adopt the
  contract; iOS converts Cooking, Finance, and Calendar and replaces full
  refetches with `DeltaSyncStore` deltas; silent push
  (`didReceiveRemoteNotification`) triggers delta sync; a user→socket registry
  allows server-initiated WebSocket fan-out.
- Release drain: a traffic-drain primitive for container replacement so a
  release does not drop in-flight requests (owner-gated per the CD doc;
  this roadmap only records the need). Field-encryption key versioning (a
  key id in the packed blob) with a rotation runbook. Google id-token
  consume-once guard.

Gate: availability gap during a staging release under load below two seconds;
API p95 unchanged during the cron storm now that crons run in the worker; a
one-hour SSE soak with twenty streams; a test key rotation on staging reads
old rows.

### Phase 4: content engine, cost fairness, multi-tenant hardening

- Content engine behind `background_jobs` with two uvicorn workers; the API
  enqueues, the worker calls the engine, results arrive via the outbox.
- Per-user plan caps as table rows; the global AI cap becomes fair-share (deny
  the top contributors first, never a user under their own cap).
- Chat attachments and invoices to object storage with a per-user quota;
  `resolveDashboardWarmTargets` recomputed on a cron instead of at boot;
  per-email auth buckets in addition to per-IP.

Gate: ten concurrent generations without API p95 regression; a k6 abuse
scenario in which one account cannot push other users into
`SERVICE_DEGRADED`; account deletion leaves zero rows across every
`user_id` table.

### Phase 5: scale-out evaluation

Run two backend replicas on staging. Evaluate Redis (rate limiter, WebSocket
pub/sub) and Postgres only against the Phase 1 signals gathered since. Add a
second `cloudflared` replica only with a second host. Decide; do not pre-build.

## 5. Cross-cutting risks

- Two devices per user: `OptimisticMutation` must surface version conflicts
  and never overwrite silently; test it explicitly.
- Decision Center actions going asynchronous changes "done" to "recorded";
  ship the `providerSync` badge in iOS before the backend flips the flag.
- The process split can double-run crons during rollout; the lease table
  prevents it, and `STALE_JOB_LEASE_MINUTES` should be lowered for the cutover.
- Retention on large tables must delete in batches to avoid long write locks.
- The fail-closed portal default locks out the current single-owner host
  unless the explicit single-owner setting ships in the same release; record
  it in the release notes and the operations runbook.

## 6. Verification for implementation work

- Backend: focused Vitest suites for each touched route plus the full suite
  and typecheck; the k6 scenarios above on staging with
  `NEXUS_PROVIDER_MODE=stub`; the staging smoke gate before any production
  release, as today.
- iOS: unit tests for the primitive and each converted repository; simulator
  smoke for Tasks and Decision Center offline and reconnect.
- Metrics gates per phase as listed; `/metrics` is the source for the Redis and
  Postgres triggers in section 3.

## 7. Related documents

- `backend-api-contract-standard.md` (idempotency and error envelope rules the
  mutation contract extends)
- `offline-first-tasks-architecture.md` (reference pattern)
- `runtime-and-observability-standard.md` (container pair, health, logging)
- `local-primary-inference-standard.md` (inference scheduler and admission)
- `../TOKEN-QUOTA-CONTRACT.md` (per-user and global AI budgets)
- `../release/continuous-deployment.md` and `../../ops/nexus-release/README.md`
  (release lifecycle, migrator, backup, rollback)
- `../security/security-hardening-implementation-status.md` (multi-user
  hardening backlog)
- `../security/security-control-matrix.md`
