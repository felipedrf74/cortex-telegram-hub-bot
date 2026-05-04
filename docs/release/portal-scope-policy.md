# Portal Scope Policy — Closed-Beta v4.14.126+

Date: 2026-05-03
Owner: Felipe Dominguez (sole operator)
Source code: `src/portal/server.ts`, `src/api/secret-guards.ts`,
`src/portal/portal.html`

---

## 1. Statement of intent

For the closed-beta release, the **Nexus Hub admin portal at `:8200`
is operator-only**. It is not a per-user web session surface for
beta cohort members.

- iOS users authenticate via JWT against `/api/v1/*` routes.
- Operators authenticate via `PORTAL_TOKEN` (and the future
  `PORTAL_ADMIN_TOKEN` for split read/write scope) against `/api/*`
  routes excluding the `/api/v1/*` prefix.
- There is no user-facing web sign-in, web-based preferences screen,
  or web-based account management for beta cohort members.

Beta users who need preference edits do so through the iOS app. If
the iOS app does not yet expose an edit surface for a particular
preference (e.g. Cooking allergies, Content niches, Finance
preferences — see § 4), the operator edits on the user's behalf
through the portal admin tools, with the user's explicit consent
captured via email or chat.

This policy stays in force until either (a) per-user portal sessions
are designed and shipped (out-of-scope for closed beta) or (b) iOS
catches up on edit surfaces and the portal becomes purely an
operator-side console (the preferred direction).

---

## 2. Auth surface map

| Path prefix | Auth mechanism | Audience | Source |
|---|---|---|---|
| `/api/v1/*` | iOS JWT (`auth-middleware.ts`), `req.tenantId === req.userId` enforced. | Beta users (iOS app). | `src/api/auth-middleware.ts` |
| `/api/*` (not `/api/v1/*`) | `requirePortalTokenByMethod` — `PORTAL_TOKEN` for reads, `PORTAL_ADMIN_TOKEN` for writes when split. | Operators only. | `src/portal/server.ts:281–287`, `src/api/secret-guards.ts` |
| Portal HTML (`/`, `/portal.html`, static assets) | `PORTAL_TOKEN` via the same guard. | Operators only. | `src/portal/server.ts:289` |
| OAuth callbacks (`/oauth/*`) | Provider-controlled state token. Successful callback redirects back to iOS via deep link OR portal. | Beta users (during the OAuth flow only). | `src/portal/oauth-routes.ts` |

The split between `/api/v1/*` (iOS) and `/api/*` (operator) is the
single architectural fact that keeps the closed beta safe. Any new
route on the portal MUST register under `/api/*` (operator) unless
it is explicitly designed as a per-user iOS endpoint, in which case
it goes under `/api/v1/*`.

---

## 3. What operators may do through the portal

- **Per-tenant content writes** via
  `content-admin-write.ts:resolvePortalContentScope`. The endpoint
  reads `userId` / `tenantId` from `req.body`, `req.query`, or
  `x-nexus-*` headers. By design, an operator can write to any
  tenant by supplying the target id. Every write lands an
  `audit_trail` row tagged with the operator + the target tenant.
  The audit trail is the accountability surface; the operator is
  responsible for honoring the user's consent.
- **Skill enable / disable** for a beta user who has reported a
  broken skill and wants it temporarily disabled.
- **Connection disconnection** for a beta user who reported an
  OAuth issue and wants their tokens cleared.
- **Cooking preference seeding** while the iOS edit surface is
  pending (see § 4).
- **Content profile / pillars / niches seeding** while the iOS edit
  surface is pending (see § 4).
- **Finance preferences seeding** while the iOS edit surface is
  pending (see § 4).
- **Smoke / health checks** on snapshot, status portal, intelligence
  bus, scheduler runs.

Operators MUST NOT, through the portal:

- Read another user's chat content unless the user has explicitly
  flagged a conversation for review (chat content is private even to
  the operator).
- Write into another user's content / cooking / finance preferences
  without recorded user consent (email, chat thread, or a flag
  toggled by the user themselves through the iOS app).
- Bypass `PORTAL_ADMIN_TOKEN` for writes once that split is
  configured.

---

## 4. iOS edit-surface gaps (audit-confirmed P1)

The chat-and-skills audit confirmed the iOS app currently has no
edit surface for:

- Cooking preferences (`Nexus Hub/Views/` has no Cooking edit
  screen; `CookingService.swift:191–215` exposes the client method
  but nothing invokes it).
- Content creator-profile / Voice DNA / niches / pillars.
- Finance preferences.
- Chat memory edit / correction.

For the duration of closed beta, the operator covers these gaps
through the portal admin tools above. An iOS work item to add edit
surfaces is tracked in `docs/release/OPEN_ITEMS.md` separately from
this runbook.

---

## 5. Hardening commitments still in force

Every protection from the v4.14.118 admin-portal hardening pass
remains active in v4.14.126+:

- `PORTAL_TOKEN` strength check at boot
  (`validatePortalCredentialStrength`, server.ts:273).
- Beta-readiness preflight that refuses to boot when admin is
  exposed in production without signed sessions or actor signatures
  (`validatePortalAdminBetaReadiness`, server.ts:279).
- Signed operator sessions for write scope when configured.
- `audit_trail` row per portal write with operator + target ids.
- Hardened staging operator-session smoke (valid, expired, tampered,
  unauthorized role/scope, wrong-tenant, static-token rejection
  paths) — last green run referenced in the current release/open-items
  documentation.

---

## 6. When this policy changes

- **Per-user portal sessions land** → re-classify the portal as a
  hybrid (operator + per-user) surface, document the per-user auth
  contract here, retire § 4.
- **iOS adds edit surfaces** → drop the operator-as-proxy bullets
  in § 3, retire the iOS-edit-surface-gaps section (§ 4).
- **Open beta opens** → re-evaluate the entire policy; closed-beta
  one-operator assumptions cease to apply.

Until any of those happen, this is the canonical contract.
