# Content Repurposing Model

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Purpose

Repurposing should be strategic, not accidental repetition.

Content Creation now distinguishes between:

- duplicate output that should be blocked or reviewed;
- related content inside a series;
- successful-pattern reuse with a new angle;
- platform adaptation;
- true repurposing with preserved provenance.

## Reuse Intents

Supported intents:

- `none`
- `repurpose`
- `adapt_platform`
- `series`
- `revisit_with_new_angle`
- `reuse_successful_pattern`

The service treats `none` as normal novelty control. The other intents allow repetition only when there is enough variation or lineage.

## Transformation Types

Supported transformation labels:

- `youtube_to_shorts`
- `book_to_thread`
- `linkedin_to_newsletter`
- `platform_adaptation`
- `series_continuation`
- `new_angle`
- `successful_pattern_variation`
- `generic_repurpose`

These labels are metadata, not hardcoded content templates. They make support, QA, and future UI explain why reuse was allowed.

## Reuse Provenance

The `content_repurpose_history` table tracks:

- original content ID;
- reused/repurposed content ID;
- original artifact type;
- reused artifact type;
- transformation type;
- source and target platforms;
- references preserved;
- references changed;
- novelty score;
- reason codes;
- lifecycle status.

This complements existing source provenance:

- `content_output_provenance.reused_from_content_id`
- `content_domain_objects.reuse_of_object_id`
- `content_domain_objects.repurpose_parent_id`

## Allowed Reuse Rules

Reuse can be allowed when at least one meaningful transformation exists:

- platform or format changed;
- angle changed;
- reference set changed;
- original content lineage is explicit;
- series relationship is explicit;
- successful pattern reuse is explicit.

Reuse is flagged as `needs_new_angle` when the user or skill requests reuse but the artifact is still too close to the original.

## Content Series Rules

Series content may be related by design.

The service allows `series_related` when:

- `reuseIntent` is `series`;
- `seriesId` is present;
- there is a different angle, transformation, or role in the series.

This prevents a series from being mislabeled as duplicate spam while still warning if it repeats the same hook or episode premise.

## Tenant Boundaries

Reuse history is scoped by:

- `tenant_id`
- `owner_user_id`
- `visibility_scope`
- `scope_status`

Content from another tenant cannot become the source of reuse, duplicate comparison, or successful-pattern learning.

## Open Items

- Route-level repurpose endpoints are not complete.
- Backfill from legacy scripts/ideas into reuse history is not complete.
- Portal and iOS do not yet expose reuse lineage or warnings.
- Generation and refinement routes need broader write-through to record reused artifacts after successful creation.
