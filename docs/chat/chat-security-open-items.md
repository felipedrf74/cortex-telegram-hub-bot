# Chat Security Open Items

Generated: 2026-04-29 03:30 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## P0 Production Blockers

1. WebSocket Chat must remain disabled or be fixed for auth, tenant scope, reconnect, and lifecycle parity.
2. Active tenant membership does not exist; do not claim true multi-workspace Chat.

## Closed Security Gates

1. Migration `084_chat_tenant_scope.sql` staging-clone proof passed on 2026-04-29.
2. Migration `085_chat_message_lifecycle.sql` staging-clone proof passed on 2026-04-29.

## P1 Must Fix

1. Durable tool invocation lifecycle and per-tool idempotency.
2. Attachment/file tenant scoping, prompt-injection labeling, and audit.
3. Admin/support Chat access policy, permission checks, and audit trail.
4. Wider provider/log audit outside the Chat route/tool paths touched here.
5. Tenant-aware peer mesh readers if shared-decision context must support tenant IDs different from user IDs.

## P2 Should Fix

1. Persisted pending confirmation state for safe follow-up confirmations.
2. Wider non-Chat sensitive log scanner.
3. Live vector namespace smoke if a vector store is enabled.

## Closed P2 Security/Readiness Items

1. Day-to-day red-team simulation harness is implemented and passing in deterministic fixture mode.
2. Local full-product Chat smoke is documented with cleanup confirmation.
3. Portal/web Chat surface audit is complete for metadata-only diagnostics.
4. iOS Chat smoke/readiness is represented in the RC evidence with documented limitations.

## P3 Deferrable

1. More nuanced prompt-injection taxonomy.
2. Security UX polish for source attribution/refusal text.
3. Automated sensitive-log scanner.
