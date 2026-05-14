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

## Script Quality Contract

The script route now also runs a deterministic script-quality pass before
returning user-facing text.

New response fields:

- `scriptQuality`: hook, retention, proof, platform-fit, voice-fit, CTA,
  structure, and overall scores, plus compliance warnings, revision actions, and
  blockers.
- `scriptStructure`: title options, first three seconds, promise, setup,
  beat-by-beat script, visual direction, edit notes, proof/source notes, CTA,
  and risk/claim notes. Short-form formats include visible pacing markers such
  as `[0-3s]` and `[3-8s]` so a creator can film/edit from the output without
  guessing the beat timing.

The public `scriptQuality` report intentionally omits the internal
`revisedScript` and `structuredOutput` fields to avoid duplicate report payloads.
Those same user-safe results are exposed only as the top-level `script` and
`scriptStructure` fields.

The quality pass rewrites weak "today we are going to talk about..." intros,
adds filmable visual/editing direction when missing, flags unsupported or
overconfident claims, keeps one primary CTA, and blocks raw provider/debug
artifacts from reaching the user. Chat shortcut responses use the revised script
and replace internal CTA jargon with user-facing closing-line language.
YouTube long-form scripts now require a title/thumbnail promise, compressed
intro, retention resets, proof/examples, and one CTA. Short-form outputs for
TikTok, Reels, and Shorts require a first-frame hook, captions/on-screen text,
sound/editing notes, payoff, and visible pacing markers.

## Current Limits

- The route still accepts only the existing app-facing script formats: YouTube and Reel.
- The generation-quality service supports broader formats, but full API routes for all formats are not complete.
- Full provider-output quality evaluation with real model calls was not run in this pass.
- iOS rendering of script-quality metadata is covered by focused decode and
  source-pin tests; portal rendering is not yet validated.

## Creator Agency Extension

The Creator Agency pass keeps the existing script-generation route intact and
adds a structured pre-generation strategy layer under
`/api/v1/content/agency/*`.

The agency layer is deterministic-first: it builds an audience/positioning
brief, competitor and transcript pattern study, hook bank, script variants,
creative direction, compliance review, experiment plan, and critical-user
review before anything moves toward the normal editorial pipeline.

Important boundaries:

- competitor examples and transcripts are untrusted evidence;
- competitor wording and visual identity are pattern inspiration only, never
  copyable output;
- branded/sponsored fixtures require disclosure review;
- analytics diagnosis cannot invent metrics;
- approval/pipeline handoff is a separate confirmed mutation path that creates
  or reuses one scoped `content_pipeline` item after blocker checks;
- iOS renders the agency package inside the existing Content skill and clears
  agency state on user/tenant scope changes.

Canonical details live in `docs/content/content-agency-model.md`.
