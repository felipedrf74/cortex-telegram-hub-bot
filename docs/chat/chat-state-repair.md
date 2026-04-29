# Chat State Repair

Generated: 2026-04-29 03:16 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Purpose

Chat state repair turns broken intermediate states into explicit backend truth rather than leaving the app to guess.

The first implementation focuses on message-level repair and tenant-safe conversation filtering.

## Implemented Repair Helpers

### `markMessageLifecycle`

Marks a single message as:

- `completed`
- `failed`
- `canceled`
- any other supported lifecycle state

It is scoped by tenant/user and refuses to mutate outside the resolved tenant scope.

### `repairStuckChatMessages`

Repairs stuck message state for one user/tenant:

- Assistant `streaming` or `sent` older than the repair cutoff becomes `failed`.
- Unanswered user `draft`, `sent`, or `streaming` older than the repair cutoff becomes `canceled`.

Default cutoff: 5 minutes.

Default error codes:

- `STREAM_INTERRUPTED`
- `UNANSWERED_DRAFT_REPAIRED`

### `markConversationLifecycle`

Marks a domain conversation as:

- `active`
- `archived`
- `deleted`
- `errored`
- `tenant_migrated`
- `quarantined`

Active history reads only return active conversation rows when migration `084` exists.

## Repair Cases Covered

- Message stuck streaming.
- User message accepted without assistant response after repair window.
- Soft-deleted messages excluded from active history.
- Archived/deleted/errored conversation rows excluded from active continuity.
- Tenant mismatch prevents repair.
- Retry after repaired `failed`/`canceled` user message reclaims the same message row as `retried`.

## Repair Cases Not Yet Covered

- Durable provider chunk reconstruction.
- Durable tool call stuck-pending repair.
- Conversation summary rebuild after correction.
- Pending confirmation recovery after reconnect.
- Duplicate assistant message compaction.
- Attachment upload repair.
- Streaming reconnect resume.

## Operational Guidance

Until a scheduled repair worker exists, repair helpers should be called by a controlled job or maintenance path after migration `084` is proven.

Do not run global repair without tenant/user filters. The current helpers intentionally require user and tenant scope.

## Production Gate

Before production:

- Rehearse migration `085`.
- Add a bounded worker or explicit runbook for stuck message repair.
- Keep WebSocket streaming disabled unless the streaming lifecycle is fully implemented and tested.

