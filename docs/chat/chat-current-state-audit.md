# Chat Current-State Audit

Generated: 2026-04-29 02:10 WEST  
Working branch: `feature/chat-tenant-safe-context-orchestration`  
Base commit: `a3f1b78a2dc543f285a14b2bdb9e5d602938d035`  
Rollback branch: `backup/chat-before-tenant-safe-upgrade-20260429-0210`  
Rollback tag: `backup-chat-before-tenant-safe-upgrade-20260429-0210`

## Scope And Truth Boundary

This audit describes the current backend working tree. It includes uncommitted Chat tenant-scope hardening already present from the previous Chat pass plus later release-candidate hardening. It is not proof that production is safe until the branch is reviewed, migrations are applied through the release path, a fresh production DB snapshot is taken immediately before deployment, and focused staging smoke passes. The `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql` migrations have passed staging-clone rehearsal.

No routing behavior was changed for this audit. Nexus Chat must remain provider-agnostic and must preserve the model-routing architecture documented in:

- `docs/ai/model-routing-current-state.md`
- `docs/ai/model-routing-skill-matrix.md`
- `docs/ai/model-routing-risk-register.md`
- `docs/ai/model-routing-open-items.md`

## Executive Summary

Nexus Chat is already a multi-layer interaction system, not a simple text box. It has:

- REST iOS Chat routes under `/api/v1/chat`
- deterministic Token-Zero fast paths for operational data lookups
- attachment/image preview handling
- route classification across Secretary, Training/Triathlon, Content, Finance, and Cooking
- per-domain handlers and tool loops
- short conversation continuity
- persisted iOS message history
- shared memory
- degraded responses for retryable provider failures
- configurable provider/model routing
- experimental WebSocket streaming behind `IOS_WS_ENABLED=false`

The major security finding is tenant scope. The REST Chat persistence path in the current working tree is now explicitly tenant-scoped, but the system still assumes `tenantId = userId` at auth time. That is safe only for the current one-user/one-canonical-tenant model. It is not enough for true multi-workspace Chat.

## Branch And Rollback Audit

| Item | Value |
| --- | --- |
| Starting branch observed | `feature/chat-tenant-secure-routing-intelligence` |
| Starting commit | `a3f1b78a2dc543f285a14b2bdb9e5d602938d035` |
| Required backup branch created | `backup/chat-before-tenant-safe-upgrade-20260429-0210` |
| Required backup tag created | `backup-chat-before-tenant-safe-upgrade-20260429-0210` |
| Required working branch created | `feature/chat-tenant-safe-context-orchestration` |
| Production deploy | Not performed |

## Chat Module Structure

| Area | Files | Current behavior |
| --- | --- | --- |
| Route composition | `src/api/routes/chat.ts` | Registers message, callback, and history routes with a scope guard. |
| Message entrypoint | `src/api/routes/chat-message-routes.ts` | Normalizes text/attachments, handles fast paths, routes messages, executes domain handlers, persists exchanges. |
| History | `src/api/routes/chat-history-routes.ts`, `src/services/chat-history-store.ts` | Lists and clears persisted message history. Current working tree filters by tenant and user. |
| Callback actions | `src/api/routes/chat-callback-routes.ts`, `src/api/routes/chat-persistence.ts` | Handles inline buttons and scoped assistant message edits. |
| Active context | `src/api/routes/chat-message-context.ts` | In-memory active-domain continuity with `tenantId:userId` key. |
| Attachments | `src/api/routes/chat-attachments.ts`, `src/api/routes/chat-message-attachments.ts` | Normalizes image attachments, calls image classifier, persists response metadata, does not durably store raw file bytes in this path. |
| Deterministic fast paths | `src/api/routes/chat-fastpath.ts`, `src/api/routes/chat-message-local-responses.ts`, `src/api/routes/chat-state-shortcuts.ts` | Handles slash commands and some state shortcuts without model calls. Cache keys now include tenant and user. |
| Routing/classification | `src/router/index.ts`, `src/router/classifier.ts` | Pattern, keyword, active-context, then classifier routing. Historical names still say Claude. |
| Domain execution | `src/domains/domain-handler.ts`, `src/domains/secretary.ts`, thin domain wrappers | Builds context, calls active provider, runs tool loops, stores conversation continuity. Chat execution now threads tenant/user scope through domain handlers and tool execution. |
| Shared memory | `src/state/shared-memory.ts` | Current working tree supports tenant-scoped memory store and shared-memory tools receive tenant context. |
| WebSocket streaming | `src/api/websocket.ts` | Experimental, gated by `IOS_WS_ENABLED=false`; uses JWT verification directly and lacks auth-middleware parity/tenant scope. |

## Chat Data Model

| Object | Current storage | Tenant status |
| --- | --- | --- |
| Persisted messages | `messages` table, migration `065`; tenant column added by migration `084` in current branch | Tenant-scoped in working tree after migration; staging-clone proof passed, production snapshot still required before deploy. |
| Conversation continuity | `conversations` table, originally domain/user history; tenant column added by migration `084` | Tenant-scoped in working tree; Chat domain execution threads tenant context. |
| Shared memory | `shared_memory` table, originally global key then user scoped; tenant uniqueness added by migration `084` | Tenant-scoped in store and Chat tool/context callers. |
| Daily context cache | `daily_context_cache` | Tenant-aware in the Chat branch where consumed by Chat; migration `084` adds tenant shape. |
| Shared decision context cache | in-memory scoped cache | Tenant-aware for Chat; non-canonical tenant peer mesh reads return empty until underlying mesh readers become tenant-aware. |
| Secretary state context cache | in-memory scoped cache | Tenant/user scoped for Chat usage. |
| Attachment raw files | No durable Chat attachment table found in this path | If file persistence is added, it must be tenant/user scoped. |
| Vector/embedding records | No active Chat vector index found | If added, namespace by tenant, user, domain, source object, and freshness. |
| Tool-call audit records | No durable Chat tool-call table found | If added, must record tenant, user, source message, skill, and authorization decision. |
| Streaming events | No durable stream event table found | WebSocket path is experimental and not tenant-hardened. |

## Tenant And User Scoping Current State

What is hardened in the current working tree:

- `AuthenticatedRequest` now has explicit `tenantId`.
- Current auth maps `tenantId = userId`.
- Chat REST message/history/callback persistence passes tenant ID.
- `messages`, `conversations`, and `shared_memory` are tenant-scoped after migration `084`.
- Active-domain continuity is keyed by `tenantId:userId`.
- Settings export reads messages by tenant and user.
- Focused tests exist for tenant-scoped message history, conversation continuity, shared memory, and invalid tenant scope guards.

What is still not true multi-tenant:

- JWT/auth does not carry independent active tenant/workspace selection.
- There is no membership authorization for `activeTenantId`.
- Domain handlers receive only `userId`.
- Tool executor receives only `userId`; shared-memory tools do not pass tenant ID.
- Daily context, shared decision context, and Secretary state context caches are user-scoped.
- WebSocket streaming does not use the REST auth middleware and does not attach tenant ID.
- User data export still queries `conversations` and `shared_memory` by user only.

## Conversation And Message Flow

REST message flow:

1. `POST /api/v1/chat/message` authenticates via `authMiddleware`.
2. The route validates user scope.
3. Text and image attachments are normalized.
4. Token-Zero fast paths may answer without AI.
5. Cost lock and quota guard run before AI spend.
6. Active domain context is resolved by tenant and user.
7. Message is routed by pattern, keyword, context, or classifier.
8. Domain handler executes.
9. Response is persisted to message history and conversation continuity.
10. Retryable provider failures can return a degraded response.

Important gap: the domain handler call receives `handler(message, userId)`, not tenant scope. Current store helpers default tenant to user ID, but that is not enough for true tenant switching.

## Model Routing And Provider Usage

Chat routing is provider-configurable. Do not hardcode GPT, Gemini, Claude, or any single provider.

Observed routing layers:

- task routing: classify/chat/tool-use
- domain provider routing
- provider registry and availability checks
- Anthropic runtime gate
- model-config tier/domain overrides
- portal/operator domain and model controls
- one-shot helper fallback paths
- Python content-engine TS proxy

See `docs/ai/model-routing-current-state.md` for the complete audit.

## Logs And Observability

Good:

- Chat request start/completion logs include request ID, user ID, tenant ID, domain, and duration.
- Invalid scope records tenant-scope anomalies.
- Retryable AI provider failures produce degraded responses without exposing raw provider errors to the client.
- Provider routing logs fallback events and usage rows.

Risks:

- `logger.error` in `chat-message-routes.ts` logs `text: normalizedText` on unhandled route failure. That can include sensitive user content.
- Some shortcut failure logs include `text: normalizedText`.
- Provider usage logs do not include tenant ID.
- Gemini/OpenAI domain usage often logs `user_id=0` because provider interface does not carry user ID.
- There is no single trace tying Chat request ID to provider/model/fallback/tool/cost/tenant.

## Tests Observed

Existing/focused test coverage includes:

- Chat route behavior and invalid scope guards.
- Chat history route behavior and sanitized errors.
- Chat persistence and assistant edit paths.
- Active-domain context behavior.
- Chat attachment and degraded response handling.
- Tenant-scoped chat-history store tests.
- User isolation tests for conversations and shared memory.
- Provider fallback/domain routing tests.

Missing tests:

- WebSocket auth parity, revocation, tenant scope, and streaming retry behavior.
- Domain handler tenant propagation.
- Shared memory tools with explicit tenant.
- Daily context/shared decision/Secretary context cache tenant isolation.
- User data export tenant selection.
- End-to-end day-to-day Chat simulations.
- iOS simulator Chat smoke against full local product engine.

## Do-Not-Break List

- Do not route ordinary app data lookups through model Chat when direct REST/service paths exist.
- Do not hardcode Chat to GPT, Gemini, Claude, or any provider.
- Do not rely on frontend filtering for tenant security.
- Do not let provider fallback rebuild broader or stale context.
- Do not store or retrieve memory, summaries, tool state, attachments, or stream state without tenant and user scope.
- Do not enable WebSocket streaming until it has auth-middleware parity and tenant scope.
- Do not log raw sensitive prompts, private calendar data, attachments, provider tokens, or full context dumps.
- Do not claim true multi-tenant Chat until active tenant membership and smoke tests prove it.
