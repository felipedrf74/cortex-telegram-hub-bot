# Training Production Deployment Summary

Date: 2026-04-28  
Status before deploy: **GO WITH CONDITIONS**

## Release Candidate

- Backend RC branch: `release/training-engine-production-candidate`
- Backend RC head before deploy version bump: `cef5888`
- Companion iOS branch evidence: `release/ios-training-engine-local-smoke-candidate`
- Production baseline / rollback: `a3f1b78`

## Evidence

- Backend verify: 383 files / 6,001 tests.
- Training eval: 99/100 across 156 cases.
- Google staging calendar smoke: `training-calendar-smoke-20260428165035-7ljwng`.
- Outlook staging calendar smoke: `training-calendar-smoke-20260428165107-7fsbbr`.
- Cross-skill staging smoke: `training-cross-skill-smoke-20260428164946-829lm7`.
- Migration 082: local and true staging clone apply/restore passed.
- iOS: local rich payload smoke and authenticated local API journey passed.

## Conditions

- Production-predeploy DB snapshot captured: `/home/dominguez/backups/nexushub/predeploy-training-20260428T173458Z/bot-pre-training-release.db`, integrity_check=`ok`, 26,714,112 bytes.
- Release copy must not claim GPT-5.5 runtime execution for Training plan generation.
- Production-safe post-deploy validation must run after deployment.
- Calendar production tests must use only approved safe test tenant/calendar data.

## Deployment Command

Use the documented process:

```bash
./scripts/deploy.sh
```

No alternative deployment path is approved by this package.
