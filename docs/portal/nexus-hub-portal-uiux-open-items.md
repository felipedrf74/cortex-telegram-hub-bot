# Nexus Hub Portal UI/UX — Open Items

**Branch:** `feature/nexus-hub-portal-uiux-admin-user-console`
**Date:** 2026-04-22
**Companion:** `nexus-hub-portal-uiux-final-report.md`

This document tracks everything that was **intentionally out of scope** for the UI/UX architecture pass, organized by theme. Each item has a severity and, where relevant, a sketched next step.

Legend: **P1** near-term, **P2** next pass, **P3** eventual. **Data** = requires backend/schema work before the UI can be honest. **UX** = pure front-end polish. **Product** = requires a product call.

---

## 1 · Backend data dependencies (unlock future UX)

### OI-DATA-001 — Strategy-2 reference usage tracking [P2, Data]

**What's missing.** Each skill invocation should record which references (books, channels, links, notes) it pulled. Today we only have user tagging (`skill:content` on a book) — implicit usage is not tracked. Downstream impact: we can't say "your book Atomic Habits was used in 7 Content runs last month" or "these 3 books have never been used by any skill — consider archiving".

**Unblocks.** Richer insights ("unused references", "top-performing references"), better admin cohort analytics, auto-tagging suggestion.

**Sketch.** Add a `reference_usage (id, reference_id, skill_id, tenant_id, invocation_id, ts)` table; instrument the prompt pipeline in `src/domains/*` to append a row per reference pulled.

---

### OI-DATA-002 — Channels not tenant-scoped [P1, Data]

**What's missing.** `tenant_books`, `tenant_content_notes`, `tenant_links` all scope by `tenant_id`. Channels live in a per-user `channels` table (migration 047-ish) and have no tenant scoping. Result: the Reference Center → Channels tab currently renders an honest empty state that points to `/portal` for channel management.

**Unblocks.** True tenant-shared channel management, channel-as-reference in skill dependency panels.

**Sketch.** New migration `079_tenant_channels.sql` mirroring 078's resource model. Promote channels handler from `server.ts /api/channels` into `tenant-resource-service.ts`. Add CRUD routes under `/workspace/channels`.

---

### OI-DATA-003 — Skill configuration storage [P1, Data]

**What's missing.** The Content skill's `Configuration` tab (voice guidelines, output preferences, brand notes) cannot be edited in the portal today because the backing storage isn't a clean tenant_settings key/value. Edits live in scattered places (some in iOS user prefs, some in prompt files).

**Unblocks.** Real configuration editor on every skill page. Today each skill page renders an honest empty state that points to iOS.

**Sketch.** Schema: `tenant_skill_config (tenant_id, skill_id, key, value_json, updated_by, updated_at)`. Service: `tenant-skill-config-service.ts`. Routes: `GET/PUT /workspace/skills/:skillId/config`. Use a schema-per-skill validator so the UI can render typed inputs.

---

### OI-DATA-004 — Real insight engine [P2, Data]

**What's missing.** The MVP insight generators are deterministic (one insight per missing dependency, one per incomplete setup). Real insights — "you haven't generated content in 14 days", "your running volume dropped 30% week-over-week", "cooking and training calorie estimates diverge" — require cross-skill signal aggregation.

**Unblocks.** The Insights page becoming genuinely proactive.

**Sketch.** Wire `src/services/intelligence-bus.ts` to emit signals from each skill invocation. Add `insight_generators/*.ts` that subscribe and produce rows in `user_insights`. Dismissal lifecycle: promote localStorage-based dismissal to `user_dismissed_insights`.

---

### OI-DATA-005 — Audit-trail tenant scope filter [P1, Data]

**What's missing.** The User Console → Activity page can't yet render because `audit_trail` uses `user_id` ambiguously — sometimes it's the actor, sometimes the target tenant. On workspace mutations (fix #2 from the hardening pass) we write both `user_id = tenantId` and `actor_id = acting user`, so the data is there — we just need a stable query helper.

**Unblocks.** Tenant-scoped activity feed with filters.

**Sketch.** New service helper `listAuditForTenant(tenantId, {actor?, action?, from?, to?, limit?})`. Route `GET /workspace/activity`. Keep the raw audit table unchanged.

---

### OI-DATA-006 — Platform-curated reference library [P2, Data]

**What's missing.** Admin Console → References currently links out to the legacy `books` surface. A real "platform library" that tenants can fork into their own libraries needs a separate `platform_library` table plus a "copy to my library" action on each row.

**Unblocks.** Platform-wide curation of recommended reading / channels, onboarding default library.

---

### OI-DATA-007 — Integration status per tenant [P2, Data]

**What's missing.** Admin Console → Integrations and User Console → Integrations both render empty states. The data — OAuth tokens, last-sync times, error counts — exists in `oauth_tokens`, `garmin_auth_state`, etc., but there's no consolidated read endpoint.

**Unblocks.** "Show me every integration and its health" view for both planes.

**Sketch.** `GET /workspace/integrations` and `GET /owner/integrations` aggregating from existing oauth_* tables.

---

## 2 · UX polish (no backend needed)

### OI-UX-101 — Global search [P2, UX]

**What's missing.** The app-bar has a reserved slot for global search, unwired on this branch. Should scope-aware: in Admin Console it searches tenants/users/audit; in User Console it searches references/skills/insights.

**Sketch.** Client-side fuzzy search over the already-loaded state (books, links, notes, tenants, audit). Promote to server search when any collection exceeds ~500 rows.

---

### OI-UX-102 — Reference tag editor [P2, UX]

**What's missing.** Today the book/link/note forms accept a `tags` comma-separated input. A proper tag editor with autocomplete (pulled from existing tag set) would make tagging adopt more consistently.

---

### OI-UX-103 — Bulk actions on reference tables [P2, UX]

**What's missing.** Select-many + bulk-tag, bulk-delete, bulk-re-status. Relevant once a tenant has >50 books/links/notes.

---

### OI-UX-104 — Skill-name label map in dropdowns [P3, UX]

**What's missing.** Book status dropdown shows raw `want_to_read` / `reading`. Should render as "Want to read" / "Reading" etc. Same for role selectors (`tenant_admin` → "Admin"). Small polish; inherited from the OI-UX-003 item in the hardening open-items.

---

### OI-UX-105 — Keyboard navigation [P2, UX]

**What's missing.** Tab-reachability is OK for forms; but keyboard shortcuts for power users (g h = go home, / = focus search, j/k = navigate table rows) would match the "density-first power console" framing.

---

### OI-UX-106 — Responsive collapse for < 768 px [P3, UX]

**What's missing.** Sidebar collapse is only at < 1024 px. Below 768 px the shell would become cramped. Spec acknowledges iOS is for small viewports, so this is low priority.

---

### OI-UX-107 — Dark/light theme toggle [P3, UX]

**What's missing.** Dark-only today. Some users prefer light UIs during the day. Trivial to add with CSS custom property swaps.

---

## 3 · Navigation & routing

### OI-NAV-201 — Promote `/admin-console` → `/admin` [P1, gate]

**What's missing.** On this branch, `/admin` still serves the legacy dashboard (portal.html). The new shell is at `/admin-console`. Flipping the alias is an explicit post-review step to avoid breaking platform-admin bookmarks and external monitors that hit `/admin`.

**Gate.** Human review signs off, then: change the `/admin` alias to serve `admin-console.html`, and redirect `/admin/legacy` or keep `/portal` as the pinned legacy entry.

---

### OI-NAV-202 — Hash-routing deep links [P2, UX]

**What's missing.** The User Console SPA uses `showPage(id)` state but doesn't currently update `location.hash`. That means reloading on `/console#/skills/content/references` lands on Home, not on that sub-tab. Sitemap calls out this shape as the intended behavior.

**Sketch.** On `showPage`, `location.hash = '/' + id`. On load, parse `location.hash` and call `showPage`.

---

### OI-NAV-203 — `/invite/accept?code=` landing page [P1, UX]

**What's missing.** The Team → Invite flow generates a link `{origin}/invite/accept?code=XYZ` but that URL isn't wired yet. Clicking it 404s.

**Sketch.** A thin `invite-accept.html` that pulls `?code` from the URL, prompts for iOS JWT, POSTs to `/workspace/my-invites/:code/accept`, and redirects to `/console`.

---

## 4 · Admin Console feature gaps

### OI-ADM-301 — Tenant detail drill-in [P1, UX]

**What's missing.** `/admin-console` Tenants tab shows the list but rows are not yet click-through to a detail drawer. The `/owner/tenants/:tenantId` endpoint exists; wiring the drawer is UI-only work.

**Sketch.** Drawer with tabs: Details / Members / Usage / Audit. Reuses existing `/owner/tenants/:tenantId/*` endpoints.

---

### OI-ADM-302 — Tenant suspend action [P1, UX + Data]

**What's missing.** There's no "Suspend tenant" action on either endpoint — only per-user suspend via `POST /api/users/:userId/suspend`. A tenant-level suspend would be the operational primitive for platform ops.

**Sketch.** Add `POST /owner/tenants/:tenantId/suspend` that cascades to all users in the tenant. Requires careful audit row + reversible state.

---

### OI-ADM-303 — Admin audit viewer with filters [P1, UX]

**What's missing.** Admin Console → Security currently shows the last 10 audit events from /owner/console/overview. A proper filtered viewer (actor, action, date range, tenant) is needed.

**Sketch.** `GET /owner/audit?filter=...&limit=100`. Extend `admin-console.html` with the viewer, reuse the drawer pattern.

---

### OI-ADM-304 — Cohort analytics on Skills [P2, Data+UX]

**What's missing.** Admin Console → Skills renders an empty-state link-out to legacy. A real "of N tenants with Content skill enabled, M are missing a primary channel" view needs cohort aggregation over the dependency evaluator.

---

### OI-ADM-305 — Consolidated integration health [P2, Data+UX]

**What's missing.** See OI-DATA-007.

---

## 5 · User Console feature gaps

### OI-USR-401 — Skill config editor [P1, Data+UX]

**What's missing.** See OI-DATA-003.

---

### OI-USR-402 — Activity feed [P1, Data+UX]

**What's missing.** See OI-DATA-005. The page renders an empty state today.

---

### OI-USR-403 — Integration status panel [P1, Data+UX]

**What's missing.** See OI-DATA-007.

---

### OI-USR-404 — Onboarding wizard [P2, UX]

**What's missing.** Setup-progress milestones are visible on Home but there's no guided wizard for first-time tenant admins. A 3-step walkthrough (tenant name / add a book / invite teammate) would improve activation.

---

### OI-USR-405 — Reference-to-skill assignment UI [P2, UX]

**What's missing.** Tagging a reference with `skill:content` works but isn't obvious from the UI. A "Used by skills" multi-select on each reference card would make the relationship explicit.

---

### OI-USR-406 — In-UI invite expiry countdown [P3, UX]

**What's missing.** Invites have `expires_at`; the team table shows the timestamp but not a relative countdown. Inherited from OI-UX-002 in the hardening open-items.

---

### OI-USR-407 — Profile editor [P2, UX]

**What's missing.** Profile page renders read-only. Edits still go through iOS. A minimal editor (name, avatar URL, timezone) is low-risk to add.

---

## 6 · Dependencies / References / Insights model gaps

### OI-MODEL-501 — Dependency catalog completeness [P2, Data]

**What's missing.** The MVP catalog in `/workspace/console/home` models 4 dependencies (3 content + 1 team). The full catalog in `nexus-hub-portal-uiux-dependencies-and-insights-model.md` §2.2 enumerates ~20 across 5 skills. Filling the rest requires reading status from provider-specific tables (oauth_tokens for Google, garmin_auth_state, etc.) plus user_prefs keys.

**Sketch.** A per-skill evaluator plugin (`src/services/dependency-evaluators/content.ts`, `/secretary.ts`, etc.). Each returns an array of Dependency objects. The endpoint composes all of them.

---

### OI-MODEL-502 — Insight dismissal lifecycle [P2, Data]

**What's missing.** The UI shows dismiss-x buttons but dismissal today would be client-only. Server-side dismissal (so dismissals sync across devices and re-surface on condition change) needs the `user_dismissed_insights` table.

---

### OI-MODEL-503 — Cross-skill insight cluster [P3, Data]

**What's missing.** "You're behind on Training AND Cooking this week — both depend on Secretary being configured" is the kind of multi-skill synthesis the intelligence-bus enables, but the UI doesn't yet render clustered insights.

---

## 7 · Testing

### OI-TEST-601 — E2E test for `/admin-console` boot + navigation [P2, Testing]

**What's missing.** Today we have unit tests for the new endpoints but no end-to-end (Playwright / Puppeteer) validation that the admin-console.html loads, authenticates, and switches pages without errors.

---

### OI-TEST-602 — E2E test for User Console skill-page navigation [P2, Testing]

**What's missing.** Same as above for `/console`.

---

### OI-TEST-603 — Accessibility audit (axe) [P2, Testing]

**What's missing.** No automated a11y check. Both new shells should be axe-clean.

---

## 8 · Pre-existing failures (not introduced by this branch, tracked for visibility)

### PRE-EX-101 — `content-intelligence-detail.test.ts` failing [baseline]

Confirmed pre-existing on baseline `3500470`. Owner: content-intelligence team.

### PRE-EX-102 — `content-intelligence-summary.test.ts` failing [baseline]

Confirmed pre-existing on baseline `3500470`. Owner: content-intelligence team.

Both failures were already documented in the hardening open-items and persist unchanged here.

---

## 9 · Deferred / nice-to-have

- **OI-DEF-901** — Command palette (`⌘K`). Search + action-trigger across the whole console.
- **OI-DEF-902** — Export reference library to CSV / Markdown.
- **OI-DEF-903** — Audit row redaction UI for GDPR requests.
- **OI-DEF-904** — Webhook event stream viewer in Admin Console (legacy has a raw stats view).
- **OI-DEF-905** — First-class "API tokens for iOS/CLI" management in User Console → Profile.
- **OI-DEF-906** — Plan / entitlement surface (tenant plan tiers, quota progress) — currently all tenants are effectively free-tier.
- **OI-DEF-907** — Tenant-level "Transfer ownership" flow. Today, making someone else the last admin requires two admins + a manual swap.
