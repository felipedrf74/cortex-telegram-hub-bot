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

### ~~OI-DATA-002 — Channels not tenant-scoped~~ [DONE · 2026-04-22]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Shipped the full end-to-end stack:

- **Migration 079** — new `tenant_channels` table with `(id, tenant_id, created_by, title, url, handle, description, kind, status, tags_json, last_fetched_at, created_at, updated_at)`. Enum CHECK constraints on `kind` (generic / rss / youtube / podcast / newsletter / twitter / substack) and `status` (active / muted / archived). Two indexes: `(tenant_id, status, updated_at DESC)` for the default list; `(tenant_id, kind)` for kind filters.
- **Service** — `src/services/tenant-channel-service.ts` mirrors the `tenant-resource-service` pattern (isolation by construction, authorship rule, enum validation). Extra: **HTTP-protocol whitelist on URLs** (`http://` or `https://` only) to prevent `javascript:` / `data:` / `file:` from becoming clickable links downstream.
- **Routes** — 5 endpoints at `/workspace/channels`: `GET /` (with `?status=&kind=&limit=&offset=`), `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`. List default excludes archived; pass `?status=all` to include.
- **Home payload** — `/workspace/console/home` now returns `counts.channels` (active count) + a new `content.channel.primary` dependency row. When no active channels exist, the dependency is `missing` with a CTA pointing at `#/references/channels`; auto-heals to `ready` on first active channel.
- **UI** — Reference Center → Channels tab replaces the old empty-state link-out with a full add-form (title / URL / kind / handle) + searchable / filterable table. Each row has Mute/Unmute + Remove controls. Sidebar badge + Home counts panel both show live channel count.
- **Legacy `channels` table** untouched. The per-user table stays for the content-creator pipeline; tenant-shared channels use the new table. A future migration can unify if the product calls for it.

Tests (41 new, all green):
- `__tests__/services/tenant-channel-service.test.ts` (26): CRUD happy path, enum validation, authorship rule across admin/member/viewer/cross-member, URL whitelist (3 pins: javascript, data, file), tag normalization, list filters, archived exclusion, cross-tenant isolation + existence non-leakage.
- `__tests__/api/portal-workspace-channels-routes.test.ts` (15): HTTP glue, 201 on create, 400 on bad URL, 404 on cross-tenant GET/DELETE (no leak), PATCH explicit-null url handling, home integration with count + dependency, cost-privacy invariant pinned with channels in the mix.
- Existing `/workspace/console/home` tests (12) continue to pass — they were written against dep-set invariants, not cardinality.

Follow-ups still open:
- **OI-DATA-002a** — unify the legacy per-user `channels` table (content-creator pipeline) with `tenant_channels` when the pipeline promotes tenant-awareness. Today they coexist cleanly but conceptually the pipeline should consume the tenant-scoped view.
- **OI-DATA-002b** — channel feed ingestion (populate `last_fetched_at` and surface new items). Today the column exists but nothing writes to it — ingestion is Phase-later work.
- **OI-DATA-002c** — channel health indicators (last fetch success/failure, error rate) on the UI table.

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

### ~~OI-NAV-203 — `/invite/accept?code=` landing page~~ [DONE · 2026-04-22]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**
Shipped `src/portal/invite-accept.html` + `GET /invite/accept` route in `server.ts`.
The landing page:
  1. strips `?code=` from the URL on load (`history.replaceState`) so screenshots / copy-link / browser-history don't carry the live secret;
  2. prompts for an iOS JWT if none is cached in sessionStorage;
  3. POSTs to `/workspace/my-invites/:code/accept`;
  4. handles every documented error shape (NOT_FOUND / EMAIL_MISMATCH / EXPIRED / REVOKED / ALREADY_ACCEPTED / 401 / network) with a bespoke UI state;
  5. on success, persists the newly-joined tenant as `nx.usr.tenantId` so `/console` lands on the right workspace.

Test coverage: `__tests__/portal/invite-accept-route.test.ts` (11 pins, including: no-raw-code-in-initial-HTML, `history.replaceState` called, all 6 error codes branched, masked preview only, route wired with anti-cache + clickjacking headers).

Follow-up items still open:
- **OI-NAV-203a** — queued invitations for users who don't yet have a Nexus account (email link → sign-up path → auto-accept on first login). Today the landing page assumes the invitee has an iOS account + token.
- **OI-NAV-203b** — email delivery of the invite link. Backend is email-agnostic (by design); a minimal transactional-email integration is a product choice, not a UX blocker.

---

## 4 · Admin Console feature gaps

### ~~OI-ADM-301 — Tenant detail drill-in~~ [DONE · 2026-04-22]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Tenant rows in `/admin-console → Tenants` now click through to a slide-in drawer with 4 tabs: **Details · Members · Usage · Audit**. All four tabs fetch in parallel via `Promise.allSettled` so tab switches are instant. ESC / overlay-click / × button close. `aria-labelledby` wires the header to the dialog for screen readers.

Backend: added `GET /owner/tenants/:tenantId/audit` (tenant-scoped audit feed with LIMIT/OFFSET, dot-prefix scoping so tenant 4 never leaks tenant 42's rows).

Tests: 6 pins in `__tests__/portal/admin-console-drawer-audit.test.ts` + 6 pins in `__tests__/api/portal-admin-audit-endpoints.test.ts` covering scope boundary, pagination, auth, error paths.

Follow-ups still open:
- **OI-ADM-301a** — tenant suspend/activate action from the Details tab (depends on OI-ADM-302).
- **OI-ADM-301b** — historical usage slicing in the Usage tab (today we show today-only; a by-day breakdown needs a wider `/owner/usage` endpoint).

---

### OI-ADM-302 — Tenant suspend action [P1, UX + Data]

**What's missing.** There's no "Suspend tenant" action on either endpoint — only per-user suspend via `POST /api/users/:userId/suspend`. A tenant-level suspend would be the operational primitive for platform ops.

**Sketch.** Add `POST /owner/tenants/:tenantId/suspend` that cascades to all users in the tenant. Requires careful audit row + reversible state.

---

### ~~OI-ADM-303 — Admin audit viewer with filters~~ [DONE · 2026-04-22]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Admin Console → Security now hosts a full filtered audit viewer:
- Filters: **actor** (user id), **action** (exact OR `prefix*` wildcard), **from / to** datetime, **resource** free-text search.
- Pagination: 100 rows per page, prev/next, total count displayed.
- Expandable details: click any row to inline-expand the full `details` JSON.
- CSV export: client-side Blob-and-download over the current filter set.

Backend: added `GET /owner/audit` with query-param filters. Defensive hardening:
- LIKE-wildcard characters (`%`, `_`) in user input are escaped with `ESCAPE '\\'` — tested with a `tenant_invite.create` regex-style input that would otherwise have matched `tenant.invite.create` (SQLite `_` = single-char wildcard).
- Length caps on `action` and `q` (128 chars).
- `limit` clamped to 500.
- Trailing `*` → LIKE prefix match with escape-aware left side.

Tests: 12 pins in `__tests__/api/portal-admin-audit-endpoints.test.ts` (actor / action / prefix / LIKE-injection × 2 / date range / combined / clamp / bad input / auth) + 9 pins in `__tests__/portal/admin-console-drawer-audit.test.ts` (filter form / pager / CSV / expand / datetime-T-to-space normalization / showPage wiring).

Follow-ups still open:
- **OI-ADM-303a** — server-side CSV streaming for exports > 500 rows (today the client can only export what's on screen).
- **OI-ADM-303b** — saved filter presets (e.g. "tenant.* from last 24h") — localStorage-backed initially.

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

### ~~OI-USR-404 — Onboarding wizard~~ [DONE · 2026-04-22]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

User Console now ships a 3-step modal wizard that auto-opens on first visit for tenant_admins with incomplete setup, and can be re-launched anytime from the Home Setup panel.

Steps:
1. **Welcome** — explains the portal/iOS divide + shows live setup progress %.
2. **Curate a first reference** — inline tabs for Book / Link / Note with real-time save to `/workspace/books` / `/workspace/links` / `/workspace/content`. Non-coercive: if all forms are empty, user can still advance.
3. **Team or solo** — two big-button choice. "Invite" reveals an inline email+role form that POSTs to `/workspace/invites` and generates the OI-NAV-203 canonical URL. "Solo" just advances — no server call.

Auto-open gate (all four must hold):
- role === `tenant_admin`
- `setup.percent < 100`
- no `nx.usr.onboarded-dismissed` in localStorage
- no `nx.usr.onboarded-skipped` in sessionStorage

Two-tier dismissal:
- **"Skip for now"** or overlay-click → sessionStorage only (re-prompts next session if setup still <100%).
- **"Don't show again"** → localStorage (persistent; use Home button to re-open).

Tests: `__tests__/portal/user-console-wizard.test.ts` — 17 structural pins covering markup, 4-step flow, two-tier dismissal, endpoint wiring, Solo path no-server-call, Home refresh after save.

Follow-ups still open:
- **OI-USR-404a** — role-aware wizard for tenant_member and tenant_viewer (different steps — they can't invite).
- **OI-USR-404b** — wizard progress telemetry (server-side record of which step users drop off at) — requires a small schema + endpoint.

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
