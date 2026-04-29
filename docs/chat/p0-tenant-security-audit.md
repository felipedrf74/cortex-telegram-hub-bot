# P0 Chat Tenant Security Audit

Generated: 2026-04-29 11:52 WEST

Branch: `feature/chat-p0-tenant-security-audit`

Backup: `backup/chat-p0-tenant-security-audit-20260429-1116`, tag `backup-chat-p0-tenant-security-audit-20260429-1116`

Scope: conversations, messages, callback/button actions, streaming, memory, summaries, retrieval/vector storage, attachments, tool calls, skill invocations, shared context, iOS cache, portal/admin surfaces, prompt construction, provider fallback, logs, and observability.

## Executive Summary

Nexus Chat has strong tenant scoping on the main REST history and prompt-context paths after migrations `084` and `085`: messages, conversations, shared memory, daily context cache, API usage, and audit rows now carry tenant scope, and REST chat routes pass `tenantId` through persistence, prompt construction, model metadata, and scoped tool execution.

However, the audit found one P0 release blocker: inline chat callback state is global, short-reference based, and not bound to tenant/user/message ownership. Task callbacks then execute Microsoft Todo mutations through the global provider service rather than the per-user task provider path. If callback refs are leaked, reused, guessed, replayed, or mixed across users, the backend has no owner check before fetching, completing, or deleting task/list data.

The audit also found several P1 issues that must remain explicit before a broader workspace/tenant release: WebSocket chat is disabled and intentionally not production-grade, but if enabled it does not carry tenant scope through routing/handlers; active tenant membership is not modeled because iOS currently sets `tenantId = userId`; daily context source reads remain user-scoped; attachment vision classification does not propagate tenant metadata into provider usage; and portal user diagnostics are metadata-only but user-scoped rather than tenant-scoped.

No runtime implementation was performed in this pass. The P0 callback issue is not safe as a one-line patch because it requires a database migration, callback API signature changes, caller rewiring, per-user task provider execution, destructive-action idempotency/replay rules, and new isolation tests.

## Current Tenant Model

The iOS auth middleware sets the authenticated request scope as:

- `userId = JWT.userId`
- `tenantId = JWT.userId`
- `deviceId = JWT.deviceId`

Evidence:

- `src/api/auth-middleware.ts:126-131`

The explicit comment says Nexus currently uses `users.id` as the canonical tenant key for iOS runtime data. This is consistent for the current one-user-one-canonical-tenant release. It is not sufficient for true multi-workspace tenant switching.

The shared chat scope helper accepts a valid explicit tenant ID when one is provided, otherwise it falls back to `userId`.

Evidence:

- `src/services/chat-tenant-scope.ts:41-80`

Risk: no membership check exists in `resolveChatTenantScope` itself. Current iOS REST calls do not let the client supply a different tenant, but future active-tenant headers or portal/admin routes must add membership validation before using arbitrary tenant IDs.

## Positive Findings

| Area | Result | Evidence |
| --- | --- | --- |
| REST messages | Scoped by `tenant_id`, `user_id`, and `scope_status` after migration `084`. | `migrations/084_chat_tenant_scope.sql:8-27` |
| REST conversations | Scoped by tenant/user/domain and active status. | `migrations/084_chat_tenant_scope.sql:29-66` |
| Shared memory | Rebuilt with `tenant_id`, `user_id`, visibility, status, and unique `(tenant_id, user_id, key)`. | `migrations/084_chat_tenant_scope.sql:68-123` |
| Daily context cache | Rebuilt with primary key `(tenant_id, user_id, date)`. | `migrations/084_chat_tenant_scope.sql:125-159` |
| API usage and audit rows | `tenant_id` added and indexed. | `migrations/084_chat_tenant_scope.sql:161-169` |
| Prompt context builder | Builds typed context items with tenant, user, freshness, confidence, source, relevance, and permission metadata before model calls. | `src/services/chat-context-engine.ts` |
| Main domain provider path | Provider-agnostic path passes `{ userId, tenantId }` to model calls and tool continuation. | `src/domains/domain-handler.ts:433-479` |
| Tool call authorization | Chat route wraps domain handlers in a scoped authorization context, and `executeToolCall` checks user and tenant where context is present. | `src/services/chat-tool-authorization.ts`, `src/services/tool-executor.ts` |
| iOS REST chat cache | Repository scopes loaded messages and local clear cutoff by `user-{id}.tenant-{id}` and clears on scope change. | `Nexus Hub/Nexus Hub/Core/Repositories/ChatRepository.swift:21-57` |
| Portal chat diagnostics | Default portal diagnostics expose metadata, counts, lifecycle, provider usage, and text length, not raw message text. | `src/portal/chat-diagnostics.ts:350-408` |
| WebSocket release status | WebSocket is config-gated and documented as disabled for release. | `src/config.ts:442-445`, `src/portal/server.ts:345-355`, `docs/qa/QA_BACKEND_REPORT.md:18` |

## Findings

### P0 Production Blocker - Global callback refs can drive cross-user task mutations

Callback payloads are stored in `callback_entries` by `ref` only. The table has no `tenant_id`, `user_id`, `created_by`, `visibility_scope`, `scope_status`, `message_id`, or consumed/replay state.

Evidence:

- `migrations/066_ephemeral_action_state.sql:14-23`
- `src/utils/callback-store.ts:41-68`
- `src/utils/callback-store.ts:106-128`

Callback refs are only 8 hex characters from a UUID and are retrieved by ref alone.

Evidence:

- `src/utils/callback-store.ts:106-114`

The iOS chat callback route calls `getCallback(ref)` or `getCallback(callbackData)` without verifying that the current `userId` and `tenantId` own the callback.

Evidence:

- `src/api/routes/chat-callback-routes.ts:131-143`
- `src/api/routes/chat-callback-routes.ts:163-166`

Task callback actions then use the global Microsoft Todo service directly:

- list tasks: `microsoftTodo.getTasks(...)`
- complete task: `microsoftTodo.completeTask(...)`
- delete task/list: `microsoftTodo.deleteTask(...)`, `microsoftTodo.deleteList(...)`

Evidence:

- `src/api/routes/chat-callback-routes.ts:181-214`

The callback producers store task/list/coach payloads without owner scope.

Evidence:

- `src/api/routes/chat-inline-buttons.ts:63-65`
- `src/api/routes/chat-inline-buttons.ts:80-93`
- `src/api/routes/chat-inline-buttons.ts:123-130`

Impact:

- A callback ref leaked through logs, screenshots, local cache, replay, notification previews, or a compromised client can be submitted by another authenticated user.
- The backend validates that the caller is logged in, but it does not validate ownership of the callback payload before using the payload.
- Destructive task/list callbacks can mutate the wrong account if global Microsoft Todo credentials are active.
- This is backend-side, not frontend-filterable.

Required fix:

- Add tenant/user/scope columns to `callback_entries`.
- Replace `storeCallback(data)` with a scoped API that requires `tenantId`, `userId`, `sourceMessageId`, `actionType`, and optional `consumed_at`.
- Replace `getCallback(ref)` with `getCallbackForScope(ref, tenantId, userId)`.
- Increase ref entropy and reject old unscoped callbacks or quarantine them.
- Route task callbacks through the authenticated user's task provider, not the global Microsoft Todo module.
- Add replay protection for destructive callbacks.
- Add tests for cross-user ref replay, cross-tenant ref replay, expired ref, destructive callback idempotency, and wrong-provider mutation denial.

Status: open P0.

### P1 - WebSocket chat is disabled, but unsafe if enabled

The WebSocket transport is currently gated by `IOS_WS_ENABLED=false` and release docs say it must remain disabled. If enabled, the WebSocket path diverges from REST auth and tenant semantics:

- It accepts a connection without auth, then authenticates via the first WebSocket frame.
- It verifies the JWT directly rather than using the REST auth middleware, so user/device session revocation and user-status checks can drift.
- It does not set `tenantId`.
- `routeMessage` is called with `userId` only.
- Domain handlers are called as `handler(message, userId)` only.
- Request context includes `userId` but not tenant.
- Stream chunk/done frames do not include tenant/user scope.

Evidence:

- `src/api/websocket.ts:54-60`
- `src/api/websocket.ts:83-89`
- `src/api/websocket.ts:108-114`
- `src/api/websocket.ts:158-185`
- `src/config.ts:442-445`
- `src/portal/server.ts:345-355`

iOS release code intentionally disables the streaming path:

- `Nexus Hub/Nexus Hub/ViewModels/ChatViewModel.swift:639-645`

Impact:

- Not an active exploit while `IOS_WS_ENABLED` remains unset/false and iOS REST-only behavior holds.
- P0 if WebSocket is enabled before tenant/auth parity and lifecycle hardening are complete.

Required fix:

- Keep `IOS_WS_ENABLED=false` in staging and production.
- If enabling later, reuse the REST auth/session/device revocation path or factor a shared JWT verifier.
- Carry `tenantId` through route, handlers, prompt context, tool authorization, stream frames, logging, persistence, and reconnect/idempotency.
- Add WebSocket tenant isolation, reconnect, duplicate chunk, and provider fallback tests.

Status: open P1, with P0 release condition: WebSocket must remain disabled.

### P1 - Active tenant membership is not modeled

The code now has tenant columns, but active tenant identity is still the authenticated user ID. `resolveChatTenantScope` validates positive IDs, not membership.

Evidence:

- `src/api/auth-middleware.ts:126-131`
- `src/services/chat-tenant-scope.ts:41-80`

Impact:

- Current iOS one-user-one-canonical-tenant data is scoped.
- True tenant/workspace switching cannot be claimed or released safely until there is a tenant membership model and all chat queries/tool calls enforce it.

Required fix:

- Define tenant/workspace membership tables and active-tenant selection.
- Validate that the authenticated user is a member of the active tenant before any chat query, prompt context build, tool call, attachment classification, memory read/write, or portal/support access.
- Make iOS scope keys use the actual active tenant, not `tenant=user`.

Status: open P1. If product requires true tenant switching now, reclassify to P0.

### P1 - Daily context sources remain user-scoped and not fully tenant-aware

The cache row is tenant-scoped, but several source reads inside `buildDailyContext` query by `user_id` only:

- unified tasks
- calendar events through user-level provider lookup
- training plans
- readiness scores
- content saved ideas with `user_id IN (0, ?)`

Evidence:

- `src/services/context-engine.ts:111-131`
- `src/services/context-engine.ts:145-150`
- `src/services/context-engine.ts:168-176`
- `src/services/context-engine.ts:189-192`
- `src/services/context-engine.ts:206-208`

Impact:

- Safe enough for current tenant=user architecture.
- Unsafe for real multi-tenant workspaces where the same user may hold different tenant contexts.
- `saved_ideas user_id=0` is treated as global context. If those rows ever contain tenant-private content, Chat can ingest unrelated content context.

Required fix:

- Make source tables tenant-aware where tenant scope applies.
- Replace `user_id IN (0, ?)` prompt-context reads with explicit public/system scope semantics.
- Add tests that a same user in two tenants receives different daily context and that global/system content cannot contain tenant-private data.

Status: open P1 for true multi-tenant release.

### P1 - Attachment vision classification does not propagate tenant metadata

Chat attachment classification accepts `userId` but not `tenantId`. The image classifier and vision fallback log provider usage with user metadata only.

Evidence:

- `src/api/routes/chat-message-attachments.ts:10-15`
- `src/api/routes/chat-message-attachments.ts:92-115`
- `src/services/anthropic.ts:634-686`

Impact:

- Attachment bytes are not persisted as durable chat files in this code path, which limits durable leakage risk.
- Provider usage, telemetry, and fallback metadata are not tenant-complete.
- If true multi-tenant attachments arrive later, provider calls must not depend only on user scope.

Required fix:

- Add `tenantId` to attachment classification input and all provider usage logging.
- Add tenant-aware size/type limits, prompt-injection handling for image content, and tests for tenant metadata propagation.

Status: open P1 for attachment/provider release claims; P2 in current REST text-only release if attachments remain limited.

### P1 - Portal user chat diagnostics are metadata-only but not tenant-filtered

Portal diagnostics avoid raw text by default, but user-level recent message diagnostics filter by `user_id` only, not by tenant. In the current tenant=user model, this is equivalent. In future multi-tenant, it would collapse the user's conversations across all tenants.

Evidence:

- `src/portal/chat-diagnostics.ts:379-408`
- `src/portal/chat-routes.ts:30-59`

Operator target scoping is optional. If `PORTAL_OPERATOR_USER_SCOPES` is empty, any valid admin token can inspect any user metadata.

Evidence:

- `src/portal/admin-target-user.ts:45-55`

Impact:

- Metadata-only diagnostics reduce privacy exposure.
- Still insufficient for tenant-isolated support tooling and audited tenant admin access.

Required fix:

- Require tenant filter or tenant permission for user chat diagnostics.
- Audit each diagnostics access with actor, target user, target tenant, reason, route, and result.
- Configure operator-user scopes in any multi-operator environment.

Status: open P1 for support/admin production tooling.

### P2 - Direct Anthropic fallback path loses tenant metadata

The normal provider-agnostic route passes `{ userId, tenantId }` into `provider.callDomain` and `provider.continueWithToolResults`. The legacy direct fallback path builds the scoped prompt first, but calls Anthropic with legacy positional args, so provider usage metadata does not get the tenant ID.

Evidence:

- Normal path: `src/domains/domain-handler.ts:433-479`
- Direct fallback path: `src/domains/domain-handler.ts:507-542`

Impact:

- Prompt context remains scoped because `history` and `stateContext` are built before the fallback.
- Observability and cost rows may lose tenant attribution if the direct fallback path is used.

Required fix:

- Convert `handleWithDirectCalls` to pass a full `CallDomainOptions` object, including `tenantId`, for both initial and continuation calls.
- Add a regression test that direct fallback provider calls receive tenant metadata.

Status: open P2.

### P2 - Some chat logs/telemetry omit tenant/user metadata

Most chat request logs include user and tenant. Some routing and degraded attachment logs omit tenant, and WebSocket telemetry omits tenant because WebSocket does not carry it.

Evidence:

- `src/api/routes/chat-message-routes.ts:220-280`
- `src/api/websocket.ts:72-78`
- `src/api/websocket.ts:190-197`

Impact:

- Weakens incident response and tenant-level monitoring.
- Not a direct data leak by itself.

Required fix:

- Standardize chat log fields: `tenantId`, `userId`, `requestId`, `conversationId/messageId`, `domain`, `routeMethod`, provider/model/category where applicable.
- Keep raw prompt, message text, provider tokens, calendar details, and finance data out of logs.

Status: open P2.

### P2 - iOS WebSocket placeholder messages have nil tenant/user

The iOS REST chat cache is scoped, but the dormant WebSocket chunk handler creates assistant messages with `tenantId: nil` and `userId: nil` when a chunk arrives for an unknown message ID.

Evidence:

- `Nexus Hub/Nexus Hub/ViewModels/ChatViewModel.swift:168-181`

Impact:

- Not active while iOS forces REST-only streaming disabled.
- Unsafe to enable streaming without tenant-aware message frames and iOS scope validation.

Required fix:

- Include tenant/user in stream metadata or bind stream sessions to an authenticated scoped repository.
- Reject chunks whose message/session scope does not match the current scope key.

Status: open P2 while WebSocket disabled; P1 if streaming is enabled.

### P3 - Prompt context includes numeric tenant/user IDs

The prompt context block carries active tenant/user IDs as metadata. This is useful for traceability but may not be necessary for model reasoning.

Evidence:

- `src/services/chat-context-engine.ts`

Impact:

- Low sensitivity by itself.
- Can be minimized later by using opaque labels such as "active tenant" and keeping raw IDs in metadata/logs only.

Status: open P3.

## Coverage Notes

No durable chat-specific tables were found for message chunks, stream events, embeddings/vector records, tool calls, skill invocations, attachment files, or conversation summaries. The current implementation appears to store messages, conversation history, shared memory, daily context cache, callback state, API usage, and audit records; tool calls and skill results are mostly transient or embedded in message metadata.

If durable vector/retrieval or tool-call tables are added later, they must carry tenant/user/scope columns from the start.

## Immediate Release Gate

Verdict: NO-GO for any release that enables inline chat task callbacks, true workspace tenant switching, or WebSocket chat streaming without additional hardening.

Conditional path for a narrow REST-only Chat release:

1. Disable or remove unsafe callback actions until scoped callback ownership is implemented.
2. Keep `IOS_WS_ENABLED=false` in staging and production.
3. Do not claim true workspace/tenant switching.
4. Do not expose raw chat content in portal/support tooling.
5. Run focused staging Chat smoke after these conditions are confirmed.
