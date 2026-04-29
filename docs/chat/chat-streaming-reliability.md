# Chat Streaming Reliability

Generated: 2026-04-29 03:16 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Current Decision

Chat streaming is not considered production-ready in this branch. The safe operational posture remains:

```text
IOS_WS_ENABLED=false
```

The REST chat path is the hardened path for this implementation pass. It now has message claiming, replay, conflict detection, and stuck-state repair primitives.

## Reliability Model

The target streaming model is:

1. Authenticate the stream with the same user/session requirements as REST.
2. Resolve active tenant before any history/context retrieval.
3. Claim the user message with `client_message_id`.
4. Persist assistant response as `streaming`.
5. Append chunks with monotonic sequence numbers.
6. Finalize as `completed` only after provider/tool execution completes.
7. Mark `failed` or `canceled` explicitly on disconnect/cancel/failure.
8. Allow reconnect to resume or replay without duplicating actions.

## Implemented In This Pass

Implemented for REST and reusable by streaming:

- `clientMessageId` and `idempotencyKey` normalization.
- Early user-message claim before skill/model execution.
- Replay of completed assistant response for idempotent retries.
- `202 idempotency-in-progress` for duplicate in-flight retries.
- `409 CHAT_IDEMPOTENCY_CONFLICT` when a client ID is reused for different text.
- Tenant-scoped lifecycle mutation helper.
- Tenant-scoped stuck-state repair helper.
- Hidden `deleted` messages from active history.

## Not Yet Implemented

Streaming still needs:

- Durable chunk table or append-only event store.
- Chunk sequence numbers.
- Duplicate/out-of-order chunk handling.
- Stream resume token.
- Reconnect endpoint.
- Provider-specific streaming adapters for Gemini/OpenAI/Anthropic fallback.
- Tests proving fallback does not duplicate assistant rows or tool calls.
- Tests proving reconnect cannot switch tenant/user scope.

## Provider Routing

This pass does not change model routing.

Any future streaming implementation must preserve the live routing architecture:

- Gemini-first where configured.
- OpenAI fallback where configured.
- Anthropic emergency fallback only when enabled.
- Domain/tier/operator overrides.
- Existing cost/category tracking.

The safe invariant is: context is scoped once before provider execution, and provider fallback receives that same scoped context rather than rebuilding broader context.

## Repair Behavior

`repairStuckChatMessages(userId, tenantId)` repairs:

- old assistant `streaming` or `sent` messages -> `failed` with `STREAM_INTERRUPTED`
- old unanswered user `draft`, `sent`, or `streaming` messages -> `canceled` with `UNANSWERED_DRAFT_REPAIRED`

The helper is tenant-scoped and never repairs messages outside the resolved tenant/user scope.

## Release Gate

Streaming must not be advertised or enabled until:

- WebSocket auth parity exists.
- Tenant/user scope is enforced on connect, reconnect, and chunk read.
- Durable chunk/event persistence exists.
- Replay/resume tests pass.
- Provider fallback streaming tests pass.

