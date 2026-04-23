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

### ~~OI-DATA-003 — Skill configuration storage~~ [DONE · 2026-04-22 — Content skill only (v1)]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Infrastructure + first skill shipped. Secretary / Training / Finance / Cooking configuration UIs remain honest empty-state link-outs — per-skill schema decisions are a product call and land in follow-ups (OI-DATA-003a..d).

What's live:

- **Migration 080** — `tenant_skill_config` table. One row per `(tenant_id, skill_id)` carrying a JSON `config_json` blob. This is Option-B from the original sketch (key-per-row was rejected: UX saves the whole form at once, so atomic single-row update matches the intent; per-field audit history is tracked as OI-DATA-003e if ever needed).
- **Service** — `src/services/tenant-skill-config-service.ts` with a per-skill validator registry. Each skill declares a TypeScript `Record<fieldKey, FieldValidator>`; storage is generic JSON but unknown keys are refused at the service layer. **Content** has a real schema (6 fields — voice_guidelines, default_platform, output_length, include_references_policy, auto_publish, extra_notes). The other 4 skills have empty schemas so any PUT field returns 400 with a clear "no configurable fields yet" message.
- **Routes** — `GET /workspace/skills/:skillId/config` (any member; returns stored config merged over schema defaults so the UI always sees a populated form) and `PUT /workspace/skills/:skillId/config` (tenant_admin only, via `requireTenantAdmin`). PUT accepts nested `{ config: {...} }` OR flat body. Writes trigger a `tenant.skill_config.update` audit row carrying `keysTouched` but **never** the raw values — voice guidelines can be long, personal, and shouldn't leak through the audit table.
- **Home payload** — new `content.voice.guidelines` dependency. Missing when voice_guidelines is empty/null; ready when it's filled. CTA `#/skills/content/configuration` deep-links to the editor. Auto-heals on save.
- **UI** — Content skill Configuration tab replaces the "edit in iOS" empty state with a real editor: textarea for voice guidelines, 3 enum dropdowns, a checkbox for auto_publish, an extra_notes textarea. Same dirty-state / Revert / Save / diff-only PUT pattern as the OI-USR-407 Profile editor. Non-admins see the form fields disabled with a visible "ask a tenant_admin to change these" note; Save/Revert hidden.

SECURITY notes:
- **Audit log redaction.** The `tenant.skill_config.update` audit row's details blob contains `keysTouched: [...]` but never the values — test-pinned (a "Top-secret voice rule" test plants a known string and asserts `JSON.stringify(details).not.toContain(value)`).
- **WRITE guard.** `requireTenantAdmin` at the route layer blocks tenant_member and tenant_viewer from PUT — test-pinned for both roles.

Tests: 58 new pins across 3 files (all green).
- `__tests__/services/tenant-skill-config-service.test.ts` (24): schema registry, Content round-trip, diff patches, enum/length/type validation, empty-schema skills rejection, isolation, unknown skill.
- `__tests__/api/portal-workspace-skill-config-routes.test.ts` (14): GET+PUT + auth chain, tenant_viewer read access, admin-only write (403 for member/viewer), nested+flat body shapes, unknown field 400, audit values-not-leaked, Home dependency flips ready/missing on save/clear.
- `__tests__/portal/user-console-content-config.test.ts` (20): markup, 6 input ids, enum option presence, dirty tracking, diff-only PUT, post-save re-baseline, loadHome refresh, non-admin disable+hide pattern.

Follow-ups (one per remaining skill):
- ~~**OI-DATA-003a** — Secretary schema~~ **DONE 2026-04-23.** 6-field schema (daily_routines, priority_rules, focus_block_policy, primary_calendar, interruption_tolerance, extra_notes) — same shape as Content. Configuration tab now a real editor. New Home dependency `secretary.routines.set` auto-heals when daily_routines is filled. 35 new regression tests (12 service + 5 route + 18 UI). See the "Secretary editor" note below for the full resolution.
- ~~**OI-DATA-003b** — Training schema~~ **DONE 2026-04-23.** 6-field schema (goals, equipment_available, constraints_and_injuries, preferred_training_days, recovery_priority, extra_notes). Configuration tab now a real editor. New Home dependency `training.goals.set` auto-heals when goals is filled. 35 new regression tests (12 service + 5 route + 18 UI). Forward-compatible with the Phase 1 triathlon→gym/running/cycle/swim split: sub-skills will carry their own `tenant_skill_config` rows under new skill ids and inherit this shape.
- ~~**OI-DATA-003c** — Finance schema~~ **DONE 2026-04-23.** 6-field schema (budget_monthly, saving_goals, affordability_rules, primary_currency, decision_style, extra_notes). Configuration tab now a real editor. New Home dependency `finance.budget.set` auto-heals when `budget_monthly` is filled. 35 new regression tests (12 service + 5 route + 18 UI). Currency enum covers the 5 big majors + 'other' escape hatch — full ISO-4217 coverage is a future enhancement.
- ~~**OI-DATA-003d** — Cooking schema~~ **DONE 2026-04-23 — COMPLETES THE 5/5 PER-SKILL-CONFIG ARC.** 6-field schema (dietary_restrictions, preferences, kitchen_inventory, serving_size, meal_cost_ceiling, extra_notes). Configuration tab now a real editor. New Home dependency `cooking.restrictions.set` — deliberately gated on the HARD constraint (`dietary_restrictions`), not `preferences`, because allergies can be dangerous and Cooking should never plan a meal blind. 36 new regression tests (12 service + 5 route + 19 UI). Also removed the now-obsolete `EMPTY_SCHEMA` constant from the service + the entire "empty-schema skills" describe block from the base test file (3 tests) since no skills remain empty. **All 5 skills (Content, Secretary, Training, Finance, Cooking) now ship real Configuration editors backed by the `tenant_skill_config` infrastructure from OI-DATA-003.**
- **OI-DATA-003e** — per-key audit history (only if product asks for it; not worth the schema complexity on spec alone).

#### OI-DATA-003a — Secretary editor resolution note

Secretary's Configuration tab is now a real editor mirroring Content's shape. Schema:

| Field | Type | Notes |
|---|---|---|
| `daily_routines` | string ≤4000 | Largest field — morning/evening rituals that anchor Secretary's scheduling. |
| `priority_rules` | string ≤2000 | Plain-English rules like "Felipe > family > email". |
| `focus_block_policy` | enum(5) | `none` / `mornings` / `afternoons` / `all_day` / `custom`. |
| `primary_calendar` | enum(4) | `google` / `outlook` / `icloud` / `none` — informational (actual integration is OAuth). |
| `interruption_tolerance` | enum(3) | `low` / `medium` / `high` — controls nudge aggressiveness. |
| `extra_notes` | string ≤2000 | Safety valve — same pattern as Content. |

Home dependency: `secretary.routines.set` = `missing` when `daily_routines` is empty/null; `ready` otherwise. CTA `#/skills/secretary/configuration`.

Tests added on this pass:
- `__tests__/services/tenant-skill-config-secretary.test.ts` (12 pins): enum validation, length caps, empty-string→null, diff patches, unknown-field 400 with the 6-field allowed list.
- `__tests__/api/portal-workspace-secretary-config-routes.test.ts` (5 pins): GET defaults, PUT wrong-skill field rejection, Home dep flip missing→ready→missing on set/clear, cost-privacy invariant pinned.
- `__tests__/portal/user-console-secretary-config.test.ts` (18 pins): legacy empty-state gone, 6 input ids, enum options, Save/Revert/dirty wiring, diff-only PUT, post-save re-baseline, loadHome refresh, non-admin view-only mode, Content editor not regressed.

Pre-existing tests updated (not new): `__tests__/services/tenant-skill-config-service.test.ts` — the "Content + other-skills-have-0" assertion now expects Secretary to have 6 fields. Training/Finance/Cooking still empty.

---

### OI-DATA-004 — Real insight engine [P2, Data]

**What's missing.** The MVP insight generators are deterministic (one insight per missing dependency, one per incomplete setup). Real insights — "you haven't generated content in 14 days", "your running volume dropped 30% week-over-week", "cooking and training calorie estimates diverge" — require cross-skill signal aggregation.

**Unblocks.** The Insights page becoming genuinely proactive.

**Sketch.** Wire `src/services/intelligence-bus.ts` to emit signals from each skill invocation. Add `insight_generators/*.ts` that subscribe and produce rows in `user_insights`. Dismissal lifecycle: promote localStorage-based dismissal to `user_dismissed_insights`.

---

### ~~OI-DATA-005 — Audit-trail tenant scope filter~~ [DONE · 2026-04-22]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

User Console → Activity now shows a real filtered audit feed. The dual-purpose work:

1. **New endpoint** — `GET /workspace/activity` with query params `?actor=&action=&from=&to=&limit=<=200&offset=`. Scopes via the same dot-prefix convention as OI-ADM-301 (`resource = 'tenant.<id>'` OR `resource LIKE 'tenant.<id>.%'`). Tenant 4 can never match tenant 42 — boundary test-pinned. Actor, action (exact OR trailing-`*` prefix), date range, pagination. LIKE-wildcard escape + 128-char length cap on text inputs (shared defense pattern with OI-ADM-303).

2. **Resource-delete audit writes** — four new `writeWorkspaceAudit` call sites (book / note / link / channel delete). Each captures the row title BEFORE the delete so the audit carries human-readable detail. Details blob includes `{tenantId, <type>Id, title, ...}`. Create / update are intentionally NOT audited yet — they'd flood the feed in normal use; delete is the high-value/low-noise entry point (flagged as OI-DATA-005a for future extension).

3. **UI wiring** — the Activity page replaces the legacy empty-state with a real filter form + table + pager. Each row expands inline to show the `details` JSON. Reuses the audit-row CSS pattern from admin-console.html (injected client-side to avoid duplicating between two HTML files).

**Access control.** `tenant_viewer` CAN read the feed — the events describe shared tenant state, so visibility mirrors the resource tables themselves (viewer reads books/links/notes; viewer reads audit of deletes). Explicitly pinned.

Tests (29 new, all green):
- `__tests__/api/portal-workspace-activity-routes.test.ts` (16): empty + populated reads, auth, tenant-scope + dot-prefix boundary (tenant.4 ≠ tenant.42.*), cross-tenant 403, tenant_viewer read access, actor/action/prefix/date-range filters, LIKE-injection defense, length cap, clamp, pagination, cost-privacy, and DELETE-on-each-resource-writes-audit.
- `__tests__/portal/user-console-activity.test.ts` (13): filter inputs, lazy-load, URLSearchParams query build, datetime T→space normalization, pagination wiring, row expand/collapse, empty-state correct.

Follow-ups still open:
- **OI-DATA-005a** — write audit rows on resource CREATE + UPDATE (today only DELETE writes). Would require a per-tenant rate limiter or ring buffer to avoid flooding.
- **OI-DATA-005b** — join audit with the current user row to show actor name/email in the feed (today we show `by #<id>` since audit_trail stores only ids).
- **OI-DATA-005c** — saved filter presets (localStorage), same pattern as OI-ADM-303b.

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

### ~~OI-UX-101 — Global search~~ [DONE · 2026-04-22 — User Console only]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Spotlight-style global search shipped on **both** the User Console (original OI-UX-101) and the Admin Console (OI-UX-101a, 2026-04-22).

What's live:
- **Trigger**: app-bar button with a platform-aware kbd hint (⌘K on Mac, Ctrl+K elsewhere).
- **Keyboard**: Cmd/Ctrl+K toggles; ArrowDown/ArrowUp navigate; Enter picks; Esc closes. Focused item scroll-into-view.
- **Sources**: PAGES_INDEX (16 nav destinations, always available) + `state.books / channels / links / notes / members` + `activityState.lastRows`. Each collection only appears in results if the user visited its tab at least once.
- **Match**: simple `String.indexOf` substring on title + one secondary field (author / url / body). Hits highlighted with `<mark>`. No regex, no fuzzy library dependency — fast and predictable for workspaces ≤500 items.
- **Honest empty state**: when the user searches and some collections are empty because a tab wasn't visited, a banner says exactly which tabs to open to widen the search.
- **Pick action**: routes via the shell's `showPage()`. The user lands on the result's tab; the exact row becomes visible on that page.

Tests: `__tests__/portal/user-console-global-search.test.ts` — 19 structural + behavior pins (markup, Cmd/Ctrl key handling, ArrowUp/Down/Enter/Esc, platform-aware kbd label, 16 pages indexed, substring match no regex/fuzzy, `<mark>` highlight, showPage dispatch, banner when collections are unindexed, plural/singular result count).

Follow-ups still open:
- ~~**OI-UX-101a** — port the search to Admin Console~~ **DONE 2026-04-22.** Admin Console spotlight indexes 11 pages + `state.tenants` + `state.platformAdmins` + `state.inactiveTenants` (adoption risk from /owner/console/overview) + `auditState.lastRows`. **Command-palette polish**: tenant hits deep-link to the tenant detail drawer (OI-ADM-301) instead of merely navigating to the Tenants page — searching is the fastest way to drill into any tenant. Required a small state-caching refactor so `loadTenants` / `loadPlatformAdmins` / `paintOverview` capture into `state.*`; the prior implementations rendered inline without caching. 25 new regression pins (markup, keyboard, 11 pages, 4 result groups, tenant-drawer deep-link, state caching).
- **OI-UX-101b** — promote to server-side search when any collection exceeds ~500 rows (today we ship what's loaded; scale is the gate).
- **OI-UX-101c** — warm pre-fetch on first open (load collections the user hasn't visited yet so the first search is fully indexed). Trade-off: adds latency on open; not worth it until scale forces it.

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

### ~~OI-USR-401 — Skill config editor~~ [DONE · 2026-04-22 — Content skill only (v1)]

Closed alongside OI-DATA-003 — see that entry for the full resolution note. The Content skill Configuration tab is now a real editor; Secretary/Training/Finance/Cooking configs are tracked as per-skill follow-ups (OI-DATA-003a..d).

---

### ~~OI-USR-402 — Activity feed~~ [DONE · 2026-04-22]

Closed alongside OI-DATA-005 — the Activity page now renders a real filtered feed backed by `GET /workspace/activity`. See OI-DATA-005 for the full resolution note and OI-DATA-005a/b/c for remaining follow-ups.

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

### ~~OI-USR-405 — Reference-to-skill assignment UI~~ [DONE · 2026-04-23]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

All 4 reference types (books / channels / links / notes) now have an explicit "Used by skills" UX. Zero backend change — rides on the existing `tags` arrays using a `skill:<id>` namespace convention (`skill:content`, `skill:secretary`, `skill:training`, `skill:finance`, `skill:cooking`).

Three layers of UI support:

1. **Create forms** — a new "Used by skills (optional)" row below each Add form with a checkbox chip per skill. Selecting checkboxes adds the corresponding `skill:<id>` tag to the outgoing `tags` array on POST. Post-save, checkboxes reset.

2. **Table rows** — each row now has a dedicated "Used by" column (books / channels / links) or inline badges (notes) showing skill chips. The plain "Tags" column strips `skill:*` entries so the same tag never renders twice. Visual distinction: skill chips use the orange accent palette; regular tags stay muted grey.

3. **Filter dropdowns** — each of the 4 reference pages has a new "Filter by skill" dropdown next to the existing search/status filters. Client-side filter via `rowMatchesSkill(tags, skillId)`.

SECURITY: `parseSkillTags` only lifts `skill:<id>` entries to the "Used by" display when `id` is in the static `SKILL_IDS` allowlist. A user who types a raw `skill:evil` into the tags field gets a plain gray tag, not a rendered chip. `renderSkillBadges` HTML-escapes the label before interpolation. `renderSkillPicker` escapes checkbox value + label.

Tests: 32 structural + behavior pins in `__tests__/portal/user-console-ref-skill-tags.test.ts` covering helper functions, 4 forms × skill-picker, 4 filter dropdowns, create-function merge + reset, render split (skill badges vs regular tags), rowMatchesSkill filter, security pins (esc on label, SKILL_IDS allowlist gating).

Follow-ups still open:
- **OI-USR-405a** — edit-mode UI (today you can tag on create; editing an existing reference's skills requires the backend PATCH + a modal). Low-value: users can delete and re-add to change skill tags.
- **OI-USR-405b** — automatic skill-tag inference from the reference content (e.g. a book titled "Atomic Habits" auto-suggests `skill:content`). Needs an ML hook; tracked separately.
- **OI-DATA-001 interaction** — once reference-usage tracking ships (OI-DATA-001), the "Used by skills" labels can be split into "Tagged by user" vs "Used by pipeline", showing both explicit intent and observed usage.

---

### OI-USR-406 — In-UI invite expiry countdown [P3, UX]

**What's missing.** Invites have `expires_at`; the team table shows the timestamp but not a relative countdown. Inherited from OI-UX-002 in the hardening open-items.

---

### ~~OI-USR-407 — Profile editor~~ [DONE · 2026-04-22]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Profile page is now a real editor for 6 fields: `firstName`, `lastName`, `username`, `avatarUrl`, `language`, `timezone`. The backend `PATCH /workspace/profile` endpoint already existed from Phase 1 (accepts any subset of the 6 fields, each `string | null`, trim+cap at 256 chars). This pass wires the UI that consumes it.

UX details:
- **Read-only identity card** — email, tier, user id. Email-change needs re-verification and tier is plan-assigned; neither belongs in this editor.
- **Baseline-vs-current dirty tracking.** Save and Revert both disable when no changes are pending. `profileBaseline` holds the last-saved values and is updated on successful save so Revert always means "undo my unsaved changes", not "reset to some historical point".
- **Diff-only PATCH** — only fields the user actually changed are sent. Smaller payload; also race-friendly (if I never touched `username`, I can't accidentally overwrite a concurrent update from iOS).
- **Empty string → `null`.** Users clearing a field persist as `NULL` in the DB rather than `""` — matches nullable-column semantics and keeps the GET round-trip clean.
- **Browser detection helpers** — "Detect from browser" buttons for Language (`navigator.language`) and Timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). Free-form inputs remain so power users can override.
- **Context-strip refresh** — Save triggers `loadMe()` after PATCH so the "You are <Name>" header at the top of the console updates without a full reload.

Tests: `__tests__/portal/user-console-profile-editor.test.ts` — 17 structural + behavior pins (markup, Save/Revert/dirty-state, diff-only payload, empty→null conversion, post-save re-baseline, loadMe-after-save refresh, input-listener binding, browser-detect wiring, legacy empty-state removed).

Follow-ups still open:
- **OI-USR-407a** — avatar image upload (today only a URL input; file upload needs a storage backend).
- **OI-USR-407b** — server-side validation for language (ISO 639-1) and timezone (IANA). Today the backend accepts any string ≤ 256 chars.
- **OI-USR-407c** — username uniqueness check (today two users can hold the same username since the column isn't `UNIQUE`). Product-decision: is username user-visible enough to need a unique constraint?

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
