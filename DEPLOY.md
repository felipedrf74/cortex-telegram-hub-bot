# Nexus Hub — Deploy & CI/CD Context for Claude Code Agents
<!-- TODO: Rename server directory /home/dominguez/telegram-hub-bot → /home/dominguez/nexus-hub -->

## Current CI/CD Status

### CI Pipeline (AUTOMATIC) ✅
- **Trigger:** Every push to `main` or `develop`, every PR
- **Workflow:** `.github/workflows/ci.yml`
- **Jobs:** Lint & Type Check → Tests (256 passing) → Build → Content Engine Check → Migration Check
- **Status:** GREEN — fully working

### CD Pipeline (MANUAL ONLY) ⚠️
- **Trigger:** Manual only (`workflow_dispatch`) — NOT on push
- **Workflow:** archived as `.github/workflows/cd-production.yml.archived`
- **Why archived:** hosted GitHub Actions runners cannot reach the SSH/rsync
  deploy target. The existing Cloudflare Tunnel exposes HTTPS app health routes,
  not SSH deploy transport.
- **Status:** production deploys still run from Felipe's Mac via the local
  scripts below. Actions now has a non-deploy reachability smoke at
  `.github/workflows/promote-reachability.yml`.

### Release Pipeline (MANUAL) 🏷️
- **Trigger:** Manual (`workflow_dispatch`) in GitHub Actions UI
- **Workflow:** `.github/workflows/release.yml`
- **Jobs:** Bump version → Update CHANGELOG → Git tag → GitHub Release → Notify Notion

---

## How to Deploy to Production

**DO NOT** rely on GitHub Actions CD for deployment. Two paths from Felipe's Mac:

### 🟢 Recommended: Validated Promote (staging → prod)

For any change beyond a one-line typo, use the validated-promote pipeline:

```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot

# 1. Ship the change to staging
./scripts/deploy-staging.sh

# 2. (Optional) Let staging soak for 5 min so cron jobs fire at least once

# 3. Promote to prod — runs smoke tests automatically and refuses to
#    promote if any fail
./scripts/promote-to-prod.sh
```

`promote-to-prod.sh` runs `staging-smoke.sh` first (13 automated assertions
against the staging install: health, snapshot shape, cost-by-domain shape,
provider stats, PM2 state, DB integrity), and only proceeds to
`deploy.sh` if all 13 pass. See `STAGING.md` for the full staging runbook.

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

### Telegram Delivery Mode: Long-Polling vs Webhooks

The bot supports both delivery modes. Long-polling is the default; webhooks
are opt-in via env var.

**Long-polling (current default):**
- The bot makes a long-running `getUpdates` request to Telegram every few seconds.
- Pros: zero infrastructure setup, works behind any firewall, no public URL needed.
- Cons: Holds an open connection to Telegram constantly. Only one process can poll
  per bot token. ~1-3s message delivery latency.

**Webhooks (opt-in):**
- Telegram POSTs each update to `https://api.nexushub.me/webhooks/telegram`
  via the existing cloudflared tunnel → portal on :8200.
- Pros: Lower latency (Telegram pushes to us instantly). No long-running
  connection. Multiple processes COULD share the same token (though we still
  run only one because of cron / state).
- Cons: Requires a public HTTPS endpoint reachable from Telegram's IPs.

**Switching to webhooks** (low-risk, reversible):

1. Add to `.env`:
   ```
   TELEGRAM_WEBHOOK_URL=https://api.nexushub.me/webhooks/telegram
   TELEGRAM_WEBHOOK_SECRET=<random 32+ char string>
   ```
2. Restart the bot: `./scripts/deploy.sh` (or just `pm2 restart nexus-hub` if no code changes)
3. The bot will:
   - Call `bot.api.deleteWebhook()` to clean any stale registration
   - Call `bot.api.setWebhook(url, { secret_token })` to register the new one
   - SKIP `bot.start()` (no long-polling)
   - Mount `POST /webhooks/telegram` on the portal Express server
4. Verify: `pm2 logs nexus-hub --nostream | grep "WEBHOOK mode"` should show the registration succeeded

**Reverting to long-polling** (instant, no code rollback needed):

1. Remove (or comment out) `TELEGRAM_WEBHOOK_URL` in `.env`
2. Restart: `pm2 restart nexus-hub`
3. The bot detects the missing env var and goes back to `bot.start()` with long-polling
4. The webhook registration on Telegram's side becomes a no-op — Telegram falls back to allowing getUpdates

The webhook code path is gated entirely on `TELEGRAM_WEBHOOK_URL` being non-empty.
There's no migration step or DB change to undo. Setting and unsetting one env var
is the entire toggle.

**If `setWebhook()` fails at boot** (Telegram API blip, network issue), the bot
automatically falls back to long-polling for that boot — see the try/catch in
`src/index.ts`. So a transient Telegram outage during a deploy can't lock you
into a half-broken webhook state.

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
1. Type-checks TypeScript locally
2. Builds the project
3. Stops PM2 services on server
4. Rsyncs files (excludes .env, data/, logs/, node_modules/)
5. Installs production dependencies
6. Rebuilds native modules against system Node
7. Starts PM2 services
8. Runs health checks

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
- Restore `.github/workflows/cd-production.yml.archived` or add deploy push triggers
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
