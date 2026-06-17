# Runtime, Observability, and Operations Standard

Status: canonical
Owner: backend runtime + on-call lead
Last verified: 2026-06-16
Update policy: update when health-check shape changes, when alert
producers change, when log/metric semantics change. The runbook companion
at `docs/OBSERVABILITY-ONCALL.md` is preserved for alert lifecycle
detail.

This standard is the single source of truth for how Nexus Hub's backend
runs, logs, traces, alerts, and recovers. It is grounded in the
Twelve-Factor App principles and OpenTelemetry-style semantics, then
translated into the realities of the single-VPS / PM2 / Cloudflare
Tunnel deployment.

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

1. **One backend process (`nexus-hub`) + one Python content-engine
   subprocess (`content-engine`) under PM2.** The Python engine is
   started as a child by the backend and restarted on crash.
2. **Graceful shutdown handles `SIGTERM`.** The backend drains in-flight
   HTTP requests up to 10 s, flushes pino buffers, closes the SQLite
   connection, then exits. `pm2 reload` triggers this; `pm2 restart`
   does not (kills immediately).
3. **No long-running blocking work in the request thread.** Heavy
   generation/sync is enqueued through scheduler/worker patterns, not
   awaited in HTTP handlers.
4. **No global mutable state survives a deploy.** Any cache that
   matters (oauth-store LRU, decrypted-token LRU, provider cost
   counters) is rebuildable from SQLite or external state on cold start.

## 3. Health endpoints (must)

1. **`/api/health` returns 200 with `{ ok: true, version, commit }`** when
   the backend is up and SQLite is reachable. No auth required.
2. **`/api/health/deep` returns 200 with per-dependency state** for PM2
   deploy gates. Includes: SQLite ok, content-engine subprocess ok,
   provider connectivity ok (with last-success timestamps), cron
   scheduler heartbeat, audit-trail writable.
3. **`/api/snapshot` returns the running version** (commit + version
   string from `package.json`). Used by `promote-to-prod.sh` post-deploy
   to verify the new binary is live.
4. **The PM2 `nexus-hub` and `content-engine` processes both expose
   health.** A deploy that fails to start either process triggers
   automatic rollback in `deploy.sh`.

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

A future improvement is to ship these as proper Prometheus-style metrics
with histograms instead of structured-log derivation. Until then, use
pino-based dashboards.

## 7. Alert lifecycle (must — see OBSERVABILITY-ONCALL.md)

The complete alert lifecycle (open → delivered → acknowledged → resolved
→ recovered) is documented in `docs/OBSERVABILITY-ONCALL.md`.
The standard-level rules are:

1. **Every alert has a runbook URL.** The default is the
   OBSERVABILITY-ONCALL.md doc; per-source overrides exist in
   `error_monitor.ts`.
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

Production rollback is **always available**. The contract:

1. **`scripts/rollback.sh` is tested in dry-run mode** before
   each deploy. The `--dry-run` flag prints the mutation surface
   without applying.
2. **Last-known-good production tag**: every deploy creates
   `prod-<version>` and `prod-<version>-pre-rollback-target` tags. The
   rollback script reads the target tag from `deploy-state.json`.
3. **Database rollback is migration-driven.** A migration that has
   landed cannot be rolled back without a down-migration; the inverse
   migration approach in §9 of the API contract standard is the
   foundation.
4. **Worktree-safety**: the deploy/rollback scripts exclude
   `worktrees/.git`, agent state, and local backup files so a branch
   worktree deploy is safe.

## 9. Incident runbook (must)

When production is degraded:

1. **Open `/admin#alerts`** to read the active alert state.
2. **Inspect `/api/health/deep`** to identify which dependency degraded.
3. **`pm2 logs nexus-hub --lines 200`** for raw stack traces if the
   alert payload is sanitized too aggressively.
4. **`pm2 logs content-engine --lines 200`** if the content-engine
   subprocess is the suspect.
5. **`scripts/rollback.sh --dry-run` before applying.** Confirm
   the mutation surface matches the operator's intent.
6. **Update `docs/release/CURRENT_RELEASE_STATE.md`** with the incident
   timeline within 24 h.
7. **Open OPEN_ITEMS entries for any defect surfaced** during the
   incident.

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

- [ ] `/api/health` returns 200 with the new version.
- [ ] `/api/snapshot` returns the new version.
- [ ] PM2 `nexus-hub` is online and uptime ≥ 5 min.
- [ ] PM2 `content-engine` is online and uptime ≥ 5 min.
- [ ] No new error-monitor alerts opened in the last 30 min.
- [ ] No new tenant-scope alerts opened.
- [ ] No new degraded-response alerts at unusual rate.
- [ ] Status portal `/portal/health` is accessible.

The 1-hour gate is automatic via `deploy.sh` postdeploy block; the
operator confirms manually if the auto-gate is bypassed.

## 13. Data shape and disposability (must)

1. **SQLite is the system of record.** It must be backed up before any
   migration and on a daily cadence.
2. **Backups live at `data/backups/`** with timestamp. A 30-day
   rolling window is preserved; older are pruned by the housekeeping job.
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
- [ ] SQLite backup from yesterday exists.

### Weekly (Sunday 06:00 UTC, automated via
`weekly-housekeeping.yml`)

- [ ] Smoke-evidence pruned (60-day retention).
- [ ] Release identity refreshed.
- [ ] `npm run docs:audit` total recorded.

### Per-deploy

- [ ] Required staging smoke suite green; check count is release-dependent.
- [ ] Production health-check green.
- [ ] PM2 nexus-hub + content-engine online.
- [ ] Smoke evidence JSON written.
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

- [ ] No new env-key without a default in `src/config.ts` AND a doc
      entry in `STAGING.md` and `DEPLOY.md`.
- [ ] Health-check change has a corresponding `/api/health/deep`
      assertion.
- [ ] New alert source has a runbook entry and a dedupe strategy.
- [ ] New log surface has a stable name and is documented in §4 above.
- [ ] No new direct provider SDK call (`anthropic.messages.create`,
      `gemini.generateContent`, `openai.chat.*`).
- [ ] Cost telemetry routed through `trackedCreate` (or the equivalent
      Gemini/OpenAI wrappers).
- [ ] Graceful shutdown still drains in ≤ 10 s.
