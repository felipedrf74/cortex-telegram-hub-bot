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
- **Workflow:** `.github/workflows/cd-production.yml`
- **Why manual:** Server is IPv6-only (`2a01:14:8021:c0d0:d5e8:b946:d3e4:a53b`). GitHub Actions runners don't have IPv6 connectivity, so SSH-based deploy fails.
- **Status:** Available but can't reach server from GitHub

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
- Modify `.github/workflows/cd-production.yml` to add push triggers
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
| SERVER_HOST | ⚠️ IPv6 (can't reach from GH Actions) | Works from local Mac |
| SERVER_USER | ✅ dominguez | |
| SERVER_SSH_KEY | ✅ Configured | |
| NOTION_TOKEN | ✅ Configured | |
| NOTION_RELEASES_DB | ✅ 332ad49d-23e7-8134-b413-d8d3cc3f1a4a | |

## Future: Re-enabling Auto-Deploy

When the server gets a stable IPv4 address or Cloudflare Tunnel:
1. Update `SERVER_HOST` secret with reachable address
2. Add `push: branches: [main]` back to `cd-production.yml` trigger
3. Auto-deploy will resume
