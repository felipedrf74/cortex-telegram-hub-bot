# Chat Tool Call Authorization

Status: implemented for Chat-domain tool calls on `feature/chat-tenant-safe-context-orchestration`

Tool authorization is enforced outside the model. Prompt instructions are not treated as a security boundary.

## Runtime Guard

Chat domain execution is wrapped in `runWithChatToolAuthorization`.

The guard records:

- authenticated user ID
- active tenant ID
- whether the current turn explicitly confirmed a destructive action
- confirmation source

`executeToolCall` calls `authorizeChatToolCall` before dispatching to providers or skill services.

## Enforced Checks

- Tool user must match the authenticated Chat request user.
- Tool tenant must match the active Chat request tenant.
- Destructive or external-send tools require explicit current-turn confirmation.
- Unauthorized tool calls return structured errors and do not call the downstream provider/service.

## Confirmation-Gated Tools

Examples:

- `delete_calendar_event`
- `ms_todo_delete_task`
- `ms_todo_delete_list`
- `send_outlook_email`
- `reply_outlook_email`
- `finance_delete_transaction`
- `finance_mark_tax_paid`
- `cooking_delete_recipe`
- `cooking_delete_meal`
- `shared_memory_remove`

## Route-Level Safety

If the user asks for a destructive action without explicit confirmation, `/api/v1/chat/message` returns a confirmation-required response before calling the router/domain handler.

This prevents accidental model execution for prompts such as:

- “Cancel my training plan and clear the calendar.”
- “Delete that task.”
- “Send this email.”

## Remaining Risks

- Confirmation is current-turn text based. A richer pending-confirmation state machine would make follow-up confirmations more ergonomic.
- WebSocket Chat remains disabled or must receive equivalent auth/tenant/confirmation guards before enabling.
