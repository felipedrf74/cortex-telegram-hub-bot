# Runtime, Observability, and Operations Standard

Status: canonical
Owner: backend runtime + on-call lead
Last verified: 2026-08-13
Update policy: update when health-check shape changes, when alert
producers change, when log/metric semantics change, or when the release
process model changes. Incident response and recovery detail lives in
`docs/security/security-operations-runbook.md`; recovery-first container
deployment is governed by `docs/release/continuous-deployment.md`. The PM2
operator path in `docs/release/README.md` is a first-cutover fallback only.

This standard is the single source of truth for how Nexus Hub's backend
runs, logs, traces, alerts, and recovers. It is grounded in the
Twelve-Factor App principles and OpenTelemetry-style semantics, then
translated into the realities of the single-VPS, digest-pinned container pair,
Cloudflare Tunnel ingress, and recovery-first continuous deployment.

## 1. Configuration (must)

1. **Configuration is in the environment, not in code.** `src/config.ts`
   reads every required key at startup and **fails closed** when a
   required key is missing in production.
2. **No hardcoded provider names or model IDs.** `providerRouting` is the
   only acceptable place for "Gemini 2.5-flash" / "Claude Sonnet 4.6" /
   "GPT-5.5" strings. Business code calls `getActiveProvider(taskType)`.
3. **Feature flags are boolean env keys.** `NEXUS_FIXTURE_MODE=1`,
   `SECRETARY_PRIMARY_ROUTE_ENABLED=true`, `IOS_REQUIRE_UDID=1`,
   `PORTAL_BETA_HARDENED=true`, `NEXUS_DEPLOY_SKIP_VERIFY=1`. Default off
   for any flag that exposes new behavior.
4. **Secrets never appear in `process.env` log dumps.** A debug helper
   that dumps env should redact every key matching
   `/(token|secret|key|password|webhook)/i`.
5. **OpenAI Batch project isolation is paired and backward-compatible.**
   `OPENAI_BATCH_API_KEY` and `OPENAI_BATCH_PROJECT_ID` must be configured
   together with the legacy `OPENAI_API_KEY`. Genuinely new Batch uploads and
   jobs use the isolated project; recovered legacy input files and retained
   Batch/file operations stay on the legacy project after a provider `404`.
   Both keys must remain project-scoped to different projects, and the isolated
   pair must not be removed while any isolated Batch or file remains retained.
   Authorization failures, ambiguous intent matches, and every other provider
   error fail closed.

## 2. Process model (must)

1. **Two independent containers run in production.** `backend` owns the Node
   API/portal on container port 8200 and `content-engine` owns the Python service
   on 8100. Compose pins each image by immutable digest, runs both as UID/GID
   10001, and restarts them independently.
2. **The signed release identity is the runtime identity.** Source SHA, backend
   digest, content-engine digest, Compose digest, and release-payload digest must
   match the verified manifest and the durable host state/receipt. A moving tag
   discovers a payload digest but never authorizes runtime bytes.
3. **Graceful backend shutdown handles `SIGTERM`.** The Node process closes the
   HTTP server, flushes Sentry best-effort, closes SQLite, and exits inside the
   Compose grace period. The Python container has its own lifecycle and health
   probe; do not infer its state from Node health.
4. **No long-running blocking work in the request thread.** Heavy
   generation/sync is enqueued through scheduler/worker patterns, not
   awaited in HTTP handlers.
5. **No global mutable state survives a deploy.** Any cache that
   matters (oauth-store LRU, decrypted-token LRU, provider cost
   counters) is rebuildable from SQLite or external state on cold start.
6. **PM2 is fallback-only during bootstrap.** Its exact-artifact operator path
   exists only to recover the first container cutover and is removed after 14
   stable days. It is not an alternate continuous-deployment path.

## 3. Health endpoints (must)

1. **`/health` is the public Node readiness endpoint.** It returns 200 only
   when runtime and SQLite status are healthy; the payload includes server,
   database-probe, uptime, memory, and timestamp state without secrets.
2. **`/health/detailed` is the protected operational endpoint.** It adds cron,
   integration, provider, runtime-supervisor, Sentry, cache, and recent-error
   diagnostics. Outside local development it requires the health bearer token.
3. **`/api/snapshot` remains an authenticated running-version proof.** It is
   useful for operator diagnosis, while continuous deployment derives release
   authority from the signed manifest, immutable OCI digests, and host receipt.
4. **Both containers expose independent health.** Exact staging and production
   readiness probe Node and Python separately, validate the API smoke/public
   status, native SQLite binding, and live-database integrity, then preserve the
   exact predecessor image pair for recovery. A failed production observation
   invokes automatic predecessor recovery; database-integrity failure hard-stops.

## 4. Logging (must)

1. **Use `pino` JSON logs, not `console.log`.** Every log line is JSON.
   Severity levels are `trace | debug | info | warn | error | fatal`.
2. **Every log line carries `reqId`** when emitted within an HTTP
   request. `src/utils/request-context.ts` (AsyncLocalStorage) is the
   propagation mechanism; no log helper should accept a `reqId` arg —
   it pulls from context automatically.
3. **Every log line carries `userId`** when emitted within an
   authenticated context. `userId === tenantId` per the auth contract.
4. **Structured event surfaces are stable.** `coach-kernel.buildAthleteState…`,
   `provider.fallback`, `account_switching`, `auth.login_email` —
   these are public log surfaces; renaming them is a contract change
   for log-based dashboards.
5. **No PII in logs.** See the Security & Data Isolation standard, §8.
6. **No raw prompts, raw chat content, raw email/calendar/finance
   values.** Redaction is enforced at the log helper layer, not at the
   call site.
7. **Log level for `info` events is the default.** `debug` is
   developer-only and disabled in production. `warn` is operator-actionable.
   `error` triggers `error_monitor` and may emit an operator alert.

## 5. Tracing / correlation (should, target: must)

1. **`reqId` is the de-facto correlation id today.** Every HTTP request
   gets a fresh reqId via `request-context.ts`; cron jobs get a synthetic
   `cron:<jobName>:<timestamp>` id; tool calls inherit the parent reqId.
2. **OpenTelemetry adoption is a future target.** When adopted, the
   semantic conventions for `service.name`, `trace.id`, `span.id`,
   `db.system`, `http.method` become required. Until then, treat
   `reqId` as the trace id.
3. **Cross-process correlation (backend ↔ content-engine) carries
   `reqId` via header.** When the backend calls FastAPI, the
   `X-Request-Id` header is set. The Python engine logs the same
   `reqId` in its lines.

## 6. Metrics (should)

The current metric surfaces are:

1. **Request latency**: pino `responseTime` field on every HTTP request
   line.
2. **Provider/model fallback events**: `provider.fallback` log lines
   carry primary, fallback, taskType, latency, error class.
3. **Calendar sync metrics**: success / failure / skipped counts per
   user per provider, emitted as `calendar.sync` log lines.
4. **Tenant-denial metrics**: `tenant_scope` alert source with deduped
   counters per route per user.
5. **Cost guardrail counters**: daily totals per user and global,
   surfaced in `/admin#ai`.
6. **iOS account-switching events**: `event=account_switching` lines
   from `/auth/logout` and `/auth/logout-all`.
7. **Governed product learning**: the portal-admin-only
   `/api/v1/admin/product-learning/summary` read model exposes aggregate
   lifecycle, staleness, promotion, adaptation accept/dismiss, and Training
   category-coverage counts. Active/unexpired and historical/retired metrics
   are reported separately; only active, unexpired `golden` cases are counted
   as export eligible. It never returns case payloads or user ids.
8. **Content workspace metrics**: the portal-admin-only
   `/api/content-workspace-metrics` read model exposes global aggregate
   reliability, operation-latency, closed failure-reason, product-funnel, and
   quality counters. The five aggregate tables introduced by migration 245
   contain no tenant or user identity, timestamps, prompts, content, source
   URLs, hashes, payloads, or raw provider responses. Request-path recording
   is best effort: an in-process delta is coalesced into a SQLite transaction,
   read snapshots include unflushed deltas exactly once, and metric-storage
   failure never fails a user operation. Because pending deltas are process
   memory, an abrupt crash can lose only the not-yet-flushed aggregate delta;
   the response declares whether totals are durable, durable with pending
   writes, or process fallback rather than overstating durability.
9. **Content rollout and legacy-exit evidence**: closed aggregate signals
   record rollout-gate blocks plus legacy pipeline, ideas, topics, and
   editorial compatibility reads/mutations. The cumulative totals contain no
   identity or content and cannot alone prove a zero-traffic window; each
   supported release records start/end snapshots in governed release evidence.
   A gate may be removed only from observed zero deltas across two supported
   release windows, no kill-switch activation, successful migration/readiness
   rehearsal, and supported-client capability adoption.
10. **Local-primary inference evidence**: the portal-admin-only
    `/api/v1/admin/local-inference/summary` surface provides aggregate
    provider/workload baseline, local/fallback share, schema quality, latency,
    capacity, script-job, and cost evidence. It exposes no prompts, generated
    content, or user ids. Counterfactual savings are labelled estimates; live
    invoices, host/cgroup receipts, and store prices remain external evidence.

Training learning producers persist closed outcome codes plus tenant-scoped
SHA-256 fingerprints only. They must not persist raw plan edits, exercise ids,
calendar content, device details, or free-form feedback. Every case enters as
`observed`; only the existing Decision Center review receipt may advance it
through `candidate -> reviewed -> golden`. The backend cannot infer physical
device outcomes: an operator records those through the portal-admin-only
`POST /api/v1/admin/product-learning/physical-device-observations` contract,
which accepts an exact TestFlight build/check/result tuple and no free-form
field. The product-learning admin surface has a dedicated 16 KiB JSON limit,
a 30-request/minute per-IP pre-body throttle, and a 300-request/minute
per-process global throttle before authentication. Its tracked-IP state is
cardinality-bounded and excess unique IPs share one bounded overflow bucket,
so invalid credentials cannot create unbounded distributed audit bursts.
Accepted device observations emit
only case-specific, redacted operator audit metadata. Producers reject
observation clocks more than five minutes in the future. Product learning
never mutates prompts or starts provider-side training.

A future improvement is to ship these aggregates as proper Prometheus-style metrics
with histograms instead of structured-log derivation. Until then, use
pino-based dashboards.

## 7. Alert lifecycle (must)

The alert lifecycle is open → delivered → acknowledged → resolved → recovered.
Live incident response uses `docs/security/security-operations-runbook.md`;
the durable alert-contract rules are:

1. **Every alert has a runbook URL.** The default is the security operations
   runbook; per-source overrides exist in `error_monitor.ts`.
2. **Alert sources are durable**, not ad-hoc. Adding a new alert source
   requires a runbook entry, dedupe key strategy, and severity
   classification (`info | warning | error | critical`).
3. **Alert payloads are sanitized.** `alert-service.ts` is the
   single redaction point; secrets, raw user data, raw provider
   responses are stripped.
4. **Webhook delivery has retries with exponential backoff.** 3 attempts
   default, base 60 s. Failed delivery → `dead_letter` after the cap.
5. **Drill cadence**: a synthetic alert lifecycle drill runs at least
   every 90 days on staging. The 2026-04-25 drill is the most recent
   passing one. Re-run when the production receiver changes.

The release poller implements this boundary with its root-owned
`nexus.release-discovery-alert-state.v1` source: persist before delivery,
fixed source/severity/dedupe/runbook metadata, 60/120-second retries, durable
dead-letter, and recovery-only rearm. It never falls back to an ad-hoc send when
the durable source is unsafe.

## 8. Rollback runbook (must)

Production recovery is required, but automatic predecessor rollback is available
only after the first completed container receipt seeds that predecessor. The
first container switch instead uses the exact owner-authorized PM2 fallback
transaction. Beyond that bootstrap boundary, the default release contract is:

1. **Deploy only verified OCI identities.** Hosted release publication builds
   the backend/content-engine images and a signed payload from successful
   protected-main CI. The VPS poller deploys only immutable digests bound by that
   signature; CI has no registry credential or deploy path.
2. **Serialize the root transaction.** The systemd poller holds the kernel
   release lock and the shared root maintenance mutex before it reads or mutates
   deployment state. Receipt and state writes are durable and fail closed.
3. **Rehearse the exact topology.** Staging runs the signed migration inventory,
   exact Compose bytes, and exact image pair before production is eligible.
4. **Back up before production mutation.** The root-owned local backup service
   publishes a fresh descriptor-verified encrypted artifact. Its exact evidence
   is persisted and reverified immediately before write-ahead state; a missing or
   changed artifact stops before migration.
5. **Write ahead before migration or switch.** `production_observing` is durable
   before the production migrator and Compose switch. A crash in that window
   recovers from the persisted backup and predecessor identities, never from a
   moving tag or mutable backup pointer.
6. **Rollback restores the predecessor image pair.** Failed production health or
   the fixed 60-second observation restores the predecessor's own signed payload,
   Compose topology, and backend/content-engine digests. Recovery duration is
   recorded against the 120-second objective. Database-integrity failure does not
   swap images because an older runtime cannot repair corrupt data.
7. **Contract/destructive migrations remain blocked.** They require an
   owner-approved drain, rehearsal, database checkpoint/restore, and exact
   authorization contract that is intentionally not inferred by the unattended
   poller.
8. **PM2 is a bootstrap fallback, not the default.** The owner-approved path in
   `docs/release/README.md` exists only for first-cutover recovery and is removed
   after 14 stable days. Do not extend it or restore retired release machinery.

## 9. Incident runbook (must)

When production is degraded:

1. **Open `/admin#alerts`** to read the active alert state.
2. **Inspect authenticated `/health/detailed`** to identify which dependency
   degraded, and probe the content engine's `/health` independently.
3. **Inspect the root poller journal and exact release evidence.** Use
   `journalctl -u nexus-release-poller.service` and the root-host commands in
   `ops/nexus-release/README.md`; do not infer release identity from a container
   tag or a checked-in projection.
4. **Read authoritative state before taking action.** `release:cd:ack -- --show`
   exposes the root blocked, active, and predecessor state. The addressed root
   receipt under `/var/lib/nexus-release/receipts/` remains authoritative;
   `release:cd:state` revalidates recent immutable receipts while emitting only a
   generated, non-authoritative human projection.
5. **Let the locked poller perform supported crash recovery.** An
   `unprovable_active_release` must not be acknowledged away. Start the poller or
   invoke its flocked wrapper so it can verify the interrupted payload, backup,
   database integrity, and predecessor before recovery. Missing proof remains a
   hard stop for operator intervention; database bytes are never restored
   automatically.
6. **Inspect container logs only after binding them to the verified running
   digests.** PM2 logs are relevant solely when the documented first-cutover
   fallback is actually active during its 14-stable-day window.
7. **Record durable follow-up in the canonical project tracker** for every
   defect surfaced; do not create a one-off Markdown incident handoff or treat
   `CURRENT_RELEASE_STATE.md` as incident evidence.

## 10. Provider/model fallback safety (must)

1. **Runtime code uses provider routing abstractions.** The legacy one-shot
   helper calls Gemini primary, then its configured Gemini fallback model,
   then OpenAI, and only then an explicitly enabled Anthropic thunk. New
   local-primary work routes through `SkillInferenceService` and its approved
   cloud boundary instead of calling this cascade directly.
2. **Fallback is logged with full primary→fallback metadata.** Operators
   can dashboard fallback rate per task type to detect provider
   degradation early.
3. **Caller cancellation is terminal.** DOM/Undici aborts and cloud-SDK abort
   classes are normalized before retry and breaker accounting; no later model
   or provider hop may start after cancellation.
4. **The `degraded: true` envelope on app-facing routes** signals to iOS
   that the response is best-effort. iOS renders a banner.
5. **No silent quota cap.** When a per-user or global cap is hit, the
   user-facing response is `429 RATE_LIMITED` with an `error.code` and a
   `retryAfter` hint.
6. **Container local-primary inference is a separate, default-off runtime.**
   `config/local-model-manifest.json` is packaged in the signed backend image;
   environment selectors may name only its active production-eligible model,
   and production `canary` or `active` mode requires a digest-pinned benchmark
   winner. Backend containers reach host Ollama only through the least-privilege
   Unix-socket gateway command in the same signed image. The gateway has no
   application secrets, database, published port, or arbitrary proxy surface;
   it permits only health/version/tags/loaded-model/show/chat operations for the
   active model and independently caps context, output, request size, response
   size, residency, and deadlines. It defensively enforces the signed one-active
   generation/four-waiter envelope and revalidates that envelope when each
   queued request is dispatched; the application scheduler remains the sole
   product priority queue. A missing resident model triggers one
   single-flight gateway-owned warm request for the fixed signed model before
   the original request proceeds; client fields cannot influence that call.
   Production and staging use separate
   UID-10001-owned mode-0700 socket directories. The bridge is added to the
   signed Compose topology only after the attended host preflight creates and
   verifies those directories and the Ollama service envelope.

   Runtime admission has default-off feature flags plus the audited
   `off | shadow | canary | active` database control. An owner/admin mutation
   records the actor, previous and next mode, percentage, manifest, reason, and
   evidence reference in the same transaction. Mode `off` rejects waiting
   in-memory requests after that audited transaction commits and rejects new
   Content jobs; already durable jobs remain `waiting_capacity` at encrypted
   checkpoints and do not spend cloud budget. Shadow evaluation is detached
   from the cloud response and records a separate attempt only after a
   successful, non-degraded visible result, without adding local latency to the
   user-visible request. The environment hard kill is an
   attended emergency control. One model is resident, one generation runs at a
   time, four interactive requests may wait, and Max/Pro scheduling is weighted
   2:1 with starvation protection. The production host envelope is 8 CPUs,
   `MemoryHigh=18G`, `MemoryMax=20G`, zero swap, `Nice=10`, and at least 6 GiB available
   host memory; 24 GiB is benchmark-only. Cloud budget is acquired lazily only
   around an actual approved cloud attempt, with ordinary daily/monthly limits
   plus plan-owned hard local-fallback run/day ceilings and durable per-provider
   attempt reservations. Private Content rewrite/expand, Chat Content
   refinement, and specialist payloads remain local-only after local-primary
   admission. With local routing OFF or outside the cohort, independently
   authorized legacy cloud paths remain available. Resumable script jobs,
   including short Reel jobs, generate
   a validated outline and then one bounded section at a time, renewing the
   lease and encrypting each validated checkpoint before starting the next
   section. Under the owner-approved 2026-08-21 classification, these script-
   generation packets are non-sensitive and may use the approved OpenAI
   delivery binding after a local failure or unavailable local route. Every
   such attempt still passes the provider/model/service-tier gate and
   serialized user/plan/run budget; the completed job records `local`, `cloud`,
   or `mixed` provenance.

   The additive Content job API is `POST /api/v1/content/script-jobs`, tenant-
   scoped `GET`, `POST .../cancel`, and `POST .../retry`. It exposes the six
   declared durable states and returns a result only after final validation.
   Existing synchronous routes remain compatible and may report `ollama` in
   their additive provider field. Content Engine delegation uses a separately
   transported request-proof key plus an encrypted token envelope; the exact
   normalized callback is MACed before a shared SQLite nonce ledger atomically
   consumes its run UUID. Token-only replay or request mutation is rejected
   before Python work can reach inference.

   The application rollback monitor uses governed inference telemetry plus a
   bounded process-local request ring. It turns routing OFF for the documented
   local success/fallback/Chat/script thresholds, script-job p95 above 12
   minutes, non-AI p95 regression above 5%, public 5xx regression above 0.5
   percentage points, host-view memory below 6 GiB, any host-view swap, manifest
   outage/version drift, specialist-profile drift, or observed local-model
   digest drift. A
   restart begins a new current request sample window. `/proc/meminfo` and the
   request ring are immediate guards; the attended cgroup/host receipt and host
   observability remain the authoritative sustained-capacity evidence.
   Classifier shadow uses its explicit Ollama provider through the same routing
   provider circuit, without enabling fallback; local queue pressure does not
   count as provider-health failure.
7. **The PM2 first-cutover fallback remains fallback-only.** Until the attended
   local-primary host transaction occurs, the authoritative release-state
   projection continues to describe the observed 3B/4G/6G host preimage. That
   is historical live-state evidence, not the target envelope encoded by this
   release. The fallback's Ollama selectors must repeat the active signed
   manifest tag; the absent fast-chat path defaults off.
   Classification remains Gemini-primary. Full script generation and larger
   reasoning route through the approved cloud/privacy gate and fail visibly
   when the content or model is not approved; local execution requires an
   explicit evaluation mode. Approved cloud script generation uses the exact
   provider/model selected by that gate in a dedicated two-pass JSON pipeline
   (plan, then artifacts); it disables tools, rejects malformed or drifting
   schemas, and enters the same path/symlink sandbox, deterministic validators,
   and run persistence as offline-local evaluation. A generic domain completion
   is never cast into a script-generation result.
   The environment-mutation and PM2 staging procedure that follows is retained
   only for the owner-authorized first-cutover fallback during the initial 14
   stable days. Before that fallback's first staging boot, inspect both
   environment values and persisted model overrides: set `OLLAMA_MODEL`,
   `OLLAMA_CLASSIFIER_MODEL`, `CHAT_CORE_V2_LOCAL_CHAT_MODEL`, and the recipe
   model to the active signed-manifest tag; set `CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL=off`;
   remove the retired `OLLAMA_OPERATIONAL_ROLLBACK_MODEL`; and remove or replace
   every persisted Ollama override. Startup and per-request dispatch reject any
   remaining large-model selector instead of silently changing it. The Ollama
   staging smoke must prove the authenticated Gemini and Ollama runtime health
   plus the live PM2 environment: Gemini is the classification primary,
   classification and local chat are shadow-only, local script/reasoning
   evaluation is off, cloud fallbacks are the approved reasoning gate, and all
   local model selectors repeat the signed manifest with fast chat off. Missing
   settings do not inherit defaults during this promotion check.
8. **The attended local-primary host transaction owns the new envelope.** It
   binds loopback-only Ollama to one loaded model, one parallel request, queue
   depth four, 16K maximum context, 8 CPU quota, `MemoryHigh=18G`,
   `MemoryMax=20G`, and zero swap. The former PM2 lean finalizer is not the
   local-primary entrypoint and must not be used to select, pull, or activate a
   benchmark winner. The envelope installer accepts only an owner-digest-verified
   Git archive whose PAX commit equals the SHA-named root bootstrap, restores
   all replaced operational assets and the exact prior service state on
   failure, and must not install a binary or pull a mutable model tag.
   It requires the reviewed Ollama binary and systemd service-fragment digests,
   and transaction commit independently verifies the retained tag/digest.
   A permanent root-owned install-state guard is bootstrapped and loaded before
   the first journal write, so a power loss before candidate publication still
   blocks Ollama startup until exact recovery.
   Commit and rollback seal an exact-result terminal journal before best-effort
   predecessor-backup garbage collection. An active predecessor with no prior
   override receives only a one-use restart authorization bound to the
   transaction, candidate digest, current boot, and live rollback-helper PID;
   reboot or replay remains blocked. The separately acknowledged socket
   transaction verifies the settled signed release, Ollama 0.24+, model digest,
   host RAM/disk/swap, effective envelope, loopback listener, tmpfiles policy,
   and staging/production directory preimage before mutation. It shares the
   release maintenance mutex, emits a root-owned receipt, and has a bounded
   rollback for both the activated tmpfiles policy and empty directories so
   reboot cannot recreate a reverted socket boundary. None of these host
   transactions is a continuous application-deployment gate. A receipt-bound benchmark transaction
   may temporarily apply `MemoryHigh=22G` and `MemoryMax=24G` only while both
   gateway sockets are absent. It keeps zero swap, 8 CPUs, and `Nice=10`, uses
   the same maintenance mutex, and will not finish rollback until the 18G/20G
   production envelope is effective again.
9. **Captured coach evaluations are local-only by default.** A cloud comparison
   requires an explicit cloud mode plus the per-run
   `--operator-authorize-private-cloud` acknowledgement. The script classifies
   captured Garmin prompts as private and calls the configured cloud provider
   only after `cloud-reasoning-gate` approves both model and raw-private-data
   policy; a rejection is visible and no direct provider fallback is allowed.

## 11. Cost guardrail (must)

1. **Daily AI spend caps** are configured via env (per-domain, per-user,
   global). Exceeding a tier emits an operator alert.
2. **Cost telemetry is logged at the SDK wrapper layer** (`trackedCreate`
   for Anthropic; `track*Generate` for Gemini and OpenAI). Direct SDK
   calls bypass cost logging and are forbidden.
3. **The `/admin#ai` portal page** surfaces today's spend per domain
   and recent fallback events.

## 12. Postdeploy monitoring (must)

After every production deployment, within 1 h:

- [ ] Node `/health` returns 200 and reports healthy SQLite state.
- [ ] Authenticated `/api/snapshot` returns the new package version.
- [ ] Content-engine `/health` returns 200 independently.
- [ ] Backend and content-engine containers run the manifest-pinned digests.
- [ ] The immutable release receipt records `completed`, or the exact recovery
      outcome and predecessor identity.
- [ ] No new error-monitor alerts opened in the last 30 min.
- [ ] No new tenant-scope alerts opened.
- [ ] No new degraded-response alerts at unusual rate.
- [ ] Status portal `/portal/health` is accessible.

The poller enforces immediate loopback/public readiness, the fixed 60-second
observation, and automatic predecessor rollback. Audit-mirror delivery remains
non-gating and is reconciled from the immutable local receipt.

## 13. Data shape and disposability (must)

1. **SQLite is the system of record.** It must be backed up before any
   migration and by an hourly online recovery-point timer.
2. **Recovery points live under the governed local backup directory**
   (`/srv/nexus-backups/application/` in the current single-VPS deployment)
   with timestamp identity. Keep 24 hourly, 30 daily, 4 weekly, and 10
   pre-promotion encrypted points. This is operational rollback protection,
   not protection against full server or NVMe loss.
3. **Cold-restart recovers all behavior** within 30 s. Caches are
   rebuilt; OAuth tokens decrypt on first use; cron scheduler picks up
   from last-run timestamps.
4. **The Python content-engine has no persistent state.** It reads
   from SQLite via the backend; restart is safe.

## 14. Operational checklists

### Daily

- [ ] No open critical alerts.
- [ ] `/admin#issues` has no unacknowledged open issue; `/admin#support` has no
      `new` ticket older than 48 h.
- [ ] No degraded provider state (Garmin, Google, Outlook, OAuth
      providers).
- [ ] Backend and content-engine containers are healthy; any restart is explained.
- [ ] Latest encrypted SQLite recovery point is no more than one hour old.

### Weekly (Sunday 06:00 UTC)

- [ ] Generated project map freshness checked automatically by
      `weekly-housekeeping.yml`.
- [ ] `npm run docs:audit` checked automatically by
      `weekly-housekeeping.yml`.
- [ ] If legacy local smoke evidence is still retained, review the dry-run from
      `scripts/smoke-evidence-prune.sh`; no scheduled destructive invocation is
      currently authorized.

### Per-deploy

- [ ] Required staging smoke suite green; check count is release-dependent.
- [ ] Production health-check green.
- [ ] Backend and content-engine run the signed manifest digests.
- [ ] Exact backup evidence and immutable terminal receipt are present.
- [ ] Audit-mirror acknowledgement exists or a durable retry obligation remains.

### Per-incident

- [ ] Alert acknowledged within 15 min.
- [ ] Root cause identified before resolve.
- [ ] Regression test landed before fix.
- [ ] Postmortem written within 7 days for any P0 incident.

## 14a. Operator portal surfaces (Observe / Support)

The admin portal (`:8200`, operator tokens only) is the day-to-day triage
surface; `ssh … pm2 logs` is the fallback, not the default.

- **Logs** (`/admin#logs`, `GET /api/ops/logs`, SSE `GET /api/ops/logs/stream`):
  a second pino stream fills an in-memory ring and the bounded `runtime_logs`
  table (info and above, already redacted; 72 h / 500k rows). Filters: level,
  `src`, `reqId`, `userId`, text. `LOG_STORE_ENABLED=false` disables capture;
  stdout for the container is unchanged either way.
- **Requests** (`/admin#requests`, `GET /api/ops/requests`, `/api/ops/requests/:reqId`,
  `/api/ops/latency`, `/api/ops/rate-limits`): the sampled `http_request_log`
  ledger keeps every non-2xx, every request ≥ 500 ms, and every portal
  mutation; polling paths are sampled 1-in-50 and fast 2xx at
  `HTTP_LOG_SAMPLE_RATE` (default 0.1). IPs are salted hashes
  (`HTTP_LOG_IP_SALT`). Retention 7 d / 500k rows. A row opens the correlated
  runtime log lines and error rows for the same `reqId`.
- **Issues** (`/admin#issues`, `GET /api/ops/issues`): `error_log` and iOS
  `client_errors` grouped by fingerprint (kind + source + normalised message +
  first stack frame) into `issues` with ack / resolve / mute / reopen (admin,
  audited as `issue.<action>`). A resolved issue that recurs is reopened,
  marked regressed, and raises a `warning` alert from source `issue_tracker`.
- **Support** (`/admin#support`, `GET /api/support/tickets`): tickets from
  in-app feedback (`POST /api/v1/support/feedback`, 5 per user per hour,
  allowlisted diagnostics only, never chat content), from an Issue or an
  Operator Alert ("Ticket" buttons), email intake, and operator tasks. States
  `new → open → waiting_user → resolved → closed`, priorities `p0..p3`, one
  timeline event per change; new tickets raise an `info` alert from source
  `support` (`critical` for `p0`). The app can list its own tickets' status
  only (`GET /api/v1/support/feedback/mine`).
- **Users drawer**: sign out one or all devices, revoke a push token, inspect
  or clear the login lockout, and see the provider connection matrix. All are
  admin mutations audited as `user.*`. There is no impersonation and no
  operator password reset.
- **Release card** (`/admin#dashboard`, `GET /api/release`): version, the
  container identity from `NEXUS_RELEASE_SHA` / `NEXUS_RELEASE_ARTIFACT_SHA256`
  / `NEXUS_RELEASE_ROLE` (the build stamp `dist/release-stamp.json` fills in
  branch and commit detail), boot time, applied vs pending migrations, admin
  exposure mode, and whether Sentry and the operator-alert webhook are
  configured (booleans only). `/health` carries `version` and `gitShortSha`.

- **Jobs** (`/admin#jobs` Job Control card, `GET /api/jobs`,
  `GET /api/jobs/:name/history`, `POST /api/jobs/:name/run`): every cron job
  with its AgentJobManifest governance (policy owner, provider usage, cost and
  overlap policy), lifecycle, next fire time, and 24 h outcome counts. Manual
  runs are admin mutations audited as `job.run` with a 30 s cooldown per job;
  jobs paused by the manifest or whose sub-skill is disabled are denied, and
  provider-capable jobs require `{"confirm": true}`. Pause/resume is a
  reviewed change to `config/agent-job-manifest.json`, not a runtime toggle.
- **Queues & Flags** (`/admin#operate`): `GET /api/ops/queues` reports depth by
  status and oldest pending age for `background_jobs` and `event_outbox`;
  `GET /api/ops/queues/dead-letter` lists dead letters across tenants and
  `POST /api/ops/queues/:kind/:id/{replay,cancel}` delegates to the
  tenant-scoped queue services (audited as `queue.<kind>.<action>`).
  `GET /api/ops/flags` renders the runtime flag catalog
  (`src/services/runtime-flags-catalog.ts`, pinned to the exports of
  `runtime-flags.ts` by test) as parsed values plus env-key presence, never raw
  env strings; env flags are read-only. The DB-backed hybrid kill switches are
  the only mutable switches (`POST /api/ops/flags/kill-switches/:key`, audited
  as `hybrid_kill_switch.<key>`, same service as the iOS admin route).
  `GET /api/ops/provider-health-history` buckets `integration_health` probes
  per provider and hour; `GET /api/ops/notification-delivery` (admin)
  summarizes `notification_delivery_attempts` by status, channel, provider and
  APNs response code. The webhooks card is read-only over the existing
  `/api/webhooks/{stats,subscriptions,events}` routes.
- **Audit** (`/admin#audit`, `GET /api/audit-trail`): filters by user, actor,
  action, resource prefix, free text and time range, cursor paging with
  `beforeId`, `GET /api/audit-trail/facets` for dropdowns, and
  `format=csv` for a server-rendered export (spreadsheet-formula cells are
  neutralized).

- **Cookie sessions and CSP** (`POST /api/auth/session`, `GET /api/auth/session`,
  `POST /api/auth/session/logout`): with `PORTAL_SESSION_SECRET` set, the SPA
  exchanges the portal token once for a signed `ps_` session in an HttpOnly,
  SameSite=Strict `portal_session` cookie scoped to that token's rights
  (read/write/admin) and capped at 8 h or `PORTAL_SESSION_MAX_AGE_MS`; the
  session survives reloads and every mutating request must carry the
  `x-portal-csrf` proof returned at sign-in (`rejectCookieSessionCsrf`).
  Without the secret the routes answer 503 and the in-memory bearer flow
  remains. The dashboard ships no inline script: the SPA lives in
  `src/portal/ui/legacy.js` plus the ES modules and markup uses `data-act`
  delegation, so the dashboard CSP is `script-src 'self'` (no
  `'unsafe-inline'`); `__tests__/portal/portal-csp-no-inline.test.ts` keeps
  it that way. Background tabs pause polling; badge counts ride the alerts
  stream (`/api/ops/alerts/stream` now carries issues and support summaries).

Triage loop: Issues → open the last request → read its log lines → fix →
resolve the issue and let the regression alert say if it comes back. Quote the
`x-request-id` from the app or the response headers when reporting.

## 15. Forbidden runtime patterns

- ❌ `setTimeout(fn, very_long)` for "do this in 24 h" — use the cron
   scheduler. Process-restart loses the timer; cron survives.
- ❌ In-memory rate limiters that wipe on restart for production-grade
   abuse control. Move to Redis-backed when scaling (AUTH-O14).
- ❌ Direct SQLite writes from Telegram bot handlers; route through
   service modules so all writes go through the same validation.
- ❌ `fs.writeFileSync` on the request thread — block the event loop.
- ❌ Calling `await` inside a `for` loop where `Promise.all` would do —
   N×latency hit on app-facing routes.
- ❌ `JSON.parse` in a tight loop without a try/catch — one malformed row
   crashes the loop.

## 16. PR checklist (runtime/ops changes)

- [ ] No new env-key without a default in `src/config.ts` AND a runbook
      entry in `ops/nexus-release/README.md` or the owning canonical runbook.
- [ ] Health-check change has a corresponding `/health` or `/health/detailed`
      assertion.
- [ ] New alert source has a runbook entry and a dedupe strategy.
- [ ] New log surface has a stable name and is documented in §4 above.
- [ ] No new direct provider SDK call (`anthropic.messages.create`,
      `gemini.generateContent`, `openai.chat.*`).
- [ ] Cost telemetry routed through `trackedCreate` (or the equivalent
      Gemini/OpenAI wrappers).
- [ ] Graceful shutdown still drains in ≤ 10 s.
