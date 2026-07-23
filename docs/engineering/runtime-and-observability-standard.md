# Runtime, Observability, and Operations Standard

Status: canonical
Owner: backend runtime + on-call lead
Last verified: 2026-07-22
Update policy: update when health-check shape changes, when alert
producers change, when log/metric semantics change, or when the release
process model changes. Incident response and recovery detail lives in
`docs/security/security-operations-runbook.md`; exact-artifact deployment
is governed by `docs/release/README.md`.

This standard is the single source of truth for how Nexus Hub's backend
runs, logs, traces, alerts, and recovers. It is grounded in the
Twelve-Factor App principles and OpenTelemetry-style semantics, then
translated into the realities of the single-VPS / two-process PM2 /
Cloudflare Tunnel deployment and its immutable release directories.

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

1. **Two independent PM2 processes run in production.** `nexus-hub` owns the
   Node API/portal on port 8200 and `content-engine` owns the Python service on
   port 8100. Neither process starts or supervises the other; PM2 restarts each
   independently from `ecosystem.release.config.js`.
2. **The release directory is part of process identity.** Both PM2 entries must
   be online, carry the same `NEXUS_RELEASE_SHA`, and use the expected exact
   release cwd (`<release>` and `<release>/content-engine`). The production
   `current` symlink must resolve to that same release before promotion,
   backup, readiness success, or rollback success is accepted.
3. **Graceful backend shutdown handles `SIGTERM`.** The Node process closes the
   HTTP server, flushes Sentry best-effort, closes SQLite, and exits inside the
   PM2 kill timeout. The Python process has its own PM2 lifecycle and health
   probe; do not infer its state from Node health.
4. **No long-running blocking work in the request thread.** Heavy
   generation/sync is enqueued through scheduler/worker patterns, not
   awaited in HTTP handlers.
5. **No global mutable state survives a deploy.** Any cache that
   matters (oauth-store LRU, decrypted-token LRU, provider cost
   counters) is rebuildable from SQLite or external state on cold start.

## 3. Health endpoints (must)

1. **`/health` is the public Node readiness endpoint.** It returns 200 only
   when runtime and SQLite status are healthy; the payload includes server,
   database-probe, uptime, memory, and timestamp state without secrets.
2. **`/health/detailed` is the protected operational endpoint.** It adds cron,
   integration, provider, PM2-supervisor, Sentry, cache, and recent-error
   diagnostics. Outside local development it requires the health bearer token.
3. **`/api/snapshot` is the authenticated running-version proof** used by exact
   promotion to confirm the public endpoint serves the manifest package
   version after cutover.
4. **The PM2 `nexus-hub` and `content-engine` processes both expose
   health.** Exact staging and production readiness probe Node and Python
   separately, then validate authenticated Content Engine readiness, native
   SQLite binding, live-database integrity, and two stable PM2 cwd/SHA identity
   samples before disabling automatic rollback. Any failed candidate check
   invokes automatic exact predecessor recovery.

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

Production rollback is **always available**. The default release contract is:

1. **Use the exact-artifact operator path:** `npm run release:status`,
   `release:prepare`, `release:staging`, then owner-authorized
   `release:promote`. The signed `ReleaseManifestV2`, staging attestation, and
   installed-runtime digest must all bind the same runtime SHA and bundle.
2. **Install before cutover.** Node/Python dependencies and native modules are
   prepared in a versioned staging release while production stays online.
   Promotion copies that already installed directory; it does not rebuild or
   install dependencies while production is stopped.
3. **Back up the exact predecessor.** Immutable runtime content is prepared
   live. During the brief write drain, both independent PM2 apps stop, SQLite
   is checkpointed and integrity-checked, and the database snapshot is added
   to the verified release backup. For an irreversible migration, the helper's
   archive path, SHA-256, size, versions, and timestamp are captured in the
   ignored strict migration evidence record and revalidated before candidate
   mutation begins.
4. **Rollback restores exact bytes and state.** If symlink, PM2 identity,
   loopback health, public health, or snapshot-version readiness fails, restore
   the exact backup and previous release directory automatically. Revalidate
   archive path, size, whole-archive SHA-256, and stopped-state database SHA-256
   before data mutation; reject traversal, duplicate paths, links, devices, or
   unsupported archive members. A changed or irreversible migration still
   requires explicit owner approval.
5. **Promotion is a durable server transaction.** Before the first PM2
   mutation, persist a root-owned immutable request, predecessor identity, and
   recovery intent. A Mac/SSH disconnect must not interrupt the transaction.
   Reboot recovery completes before normal PM2 startup, and failed readiness
   restores healthy predecessor service within 120 seconds. Use the Linux
   monotonic clock for the same-boot 60-second candidate boundary and total
   120-second budget; persist cutover, actual-unavailability, candidate-healthy,
   and predecessor-recovered timestamps. Reboot wall timing is diagnostic and
   requires the staging reboot drill before the bound is considered proven.
6. **Runtime immutability is root-verified.** The production base is
   root-owned/sticky, its `releases/` child is root-owned and application
   non-writable, and a narrow root operation creates the exact target without
   following or replacing links. Root-installed code verifies predecessor and
   candidate artifact/installed-tree digests and safe dependency links, seals
   all runtime entries read-only, and verifies again before candidate code runs.
7. **The soak is evidence, not downtime.** Preserve the exact 60-second
   stability soak. Record service unavailability separately from total cutover
   duration so the soak is never shortened to improve a headline metric.
8. **Capacity and rollback freshness fail closed.** Staging and promotion
   require a rollback drill no more than 30 days old, at least 12 GiB available
   memory, load-15 below 6, no sustained swap pressure or recent OOM/restart
   delta, and no active Sonar Compute Engine analysis.
9. **Advisory workloads prove host headroom before activation.** SonarQube
   start requires a checksummed, same-boot preflight no more than two hours old
   with at least 16 GiB available memory, load-15 below 6, zero swap delta,
   zero recent OOMs, stable PM2/health, and complete listener/route/firewall
   snapshots captured after Docker client/server installation. It also
   requires the exact successful 24h staging then 24h production small-model
   soak and cleanup evidence chain. Each window is backed by canonical,
   mode-0600 path+SHA-256 health/request records that cover the full interval,
   preserve the retained-model digest, and report zero health failures,
   OOMs, restart deltas, pressure, or large/unapproved-model requests. Live Sonar state is
   bind-mounted below the root-controlled `/srv/sonarqube/data` boundary.
10. **Legacy repository-sync wrappers are retired.** The deleted `deploy.sh`,
   `deploy-staging.sh`, and `promote-to-prod.sh` paths must not be restored or
   invoked. Exact `scripts/rollback.sh` and restore tooling remain available
   for emergency predecessor recovery.

## 9. Incident runbook (must)

When production is degraded:

1. **Open `/admin#alerts`** to read the active alert state.
2. **Inspect authenticated `/health/detailed`** to identify which dependency
   degraded, and probe the content engine's `/health` independently.
3. **`pm2 logs nexus-hub --lines 200`** for raw stack traces if the
   alert payload is sanitized too aggressively.
4. **`pm2 logs content-engine --lines 200`** if the independent Python process
   is the suspect.
5. **Use exact release evidence first.** Run `npm run release:status` against
   the manifest and inspect the current release/backup identity before invoking
   emergency rollback tooling.
6. **Update `docs/release/CURRENT_RELEASE_STATE.md`** with the incident
   timeline within 24 h.
7. **Record durable follow-up in the canonical project tracker** for every
   defect surfaced; do not create a one-off Markdown incident handoff.

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
   Before the first small-only staging boot, inspect both environment values
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
   `MemoryHigh=4G`, `MemoryMax=6G`, and at most 512 MiB swap. Move swap to zero
   only after the additional healthy observation window. Staging, production,
   cleanup, Sonar enablement, and zero-swap authorization must use the
   root-installed foreground observation collector. Hand-authored aggregates
   are not evidence. Its canonical mode-0600 result must resolve to a bounded
   raw hash chain captured on one boot and to exact-window read-only SQLite
   `api_usage` counts by provider/model with fail-closed pricing/local-unit
   persistence. The production window must reference and revalidate the prior
   staging result; the zero-swap window must bind the exact cleanup result.
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

After every production promote, within 1 h:

- [ ] Node `/health` returns 200 and reports healthy SQLite state.
- [ ] Authenticated `/api/snapshot` returns the new package version.
- [ ] Content-engine `/health` returns 200 independently.
- [ ] PM2 `nexus-hub` is online and uptime ≥ 5 min.
- [ ] PM2 `content-engine` is online and uptime ≥ 5 min.
- [ ] No new error-monitor alerts opened in the last 30 min.
- [ ] No new tenant-scope alerts opened.
- [ ] No new degraded-response alerts at unusual rate.
- [ ] Status portal `/portal/health` is accessible.

The exact promotion command enforces immediate loopback/public readiness and
automatic rollback. The operator completes the longer observation window and
records evidence under ignored `.local/release/` paths or CI artifacts.

## 13. Data shape and disposability (must)

1. **SQLite is the system of record.** It must be backed up before any
   migration and by an hourly online recovery-point timer.
2. **Release backups live under the governed remote backup directory**
   (`/home/dominguez/backups/nexushub/` in the current single-VPS deployment)
   with version/timestamp identity. Routine database backups retain their
   separately governed lifecycle.
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
- [ ] PM2 uptime ≥ 24 h or last restart was a planned deploy.
- [ ] Latest encrypted SQLite recovery point is no more than one hour old.

### Weekly (Sunday 06:00 UTC, automated via
`weekly-housekeeping.yml`)

- [ ] Smoke-evidence pruned (60-day retention).
- [ ] Generated project map and current release-state consistency checked.
- [ ] `npm run docs:audit` total recorded.

### Per-deploy

- [ ] Required staging smoke suite green; check count is release-dependent.
- [ ] Production health-check green.
- [ ] PM2 nexus-hub + content-engine online.
- [ ] Smoke, installed-tree, PM2-identity, staging-attestation, and production
      evidence written under `.local/release/` or CI artifacts.
- [ ] `docs/release/CURRENT_RELEASE_STATE.md` updated.

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
      entry in `docs/release/README.md`.
- [ ] Health-check change has a corresponding `/health` or `/health/detailed`
      assertion.
- [ ] New alert source has a runbook entry and a dedupe strategy.
- [ ] New log surface has a stable name and is documented in §4 above.
- [ ] No new direct provider SDK call (`anthropic.messages.create`,
      `gemini.generateContent`, `openai.chat.*`).
- [ ] Cost telemetry routed through `trackedCreate` (or the equivalent
      Gemini/OpenAI wrappers).
- [ ] Graceful shutdown still drains in ≤ 10 s.
