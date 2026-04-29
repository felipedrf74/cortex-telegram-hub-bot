# Chat Authorization Model

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Enforcement Rules

1. Authenticated iOS routes must pass through `authMiddleware`.
2. Chat route guards reject invalid `userId` before any history read, write, callback mutation, or model prompt construction.
3. Chat storage accessors require valid `(tenant_id, user_id)` scope and only return `scope_status = 'active'`.
4. Multi-turn context uses tenant-aware active-domain keys and tenant-aware conversation retrieval.
5. Shared memory tools inherit the current Chat tenant scope and cannot write into another tenant key.
6. Daily-context and shared-decision caches use tenant-aware keys.
7. Ambiguous legacy rows are quarantined and omitted from runtime accessors.

## Current Access Semantics

| Scope | Current behavior |
| --- | --- |
| `user_private` | Default for all iOS Chat messages, conversations, and memory. Only the authenticated user in the resolved tenant can access it. |
| `tenant_shared` | Reserved, not emitted by current Chat writes. Requires membership/role checks before use. |
| `tenant_admin_visible` | Reserved. Must require tenant-admin role and audit. |
| `platform_admin_visible` | Reserved. Must require platform-admin role and audit. |
| `system_internal` | Used for quarantined ambiguous rows and internal/system artifacts. Not returned to normal Chat. |

## Backend Guarantees Added

- `listChatMessages`, `updateAssistantMessage`, and `clearChatHistory` filter by tenant and user.
- Conversation history, last-assistant lookup, and clear operations filter by tenant and user.
- Shared memory reads/writes/removes filter by tenant and user.
- Fast-path Chat command cache is keyed by `tenantId:userId:command`.
- Secretary/simple-domain prompt context receives tenant-aware conversation and memory context.
- Provider tool execution no longer logs full tool input payloads.

## Explicit Non-Goals In This Pass

- This pass does not introduce a multi-workspace tenant membership table.
- This pass does not enable WebSocket Chat; WebSocket remains unsafe unless hardened separately.
- This pass does not add durable attachment/vector/tool-call tables because no active Chat storage for those was found.

## Release Gate

Do not enable true tenant switching or WebSocket Chat until:

- membership and active tenant are explicit,
- every Chat route and transport uses the same authorization primitive,
- provider usage rows carry tenant where available,
- iOS smoke proves tenant switching clears stale Chat state.
