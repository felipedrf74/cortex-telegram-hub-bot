# Content Object Model

Updated: 2026-04-29

## Model Summary

Content objects now have a typed model that can represent planning, generation, review, scheduling, publishing, and repurposing.

The baseline fields for ontology-aware objects are:

| Field | Purpose |
|---|---|
| `tenant_id` | Tenant/workspace boundary. |
| `owner_user_id` | Private owner when scope is user-private. |
| `visibility_scope` | `user_private`, `tenant_shared`, `tenant_admin_visible`, `platform_internal`, or `public_published`. |
| `scope_status` | `active`, `quarantined`, `archived`, or deleted-style states. |
| `object_type` | Typed content object such as `script`, `hook`, `campaign`, or `reference`. |
| `lifecycle_state` | Workflow state such as `drafting`, `reviewing`, `published`, or `repurposed`. |
| `platform_id` | Platform target such as `youtube`, `linkedin`, or `newsletter`. |
| `format_id` | Format target such as `youtube_long_form` or `x_thread`. |
| `pillar_id` | Strategy pillar linkage. |
| `audience_segment_id` | Audience linkage. |
| `campaign_id` | Campaign linkage. |
| `series_id` | Series linkage. |
| `source_ids_json` | Sources that influenced the object. |
| `claims_json` | Claims made by the output. |
| `evidence_json` | Evidence backing claims. |
| `production_requirements_json` | Format-specific production asks. |
| `reuse_of_object_id` | Prior output being reused. |
| `repurpose_parent_id` | Parent output in a repurposing chain. |
| `ontology_metadata_json` | Typed object/format-specific metadata. |
| `ontology_schema_version` | Schema compatibility marker. |

## Existing Table Integration

Migration `090_content_domain_ontology.sql` adds ontology metadata columns to:

- `content_topics`
- `content_scripts`
- `content_pipeline`
- `saved_ideas`
- `content_topic_feedback`
- `book_library`
- `content_reference_links`
- `content_ref_channels`

These are additive columns. Existing read/write paths keep working.

## New Strategy Tables

`content_pillars`

- Stores topic lanes and strategic promises.
- Used to prevent random idea generation and support novelty/reuse checks.

`content_audience_segments`

- Stores audience needs, objections, and desired outcomes.
- Used to shape hooks, examples, and calls to action.

`content_campaigns`

- Stores time-bound or goal-bound editorial sequences.
- Used for cadence, platform priority, and release planning.

`content_series`

- Stores recurring editorial containers.
- Used for continuity, format consistency, and expectation setting.

`content_domain_objects`

- Generic ontology-backed object ledger for future features that need typed Content state without overloading older tables.

`content_source_output_links`

- Records which source influenced which output and why.
- Supports source attribution, duplicate/reuse checks, evidence review, and quality analysis.

## Required Metadata Examples

`script`

- `contentGoal`
- `voiceProfileId`
- `productionIntent`
- Format-specific fields such as `viewerPromise` and `thumbnailAngle` for YouTube long-form.

`hook`

- `targetEmotion`
- `promise`

`reference`

- `sourceType`
- `trustLevel`
- `extractionStatus`

`content_calendar_item`

- `scheduledWindow`
- `contentGoal`

## Do Not Break

- Do not replace existing `content_topics.status` behavior until iOS contracts are updated.
- Do not use ontology metadata to bypass tenant scope checks.
- Do not let custom formats enter generation without typed format definitions.
- Do not treat source IDs as authorized until scope and extraction metadata have been validated.
