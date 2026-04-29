# Content Creation Data Model Scope

Updated: 2026-04-29

## Scope Fields

Content-related rows now converge on these fields:

| Field | Purpose |
|---|---|
| `tenant_id` | Active tenant/workspace boundary. Defaults to `user_id` in current iOS runtime. |
| `owner_user_id` | User that owns private content. |
| `visibility_scope` | `user_private`, `tenant_shared`, `tenant_admin_visible`, `platform_internal`, `public_published`. |
| `lifecycle_state` | Content state such as pending, active, scripted, published, archived, etc. |
| `scope_status` | `active`, `quarantined`, archived/deleted-style states. |
| `created_by` / `updated_by` | Actor metadata for future support/audit workflows. |
| `audit_metadata_json` | Reserved structured metadata for admin/support workflows. |

## Tables Covered

Migration `089_content_tenant_privacy_scope.sql` covers:

- `book_library`
- `content_ref_channels`
- `content_patterns`
- `content_knowledge`
- `content_reference_links`
- `content_scripts`
- `content_performance`
- `content_learned_patterns`
- `content_radar_preferences`
- `content_topics`
- `content_topic_feedback`
- `content_pipeline`
- `saved_ideas`
- `content_notifications`
- `content_research_briefs`
- `content_search_cache`
- `content_search_results`
- `content_trending_topics`
- `video_transcripts`
- `video_studies`

Runtime helper `ensureContentTenantScopeColumns()` also repairs focused test schemas and optional local tables such as `content_ideas` if present.

## Backfill Rules

- Rows with `user_id > 0` become `tenant_id=user_id`, `owner_user_id=user_id`, `visibility_scope=user_private`, `scope_status=active`.
- Rows with `user_id=0` become `tenant_id=0`, `owner_user_id=0`, `visibility_scope=platform_internal`, `scope_status=quarantined`.
- Quarantined rows are not returned by normal user reference retrieval or prompt context assembly.
- New system/platform references must be explicit curated rows: `tenant_id=0`, `owner_user_id=0`, `visibility_scope=platform_internal` or `public_published`, and `scope_status=active`.

## Prompt Context Boundary

`buildAuthorizedContentReferenceContext(userId, tenantId)` is the prompt-facing read path for books, links, and channels.

It returns only rows allowed by:

```text
scope_status = active
AND (
  visibility_scope = user_private AND tenant_id = active tenant AND owner_user_id = user
  OR visibility_scope IN (tenant_shared, public_published) AND tenant_id = active tenant
)
```

System reference jobs use a narrower platform predicate for curated baseline rows only:

```text
scope_status = active
AND visibility_scope IN (platform_internal, public_published)
AND tenant_id = 0
AND owner_user_id = 0
```

Those rows may inform system-level channel knowledge synthesis. They are separate from tenant/user references and do not authorize cross-tenant reference use.

## Compatibility

The data model is additive. Existing `user_id` and `owner_scope` semantics remain readable, but prompt-facing and API-facing paths prefer explicit tenant/scope metadata.
