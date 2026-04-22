# Nexus Hub — Owner / Workspace Usability Review

**Branch:** `hardening/nexus-hub-owner-workspace-validation`
**Date:** 2026-04-22
**Scope:** human-facing HTML demos (`src/portal/owner-ui.html`, `src/portal/workspace-ui.html`) plus the API ergonomics they depend on.
**Method:** walked each flow end-to-end as the intended persona, noted friction, classified by severity.

Personas:
- **Owner (Felipe)** on the `/owner/*` console.
- **Tenant admin (Alice)** on the `/workspace/*` demo UI, managing her team.
- **Tenant member (Bob)** on the same UI, using team-shared resources.
- **Invitee (Carol)** accepting an invite email link.

---

## 1 · Flow-by-flow findings

### 1.1 Owner · "who's on my platform?"

**Route:** `GET /owner/tenants` → table in `owner-ui.html`.

| Step | Observation | Severity |
|------|-------------|----------|
| Log in | Need to open URL, paste 16+ char token, paste admin user id. No remember/session. | Medium — UI friction for repeat visits (OI-SEC-001 would fix both ergonomically and securely) |
| See tenants | Renders plan / member_count / created_at. | OK |
| Click a tenant | No drill-in — just a row. Tenant detail view is not wired up in the MVP demo. | Medium — functional gap for the owner UX |
| Leave the page | No logout button; token stays in local JS memory. | Low — demo-only context |

### 1.2 Owner · "grant a platform role to a new hire"

**Route:** `POST /owner/platform-admins` → small form in `owner-ui.html`.

| Step | Observation | Severity |
|------|-------------|----------|
| Enter `userId` and `role` | Drop-down for role is good; user id is a raw integer input | Low — would be nicer as a searchable typeahead |
| Submit with suspended user | **Before fix:** 201 (silently accepted — confusing!). **After fix:** 400 `USER_NOT_ACTIVE` with `{status: "suspended"}` in details. UI shows the detail — actionable. | ✅ Fix #3 improved this directly |
| Submit with wrong user id | 404 `USER_NOT_FOUND` — clear | OK |
| Submit with own id | Works (grants self); no guard. Probably fine for the `platform_owner` promoting someone else | OK |

### 1.3 Owner · "see who spent what this month"

**Route:** `GET /owner/usage` → table in `owner-ui.html`.

| Step | Observation | Severity |
|------|-------------|----------|
| Open usage view | Shows tokens + `costUsd` per user | OK — matches intent |
| Per-tenant roll-up | No — usage is per-user across all tenants | Medium (OI-COR-001 has the tenant-plane counterpart) |

### 1.4 Tenant admin (Alice) · "invite Bob to my workspace"

**Route:** `POST /workspace/invites` → form in `workspace-ui.html`.

| Step | Observation | Severity |
|------|-------------|----------|
| Open workspace UI | Auto-uses JWT from localStorage; uses solo-tenant if no `X-Tenant-Id` | OK |
| Fill invite form | Email + role dropdown. Role labels are raw enum (`tenant_admin`) not "Admin". Tiny polish gap. | Low (OI-UX-003 tracks a similar issue on book status) |
| Submit | 201 returns invite_code in the table | OK |
| Share the invite | No "copy link" button — admin has to hand-copy the code from a narrow column | **High (OI-UX-001)** — this is the invite flow's biggest friction point |
| See expiry countdown | None — just a timestamp | Medium (OI-UX-002) |

### 1.5 Tenant admin · "remove Bob from the workspace"

**Route:** `DELETE /workspace/members/:userId`.

| Step | Observation | Severity |
|------|-------------|----------|
| Click "Remove" next to Bob | Confirm dialog: "Remove this member?" — yes/no. Good. | OK |
| Last admin self-removes | Server 400 `LAST_ADMIN` — UI shows the message. Fine. | OK |
| **After fix:** audit row is written | Invisible from the UI but present in `audit_trail`; owner can see it on the owner audit page. | ✅ Fix #2 |

### 1.6 Tenant member (Bob) · "what resources do we have?"

**Routes:** `GET /workspace/books`, `/content`, `/links` — three sections in `workspace-ui.html`.

| Step | Observation | Severity |
|------|-------------|----------|
| Open books tab | List of books with author, title, status badge | OK |
| See status badges | **Before fix:** all four states rendered identically (same grey pill). **After fix:** distinct colors — want_to_read blue, reading amber, finished green, abandoned grey. Scannable at a glance. | ✅ Fix #5 |
| Click "Add book" | Form opens; dropdown status values are raw `want_to_read` / etc. | Low (OI-UX-003) |
| Edit a book I didn't author, as tenant_member | 403 `FORBIDDEN` — the row shows but the edit button isn't hidden (frontend relies on the server to reject; appropriate). UX could pre-disable the button for clarity, but it's not a security risk. | Low |

### 1.7 Invitee (Carol) · "I got an invite email"

**Route:** `POST /workspace/my-invites/:code/accept`.

| Step | Observation | Severity |
|------|-------------|----------|
| Email contains a raw code | Today Alice hand-copies and emails the raw `invite_code`. No deep link. | **High (OI-UX-001)** — the bottleneck for invite adoption |
| Carol logs into the iOS app | iOS doesn't yet have an invite acceptance screen in this branch | (out of scope for this hardening pass) |
| Carol hits `my-invites`, finds her pending invites | Returns invites keyed on her email — good | OK |
| Accept | 200 + she's now in Alice's tenant | OK |
| Audit row written | ✅ with Carol as actor | ✅ Fix #2 |

### 1.8 Frontend / backend coherence

**Method.** Walked each mutation in the workspace UI and confirmed: (a) the server is the final authority (no button relies solely on CSS hiding for security), (b) error codes from the server map to user-readable messages in JS.

| Check | Result |
|-------|--------|
| UI hides "Remove" button for non-admins | Yes — but server also rejects regardless (defense-in-depth) |
| UI hides "Edit" / "Delete" for non-authors (for tenant_member) | Partial — button always shown; server rejects with 403 | Acceptable for now |
| UI shows error body text on failure | Yes — `data.error.message` surfaced in the form toast |
| UI distinguishes 400 (validation) from 500 (server) | Yes — error color coded |
| UI caches stale data after mutation | No global cache — each form POST triggers a fresh fetch |

---

## 2 · Severity summary

- **HIGH:** 1 finding (OI-UX-001 — copy invite link)
- **MEDIUM:** 4 findings (owner session / remember-login, tenant detail drill-in, per-tenant usage roll-up, invite expiry countdown)
- **LOW:** 3 findings (role / status dropdown labels, admin self-promotion check, edit button always visible)

All HIGH / MEDIUM findings are tracked in `nexus-hub-owner-workspace-open-items.md` with OI-UX- IDs.

---

## 3 · What the hardening pass improved (from a UX lens)

| Fix | UX impact |
|-----|-----------|
| #1 Rate-limit on `/owner/*` | Owner UI feels identical under normal use; under attack owner sees a clear 429 with `Retry-After`. |
| #2 Audit logging on workspace mutations | Owner's forensic trail is now complete — "who removed Bob?" has an answer. |
| #3 `USER_NOT_ACTIVE` on grant | Owner sees a clear 400 with `status: "suspended"` in details. Before, a silently-granted role on a suspended user surfaced as a confusing "why can't Bob log in?" later. |
| #4 TZ-safe invite expiry | Invitees in non-UTC regions no longer see "invite expired" errors on invites that should still be valid, nor the reverse. |
| #5 Book status badges | Scannable book tab; "what am I reading right now" is a 1-second visual lookup. |

---

## 4 · Recommendations — next UX pass

Ranked by user-value / effort ratio:

1. **OI-UX-001** — one-click copy invite link (solves the single biggest invite-flow bottleneck, ~30 min of work).
2. **OI-UX-002** — invite expiry countdown (a small Intl.RelativeTimeFormat hook; ~1 h).
3. **OI-UX-003** — humanize status / role labels in dropdowns (label map, ~15 min each).
4. Pre-disable edit/delete buttons on rows the caller can't mutate (not a security gain but removes 403-surprises).
5. Owner "tenant detail" drill-in view — surfaces tenant members, invites, books in one screen.

None of these are security / correctness blockers. They are the follow-on polish pass after this hardening branch lands.
