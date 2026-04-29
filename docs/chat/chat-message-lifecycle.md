# Chat Message Lifecycle

Generated: 2026-04-29 03:16 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`  
Commit base: `a3f1b78`

## Purpose

Chat messages now carry explicit lifecycle metadata so Nexus can reason about retries, interruptions, cancellation, repair, and idempotent iOS/client reconnects without duplicating user-visible actions.

This is a backend lifecycle foundation. It does not enable WebSocket streaming, and it does not change live model-provider routing.

## Schema

Migration `085_chat_message_lifecycle.sql` adds additive columns to `messages`:

- `lifecycle_state`
- `client_message_id`
- `request_id`
- `retry_of_message_uuid`
- `completed_at`
- `failed_at`
- `canceled_at`
- `error_code`
- `error_message`

It also adds additive columns to `conversations`:

- `conversation_state`
- `archived_at`
- `deleted_at`
- `errored_at`

The migration is additive-only. Older code can ignore these columns. Staging-clone migration rehearsal passed on 2026-04-29; production release still requires the normal predeploy production DB snapshot.

## Message States

Supported message lifecycle states:

- `draft`: local/pre-send state when a client has not committed the message.
- `sent`: user message has been accepted by the backend.
- `streaming`: assistant response is in progress or only partially persisted.
- `completed`: assistant response completed and is safe to replay for idempotent retry.
- `failed`: backend/provider/tool path failed and should be visible as failed state.
- `canceled`: user request was canceled or repaired as abandoned.
- `retried`: a previously failed/canceled user request was reclaimed for a retry.
- `edited`: message was edited after initial persistence where supported.
- `deleted`: soft-deleted message; hidden from active history.

Current REST `/api/v1/chat/message` behavior:

- User messages with a `clientMessageId` or `idempotencyKey` are claimed before skill/model execution.
- Completed assistant messages are replayed on retry.
- In-flight duplicate client IDs return `202` with `routeMethod=idempotency-in-progress` instead of executing a skill twice.
- Reusing a client ID with different message text returns `409 CHAT_IDEMPOTENCY_CONFLICT`.

## Conversation States

Supported conversation lifecycle states:

- `active`
- `archived`
- `deleted`
- `errored`
- `tenant_migrated`
- `quarantined`

Active history reads exclude non-active conversation rows when the lifecycle columns exist.

## Tenant Safety

All lifecycle writes and reads are scoped by:

- `tenant_id`
- `user_id`
- `scope_status='active'`

The lifecycle helpers call `resolveChatTenantScope` before persistence, replay, mutation, repair, or history reads. Frontend filtering is not relied on for lifecycle isolation.

## Idempotency Contract

Clients may send either:

- `clientMessageId`
- `idempotencyKey`
- `x-client-message-id`
- `x-idempotency-key`

The backend normalizes the value to a bounded safe ID and uses it to derive a stable user message ID:

```text
msg-user-${normalizedClientMessageId}
```

Replay behavior:

- Same tenant/user/client ID plus same text and completed assistant response: return existing assistant response.
- Same tenant/user/client ID plus same text but no completed assistant response: return in-progress response, do not invoke route/skill again.
- Same tenant/user/client ID plus different text: reject with `409 CHAT_IDEMPOTENCY_CONFLICT`.
- Failed/canceled user claim with same text can be reclaimed as `retried`.

## Current Limits

- True provider streaming persistence remains gated; WebSocket streaming must stay disabled until it has auth/tenant parity and lifecycle tests.
- Durable tool-call lifecycle records are not yet stored in a dedicated `chat_tool_invocations` table.
- Attachment idempotency currently keys on the client message ID and text; attachment binary/content identity is not hashed in this pass.
- Migration `084` passed disposable staging-clone rehearsal; production still needs a fresh predeploy DB snapshot.
