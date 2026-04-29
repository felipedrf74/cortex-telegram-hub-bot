# Content Portal Readiness

Date: 2026-04-29
Branch audited: `qa/nexus-hub-focused-review-selected-areas`
Mode: static portal/backend surface audit plus power-console contract definition. Backend link/book/channel/manual Voice DNA hardening was added after the initial audit; full portal browser/runtime smoke was not run in this batch.

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

## Release Recommendation

Keep the existing Content portal as an operator dashboard only. Build a separate tenant-safe Content power console before exposing upgraded Content Creation workflows to tenant admins or users through the portal.
