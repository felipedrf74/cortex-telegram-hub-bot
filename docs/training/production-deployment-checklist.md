# Training Production Deployment Checklist

Date: 2026-04-28  
Backend RC: `release/training-engine-production-candidate`

## Pre-Deploy

- [x] Backend release branches pushed: `release/training-engine-production-candidate` and `release/training-engine-production-hardening`.
- [x] Full backend verify passed: 383 files / 6,001 tests.
- [x] Google staging calendar lifecycle passed with read-back and cleanup.
- [x] Outlook staging calendar lifecycle passed with read-back and cleanup.
- [x] Seeded cross-skill staging smoke passed and cleanup was verified.
- [x] Migration 082 local and true staging clone apply/restore rehearsals passed.
- [x] Local iOS rich Training smoke and authenticated local API journey passed.
- [x] Release copy avoids GPT-5.5 runtime execution claims.
- [x] Production-predeploy DB snapshot captured immediately before deployment: `/home/dominguez/backups/nexushub/predeploy-training-20260428T173458Z/bot-pre-training-release.db`, integrity_check=`ok`.
- [x] Rollback snapshot path recorded for rollout.

## Deploy

- [x] Run the documented production deploy path only: `./scripts/deploy.sh`.
- [x] Confirm deploy validation passes before remote changes begin.
- [x] Confirm deploy backup includes `data/bot.db`.
- [x] Confirm production `.env` validation passes.
- [x] Confirm PM2 services restart cleanly.
- [x] Confirm production content engine health.
- [x] Confirm production status portal health.
- [x] Confirm no staging `.env.*`, `.local`, local DB, `.codex`, or `.claude/worktrees` artifacts sync to production.

## Post-Deploy

- [x] Confirm `/api/snapshot` reports the new version/commit.
- [x] Confirm `nexus-hub` and `content-engine` are online in PM2.
- [ ] Run production-safe API smoke with test tenant/user only if a safe token is available. Deferred: no approved safe production token was provided.
- [ ] Run Training read/create/cancel checks only for approved safe test tenant/user. Deferred: no approved safe production test tenant/user was provided.
- [ ] Run production calendar create/delete only if explicitly approved and isolated to a safe test calendar. Deferred: no production calendar write approval/scope was provided.
- [x] Check logs for calendar sync failures, tenant/auth errors, iOS decode errors, and model/provider runaway loops.
- [x] Confirm no unnecessary local/staging jobs or tunnels remain running.
