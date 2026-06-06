# Content Frontend Contracts

Date: 2026-05-04 (extended)
Scope: iOS and portal contracts for upgraded Content Creation. The 2026-05-04 vertical slice added the iOS creator profile editor, profile completeness card, accessibility identifiers per spec, two contrasting test fixtures, and a portal tenant scope picker with scope-aware fetch wrapper. See `docs/portal/content-portal-readiness.md` for verdict, gaps, and follow-up CONTENT-UI-O* items.

## Contract Principles

- Backend authorization is mandatory before content data is returned.
- Frontend filtering is never the tenant/privacy boundary.
- Unknown enum values must not crash clients.
- Rich content output must not be flattened into generic text when lifecycle, provenance, approval, novelty, or schedule metadata matters.
- iOS supports daily review and quick actions.
- Portal supports deeper editing, references, Content Agent setup, approvals, and workflow inspection.
- Token-zero remains intact: operational reads/writes use REST, not fake chat commands.

## Core DTO Families

### Content Object Summary

Required for ideas, topics, outlines, scripts, captions, calendar items, campaigns, series, and radar conversions.

```ts
interface ContentObjectSummaryDTO {
  id: string;
  objectType: string;
  title: string;
  summary?: string;
  tenantId: number;
  ownerUserId?: number;
  visibilityScope: 'user_private' | 'tenant_shared' | 'tenant_admin_visible' | 'platform_internal' | 'public_published' | string;
  lifecycleState: string;
  approvalState?: string;
  reviewRequired?: boolean;
  reviewReasonCodes?: string[];
  platform?: string;
  format?: string;
  contentPillarIds?: string[];
  audienceSegmentIds?: string[];
  createdAt: string;
  updatedAt: string;
}
```

Frontend behavior:

- Unknown `objectType`, `visibilityScope`, `lifecycleState`, or `approvalState` renders as an explicit "Unknown state" or "Needs review" fallback, not as normal ready content.
- `reviewRequired=true` must show a warning before copy, share, schedule, publish, or approve actions.

### Reference Summary

```ts
interface ContentReferenceSummaryDTO {
  referenceId: string;
  tenantId: number;
  ownerUserId?: number;
  visibilityScope: string;
  type: 'book' | 'link' | 'channel' | 'note' | 'previous_content' | 'radar_signal' | 'external_research_result' | 'user_uploaded_source' | string;
  title: string;
  url?: string;
  authorSource?: string;
  extractionStatus: string;
  freshnessScore?: number;
  confidenceScore?: number;
  trustLevel?: string;
  qualityScore?: number;
  brokenStatus?: string;
  staleStatus?: string;
  topicTags?: string[];
  lastUsedAt?: string;
  reviewRequired?: boolean;
  rejectionReasons?: string[];
}
```

Frontend behavior:

- Broken, stale, failed, quarantined, deprecated, or very low-confidence references must be visibly marked.
- The UI must not imply a reference was used unless the provenance envelope says it was used.
- Reference URLs should be opened only through normal safe-link behavior; untrusted retrieved content is not instruction text.

### Provenance Envelope

```ts
interface ContentProvenanceDTO {
  groundingStatus: 'grounded' | 'partially_grounded' | 'ungrounded' | string;
  referencesUsed: ContentReferenceSummaryDTO[];
  claims?: Array<{
    id: string;
    text: string;
    supportedBy?: string[];
    confidence?: number;
  }>;
  unsupportedClaims?: Array<{
    id: string;
    text: string;
    reasonCodes?: string[];
  }>;
  sourceSummaries?: string[];
  generatedFromRadarSignalId?: string;
  reusedFromContentId?: string;
  reviewRequired?: boolean;
}
```

Frontend behavior:

- `ungrounded` and `partially_grounded` outputs must be labeled before publish/share/copy-to-final workflows.
- Unsupported claims must be surfaced as review blockers.
- Source attribution may be compact on iOS, but should be inspectable in portal.

### Radar Signal

```ts
interface ContentRadarSignalDTO {
  signalId: string;
  tenantId: number;
  ownerUserId?: number;
  lifecycleState: string;
  sourceType: string;
  sourceReferenceId?: string;
  topic: string;
  freshnessScore: number;
  confidenceScore: number;
  relevanceScore: number;
  noveltyScore: number;
  audienceFitScore?: number;
  brandFitScore?: number;
  platformFitScore?: number;
  productionFeasibilityScore?: number;
  duplicateRiskScore?: number;
  strategicValueScore?: number;
  reviewRequired?: boolean;
  evidence?: ContentProvenanceDTO;
}
```

Frontend behavior:

- Low-confidence radar signals should be review-only, not presented as ready advice.
- Dismissed/expired signals should not be shown as active.
- Conversion actions must route through backend workflow APIs.

### Editorial Workflow State

```ts
interface ContentWorkflowDTO {
  contentObject: ContentObjectSummaryDTO;
  allowedActions: string[];
  pendingApproval?: {
    approvalRequired: boolean;
    approvalTypes: string[];
    reasonCodes: string[];
  };
  secretaryScheduleDecision?: {
    status: 'scheduled' | 'reflowed' | 'compressed' | 'deferred' | 'unscheduled' | 'rejected' | 'needs_more_context' | string;
    reasonCode?: string;
    explanation?: string;
    scheduledStart?: string;
    scheduledEnd?: string;
    agendaItemId?: string;
    conflicts?: string[];
  };
}
```

Frontend behavior:

- Destructive workflow actions require explicit confirmation.
- Publish/external-send actions require explicit confirmation and backend approval.
- Schedule actions must go through Secretary-owned scheduling routes/intents.

### Editorial Mutation Routes

The backend now exposes the first app-facing mutation contract family:

| Route | Contract |
| --- | --- |
| `GET /api/v1/content/workflow/:id` | Inspect an authorized object, workflow events, and approval records. |
| `POST /api/v1/content/workflow/:id/actions` | Run lifecycle/editorial actions. Returns `202` when approval is required. |
| `POST /api/v1/content/workflow/:id/source-review` | Submit source/claim review. Cross-tenant references are rejected before provenance write. |
| `POST /api/v1/content/workflow/:id/approval` | Approve or reject pending gates such as publish, low-confidence source, or tenant-shared scheduling. |
| `POST /api/v1/content/workflow/:id/repurpose` | Create a derived workflow object with `content_repurpose_history` lineage. |

Frontend behavior:

- Treat `202` from workflow actions/source review as a pending approval/review state, not a failure.
- Show `error.details.reasonCodes` when the backend rejects an invalid transition or unauthorized source.
- Never pass references from local cache unless they came from an authorized active-tenant response.
- Repurpose flows should render both `sourceObject` and `reusedObject` so the user can see lineage.

### Novelty and Reuse

```ts
interface ContentNoveltyDTO {
  status: 'novel' | 'near_duplicate' | 'duplicate' | 'intentional_reuse' | 'series_related' | string;
  noveltyScore?: number;
  duplicateRiskScore?: number;
  reasonCodes?: string[];
  comparedAgainstIds?: string[];
  reuseAllowed?: boolean;
  reuseLineage?: {
    originalContentId: string;
    repurposedContentId?: string;
    transformationType: string;
    sourcePlatform?: string;
    targetPlatform?: string;
  };
}
```

Frontend behavior:

- Duplicate warnings should not block intentional reuse by default.
- Reuse lineage should be shown in portal and compactly represented in iOS.

## Notification Deep-Link Resolver Contract

`GET /api/v1/content/notifications/:id` resolves a durable Content notification into a navigation target without mutating read/resolved state.

Clients should use this route when a Content notification is tapped, then call the existing generic mutation routes only after the user lands or completes the action:

- `POST /api/v1/notifications/:id/read`
- `POST /api/v1/notifications/:id/resolve`

Resolver payload:

```ts
interface ContentNotificationResolution {
  contractVersion: 1;
  notification: {
    id: number;
    userId: number;
    type: string;
    title: string;
    body: string;
    data: Record<string, unknown>;
    status: 'unread' | 'read' | 'resolved';
    createdAt: string;
  };
  deepLink: {
    targetKind:
      | 'approval'
      | 'source_review'
      | 'workflow_object'
      | 'script'
      | 'topic'
      | 'radar_signal'
      | 'reference'
      | 'pipeline_item'
      | 'weekly_package'
      | 'performance'
      | 'agent_insight'
      | 'content_home';
    targetId: string | null;
    screen: string;
    route: string;
    action: string;
    canOpenConcreteTarget: boolean;
    reasonCodes: string[];
    fallback: { screen: 'contentHome'; route: 'content/home' };
    markReadEndpoint: string;
    resolveEndpoint: string;
    sourceDataKeys: string[];
  };
}
```

Client requirements:

- Unknown `targetKind` or `screen` values must fall back to `fallback.route`.
- `canOpenConcreteTarget=false` should navigate to Content Home or a broad Content inbox, not a blank state.
- Clients must not infer targets from notification title/body.
- The backend resolver is owner-scoped; frontend filtering must not be treated as a security boundary.

## Secretary-Owned Scheduling Action Contract

`POST /api/v1/content/workflow/:id/actions` with `action = "schedule_content"` now returns the live Secretary scheduling result.

Clients may send:

- `durationMinutes`
- `minimumDurationMinutes`
- `preferredWindows`
- `unavailableWindows`
- `protectedWindows`
- `deadline`
- `priority`
- `flexibility`
- `approvalConfirmed`
- `reason`

Clients should render:

- `data.scheduling.status`
- `data.scheduling.explanation`
- `data.scheduling.selectedSlot`
- `data.scheduling.conflicts`
- `data.scheduling.downstreamImplications`
- `data.agendaItem.lifecycleState`
- `data.feedback.shouldRefreshSource`

Important behavior:

- `scheduled`, `reflowed`, and `compressed` return HTTP `200`.
- `deferred`, `unscheduled`, and `needs_more_context` return HTTP `202` as valid Secretary decisions.
- Tenant-shared scheduling can return HTTP `202` with `workflow.status = "approval_required"` before any agenda item is created.
- Frontend must not treat a local Content `scheduled` state as proof unless `secretaryAgendaItemId`/`agendaItem` is present.

## iOS Contract Requirements

iOS should render:

- compact content idea overview
- radar highlights
- review/approval badges
- lifecycle status chips
- source/provenance chips
- degraded or low-confidence warnings
- Secretary schedule status for content work
- portal deep link for complex editing
- unknown/future states without crash

iOS should avoid:

- editing large scripts as the only portal-equivalent surface
- making tenant/private visibility decisions locally
- keeping tenant-agnostic Content reference caches once tenant switching exists

## Portal Contract Requirements

Portal should render:

- Content Agent configuration
- Reference Center for books, links, channels, notes, previous content
- Content Radar with score breakdown and conversion actions
- voice/brand profile editor
- memory review with scope/freshness/confidence/corrections
- provenance inspector
- approval queue
- content lifecycle workflow board
- content calendar and Secretary schedule state
- source extraction/indexing health

Portal should avoid:

- raw private draft visibility for admins by default
- global id-only mutation without tenant/user scope
- exposing raw prompts or private model context in diagnostics

## Backward Compatibility

Existing iOS clients should continue to work with:

- `/api/v1/content/home`
- `/api/v1/content/pipeline`
- `/api/v1/content/ideas`
- `/api/v1/content/script`
- `/api/v1/content/topics`
- `/api/v1/content/books`
- `/api/v1/content/channels`
- `/api/v1/content/voice-dna`
- `/api/v1/content/intelligence`
- `/api/v1/content/intelligence/detail`

New rich fields should be additive. Backend routes should not make old clients decode mandatory new nested objects before a versioned mobile release is shipped.

## Minimum Tests Before Release

- iOS decodes unknown content lifecycle values without crash. **E2 PASS** — `ContentHomeContractDecodingTests` + `ContentSkillPresentationTests` pin `ContentTopicStatus` unknown→`.unknown` and `ContentHomeViewState` decodeOrDefault.
- iOS renders source attribution and review warnings. **E2 PASS** — `ContentScriptProvenanceDecodingTests` + `ContentIdeaReviewDetailRenderingTests` cover provenance/risk/review surfaces.
- iOS tenant switch clears or partitions Content caches. **E2 PASS (extended)** — `ContentReferenceLocalStoreTests` + the new `ContentCreatorProfileTests` (2026-05-04, 25 tests) pin scope-key partitioning, legacy-key quarantine, reset-only-this-scope semantics, and User A vs User B fixture isolation.
- Portal user console cannot read another tenant's private draft. **NOT PROVEN** — needs full user-console route + browser smoke. Tracked under CONTENT-UI-O5.
- Portal admin aggregate view does not expose raw private content. **NOT PROVEN** — same.
- Portal support access is audited when raw content is viewed. **NOT PROVEN**.
- Reference from another tenant is not returned to frontend contracts. **E1 PASS** — backend `content-admin-write.test.ts` pins scope predicates.
- Source/provenance warnings survive script refinement. **E2 PASS** — provenance decoding tests.
- Secretary schedule decision states render in iOS and portal. **E1 PARTIAL** — iOS `SecretaryDayPlanPreviewData` covers `scheduled` / `reflowed` / `compressed` / `deferred` / `unscheduled` states; portal lifecycle states still BLOCKED.
- (NEW 2026-05-04) iOS Content Home exposes accessibility identifiers per spec — `content-home-screen`, `content-next-action-card`, `content-profile-completeness-card`, `content-radar-button`, `content-ideas-button`, `content-script-studio-button`, `content-calendar-button`, `content-references-button`, `content-profile-voice-button`, `content-performance-button`. **E2 PASS** — all added on this branch via `accessibilityIdentifier` modifiers and tested via `xcodebuild build` PASS.
- (NEW 2026-05-04) iOS creator profile editor saves and reads back without crash. **E2 PASS** — `ContentCreatorProfileTests.test_writeAndReadProfile_roundTripsAllFields` round-trips all 13 fields against a `UserDefaults(suiteName: ...)`.
- (NEW 2026-05-04) Portal V1 admin content routes receive `x-nexus-user-id` / `x-nexus-tenant-id` when scope is set. **E2 PASS** (Node self-test) — 3-assertion suite validates the `apiFetch` wrapper. Browser/runtime smoke is the next gate (E3).
