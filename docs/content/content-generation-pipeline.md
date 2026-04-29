# Content Generation Pipeline

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Goal

Content Generation should produce platform-aware, source-aware, voice-aware, workflow-aware output. This pass adds an explicit backend quality/context layer instead of relying on generic prompt text.

## Implementation

- Service: `src/services/content-generation-quality.ts`
- Script route integration: `src/api/routes/content-script-routes.ts`
- Provider payload scope hardening: `src/services/content-engine.ts`
- Tests: `__tests__/services/content-generation-quality.test.ts`

## Generation Inputs

The generation package uses:

- active `tenant_id`
- active `user_id`
- topic
- content goal
- platform/format
- workflow state
- content pillar/audience where available
- tenant/user creative profile
- authorized references
- source confidence
- novelty/reuse notes when supplied
- radar signal id when supplied

## Contract Produced

`buildContentGenerationPackage()` returns:

- format definition
- primary object type
- required output fields
- required structure
- platform notes
- production notes
- source usage rules
- review warnings
- voice context
- selected authorized references
- source grounding status
- provider-routing metadata
- next workflow step
- prompt/context block for generation

## Provider Routing

This pass does not hardcode a provider or model.

Generation metadata is provider-agnostic:

- task type: `chat`
- category: `content_generation`
- domain: `content`
- tenant/user metadata included before provider calls
- operator overrides preserved

The Python content engine already routes provider calls through the TypeScript internal AI proxy. This pass also forwards `tenant_id` through `getScript()` so provider fallback paths receive the same scoped metadata.

## Script Route Wiring

The existing `/api/v1/content/script` route now appends the generation package to creator context. This means scripts receive:

- Voice/profile memory
- Authorized source rules
- Platform/format contract
- Workflow state
- Review warnings
- Tenant/user scope instructions

The response remains backward compatible and adds optional `generationQuality` metadata.

## Current Limits

- The route still accepts only the existing app-facing script formats: YouTube and Reel.
- The generation-quality service supports broader formats, but full API routes for all formats are not complete.
- Full provider-output quality evaluation with real model calls was not run in this pass.
- iOS/portal rendering of `generationQuality` is not yet validated.
