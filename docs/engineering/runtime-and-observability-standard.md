# Runtime, Observability, and Operations Standard

Status: canonical
Owner: backend runtime + on-call lead
Last verified: 2026-08-09
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
   `FOSSA_EMAIL_ENABLED=1`, `IOS_REQUIRE_UDID=1`,
   `PORTAL_BETA_HARDENED=true`, `NEXUS_DEPLOY_SKIP_VERIFY=1`. Default off
   for any flag that exposes new behavior.
4. **Secrets never appear in `process.env` log dumps.** A debug helper
   that dumps env should redact every key matching
   `/(token|secret|key|password|webhook)/i`.

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

1. **`completeOneShotWithFallback(taskType, prompt, opts)`** is the
   default routing helper. It calls Gemini first (per
   `providerRouting`); on failure or quota cap, falls back to Anthropic;
   on second failure, OpenAI.
2. **Fallback is logged with full primary→fallback metadata.** Operators
   can dashboard fallback rate per task type to detect provider
   degradation early.
3. **The `degraded: true` envelope on app-facing routes** signals to iOS
   that the response is best-effort. iOS renders a banner.
4. **No silent quota cap.** When a per-user or global cap is hit, the
   user-facing response is `429 RATE_LIMITED` with an `error.code` and a
   `retryAfter` hint.
5. **ServerDominguez is small-model only.** The only permitted Ollama tag is
   `qwen2.5:3b-instruct-q4_K_M`; the absent fast-chat path defaults off.
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
   stable days. Before that fallback's first small-only staging boot, inspect both environment values
   and persisted model overrides: set `OLLAMA_MODEL`,
   `OLLAMA_CLASSIFIER_MODEL`, `CHAT_CORE_V2_LOCAL_CHAT_MODEL`, and the recipe
   model to the retained 3B tag; set `CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL=off`;
   remove the retired `OLLAMA_OPERATIONAL_ROLLBACK_MODEL`; and remove or replace
   every persisted Ollama override. Startup and per-request dispatch reject any
   remaining large-model selector instead of silently changing it. The Ollama
   staging smoke must prove the authenticated Gemini and Ollama runtime health
   plus the live PM2 environment: Gemini is the classification primary,
   classification and local chat are shadow-only, local script/reasoning
   evaluation is off, cloud fallbacks are the approved reasoning gate, and all
   local model selectors are explicit 3B values with fast chat off. Missing
   settings do not inherit defaults during this promotion check.
6. **Ollama has a hard host envelope.** Bind loopback-only with one loaded
   model, one parallel request, queue depth four, 4096 context, 2 CPU quota,
   `MemoryHigh=4G`, `MemoryMax=6G`, and exactly 512 MiB swap. The old staged
   observation, cleanup, and zero-swap chain is retired. The finalizer procedure
   below is PM2 first-cutover fallback only and must be completed before the
   container bootstrap; there is no supported post-bootstrap container
   maintenance transaction for this mutation. After one exact fallback release
   has passed both staging and production, run the root-installed
   `nexus-ollama-lean-finalize.mjs` command first in dry-run mode. Apply
   requires the exact printed plan digest plus explicit owner authorization.
   The command holds both the user fallback-release mutex and the shared root
   maintenance mutex (whose `-sonar` filename is historical), and binds the same
   passing PM2 fallback release SHA and artifact digest across both transaction
   states, current symlinks, and all four PM2 processes. It accepts only the audited four-tag full-digest
   inventory, refuses a loaded deletion target, and removes only Gemma 2B,
   Qwen 27B, and Qwen 35B after the fixed envelope restarts and the retained
   3B model passes a bounded inference smoke. Restart or smoke failure restores
   the exact predecessor drop-in. A root-only receipt records before/after
   release, PM2, envelope, model, and rollback evidence; no Sonar state is read
   or carried.
   The envelope installer accepts only an owner-digest-verified
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
   reboot or replay remains blocked.
   The fixed envelope and finalizer must be installed before that cutover-era
   small-only PM2 release. They are not a continuous-deployment gate.
7. **Captured coach evaluations are local-only by default.** A cloud comparison
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
