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

- [ ] Run the documented production deploy path only: `./scripts/deploy.sh`.
- [ ] Confirm deploy validation passes before remote changes begin.
- [ ] Confirm deploy backup includes `data/bot.db`.
- [ ] Confirm production `.env` validation passes.
- [ ] Confirm PM2 services restart cleanly.
- [ ] Confirm production content engine health.
- [ ] Confirm production status portal health.
- [ ] Confirm no staging `.env.*`, `.local`, local DB, `.codex`, or `.claude/worktrees` artifacts sync to production.

## Post-Deploy

- [ ] Confirm `/api/snapshot` reports the new version/commit.
- [ ] Confirm `nexus-hub` and `content-engine` are online in PM2.
- [ ] Run production-safe API smoke with test tenant/user only if a safe token is available.
- [ ] Run Training read/create/cancel checks only for approved safe test tenant/user.
- [ ] Run production calendar create/delete only if explicitly approved and isolated to a safe test calendar.
- [ ] Check logs for calendar sync failures, tenant/auth errors, iOS decode errors, and model/provider runaway loops.
- [ ] Confirm no unnecessary local/staging jobs or tunnels remain running.
