# Chat Retrieval Tenant Safety

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Current Status

No active durable Chat vector/embedding table was identified in this pass. Chat retrieval currently means scoped reads from SQL-backed conversation, shared memory, daily context, and cross-skill context stores.

## Required Retrieval Rule

Retrieval must be scoped before ranking whenever possible:

- Filter by `tenant_id`.
- Filter by `user_id` for private scope.
- Filter by visibility/permissions.
- Filter by `scope_status = active`.
- Quarantine ambiguous legacy records.

Post-retrieval filtering is not sufficient for sensitive tenant data if an embedding/vector backend can return cross-tenant neighbors.

## Future Vector Store Requirements

If Chat vector search is added, records must include:

- `tenant_id`
- `user_id` / owner
- visibility scope
- source object ID
- source domain
- lifecycle state
- created/updated timestamps
- embedding namespace derived from tenant and visibility

Queries must include tenant namespace and permission filters before returning candidates to the prompt builder.

## Tests Added In This Pass

`chat-context-engine.test.ts` covers:

- Active tenant isolation.
- Cross-user private memory isolation.
- Quarantined memory/conversation exclusion.
- Weak-context behavior for ambiguous references and tenant-boundary mentions.

## Remaining Open Item

Add vector namespace tests when a Chat vector store exists.
