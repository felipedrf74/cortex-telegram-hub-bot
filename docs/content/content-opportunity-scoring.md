# Content Opportunity Scoring

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Goal

Content Radar scores opportunities by usefulness, grounding, timeliness, novelty, brand fit, and production feasibility. The score is deterministic and does not depend on a model provider.

## Score Inputs

The scoring contract accepts:

- topic
- content pillars
- audience
- preferred formats
- disliked formats
- source quality
- freshness
- confidence
- novelty
- platform/format
- cross-skill relevance
- production feasibility
- duplication risk
- strategic value
- source type

## Score Components

`scoreContentOpportunity()` returns:

- `freshness`
- `confidence`
- `relevance`
- `novelty`
- `audienceFit`
- `brandFit`
- `platformFit`
- `sourceQuality`
- `crossSkillRelevance`
- `productionFeasibility`
- `duplicationRisk`
- `strategicValue`
- `total`
- `reviewRequired`
- `reasonCodes`

## Decision Reasons

Current reason codes include:

- `low_quality_source`
- `low_confidence_signal_requires_review`
- `stale_signal_downgraded`
- `high_duplicate_risk`
- `disliked_format_penalty`
- `cross_skill_opportunity`
- `low_production_feasibility`
- `matches_content_pillar`
- `brand_aligned`
- `audience_aligned`
- `book_reference_signal`
- `reference_channel_signal`
- `cross_skill_training_milestone`
- `cross_skill_finance_deadline`
- `cross_skill_cooking_routine`
- `cross_skill_secretary_capacity_signal`
- `chat_repeated_question_signal`
- `secretary_capacity_low`

## Duplicate And Stale Handling

Signals with the same normalized topic or source reference are linked through `duplicate_signal_ids_json` and penalized with high duplication risk. Stale signals receive `stale_signal_downgraded` and a lower score. This prevents Radar from repeatedly recommending the same old idea.

## Secretary Capacity

`prioritizeContentRadarSignals()` can accept `secretaryCapacityScore`. Low capacity lowers production feasibility and adds `secretary_capacity_low`, which keeps Radar from pushing heavy ideas on overloaded days/weeks.

## Release Notes

This pass adds scoring foundations only. Production readiness still requires API wiring, iOS/portal rendering, and full local product smoke through Chat, Secretary, and Content Creation.
