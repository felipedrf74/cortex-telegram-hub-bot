# Chat Production Open Blockers

Date: 2026-04-29  
Release branch: `release/chat-tenant-safe-production-candidate`

## P0

None open for the current REST Chat release scope.

This statement depends on the following hard constraints:

- WebSocket streaming remains disabled.
- No true multi-workspace Chat claim is made.
- Raw Chat content is not exposed through portal/support tooling.
- Migrations are rehearsed before production deployment. The staging-clone rehearsal for `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql` passed on 2026-04-29; a fresh production DB snapshot is still required immediately before deployment.

## P1

No open code/test P1 remains for the current restrained REST Chat release scope.

Deployment still has two required process gates:

| ID | Process Gate | Required Action |
| --- | --- | --- |
| CHAT-DEPLOY-P1-01 | Fresh production DB snapshot | Closed for this deployment run: `/home/dominguez/telegram-hub-bot/data/release-snapshots/chat-tenant-safe-20260429T085055Z/predeploy-bot.db`, SHA-256 `11a54315544eee5872946b06c7f4b1cfffa357176a509d9e1654a608b2b03428`, integrity `ok`. |
| CHAT-DEPLOY-P1-02 | Focused staging Chat smoke | Deploy to staging first and run focused Chat smoke before production promotion. |

## Closed Since RC Packaging

| ID | Item | Closure Evidence |
| --- | --- | --- |
| CHAT-P1-01 | Migration `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql` clone proof. | Passed on staging clone. See `docs/chat/chat-migration-084-085-rehearsal.md`. |
| CHAT-P1-02 | Live provider routing/fallback claim gate. | Release package avoids live-provider quality/fallback/operator-pin claims. See `docs/chat/chat-production-release-notes.md`. |
| CHAT-P1-03 | Streaming/reconnect posture. | Staging and production `IOS_WS_ENABLED` are unset, which resolves to false; release package excludes streaming readiness claims. |
| CHAT-P1-04 | Durable tool invocation lifecycle scope. | Accepted out of scope for this restrained release; route-level idempotency and destructive confirmation tests passed. |
| CHAT-P1-05 | Durable attachment/support scope. | Durable attachment and raw support-console workflows are explicitly out of scope in release notes and support runbook. |
| CHAT-P1-06 | Active tenant membership/workspace claims. | Release package avoids true workspace-switching claims; current canonical scope remains one tenant per user. |
| CHAT-P1-07 | Migration file history alignment. | `083_secretary_agenda_ledger.sql` is recovered into the branch, Chat migrations are renumbered to `084`/`085`, and the final staging-clone proof passed. |

## Deployment Cautions

- Use the fresh production DB snapshot recorded above if migration/data rollback is needed; the rehearsal used a staging clone only.
- Production and staging both have `082_training_session_identity_shape_hash.sql` applied; the file is now included in this branch's `migrations/` directory so deploy packaging does not drop an already-production migration file.
- Staging has `083_secretary_agenda_ledger.sql` in `_migrations`; the release branch now includes the recovered file and Chat migrations are renumbered to `084`/`085`, so no duplicate migration prefix remains in the branch.

## P2

| ID | Item | Next Step |
| --- | --- | --- |
| CHAT-P2-01 | Single-command local Chat smoke runner missing. | Add `scripts/chat-full-nexus-local-smoke.sh` that starts, seeds, tests, and cleans. |
| CHAT-P2-02 | Cooking/Content natural-language live orchestration is fixture-covered, not provider-backed. | Add deterministic local shortcuts or bounded provider smoke. |
| CHAT-P2-03 | iOS unauthorized Chat UI was only partially smoked. | Add simulator test with revoked/no-refresh token. |
| CHAT-P2-04 | Portal diagnostics read access is not audited as a support-read event. | Add audit event before expanding diagnostics. |
| CHAT-P2-05 | Live vector namespace smoke absent. | Add when vector store is configured locally. |

## P3

- Copy polish for lifecycle/tool labels.
- Portal diagnostics UI.
- Persistent XCUITest coverage for Chat.
- Provider circuit state persistence.

## Release Recommendation

Proceed to deployment preparation with the restrained release package. Do not skip the fresh production DB snapshot or focused staging Chat smoke.
