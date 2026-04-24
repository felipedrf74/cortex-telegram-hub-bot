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

### ~~OI-UX-102 — Reference tag autocomplete~~ [DONE · 2026-04-23]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Every free-form tag input on the Add forms (Books / Links / Notes — Channels has no such field today) now shows a dropdown of existing tags pulled from `state.books + state.links + state.notes + state.channels` as the user types. Skill tags (`skill:<id>`) are excluded from the pool — those are owned by the skill-picker checkbox UI and would otherwise double-offer.

Design calls:
- **Pool is recomputed per keystroke** (Map<tag, count> over 4 state arrays). Cheap enough at single-tenant scale (~hundreds of tags max), and the big win is that a freshly-saved reference's tags appear immediately in the next suggestion — no cache-invalidation bookkeeping.
- **Ranking: prefix > substring, count DESC, alphabetical tiebreak, max 8.** Most-used tags float to the top; users narrow by typing. Empty prefix on focus shows the top 8 overall ("what am I usually tagging things with?").
- **Comma-separated editing model preserved.** The input's "current token" is everything after the last comma (`lastIndexOf(',')`), so `react, product design, mobi` → the dropdown filters against `mobi`. Selection appends `tag, ` so the user can keep typing the next one without manual commas.
- **Popover appended to `document.body`** (position:fixed, z-index 30) instead of wrapping the input. Wrapping would break the Notes input's `class="grow"` flex-grow hint.
- **mousedown-before-blur race fix.** The popover fires on `mousedown` with `e.preventDefault()` so insertion lands BEFORE the input's blur→`setTimeout(hide, 150)` can hide the dropdown on slow machines.
- **Escape closes without selection.** Keyboard escape hatch for users who triggered the popover by accident.

Files: `src/portal/user-console.html` (+~140 LOC JS + ~22 LOC CSS for `.tag-ac-popover` / `.tag-ac-item`). Zero backend change. Boot hook piggybacks on the existing skill-picker `setTimeout(..., 0)` so both inits run in the same microtask batch.

SECURITY: `collectTagPool` guards against non-string entries and ensures `Array.isArray` on both the source array and `row.tags`. The renderer `esc()`-wraps every tag value both in the `data-tag` attribute and the inner `<span>` — pool tags are user-controlled strings (a tag named `<script>` must not execute on render).

Tests: 31 structural + behavior pins in `__tests__/portal/user-console-tag-autocomplete.test.ts` covering pool collection + skill-tag exclusion + defensive guards, `splitTagInput` (empty / single-comma / multi-comma via `lastIndexOf`), `rankTagSuggestions` (prefix-first order, already-used filter, empty-prefix top-N, count+alpha tiebreak, max 8, case-insensitive), `initTagAutocomplete` (dataset-guard idempotency, body append, fixed positioning, listeners bound, mousedown-not-click, 150ms blur delay, esc-on-innerHTML), `initAllTagAutocomplete` (3 inputs bound, no Channels bind, single shared boot hook), CSS anchors, and a regression pin that the 3 ids + `class="grow"` on noteTags survive the refactor.

---

### ~~OI-UX-103 — Bulk actions on reference tables~~ [DONE · 2026-04-23]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Every reference page (Books / Channels / Links / Notes) now supports row selection + bulk operations:

- **Checkbox column** on every row + a header "select all" checkbox (on Notes, a leading flex-inline "Select all" row since it's a div-list, not a table).
- **Bulk toolbar** appears above the list when ≥1 row is selected. Shows "{N} selected" + a skill-selector + "Apply" (bulk add-skill) + "Delete" + "Clear".
- **Bulk add-skill**: idempotent — rows that already carry the selected skill are skipped and reported ("Tagged 5 books with Content (3 already had it)"). Non-skill tags are preserved via the same `stripSkillTags + mergeTagsWithSkills` pattern as the single-row chip editor (OI-USR-405a).
- **Bulk delete**: guarded by `confirm()` (destructive-action gate). Partial failures are reported honestly ("Deleted 8 of 10; 2 failed").

Design calls worth remembering:

1. **Sequential operations (for-of, not Promise.all).** Two reasons: the tenant rate-limiter can push back on burst writes, and partial-failure reporting is much more actionable than all-or-nothing. 50 rows × 50-100ms = 2.5-5s — acceptable for an admin batch action, and predictable under load.

2. **Selection state is `Set<id>` per kind** (`state.bulkSel = { book, link, note, channel }`). O(1) membership and toggle; no risk of cross-kind leakage. Set lives outside any row, so loads/renders don't require resync.

3. **"Select all" acts on visible rows only.** When a skill filter is active, `Array.every(id => bulkSel.has(id))` is computed against `visibleIds = rows.map(...)` — not `state.books`. The worst regression this prevents: a user filters to Content-tagged books, hits select-all, then bulk-delete, and the operation wipes rows they can't see. A structural test pins the `visibleIds.every(...)` shape in all 4 renderers.

4. **Selection persists across filter changes.** A user can toggle filters to narrow rows, select them, broaden the filter, and the prior selection survives. Pairs naturally with sequential bulk ops — the user sees confirmed counts in the toolbar regardless of the current filter view.

5. **Row-selected tint via CSS.** `tr.row-selected td` and `.row.row-selected` both lean on `var(--accent-subtle)` — same tint used by the toolbar so the visual grouping is obvious. Subtle enough to coexist with existing zebra-striping and hover states.

6. **Inline Remove buttons preserved.** Bulk delete doesn't replace per-row delete; a user who wants to remove one book shouldn't have to check a box + confirm a modal. A regression pin ensures `onclick="deleteBook(..."` (and the other three) still exist.

Files: `src/portal/user-console.html` (+~175 LOC JS for helpers + toolbar renderer + 4 renderer updates; +~42 LOC CSS).

Tests: 41 structural + behavior pins in `__tests__/portal/user-console-bulk-actions.test.ts` — `state.bulkSel` shape, `BULK_KINDS` lookup (4 kinds × path + reload + findById + render), `bulkToggle` / `bulkToggleAll` (visible-only + progressive-all-off affordance), `bulkDelete` (sequential-not-parallel, `confirm()` gate, partial-success toast, DELETE shape, clear-then-reload), `bulkAddSkill` (idempotent skip, label-humanised toast, non-skill-tag preservation, PATCH shape, sequential-not-parallel), `renderBulkToolbar` (zero-state returns empty string, markup, role+aria-label, ≥6 `esc(kind)` uses as defense in depth), 4 renderers wired with matching checkbox column + body rows + toolbar prepend, CSS anchors (accent-subtle tint on toolbar + row-selected, flex-gap layout, 32px check column), and 3 regression pins (inline delete buttons, tag autocomplete, skill-badges-editable rendering all survive).

---

### ~~OI-UX-104 — Wire-enum → human label map~~ [DONE · 2026-04-23]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Wire values (`want_to_read`, `tenant_admin`, `suspended`) used to leak into user-facing pills. A central `LABELS` object + `labelFor(kind, value)` helper is now the single source of truth for human-facing labels. Both consoles carry the same LABELS shape so keys stay in sync.

Scope (11 raw-enum leak sites rewrapped):
- **user-console.html (7 sites):** Books-table status pill, Books search-result subtitle, Channels-table kind pill, Team members role pill, Invites role pill, Invites status pill, Tenant switcher option text.
- **admin-console.html (4 sites):** Tenants-table plan pill, tenant-drawer plan KV, tenant-drawer status KV, drawer-members role pill.

Covered enum kinds:
- `bookStatus`: `want_to_read`/`reading`/`finished`/`abandoned`
- `channelKind`: `generic`/`youtube`/`podcast`/`newsletter`/`rss`/`twitter`/`substack`
- `role`: `tenant_admin`→"Admin" / `tenant_member`→"Member" / `tenant_viewer`→"Viewer" / `platform_admin`→"Platform admin" / `owner`→"Owner"
- `inviteStatus`: `pending`/`accepted`/`revoked`/`expired`
- `tenantPlan`: `free`/`pro`/`enterprise`
- `tenantStatus`: `active`/`suspended`/`archived`

Design calls:
- **Raw fallback.** `labelFor('bookStatus', 'sold')` returns `'sold'` (the raw value) rather than `''`. A new server-side enum shows as the raw wire value, prompting "add it to LABELS" — a visible bug beats an invisible render gap.
- **Empty input → empty string.** `labelFor(kind, undefined)` returns `''` so an unset field never renders as `"undefined"` in the UI.
- **Wire/display split preserved.** Form `<option value="...">` attributes still carry wire values; `labelFor` only applies to display pills. This is pinned via regression test to prevent a "helpful" refactor that would break POST/PATCH validation.
- **Both consoles carry identical LABELS shape** even when a key isn't used locally (user-console has `tenantPlan`/`tenantStatus` that only admin-console displays today). The cost is ~20 bytes of dead data per console; the benefit is "one map, two callers" mental model for future maintenance.

Files: `src/portal/user-console.html` (+~48 LOC), `src/portal/admin-console.html` (+~50 LOC). Zero backend change. Zero migration.

Tests: 35 structural + behavior pins in `__tests__/portal/portal-label-map.test.ts` — 6 kinds × {declared, each value pair} × both consoles + labelFor fallback + 11 display-site swaps (7 user + 4 admin) + 4 absence pins (old `esc(x.role)` / `esc(i.role)` / `esc(i.status)` / `esc(ch.kind)` leaks verified gone) + wire/display split regression (option values stay snake_case).

---

### ~~OI-UX-105 — Keyboard shortcuts~~ [DONE · 2026-04-23]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

User Console now supports power-user keyboard navigation on top of the existing Cmd+K / Ctrl+K search binding from OI-UX-101:

- `/` → Open search (complements Cmd+K)
- `?` → Open shortcuts help modal
- `Esc` → Close shortcuts modal when open
- `g` then `h/i/d/a/t/p` → Home / Insights / Dependencies / Activity / Team / Profile
- `g` then `b/c/l/n` → Reference Center Books / Channels / Links / Notes

Four correctness guards in the handler:

1. **Input-focus guard** (`isTypingInInput`): if the target is `INPUT` / `TEXTAREA` / `SELECT` / `contentEditable`, the whole handler bails. Typing "google" into a note body must stay literal — the single biggest footgun in global keyboard bindings.
2. **Modifier-key bailout**: any `metaKey`/`ctrlKey`/`altKey` press bails so browser shortcuts (Ctrl+T, Cmd+R, Cmd+Shift+[, etc.) remain untouched. Cmd+K continues to live in the dedicated search listener.
3. **Pending-state expiry**: the `g` prefix self-clears after 1500ms (Vim/Gmail/Linear convention). A stray `g` that's not followed up doesn't swallow the user's next key half an hour later.
4. **`preventDefault()` only when consumed**: the handler only calls `e.preventDefault()` on keys it actually acts on. Non-bound keys pass through to the browser.

UX polish:
- Help modal is a two-column grid of `<kbd>`-styled bindings with three sections (Navigation / Reference Center / Global) and a footer disclaimer that shortcuts are disabled while typing in a field.
- Search-modal footer now advertises `? shortcuts` next to the other key hints, so users who discovered Cmd+K have a trail back to the full list.
- The help modal shares styling DNA with the search modal (`position:fixed`, `z-index:72` — one above search at 71 so it stacks cleanly if both ever open together) for visual consistency.
- `kbShortcutsIsOpen()` uses the element's `classList.contains('hidden')` as state instead of a separate boolean — one source of truth, fewer desync bugs.

Files: `src/portal/user-console.html` (+~80 LOC JS + ~40 LOC CSS + ~35 LOC modal HTML + 1 line in search footer).

Tests: 29 structural + behavior pins in `__tests__/portal/user-console-keyboard-shortcuts.test.ts` — 10 g-prefix map entries (plus cross-check that every key in the map has a corresponding `<kbd>` row in the modal HTML, catching drift), 3 correctness guards, 1500ms pending expiry, input-guard-first contract, / and ? and Esc handlers, modal structure (role, aria-label, 3 section headings, footer disclaimer), CSS anchors (`position:fixed`, `z-index:72`, 2-column grid, monospace kbd), open/close helper exposure on `window`, 2 regression pins for the pre-existing Cmd+K listener + search functions.

---

### ~~OI-UX-106 — Responsive collapse for < 768 px~~ [DONE · 2026-04-23]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Both consoles now ship a `@media (max-width: 768px)` block that:

- **Shows a hamburger button** (`#mobileNavToggle`, `☰`) in the app-bar with `aria-label="Toggle navigation"` and `aria-expanded` state. Hidden at desktop widths via `display: none` default.
- **Turns the sidebar into a slide-in drawer** — `position: fixed` top-left, `width: min(280px, 80vw)`, `transform: translateX(-100%)` by default, `.mobile-open` class applies `translateX(0)`. 0.2s ease-out transition so the slide is snappy but perceptible.
- **Backdrop via pseudo-element** — `.sidebar.mobile-open::after` darkens the main area (rgba 0.5) but has `pointer-events: none` so taps pass through to the document click-outside listener.
- **Tightens the app-bar** — hides the `.divider` + `.scope-pill`, shrinks `button.switch` padding, hides the search-trigger's `.search-label` + `.search-kbd` (so just the ⌕ icon shows).
- **user-console only:** tightens page padding, wraps dense reference tables in `overflow-x: auto` (horizontal scroll rather than stacking — preserves column mental map for a data-heavy UX), wraps the bulk toolbar, and stacks the shortcuts-help modal body from 2 columns to 1.

JS side:
- `toggleMobileNav()` / `closeMobileNav()` — exposed on `window`. Both sync the `aria-expanded` attribute so screen readers track drawer state.
- `showPage()` auto-closes the drawer on every navigation — one choke point so nav-item clicks, search picks, keyboard shortcuts (`g h` etc.), and deep links all Just Work without parallel handlers.
- Document click-outside listener closes the drawer on any tap outside the sidebar + hamburger. Guarded against inside-drawer clicks (nav items already navigate) and inside-hamburger clicks (would otherwise render the toggle button unable to open the drawer — tap → open → immediately close).

Design calls worth remembering:

1. **`pointer-events: none` on the backdrop** lets the document click-outside listener handle close — no explicit `<div class="backdrop" onclick="close">` needed. One less element, one less handler.
2. **Horizontal scroll on tables, not card stacking.** For 6-7 column reference tables, stacking to `label: value` pairs produces a wall of text. Horizontal scroll preserves the "Status is column 3" mental map users build up.
3. **`closeMobileNav` is called from `showPage`, not from the click handler.** Every navigation funnels through `showPage`, so any future entry point (new keyboard shortcut, new deep link) gets auto-close for free.
4. **iOS is the primary small-screen experience.** This responsive block is a usable fallback for anyone opening the portal on a phone browser, not the main supported path. Admin-console especially — owners operate from desktops — gets a minimal mobile treatment (drawer + app-bar, but no table scroll overrides since the existing tenant-drawer already uses `min(540px, 95vw)`).

Files: `src/portal/user-console.html` (~65 LOC CSS + ~30 LOC JS + 1 line of HTML), `src/portal/admin-console.html` (~45 LOC CSS + ~30 LOC JS + 1 line of HTML).

Tests: 47 structural pins in `__tests__/portal/portal-responsive-collapse.test.ts` — hamburger button shape on both consoles, `@media (max-width: 768px)` block existence, hamburger display:inline-flex inside media query, shell collapses to single column, sidebar becomes fixed-position slide-in drawer with bounded width, `pointer-events: none` on backdrop, app-bar chrome hidden, user-console-specific page-padding + table-scroll + bulk-toolbar wrap + kb-modal single-column + modal top:5vh, `toggleMobileNav` + `closeMobileNav` definitions + window exposure + aria-expanded sync, `showPage` ends with `closeMobileNav()`, document click-outside handler + inside-drawer guard + inside-hamburger guard, regression that desktop-width grid stays `260px 1fr` and default sidebar has no `position: fixed` outside the media query.

---

### OI-UX-107 — Dark/light theme toggle [P3, UX]

**What's missing.** Dark-only today. Some users prefer light UIs during the day. Trivial to add with CSS custom property swaps.

---

## 3 · Navigation & routing

### ~~OI-NAV-201 — Promote `/admin-console` → `/admin`~~ [DONE · 2026-04-24]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

Three-move URL flip:

1. **`/admin`** now serves `admin-console.html` (the new shell) via a new `createAdminConsoleShellHandler(portalDir)` factory in `src/portal/static-routes.ts`. Same security headers as the legacy handler — `Cache-Control: no-cache`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'self'`.
2. **`/admin-console`** becomes a 301 permanent redirect to `/admin`, wired in `src/portal/server.ts`. 301 (not 302) tells browsers + iOS deep-linkers + uptime monitors to update their cached URL — after the first hit, subsequent requests go straight to `/admin` with zero network round-trip.
3. **`/portal`** keeps serving `portal.html` (the legacy dashboard). Users who explicitly want the old UI have a pinned entry point. `/` (root) also keeps serving portal.html — landing UX is a separate decision, not part of this URL flip.

Cross-console wiring updated:
- `src/portal/user-console.html` — "↗ Admin Console" switch button now targets `/admin` directly instead of `/admin-console` (avoids a 301 hop on every click from the user console).

Files: `src/portal/static-routes.ts` (+~25 LOC — new handler factory + rewired binding), `src/portal/server.ts` (~10 LOC changed — `/admin-console` handler switched from serve-file to 301 redirect), `src/portal/user-console.html` (1 char change in switcher target).

Tests: 9 new pins in `__tests__/portal/portal-admin-console-promotion.test.ts` covering: `createAdminConsoleShellHandler` serves admin-console.html + security headers + 503 on missing file; `registerPortalStaticRoutes` maps /admin to the new shell NOT the legacy dashboard; `/portal` and `/` still serve legacy; `/admin-console` is NOT in static routes (it lives in server.ts); server.ts contains the `res.redirect(301, '/admin')` shape; absence pin that the old `app.get('/admin-console', serveShell('admin-console.html'))` binding is gone; and a UI pin that user-console.html's switcher now targets `/admin` (with an absence pin on `/admin-console`).

Followups:
- iOS deep-links currently use `/admin-console` in 1-2 spots; they'll continue working via the 301 indefinitely, but a separate iOS-repo PR should update them to `/admin` for clarity + to skip the redirect hop.

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

Follow-ups:
- **~~OI-USR-405a~~ — edit-mode UI** [DONE · 2026-04-23]. Every reference row (books / channels / links / notes) now shows an inline chip widget in the "Used by" column: assigned skills are click-to-remove (× glyph, red hover), and a dashed "+ Skill" chip opens a `<details>`/`<summary>` popover listing only unassigned skills. One skill per PATCH call (maps 1:1 to user intent), which keeps the server handler simple and lets each change surface its own error toast. Home is reloaded after every mutation so dependency badges stay in sync. Chose `<details>` over a custom dropdown so the browser gives us click-outside-to-close for free (`list-style: none` + `::-webkit-details-marker { display: none }` strip the ▸ triangle). Files touched: `src/portal/user-console.html` (helper `SKILL_EDIT_KINDS` + `setSkillTagOnRef` + `renderSkillBadgesEditable` + 4 row-renderer swaps + ~60 lines CSS) + `__tests__/portal/user-console-ref-skill-edit.test.ts` (30 new pins) + updated OI-USR-405 render-call pins (4 regex). Net ~150 LOC UI + ~200 LOC tests. Backend required zero change — all 4 PATCH routes already accept `tags: Array.isArray(body.tags) ? body.tags : undefined`.
- ~~**OI-USR-405b** — automatic skill-tag inference~~ [DONE · 2026-04-24]. Each reference row (books / channels / links / notes) now shows a **✨ Suggest** chip next to the "+ Skill" popover. First click fires `POST /workspace/skills/suggest-tags`, computes top-3 skill candidates via Jaccard similarity over the user's own tag vocabulary, and renders them as one-click apply buttons with confidence % overlays ("Content 67%"). No LLM calls, no embeddings — pure tag-overlap ranking over the tenant's own curated history. Cold-starts when ≤ 3 refs carry any skill tag. Supporting ref IDs are returned for future "because of..." UI explainability. Service: `src/services/skill-inference.ts` (pure-function core + DB wrapper). Route: `POST /workspace/skills/suggest-tags` in `portal-workspace-router.ts`. UI: `renderSkillBadgesEditable` extended with a second `<details>`/`<summary>` popover; lazy-loads via `ontoggle` so we don't fire on every row render. Tenant isolation pinned by test. 24 service pins + 10 route pins + 17 UI pins = 51 new assertions.
- **OI-DATA-001 interaction** — once reference-usage tracking ships (OI-DATA-001), the "Used by skills" labels can be split into "Tagged by user" vs "Used by pipeline", showing both explicit intent and observed usage.

---

### ~~OI-USR-406 — In-UI invite expiry countdown~~ [DONE · 2026-04-23]

**Resolved on branch `feature/nexus-hub-portal-uiux-admin-user-console` (commit pending).**

The Team page's Invites table now carries a dedicated "Expires" column showing a relative countdown instead of a raw timestamp. Five urgency states with tinted pills:

- `none` — no expiry set → "never" (muted italic)
- `fresh` — > 24h remaining → "expires in Nd" (neutral)
- `soon` — 1-24h remaining → "expires in Nh" (accent blue)
- `expiring` — < 1h remaining → "expires in Nm" (orange tint)
- `expired` — past expiry → "expired Nd/Nh/Nm ago" (danger red, slight bold)

Implementation:

- **Pure helper `formatCountdown(iso)`** returns `{ label, kind }`. Day/hour/minute resolution only (no second-level tick — that creates visible noise and demands 1s intervals). Sub-minute output clamps to "1m" so the UI never reads "expires in 0m".
- **Companion `humanizeDuration(ms)`** for the "expired Xd ago" branch. Same ladder (d → h → m) with the same 1m clamp.
- **30s background tick via `setInterval`** — recomputes every visible `.invite-countdown[data-expires]` cell's `textContent` + `className` without re-rendering the row. This preserves in-flight button clicks like "Copy link" → clipboard which would otherwise be destroyed by row replacement.
- **Both camelCase + snake_case support** — the row reads `i.expiresAt || i.expires_at` so the same markup survives whichever shape the route returns.

Design calls worth remembering:

1. **Return `{ label, kind }` instead of a raw string.** Gives the caller both the text and the CSS class in one call; no second parser needed to categorise the string. Pattern applied also in OI-UX-104 (`labelFor`) but here it's load-bearing for the tint.
2. **`font-variant-numeric: tabular-nums`** on `.invite-countdown`. Without it, digit glyphs shift pixel width as numbers change (12h → 13h), creating visible jitter on every tick. Tabular-nums locks digit glyphs to uniform width.
3. **30s cadence, not 1s.** Minute-resolution UX is cheap in DOM writes (~8 cells per tick for a normal invite list) and matches the actual information change rate (minutes, not seconds).
4. **`formatCountdown(iso || null)` on row render.** Empty-string `expires_at` is coerced to `null` so the helper's early-return "none" branch fires instead of computing "expired 56y ago" from the Unix epoch.
5. **Tick only mutates `textContent` + `className`** — no `innerHTML` rewrite. This preserves event listeners on sibling elements (Copy/Revoke buttons) and any in-flight interaction state.

Files: `src/portal/user-console.html` (~50 LOC helpers + CSS + column wiring). Zero backend change.

Tests: 26 pins in `__tests__/portal/user-console-invite-countdown.test.ts` — unlike most of the pin files, this one extracts `formatCountdown` and `humanizeDuration` via `new Function(...)` and runs them against `vi.setSystemTime()` frozen clocks, so the behavior boundaries (24h/1h/0) are tested as *actual outputs*, not just structural shape. Plus 6 structural pins on the invites table column, tick wiring, 5 CSS kind classes, and regressions that existing OI-UX-104 label calls + action-button rendering still fire.

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
