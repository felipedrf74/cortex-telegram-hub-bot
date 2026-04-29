# Chat Tenant Data Model

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Summary

Chat now treats tenant scope as a backend data boundary, not a UI filter. The current Nexus canonical tenant is still `users.id`, so authenticated iOS requests resolve `tenantId = userId` until a true workspace membership model exists. The data model is explicit anyway so future tenant switching cannot accidentally reuse user-only storage.

## Scope States

| Field | Meaning |
| --- | --- |
| `tenant_id` | Tenant/workspace boundary. Current canonical value is the authenticated `users.id`. |
| `user_id` | Owning user for user-private Chat data. |
| `visibility_scope` | One of `user_private`, `tenant_shared`, `tenant_admin_visible`, `platform_admin_visible`, `system_internal`. Runtime writes currently use `user_private`. |
| `scope_status` | `active` rows are available to Chat. `quarantined` rows are never returned by Chat accessors. |
| `created_by` | User that created the row when known. Ambiguous legacy rows keep this null. |

## Objects Covered

| Object | Runtime status |
| --- | --- |
| `messages` | Tenant/user scoped with active/quarantined filtering. |
| `conversations` | Tenant/user/domain scoped with active filtering and tenant-aware pruning. |
| `shared_memory` | Tenant/user/key scoped with active filtering and scoped upsert. |
| `daily_context_cache` | Rebuilt as `(tenant_id, user_id, date)` primary key. |
| `audit_trail` | Adds `tenant_id`; new audit writes set `tenant_id = user_id` unless a caller provides a tenant. |
| `api_usage` | Adds `tenant_id` for release backfill; Gemini/OpenAI/Anthropic domain calls can now persist tenant metadata when callers pass `CallDomainOptions`. Streaming and some off-domain one-shot paths still need a wider audit. |
| attachments/files | No durable Chat attachment table found; runtime image attachments are request-local. Durable attachment storage must use the same scope fields before launch. |
| tool calls/skill calls/retrieval/vector records | No durable Chat-specific table found. If added, they must include `tenant_id`, `user_id`, source skill, and active/quarantined state. |

## Runtime Scope Helper

`src/services/chat-tenant-scope.ts` centralizes Chat scope resolution. Invalid or missing user scope records a tenant-scope anomaly and refuses access. This prevents legacy `user_id = 0` or `tenant_id = 0` data from being exposed as active Chat context.

## Remaining Model Limit

This is tenant-safe for the current one-canonical-tenant-per-user architecture. It is not a complete workspace membership system. Before true tenant switching, add explicit tenant membership, active-tenant selection, role checks, and tests that prove one user can switch tenants without carrying conversation or memory across them.
