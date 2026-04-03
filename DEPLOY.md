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

**DO NOT** rely on GitHub Actions CD for deployment. Use the local deploy script from Felipe's Mac:

<!-- NOTE: Local path references old folder name. Update when folder is renamed. -->
```bash
cd ~/Desktop/Custom\ Connectors/Cortex/cortex-telegram-hub-bot
./scripts/deploy.sh
```

This script:
1. Type-checks TypeScript locally
2. Builds the project
3. Stops PM2 services on server
4. Rsyncs files (excludes .env, data/, logs/, node_modules/)
5. Installs production dependencies
6. Starts PM2 services
7. Runs health checks

### Deploy Target
- **Server:** `dominguez@serverdominguez` (resolves locally, not from cloud)
- **Path:** `/home/dominguez/telegram-hub-bot`
- **Process Manager:** PM2 (nexus-hub + content-engine)
- **Backups:** `/home/dominguez/backups/nexushub/` (last 10 kept)

### Rollback
```bash
./scripts/rollback.sh              # List available versions
./scripts/rollback.sh v4.4.1       # Rollback to specific version
./scripts/rollback.sh latest       # Rollback to most recent backup
```

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
