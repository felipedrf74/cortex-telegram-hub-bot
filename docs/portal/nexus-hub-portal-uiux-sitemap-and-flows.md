# Nexus Hub Portal — Sitemap & User Flows

**Branch:** `feature/nexus-hub-portal-uiux-admin-user-console`
**Companion:** `nexus-hub-portal-uiux-admin-user-console-spec.md`

---

## 1 · Full sitemap

### 1.1 Public / auth surfaces

```
/                          → landing OR workspace-ui (auth-aware)
/landing                   → landing.html (public marketing)
/login                     → existing login flow (unchanged)
/invite/accept?code=...    → invite acceptance landing (shipped 2026-04-22 —
                              strips ?code from URL on load, prompts for JWT if
                              needed, handles all server error codes, persists
                              the newly-joined tenant as active on success)
/health, /health/detailed  → ops health endpoints (unchanged)
```

### 1.2 Admin Console

```
/admin-console                            → NEW Admin Console shell → Overview
                                             (/admin STAYS on legacy dashboard during rollout —
                                              promotion of /admin to the new console is an
                                              explicit post-review step; bookmarks to /admin
                                              continue to hit portal.html unchanged.)
/admin/overview                           → Overview
/admin/tenants                            → Directory (list)
/admin/tenants/:tenantId                  → Detail drawer / page
/admin/tenants/:tenantId/members          → Members tab
/admin/tenants/:tenantId/usage            → Usage tab
/admin/tenants/:tenantId/audit            → Tenant-scoped audit
/admin/users                              → User directory
/admin/users/:userId                      → User detail
/admin/users/platform-admins              → Platform admin roster + grant/revoke
/admin/usage                              → Platform usage
/admin/usage/by-tenant                    → Sliced by tenant
/admin/usage/by-user                      → Sliced by user
/admin/usage/by-skill                     → Sliced by skill
/admin/skills                             → Skill adoption + global flags
/admin/skills/:skillId                    → Skill drill-in (cohort setup health)
/admin/security                           → Security overview
/admin/security/audit                     → Full audit trail
/admin/security/alerts                    → Rate-limit hits, suspicious events
/admin/references                         → Platform-curated content library
/admin/integrations                       → Integration health
/admin/operations                         → Embed / link-out to legacy portal.html
/admin/operations/ai                      → AI & providers (legacy)
/admin/operations/jobs                    → Scheduled jobs (legacy)
/admin/operations/errors                  → Error monitor (legacy)
/admin/growth                             → Growth overview
/admin/growth/waitlist                    → Waitlist approvals (legacy)
/admin/growth/founders                    → Founders (legacy)
/admin/growth/invite-codes                → Marketing invite codes (legacy)
/admin/settings                           → Platform settings
/admin/settings/entitlements              → Plan/entitlement config
/admin/settings/rate-limits               → Rate-limit configuration
```

**Implementation note.** Routes under `/admin/operations/*` and `/admin/growth/*` are link-outs into the legacy `portal.html` — we do not rebuild those surfaces on this branch; we reorganize their entry points.

### 1.3 User Console

```
/console                                  → User Console → Home
/console/home                             → Home dashboard
/console/skills                           → Skill index
/console/skills/content                   → Content Creation workspace
/console/skills/content/overview
/console/skills/content/configuration
/console/skills/content/references
/console/skills/content/dependencies
/console/skills/content/activity
/console/skills/content/insights
/console/skills/content/radar             → (plug-in: Content Radar)
/console/skills/secretary                 → Secretary workspace (same tabs)
/console/skills/training                  → Training workspace
/console/skills/finance                   → Finance workspace
/console/skills/cooking                   → Cooking workspace
/console/references                       → Reference Center
/console/references/books
/console/references/channels
/console/references/links
/console/references/notes
/console/insights                         → Insights feed
/console/dependencies                     → Dependency map
/console/activity                         → Activity / history
/console/integrations                     → Personal + tenant integrations
/console/team                             → Team home (tenant_admin only)
/console/team/members
/console/team/invites
/console/team/settings
/console/profile                          → Profile / security / preferences
```

**Implementation note.** The User Console is a single-page shell. Routes are hash-routed (`/console#/skills/content/overview`) to avoid a full backend routing layer for the SPA. This matches the existing `workspace-ui.html` pattern (tabs via `data-tab`) but adds a second dimension (skill + sub-tab).

### 1.4 Backend-served API / OAuth (unchanged)

```
/api/*                                    → all existing admin API endpoints
/api/v1/*                                 → iOS REST API
/owner/*                                  → owner-console backend (Phase 2A)
/workspace/*                              → workspace backend (Phase 2B–D)
/oauth/*/callback                         → OAuth callbacks
```

### 1.5 Legacy aliases (stay working)

```
/                                         → legacy portal.html (unchanged)
/portal                                   → legacy portal.html (unchanged)
/admin                                    → legacy portal.html (UNCHANGED during rollout)
/admin-console                            → NEW admin-console.html (preview path)
/owner-ui                                 → owner-ui.html (unchanged)
/workspace-ui                             → workspace-ui.html (unchanged — the refactor
                                             landed in a NEW file, not here)
/console                                  → NEW user-console.html
/user-console                             → NEW user-console.html (alias)
```

---

## 2 · Navigation model

### 2.1 Admin Console primary sidebar

```
┌───────────────────────────┐
│  NEXUS HUB · Admin        │
├───────────────────────────┤
│  OPERATIONAL              │
│  ● Overview               │  ← home
│  ○ Tenants         [142]  │  ← badge = count
│  ○ Users & Access  [1.2k] │
│  ○ Usage                  │
│  ○ Skills                 │
│  ○ Security        [3]    │  ← badge = unread alerts
├───────────────────────────┤
│  CONTENT & INFRA          │
│  ○ References Platform    │
│  ○ Integrations           │
│  ○ Operations       ›     │  ← link-out chevron to legacy
│  ○ Growth            [7]  │  ← badge = waitlist backlog
│  ○ Settings               │
├───────────────────────────┤
│  v4.14.60 · sign out      │
└───────────────────────────┘
```

### 2.2 User Console primary sidebar

```
┌───────────────────────────┐
│  NEXUS HUB · Workspace    │
│  [acme-corp ▾]            │  ← tenant switcher (only if >1 tenant)
├───────────────────────────┤
│  ● Home                   │
│  ○ Insights        [2]    │  ← badge = new insights
│  ○ Dependencies    [!]    │  ← badge = missing dependency
├───────────────────────────┤
│  SKILLS                   │
│  ○ Content                │
│  ○ Secretary              │
│  ○ Training               │
│  ○ Finance                │
│  ○ Cooking                │
├───────────────────────────┤
│  REFERENCES               │
│  ○ Books            [18]  │
│  ○ Channels         [6]   │
│  ○ Links            [42]  │
│  ○ Notes            [11]  │
├───────────────────────────┤
│  ○ Activity               │
│  ○ Integrations           │
│  ○ Team             admin │  ← admin-only
│  ○ Profile                │
├───────────────────────────┤
│  v4.14.60 · sign out      │
└───────────────────────────┘
```

### 2.3 Console switcher

A dropdown in the top app bar, visible only if the signed-in user has scope in both consoles.

```
[  Console: Admin ▾  ]
   ├ Admin Console       ← (platform roles)
   └ User Console · acme-corp ← (active tenant)
```

### 2.4 Tenant switcher (User Console)

```
[  acme-corp ▾  ]
   ├ ✓ acme-corp (tenant_admin)
   ├ beta-inc (tenant_member)
   └ personal (tenant_admin)
```

Changes the active tenant context. The app reloads data scoped to the selected tenant. The `X-Tenant-Id` header used by fetch calls is updated accordingly. Reuses the existing `/workspace/tenants` endpoint.

### 2.5 Breadcrumbs

Every non-home page renders a breadcrumb row immediately under the context strip.

Examples:
- `Admin › Tenants › acme-corp › Members`
- `Admin › Security › Audit trail`
- `Workspace › Skills › Content Creation › References`
- `Workspace › Reference Center › Books › "Atomic Habits"`

The first segment is clickable and goes to the console home. Intermediate segments are clickable.

---

## 3 · Key flows

### 3.1 First-time tenant admin

Goal: Alice signs up, becomes tenant_admin of a new tenant, and gets her team set up.

```
1. Alice signs up via iOS or landing.
2. Backend creates users row + solo tenant (tenant.id == users.id).
3. Alice opens portal → /console → Home.
4. Home dashboard renders:
   [Setup progress: 25%] ← 1 of 4 milestones done
   [Next steps]
     □ Connect Google Calendar
     □ Add your first book
     □ Invite a teammate
     □ Configure Content skill
5. Each next-step card has a CTA that deep-links into the right page:
     → Integrations → Google
     → Reference Center → Books → Add
     → Team → Invites → Create
     → Skills → Content → Configuration
6. As Alice completes each, the progress bar animates and the card fades.
7. When all 4 are done, Home shows a "You're all set — here's what's happening" layout
   with Insights feed + recent activity.
```

### 3.2 Tenant admin invites a teammate

```
1. Alice in /console → Team → Invites.
2. Clicks "Invite someone".
3. Form: email + role dropdown (member / viewer / admin).
4. Submit → POST /workspace/invites (existing endpoint, audited).
5. Toast: "Invited bob@… — copy the invite link below."
6. Modal shows the invite URL (format: {origin}/invite/accept?code=XYZ).
7. One-click "Copy" button. Audit row already written.
```

### 3.3 Content creator configures Content skill

```
1. Alice in /console → Skills → Content → Overview.
2. Overview shows:
   - Last run: never / 3h ago / …
   - Active references: 4 books, 2 channels, 12 links
   - Setup completeness: 60% (missing: voice guidelines)
3. Click "Configuration" tab.
4. Editors for: agent prompt, voice guidelines, output preferences.
5. Save → POST /workspace/skills/content/config (future — see open-items).
   For now: edits land in tenant_config (existing key/value) with a clear empty-state
   if the backend doesn't persist yet.
6. Click "References" tab → filtered view of Reference Center (only books/channels/links
   tagged as Content-relevant, pulled from tenant_books etc. matching a tag).
7. Click "Dependencies" tab → status of: Google OAuth for research, books library,
   channel list.
```

### 3.4 Tenant admin removes a teammate

```
1. Alice in /console → Team → Members.
2. Row for Bob with [Remove] button (admin-only, visible because her role == tenant_admin).
3. Click → confirm modal: "Remove Bob from this tenant? He will lose access to all shared resources."
4. Confirm → DELETE /workspace/members/:userId.
5. Server: last-admin guard, audit row written (tenant.member.remove).
6. UI refreshes member list, toast success.
```

### 3.5 Platform owner reviews a suspicious tenant

```
1. Felipe in /admin → Security → Alerts.
2. Sees: "Tenant beta-inc: 120 rate-limit hits in 1h".
3. Click → drill into tenant beta-inc detail.
4. Tabs: Members / Usage / Audit.
5. Usage tab shows tokens + costUsd (admin-scope).
6. Audit tab shows recent events scoped to tenant_id = beta-inc.
7. If action needed: [Suspend tenant] (future — see open-items). For now:
   Felipe can suspend the individual users via Users & Access → User detail.
```

### 3.6 Platform owner grants platform_admin role

```
1. Felipe in /admin → Users & Access → Platform admins.
2. Sees current roster.
3. Click "Grant role".
4. Form: userId + role dropdown (platform_admin / platform_readonly).
5. Submit → POST /owner/platform-admins.
6. If target user status != active → 400 USER_NOT_ACTIVE (fix #3 from hardening pass).
   UI surfaces the reason: "Cannot grant — user is suspended. Reactivate first."
7. On success → row added to roster, audit row written (platform.admin.grant).
```

### 3.7 User explores dependencies for a skill

```
1. Bob in /console → Skills → Content → Dependencies.
2. Panel shows:
   [✓] Google Calendar        connected, last sync 2m ago
   [✓] Books library          18 books
   [!] Content channels       0 channels — Content skill runs blind without
                               reference channels. [Add a channel]
   [✓] Voice guidelines       configured
   [?] Tenant plan            free tier — 100 generations/month cap
3. Click [Add a channel] → deep-links to Reference Center → Channels → Add.
```

### 3.8 Tenant admin audits recent changes

```
1. Alice in /console → Activity.
2. List of recent events (tenant-scoped, from audit_trail WHERE user_id = active_tenant).
3. Each row: actor avatar + what they did + when + object.
   Example: "Alice revoked invite #12 — 3h ago"
   Example: "Bob added book 'Atomic Habits' — 1d ago"
4. Filter by: actor / action type / date range.
5. Click row → detail drawer with full JSON payload for power users.
```

### 3.9 Platform owner reviews cross-tenant usage

```
1. Felipe in /admin → Usage.
2. Default view: last-7-day rollup. Total tokens / total cost.
3. Tabs: [By tenant] [By user] [By skill] [By provider].
4. By-tenant tab: table with tenant / tokens / cost / top-skill.
5. Click a tenant row → drill into Tenant detail → Usage tab.
6. Cost columns are visible in Admin Console only.
7. User Console → Home shows tokens-only, no cost (cost-privacy invariant).
```

---

## 4 · Empty / loading / error states

Every page renders one of four visual states:

| State    | Trigger                                          | What renders                                    |
|----------|--------------------------------------------------|-------------------------------------------------|
| Empty    | Data source returned 0 rows                      | Illustration + explainer + primary CTA          |
| Loading  | Fetch in flight                                  | Skeleton rows / muted placeholders              |
| Error    | Fetch failed (4xx except 404 / 5xx)              | Inline banner with retry + technical details toggle |
| Ready    | Data present                                     | Normal content                                  |

### 4.1 Empty-state copy guidelines

- Never use "No data" alone. Always explain WHY.
- Always show the path to fix it.
- Use second-person ("You haven't added a book yet.") not third-person.

Example, Reference Center → Books (empty):
```
[illustration]
You haven't added a book yet.
Your Content and Secretary skills use your library as reference material —
the more books you add, the richer the context.

[Add a book]   [Import from Goodreads (coming soon)]
```

Example, Insights (empty):
```
[illustration]
No insights yet.
Once there are a few days of activity on your workspace, we'll surface
recommendations, setup gaps, and opportunities here.

[Explore Skills]
```

### 4.2 Loading states

We skeleton-load rather than spinner-load whenever possible. Skeletons match the final shape (3 grey rectangles for a 3-row table). Spinners are reserved for form submits.

### 4.3 Error states

Error banners are scoped to the panel that failed, not full-page — the rest of the UI stays usable. Retry button calls the same fetch. "Details" toggle reveals technical error body (for power users copying into support tickets).

---

## 5 · Interaction patterns

### 5.1 Tables

- Sortable columns (click header).
- Row hover → action buttons slide in from right.
- Row click → detail drawer (right 40% of viewport) — avoids losing list context.
- Bulk-select checkboxes in admin tables with >1 selection.

### 5.2 Forms

- Save button is sticky to the bottom-right when editing a long form.
- Destructive actions (delete, remove member) always require a confirm modal with the exact subject quoted back ("Remove Bob from acme-corp?").
- Optimistic UI on low-risk operations (toggles); strict-wait UI on high-risk (deletes, grants).

### 5.3 Drawers vs. dialogs

- **Drawer** — for detail views that don't require a decision (tenant detail, audit row detail).
- **Dialog** — for decisions (confirm delete, complete an action).

### 5.4 Toasts

- 3-second default. Dismissible. Auto-dismissed on navigate-away.
- Severity: success (green dot), warning (amber dot), error (red dot).
- Never contain raw error bodies; link to the error-details toggle instead.

---

## 6 · Accessibility & keyboard

- All interactive elements reachable by Tab.
- Esc closes drawer / dialog / dropdown.
- `/` focuses global search (future).
- Skip-to-content link in app bar for screen readers.
- Color is never the only signal — status pills include text labels.

---

## 7 · Responsive behavior

- Viewport < 1024 px: sidebar collapses to an icon rail, labels in hover tooltip.
- Viewport < 768 px: sidebar becomes a top drawer. Acknowledged as not the primary UX — the iOS app is for small viewports.

---

## 8 · Versioning surface

Footer shows `v{pkg.version}` pulled from `/api/snapshot` (existing endpoint). Clicking it toggles a panel with build SHA, deployed-at timestamp, and environment label (staging / prod). Aids debugging for support tickets.
