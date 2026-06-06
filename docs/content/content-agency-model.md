# Content Agency Model

Status: current
Last updated: 2026-05-14

## Purpose

The Content Agency layer turns the existing Content skill into a structured
creator-agency workflow: brief synthesis, audience and positioning, competitor
pattern study, transcript study, hook bank, script variants, creative
direction, compliance review, experiment planning, performance diagnosis, and
critical-user review.

This is not a parallel Content v2 stack. It extends the canonical Content
services, routes, skill manifest, quality harness, and iOS Content surface.

## Canonical Backend Files

- Reference-backed rules: `src/services/content-agency-rules.ts`
- Agency orchestrator and quality gate: `src/services/content-agency.ts`
- REST routes: `src/api/routes/content-agency-routes.ts`
- Route registration: `src/api/routes/content.ts`
- Persistence migration: `migrations/128_content_agency.sql`
- Skill declaration: `src/skills/content/manifest.json` and `src/skills/skill-config.ts`
- Evaluation harness scenarios: `src/services/content-day-to-day-evaluation.ts`

## Canonical iOS Files

- API contracts: `Nexus Hub/Core/Services/ContentService.swift`
- Repository state and scope clearing: `Nexus Hub/Core/Repositories/ContentRepository.swift`
- Content Agency studio entrypoint and screens: `Nexus Hub/Views/Content/ContentSkillView.swift`

The iOS experience lives inside the existing Content skill under Skills. It
does not add a bottom tab, duplicate repository, or duplicate DTO family.

## Reference Rule Registry

`CONTENT_AGENCY_RULES` represents every supplied reference category as concise
runtime rules. The rule registry stores source anchors, product behavior,
quality-gate impact, blocked failure modes, and the intended user-facing
effect. It deliberately avoids copying long source text into prompts.

Rule categories:

- YouTube discovery, Shorts, Analytics, retention, engagement, Trends,
  Inspiration, APIs, copyright, and fair use.
- TikTok For You recommendations, Creative Center, Top Ads, Creative Codes,
  split testing, measurement, and Research API.
- Instagram/Meta ranking, Feed, Explore, recommendations, search, Insights,
  dashboard, branded content, ads, and A/B testing.
- Google Search, people-first helpful content, video/image SEO, AI-generated
  content guidance, and Trends.
- Human behavior: emotion/arousal, virality, video engagement, narrative
  transportation, and short-form attention research.
- Brand and positioning: distinctive assets, long/short marketing effects,
  Jobs To Be Done, competitive positioning, category strategy, and StoryBrand.
- Scripting/storytelling: hooks, payoff, memory, narrative structure, and
  audience transformation.
- Editing/production: native vertical production, first frame, captions,
  sound, cuts, B-roll, overlays, and production feasibility.
- Creator economy and agency: paid/organic loops, UGC, partnerships,
  influencer effectiveness, brand lift, and direct response.
- Compliance: FTC, ASA, UK disclosure guidance, branded-content policies,
  copyright, fair use, and regulated-claim boundaries.
- Agent/eval architecture: scoped handoffs, guardrails, human review, and
  scenario evaluation.

## API Contract

All routes live under `/api/v1/content` and require the existing authenticated
Content route scope.

- `GET /agency/rules`
- `POST /agency/brief`
- `POST /agency/competitor-study`
- `POST /agency/transcript-study`
- `POST /agency/package`
- `POST /agency/score`
- `GET /agency/projects/:id`
- `POST /agency/projects/:id/handoff`

Every agency response includes scoped identity, platform, format, objective,
source trace, reference ids, confidence, quality score, warnings, blockers,
review requirement, and next best actions where applicable. Routes also return
a shared `contract` envelope so Chat, iOS, and future Content surfaces can read
the same tenant-safe summary, quality state, warnings/blockers, source trace,
and next actions without scraping presentation fields.

User-facing responses must not include raw prompts, provider output, raw
transcript dumps, raw JSON fragments, copied competitor wording, unsupported
analytics claims, internal IDs, fake metrics, viral guarantees, or generic
advice without a diagnosis.

## Persistence

Migration `128_content_agency.sql` adds scoped tables for agency briefs,
competitor studies, transcript studies, packages, compliance reviews,
experiment runs, and quality reviews.

Every table includes `user_id`, `tenant_id`, `visibility_scope`, `status`,
`platform`, `format`, source trace JSON, quality score, warnings, blockers, and
timestamps. Agency ids are unique per `(tenant_id, user_id, agency_id)` so a
stable package/brief/study id updates the scoped artifact instead of silently
accumulating duplicates. Competitor material and transcripts are stored as
untrusted evidence; final creative records provenance without copying source
wording.
Migration `129_content_agency_pipeline_handoff.sql` adds
`content_pipeline.source_agency_package_id` so approved packages can move into
the existing editorial pipeline exactly once with read-back traceability.

## Quality Gate

`ContentAgencyOutputQualityGate` is implemented inside
`src/services/content-agency.ts`. It scores and blocks or warns on:

- audience specificity
- platform-native fit
- hook strength
- first-frame clarity
- narrative tension
- emotional arousal and shareability
- proof density
- originality
- brand consistency
- editability
- production feasibility
- claim grounding
- compliance safety
- experiment clarity
- actionability

The package contract also includes a deterministic performance diagnosis that
maps supplied metrics to useful bottleneck hypotheses without inventing
analytics. Examples include high CTR with low retention, low CTR with high
retention, high retention with low conversion, strong saves with low comments,
and strong comments with low shares.

Blockers cover copied competitor material, prompt injection, unsupported
platform-ranking claims, invented metrics, missing disclosure for branded
content, raw artifacts, missing platform/objective context, weak next actions,
and unsafe regulated claims. Warnings cover thin briefs, weak proof, unclear
CTA, weak emotional driver, low brand memory, high production demand, and
strong trend fit with weak brand fit.

`CONTENT_AGENCY_RUNTIME_QUALITY_RULES` maps every reference category to at
least one runtime quality dimension. `validateContentAgencyReadiness()` fails if
a category is present only as documentation and has no product behavior, which
keeps official platform docs, compliance rules, human-behavior research,
brand/positioning references, editing guidance, analytics logic, and
agent/eval architecture connected to the package scorer and output gate.

## Existing-Agent Health Gate

Before relying on the agency layer, direct runtime tests now pin weak existing
Content agent paths:

- Reaction Radar completes without fake opportunities when APIs are unavailable.
- SEO and Performance agents fail closed without a user-scoped creator channel.
- Pipeline Agent ignores user-private backlog when emitting global scheduled
  signals, while dashboard reads preserve the normal scoped read behavior.
- Editorial Coordinator emits useful cross-skill signals without generic noise.

## iOS Behavior

The Content Agency studio shows summary-first sections:

- Agency Brief
- Audience & Positioning
- Competitor Study
- Transcript Study
- Hook Bank
- Script Studio
- Creative Direction
- Compliance Review
- Experiment Plan
- Performance Diagnosis
- Pipeline Handoff

Warnings are visible and calm. Blockers disable approval. The current UI does
not fake pipeline mutation: when blockers are clear, the "Move to pipeline"
button calls the confirmed handoff route, the backend creates or reuses one
scoped `content_pipeline` item, explicitly reads the inserted/existing row back
by id, tenant, user, owner, package id, active scope, and approved state, and
iOS refreshes pipeline state after the read-back response.

The iOS validation fixture launches the Agency Studio directly in UI-test mode,
extracts visible text like a skeptical creator, and fails if the surface lacks
clear next actions, source/evidence cues, compliance/originality status,
performance metrics to watch, or if raw prompt/debug artifacts leak into the
primary UI.

## Evaluation

The Content day-to-day harness now includes Creator Agency scenarios for:

- competitor transcripts to agency package
- weak script rewrite
- analytics bottleneck diagnosis
- brand positioning and calendar
- viral competitor pattern originality
- branded content disclosure gate
- prompt-injected transcript guard

Release expectation remains overall score `>= 90`, no critical failures, no
tenant leaks, no copied competitor wording, no unsupported analytics claims,
no missing disclosure in sponsored fixtures, no raw prompt artifacts, and no
priority generic-output failures.

## Open Limitations

- The first pass is deterministic and local to existing Content APIs. It does
  not post content, spend ads, mutate platform accounts, or call production
  platform APIs.
- Pipeline handoff moves approved packages into the existing `content_pipeline`
  table only. It does not publish, schedule, spend, or mutate external
  platforms.
- Manual hostile review of real creative taste remains valuable before public
  beta because scenario tests can catch usefulness and safety, but not every
  taste-level editorial judgment.
