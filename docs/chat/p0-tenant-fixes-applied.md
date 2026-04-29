# P0 Chat Tenant Fixes Applied

Generated: 2026-04-29 12:12 WEST

Branch: `feature/chat-p0-tenant-security-audit`

Rollback anchor:
- branch: `backup/chat-p0-tenant-fixes-20260429-1126`
- tag: `backup-chat-p0-tenant-fixes-20260429-1126`

## Executive Summary

This batch closes the highest-risk Chat tenant-safety gaps found in the P0 audit for the current iOS production model, where the active chat tenant is canonicalized as the authenticated user ID.

The fixes enforce tenant/user scope before chat callbacks, task mutations, attachment classification, direct provider fallback metadata, WebSocket routing if enabled, portal chat diagnostics, and prompt/tool execution paths. Live model routing remains provider-agnostic and operator-controlled; no provider or model was pinned by these changes.

No production deployment was performed.

## Issues Closed

| ID | Prior severity | Status | Fix summary |
| --- | --- | --- | --- |
| CHAT-P0-01 | P0 | Closed for scoped Chat callbacks | Added scoped callback storage with `tenant_id`, `user_id`, lifecycle fields, replay controls, and tenant/user-bound lookup/consume APIs. Existing legacy callback rows are quarantined by migration. |
| CHAT-P0-02 | P0 | Closed | Chat callback task actions now use the authenticated user's task provider instead of global `microsoftTodo`. |
| CHAT-P0-03 | P0 if enabled | Mitigated | WebSocket remains disabled by default, and the dormant route now authenticates JWT/device state, sets tenant scope, and propagates tenant/user metadata into route and provider calls. Full durable streaming remains a future gate before enabling WebSocket. |
| CHAT-P1-04 | P1 | Closed | Attachment vision classification now passes tenant metadata through the live provider routing/fallback layer. |
| CHAT-P1-05 | P1 | Closed for metadata-only diagnostics | Portal chat diagnostics now tenant-filter user diagnostics and write audit records for aggregate/user diagnostic reads. |
| CHAT-P1-06 | P1 | Closed | Added tenant/user callback tests for scoped lookup, legacy quarantine, replay prevention, and task-provider ownership. |
| CHAT-P2-01 | P2 | Closed | Direct Anthropic fallback now receives `tenantId` in call options for tenant-safe usage/fallback observability. |

## Implementation Notes

### Scoped callback ownership

Added migration `086_chat_callback_scope.sql` to extend `callback_entries` with tenant/user ownership, callback lifecycle, visibility scope, source message, action type, and replay tracking.

The new callback APIs are:
- `storeCallbackForScope(data, scope, ttlMs?)`
- `getCallbackForScope(ref, { tenantId, userId })`
- `consumeCallbackForScope(ref, { tenantId, userId })`

Legacy callback APIs remain available for existing bot/Telegram flows, but legacy global lookup refuses active scoped Chat refs. Scoped lookup rejects ambiguous legacy refs.

### Chat callback route hardening

Chat inline buttons and fast-path buttons now create tenant/user-scoped callback refs when invoked from iOS Chat. Callback consumers reject mismatched or missing refs and consume destructive refs after successful mutation.

Task callbacks use `getTaskProviderForUser(userId)`, so the action executes against the authenticated user's provider instead of a global integration object.

### Chat route tenant guard

The iOS Chat REST ingress now validates scope with `ensureValidChatRouteScope`. For the current canonical model, `tenantId` must equal `userId`; mismatches return `403 tenant_scope_violation` before data access, prompt construction, skill routing, or model calls.

This intentionally does not claim true workspace tenant switching. Workspace tenants require membership tables, role checks, and tenant-aware source reads before release.

### Prompt and model-provider paths

Attachment classification and direct fallback paths now carry tenant metadata. Provider routing remains unchanged:
- no fixed GPT, Gemini, Claude, or other model was hardcoded
- operator overrides remain part of the existing routing stack
- Anthropic remains gated by existing config
- category tags remain tracking/observability signals, not a forced routing layer

### Tool-call authorization

Tool-call authorization now rejects model or prompt-injected inputs that try to override `tenantId`, `tenant_id`, `userId`, `user_id`, `ownerUserId`, or `owner_user_id` away from the authenticated Chat scope before execution.

### WebSocket route

The dormant iOS WebSocket path now validates JWT and device state, assigns tenant scope, and includes tenant/user metadata in route calls and frames. It remains a non-release path until durable streaming lifecycle, idempotency, and local/iOS smoke are completed.

### Portal/support diagnostics

Portal chat diagnostics remain metadata-only. User diagnostics now include tenant filtering and audit log writes for both aggregate and user diagnostic reads. Non-canonical tenant queries are rejected.

## iOS Cache Status

No iOS code changes were required in this batch. Existing iOS Chat repository tests already cover tenant/user cache partition behavior: switching scope changes the loaded cache key and prevents stale persisted messages from a prior scope from loading into the new scope.

The iOS simulator was not rerun in this focused backend security batch. Full iOS local smoke remains a release-gate step before production.

## Migration and Rollback

Migration:
- `migrations/086_chat_callback_scope.sql`

Rollback strategy:
- restore the pre-deploy DB snapshot if migration rollback is needed
- deploy previous backend commit or the backup branch/tag listed above
- keep `IOS_WS_ENABLED=false` during rollback

Because existing legacy callback refs are quarantined by the migration, rollback should account for any in-flight Chat buttons minted after migration. The safe user-facing behavior is to ask the user to retry the Chat action.

## Release Impact

Safe to stage for focused Chat tenant-safety validation after normal migration rehearsal and staging deploy.

Not sufficient for a broad Chat product release that claims:
- true workspace tenant switching
- durable WebSocket Chat streaming
- tenant-aware vector retrieval
- raw admin/support conversation review
- broad destructive tool execution from Chat without a durable action ledger
