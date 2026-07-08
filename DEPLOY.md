# Nexus Hub — Deploy & CI/CD Context for Claude Code Agents
<!-- TODO: Rename server directory /home/dominguez/telegram-hub-bot → /home/dominguez/nexus-hub -->

## Current CI/CD Status

### CI Pipeline (AUTOMATIC) ✅
- **Trigger:** Every push to `main` or `develop`, every PR
- **Workflow:** `.github/workflows/ci.yml`
- **Jobs:** Lint, type check, tests, build, content-engine checks, migration
  checks, and release gates. Keep live test counts in generated QA/release
  artifacts, not in this runbook.
- **Status:** GREEN — fully working

### CD Pipeline (MANUAL ONLY) ⚠️
- **Trigger:** Manual only (`workflow_dispatch`) — NOT on push
- **Workflow:** local scripts are canonical. A legacy
  `.github/workflows/cd-production.yml` is still tracked for owner review, but
  it is not the approved deployment path and must not be deleted/renamed
  without explicit owner approval.
- **Why archived:** hosted GitHub Actions runners cannot reach the SSH/rsync
  deploy target. The existing Cloudflare Tunnel exposes HTTPS app health routes,
  not SSH deploy transport.
- **Status:** production deploys still run from Felipe's Mac via the local
  scripts below. Actions now has a non-deploy reachability smoke at
  `.github/workflows/promote-reachability.yml`.

### Release Pipeline (MANUAL) 🏷️
- **Trigger:** Manual (`workflow_dispatch`) in GitHub Actions UI
- **Workflow:** `.github/workflows/release.yml`
- **Jobs:** Validate already-prepared package version → Git tag the exact
  promoted commit → GitHub Release → Notify Notion
- **Rule:** it must not bump package versions. Run `scripts/release-prep.sh`
  before staging so the staged artifact digest is the production artifact
  digest.
- **Version policy:** every production promote must mint a patch version before
  `deploy-staging.sh` so staging and production runtime self-reporting are
  unambiguous.

---

## How to Deploy to Production

**DO NOT** rely on GitHub Actions CD for deployment. Two paths from Felipe's Mac:

### 🟢 Recommended: Validated Promote (staging → prod)

For any change beyond a one-line typo, use the validated-promote pipeline:

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

# 0. Prepare and locally gate the release candidate
npm run release:prep -- --patch
npm run release:focused-verify
npm run release:pre-rc

# 0a. Let RC CI produce signed evidence:
#     full Vitest once as shards, full pytest once, typecheck, build,
#     migration safety, science-policy, sandbox smoke, cannot-skip dashboard.
#     Download the signed artifacts into .local/release/evidence/.

# 1. Ship the exact release commit to staging
./scripts/deploy-staging.sh

# 2. (Optional) Let staging soak for 5 min so cron jobs fire at least once

# 3. Promote to prod — runs smoke tests automatically and refuses to
#    promote if any fail
./scripts/promote-to-prod.sh
```

`promote-to-prod.sh` checks staging/prod env-key parity, validates the
staging artifact digest as a hard no-drift gate, runs `staging-smoke.sh`, and
only proceeds to `deploy.sh` if all gates pass. When `promote-to-prod.sh`
delegates to `deploy.sh`, it passes the staging manifest digest as the required
parity proof for deploy-time evidence reuse. `deploy.sh` no longer bumps
versions during production deploy; the artifact digest checked after local
build is rechecked against both signed evidence and the staging parity proof
immediately before rsync. See `STAGING.md` for the full staging runbook.

Signed release evidence reuse remains shadow/default-off. Before enabling
`NEXUS_RELEASE_EVIDENCE_REUSE_ENABLED=1`, an owner must install the GitHub
Actions signing secret that matches
`docs/release/evidence/release-evidence-public-key.pem`, three clean signed RCs
for the candidate SHA must be present under `.local/release/evidence/`, and
current rollback drill evidence must exist at
`docs/release/evidence/rollback-drill-latest.json`.

Performance rule: full Vitest and full pytest are required once per release
candidate through signed CI evidence. Staging and production deploy steps should
not rerun the 10k+ JavaScript suite when signed evidence, exact SHA, exact
post-build artifact digest, clean RC history, rollback drill evidence, staging
smoke, locks, env parity, and readiness checks all pass. If any of those gates
is missing or invalid, `deploy.sh` falls back to the full local verify path.

### GitHub Actions Reachability Smoke

Use `.github/workflows/promote-reachability.yml` only to prove reachability. It
does not deploy. The hosted job checks the existing Cloudflare HTTPS route for
`api.nexushub.me` and `api-staging.nexushub.me`; the self-hosted job checks
that a runner labeled `self-hosted` + `nexus-hub-promote` can resolve
`serverdominguez` and SSH to `dominguez@serverdominguez`.

The self-hosted runner dependency is documented in
`docs/release/self-hosted-runner-prereqs.md`. Do not add GitHub SSH deploy
secrets or revive direct hosted-runner SSH deploys without explicit owner
approval.

### Telegram Inbound Status

Telegram inbound polling/webhooks are retired. `src/bot.ts` is outbound-only
legacy compatibility, gated by `TELEGRAM_LEGACY_DELIVERY=true`; the process
does not register commands, message handlers, callback queries, polling, or
webhooks. Deploy safety still requires a single production deploy at a time
because rsync, PM2, scheduler/cron, SQLite state, and native module rebuilds
are singleton operations.

Do not reintroduce Telegram polling/webhook release steps without a new owner
approved runbook and tests.

Old long-polling/webhook rollback notes are obsolete. Do not use
`TELEGRAM_WEBHOOK_URL` or polling toggles as release procedures unless a future
owner-approved Telegram inbound runbook reintroduces them with current tests.

---

### 🟡 Direct Deploy (skip staging — use only for trivial fixes)

```bash
./scripts/deploy.sh
```

This is the underlying script that `promote-to-prod.sh` ultimately calls.
Use it directly only when:
- The change is a one-line typo or comment fix
- Staging is broken and you need an emergency hotfix
- You've already validated locally and don't need the smoke-test gate

It still does:
1. Acquires local and remote deploy locks
2. Verifies git/worktree health and release evidence shadow status
3. Runs full local validation unless an explicitly enabled signed-evidence path
   is also backed by three clean RC evidence runs and current rollback drill
   evidence
4. Type-checks TypeScript locally
5. Builds the project and records the artifact manifest digest
6. Rechecks the artifact digest immediately before rsync
7. Stops PM2 services on server
8. Rsyncs files (excludes .env, data/, logs/, node_modules/)
9. Installs production dependencies
10. Rebuilds native modules against system Node
11. Starts PM2 services
12. Runs readiness, DB integrity, native module, and PM2 health checks

### Deploy Target
- **Server:** `dominguez@serverdominguez` (resolves locally, not from cloud)
- **Path:** `/home/dominguez/telegram-hub-bot`
- **Process Manager:** PM2 (nexus-hub + content-engine)
- **Backups:** `/home/dominguez/backups/nexushub/` (last 10 kept)

### Rollback — Tested Procedure

**Rule #1:** ALWAYS run `--dry-run` first. The dry-run extracts the backup into
a temp dir on the server, runs SQLite `PRAGMA integrity_check`, and prints row
counts for the critical tables — confirming the backup is actually restorable
**without touching production**.

```bash
# 1. List available backups (read-only, no changes)
./scripts/rollback.sh

# 2. Validate the backup you want to restore (NO changes to production)
./scripts/rollback.sh --dry-run latest        # Validate most recent
./scripts/rollback.sh --dry-run v4.9.30       # Validate specific version

# 3. Apply the rollback for real (prompts for YES confirmation)
./scripts/rollback.sh latest
./scripts/rollback.sh v4.9.30
```

**Backup flags in the listing:**
- `[includes data]` — Contains `dist/ + migrations/ + prompts/ + data/bot.db`.
  Safe for full rollback. Only backups from v4.9.29+ have this
  (QW-10 fixed an earlier bug where deploy.sh excluded bot.db).
- `[code only ⚠️]` — Contains only `dist/ + migrations/ + prompts/` but no
  `data/bot.db`. Will **fail** `--apply` because restore.sh requires a DB.
  Only usable for manual code-only rollbacks via raw `tar xzf`.

**What `--apply` actually does (orchestrated by rollback.sh → restore.sh):**
1. `pm2 stop nexus-hub content-engine` — releases DB locks
2. Waits for port 8200 to drain (up to 30s)
3. Creates a **pre-restore snapshot** (`pre-restore-YYYYMMDD.tar.gz`) so
   you can undo the rollback itself
4. SQLite `PRAGMA integrity_check` on the backup's bot.db — aborts if bad
5. Atomic file swap: `dist/`, `migrations/`, `prompts/`, `data/bot.db`,
   `data/garmin-tokens/`
6. `npm ci --production` — in case package.json differs
7. `npm rebuild better-sqlite3` — native modules must match system Node
8. `pm2 start` both services
9. Health check against `http://localhost:8200/api/snapshot` with 3 retries
10. Prints the current→target version diff

**If the rollback's own health check fails:**
The script prints the path to the pre-restore snapshot and the exact command
to undo the rollback:
```bash
ssh dominguez@serverdominguez 'cd /home/dominguez/telegram-hub-bot && bash scripts/restore.sh --apply <pre-restore-snapshot>'
```

**Last tested:** 2026-04-08 — dry-run validated against v4.9.30 and v4.9.32,
both passed integrity check with expected row counts for
`users`, `user_oauth_tokens`, `job_history`, `audit_trail`.

---

## What This Means for Agents

### When Writing Code
- All code goes through CI automatically (lint, test, build) — this works perfectly
- Focus on making tests pass — CI is the quality gate
- Don't worry about deployment — Felipe handles it manually

### When Finishing Work
1. Commit with conventional format: `type(scope): description`
2. Push to your feature/bugfix branch
3. CI validates automatically
4. Felipe reviews, merges, and deploys manually via `./scripts/deploy.sh`

### Do NOT
- Delete/rename `.github/workflows/cd-production.yml`, restore archived deploy
  workflows, or add deploy push triggers without explicit owner approval
- Try to SSH to the server from within Claude Code
- Attempt any deployment commands — deployment is Felipe's responsibility
- Modify `.env`, `data/`, or any server-specific configuration

### Deployment Flow
```
Agent writes code → Push to feature branch → CI validates (automatic)
  → Felipe reviews → Merge to develop → CI validates (automatic)
  → Felipe merges to main → CI validates (automatic)
  → Felipe runs ./scripts/deploy.sh from Mac → Server updated
```

---

## Server Sync (Pulling Production Changes)

If the production server has hotfixes or changes made directly:

```bash
./scripts/sync-from-server.sh --dry-run    # Preview changes (safe)
./scripts/sync-from-server.sh              # Pull into server-sync branch
```

Then merge: `server-sync/* → develop → main → deploy.sh`

---

## GitHub Secrets Configured

| Secret | Status | Notes |
|--------|--------|-------|
| SERVER_HOST | ⚠️ legacy archived-CD secret | Do not use from hosted runners |
| SERVER_USER | ✅ dominguez | |
| SERVER_SSH_KEY | ✅ Configured | |
| NOTION_TOKEN | ✅ Configured | |
| NOTION_RELEASES_DB | ✅ Configured | Stored in secret manager; do not copy database IDs into docs |

## Optional Runtime Secrets (Training Coach v2)

| Env var | Purpose | What happens when unset |
|---------|---------|-------------------------|
| `OWNER_ID_HASH_SECRET` | HMAC-SHA256 key for the `u#XXXXXXXX` ownership-denial log correlation tag (R5 P3 / R6 P3) | Each Node process generates a random 32-byte salt at boot. Tag correlation works WITHIN a single process boot but NOT across processes / restarts. Set this in production if the operator runbook for "investigate why account X tried to access plan Y" reaches across multiple processes or recent deploys. Treat as a secret — leaking it lets a log reader pre-compute the tag for any user id. |

## Future: Re-enabling Auto-Deploy

When the server gets a stable SSH transport that GitHub Actions can use:
1. Prove reachability with `.github/workflows/promote-reachability.yml`.
2. Prefer a self-hosted runner that already has local SSH access to
   `serverdominguez`.
3. Only restore a deploy workflow after owner approval and after deciding
   whether the transport is self-hosted SSH, stable IPv4 SSH, or an explicit
   SSH-capable tunnel.
4. Do not add `push: branches: [main]` until manual promote has passed from the
   chosen runner path.
