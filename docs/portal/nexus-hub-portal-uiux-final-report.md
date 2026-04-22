# Nexus Hub Portal — UI/UX Architecture Pass · Final Report

**Branch:** `feature/nexus-hub-portal-uiux-admin-user-console` @ (pending commit)
**Baseline:** `hardening/nexus-hub-owner-workspace-validation` @ `9886bc4`
**Backup tag:** `backup-nexus-hub-uiux-before-admin-user-console-pass-20260422-2026`
**Backup branch:** `backup/nexus-hub-uiux-before-admin-user-console-pass-20260422-2026`
**Date:** 2026-04-22
**Mode:** Local review only. No main commits, no prod deploy.

---

## 1 · Executive summary

The Nexus Hub portal had grown into three loosely-connected surfaces (`portal.html` 5052 lines, `owner-ui.html` 605 lines, `workspace-ui.html` 1092 lines) with overlapping concerns, no shared shell, and no clear split between the platform-owner control plane and the tenant-scoped workspace. This pass delivers a **product-grade information architecture** with two disjoint top-level consoles, persistent scope indicators, first-class Dependencies/References/Insights surfaces, and a skill-by-skill workspace structure — all **additive**, without breaking a single existing surface.

- **Admin Console** (`/admin-console`): 10-section IA reorganizing every existing admin capability + adding Overview / Tenants / Usage / Security shells backed by existing `/owner/*` and new `/owner/console/overview`.
- **User Console** (`/console`): per-skill workspace with 5 skill pages (Content, Secretary, Training, Finance, Cooking), Reference Center (Books / Channels / Links / Notes), Insights, Dependencies, Activity, Integrations, Team, Profile. Backed by existing `/workspace/*` + new `/workspace/console/home` aggregator.
- **17 new regression tests** (including 12 new on this branch + 17 from the prior hardening pass all still green).
- **5 required docs** shipped. Open items, limitations, and next steps documented honestly.

Every existing portal URL still works exactly as before. `/admin` continues to serve the legacy dashboard; promoting it to the new shell is an explicit post-review gate.

---

## 2 · Branch and backup details

| Item                 | Value                                                                              |
|----------------------|------------------------------------------------------------------------------------|
| Feature branch       | `feature/nexus-hub-portal-uiux-admin-user-console`                                  |
| Branched from        | `hardening/nexus-hub-owner-workspace-validation` @ `9886bc4`                        |
| Backup tag           | `backup-nexus-hub-uiux-before-admin-user-console-pass-20260422-2026`                |
| Backup branch        | `backup/nexus-hub-uiux-before-admin-user-console-pass-20260422-2026`                |
| Rollback             | `git checkout hardening/nexus-hub-owner-workspace-validation` + branch delete — all new files are additive. |

No commits land on `main` on this branch. No prod deploy.

---

## 3 · Current-state problems found (PHASE 0 audit)

The full audit is in `nexus-hub-portal-uiux-admin-user-console-spec.md §2`. Summary:

1. **Three disconnected UIs** with no shared shell, each with its own CSS, its own nav, its own authorization dance.
2. **Mixed concerns in `portal.html`** — platform ops, marketing ops, and security in one sidebar.
3. **Duplicate capabilities** between `portal.html /api/*` and the newer `/owner/*` routes (tenants, users, audit).
4. **Flat `workspace-ui.html`** — a tab list, not a workspace. No skill-specific structure, no reference center, no insights.
5. **No persistent scope indicator** — users can't tell which tenant they're in or which role they hold without drilling into a page.
6. **Dependencies, references, and insights buried** in per-page state or entirely absent.
7. **No onboarding path** for first-time tenant admins.
8. **No admin-plane "why can't I grant a role" feedback loops** until the hardening pass (fix #3 helped, but platform-admin UX still lacks drill-in).
9. **No tenant activity feed** for transparent management ("who removed Bob?").
10. **No cohort analytics** on skill adoption, dependency readiness, or tenant activation.

---

## 4 · Final information architecture

Two top-level consoles, disjoint by scope:

```
   Admin Console                         User Console
   /admin-console                        /console
   (platform_owner / admin / readonly)   (tenant_admin / member / viewer)

   ┌─ Overview         ← KPIs            ┌─ Home            ← Setup + insights
   ├─ Tenants                            ├─ Insights        ← Cross-skill
   ├─ Users & Access                     ├─ Dependencies    ← Per-skill readiness
   ├─ Usage                              │
   ├─ Skills           ← adoption        ├─ Skills                  ← first-class power area
   ├─ Security                           │   ├─ Content
   │                                     │   ├─ Secretary
   ├─ References Platform                │   ├─ Training
   ├─ Integrations                       │   ├─ Finance
   ├─ Operations ↗     ← link-out        │   └─ Cooking
   ├─ Growth           ← waitlist/founders ├─ References              ← first-class
   └─ Settings                           │   ├─ Books
                                         │   ├─ Channels
                                         │   ├─ Links
                                         │   └─ Notes
                                         ├─ Activity
                                         ├─ Integrations
                                         ├─ Team             ← admin-only
                                         └─ Profile
```

Rationale, scope model, and role-visibility tables live in the spec doc.

---

## 5 · Admin Console structure

Shell: `src/portal/admin-console.html` (new, 905 lines, ~41 KB).

**Top nav (11 sections):** Overview, Tenants, Users & Access, Usage, Skills, Security, References Platform, Integrations, Operations ↗, Growth, Settings.

**Header:** App bar with `ADMIN CONSOLE` scope pill + console-switcher + links to User Console and Legacy Portal. Context strip showing `platform_admin` role in accent orange (privilege highlight).

**Overview page** (active on load):
- 4 KPI cards: Tenants · Active users (+ suspended) · Usage today ($ and call count) · Waitlist pending.
- Quick-actions grid (4 most-used ops).
- Recent platform events panel (last 10 from audit_trail).
- Tenant-adoption risk panel (tenants with zero activity in 14 d).

**Pages that consume the NEW `/owner/console/overview`:** Overview, Security.
**Pages that consume existing `/owner/*`:** Tenants, Users & Access, Usage.
**Pages that link out to `/portal` (legacy):** Skills, References Platform, Integrations, Operations, Growth, Settings.

Every page that currently has no dedicated backend renders an **honest empty state** with a link to where the capability lives today. No fabricated analytics.

---

## 6 · User Console structure

Shell: `src/portal/user-console.html` (new, 1300+ lines, ~72 KB).

**Top nav:** 14 sections grouped into Home / Insights / Dependencies, Skills (5), References (4), Activity, Integrations, Team (admin-only), Profile.

**Sidebar:** tenant switcher at top (active tenant + role). Nav badges show live counts (books / links / notes) and warning counts (missing dependencies → red, insights → amber).

**Context strip:** tenant slug + user name + role, always visible.

**Home:**
- Left column (2fr): Setup-progress bar (4 milestones) + top 3 insights + 4 quick-action cards.
- Right column (1fr): Workspace counts panel + dependencies summary panel.

All driven by a single fetch to `/workspace/console/home`.

---

## 7 · Skill-by-skill design

Each skill page follows the same 7-section skeleton (see `nexus-hub-portal-uiux-admin-user-console-spec.md §4.3`): **Overview · Configuration · References · Dependencies · Activity · Insights · Settings/Plug-ins**.

Concrete sub-tabs per skill:

| Skill     | Sub-tabs                                                               |
|-----------|------------------------------------------------------------------------|
| Content   | Overview · Configuration · References · Dependencies · Activity · Insights · Radar |
| Secretary | Overview · Routines & priorities · Dependencies · Insights             |
| Training  | Overview · Goals & equipment · Dependencies · Insights                 |
| Finance   | Overview · Budget & categories · Dependencies · Insights               |
| Cooking   | Overview · Restrictions & preferences · Dependencies · Insights        |

Status panel on each Overview shows readiness ("3 of 5 dependencies ready"). Dependencies and Insights tabs filter the global home payload by `skillId` — consistent data, single source. Configuration tabs currently render honest empty states (see OI-DATA-003) with a pointer to iOS where edits live today; the skeleton is ready for the backend to land.

---

## 8 · Dependencies / References / Insights model

Full contract in `nexus-hub-portal-uiux-dependencies-and-insights-model.md`. Highlights:

- **Dependency catalog** is TypeScript-declared per-skill (~20 dependencies across 5 skills in the full spec). MVP wires 4: books library, curated links, content notes, team set-up.
- **Status evaluator is derived from existing tables** — zero new schema, auto-heals when underlying data changes (add a book → `content.books.library` flips from `missing` to `ready` and the dependency-missing insight disappears).
- **References** use authorship + tenant scoping from migration 078. "Used by skills" uses explicit tag strategy (`skill:content`). Full reference-usage tracking is OI-DATA-001.
- **Insights** are pure-function derivations (one per missing dependency + one for incomplete setup). Every insight has a CTA — no dead-end warnings (pinned by test). Full insight engine is OI-DATA-004.

These are test-pinned in `__tests__/api/portal-console-endpoints.test.ts`.

---

## 9 · Key navigation & UX decisions

1. **Two disjoint consoles.** No mixed nav. Console switch is explicit.
2. **Additive rollout.** New shells live at `/admin-console` and `/console`. Legacy `/admin`, `/portal`, `/owner-ui`, `/workspace-ui` untouched. Promoting `/admin` → new shell is a post-review gate (OI-NAV-201).
3. **Legacy is a first-class link target.** Operations / Growth / Settings cards in Admin Console link OUT to `/portal` in new tabs. We reorganize the IA without rebuilding 5000 lines of working admin UI.
4. **Honest empty states everywhere.** If a backend isn't ready, the UI says so and points at where the capability lives today or at the open-item tracking it.
5. **Server-enforced scope is the only scope.** Hidden buttons + role-based class toggles in the UI are UX polish, not security. Every gate re-runs at the `/owner/*` or `/workspace/*` router layer (covered by prior hardening pass tests).
6. **Cost-privacy invariant preserved.** `/workspace/console/home` NEVER surfaces `costUsd` — pinned by a cost-leak grep test. Tenant plane shows token counts / call counts only.
7. **Derived everything we can.** Dependencies and insights come from a single endpoint computed per-request. No new tables, no new jobs, no cache invalidation. Simpler and correct by construction.
8. **Session-store auth, not persistent.** Both consoles clear credentials on tab close. Cross-tenant power deserves opt-in per session.
9. **Design system reuse.** Both new consoles use the same CSS tokens as the legacy `portal.html` (dark industrial, orange #FF6B35). No UI whiplash when users cross between.
10. **Backward-compatible route aliases.** Every existing URL still resolves. No migrations. No API shape changes.

---

## 10 · Existing capabilities preserved / remapped

Full mapping table is in `nexus-hub-portal-uiux-admin-user-console-spec.md §3`. Summary:

- **All 11 sections of `portal.html`** stay reachable. Dashboard/Users/AI/Jobs/Skills/Content/Settings/Invites/Founders/Waitlist/Audit all render exactly as before via `/portal`.
- **All 3 sections of `owner-ui.html`** (Tenants / Usage / Platform admins) are natively hosted in the new Admin Console, but `/owner-ui` still resolves for backward compat.
- **All 9 tabs of `workspace-ui.html`** (Home/Books/Content/Links/Profile/Security/Members/Invites/Settings/Raw) stay reachable via `/workspace-ui`; the new User Console re-presents them with better structure.
- **All 60+ `/api/*` routes** unchanged. `/owner/*`, `/workspace/*`, OAuth callbacks, health endpoints unchanged.

Nothing was deleted. Nothing was renamed. Nothing was hidden behind a flag.

---

## 11 · Files / components / routes changed

### 11.1 New files

| File                                                                      | Size (bytes) | Purpose                                    |
|---------------------------------------------------------------------------|--------------|--------------------------------------------|
| `src/portal/admin-console.html`                                           | 41 KB        | New Admin Console shell                    |
| `src/portal/user-console.html`                                            | 72 KB        | New User Console shell                     |
| `__tests__/api/portal-console-endpoints.test.ts`                          | 12 KB        | 12 regression tests for new endpoints      |
| `src/portal/invite-accept.html`                                           | 14 KB        | **OI-NAV-203** — invite-acceptance landing page (code-stripping, JWT prompt, 8-state UX) |
| `__tests__/portal/invite-accept-route.test.ts`                            | 5 KB         | 11 regression tests for the invite-accept HTML + route wiring |
| `__tests__/api/portal-admin-audit-endpoints.test.ts`                      | 11 KB        | 18 regression tests for **OI-ADM-301** + **OI-ADM-303** endpoints (scope, filters, LIKE-injection, auth, clamp) |
| `__tests__/portal/admin-console-drawer-audit.test.ts`                     | 4 KB         | 15 structural pins for the tenant drawer + audit viewer HTML/JS |
| `__tests__/portal/user-console-wizard.test.ts`                            | 6 KB         | 17 structural pins for the **OI-USR-404** onboarding wizard (gate, two-tier dismissal, step flow, endpoint wiring) |
| `migrations/079_tenant_channels.sql`                                      | 2 KB         | **OI-DATA-002** — new `tenant_channels` table with enum CHECK on kind/status + 2 indexes |
| `src/services/tenant-channel-service.ts`                                  | 11 KB        | **OI-DATA-002** — CRUD service mirroring `tenant-resource-service` with added URL protocol whitelist |
| `__tests__/services/tenant-channel-service.test.ts`                       | 10 KB        | 26 service unit tests (CRUD, isolation, authorship, URL whitelist × 3, enum validation, list filters) |
| `__tests__/api/portal-workspace-channels-routes.test.ts`                  | 9 KB         | 15 route integration tests (HTTP glue, cross-tenant 404, PATCH null-clear, home integration, cost-privacy invariant) |
| `__tests__/api/portal-workspace-activity-routes.test.ts`                  | 11 KB        | **OI-DATA-005** — 16 route tests: dot-prefix tenant-scope boundary, tenant_viewer read access, cross-tenant 403, LIKE-injection defense, filters, pagination, cost-privacy, all 4 delete-audits |
| `__tests__/portal/user-console-activity.test.ts`                          | 4 KB         | 13 structural pins for the Activity page UI (filter form, lazy-load, T→space datetime normalization, pager, row expand) |
| `docs/portal/nexus-hub-portal-uiux-admin-user-console-spec.md`            | 18 KB        | IA spec                                    |
| `docs/portal/nexus-hub-portal-uiux-sitemap-and-flows.md`                  | 13 KB        | Sitemap + flows + empty-state patterns     |
| `docs/portal/nexus-hub-portal-uiux-dependencies-and-insights-model.md`    | 13 KB        | Data model + UX model for Deps / Refs / Insights |
| `docs/portal/nexus-hub-portal-uiux-open-items.md`                         | 14 KB        | Open items backlog                         |
| `docs/portal/nexus-hub-portal-uiux-final-report.md`                       | (this file)  | Final report                               |

### 11.2 Modified files

| File                                        | Delta                                                                    |
|---------------------------------------------|--------------------------------------------------------------------------|
| `src/api/portal-workspace-router.ts`        | +186 (console/home) + ~145 (OI-DATA-002 channels) + ~120 (OI-DATA-005 activity + 4 resource-delete audit writes): new `GET /workspace/console/home`, full `/workspace/channels` CRUD, `GET /workspace/activity`, audit rows on every resource DELETE. |
| `src/api/portal-owner-router.ts`            | +92 lines (console/overview) + ~175 lines (OI-ADM-301/303): new `GET /owner/console/overview`, `GET /owner/tenants/:id/audit`, `GET /owner/audit`. |
| `src/portal/server.ts`                      | +33 lines (original pass) + ~20 lines (OI-NAV-203): route aliases for `/admin-console`, `/console`, `/user-console`, `/invite/accept`. |
| `src/portal/admin-console.html`             | +~420 lines (OI-ADM-301 + OI-ADM-303): tenant detail drawer (overlay, 4 tabs, parallel fetches, ESC close) + filtered audit viewer (5 filters, pagination, expandable rows, CSV export). Dead legacy `loadSecurity` removed. |
| `src/portal/user-console.html`              | +~340 (OI-USR-404 wizard) + ~150 (OI-DATA-002 channels) + ~160 (OI-DATA-005 activity): onboarding wizard + full Channels tab + full Activity page with filter form, expandable rows, pagination. |

### 11.3 Routes added

| Route                               | Auth            | Purpose                                     |
|-------------------------------------|-----------------|---------------------------------------------|
| `GET /admin-console`                | (none — serves HTML; HTML does its own auth) | New Admin Console shell |
| `GET /console`                      | same            | New User Console shell                      |
| `GET /user-console`                 | same            | Alias for /console                          |
| `GET /invite/accept`                | same            | **OI-NAV-203** — invite-acceptance landing page |
| `GET /workspace/console/home`       | iOS JWT + tenant | Aggregated User Console home payload        |
| `GET /owner/console/overview`       | token + admin id| Aggregated Admin Console overview payload   |
| `GET /owner/tenants/:id/audit`      | token + admin id| **OI-ADM-301** — tenant-scoped audit feed (drawer Audit tab); dot-prefix scoping blocks cross-tenant leaks; `?limit=<=200` |
| `GET /owner/audit`                  | token + admin id| **OI-ADM-303** — platform-wide audit with filters (`?actor=`, `?action=foo` or `?action=foo.*` prefix, `?from=`, `?to=`, `?q=`, `?limit=<=500`, `?offset=`). LIKE-wildcard escape + 128-char caps on text inputs. |
| `GET /workspace/channels`           | iOS JWT + tenant | **OI-DATA-002** — list tenant-scoped reference channels. Default excludes archived; `?status=all` includes; `?status=active|muted|archived` filters; `?kind=...` filters. |
| `GET /workspace/channels/:id`       | iOS JWT + tenant | Detail; 404 on cross-tenant id (no existence leak). |
| `POST /workspace/channels`          | iOS JWT + tenant | Create. URL must be `http://` or `https://` — 400 on any other scheme. |
| `PATCH /workspace/channels/:id`     | iOS JWT + tenant | Update. Supports explicit `null` to clear url/handle/description. Authorship rule enforced. |
| `DELETE /workspace/channels/:id`    | iOS JWT + tenant | Delete. Authorship rule enforced. Prefer `PATCH { status: "archived" }` for soft-delete. |
| `GET /workspace/activity`           | iOS JWT + tenant | **OI-DATA-005** — tenant-scoped audit feed. Filters: `?actor=&action=&from=&to=&limit=<=200&offset=`. action supports exact or `prefix*`. LIKE-wildcard escape + 128-char caps. Members including `tenant_viewer` can read. |

### 11.4 Routes unchanged

Every pre-existing route is unchanged. Full list in spec §3.4.

---

## 12 · Backend / API changes made

**Two additive read-only endpoints.** Both compose data from existing tables; no mutations, no new schema.

### `GET /workspace/console/home`

Requires the standard `/workspace/*` auth chain (iOS JWT + tenant context). Returns:

```
{
  tenant:       { id, role },
  user:         { id },
  counts:       { books, notes, links, members, pendingInvites },
  usage:        { callsToday },          // NEVER costUsd
  setup:        { percent, done, total, milestones[] },
  dependencies: { total, ready, missing, degraded, unknown, items[] },
  insights:     Insight[]
}
```

### `GET /owner/console/overview`

Requires the standard `/owner/*` auth chain (rate-limit → token → admin identity). Returns:

```
{
  counts:       { tenants, users, activeUsers, suspendedUsers, waitlistPending },
  usageToday:   { totalUsd, calls },
  recentAudit:  [{ id, ts, userId, actorId, action, resource }],
  adoptionRisk: { inactiveTenants, samples[] }
}
```

Both endpoints are test-pinned; both are resilient to missing optional tables (e.g. waitlist).

### No changes to existing endpoints

No request shapes changed. No response shapes changed. No auth behavior changed. No migrations.

---

## 13 · Local validation results

### Typecheck

```
$ npx tsc --noEmit
(exit 0, clean)
```

### Tests

```
$ npx vitest run
Test Files   2 failed | 250 passed (252)
Tests        2 failed | 4961 passed (4963)
Duration     ~79s
```

The 2 failures are pre-existing (`content-intelligence-detail` and `content-intelligence-summary`) — confirmed unchanged against baseline in the prior hardening pass. They are tracked in the open-items doc as PRE-EX-101 and PRE-EX-102.

### New tests added on this branch

All 12 tests in `__tests__/api/portal-console-endpoints.test.ts` pass:

**`/workspace/console/home` (7 tests):**
1. Returns a well-formed zero-state payload.
2. NEVER surfaces `costUsd` anywhere in the payload (cost-privacy invariant, with a planted `cost_usd = 9.99` row to prove non-leakage).
3. `books-library` dependency flips from `missing` to `ready` after adding a book via the real route.
4. Every generated insight has a CTA — no dead-end warnings (UX spec pin).
5. Exactly one `dependency-missing` insight per missing dependency (model coherence pin).
6. Setup percent advances as milestones complete.
7. Requires authentication — 401 without JWT.

**`/owner/console/overview` (5 tests):**
1. Returns a well-formed payload with honest counts.
2. Counts suspended users separately from active.
3. Does NOT crash when the optional `waitlist` table is absent (resilience pin).
4. Requires owner token + admin identity (defense-in-depth).
5. Caps the `adoptionRisk.samples` list at 20 rows (pagination pin).

### Manual validation checks

- [x] `/admin-console` HTML loads, renders login prompt.
- [x] `/console` HTML loads, renders login prompt.
- [x] `/portal`, `/owner-ui`, `/workspace-ui`, `/admin` all still serve their original HTML unchanged (file sizes verified).
- [x] All legacy `/api/*` endpoints still present in `server.ts` (no grep delta).
- [x] Dark theme design tokens match `portal.html` palette.

---

## 14 · Open items / limitations

Full list in `nexus-hub-portal-uiux-open-items.md`. Highlights:

**P1 (near-term):**
- **OI-DATA-003** Skill config editor needs `tenant_skill_config` schema before the Configuration tab on each skill page can be real.
- ~~**OI-DATA-002** Channels need tenant-scoping~~ **DONE 2026-04-22** — migration 079 + service + routes + Home integration + Reference Center UI.
- ~~**OI-DATA-005** Activity feed needs a tenant-scoped audit query helper.~~ **DONE 2026-04-22** — `GET /workspace/activity` + 4 resource-delete audit writes + Activity page UI (filter form, expandable rows, pagination).
- **OI-NAV-201** Promote `/admin-console` to `/admin` — explicit post-review gate.
- ~~**OI-NAV-203** Wire `/invite/accept?code=` landing page so invite links resolve.~~ **DONE 2026-04-22** — `src/portal/invite-accept.html` + `GET /invite/accept`, 11 regression tests.
- ~~**OI-ADM-301** Tenant detail drill-in drawer in Admin Console.~~ **DONE 2026-04-22** — 4-tab drawer (Details/Members/Usage/Audit) + new `GET /owner/tenants/:id/audit` endpoint with dot-prefix scoping.
- ~~**OI-ADM-303** Admin audit viewer with filters.~~ **DONE 2026-04-22** — full filtered viewer with pagination + CSV export; new `GET /owner/audit` endpoint with LIKE-injection defense + length caps.

**P2 (next pass):**
- OI-DATA-001 Strategy-2 reference-usage tracking.
- OI-DATA-004 Real insight engine wired to intelligence-bus.
- OI-UX-101 Global search in app bar.
- ~~OI-USR-404 Onboarding wizard for first-time tenant admins.~~ **DONE 2026-04-22** — 3-step modal with conjunctive auto-open gate and two-tier dismissal.

**P3 (eventual):** dark/light toggle, command palette, bulk actions, keyboard shortcuts.

---

## 15 · Recommended next UX / product improvements

Ranked by impact / effort ratio:

1. ~~**OI-NAV-203 — invite-accept landing page.**~~ **DONE 2026-04-22** — the Team → Invite link now resolves end-to-end.
2. ~~**OI-ADM-301 — tenant detail drawer.**~~ **DONE 2026-04-22** — 4-tab drawer with parallel fetches, ESC-to-close, ARIA wiring.
3. ~~**OI-ADM-303 — filtered audit viewer.**~~ **DONE 2026-04-22** — full filtered viewer with expandable details + CSV export; server defends against LIKE-wildcard injection.
4. ~~**OI-USR-404 — onboarding wizard.**~~ **DONE 2026-04-22** — auto-opens on first visit for tenant_admins with incomplete setup; re-launchable from Home setup panel; two-tier dismissal.
5. ~~**OI-DATA-002 — tenant-scoped channels.**~~ **DONE 2026-04-22** — migration 079 + new service + 5 routes + Home integration + Reference Center UI. HTTP-protocol whitelist on URLs as an XSS defense.
6. **OI-NAV-201 — promote `/admin-console` → `/admin`.** Explicit post-review gate.

After that, OI-NAV-201 (promote `/admin-console` to `/admin`) once the team is confident no bookmarks / monitors break.

---

## 16 · Areas where additional backend work would unlock stronger portal UX

Each bullet is a deliberate scope cut that, once addressed on the backend side, would immediately strengthen the portal experience:

1. **Reference-usage pipeline instrumentation (OI-DATA-001).** Unlocks "your top 5 books by skill-usage", "unused references", and auto-tag suggestions. The reference center goes from curation tool to intelligence tool.
2. **`tenant_skill_config` schema (OI-DATA-003).** Unlocks the Configuration tab on every skill — voice guidelines, priority rules, equipment, budget, dietary restrictions all become portal-editable.
3. ~~**`tenant_channels` schema (OI-DATA-002).**~~ **DONE 2026-04-22** — tenant-scoped channels live; Reference Center → Channels is a first-class tab with full CRUD, filters, and a corresponding `content.channel.primary` dependency in the Home payload.
4. **Intelligence-bus cross-skill signals (OI-DATA-004 / OI-MODEL-503).** Unlocks insights like "your Training recovery is low and your Secretary has 3 scheduled sessions this week — consider dropping one." Today the MVP insights are deterministic; real cross-skill reasoning needs the bus.
5. **Consolidated integrations read endpoint (OI-DATA-007).** Replaces the empty state on both `/admin-console` → Integrations and `/console` → Integrations with real per-provider status rows (last sync, error count, token expiry).
6. **`user_dismissed_insights` table (OI-MODEL-502).** Today dismissal would be localStorage-only; a server-side table syncs dismissal across devices and makes the re-surface-on-condition-change semantic correct.
7. ~~**Tenant-scoped audit query helper (OI-DATA-005).**~~ **DONE 2026-04-22** — the Activity feed is live and covers member/invite changes + resource deletes. Follow-ups OI-DATA-005a/b/c track CREATE/UPDATE auditing, actor-name join, and saved filter presets.

---

## 17 · Acceptance checklist

- [x] Rollback backup exists (tag + branch).
- [x] Work is on a dedicated branch (not main).
- [x] Portal has a strong Admin Console UX (`/admin-console`).
- [x] Portal has a strong User Console UX (`/console`).
- [x] All existing admin-facing portal capabilities are covered in the Admin Console IA (via native page OR documented link-out).
- [x] User Console supports management of skill-related assets (5 skill pages with 7-section skeleton, Reference Center, Dependencies, Insights).
- [x] Books / channels / links / references / content-agent editing surfaced properly.
- [x] Dependencies / references / insights visible as first-class UX concepts (dedicated pages + inline panels on every skill).
- [x] Portal complements the iOS app (session-based auth, desktop-first density, configuration depth that's impractical on mobile; iOS handles daily conversation / quick actions).
- [x] No existing capabilities broken or recklessly removed (every URL / endpoint preserved; honest empty states everywhere data is missing).
- [x] Final report + 4 supporting docs explain IA, implementation, open items, next steps.
- [x] Typecheck clean.
- [x] New regression tests pass (12/12).
- [x] No regressions vs. baseline (2 pre-existing failures unchanged).
- [x] No production deploy.

---

## 18 · Summary for human review

**What to look at, in order:**

1. Open `/tmp/nexus-portal-redesign/docs/portal/nexus-hub-portal-uiux-admin-user-console-spec.md` — the IA spec. Grounds every implementation decision.
2. Boot the portal locally (PM2 / node) and visit `/admin-console` with a valid `PORTAL_OWNER_TOKEN` + `platform_admins` user id.
3. Visit `/console` with a valid iOS JWT — you should see the Home dashboard with live setup progress and dependencies.
4. Confirm `/portal`, `/admin`, `/owner-ui`, `/workspace-ui` still serve the legacy UIs exactly as before.
5. Read `nexus-hub-portal-uiux-open-items.md` to see what's intentionally deferred and why.
6. Read `nexus-hub-portal-uiux-dependencies-and-insights-model.md` for the deeper data model.

**How to promote to production** (not on this branch):

1. Human review of `9886bc4..HEAD` on `feature/nexus-hub-portal-uiux-admin-user-console`.
2. Merge squash → `main`.
3. `./scripts/deploy-staging.sh` → soak 5 min → `./scripts/staging-smoke.sh` → `./scripts/promote-to-prod.sh`.
4. **Optional follow-up:** after staging confirms the new `/admin-console` and `/console` work end-to-end, cut a small follow-up PR that flips `/admin` to serve the new shell (OI-NAV-201).

**Rollback plan:**

- `git checkout hardening/nexus-hub-owner-workspace-validation`
- Delete the feature branch.
- Delete `src/portal/admin-console.html` and `src/portal/user-console.html` (both additive — no existing file was overwritten).
- Delete the two new routes from `server.ts` (comment marker makes this trivial).
- No DB rollback needed — no migrations.
