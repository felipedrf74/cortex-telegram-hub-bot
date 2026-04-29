# Training Production Deployment Log

Date: 2026-04-28  
Operator: Codex  
Deployment result: **deployed successfully**

## Summary

The Training engine release was deployed to production through the documented Nexus production deploy path:

```bash
./scripts/deploy.sh
```

No alternate deployment path was used. The deploy script ran the full validation gate before touching the server, built the TypeScript bundle, validated production environment requirements, bumped the backend version, stopped production services, created a production backup including `data/bot.db`, synced files with the hardened excludes, rebuilt native modules, restarted PM2 services, and completed health checks.

## Release Candidate

| Item | Value |
| --- | --- |
| Backend branch | `release/training-engine-production-candidate` |
| Pre-deploy code/docs commit | `7369d76` |
| Deployed version-bump commit | `4b82e79` |
| Deployed version | `4.14.100` |
| Previous production version | `4.14.99` |
| Production path | `/home/dominguez/telegram-hub-bot` |
| Production server | `dominguez@serverdominguez` |

## Pre-Deploy Validation

| Gate | Result | Evidence |
| --- | --- | --- |
| Full backend verification | Pass | Deploy script ran `npm run verify`: 383 test files / 6,001 tests passed. |
| TypeScript build | Pass | `npm run build` completed before server sync. |
| Production `.env` validation | Pass | Required production keys were present. |
| Production-predeploy DB snapshot | Pass | `/home/dominguez/backups/nexushub/predeploy-training-20260428T173458Z/bot-pre-training-release.db`, `integrity_check=ok`. |
| Standard deploy backup | Pass | Deploy script created a backup with `bot.db included: 1`. |
| Staging provider gates | Pass | Google and Outlook staging calendar smokes had already passed with read-back and cleanup. |
| Cross-skill staging gate | Pass | Seeded Training-centered cross-skill staging smoke had already passed with cleanup verified. |
| Migration 082 rehearsal | Pass | Local and true staging clone apply/restore rehearsals had passed before deploy. |

## Production Changes Applied

- Backend package version bumped from `4.14.99` to `4.14.100`.
- Migration `082_training_session_identity_shape_hash.sql` applied during production startup.
- PM2 services restarted:
  - `nexus-hub`
  - `content-engine`
- Production process list was saved through PM2.

## Deploy Script Health Result

| Check | Result |
| --- | --- |
| Content engine health | Pass |
| Status portal snapshot | Pass, reported `4.14.100` |
| Bot process | Pass, `online` |
| PM2 production services | Pass, `nexus-hub` and `content-engine` online |

## Notes

- The deploy script patched for this release excludes local/staging artifacts such as `.env.*`, `.local`, `.codex`, `.claude/worktrees`, and local database files from production sync.
- No production calendar smoke writes were performed during deployment. Provider write/read-back lifecycle proof remains from staging, and production calendar writes should only be tested with an approved safe production test tenant/calendar.
- No rollback was needed.
