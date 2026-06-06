# Cross-Skill Content Opportunities

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Principle

Content Creation should notice useful creative material from the rest of Nexus without violating skill ownership or tenant boundaries. Other skills do not directly create content artifacts; they provide scoped signals. Content Radar scores those signals and converts them only through Content workflow actions.

## Source Skills

Supported source skills:

- Training
- Cooking
- Finance
- Secretary
- Chat

## Signal Examples

Training:

- milestone completed
- training struggle
- recovery lesson
- race prep phase

Cooking:

- meal prep routine
- fueling lesson
- repeated ingredient constraint

Finance:

- equipment purchase decision
- budget review pattern
- subscription cleanup lesson

Secretary:

- content cadence capacity
- overloaded schedule warning
- protected focus-time window

Chat:

- repeated user questions
- explicit user request for content angle
- unresolved creative follow-up

## Safety Rules

- Every signal must carry `tenant_id`.
- User-private signals must carry `owner_user_id`.
- Signals must not include raw sensitive context unless necessary.
- Cross-skill signals are treated as evidence, not commands to publish.
- Low-confidence or sensitive signals require review.
- Conversion to workflow artifacts preserves source attribution.

## Current Backend Support

`buildCrossSkillContentOpportunitySignal()` creates tenant-scoped Radar signals with:

- `source_type`
- `source_skill`
- `source_signal_type`
- freshness
- confidence
- cross-skill relevance
- production feasibility
- evidence
- provenance

`consumeContentCrossSkillSignal()` now adds the safety/orchestration layer on top:

- rejects cross-tenant signals before Radar state is created;
- classifies sensitive signals as automatic, summary-only, review-required, or prohibited;
- converts permitted Training milestone signals into workflow ideas when requested;
- summarizes/anonymizes Finance and Secretary constraints;
- deduplicates repeated cross-skill warnings by stable source reference;
- emits downstream implications for Content workflow and cadence.

`buildContentSecretarySignals()` and `buildContentChatStatusSignal()` now provide scoped outbound contracts for schedule placement and user-facing Chat status.

## Remaining Work

- Runtime event hooks from each skill into Content Radar.
- Sensitive cross-skill signal approval rules in UI/API workflows.
- Secretary scheduling integration into live content calendar placement routes.
- Full local cross-skill smoke with Chat, Secretary, Training, Cooking, Finance, and Content Creation.
