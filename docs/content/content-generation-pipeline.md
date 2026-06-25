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

The response remains backward compatible and adds optional `generationQuality`
metadata plus the public provenance fields needed by iOS and QA:

- `sourceMode`, `sourceCount`, `researchWarnings`, and `qualityBlockers`
- `research.package`, a compact `ContentResearchPackage` with source mode,
  source counts, observed time, publishable state, source summaries, and claim
  ledger
- `voiceBrandCard`, a `creator-voice-brand-card-v2` summary with audience,
  pillars, positioning, proof library, quality, provenance, and missing facts
- `agentSignalsUsed`, populated only from real input signals sent into the
  content engine

The same package shape is also exposed by discovery, Radar, and Creator Agency:

- Script edit and research-refresh responses return the same `research.package`,
  top-level `sourceMode`, `sourceCount`, and `researchWarnings` fields. Edit
  paths that only receive a user-supplied source summary remain review-required
  (`sourceMode: none`) until a real source package is attached; explicit refresh
  uses live search sources when available.
- `POST /api/v1/content/discover` returns `research`, top-level `sourceMode`,
  `sourceCount`, and `researchWarnings` for both live discovery and degraded
  local fallback.
- Radar signals store `researchPackage`, `sourceMode`, `sourceCount`, and
  warnings in provenance JSON, then return the parsed package on the mapped
  signal and preserve it through workflow conversion metadata.
- Creator Agency briefs, competitor studies, transcript studies, packages, and
  package handoff history carry `researchPackage`/`sourceMode`; mock or degraded
  agency research is treated as non-publishable before pipeline handoff.

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

- The script route accepts the broader Content ontology formats: YouTube long
  form, YouTube Shorts, Reel, TikTok, LinkedIn post, X thread, newsletter, blog,
  and carousel. iOS must still render unknown future formats defensively.
- Degraded, fallback, mock, fixture, or no-source research is visible in the
  response and treated as review/non-publishable provenance until real sources
  are attached. `fixture` is intentionally retained as a deterministic local
  source-mode for eval and E2E harnesses; it is not publishable provenance.
- Full provider-output taste evaluation still requires Felipe's manual judgment
  in the iOS Simulator. The local entrypoint is
  `scripts/content-creation-e2e-validation.sh`, which boots the latest local
  backend/content-engine containers, records runtime identity, runs the content
  backend matrix (scripts, agency, Radar, discovery, profile, references,
  feedback, memory, performance, operational agents, voice evolution, and Python
  provenance), routes to Content Studio UI suites, and writes Felipe's manual
  scenario fixture plus checklist under ignored `.local/content-creation-e2e/`.
- Portal rendering of the richer script-quality metadata is not yet validated.

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
