# Chat Tenant Security Gap Analysis

Generated: 2026-04-29 02:10 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Verdict

Treat Chat tenant safety as P0 for any future workspace-switching or broad multi-tenant Chat expansion. For the current REST Chat release scope, the working-tree fixes are reviewed in the RC docs and migrations `084`/`085` are validated on a staging clone; remaining user-only paths are either fixed, disabled, or explicitly blocked from multi-tenant claims.

The current REST Chat persistence path is materially improved in the working tree. It is not yet a complete multi-workspace Chat architecture.

## P0 / P1 Gap Table

| ID | Severity | Area | Finding | Current status | Required closure |
| --- | --- | --- | --- | --- | --- |
| CHAT-TENANT-P0-01 | P0 | Production state | Existing production/staging Chat persistence may still be user-only until migration `084` is applied and code is released. | Staging-clone rehearsal passed | Apply through normal release path after fresh production DB snapshot. |
| CHAT-TENANT-P0-02 | P0 if enabled | WebSocket Chat | `src/api/websocket.ts` verifies JWT directly, does not check active user/device revocation like `authMiddleware`, does not attach tenant ID, and routes by user only. | Gated by `IOS_WS_ENABLED=false` | Do not enable WebSocket until auth parity, tenant scope, tests, and iOS smoke are complete. |
| CHAT-TENANT-P0-03 | P0 if multi-tenant switching exists | Active tenant | Auth currently maps `tenantId = userId`; there is no independent active tenant/workspace claim or membership check. | Safe only for current one-tenant-per-user assumption | Add active tenant/session model and membership authorization before true tenant switching. |
| CHAT-TENANT-P1-01 | P1 | Domain handlers | `ChatDomainHandler` and `handleSimpleDomain` accept only `userId`; tenant defaults back to user ID. | Closed in branch | Tenant-aware handler contract now threads tenant through domain context, conversation, tool execution, and persistence. |
| CHAT-TENANT-P1-02 | P1 | Tool calls | `executeToolCall` receives only user ID; shared-memory tools call `setSharedMemory(userId, ...)` without tenant. | Closed in branch | Tool execution accepts tenant ID; shared-memory tools pass it to scoped memory. |
| CHAT-TENANT-P1-03 | P1 | Context caches | `daily_context_cache`, shared decision cache, and Secretary state-context cache are user-scoped. | Closed in branch | Tenant-aware cache keys/table shape added where Chat consumes these contexts. |
| CHAT-TENANT-P1-04 | P1 | User export | `exportAllUserData` queries conversations/shared memory by user only. | Closed in branch | Export filters active canonical tenant/user Chat conversation and memory rows. |
| CHAT-TENANT-P1-05 | P1 | Provider observability | AI usage rows lacked tenant ID and some provider-domain calls logged user 0. | Partially closed | Domain calls now carry optional user/tenant metadata through `CallDomainOptions`; streaming and some one-shot paths still need a wider audit. |
| CHAT-TENANT-P1-06 | P1 | Logging | Some error logs include raw `normalizedText` or response preview snippets. | Partially closed | High-risk Chat route/tool logs touched here now use lengths/keys. Wider non-Chat logs still need audit. |
| CHAT-TENANT-P1-07 | P1 | Fast-path cache | Deterministic Chat command cache is keyed by user ID and command text only. | Closed in branch | Cache key is now `tenantId:userId:command`. |
| CHAT-TENANT-P1-08 | P1 | Attachments | Image attachments are not durably stored in this path, but model calls receive raw image data and no tenant-aware audit object exists. | Open | Add scoped attachment audit if attachments become durable or support workflows need traceability. |

## Objects That Need Tenant Scope

| Object | Current observed status |
| --- | --- |
| Conversation | Tenant column in migration `084`; tenant used in store helpers and domain callers. |
| Message | Tenant column in migration `084`; REST route uses tenant. |
| Attachment | No durable table found; runtime classification only. Needs scope if persisted. |
| Tool call | No durable Chat tool-call table found. Tool execution now receives tenant ID for scoped tools. |
| Skill invocation | Routed by user/domain. No tenant-aware invocation audit found. |
| Retrieved context | Daily/shared-decision/Secretary Chat cache paths now include tenant. Underlying peer-skill stores remain user-scoped until true tenant membership exists. |
| Memory | Store and shared-memory tool path are tenant-aware in branch. |
| Summary/cache | Daily context cache is tenant-aware in branch. Conversation summaries/vector memory not found. |
| Embedding/vector record | No active Chat vector namespace found. Must be tenant namespaced if introduced. |
| Audit log | Provider and Chat request logs lack full tenant-aware AI trace. |
| Feedback | No Chat-specific feedback table audited. Must be scoped if added. |
| Streaming event | WebSocket not tenant-aware; no durable stream table found. |
| Background job | No Chat-specific background job audited. Any future job must carry tenant/user/source message. |

## Provider Fallback And Prompt Safety

Current behavior preserves provider configurability, but tenant safety must be handled before prompt construction:

- Provider routing does not enforce tenant isolation.
- Fallback providers receive whatever context the primary would have received.
- Domain handlers must not rebuild context using only user ID when an active tenant is selected.
- Internal AI proxy is system-scoped and should not receive tenant-private prompts unless user/tenant attribution is added.

## Blocking Rule

Before production release of this Chat workstream:

1. Migrations `084` and `085` must remain linked to the passed staging-clone rehearsal, and production must receive a fresh predeploy DB snapshot.
2. Focused Chat tenant/security tests must pass.
3. WebSocket must either remain disabled or be fixed/tested.
4. Release notes must state that current tenant behavior is `tenantId=userId` unless active tenant membership is implemented.
5. No docs or product copy may claim full workspace switching safety before membership checks exist.
