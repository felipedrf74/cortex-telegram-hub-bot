# Chat Production Deployment Summary

Date: 2026-04-29
Release branch: `release/chat-tenant-safe-production-candidate`
Backend version: `4.14.99`
iOS companion branch: `feature/chat-ios-tenant-safe-rendering`

## Summary

The Chat release package is prepared with restrained release scope. The backend and iOS validation gates run in this final pass are green, and the remaining items are deployment-time controls rather than code/test failures.

## Latest Validation

Backend:

- `npm run verify` passed: 376 files / 5,939 tests.
- `npm run build` passed.
- `git diff --check` passed.
- `npm run chat:eval` passed in fixture mode: 24 scenarios, average 1.99 / 2.00.
- `node dist/tools/chat-day-to-day-simulation.js` passed: 10 scenarios, average 1.93 / 2.00.

iOS:

- `xcodebuild -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator build` passed.
- Chat-focused iOS tests passed on `iPhone 17 Pro`: `ChatRepositoryTests`, `ChatRichStateDecodingTests`, `ChatStructuredCardRenderingTests`.
- Full iOS scheme tests passed on `iPhone 17 Pro`.

Operational checks:

- Staging `IOS_WS_ENABLED` is unset.
- Production `IOS_WS_ENABLED` is unset.
- Staging-clone migration rehearsal passed for recovered `083`, Chat `084`, and Chat `085`.
- No real provider calls were made in this final pass.

## Release Scope Decisions

These decisions close the remaining P1 release-copy gates without broadening runtime behavior:

- No live-provider quality/fallback/operator-pin claim is included.
- No production WebSocket streaming claim is included.
- No true multi-workspace Chat claim is included.
- No raw support-console Chat-content review claim is included.
- Durable tool invocation records and durable attachment support remain out of scope for this release.

## Must Do Immediately Before Production Deployment

- Fresh production DB snapshot taken: `/home/dominguez/telegram-hub-bot/data/release-snapshots/chat-tenant-safe-20260429T085055Z/predeploy-bot.db`.
- Snapshot SHA-256: `11a54315544eee5872946b06c7f4b1cfffa357176a509d9e1654a608b2b03428`; integrity: `ok`.
- Reconfirmed `IOS_WS_ENABLED` is unset/false in staging and production.
- Reconfirmed provider keys are present; no provider key values were read or changed by this release.
- Deploy to staging first and run focused Chat staging smoke.
- Promote only after staging smoke passes.

## Not Included

- WebSocket streaming promotion.
- True workspace switching.
- Durable attachments.
- Raw Chat support console.
- Live provider/fallback quality proof.
- Live vector namespace smoke.

## Rollback Summary

Rollback is code rollback plus production DB snapshot restore if migration rollback is required. The WebSocket kill switch is `IOS_WS_ENABLED=false`. After rollback, verify auth, Chat history, a deterministic Chat message, cross-user denial, and portal metadata-only diagnostics.
