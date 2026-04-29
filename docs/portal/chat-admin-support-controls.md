# Chat Admin And Support Controls

Date: 2026-04-29

## Policy

Chat support tooling must default to metadata-only diagnostics. Raw user messages, prompts, retrieved context, attachments, tool outputs, and memory values are private data.

Raw content access should exist only after all of these are true:

- a role explicitly allows it
- tenant policy allows it
- the user or tenant support workflow requires it
- access is audited
- access reason is recorded
- response payload is redacted where possible

## Current Controls

| Control | Current status |
| --- | --- |
| Admin authentication | `requirePortalAdminToken` |
| Operator target-user scoping | `requireOperatorTargetUser('userId')` |
| Admin mutation audit | Existing `logPortalAdminMutation` pattern |
| Read/write credential split | Existing scoped portal token support |
| Static-token hardening | Existing portal beta exposure checks |
| Chat diagnostics privacy mode | New `metadata_only` response contract |

## New Diagnostics Routes

### `GET /api/chat/diagnostics`

Admin-only aggregate view.

Safe fields:

- totals
- by-tenant counts
- lifecycle counts
- domain counts
- route-method counts
- provider/model/category usage aggregates

Unsafe fields intentionally omitted:

- message text
- prompt text
- raw metadata
- attachments
- tool outputs
- memory values

### `GET /api/users/:userId/chat-diagnostics`

Admin-only and operator-scoped to the target user.

Safe recent-message fields:

- message ID
- tenant ID
- user ID
- role
- domain
- route method
- lifecycle state
- error code
- text length
- has buttons
- has metadata
- metadata type
- source skill IDs
- tool-call count
- confirmation/clarification flags
- created timestamp

## Support Workflow

1. Inspect aggregate diagnostics for volume or provider spikes.
2. Inspect user-specific diagnostics only when the operator is scoped to that user.
3. Use message ID/error code/provider metadata to correlate with logs.
4. Do not request or expose raw message content unless a future audited raw-content workflow exists.
5. If semantic quality must be reviewed, use simulation/evaluation transcripts or user-provided excerpts.

## Required Future Controls Before Raw Review

- `chat_content_review` permission.
- Tenant-level admin visibility policy.
- User-consent or support-case reference.
- Audit row with actor, reason, tenant, user, conversation/message IDs.
- Redaction pipeline for finance, health/training-adjacent, calendar, provider token, and tenant-private content.
- Expiring support session.

## Test Coverage

Added tests verify:

- diagnostics routes are admin-protected
- user diagnostics use operator target-user guard
- aggregate diagnostics return metadata-only payloads
- user diagnostics do not expose raw text or raw metadata
- diagnostics degrade safely when tables are unavailable
