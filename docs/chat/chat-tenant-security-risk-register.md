# Chat Tenant Security Risk Register

Generated: 2026-04-29 02:10 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

This document is retained for continuity with the earlier Chat hardening pass. The canonical current gap analysis is:

- `docs/chat/chat-tenant-security-gap-analysis.md`
- `docs/chat/chat-risk-register.md`
- `docs/chat/chat-open-items.md`

## Current Risk Table

| ID | Risk | Severity | Status | Evidence / Required Action |
| --- | --- | --- | --- | --- |
| CHAT-P0-01 | Production/staging Chat persistence may still be user-only until migration `084` and branch code are released. | P0 | Staging-clone proof closed | Working tree adds tenant columns/scope. `084`/`085` staging-clone rehearsal passed; production still needs fresh snapshot and normal release validation. |
| CHAT-P0-02 | WebSocket Chat path lacks REST auth parity, tenant ID, and revoked-device checks. | P0 if enabled | Mitigated by default flag | Keep `IOS_WS_ENABLED=false` or fix/test before enabling. |
| CHAT-P0-03 | No independent active tenant/workspace membership model. | P0 if multi-workspace switching is in scope | Open | Current auth maps `tenantId=userId`; do not claim true tenant switching. |
| CHAT-P1-01 | Domain handlers and tool executor accept user ID only. | P1 | Closed in branch | Tenant scope now threads through Chat domain and tool contracts. |
| CHAT-P1-02 | Shared memory store is tenant-aware, but shared-memory tools do not pass tenant ID. | P1 | Closed in branch | Tool context now carries tenant ID with tests. |
| CHAT-P1-03 | Daily context/shared decision/Secretary state caches are user-only. | P1 | Closed in branch | Chat-consumed cache paths now carry tenant dimension. |
| CHAT-P1-04 | AI usage/provider audit lacks tenant ID. | P1 | Partially closed | Migration adds tenant ID and domain calls carry metadata; streaming/off-domain one-shot attribution remains open. |
| CHAT-P1-05 | Raw user text can appear in some Chat error/shortcut logs. | P1 | Partially closed | High-risk Chat route/tool logs touched here now use safe metadata; wider non-Chat log audit remains. |
| CHAT-P1-06 | User export reads conversations/shared memory by user only. | P1 | Closed in branch | Export filters Chat rows by active canonical tenant/user scope. |
| CHAT-P2-01 | Day-to-day Chat simulation harness was needed for realistic multi-turn sufficiency. | P2 | Closed in branch | Deterministic persona/scenario/rubric harness and CLI are implemented and passing. |
| CHAT-P2-02 | iOS/portal Chat rendering caps were not audited in this backend pass. | P2 | Partially closed | Portal metadata-only diagnostics are audited; iOS readiness/smoke is tracked in RC docs with limitations. |

## Security Position

The current working tree closes the immediate REST Chat persistence issue for the one-canonical-tenant model and proves the migration path on a staging clone, but immediate production deployment still requires the release conditions in `docs/chat/chat-final-production-go-no-go.md`. Remaining high-risk expansion work is WebSocket streaming, wider provider audit, durable attachments/tool invocation records, and true active-tenant membership.

## Required Release Evidence

- Migrations `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql` applied on a disposable clone or staging DB. Closed for staging-clone proof on 2026-04-29.
- Focused Chat tenant tests passing after the migration.
- WebSocket disabled or fixed/tested.
- Release copy avoids claiming true multi-tenant workspace switching.
- Provider-routing docs remain provider-agnostic and do not claim GPT-only behavior.
