# Chat Tool Call Lifecycle

Generated: 2026-04-29 03:16 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Purpose

Tool and skill calls are the highest-risk part of Chat because retries can mutate external state: tasks, calendar events, reminders, shared memory, emails, training plans, finance records, cooking data, and other skill-owned objects.

This pass improves the guardrail around tool execution but does not yet add a durable tool-invocation table.

## Runtime Lifecycle

The runtime lifecycle is:

1. `requested`: model/domain path proposes a tool call.
2. `authorized`: server validates authenticated user and active tenant.
3. `confirmation_required`: destructive/external-send action is blocked unless the current turn explicitly confirms it.
4. `executing`: tool executor runs inside the chat authorization context.
5. `succeeded`: tool returns success result.
6. `failed`: tool returns structured failure or throws into the chat degraded path.
7. `canceled`: future state for user cancel or timeout.
8. `retried`: future state for idempotent retry of a failed/canceled tool call.

## Implemented Guardrails

Implemented before this lifecycle pass and validated again as part of the branch:

- `runWithChatToolAuthorization` carries `userId`, `tenantId`, and confirmation state with `AsyncLocalStorage`.
- `authorizeChatToolCall` blocks tool calls when the authenticated user or tenant scope does not match.
- Destructive and external-send tools require explicit current-turn confirmation.
- Chat route preflight pauses destructive actions before model/domain execution.
- Tool executor logs tool names and input keys, not raw sensitive user prompt text.

Implemented in this lifecycle pass:

- User message claims prevent duplicate route/skill execution on client retry before completion.
- Completed assistant replay prevents duplicate skill/tool invocation after a successful response.
- Failed/canceled user message claims can be retried without creating a second user row.

## Current Gaps

P1 before broad production Chat tool expansion:

- No durable `chat_tool_invocations` table yet.
- No per-tool idempotency key persisted at the tool boundary.
- No durable pending-confirmation record for ergonomic “yes, do it” follow-ups.
- No persisted tool result attachment to an assistant message beyond existing message metadata.
- Provider tool loops still rely on current domain execution flow rather than an explicit lifecycle state machine.

## Required Durable Model

A future durable tool-invocation record should include:

- `tool_invocation_id`
- `tenant_id`
- `user_id`
- `conversation_id` or domain/session key
- `message_uuid`
- `client_message_id`
- `tool_name`
- `source_skill`
- `risk`
- `state`
- `idempotency_key`
- `requires_confirmation`
- `confirmation_source`
- `started_at`
- `completed_at`
- `failed_at`
- `canceled_at`
- `result_ref`
- `error_code`
- `error_message`

## Acceptance Status

This branch prevents the most likely duplicate action path at the Chat route layer. It does not yet claim full durable tool lifecycle completeness.

