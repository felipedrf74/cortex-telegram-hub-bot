# Chat Production Deployment Checklist

Date: 2026-04-29
Release branch: `release/chat-tenant-safe-production-candidate`
Backend version: `4.14.99`

## Pre-Merge

- [ ] Confirm release branch HEAD and reviewed commit.
- [ ] Confirm working tree only contains intended Chat release changes.
- [x] Backend `npm run verify` passed: 376 files / 5,939 tests.
- [x] Backend `npm run build` passed.
- [x] `git diff --check` passed.
- [x] `npm run chat:eval` passed in fixture mode: 24 scenarios, average 1.99 / 2.00.
- [x] `node dist/tools/chat-day-to-day-simulation.js` passed: 10 scenarios, average 1.93 / 2.00.
- [x] iOS simulator build passed.
- [x] iOS full scheme tests passed on `iPhone 17 Pro`.
- [x] Staging-clone migration rehearsal passed for recovered `083`, Chat `084`, and Chat `085`.
- [x] Release copy avoids GPT-only/provider-quality/fallback-performance claims.
- [x] Release copy avoids streaming readiness claims.
- [x] Release copy avoids true workspace-switching claims.
- [x] Release copy avoids raw support-console review claims.
- [x] Durable tool lifecycle and durable attachment support are explicitly out of scope.

## Migrations And Backups

- [x] `082_training_session_identity_shape_hash.sql` is included because production/staging already applied it.
- [x] `083_secretary_agenda_ledger.sql` is recovered into the branch because staging already applied it.
- [x] `084_chat_tenant_scope.sql` is the Chat tenant-scope migration.
- [x] `085_chat_message_lifecycle.sql` is the Chat lifecycle/idempotency migration.
- [x] Take a fresh production DB snapshot immediately before deployment.
- [x] Record snapshot path and checksum in deployment notes.
- [x] Confirm snapshot restore command is available before applying migrations.

## Environment Variables And Feature Flags

- [x] Staging `IOS_WS_ENABLED` is unset, which resolves to false.
- [x] Production `IOS_WS_ENABLED` is unset, which resolves to false.
- [x] Reconfirm `IOS_WS_ENABLED` is unset/false immediately before deploy.
- [x] Do not enable WebSocket streaming in this release.
- [x] Confirm provider keys are not changed as part of this release.
- [ ] Confirm operator model overrides are not changed as part of this release unless separately approved.
- [ ] Confirm Anthropic remains gated unless intentionally activated for an incident.

## Staging Deployment Gate

- [ ] Merge release branch to `main`.
- [ ] Deploy to staging using the standard staging deploy script.
- [ ] Run staging health.
- [ ] Run focused Chat staging smoke:
  - auth/session
  - `/api/v1/chat/history`
  - safe `/api/v1/chat/message`
  - idempotent retry
  - destructive confirmation path
  - cross-user history denied
  - portal diagnostics metadata-only
- [ ] Confirm no raw Chat prompt/message/tool output appears in diagnostics.
- [ ] Confirm no WebSocket endpoint is enabled for iOS.

## Production Promotion Gate

- [ ] Confirm staging smoke passed.
- [ ] Confirm fresh production DB snapshot exists.
- [ ] Promote using the standard production promotion script.
- [ ] Run production health.
- [ ] Run focused production Chat health:
  - `/api/v1/auth/me`
  - `/api/v1/chat/history`
  - deterministic low-risk `/api/v1/chat/message`
  - cross-user denial sample if safe
  - portal/provider metadata route without raw content exposure
- [ ] Confirm no local services, smoke workers, tunnels, simulators, or provider-call loops remain running.

## Rollback Readiness

- [x] Code rollback command identified.
- [x] DB snapshot restore command identified.
- [x] `IOS_WS_ENABLED=false` confirmed.
- [ ] Monitoring owner ready to watch Chat lifecycle/security/provider signals.

## Deployment Execution Notes

Fresh production DB snapshot:

- Snapshot: `/home/dominguez/telegram-hub-bot/data/release-snapshots/chat-tenant-safe-20260429T085055Z/predeploy-bot.db`
- Manifest: `/home/dominguez/telegram-hub-bot/data/release-snapshots/chat-tenant-safe-20260429T085055Z/manifest.json`
- Size: `26714112` bytes
- SHA-256: `11a54315544eee5872946b06c7f4b1cfffa357176a509d9e1654a608b2b03428`
- Integrity: `ok`
- Latest production migration at snapshot time: `082_training_session_identity_shape_hash.sql`
- Restore note: stop production writers, copy `predeploy-bot.db` over `/home/dominguez/telegram-hub-bot/data/bot.db`, remove `/home/dominguez/telegram-hub-bot/data/bot.db-wal` and `/home/dominguez/telegram-hub-bot/data/bot.db-shm`, restart, then run integrity and focused health smoke.

Immediate predeploy env check:

- Staging `IOS_WS_ENABLED`: unset
- Production `IOS_WS_ENABLED`: unset
- Production provider keys: present; no provider key values were read or changed.
