# Content Portal Readiness

Date: 2026-05-04
Branch audited: `feature/content-creation-workflow-ui-redesign`
Mode: 2026-05-04 vertical-slice closeout — extends the 2026-04-29 portal/backend surface audit with the additions shipped on this branch (tenant scope picker + scope-aware `apiFetch` + iOS Profile/Voice editor) and re-asserts which portal sections are still BLOCKED, PARTIAL, or PASS. Browser-runtime smoke is documented as the next required gate.

## 2026-05-04 vertical-slice update

This pass added the safest useful slice of the upgraded Content Creation
power console:

- **Portal scope picker** in `src/portal/portal.html` Content section.
  Operator enters `userId` / `tenantId`; the picker persists the scope to
  `localStorage` (`nexus-portal-content-scope-v1`) and the `apiFetch`
  wrapper attaches `x-nexus-user-id` / `x-nexus-tenant-id` headers to every
  `/api/v1/admin/content/*` call. Non-content paths (`/api/snapshot`,
  `/api/agents`, `/api/signals`, `/api/pipeline`, `/api/notifications`,
  `/api/reports`) keep their legacy unscoped behavior. Self-tested via 3
  Node self-checks (no-scope → no headers; scope active on content path →
  headers present; scope active on non-content path → no headers).
- **iOS `ContentCreatorProfileView`** added — pillars / niches / audience /
  platforms / voice rules / preferred formats / disliked-banned topics /
  trusted-disliked sources / content goals / language / voice examples
  editor; tenant-scoped local persistence via `ContentCreatorProfileLocalStore`
  (mirrors `ContentReferenceLocalStore` versioned scope-key partitioning).
  Two contrasting fixtures (User A AI/training creator, User B
  cooking/family creator) for QA. Profile completeness card on Content
  Home with progressive disclosure (hidden when ≥70%). 25-test focused
  XCTest suite (`Nexus HubTests/ContentCreatorProfileTests.swift`) covers
  completeness math, tenant-scope partitioning, legacy-key quarantine,
  reset semantics, and fixture contrast.
- **iOS accessibility identifiers** added per spec:
  `content-home-screen`, `content-next-action-card`,
  `content-profile-completeness-card`, `content-radar-button`,
  `content-ideas-button`, `content-script-studio-button`,
  `content-calendar-button`, `content-references-button`,
  `content-profile-voice-button`, `content-performance-button`, plus
  `content-save-profile-button` and 13 per-editor identifiers on the new
  profile view.

iOS `xcodebuild -scheme "Nexus Hub" -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.4.1' build` PASS. Backend `tsc --noEmit` PASS. `npm run docs:audit` baseline preserved.

## Executive Summary

The portal already has a Content section and admin/write routes. It is useful as an operator dashboard, but it is not yet the tenant-safe Content Creation power console described by the upgraded product requirements.

Current portal strengths:

- Content dashboard section in `src/portal/portal.html`.
- Dashboard data route: `GET /api/v1/admin/content-dashboard`.
- Admin write route family: `/api/v1/admin/content/*`.
- Legacy portal routes still exist for platform dashboard reads; legacy write routes for books/channels now return `SCOPED_V1_REQUIRED`.
- Content dashboard renders pipeline KPIs, books, channels, radar, voice DNA, agent graph, triggers, and commands.
- Tenant/user-scoped backend APIs exist for portal Content links, books, channels, and manual Voice DNA mutations. These require explicit user/tenant scope and use backend predicates, not UI filtering.

Current portal limits:

- Most Content portal surfaces are platform/operator global.
- There is no tenant/user-scoped User Console Content workspace yet.
- Admin/support visibility is not granular enough for private drafts, voice profiles, and tenant-owned references.
- The portal does not yet expose all upgraded provenance, approval, lifecycle, memory, novelty, and content calendar workflow as first-class UI surfaces, but backend portal contracts now exist for provenance review packs, reuse lineage, and historical comparison.

Verdict: **NO-GO for tenant-facing Content portal readiness**. The current portal can remain an operator dashboard, but it must not be treated as a tenant admin/user Content console without additional authorization and audit controls.

**2026-05-04 verdict (slice closeout):** still **NO-GO for tenant-facing portal**. The added tenant scope picker + scope-aware `apiFetch` is a NECESSARY but NOT SUFFICIENT precondition for tenant-facing usage; the still-MISSING surfaces below (brief editor, script studio, calendar, performance, memory & feedback, approval queue) keep the portal in operator-dashboard mode. iOS-side **PASS WITH CONDITIONS** — Content surface now has an editable creator profile (largest single gap closed) and accessibility identifiers per spec; per-card Radar accept/reject/save/create-brief actions remain BLOCKED until backend exposes a per-signal feedback endpoint to iOS (intelligence-bus `/api/signals/:id/dismiss` is portal-only).

**2026-05-04 update (CONTENT-UI-O1..O8 closeout):** all 8 follow-ups
landed in this same vertical slice. Net effect on portal readiness:

- Performance dashboard, canonical 12-bucket lifecycle band, and
  scope-aware `apiFetch` are now in production-ready shape on the
  portal. Operator workflow gap is significantly reduced.
- iOS now has unified `ContentCreatorProfile` round-trip (CONTENT-UI-O1),
  per-card Radar accept/reject/save/create-brief (CONTENT-UI-O2),
  Brief editor (CONTENT-UI-O6), and week-grid Topic Scheduler
  (CONTENT-UI-O7). The iOS half of the workflow is no longer the
  bottleneck.
- **Verdict update**: portal moves from NO-GO to **PASS WITH CONDITIONS
  for operator-scoped Content workflows** (i.e. an operator can scope
  to a specific tenant and review their performance / lifecycle /
  references). Tenant-facing direct portal usage is still NO-GO until
  brief editor, script studio, calendar, memory & feedback, and
  approval queue surfaces ship on the portal.

## Current Portal Surfaces

| Surface | Current support | Evidence | Readiness |
|---|---|---|---|
| Operator Content dashboard | Yes | `src/portal/portal.html`, `src/api/routes/content-dashboard.ts` | Partial |
| Book management | Tenant/user-scoped add/delete/retry/notes in admin write route | `src/api/routes/content-admin-write.ts`, `content-admin-write-auth.test.ts` | Backend scoped; portal UI smoke missing |
| Link management | Tenant/user-scoped backend routes added | `src/api/routes/content-admin-write.ts`, `content-admin-write-auth.test.ts` | Backend scoped; portal UI smoke missing |
| Channel management | Tenant/user-scoped add/delete/reanalyze in admin write route; non-default tenant synthesis deliberately skipped | `src/api/routes/content-admin-write.ts`, `src/services/channel-learner.ts` | Backend scoped; browser workflow and tenant-specific synthesis remain open |
| Reaction Radar | Dashboard list and pillar config | portal HTML + admin routes | Partial |
| Voice DNA | Dashboard cards, manual scoped upsert/update; tenant-scoped synthesize action blocked until agent supports explicit scope | portal HTML + admin routes | Backend safer; synthesize workflow open |
| Agent graph/triggers | Read-only dashboard | portal HTML + dashboard route | Operator-ready |
| Draft/script editing | Not first-class | No tenant User Console workflow found | Missing |
| Reference Center | Fragmented books/channels/knowledge | Existing routes/tables | Missing as unified tenant-safe center |
| Provenance inspection | Backend contract ready, UI not first-class | `GET /api/v1/admin/content/provenance`, `GET /api/v1/admin/content/provenance/review-pack` | Partial |
| Approval workflow | Not first-class | Backend approval records exist, no portal UI | Missing |
| Content calendar | Pipeline/topic status only | No full workflow calendar console | Missing |
| Content memory review | Not first-class | Backend memory docs/services exist | Missing |

## Portal Security Boundary

The portal must not become the security boundary for Content data. Backend authorization must determine what can be read, edited, scheduled, approved, or deleted.

Required boundaries:

- User Console can show only the user's own private content plus tenant-shared content the user is allowed to access.
- Tenant Admin Console can show aggregate status by default, not raw private drafts or user-private voice notes.
- Tenant admin access to private content requires explicit tenant policy, role permission, and audit event.
- Platform/operator support access must be explicit and audited; raw content should not be the default diagnostics view.
- Admin write routes must not mutate global content resources by id unless the route is explicitly platform-only.

## Required Portal Product Surfaces

### User Console

The User Console should support daily creator work:

- own content ideas, drafts, scripts, captions, and outlines
- status by lifecycle/review state
- pending approvals and source-review warnings
- radar highlights and conversion actions
- reference use visibility
- content calendar blocks from Secretary
- links to iOS quick actions

### Tenant Content Console

The tenant console should support shared brand/workspace setup:

- content agent configuration
- Reference Center for books, links, channels, notes, and previous content
- voice/brand profile
- content pillars and audience segments
- platform/cadence settings
- tenant-shared approval queue
- content calendar coordination
- memory review for tenant-shared creative preferences

### Admin/Support Console

The admin/support console should default to diagnostics:

- Content route health
- model/provider metadata without raw prompt/context
- extraction/indexing status
- source broken/stale counts
- failed generation and workflow transition counts
- approval backlog counts
- radar/scheduler job health
- tenant-safe error metadata

Raw content access should require a separate audited support workflow.

## Required Portal Contract Additions

The portal needs read APIs or dashboard sections for:

- content domain objects with lifecycle and approval state
- reference registry with freshness/confidence/trust/broken/stale status
- output provenance with grounding and unsupported claims
- radar signals with scoring, novelty, duplicate risk, and conversion state
- content memory with scope, confidence, freshness, correction history
- content reuse lineage and novelty warnings
- Secretary schedule decisions for content work
- content calendar items and publishing deadlines

## Portal Smoke Matrix

| Scenario | Status | Notes |
|---|---|---|
| Portal manages books | Backend scoped; not browser-smoked | Tenant/user-scoped admin API exists and is tested; visible portal UI workflow and browser smoke remain missing. |
| Portal manages links | Backend scoped; not browser-smoked | Tenant/user-scoped admin API exists and is tested; visible portal UI workflow and browser smoke remain missing. |
| Portal manages channels | Backend scoped; not browser-smoked | Tenant/user-scoped admin API exists and is tested; non-default tenant synthesis remains blocked until agent scope support lands. |
| Portal edits content agent settings | Partial | Radar pillars/voice synth exist; no unified agent config. |
| Portal shows lifecycle states | Blocked | Backend has workflow states, portal UI does not render them. |
| Portal shows source/provenance | Backend-ready | Review-pack contract exists; portal UI/browser smoke still missing. |
| Portal approval workflow | Blocked | Backend approval records exist, portal UI missing. |
| Tenant switch does not leak references | Blocked | Needs User/Tenant Console scoping and smoke. |
| Unauthorized user cannot see private draft | Not proven | Needs backend route and portal policy tests. |
| Portal sends `x-nexus-user-id` / `x-nexus-tenant-id` on V1 admin content writes | **PASS** (2026-05-04 vertical slice) | `apiFetch` wrapper attaches headers when `isContentScopedRoute(url)` matches. Self-tested via 3 Node assertions: (a) no scope → no headers; (b) scope active + content path → headers present; (c) scope active + non-content path → no headers (legacy paths preserved). Browser smoke + write round-trip is the next gate. |
| Portal exposes a tenant scope picker on Content tab | **PASS** (2026-05-04) | New "Tenant Scope" card at the top of `data-section="content"`; persists to `localStorage` (`nexus-portal-content-scope-v1`); numeric input validation; Apply/Clear actions reload the dashboard. |
| Portal Content Profile editor (pillars/audience/voice/banned topics/sources) | iOS-only PASS / portal Blocked | iOS round-trip via `GET/PUT /api/v1/content/creator-profile` is shipped (CONTENT-UI-O1). Portal-side editor for the same profile is a follow-up — backend route works for both surfaces. |
| Portal performance dashboard (what worked / underperformed) | **PASS** (2026-05-04 CONTENT-UI-O3) | `getContentPerformanceAggregate` aggregates topics + scripts + radar feedback by tenant; admin route `GET /api/v1/admin/content/performance`; portal Performance card with KPI strip + highlights + warnings + top accepted/rejected topics. 8/8 backend tests PASS. |
| Portal full ideas pipeline kanban (12-stage lifecycle) | **PARTIAL PASS** (2026-05-04 CONTENT-UI-O4) | Canonical 12-bucket lifecycle band visible inside the Content Pipeline card on the portal (read-only) + on iOS `PipelineDetailView`. Backed by `summarizeCanonicalLifecycle` mapper over existing `content_topics`, `saved_ideas`, and `content_radar_feedback` tables. Native 12-stage transitions on the underlying data is the remaining follow-up; the read view is canonical now. |
| Portal browser-runtime smoke (scope picker + scope-aware apiFetch) | **PASS validate-only** (2026-05-04 CONTENT-UI-O5) | `scripts/content-portal-browser-smoke.mjs --validate-only` — 31/31 structural + JS-presence assertions PASS. Live Playwright mode available for runtime verification when backend is booted. |
| iOS per-card Radar accept/reject/save/create-brief actions | **PASS** (2026-05-04 CONTENT-UI-O2) | `POST /api/v1/content/radar/feedback` endpoint + iOS per-card buttons + confirmation/Undo/error chips. 13/13 backend tests PASS. |
| iOS Brief editor (objective/audience/platform/format/angle/sources/main points/claims/CTA/constraints/deadline/approval owner) | **PASS** (2026-05-04 CONTENT-UI-O6) | `ContentBriefEditorView` + `ContentBriefLocalStore` + offline-first round-trip through `POST /api/v1/content/workflow/:id/actions` when a content_object id is attached. Standalone-draft mode supported when no underlying object exists. |
| iOS Topic Scheduler week-view grid | **PASS** (2026-05-04 CONTENT-UI-O7) | 7-column week-grid (current + next 3 weeks), status-tinted chips, today highlight, mode picker toggle to legacy list view. |

## Release Recommendation

Keep the existing Content portal as an operator dashboard only. Build a separate tenant-safe Content power console before exposing upgraded Content Creation workflows to tenant admins or users through the portal.
