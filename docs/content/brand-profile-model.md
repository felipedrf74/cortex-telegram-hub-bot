# Brand Profile Model

Updated: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Purpose

The Content brand profile separates tenant-shared brand memory from user-private creator preferences. This prevents one user's private writing style from silently influencing tenant-visible content while still allowing tenant brands to have durable shared rules.

## Brand Memory Fields

Supported brand/profile keys:

- `brand.rules`
- `brand.audience`
- `brand.content_pillars`
- `brand.topics_to_avoid`
- `brand.preferred_formats`
- `brand.disliked_formats`
- `brand.positioning`
- `brand.recurring_themes`
- `source.reference_preferences`
- `source.trust_preferences`

## Performance-Informed Memory

Performance learning can store:

- `performance.successful_topics`
- `performance.weak_topics`
- `performance.successful_hooks`
- `performance.successful_formats`
- `pattern.rejected_content_patterns`
- `performance.audience_response_signals`

These memories can influence suggestion scoring without becoming hardcoded templates. Suggestions matching successful topics, formats, or hook patterns receive reason-coded boosts. Suggestions matching avoided topics, disliked formats, or rejected patterns are filtered out.

## Scope Defaults

| Profile Type | Default Scope | Rationale |
| --- | --- | --- |
| Voice profile | `user_private` | Personal writing preferences can be sensitive. |
| Brand profile | `tenant_shared` | Brand rules and pillars are normally shared tenant context. |
| Performance memory | `tenant_shared` | Performance patterns usually belong to the brand/content operation. |
| Corrections | `user_private` by default | Direct user corrections should not become tenant policy unless explicitly promoted. |

## Quality Diagnostics

`buildContentCreativeProfileContext()` returns:

- completeness score
- confidence score
- stale memory count
- missing critical keys
- follow-up questions
- applied memory keys
- omitted private memory keys

Critical keys for profile completeness:

- `voice.tone`
- `brand.audience`
- `brand.content_pillars`

Missing critical data triggers targeted follow-up questions instead of silent risky assumptions.
