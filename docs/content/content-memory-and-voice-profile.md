# Content Memory And Voice Profile

Updated: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Purpose

Content Creation now has a typed memory/profile facade over the cross-skill `skill_memories` ledger. The goal is to make generation more consistent and brand-aware while keeping memory tenant-safe, user-safe, correctable, freshness-aware, and version-aware.

Implementation:

- Service: `src/services/content-memory-profile.ts`
- Shared ledger: `skill_memories`
- Schema version: `content-creative-memory-v1`
- Tests: `__tests__/services/content-memory-profile.test.ts`

## Voice Profile Fields

Content voice memory can track:

- `voice.tone`
- `voice.style`
- `voice.pacing`
- `voice.vocabulary_preferences`
- `voice.hook_preferences`
- `voice.structure_preferences`
- `voice.storytelling_style`
- `voice.humor_sincerity_level`
- `voice.directness`
- `voice.formality`
- `voice.banned_phrases`
- `voice.preferred_ctas`
- `voice.platform.<platform>`

Platform-specific voice is applied only for the requested platform. For example, a YouTube generation path may receive `voice.platform.youtube` without receiving `voice.platform.linkedin`.

## Runtime Use

`POST /api/v1/content/script` now builds a scoped creative profile context with:

- active tenant id
- authenticated user id
- target platform/format
- scoped memories only
- freshness and confidence metadata
- omitted-private-memory warning behavior for tenant-shared output paths

The profile context is appended to the existing creator profile and reference prompt block. Live model routing is preserved; this pass does not hardcode a provider or model.

## Correction Handling

`applyContentMemoryCorrection()` writes corrected memory using the shared correction flow:

- old active memory is superseded
- new memory is marked `freshness_status=corrected`
- correction history records the superseded memory id
- retrieval defaults to active, non-stale memory only

Examples supported by the model:

- "Use a more direct tone" -> update `voice.directness`
- "Stop suggesting this topic" -> update `brand.topics_to_avoid`
- "Use my YouTube style, not LinkedIn style" -> update `voice.platform.youtube`

## Version Awareness

`markContentCreativeMemoryStaleForVersion()` allows major Content releases to stale old voice/profile memory by skill version or schema version. Stale memory is excluded from generation context by default.

## Safety

The service does not store raw prompts, secrets, provider responses, or broad tenant data dumps. It stores concise profile facts and preferences through the shared `skill-memory` safety filters.

For tenant-shared content, user-private creative preferences are omitted unless the caller explicitly sets `allowUserPrivateForTenantShared=true`.
