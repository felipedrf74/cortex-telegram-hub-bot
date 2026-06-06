# Content iOS Readiness

Date: 2026-04-29
Branch audited: `feature/ios-content-creation-intelligence-upgrade`
Mode: static readiness audit plus frontend contract definition. No iOS runtime smoke in this batch.

## Executive Summary

The iOS app has a real Content Creation surface today. It is not a blank shell:

- Content landing screen: `Nexus Hub/Views/Content/ContentSkillView.swift`
- Content repository and REST client: `Nexus Hub/Core/Repositories/ContentRepository.swift`, `Nexus Hub/Core/Services/ContentService.swift`
- Content home contract and defensive decoder: `Nexus Hub/Views/Content/ContentHomeViewState.swift`
- Script generator and structured result rendering: `Nexus Hub/Views/Content/ScriptGeneratorView.swift`
- References screen: `Nexus Hub/Views/Content/ContentReferencesView.swift`
- Backstage intelligence/radar/voice/schedule view: `Nexus Hub/Views/Content/ContentIntelligenceView.swift`
- Topic scheduler and Content tasks: `Nexus Hub/Views/Content/TopicSchedulerView.swift`, `Nexus Hub/Views/Content/ContentTasksView.swift`

The current app is ready for the existing Content product. It is not yet ready to claim full support for the upgraded Content Creation intelligence layer because it still flattens or omits several new backend concepts: provenance, source freshness/confidence, lifecycle/review/approval state, novelty/reuse decisions, tenant-scoped reference ownership, and Secretary-arbitrated content schedule states.

Verdict: **NO-GO for rich upgraded Content iOS readiness** until the open blockers below are implemented and smoke-tested.

## Current Capabilities

| Capability | Current iOS support | Evidence | Readiness |
|---|---|---|---|
| Content overview | Server-backed `/api/v1/content/home` with local fallback | `ContentRepository.loadHome`, `ContentHomeContractResolver` | Ready for current contract |
| Pipeline and ideas | Pipeline, ideas, staged cards | `getPipeline`, `getIdeas`, `ContentSkillView` | Ready for current contract |
| Script generation | Platform, duration, mode, hook, titles, script, captions, CTA, simple sources, warnings | `ContentScriptResponse`, `ScriptGeneratorView` | Partial for upgraded contract |
| Books/channels/brand voice | AppStorage-backed editor plus best-effort backend sync | `ContentReferencesView` | Partial, not tenant-switch-safe yet |
| Radar/backstage | Summary/detail, preferred topics, recent signals, schedule recommendation | `ContentIntelligenceView` | Partial |
| Topic calendar | Topic create/edit/delete, scheduled date/time, current sync metadata | `ContentTopic`, `TopicSchedulerView` | Partial |
| Degraded states | Error banners, unavailable shells, partial sync banners | Content workspace/state views | Good |
| Unknown future states | Good for `ContentHomeViewState`; weaker for topics/scripts/provenance | Decoder tests cover home only | Needs work |

## Gaps Blocking Rich Content Support

### P0 - tenant-safe local state is not proven for same-user tenant switching

`ContentRepository` caches home, pipeline, ideas, notes, topics, intelligence, and filming recommendation globally for the signed-in user session. It resets on sign-out, but it does not expose an active tenant cache key. `ContentReferencesView` stores books/channels/brand voice in `@AppStorage` keys that are not tenant-qualified:

- `nexus_content_books_json`
- `nexus_content_channels_json`
- `nexus_content_brand_voice`

This is acceptable for the current single-tenant runtime shape, but it cannot be called tenant-safe for true same-user tenant switching.

Required before release:

- Partition Content repository cache by `userId + tenantId`.
- Partition Content reference AppStorage keys by `userId + tenantId`, or move references behind a repository that reads server-scoped data first.
- Invalidate Content state on tenant switch before any render.
- Add tests for tenant switch cache invalidation and reference state isolation.

### P1 - provenance is not first-class in iOS

The script renderer displays `sourcesUsed` as title, optional URL, source type, and relevance note. The new backend provenance model carries richer metadata that iOS does not yet decode/render:

- reference ID
- tenant ID and owner scope
- source type
- extraction/indexing status
- freshness
- confidence
- trust level
- broken/stale status
- grounding status
- unsupported claims
- review required
- generated-from radar signal
- reused-from content ID

Required before release:

- Add compact source/provenance DTOs.
- Render source chips/cards with `freshness`, `confidence`, `trustLevel`, and `reviewRequired`.
- Render grounding status: `grounded`, `partially_grounded`, `ungrounded`.
- Show unsupported claim warnings before copy/share actions.

### P1 - lifecycle and approval states are too narrow

`ContentTopicStatus` currently supports only:

- `planned`
- `drafting`
- `ready`
- `published`
- `cancelled`

The upgraded backend workflow supports richer editorial states:

- `idea`
- `researched`
- `selected`
- `outlined`
- `drafted`
- `reviewed`
- `revised`
- `approved`
- `scheduled`
- `published`
- `archived`
- `repurposed`
- `rejected`
- `stale`

The UI also needs approval/review states for low-confidence sources, unsupported claims, tenant-shared scheduling, draft deletion, brand voice changes, and sensitive cross-skill signals.

Required before release:

- Add a generic content lifecycle presentation model with unknown fallback.
- Keep `ContentTopicStatus` compatible for old routes, but do not use it as the universal editorial lifecycle.
- Add approval banner/card presentation for `approvalRequired`, `reviewRequired`, and `reasonCodes`.

### P1 - novelty/reuse decisions are not visible

The backend now has duplicate, novelty, intentional reuse, and repurposing foundations. iOS does not yet show:

- near-duplicate warning
- repeated hook/topic warning
- overused reference warning
- intentional repurpose lineage
- content series allowance
- original content ID and transformation type

Required before release:

- Add novelty/reuse DTOs and warning chips.
- Render reuse lineage in scripts, ideas, and radar conversions.
- Avoid blocking intentional reuse in UI; label it clearly.

### P1 - Secretary-arbitrated Content schedule state is not represented

Topic scheduling shows current date/time plus Secretary task/calendar sync metadata. It does not yet render Secretary scheduling decisions such as:

- `scheduled`
- `reflowed`
- `compressed`
- `deferred`
- `unscheduled`
- `rejected`
- `needs_more_context`

Required before release:

- Add schedule decision/status fields to Content topic/workflow cards.
- Show reason code and explanation when a content block is reflowed, deferred, or unscheduled.
- Link to Secretary agenda item where available.

### P2 - notification deep links do not target concrete Content artifacts

Existing docs note Content notifications route to Skills and mark read, but do not resolve a specific topic/script/action. Rich Content needs deep links to:

- radar signal
- idea
- draft/script
- approval request
- source review
- scheduled content block

Required before release:

- Backend resolver: `GET /api/v1/content/notifications/:id` exists in the backend branch and returns exact/fallback Content targets.
- iOS route target enum for Content artifact/action.
- Tests for unknown artifact fallback.

## Required iOS DTO Additions

The iOS app should accept these additive fields without crashing and without treating unknown values as normal success:

```json
{
  "contentObject": {
    "id": "content_object_123",
    "objectType": "script",
    "tenantId": 42,
    "ownerUserId": 7,
    "visibilityScope": "user_private",
    "lifecycleState": "reviewed",
    "approvalState": "approval_required",
    "reviewRequired": true,
    "reviewReasonCodes": ["unsupported_claim_requires_review"],
    "platform": "youtube",
    "format": "youtube_long_form"
  },
  "provenance": {
    "groundingStatus": "partially_grounded",
    "referencesUsed": [],
    "unsupportedClaims": [],
    "reviewRequired": true
  },
  "novelty": {
    "status": "near_duplicate",
    "score": 0.42,
    "reasonCodes": ["repeated_hook"],
    "reuseAllowed": true
  },
  "scheduleDecision": {
    "status": "reflowed",
    "reasonCode": "content_focus_conflict",
    "explanation": "Moved editing away from a hard calendar conflict.",
    "agendaItemId": "agenda_123"
  }
}
```

## iOS Smoke Matrix

| Scenario | Status | Notes |
|---|---|---|
| iOS renders current Content home | Not run in this batch | Existing UI supports current contract. |
| iOS renders content idea | Not run in this batch | Current ideas surface exists. Needs richer lifecycle fixture. |
| iOS renders radar signal | Not run in this batch | Backstage view renders current signal digest. Needs upgraded signal fixture. |
| iOS renders source attribution safely | Blocked | Requires richer provenance DTO/rendering. |
| iOS renders approval/review states | Blocked | Requires DTO/rendering. |
| Tenant switch does not leak references | Blocked | Requires tenant-keyed cache/AppStorage or repository migration. |
| Unauthorized user cannot see private draft | Backend-gated, iOS not proven | iOS must not be the boundary; needs API fixture smoke. |
| Unknown/future lifecycle fallback | Partial | Home contract covered; Content topic/script/provenance states need tests. |

## Release Recommendation

Do not market the iOS app as supporting the upgraded Content Creation intelligence layer yet. It can remain compatible with the existing Content skill while backend foundations continue, but the rich release needs a dedicated iOS implementation slice and simulator smoke against the full local Nexus engine.
