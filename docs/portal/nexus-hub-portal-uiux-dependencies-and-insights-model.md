# Nexus Hub Portal — Dependencies / References / Insights Model

**Branch:** `feature/nexus-hub-portal-uiux-admin-user-console`
**Purpose:** Define the UX model + data contracts for the three cross-cutting concepts that make the User Console feel like a real workspace: **Dependencies, References, Insights.**

---

## 1 · Why these three concepts deserve first-class status

A skill-based assistant has three kinds of "things the user should care about":

1. **Dependencies** — what each skill *needs* to do good work. Without them the skill is blind / dumb / empty.
2. **References** — what the user has *given* the skill. Books, channels, links, notes. Curated knowledge.
3. **Insights** — what the system has *noticed* the user might want to know. Recommendations, warnings, opportunities.

In the existing portal these are scattered: integrations live under settings, books live under a content tab, insights live nowhere (they don't exist yet). The new IA promotes all three to persistent first-class pages AND consistent inline panels on every skill page.

---

## 2 · Dependencies

### 2.1 Data model

```typescript
type DependencyKind =
  | 'integration'    // Google Calendar, Garmin, Strava, …
  | 'reference'      // at least N books in library, at least N channels, …
  | 'setting'        // a required config key, e.g. voice guidelines
  | 'cross-skill'    // skill B needs skill A enabled
  | 'oauth';         // a specific OAuth token valid

type DependencyStatus =
  | 'ready'          // green, all good
  | 'missing'        // red, user must take action
  | 'degraded'       // amber, partial (e.g. token expired)
  | 'unknown';       // grey, we can't determine status yet

interface Dependency {
  id: string;                     // stable id, e.g. 'content.channel.primary'
  skillId: string;                // 'content' | 'secretary' | ...
  kind: DependencyKind;
  label: string;                  // "Primary reference channel"
  explainer: string;              // "Content skill pulls topic signals from channels."
  status: DependencyStatus;
  cta: { label: string; href: string } | null;   // "Add a channel" → /console/references/channels
  details?: Record<string, unknown>;              // raw data for the drawer
  updatedAt: string;
}
```

### 2.2 Dependency catalog (by skill)

The catalog is static TypeScript — each skill declares its dependencies. The status evaluator is runtime.

**Content Creation**

| id                                | label                         | kind        | Status source                                         |
|-----------------------------------|-------------------------------|-------------|-------------------------------------------------------|
| `content.channel.primary`         | Primary reference channel     | reference   | count of tenant channels where `active = 1` ≥ 1       |
| `content.books.library`           | Books library                 | reference   | count of tenant_books ≥ 1                             |
| `content.voice.guidelines`        | Voice & brand guidelines      | setting     | tenant setting `content.voice_guidelines` is non-empty |
| `content.oauth.google`            | Google Drive (for drafts)     | oauth       | oauth_tokens row for user + provider=google, valid     |
| `content.links.curated`           | Curated links                 | reference   | count of tenant_links tagged `content` ≥ 3            |

**Secretary**

| id                                 | label                         | kind        | Status source                                         |
|------------------------------------|-------------------------------|-------------|-------------------------------------------------------|
| `secretary.calendar.primary`       | Primary calendar (Google/Outlook) | oauth   | any calendar oauth token valid                        |
| `secretary.profile.routines`       | Daily routines configured      | setting     | user pref `secretary.routines` is non-empty           |
| `secretary.priority.rules`         | Priority rules                | setting     | user pref `secretary.priority_rules` is non-empty      |
| `secretary.todoist.oauth`          | Todoist (optional)            | oauth       | optional; degraded if stale                           |

**Training**

| id                                 | label                         | kind        | Status source                                         |
|------------------------------------|-------------------------------|-------------|-------------------------------------------------------|
| `training.device.garmin`           | Garmin Connect                | oauth       | garmin token valid                                    |
| `training.profile.goals`           | Training goals                | setting     | user pref `training.goals` is non-empty                |
| `training.profile.equipment`       | Equipment availability        | setting     | user pref `training.equipment` is non-empty            |
| `training.cross.secretary`         | Secretary (for scheduling)    | cross-skill | secretary skill enabled                                |

**Finance**

| id                                 | label                         | kind        | Status source                                         |
|------------------------------------|-------------------------------|-------------|-------------------------------------------------------|
| `finance.profile.budget`           | Monthly budget                | setting     | user pref `finance.budget` is non-empty                |
| `finance.profile.categories`       | Expense categories            | setting     | user pref `finance.categories` is non-empty            |
| `finance.cross.cooking`            | Cooking skill (for meal cost) | cross-skill | cooking skill enabled (optional)                       |

**Cooking**

| id                                 | label                         | kind        | Status source                                         |
|------------------------------------|-------------------------------|-------------|-------------------------------------------------------|
| `cooking.profile.restrictions`     | Dietary restrictions          | setting     | user pref `cooking.restrictions` set                   |
| `cooking.profile.preferences`      | Meal preferences              | setting     | user pref `cooking.preferences` set                    |
| `cooking.cross.finance`            | Finance (for meal cost)       | cross-skill | finance skill enabled (optional)                       |
| `cooking.cross.training`           | Training (for nutrition sync) | cross-skill | training skill enabled (optional)                      |

### 2.3 Rendering

**Inline panel on every skill page:**

```
Dependencies                                          [3 / 5 ready]
─────────────────────────────────────────────────────
[✓] Primary reference channel                        ready
[✓] Books library                          18 books  ready
[!] Voice & brand guidelines              not set    missing  [Configure →]
[✓] Google Drive                                     ready
[ ] Curated links                         2 of 3     degraded [Add links →]
```

**Dedicated page (`/console/dependencies`):**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Dependencies                                  Readiness: 11 / 18   │
├─────────────────────────────────────────────────────────────────────┤
│  Group by: [ Skill ▾ ]  Filter: [ Missing only ]                    │
├─────────────────────────────────────────────────────────────────────┤
│  CONTENT (3 / 5 ready)                                              │
│  ...                                                                │
│  SECRETARY (4 / 4 ready) ✓                                          │
│  ...                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.4 Backend contract

The status evaluator is computed server-side on demand. Endpoint:

```
GET /workspace/console/home
```

returns, among other fields:

```json
{
  "dependencies": {
    "total": 18,
    "ready": 11,
    "missing": 4,
    "degraded": 2,
    "unknown": 1,
    "items": [ { "id": "...", "label": "...", "status": "ready", ... }, ... ]
  }
}
```

The shell caches it for 30 s to avoid repeat queries when navigating between skill pages.

---

## 3 · References

### 3.1 Data model

```typescript
type ReferenceType = 'book' | 'channel' | 'link' | 'note';

interface Reference {
  id: number;
  tenantId: number;
  authorUserId: number | null;
  type: ReferenceType;
  title: string;
  url?: string;           // link, channel
  author?: string;        // book
  status?: string;        // book: want_to_read | reading | finished | abandoned
                          // channel: active | muted
  body?: string;          // note only
  tags: string[];
  usedBySkills: string[]; // derived
  createdAt: string;
  updatedAt: string;
}
```

### 3.2 Storage

Already in the schema (migration 078):

- `tenant_books (id, tenant_id, author_user_id, title, author, status, notes, tags, ...)`
- `tenant_content_notes (id, tenant_id, author_user_id, title, body, tags, ...)`
- `tenant_links (id, tenant_id, author_user_id, title, url, tags, ...)`

Channels are not yet tenant-scoped in the portal DB; they live in a per-user `channels` table wired by migration 047-ish (see `/api/channels`). **Open item**: promote channels to tenant-scoped for consistency with the rest of the reference model.

### 3.3 "Used by skills" derivation

Two strategies:

1. **Explicit tagging.** The author tags the reference with `skill:content` / `skill:secretary`. Simple, user-driven, no ambiguity.
2. **Implicit routing.** Each skill's prompt pipeline records which references it pulled, aggregated into a materialized view.

We implement strategy 1 on this branch (tag-based). Strategy 2 requires pipeline instrumentation; tracked as open item.

### 3.4 Reference Center page

```
┌─────────────────────────────────────────────────────────────────────┐
│  Reference Center                                       [+ Add ▾]   │
├─────────────────────────────────────────────────────────────────────┤
│  [Books 18]  [Channels 6]  [Links 42]  [Notes 11]                   │
│                                                                     │
│  Search: [           ]  Tag: [ All ▾ ]  Skill: [ All ▾ ]            │
├─────────────────────────────────────────────────────────────────────┤
│  ▸ Atomic Habits — James Clear               finished  · 2 skills   │
│  ▸ Deep Work — Cal Newport                   reading   · 1 skill    │
│  ▸ …                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

Row drill-in → right drawer with edit form, tags, usage stats.

### 3.5 Per-skill reference filter

Each skill's "References" tab filters the Reference Center by the `skill:<id>` tag. User can add a reference directly from there with the tag pre-applied.

---

## 4 · Insights

### 4.1 Data model

```typescript
type InsightScope    = 'platform' | 'tenant' | 'user';
type InsightSeverity = 'info' | 'nudge' | 'warning' | 'alert';
type InsightKind     =
  | 'setup'                  // "Voice guidelines missing"
  | 'usage'                  // "You used 80% of your free-tier quota"
  | 'opportunity'            // "3 books unused by any skill — tag them"
  | 'cross-skill'            // "Training depends on Secretary, which isn't configured"
  | 'dependency-missing'     // "Content skill has no primary channel"
  | 'anomaly'                // (future) "Unusual activity detected"
  | 'recommendation';        // "Try the Content Radar beta"

interface Insight {
  id: string;
  scope: InsightScope;
  skillId: string | null;
  severity: InsightSeverity;
  kind: InsightKind;
  title: string;
  body: string;
  cta: { label: string; href: string } | null;
  createdAt: string;
  dismissedAt?: string | null;
  relatedIds?: string[];   // other insight ids in the same cluster
}
```

### 4.2 Generators (MVP)

For this branch, we do **not** build a full insight engine. We implement three deterministic generators that produce insights from existing data:

1. **Dependency-derived.** For each `Dependency` with `status = missing`, emit one `Insight` with `kind = 'dependency-missing'` and `severity = 'warning'`. CTA = the dependency's CTA.
2. **Quota-derived.** Read `ai_usage` for the last 30 days. If rolling sum > 80% of plan quota, emit `kind = 'usage'` with `severity = 'nudge'`.
3. **Onboarding-derived.** If the user's setup-progress < 100%, emit `kind = 'setup'` with `severity = 'nudge'` and CTA to Home's setup section.

All three run server-side in the same endpoint that returns the Home payload. They are pure functions of existing data — zero new tables, zero new background jobs.

**Future generators** (not on this branch):

- "Books unused by any skill" (requires strategy-2 reference usage tracking)
- "Cross-skill cadence mismatch" (requires intelligence-bus wiring from Phase 1)
- Anomaly detection (requires baseline + model inference)

### 4.3 Rendering

**Home (top 3):**
```
Insights
─────────────────────────────────────────────────────
⚠ Content skill has no primary channel
   Content needs at least one reference channel to surface topic opportunities.
   [Add a channel →]
⚠ Voice guidelines not configured
   Without guidelines, generated content uses a generic tone.
   [Configure →]
◦ You've used 84% of this month's free-tier quota
   [View usage →]
```

**Insights page (full feed):**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Insights                       Filter: [ All ▾ ]   [ Refresh ]     │
├─────────────────────────────────────────────────────────────────────┤
│  ⚠ 5 setup gaps                                                     │
│  ▸ Content skill has no primary channel                             │
│  ▸ Voice guidelines not configured                                  │
│  ▸ Training goals not set                                           │
│  ...                                                                │
│                                                                     │
│  ◦ 2 nudges                                                         │
│  ▸ You've used 84% of this month's quota                            │
│  ...                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

**Dismiss behavior.** User can dismiss an insight. Dismissed insights move to a "Dismissed" section, not deleted. They re-surface if the underlying condition changes (e.g. they dismissed a setup warning, then un-configured the setting). Implementation: client-side localStorage for MVP; server-side `user_dismissed_insights` table later.

### 4.4 Admin Console insights (Platform Insights)

Parallel surface on `/admin/security/insights` (future) and `/admin/skills` (now). Generators:

- **Tenant adoption risk:** tenants with 0 activity in 14 days.
- **Underconfigured tenants:** tenants with < 50% dependency readiness.
- **Provider cost spike:** cost in last 24h > 2× 7-day average.

MVP renders only the first two (from existing `tenant_members` + `ai_usage`).

---

## 5 · Cross-cutting UX rules

### 5.1 Never show fake intelligence

If a generator can't compute a value, we render "Not enough data yet" with a hint about what would unlock the feature. We never invent a number or a recommendation.

### 5.2 Every insight has a CTA

An insight without a path to resolution is noise. If we can't link to an action, we don't surface it.

### 5.3 Dependencies and insights agree

A "missing" dependency MUST produce exactly one insight (`kind = 'dependency-missing'`). Clicking the CTA on either surface leads to the same resolution path.

### 5.4 Scope bleeds

Never. A tenant member sees only tenant-scoped insights. A platform admin sees only platform-scoped insights on the Admin Console — and their own tenant-scoped insights on the User Console.

### 5.5 Cost privacy

Insights in the User Console may mention tokens ("84% of quota") but never dollars. Admin Console insights may mention dollars.

---

## 6 · Open questions / follow-ups

See `nexus-hub-portal-uiux-open-items.md` for the full tracked backlog. Highlights:

- **Strategy-2 reference usage tracking** requires pipeline instrumentation to record which references each skill invocation pulled.
- **Channel model unification** — channels should be tenant-scoped like the other reference types.
- **Real anomaly detection** — needs baseline modeling.
- **Dismissed-insights persistence** — currently localStorage; promote to a DB table.
- **Intelligence-bus wiring** — once Phase 1 lands, the cross-skill insights become richer (Training ↔ Secretary schedule conflicts, Finance ↔ Cooking budget overrun).
