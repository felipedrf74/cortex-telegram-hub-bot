# Chat Tenant Controls

Date: 2026-04-29

## Current State

Tenant controls for Chat are not yet a complete portal product surface. The backend Chat workstream now has explicit tenant/user/lifecycle scope on messages and conversation state, and the portal has safe diagnostics, but tenant admins do not yet have a dedicated policy UI for Chat retention, sharing, memory, or support visibility.

## Required Tenant Policies

| Policy | Recommended default | Notes |
| --- | --- | --- |
| Chat enabled | Enabled for active users | Should be configurable per tenant only after tenant membership model is stable. |
| Conversation retention | Product default retention | Needs legal/privacy review before tenant override. |
| User deletion/export | User-owned export/delete | Existing user data export should include Chat tables by tenant scope. |
| Admin raw-content visibility | Disabled | Must require explicit tenant policy plus audit. |
| Support raw-content visibility | Disabled | Prefer metadata-only diagnostics. |
| Memory retention | Conservative user-private retention | Tenant-shared memory requires explicit scope. |
| Tool permissions | Skill-owned and permission-checked | Chat must not bypass skill ownership. |
| Conversation sharing | Disabled unless explicitly designed | Avoid accidental tenant-wide private chat exposure. |
| Provider/model observability | Aggregate only | Provider/model/tier/category/cost/latency are okay; prompts are not. |
| Audit logs | Enabled for admin/support access | Required for future raw review workflows. |

## What The Portal May Show Today

- Aggregate Chat health.
- Tenant-level counts.
- User-scoped message lifecycle diagnostics when operator is scoped to that user.
- Provider/model/category usage aggregates.
- Error codes and lifecycle states.

## What The Portal Must Not Show Today

- Private message text.
- Raw prompts or hidden context.
- Retrieved context bodies.
- File or attachment contents.
- Tool outputs.
- Memory values.
- Conversation summaries.
- Cross-tenant message rows.

## Future UI Controls

Recommended tenant settings:

- Chat enable/disable.
- Memory enable/disable.
- Memory retention duration.
- Conversation retention duration.
- User export/delete policy.
- Skill/tool permissions available to Chat.
- Admin raw-content visibility policy.
- Support access policy.
- Audit log retention.

## Data Model Requirements

Before portal tenant controls become editable, every Chat-related table should have:

- tenant ID
- user/owner ID where applicable
- visibility scope
- lifecycle/scope status
- created by
- indexed tenant/user access pattern
- quarantine behavior for ambiguous legacy rows

The active Chat branch already covers the core message/conversation/shared-memory path, but attachment, embedding/vector, and future conversation-list tables must follow the same standard.
