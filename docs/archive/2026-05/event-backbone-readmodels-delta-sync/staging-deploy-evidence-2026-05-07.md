Status: archive
Owner: Codex
Date: 2026-05-07

# Event Backbone / Read Models / Delta Sync — Staging Deploy Evidence

## Verdict

**STAGING_READY.**

The event-backbone branch was pushed to origin, deployed to staging with conservative event/job worker flags, soaked with the worker disabled, smoked, then soaked with the worker enabled and smoked again. Staging evidence is green: no dead-letter rows, no failed rows, pending rows drained to zero under the worker, and the post-worker smoke passed 21/21.

This is **not** a production-ready verdict. The production/main decision remains separate because the source prompt explicitly stopped at staging and because operator-only gates remain: signed TestFlight two-account walkthrough, APNs production credential/entitlement confirmation, production env-flag decision, and production migration timing review.

## Branch State

Engine:
- Branch: `feature/event-backbone-readmodels-delta-sync`
- Runtime/evidence baseline: `b13e2495acfe88732c62d67a1c1f25c647c253ad`
- Commit: `fix(release): use canonical migration ledger in staging smoke`
- The feature branch also contains later docs-only staging evidence commits; use `git log origin/feature/event-backbone-readmodels-delta-sync -1` for the current review tip.
- Backup tags pushed: `backup/event-backbone-before-staging-deploy-20260507-1945`, `backup/event-backbone-before-staging-deploy-20260507-1947`

iOS:
- Branch: `feature/event-backbone-readmodels-delta-sync`
- Origin tip: `dd8ffe0a7c3e3bda79b0cc407db9ef7861fe47fd`
- Commit: `docs(ios): record delta sync hostile v2 validation`
- Backup tags pushed: `backup/event-backbone-before-staging-deploy-20260507-1945`, `backup/event-backbone-before-staging-deploy-20260507-1947`

Deployment note:
- The staging runtime was deployed from the local tree before the smoke-script-only fix at `b13e2495`. The runtime code under test is therefore the same event-backbone runtime that was present at `79e36fb3`; `b13e2495` only corrects `scripts/staging-smoke.sh` to query the canonical `_migrations` ledger.
- Later evidence commits are docs/evidence only and were pushed to preserve the staging proof on the feature branch.

## Source Gates Before Staging

- `npx tsc --noEmit`: PASS.
- Focused event-backbone/security vitest: PASS, 6 files / 52 tests.
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: PASS, 23/23.
- `node scripts/vi-mock-completeness-lint.mjs --strict`: PASS, 827/827.
- `bash scripts/workspace-docs-mirror.sh --check`: PASS after mirror refresh commits.
- `npm run docs:audit`: PASS, 465 issues / 441 markdown files audited.

The engine pre-push hook also ran the classifier-selected focused suite on push: 158 files / 1,789 tests passed.

## Migration 115 Measurement

Migration files applied during staging deploy:
- `113_secretary_notification_orchestrator.sql`
- `114_event_backbone_readmodels_delta_sync.sql`
- `115_event_outbox_canceled_status.sql`

Staging DB:
- Path: `/home/dominguez/telegram-hub-bot-staging/data/bot.db`
- Size before deploy: approximately 15 MB.
- Remote `sqlite3` CLI was unavailable; measurements used Node + `better-sqlite3`.

Observed migration ledger:
- `114_event_backbone_readmodels_delta_sync.sql`: `2026-05-07 18:50:58`
- `115_event_outbox_canceled_status.sql`: `2026-05-07 18:50:58`

Observed PM2 migration logs:
- 113 logged at `time=1778179858826`
- 114 logged at `time=1778179858827`
- 115 logged at `time=1778179858832`

Estimated lock/rebuild window:
- Approximately 5 ms between the 114 and 115 migration log timestamps.
- This is an approximate measurement because the migration runner logs per-file completion, not explicit BEGIN/COMMIT timestamps.

Row counts:
- Before migration 115: effectively 0 `event_outbox` rows, because migration 114 created the table immediately before migration 115 in this deploy.
- After deploy and worker-disabled boot: 4 pending events and 2 pending jobs existed from startup/scheduled fixture paths.
- After manual staging probes before worker enablement: 10 pending events and 5 pending jobs.
- After worker-enabled soak: 18 processed events and 27 completed jobs; 0 pending, 0 failed, 0 dead-letter.

Production extrapolation:
- Production `event_outbox` row count was not read in this staging-only prompt.
- Because staging had no pre-existing production-scale `event_outbox` rows, the operator must re-check production row count before promotion if production has already partially received the event-backbone tables.

## Wave 2 — Worker-Disabled Staging Evidence

Staging env was backed up before modification:
- `/home/dominguez/telegram-hub-bot-staging/.env.event-backbone-backup-20260507-195005`

Conservative staging flags applied:
- `EVENT_BACKBONE_WORKER_DISABLED=1`
- `EVENT_BACKBONE_JOBS_DISABLED=1`
- `EVENT_BACKBONE_CLEANUP_APPLY=0`
- `EVENT_BACKBONE_CLEANUP_DISABLED=0`
- `EVENT_BACKBONE_EVENT_BATCH_LIMIT=10`
- `EVENT_BACKBONE_JOB_BATCH_LIMIT=10`

Deploy evidence:
- `engine/docs/release/smoke-evidence/staging-deploy-79e36fb3-20260507T185036Z.log`
- Deploy script exited cleanly and restarted only staging PM2 processes.

Worker-disabled soak:
- Duration: 30 minutes.
- Minute 1 counts: 4 pending events, 2 pending jobs.
- Minute 13 counts: 8 pending events, 4 pending jobs.
- Minute 30 counts: 8 pending events, 4 pending jobs.
- PM2 restarts stayed flat during the soak: `nexus-hub-staging` 20, `content-engine-staging` 1.
- No dead-letter rows or tenant-scope anomalies were observed.

Observability note:
- Worker-disabled skip state is not explicitly logged; evidence is inferred from pending rows remaining unprocessed while the worker-disabled flags were set. This is acceptable for staging, but a future observability improvement should add an explicit worker-disabled log line.

Pre-worker smoke:
- First run: `engine/docs/release/smoke-evidence/staging-smoke-pre-worker-79e36fb3-20260507T192240Z.log`
- Result: 20/21 because `scripts/staging-smoke.sh` queried the obsolete `applied_migrations` table.
- Source fix: `b13e2495` changes the smoke script to query `_migrations`.
- Rerun: `engine/docs/release/smoke-evidence/staging-smoke-pre-worker-b13e2495-20260507T192422Z.log`
- Evidence JSON: `engine/docs/release/smoke-evidence/staging-smoke-b13e2495-20260507T192438Z.json`
- Result: PASS, 21/21.

Manual authenticated probes:
- Created a staging-only test user in the staging DB; no production data was used.
- `GET /api/v1/sync/changes?since=0&limit=10`: 200, empty cursor response.
- `GET /api/v1/summaries`: 200, 5 summary types.
- `POST /api/v1/notifications/intents/fixtures/secretary`: 200.
- Follow-up `GET /api/v1/sync/changes?since=0&limit=10`: 200, 2 changes, cursor `10`.
- Signed portal-session admin dead-letter routes: events count 0, jobs count 0.

## Wave 4 — Worker-Enabled Evidence

Worker flags changed on staging:
- `EVENT_BACKBONE_WORKER_DISABLED=0`
- `EVENT_BACKBONE_JOBS_DISABLED=0`
- `EVENT_BACKBONE_EVENT_BATCH_LIMIT=10`
- `EVENT_BACKBONE_JOB_BATCH_LIMIT=10`
- `EVENT_BACKBONE_CLEANUP_APPLY=0`

Staging restart:
- `pm2 restart nexus-hub-staging`
- Intentional restart count moved from 20 to 21.

Worker-enabled soak:
- Duration: 30 minutes.
- Minute 1: event_outbox pending 4 / processed 10; jobs pending 7 / completed 10.
- Minute 3: event_outbox processed 14; jobs completed 21; pending drained.
- Minute 8: scheduled work created 4 pending events and 2 pending jobs.
- Minute 9: the scheduled batch drained; event_outbox processed 18; jobs completed 27.
- Minute 30: event_outbox processed 18; jobs completed 27; no pending/failed/dead-letter rows.

Worker log evidence:
- `event_outbox_batch` emitted `claimed`, `processed`, `failed`, `deadLetter`, and `durationMs`.
- `background_job_batch` emitted `claimed`, `completed`, `failed`, `deadLetter`, and `durationMs`.
- `event_backbone_worker_tick` emitted aggregate events/jobs counts and duration.
- No retry loop, dead-letter accumulation, tenant-scope anomaly, or memory/CPU spike was observed.

Post-worker smoke:
- First post-worker run passed 21/21 but the shell wrapper exited non-zero after reusing zsh's read-only `status` variable.
- Clean rerun log: `engine/docs/release/smoke-evidence/staging-smoke-worker-on-b13e2495-20260507T195852Z.log`
- Evidence JSON: `engine/docs/release/smoke-evidence/staging-smoke-b13e2495-20260507T195919Z.json`
- Result: PASS, 21/21.

Health evidence:
- `/health`: `engine/docs/release/smoke-evidence/staging-health-worker-on-b13e2495-20260507T200057Z.json`
- `/health/detailed`: not captured because staging returns 401 without the dedicated `HEALTH_TOKEN`; this is a staging auth/config limitation, not a runtime health failure.
- DB liveness was separately covered by `/health` returning healthy database state and staging-smoke DB `integrity_check: ok`.

Final dead-letter check:
- Events route: `{"ok":true,"data":{"events":[],"count":0}}`
- Jobs route: `{"ok":true,"data":{"jobs":[],"count":0}}`
- Direct DB counts: event_outbox `processed=18`, background_jobs `completed=27`, failed/dead-letter counts 0.

## Production / Main Readiness Decision

**Do not merge to main or promote production from this evidence alone.**

The staging runtime evidence is good, but production remains gated by explicit operator decisions and device/provider validation that were outside this prompt. The work is ready for PR/review and the next operator validation step, not autonomous production promotion.

## Operator-Only Gates Remaining Before Production

- Production env flag decision:
  - `EVENT_BACKBONE_WORKER_DISABLED`
  - `EVENT_BACKBONE_JOBS_DISABLED`
  - `EVENT_BACKBONE_EVENT_BATCH_LIMIT`
  - `EVENT_BACKBONE_JOB_BATCH_LIMIT`
  - `EVENT_BACKBONE_CLEANUP_APPLY`
  - `EVENT_BACKBONE_CLEANUP_DISABLED`
- Confirm production migration 115 row count if production has pre-existing `event_outbox` rows.
- Signed TestFlight build and two-account walkthrough on Felipe's iPhone, including Felipe + Jaqueline account separation.
- APNs production credentials provisioning.
- Confirm `com.apple.developer.usernotifications.time-sensitive` entitlement in the signed build.
- Open and review PR from `feature/event-backbone-readmodels-delta-sync` to `main`; do not auto-merge without review.

## Recommended Next Prompt

Next owner action should be operator validation, not production deploy:

1. Build/sign TestFlight from `feature/event-backbone-readmodels-delta-sync`.
2. Run a two-account walkthrough on Felipe's iPhone covering Home, Week/Semana, Training, Content, Notifications, logout/account switch, and stale-cache separation.
3. Confirm APNs production credentials and time-sensitive entitlement.
4. Decide production event-backbone worker/cleanup flags.
5. Only after that, write a separate production deploy prompt with rollback and health gates.

## Cleanup Status

- No local backend or local worker was started.
- Staging PM2 remains intentionally running with worker enabled and cleanup dry-run.
- No production service was touched.
- Local dev ports were checked during final cleanup in the Codex session.
- No long-running soak or smoke command was left running.
