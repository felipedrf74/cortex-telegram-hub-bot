# Content Creation Tenant Security Model

Updated: 2026-04-29

## Release Gate Summary

Verdict: PASS WITH CONDITIONS

The Content Creation skill now has an explicit tenant/privacy scope foundation for references, scripts, radar preferences, Voice DNA, learned patterns, performance feedback, research artifacts, and prompt-context assembly. The implementation is additive and keeps the current Nexus runtime tenant model intact: `tenant_id` defaults to the authenticated `user_id` where an explicit tenant is not supplied.

This pass does not claim a complete enterprise multi-member tenant permission model. Tenant-admin visibility, support access workflows, and portal policy UX remain open until Nexus has a broader tenant membership/role model beyond current founder/user-scoped iOS runtime semantics.

## Threat Model

Protected data:
- Books, links, channels, source references, and extracted content patterns.
- Voice DNA, brand profile, creator memory, learned patterns, rejected ideas, and script history.
- Drafts, outlines, scripts, captions, hooks, content calendar items, radar preferences, and performance feedback.
- Model prompt context, source retrieval cache, and Content skill invocations from Chat/iOS/portal surfaces.

Primary P0 threats:
- Tenant A references powering Tenant B generation.
- Tenant A Voice DNA or learned style influencing Tenant B scripts.
- User-private drafts exposed through tenant/admin or portal views without explicit permission.
- Ambiguous legacy `user_id=0` rows being treated as shared creator knowledge.
- Prompt builders receiving unauthorized books/channels/links/Voice DNA.

## Implemented Controls

- Added migration `089_content_tenant_privacy_scope.sql`.
- Added explicit scope fields: `tenant_id`, `owner_user_id`, `visibility_scope`, `lifecycle_state`, `scope_status`, `created_by`, `updated_by`, `audit_metadata_json`.
- Added `content_reference_links` for tenant-scoped link references.
- Added `src/services/content-tenant-scope.ts` with shared predicates and insert metadata.
- Added `src/services/content-reference-context.ts` for authorized generation references.
- Existing user-owned rows backfill as `user_private` and `active`.
- Legacy/ambiguous `user_id=0` content rows backfill as `platform_internal` and `quarantined`, so they are not used in normal user prompt context.
- Content book/channel/Voice DNA API routes now enforce backend scope before listing, creating, deleting, or updating.
- Content script prompt assembly now adds only authorized reference context.
- Content radar preferences, recent scripts, performance, learned patterns, topic feedback, and artifact-chain access now use explicit scope predicates.
- Reaction Radar no longer scans user-private reference channels in its global path.

## Authorization Rules

Default authenticated user access:
- `user_private`: visible only when `tenant_id` matches the active tenant and `owner_user_id` matches the authenticated user.
- `tenant_shared`: visible only inside the active tenant.
- `public_published`: visible only inside the active tenant unless later promoted to a true public distribution model.
- `tenant_admin_visible`: reserved for future tenant role-aware admin surfaces.
- `platform_internal`: reserved for curated platform-owned reference baselines. Legacy `user_id=0` rows are quarantined by default; only explicit `scope_status=active`, `tenant_id=0`, `owner_user_id=0` rows can be consumed by system reference jobs.

Prompt construction:
- Prompt context is built after backend scope checks.
- Unauthorized references are excluded before provider routing.
- `buildAuthorizedContentReferenceContext()` does not expose platform-internal rows as user/tenant references. Channel learner synthesis may blend explicit active platform baselines with user-owned channel patterns, but it never scans another tenant's private references.
- Live model routing remains unchanged; scoped context is assembled before any provider call.

## Current Limits

- True same-user multi-tenant switching is still limited by the broader auth model.
- Tenant admin/support visibility is documented but not fully implemented as a permissioned/audited portal workflow.
- Existing global reaction radar signals may still need a broader tenant-aware redesign before tenant-shared creative radar is complete.
- Content vector/embedding storage was not found as a first-class Content table in this pass; namespace rules are documented in open items for any future vector backend.
