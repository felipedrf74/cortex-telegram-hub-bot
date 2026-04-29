# Chat Context Engine

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Purpose

Chat now has a dedicated context-selection layer in `src/services/chat-context-engine.ts`.

The goal is to stop treating prompt context as an undifferentiated string dump. The engine builds an auditable `<chat_reasoning_context>` block with explicit tenant/user scope, source, freshness, confidence, relevance, permission requirements, and weak-context signals before any provider sees the prompt.

## Current Inputs

The context engine selects from:

- Current user turn intent metadata.
- Tenant/user-scoped conversation history.
- Tenant/user-scoped shared memory.
- Tenant/user-scoped daily context cache.
- Tenant/user-scoped shared decision context.

All selected rows must resolve through `resolveChatTenantScope`. Invalid user/tenant scope returns no private context and emits a weak-context guardrail.

## Context Item Metadata

Each selected item carries:

- `tenantId`
- `userId`
- `ownerUserId`
- `scope`
- `source`
- `freshness`
- `confidence`
- `relevanceScore`
- `permissionRequirements`
- `expiresAt` / `staleAfter` where available
- `critical`
- `reason`

The current scope values align with the Chat tenant model:

- `user_private`
- `tenant_shared`
- `tenant_admin_visible`
- `platform_admin_visible`
- `system_internal`

## Selection Pipeline

1. Parse user intent for domain relevance, ambiguous follow-ups, memory recall/write, corrections, tenant-boundary mentions, planning, and action references.
2. Resolve tenant/user scope.
3. Retrieve only active rows for the resolved tenant and user.
4. Rank context by relevance, freshness, confidence, and criticality.
5. Dedupe repeated content.
6. Apply a character budget while preserving critical current-turn and ambiguous-follow-up context.
7. Emit weak-context signals when context is missing, stale, low-confidence, or tenant-ambiguous.

## Integration Points

- `src/domains/domain-handler.ts` appends the block for non-Secretary domains.
- `src/domains/secretary.ts` appends the block after the cached base Secretary state context, so per-turn prompt context is not accidentally cached across different user messages.
- `src/services/provider-fallback.ts` forwards the same scoped state context to whichever configured provider runs.

## Model Routing

The context engine does not pick a model. It preserves live routing:

- Gemini primary where configured.
- OpenAI fallback where configured.
- Anthropic emergency fallback only when enabled.
- Domain/tier/operator overrides remain outside this service.

Provider fallback receives the same already-scoped state context instead of rebuilding context independently.

## Remaining Limits

- No durable Chat vector store was found in this pass.
- True tenant membership/workspace switching is still not modeled; current canonical tenant is `tenantId = userId`.
- Streaming/WebSocket Chat must remain disabled or be hardened separately.
