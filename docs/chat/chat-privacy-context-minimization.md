# Chat Privacy and Context Minimization

Generated: 2026-04-29 03:30 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Goal

Chat should be useful without dumping all user, tenant, skill, calendar, finance, content, training, or cooking data into model prompts.

## Current Context Policy

The prompt context builder selects scoped items with:

- tenant ID
- user ID
- source
- freshness
- confidence
- relevance score
- priority
- permission requirements
- source attribution
- stale/expiration metadata where available

The context budget defaults to `2600` characters.

Current-turn prompt context contains only:

- message length
- intent flags
- relevant domains

It does not include raw current-turn text in the prompt context block.

## Sources

| Source | Privacy Behavior |
| --- | --- |
| Current turn | Summarized by intent flags and length only. |
| Conversation history | Included only for ambiguous follow-up, action reference, correction, memory recall, or explanation requests. |
| Shared memory | Tenant/user scoped; stale memory is low confidence. |
| Daily context | Tenant/user scoped and included only when relevant to planning/domain context. |
| Shared decision context | Non-canonical tenant IDs are refused until peer mesh readers become tenant-aware. |

## Minimization Rules

The prompt builder should:

- include only relevant domains
- prefer fresh context
- label stale/low-confidence context
- keep critical constraints even under tight budget
- ask clarification when context is missing
- avoid unrelated skill dumps
- avoid raw provider tokens, full calendars, full finance ledgers, or full content strategy dumps

## Logging Rules

Safe logging:

- tenant-safe IDs
- user ID
- provider/model/category metadata
- text length
- tool name
- input key names
- failure codes

Unsafe logging:

- raw private chat messages
- full prompt dumps
- provider tokens
- full calendar details
- finance transaction bodies
- health/training-sensitive notes
- tenant-private content strategy
- attachment text without redaction

## Open Privacy Work

- Attachment/file prompt minimization.
- Admin/support access policy and audit.
- Wider provider logs outside the Chat route/tool paths touched in this branch.
- True tenant membership and tenant-shared visibility model.

