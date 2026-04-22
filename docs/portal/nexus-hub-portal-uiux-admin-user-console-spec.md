# Nexus Hub Portal — Admin Console & User Console UX Spec

**Branch:** `feature/nexus-hub-portal-uiux-admin-user-console`
**Baseline:** `hardening/nexus-hub-owner-workspace-validation` @ `9886bc4`
**Backup tag:** `backup-nexus-hub-uiux-before-admin-user-console-pass-20260422-2026`
**Date:** 2026-04-22

---

## 0 · Product framing

The **Nexus Hub iOS app is the primary daily assistant experience.** Quick actions, conversational flow, glanceable briefings, notifications, voice capture.

The **portal is the companion control console.** Density-first, desktop-first, management-first. Deep editing, configuration, reference management, analytics, inspection, administration. The portal is where you go when you want to *set up* a skill well, *understand* what is powering it, *audit* what the platform did, or *curate* the knowledge base that your assistant draws on.

Key consequence: we don't duplicate the iOS conversation loop here. We don't replicate the "ask your assistant" box. We give the power user, the tenant admin, and the platform owner a workstation.

**Two top-level experiences:**

| Console        | Who                                | What for                                                                  |
|----------------|------------------------------------|---------------------------------------------------------------------------|
| Admin Console  | platform owner, platform admins    | Run the platform. See all tenants/users. Ops, security, usage, integrity. |
| User Console   | tenant admin, tenant member, viewer | Run *my* workspace. Manage my skills, my references, my insights.         |

These are **scope-disjoint**. A platform owner may also have a User Console (they're a tenant member of their own personal tenant) — but the two experiences never bleed into each other. A user inside the User Console cannot accidentally see cross-tenant data. A platform admin inside the Admin Console cannot edit a user's personal preferences.

---

## 1 · UX principles

1. **Scope awareness everywhere.** Every page renders a context strip that tells the user (a) which console they're in, (b) which tenant is active (User Console only), (c) which role they're operating under.
2. **Disjoint IA.** Admin and User sections never show up in the same nav. Switching consoles is an explicit, deliberate action.
3. **Global ≠ tenant ≠ personal.** A control that affects all tenants looks and reads differently from one that affects just my tenant or just me.
4. **Desktop-first density.** We assume a wide viewport. Tables, inline editors, side panels, command bars. Mobile is supported but not optimized — the iOS app is for mobile.
5. **Progressive disclosure.** Overviews on top, drill-in paths to detail. Do not explode every knob on the first screen.
6. **First-class dependencies / references / insights.** These are structural UX concepts, not hidden settings tabs.
7. **Consistent page patterns.** Each skill page, reference section, and admin entity renders with the same skeleton.
8. **Honest empty states.** If data isn't there yet, we say so and point at the setup path. No fake numbers.
9. **Server-enforced scope.** No UI hiding is security. Every gate is re-checked at the router layer.
10. **Never break existing capabilities.** Every surface currently shipping stays reachable. Reorganized, not deleted.

---

## 2 · Current-state problems (from PHASE 0 audit)

| # | Problem                                                                                      | Severity |
|---|----------------------------------------------------------------------------------------------|----------|
| 1 | Three disconnected UIs (`portal.html`, `owner-ui.html`, `workspace-ui.html`) with no shared shell. | High     |
| 2 | `portal.html` mixes global ops (AI providers, scheduled jobs) with marketing ops (founders, waitlist) and security in the same sidebar. | High     |
| 3 | `/owner/*` capabilities are duplicated with `portal.html` nav items for the same concepts (users, audit, tenants). Two ways to do the same thing. | High     |
| 4 | `workspace-ui.html` is a flat tab list with no skill-specific structure, no references center, no insights. It exposes raw data, not a workspace. | High     |
| 5 | No breadcrumbs, no scope labels, no "which tenant am I in?" persistent indicator.           | Medium   |
| 6 | Skills section inside the admin portal lets the admin flip flags globally but has no per-user or per-tenant visibility into setup. | Medium   |
| 7 | Books / channels / links appear in two different places (admin content section AND workspace tabs) with no clear ownership distinction. | Medium   |
| 8 | No onboarding/setup path on the portal. First-time tenant admins are dropped into a raw UI. | Medium   |
| 9 | Dependencies between skills (Training ↔ Calendar, Content ↔ Books, Cooking ↔ Finance) are invisible. | Medium   |
| 10 | No aggregated "Insights" view. Recommendations, warnings, and opportunities are buried in per-page state. | Medium   |
| 11 | Admin "Audit" page shows a raw log; no filtering by actor, action, or tenant scope.         | Low      |
| 12 | No search / filter on books, channels, links.                                                | Low      |

---

## 3 · What must be preserved (PHASE 0 inventory)

Every surface currently in the portal stays reachable. Nothing is deleted on this branch.

### 3.1 From `portal.html` (the legacy admin SPA, 11 sections)

| Section       | What it does today                                     | Where it lives in the new IA         |
|---------------|--------------------------------------------------------|--------------------------------------|
| Dashboard     | KPI snapshot, recent errors                             | Admin Console → Overview             |
| Users         | User directory, suspend/activate                        | Admin Console → Users & Access → Directory |
| AI & Providers| Provider health, model config, cost by domain           | Admin Console → Operations → AI & Providers |
| Scheduled Jobs| Cron visibility                                         | Admin Console → Operations → Scheduled Jobs |
| Skills        | Global skill on/off flags                               | Admin Console → Skills → Global Flags |
| Content       | Platform-level books & content ideas                    | Admin Console → References → Platform Library |
| Settings      | Platform settings, rate-limits, entitlements            | Admin Console → Settings             |
| Invite Codes  | Marketing invite codes (not tenant invites)             | Admin Console → Growth → Invite Codes |
| Founders      | Founder list                                            | Admin Console → Growth → Founders    |
| Waitlist      | Pending waitlist approvals                              | Admin Console → Growth → Waitlist    |
| Audit Trail   | Raw audit_trail browsing                                | Admin Console → Security → Audit Trail |

### 3.2 From `owner-ui.html` (`/owner/*` surface)

| Feature                      | Where it lives in the new IA               |
|------------------------------|--------------------------------------------|
| Tenant list + drill-in       | Admin Console → Tenants → Directory + Detail |
| Cross-tenant usage           | Admin Console → Usage & Consumption        |
| Platform admin grant / revoke| Admin Console → Users & Access → Platform Admins |

### 3.3 From `workspace-ui.html` (`/workspace/*` surface)

| Feature            | Where it lives in the new IA                                 |
|--------------------|--------------------------------------------------------------|
| /me + active tenant | User Console → Home (context strip is persistent)           |
| Books              | User Console → Reference Center → Books (also visible on Content skill) |
| Content notes      | User Console → Reference Center → Notes (also on Content skill) |
| Links              | User Console → Reference Center → Links                      |
| Profile            | User Console → Profile & Preferences                         |
| Security           | User Console → Profile & Preferences → Security              |
| Members (admin)    | User Console → Team → Members                                |
| Invites (admin)    | User Console → Team → Invites                                |
| Tenant settings    | User Console → Team → Settings                               |

### 3.4 Backend surfaces that keep working unchanged

- All `/api/*` routes in `server.ts` (kept; new UI consumes them).
- All `/owner/*` routes (kept; Admin Console consumes).
- All `/workspace/*` routes (kept; User Console consumes).
- All OAuth callbacks (kept).
- `/health`, `/health/detailed` (kept).
- Portal token + admin-id gate (kept; new shells respect it).

No migrations. No breaking API changes. Two NEW optional routes are added as convenience summaries for the shells (see §9.2).

---

## 4 · Top-level information architecture

```
 ┌────────────────────────────────────────────────────────────────┐
 │ Nexus Hub Portal                                               │
 │                                                                │
 │   Console switcher (only visible to users with both scopes):   │
 │   ┌─────────────────────┐  ┌─────────────────────┐             │
 │   │   Admin Console     │  │   User Console      │             │
 │   │   (platform scope)  │  │   (tenant scope)    │             │
 │   └─────────────────────┘  └─────────────────────┘             │
 │                                                                │
 └────────────────────────────────────────────────────────────────┘
```

A user with only one scope lands directly in that console. A platform_admin is also a tenant member of their personal tenant, so they see the switcher. A tenant_member without platform role sees only User Console. An anonymous visitor is redirected to login.

### 4.1 Admin Console — top nav

```
Admin Console
├── Overview               (platform KPIs, alerts, shortcuts)
├── Tenants                (directory, detail, lifecycle)
├── Users & Access         (directory, platform admins, roles)
├── Usage & Consumption    (platform spend, by-tenant, by-user, by-skill)
├── Skills                 (adoption, global flags, setup completeness)
├── Security               (audit trail, access changes, alerts)
├── References Platform    (platform-curated books / content library)
├── Integrations           (connected providers, ingestion health)
├── Operations             (AI & providers, scheduled jobs, error monitor) ← hosts legacy portal.html
├── Growth                 (founders, waitlist, invite codes, marketing)
└── Settings               (platform config, entitlements, rate limits)
```

### 4.2 User Console — top nav

```
User Console  [ Active tenant: «slug» · Role: «role» ▾ ]
├── Home                   (dashboard, setup progress, recent activity, insights feed)
├── Skills                 (one sub-page per skill)
│   ├── Content Creation
│   ├── Secretary
│   ├── Training
│   ├── Finance
│   └── Cooking
├── Reference Center       (books, channels, links, notes — cross-skill)
├── Insights               (recommendations, setup gaps, opportunities)
├── Dependencies           (what each skill needs and what's missing)
├── Activity               (recent edits, operations history)
├── Integrations           (my connected providers)
├── Team                   (members, invites, shared settings — tenant_admin only)
└── Profile                (preferences, security, account)
```

A `tenant_member` without admin role does not see `Team`. A `tenant_viewer` sees read-only versions of everything.

### 4.3 Skill-page internal structure (applies to all 5 skills)

Every skill page has the same skeleton:

```
<skill>
├── Overview           — what this skill is, last activity, key stats
├── Configuration      — agent settings, preferences
├── References         — which books/channels/links feed this skill
├── Dependencies       — what's missing, what's connected, readiness %
├── Activity / Outputs — history of what the skill has done
├── Insights           — skill-specific recommendations
└── Settings           — destructive / reset / disable
```

Skill-specific panels (e.g. Content Radar on the Content skill, Readiness on Training) live INSIDE the Overview or in a dedicated panel registered for that skill. The skeleton is stable; the panels are plug-ins.

---

## 5 · Scope model

| Concept       | Where it lives                   | Visibility                                |
|---------------|----------------------------------|-------------------------------------------|
| Platform data | `users`, `tenants`, `ai_cost_ledger`, `audit_trail`, `platform_admins` | Admin Console only |
| Tenant data   | `tenant_books`, `tenant_content_notes`, `tenant_links`, `tenant_members`, `tenant_invites` | User Console, scoped to active tenant |
| Personal data | `users.preferences`, personal skill overrides, OAuth tokens for my providers | User Console → Profile (me only) |
| Provider cost | `costUsd` columns                | Admin Console only — NEVER surfaced on User Console (pinned by audit tests) |

### 5.1 Context strip

Every User Console page renders a persistent strip at the top of the main area:

```
[tenant-avatar] «Tenant name» · You are «Alice» · Role: «tenant_admin»  [switch tenant ▾]
```

Every Admin Console page renders:

```
[platform-logo] Nexus Hub Platform · You are «Felipe» · Role: «platform_owner»  [switch console ▾]
```

The role label is colored by privilege:
- `platform_owner` / `tenant_admin` → accent orange
- `platform_admin` / `tenant_member` → neutral white
- `platform_readonly` / `tenant_viewer` → muted grey

---

## 6 · Role-based visibility rules

### 6.1 Admin Console (global roles)

| Section             | `platform_owner` | `platform_admin` | `platform_readonly` |
|---------------------|:----------------:|:----------------:|:-------------------:|
| Overview            | ✅               | ✅               | ✅                  |
| Tenants             | full             | full             | read-only           |
| Users & Access      | full             | suspend/activate only; cannot grant platform roles | read-only |
| Usage & Consumption | full             | full             | read-only           |
| Skills              | full             | full             | read-only           |
| Security            | full             | full             | read-only           |
| References Platform | full             | full             | read-only           |
| Integrations        | full             | full             | read-only           |
| Operations          | full             | full             | read-only           |
| Growth              | full             | full             | read-only           |
| Settings            | full             | read-only        | read-only           |

### 6.2 User Console (tenant roles, scoped to active tenant)

| Section         | `tenant_admin` | `tenant_member` | `tenant_viewer` |
|-----------------|:--------------:|:---------------:|:---------------:|
| Home            | ✅              | ✅               | ✅              |
| Skills          | full (edit all)| edit own inputs; read shared | read-only |
| Reference Center| full            | author: full; others: edit if allowed per row | read-only |
| Insights        | ✅              | ✅               | ✅              |
| Dependencies    | ✅              | ✅               | ✅              |
| Activity        | tenant-wide     | own + shared     | own + shared    |
| Integrations    | tenant OAuth    | personal OAuth only | read-only   |
| Team            | ✅              | ❌               | ❌              |
| Profile         | own             | own              | own             |

Rows on `tenant_books` / `tenant_content_notes` / `tenant_links` honor the **authorship rule**: author OR tenant_admin may mutate; tenant_viewer is read-only regardless.

---

## 7 · Dependencies / References / Insights — UX model

These are three first-class cross-cutting concepts with their own pages AND inline panels on every skill.

### 7.1 Dependencies

A **dependency** is something a skill needs to work well. Shape:

```typescript
interface Dependency {
  id: string;
  skillId: string;               // 'content' | 'secretary' | ...
  kind: 'integration' | 'reference' | 'setting' | 'cross-skill' | 'oauth';
  label: string;                 // "Google Calendar connected"
  status: 'ready' | 'missing' | 'degraded' | 'unknown';
  cta: { label: string; href: string } | null;  // where to fix it
  details?: string;
}
```

Rendering:
- On each **skill page**, a "Dependencies" panel lists this skill's dependencies with a status pill.
- On the **User Console → Dependencies** page, all dependencies across all skills are aggregated, grouped by kind.
- On the **Admin Console → Skills** page, an aggregate per-tenant-cohort view: "Of N tenants with content skill enabled, M are missing a primary reference channel."

### 7.2 References

A **reference** is a piece of knowledge the user has curated: a book, a channel, a link, a note. Shape:

```typescript
interface Reference {
  id: number;
  tenantId: number;
  authorUserId: number | null;
  type: 'book' | 'channel' | 'link' | 'note';
  title: string;
  url?: string;
  author?: string;              // book author
  status?: string;              // book status, channel active/muted
  usedBySkills: string[];       // which skills consume this reference
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
```

Rendering:
- **Reference Center** is the hub. Tabs per type (Books / Channels / Links / Notes). Search + filter + tag.
- Each reference card shows "Used by" badges → click-through to the skill.
- Each **skill page** has a "References" tab filtered to that skill's consumers.
- Admin Console has a **Platform Library** that's distinct from tenant references — platform-curated content that tenants can "fork" into their own library.

### 7.3 Insights

An **insight** is a recommendation, warning, or observation. Shape:

```typescript
interface Insight {
  id: string;
  scope: 'platform' | 'tenant' | 'user';
  skillId: string | null;
  severity: 'info' | 'nudge' | 'warning' | 'alert';
  kind: 'setup' | 'usage' | 'opportunity' | 'cross-skill' | 'dependency-missing';
  title: string;
  body: string;
  cta: { label: string; href: string } | null;
  createdAt: string;
  dismissedAt?: string;
}
```

Rendering:
- **Home** shows the top 3 insights for the user, newest + highest severity.
- **Insights** page shows all of them, filterable by skill / severity / kind.
- Each **skill page** has an "Insights" panel filtered to that skill.
- Admin Console has a parallel "Platform Insights" page (tenant adoption risk, underconfigured tenants).

### 7.4 Honest empty states

The insight engine, the dependency engine, and the skill-specific adoption analytics do not all exist on the backend yet. Where they don't, the UI renders:

> **No insights yet.** Once we have a few days of activity on this skill we'll start surfacing recommendations here.

Not fake numbers. Not "3 insights detected" with made-up content. The spec explicitly forbids that.

---

## 8 · Navigation & page patterns

### 8.1 Shell composition

```
┌───────────────────────────────────────────────────────────────────────┐
│  [Logo] Nexus Hub       [Admin / User switcher]    [Global search]    │  ← App bar
├──────────────┬────────────────────────────────────────────────────────┤
│              │  [Context strip — tenant/role or platform/role]        │
│   Sidebar    ├────────────────────────────────────────────────────────┤
│   (primary   │                                                        │
│    nav)      │   [Page title + breadcrumb]                            │
│              │                                                        │
│              │   [Page content — overview / list / detail]            │
│              │                                                        │
│              │   [Side panels — dependencies, insights, references]  │
│              │                                                        │
├──────────────┴────────────────────────────────────────────────────────┤
│  Footer: version, sign out, doc link                                  │
└───────────────────────────────────────────────────────────────────────┘
```

### 8.2 Page templates

We codify three templates, reused across all pages:

- **Overview template** — KPI row + insights strip + quick-action grid.
- **Directory template** — search/filter bar + table + row drill-in to detail drawer.
- **Detail template** — header + tabbed subsections + side panels for dependencies/insights.

Every page in the app picks one of the three.

### 8.3 Breadcrumbs

- Admin Console: `Admin › Tenants › acme-corp › Members`
- User Console: `Workspace › Skills › Content Creation › References`

The first breadcrumb segment identifies the console unambiguously.

### 8.4 Quick actions

Every Overview page has a "Quick actions" grid of the 4–6 most important operations. Admin Overview example: *Invite a platform admin · View audit · Review waitlist · Suspend a user*. User Home example: *Add a book · Set up a channel · Invite a teammate · Connect Google Calendar*.

### 8.5 Global search (future)

Reserved slot in the app bar. Stubbed today, wired later. See open-items.

---

## 9 · Implementation plan

### 9.1 What we build on this branch

1. **NEW** `src/portal/admin-console.html` — the Admin Console shell. Embeds the legacy `portal.html` as an iframe / directly reuses its sections for the "Operations" and "Growth" blocks. Adds new NAV + new pages for Tenants, Usage, Skills, Security, References, Integrations, Settings consumption from `/owner/*` and `/api/*`.
2. **REFACTORED** `src/portal/workspace-ui.html` — renamed mental model to "User Console" (filename kept for backward compat). New left-nav, per-skill pages with the 7-section skeleton, Reference Center, Insights, Dependencies, Activity, Integrations, Team, Profile.
3. **NEW** `src/portal/portal-shell.css` — single shared stylesheet for both consoles. Extracts the design tokens used by the existing three HTML files. Shared components: sidebar, app bar, context strip, tabs, tables, side panels, empty/loading/error states.
4. **UPDATED** `src/portal/server.ts` — route aliases so `/admin` → admin-console.html, `/console` → workspace-ui.html, `/`→ landing or workspace depending on auth. Existing routes kept.
5. **NEW** `src/api/portal-shell-router.ts` — small helper endpoints (see §9.2).
6. **Docs** — the five required docs, plus open-items + final-report.
7. **Tests** — new vitest file for the shell-router endpoints.

### 9.2 Backend additions (small, additive, non-breaking)

Two new endpoints, mounted under `/workspace/` and `/owner/` so they inherit the existing guards:

| Route                              | Purpose                                                             | Auth             |
|------------------------------------|---------------------------------------------------------------------|------------------|
| `GET /workspace/console/home`      | Aggregated home payload: tenant, role, setup-progress %, skill-summary, top 3 insights, top 3 dependency gaps. Backed by existing tables; computed on request. | Tenant member |
| `GET /owner/console/overview`      | Aggregated admin overview: tenant count, user count, usage 24h, waitlist backlog, recent audit events. Backed by existing tables. | Platform admin |

Both routes are **additive** — they compose data from existing sources and never mutate. They are thin convenience endpoints so the shell doesn't make 8 parallel fetches on first paint.

Nothing else in the backend changes. No migrations. No new tables.

### 9.3 What we do NOT build on this branch

- Global search (stubbed).
- Real insight engine (honest empty states).
- Cross-skill signal bus wiring (already tracked as Phase 1 in CLAUDE.md).
- iOS app changes (out of scope by the task prompt).
- Framework migration (vanilla JS stays).
- Analytics that require new data pipelines (honest empty states).

All tracked in `nexus-hub-portal-uiux-open-items.md`.

---

## 10 · Rollout & rollback

- Work lands on `feature/nexus-hub-portal-uiux-admin-user-console`.
- Rollback is `git checkout main` + delete the branch + delete the backup tag. All new files are additive except the refactored `workspace-ui.html`, which is also covered by `backup-nexus-hub-uiux-before-admin-user-console-pass-20260422-2026`.
- Legacy `portal.html` is NOT modified. Every existing URL still resolves exactly as before. `/admin` is a new alias; `/portal` still serves the legacy dashboard unchanged.
- The new `admin-console.html` is opt-in via the `/admin` route until human review approves promoting it.

---

## 11 · Acceptance checklist (validated by PHASE 10)

- [ ] Backup tag + feature branch exist.
- [ ] `/portal`, `/admin`, `/owner-ui`, `/workspace-ui` still resolve to the legacy UIs unchanged (no bookmark breakage).
- [ ] `/admin-console` serves the NEW Admin Console (preview path; promoting it to `/admin` is a post-review gate).
- [ ] `/console` and `/user-console` serve the NEW User Console.
- [ ] Legacy `portal.html` sections all remain reachable from the new Admin Console.
- [ ] User Console Home shows active tenant + role + setup progress.
- [ ] Every skill has a page following the 7-section skeleton.
- [ ] Reference Center shows books/channels/links/notes with search.
- [ ] Insights / Dependencies pages render honest empty states when data is sparse.
- [ ] Context strip renders on every page.
- [ ] Breadcrumbs render on every page.
- [ ] Role-based visibility rules enforced in shell AND at route layer.
- [ ] `costUsd` never appears on any User Console page.
- [ ] `npx tsc --noEmit` clean.
- [ ] Full vitest suite no regressions vs. baseline.
