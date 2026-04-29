# Chat Portal Readiness

Date: 2026-04-29

## Verdict

Status: partially ready.

The portal now has a privacy-safe Chat diagnostics foundation, but it does not yet expose a user-facing Chat history console, a reviewed tenant policy editor, or raw-content support review workflow. That is intentional: raw Chat content is sensitive and must not be made casually visible to admins.

## Existing Surfaces

- Portal auth uses scoped bearer/session credentials through `requirePortalTokenByMethod`.
- Admin mutations use `requirePortalAdminToken`.
- Target-user admin actions use `requireOperatorTargetUser('userId')`.
- Admin mutations are audited through `logPortalAdminMutation`.
- Provider/model observability already exists through provider routes.
- Chat usage is represented in `api_usage` when model/provider calls happen.
- Chat messages now carry tenant/user/lifecycle fields through the Chat tenant-scope workstream.

## New Surface

Added:

- `GET /api/chat/diagnostics`
- `GET /api/users/:userId/chat-diagnostics`

Both routes require `requirePortalAdminToken`. The user-specific route also requires `requireOperatorTargetUser('userId')`.

The response is `privacyMode: metadata_only` and intentionally excludes:

- raw message text
- raw prompts
- raw metadata JSON
- tool outputs
- attachments
- retrieved context bodies
- memory values
- provider request/response bodies

It may expose:

- tenant ID
- user ID for user-scoped diagnostics
- message ID
- lifecycle state
- domain
- route method
- error code
- text length
- metadata type
- source skill IDs
- tool-call count
- aggregate provider/model/category usage
- latency/cost/token aggregates

## User Console Chat

Not implemented in this pass.

Readiness requirements before adding it:

- Backend conversation-list contract must be tenant-safe.
- User must see only own private conversations or explicitly shared tenant conversations.
- Archive/delete actions need idempotent backend lifecycle states.
- Pending confirmations and unresolved actions need a stable callback contract.

## Admin Console Chat Oversight

Ready for aggregate diagnostics only.

Admins can use metadata-only diagnostics to inspect:

- failed Chat messages
- stuck streaming/sent states
- pending confirmation volume
- clarification prompt rate
- domain routing distribution
- route-method distribution
- provider/model/category usage
- tenant-level aggregate volume

Admins must not see raw private content without a future explicit permission model, tenant policy, and audit trail.

## Support Diagnostics

Current support-safe shape:

- conversation/message identifiers
- tenant/user identifiers
- status/lifecycle
- domain/route method
- error code
- provider/model/category aggregates
- text length only
- metadata type and safe structural counts

This is sufficient to debug many production issues without exposing user content.

## Risks

| Risk | Status | Mitigation |
| --- | --- | --- |
| Admin raw-content overexposure | Controlled | No raw-content route was added. |
| Cross-tenant leakage | Controlled | User-specific route uses operator target-user guard; aggregate route returns counts only. |
| Prompt/provider leakage | Controlled | Provider route returns provider/model/category/cost/latency aggregates only. |
| Metadata leakage | Controlled | Diagnostics parse metadata locally but expose only type/count/source skill IDs. |
| Support inability to debug semantic failures | Open | Needs explicit raw-content access policy or user-granted support session. |

## Release Interpretation

The portal is safe enough for aggregate Chat health diagnostics. It is not yet a full Chat support console or user Chat history UI.
