# Chat Tenant Isolation Test Matrix

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

| Area | Test | Status |
| --- | --- | --- |
| Message history | Same user, two tenants, same message IDs remain isolated. | Added in `chat-history-store.test.ts`. |
| Message mutation | Assistant edit updates only matching tenant/user/message. | Added in `chat-history-store.test.ts`. |
| Message clearing | Clearing one tenant does not clear another tenant. | Added in `chat-history-store.test.ts`. |
| Legacy quarantine | Quarantined legacy rows are not returned by active history. | Added in `chat-history-store.test.ts`. |
| Invalid writes | Missing/invalid user scope is rejected for message writes. | Added in `chat-history-store.test.ts`. |
| Conversation context | Same user conversation state is isolated by tenant. | Covered in `user-isolation.test.ts`. |
| Legacy conversation | `user_id = 0` conversation data is not exposed. | Updated in `user-isolation.test.ts`. |
| Shared memory | Same user can store same key independently per tenant. | Covered in `user-isolation.test.ts`. |
| Tool calls | Shared-memory tool calls inherit Chat tenant scope. | Added in `tool-executor.test.ts`. |
| Fast-path cache | Deterministic command cache is tenant/user scoped. | Added in `chat-message-local-responses.test.ts`. |
| Domain execution | Domain handlers receive tenant ID from Chat route execution. | Updated in `chat-message-execution.test.ts`. |
| Daily context cache | Same user daily context is isolated per tenant. | Added in `context-engine.test.ts`. |
| Shared decision cache | Same user shared-decision context cache is isolated per tenant. | Added in `shared-decision-context.test.ts`. |
| Sensitive Chat shortcut logs | Content shortcut/refinement failures do not log raw normalized user text. | Verified by route tests and source scan after log redaction. |
| WebSocket | Auth parity, revoked-session checks, tenant ID, and stream retry isolation. | Open P0 if WebSocket is enabled. |
| Attachments/files | Durable attachment access denied across tenant/user. | Open; no durable Chat attachment table found. |
| Vector/retrieval | Retrieval namespace cannot cross tenants. | Open; no active Chat vector store found. |
| iOS tenant switch | Switching tenant clears stale conversation/memory/cache. | Open; requires true tenant switch support. |
