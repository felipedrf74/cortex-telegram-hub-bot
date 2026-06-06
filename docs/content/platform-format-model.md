# Platform Format Model

Updated: 2026-04-29

## Purpose

Content Creation now has platform-aware format metadata so generation, review, scheduling, and repurposing can reason about the shape of the output.

The baseline format model is implemented in `src/services/content-domain-ontology.ts`.

## Baseline Formats

- `youtube_long_form`
- `youtube_shorts`
- `instagram_reel`
- `tiktok`
- `linkedin_post`
- `x_thread`
- `newsletter`
- `blog`
- `podcast_outline`
- `carousel`
- `generic_script`
- `caption`

Each format defines:

- Supported platforms
- Primary object type
- Structure
- Length expectation
- Pacing
- Hook style
- Production requirements
- Source usage pattern
- Editing/review needs
- Required metadata
- Whether tenant config can extend it

## Examples

`youtube_long_form`

- Structure: cold open, context, stakes, teaching beats, proof, payoff, CTA.
- Production requirements: title options, thumbnail angle, B-roll notes, source attribution.
- Review needs: claim check, retention pass, voice pass, source pass.
- Required metadata: viewer promise, thumbnail angle, production intent.

`x_thread`

- Structure: thread hook, promise, numbered beats, receipts, closing prompt.
- Production requirements: post count, quote-safe claims, source receipts.
- Review needs: claim density, thread flow, quote safety.

`carousel`

- Structure: cover hook, slide sequence, saveable summary, CTA.
- Production requirements: slide count, visual direction, design notes.
- Review needs: slide density, visual consistency, source safety.

## Extension Policy

The baseline list is not the whole intelligence layer. Tenant-defined formats are allowed only through typed `PlatformFormatDefinition` objects. This prevents silent prompt-only format drift.

Any custom format must define:

- `formatId`
- `platforms`
- `label`
- `primaryObjectType`
- `structure`
- `lengthExpectation`
- `pacing`
- `hookStyle`
- `productionRequirements`
- `sourceUsagePattern`
- `editingReviewNeeds`
- `requiredMetadata`

## Generation Readiness

Generation-capable outputs must pass `validateGenerationReadiness()`.

The validator checks:

- Tenant/user scope
- Known object type
- Known or explicitly registered format
- Platform compatibility
- Required object metadata
- Required format metadata
- Content pillar linkage
- Audience segment linkage
- Reference metadata when sources are supplied

This makes the Content skill less likely to generate unsupported, ungrounded, or generic outputs.
