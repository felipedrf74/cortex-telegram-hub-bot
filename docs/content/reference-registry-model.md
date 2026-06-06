# Content Reference Registry Model

Updated: 2026-04-29

## Registry Table

`content_reference_registry` is the normalized source registry for Content Creation.

Core fields:

| Field | Purpose |
|---|---|
| `tenant_id` | Tenant/workspace boundary. |
| `owner_user_id` | Private owner when scope is user-private. |
| `visibility_scope` | Visibility policy. |
| `scope_status` | Active/quarantined/deleted-style state. |
| `reference_type` | `book`, `link`, `channel`, `note`, `previous_content`, `radar_signal`, `external_research_result`, or `user_uploaded_source`. |
| `source_table` / `source_pk` | Optional pointer to existing source table. |
| `source_identifier` | Stable source identifier such as URL, book key, or previous content ID. |
| `title` | User/debug-visible title. |
| `url` | Optional URL. |
| `author_source` | Author, channel, publisher, or source label. |
| `extraction_status` | `pending`, `extracting`, `indexed`, `ready`, `failed`, `stale`, or `quarantined`. |
| `freshness_score` | 0-1 freshness score. |
| `trust_level` | `unverified`, `observed`, `curated`, `first_party`, `published`, or `deprecated`. |
| `quality_score` | 0-1 quality score. |
| `confidence_score` | 0-1 confidence score. |
| `topic_tags_json` | Retrieval and novelty tags. |
| `related_output_ids_json` | Outputs that used this reference. |
| `last_used_at` | Last usage timestamp. |
| `broken_status` | `ok`, `unknown`, or `broken`. |
| `stale_status` | `fresh`, `unknown`, or `stale`. |
| `source_summary` | Safe summary for prompt/evaluation use. |
| `source_snippets_json` | Short source snippets/summaries, not arbitrary full raw text. |
| `source_metadata_json` | Source-specific metadata. |

## Existing Reference Tables

The migration also adds source-health fields to:

- `book_library`
- `content_reference_links`
- `content_ref_channels`

This lets current reference flows become safer without forcing an immediate data migration into the normalized registry.

## Retrieval Rules

`retrieveAuthorizedContentReferences()`:

- filters by active tenant/user scope before returning data
- optionally filters by reference type
- optionally searches title, source summary, and topic tags
- ranks by extraction readiness, source health, confidence, quality, freshness, and last-used time
- deduplicates by reference ID
- excludes unusable references

Unusable references include:

- failed or quarantined extraction
- broken sources
- stale sources
- deprecated sources
- too-low confidence or quality

## Trust Semantics

- `curated`: intentionally selected by user/operator.
- `first_party`: user-uploaded or user-authored source.
- `published`: prior published content.
- `observed`: extracted from reference channels or analytics.
- `unverified`: available but review-required.
- `deprecated`: should not be used for new content.
