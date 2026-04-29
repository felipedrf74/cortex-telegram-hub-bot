# Content Radar Engine

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Purpose

Content Radar is the Content Creation opportunity layer. It is not a generic trend list and does not invent external trend data. It normalizes tenant-safe signals from references, skills, performance, and manual input into scored opportunities that can become ideas, outlines, scripts, or calendar items.

## Implementation

- Migration: `migrations/093_content_radar_opportunity_engine.sql`
- Service: `src/services/content-radar-engine.ts`
- Tests: `__tests__/services/content-radar-engine.test.ts`

The canonical ledger is `content_radar_signals`.

Core fields:

- `signal_id`
- `tenant_id`
- `owner_user_id`
- `visibility_scope`
- `source_type`
- `source_reference_id`
- `source_skill`
- `source_signal_type`
- `topic`
- `freshness_score`
- `confidence_score`
- `relevance_score`
- `novelty_score`
- `audience_fit_score`
- `brand_fit_score`
- `platform_fit_score`
- `source_quality_score`
- `cross_skill_relevance_score`
- `production_feasibility_score`
- `duplication_risk_score`
- `strategic_value_score`
- `total_score`
- `evidence_json`
- `provenance_json`
- `duplicate_signal_ids_json`
- `reason_codes_json`
- `lifecycle_state`
- `review_required`
- conversion metadata

## Lifecycle

Supported Radar states:

- `detected`
- `scored`
- `review_required`
- `shortlisted`
- `dismissed`
- `converted_to_idea`
- `converted_to_outline`
- `converted_to_script`
- `converted_to_calendar_item`
- `scheduled`
- `expired`

Low-confidence or low-quality signals become `review_required` instead of being surfaced as ready opportunities.

## Tenant And Privacy Rules

- Retrieval uses `contentDirectScopePredicate()`.
- User-private signals require matching `tenant_id` and `owner_user_id`.
- Tenant-shared/public signals require matching `tenant_id`.
- Private references owned by another user cannot generate Radar signals.
- Cross-tenant references cannot generate Radar signals.
- No model provider is called by this engine.

## Conversion

`convertContentRadarSignal()` supports:

- `idea`
- `outline`
- `script`
- `content_calendar_item`
- `dismissed`
- `expired`

Creative outputs are persisted through `createContentWorkflowObject()` with lineage metadata:

- source Radar signal
- Radar score
- source type
- evidence
- provenance

## Current Limits

- This is backend service foundation, not yet a full API/iOS/portal workflow.
- Real external trend ingestion is not claimed.
- Secretary calendar placement for content calendar items still needs runtime route wiring and local smoke.
