# Content Creation Domain Ontology

Updated: 2026-04-29

## Purpose

Content Creation now has a structured ontology foundation instead of treating every output as a generic prompt string. The ontology defines typed content objects, platform-aware formats, reference/source metadata, lifecycle states, strategy entities, and source-to-output lineage.

The implementation lives in:

- `src/services/content-domain-ontology.ts`
- `migrations/090_content_domain_ontology.sql`

This is not intended to be a closed taxonomy. The code ships a baseline model plus typed extension hooks for tenant-defined formats and future object schemas.

## Core Object Families

The baseline object types are:

- `idea`
- `topic`
- `hook`
- `outline`
- `script`
- `caption`
- `carousel`
- `thread`
- `newsletter`
- `blog`
- `video_concept`
- `radar_signal`
- `reference`
- `content_calendar_item`
- `campaign`
- `content_series`
- `content_pillar`
- `audience_segment`

Each object type defines:

- Purpose
- Allowed lifecycle states
- Required fields
- Required metadata
- Whether platform/format metadata applies
- Whether source attribution applies
- Whether reuse/repurposing lineage applies

## Lifecycle

The shared lifecycle vocabulary is:

- `captured`
- `triaged`
- `planned`
- `researching`
- `outlining`
- `drafting`
- `reviewing`
- `approved`
- `scheduled`
- `published`
- `repurposed`
- `archived`
- `rejected`
- `cancelled`

This lifecycle is broader than the current `content_topics.status` enum. Existing flows keep their current states, while new ontology metadata can map current states into richer workflow semantics.

## Strategy Concepts

The ontology explicitly models:

- Content pillars
- Audience segments
- Campaigns
- Content series
- Brand/voice attributes
- Preferred/disliked formats
- Platform priorities
- Prohibited topics
- Cadence and campaign goals

New persistence tables:

- `content_pillars`
- `content_audience_segments`
- `content_campaigns`
- `content_series`
- `content_domain_objects`
- `content_source_output_links`

## Source And Evidence Model

Reference types:

- `book`
- `link`
- `channel`
- `note`
- `previous_content`
- `radar_signal`
- `external_research_result`
- `user_uploaded_source`

Reference metadata includes:

- Tenant/user scope
- Visibility scope
- Freshness
- Confidence
- Trust level
- Extraction status
- Topic tags
- Used-by output IDs
- Source-specific metadata

Generation-facing validators require source metadata before a reference can be considered complete. This helps prevent hallucinated references, cross-tenant source mixing, and unsupported claims.

## Validation

The service exposes validators for:

- Platform format definitions
- Reference metadata
- Content domain objects
- Generation readiness
- Source-to-output links

Generation readiness is stricter than object validity. For generation-capable objects, it requires:

- Tenant/user scope
- Format metadata
- Content goal
- Content pillar linkage
- Audience segment linkage
- Object-specific metadata
- Format-specific metadata

Source references are recommended for grounded generation and validated when supplied.

## Release Gate

Verdict: PASS WITH CONDITIONS

Implemented and tested:

- Typed ontology model
- Platform-aware format model
- Reference/source metadata model
- Strategy persistence tables
- Source-output linkage table
- Schema/metadata validation tests
- Migration replay
- Typecheck

Open:

- Existing generation routes do not yet persist ontology metadata for every output.
- Portal/iOS editing surfaces for pillars, campaigns, audience segments, and source linkage are not implemented yet.
- Tenant-specific custom format definitions are supported in code but not yet backed by an admin UI or persistence table.
