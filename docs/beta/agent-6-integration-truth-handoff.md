# Agent 6 — Gap 6: Integration truth for Gmail / Outlook / Health

**Branch**: `beta/gap-6-integration-truth`
**Base**: `beta/rc`
**Status**: ready for review

## Summary

Before this change, the product misrepresented integration state in three ways:

1. `/api/v1/connections` silently hid Garmin tokens in `needs_reauth`, `mfa_pending`,
   or `expired` — only `status = 'active'` appeared as connected. A user whose Garmin
   session had expired saw "not connected" copy, then re-authed, then saw the token
   rejected again seconds later.
2. A user with exactly one provider connected (Gmail only, Outlook only, or Garmin
   only) was treated as "partial" by any feature that implicitly assumed both email
   providers should be present.
3. The training home screen rendered "Today's read is partial — waiting for Garmin
   to sync again" whenever `coachBriefing.degraded` flipped true, even for users who
   had never connected Garmin. The copy named a provider that had never been a data
   source for them.

This gap fixes all three. The core move is a new canonical service module
`src/services/integration-status.ts` that combines every tier of integration
storage (OAuth tokens, Garmin lifecycle column, integration_health probe history)
into a single closed-set state machine. The `/api/v1/connections` endpoint surfaces
the canonical view in a new `integrations[]` field alongside the existing arrays
so iOS clients can migrate at their pace.

## Provider-state contract

The canonical type is `ProviderIntegrationStatus` ([integration-status.ts:78-90](../../src/services/integration-status.ts)).

| State            | Meaning                                                       |
|------------------|---------------------------------------------------------------|
| `not_configured` | OAuth app credentials missing — the user cannot connect.      |
| `disconnected`   | Provider is connectable but the user hasn't linked it.        |
| `pending`        | Connection started but not complete (Garmin MFA waiting).     |
| `connected`      | Tokens present and healthy.                                   |
| `degraded`       | Tokens present but recent health probes fail — stale data OK. |
| `revoked`        | Auth is known-bad; user must reconnect (needs_reauth/expired).|
| `coming_soon`    | Provider exists but is not launched to users (WHOOP today).   |

Each entry also carries a `reasonCode` (closed set: `NOT_CONFIGURED`, `COMING_SOON`,
`NEEDS_REAUTH`, `MFA_PENDING`, `EXPIRED`, `PROBE_FAILING`, `TOKEN_EXPIRED`) and an
optional human-readable `detail`. The caller never has to parse strings to decide
copy — it maps reasonCode → localized message.

Every connectable provider appears exactly once in the summary (`google`, `outlook`,
`garmin`, `strava`, `whoop`, `fitbit`, `todoist`, `notion`). This is invariant:
UI code can safely iterate without checking for missing entries.

The `IntegrationSummary` also exposes four derived capability flags:

- `capabilities.mail`        — true iff any usable provider grants email access
- `capabilities.calendar`    — true iff any usable provider grants calendar access
- `capabilities.externalTasks` — true iff the user has an external task provider
- `capabilities.health`      — true iff any usable wearable/health provider

"Usable" means `connected` or `degraded` (last-known data still renders). `revoked`,
`pending`, `disconnected`, `not_configured`, and `coming_soon` all count as unusable
for capability purposes.

## Changed files

| Path                                              | Change                                                                                              |
|---------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `src/services/integration-status.ts`              | **New.** Canonical integration-state module.                                                        |
| `src/api/routes/connections.ts`                   | Added `integrations[]`, `counts`, `capabilities` to the response; legacy fields unchanged.          |
| `src/api/routes/training-home-payload.ts`         | `isGarminStale` now gated on `isGarminActivelyIntegrated(userId)` so users without Garmin can't be flagged stale. |
| `src/services/training-home-view-state.ts`        | Split the "partial" copy: Garmin-named copy fires only when `isGarminStale`; fallback generic copy for other degradation. |
| `__tests__/services/integration-status.test.ts`   | **New.** 32 tests across every provider combination + lifecycle + probe degradation.                |
| `__tests__/api/connections-routes.test.ts`        | Added 5 tests covering the canonical `integrations[]` + capabilities + Garmin revoked/pending.      |
| `__tests__/services/training-home-view-state.test.ts` | Added 3 tests for the provider-truthful degraded copy (Gap 6 regression pins).                 |

## Tests added

**`__tests__/services/integration-status.test.ts` (32 tests):**

- No provider connected — state: disconnected across the board, capability flags all false
- Gmail only — google:connected with gmail+calendar capabilities, Outlook stays disconnected, does NOT imply Outlook
- Outlook only — outlook:connected with calendar+email+tasks, Google stays disconnected
- Garmin only — garmin:connected, no email providers implied, `health` capability true alone
- Gmail + Garmin — both connected without implying Outlook
- Outlook + Garmin — both connected without implying Gmail
- Garmin `needs_reauth` → state: revoked, reasonCode: NEEDS_REAUTH
- Garmin `expired` → state: revoked, reasonCode: EXPIRED
- Garmin `mfa_pending` → state: pending, reasonCode: MFA_PENDING
- Revoked/pending Garmin does not count as usable health capability
- Probe-derived degradation: 3 consecutive failures flips state to degraded; 2 fails stays connected
- Probe failures isolated per provider (Google degraded does not degrade Outlook)
- Convenience helpers (`isGarminActivelyIntegrated`, `hasUsableMailProvider`, `hasUsableCalendarProvider`, `hasUsableHealthProvider`) agree with summary
- Scope-aware capabilities: Google calendar-only scope does not expose gmail; Outlook without tasks scope does not expose externalTasks
- Summary invariants: exactly one entry per provider; counts reflect distribution

**`__tests__/api/connections-routes.test.ts` (new cases):**

- `integrations[]` array contains exactly one entry per connectable provider
- `capabilities` flags derived correctly from connected providers
- Garmin `needs_reauth` surfaces as state=revoked in `integrations[]` (legacy `connections[]` hides this)
- Garmin `mfa_pending` surfaces as state=pending
- Gmail-only user gets Outlook in `integrations[]` as not_configured (not missing)

**`__tests__/services/training-home-view-state.test.ts` (new cases):**

- Garmin-specific "until Garmin syncs again" copy fires only when `isGarminStale` is true
- Generic "signals recover" copy for degraded briefing on users without Garmin
- cachedOnlyMiss on a user without Garmin never names Garmin

## Tests run

- `npx tsc --noEmit` — clean
- `npx vitest run __tests__/services/integration-status.test.ts` — 32/32
- `npx vitest run __tests__/api/connections-routes.test.ts` — 9/9
- `npx vitest run __tests__/services/training-home-view-state.test.ts` — 30/30
- `npx vitest run __tests__/api/training-home-payload.test.ts` — 3/3
- **Full suite: `npx vitest run` — 5360/5360 passed**

## Tests not run

None. Everything in the default Vitest scope ran green.

An earlier full-suite run showed 7 failures in `__tests__/portal/portal-token-strength.test.ts`
with `Cannot find module '../api/router'`. Re-running that file in isolation — and
re-running the full suite — passed all tests. The failures are pre-existing flakiness
from `vi.doMock` module-cache bleed across test files, unrelated to Gap 6. Flag to
Agent 1: when running the beta smoke suite, re-run if portal-token-strength flakes.

## Remaining risks

**Owner-level probe coupling.** `integration_health` stores a single row per provider
(owner-tier credentials), not per-user. For the Felipe-owned single-tenant beta this
is correct. When multi-tenancy lands (Agent 2), the degraded overlay needs a per-user
scope — today a degraded probe for one user's Google OAuth will mark every user's
Google as degraded. Acceptable for beta.

**iOS adoption.** The new `integrations[]` / `capabilities` / `counts` fields are
additive — the existing `connections[]` / `availability[]` arrays are unchanged, so
no iOS build breaks. iOS can adopt `integrations[]` at its own pace to render Garmin
revoked/pending states correctly. Until then, iOS cannot distinguish "Garmin not
connected" from "Garmin revoked" from the response (the legacy shape still hides it).

**Generic degraded copy needs polish.** The new provider-agnostic fallback ("Today's
plan is still visible, but the briefing is running on limited data while signals
recover.") is functional but terse. Agent 4 owns the generic degraded UI and should
decide whether to replace with richer copy.

**Other isConnected call sites not touched.** `src/services/task-router.ts:35`,
`src/services/training-plans.ts:679-680`, `src/services/fiscal-bundle.ts:238-239`,
and `src/api/routes/notifications.ts:169-170, 464-465` still use raw
`isConnected(userId, 'outlook' | 'google')` checks. They are already provider-agnostic
(they check both), so they are not lying — but they would benefit from migrating to
`hasUsableMailProvider(userId)` / `hasUsableCalendarProvider(userId)` to also handle
revoked/degraded correctly. Out of scope for Gap 6 (behavior is unchanged — tokens
revoked today already silently fail downstream). Flag to future cleanup.

## Notes for Agent 4 (degraded-state UI)

1. The new `integrations[]` contract includes per-provider `state` + `reasonCode` +
   `detail`. Use these instead of rolling your own copy mapping. A provider in
   `degraded` state is still showing last-known data — the banner should be "limited"
   tone, not "unavailable".
2. `src/services/training-home-view-state.ts` now has a two-branch split around the
   Garmin-specific copy (see [line 1271-1300](../../src/services/training-home-view-state.ts)).
   The second branch is provider-agnostic fallback copy that you may want to enrich
   or replace with richer generic degraded copy. The tone is `'limited'` in both
   branches.
3. `meta.isStale` and `meta.reasonCodes` (`COACH_STALE`) fire for any briefing
   degradation, not just Garmin. Use those for the screen-level degraded banner;
   use `state.reasoning.summary` for the per-card copy.
4. `IntegrationSummary.counts.revoked` is the right number to show on a "Reconnect
   needed" banner. Don't sum `state === 'revoked'` yourself — use `counts.revoked`
   from the summary.
5. If you introduce provider-specific degraded copy (e.g. "Outlook is offline"),
   drive it off the `ProviderIntegrationStatus.state === 'degraded'` entries, not
   off the shared `integration_health` table directly. The service module has
   already decoded "owner probe fails → this user sees degraded".

## Notes for Agent 1 (smoke testing)

1. Smoke test matrix for integration truth:
   - **Gmail-only**: connect Google with gmail+calendar scope, no Outlook, no Garmin.
     Expect `/api/v1/connections` → `integrations[0].state === 'connected'` for google,
     `integrations[*].state === 'disconnected'` for outlook, garmin. Capabilities:
     `mail: true, calendar: true, externalTasks: false, health: false`.
   - **Outlook-only**: inverse.
   - **Garmin-only**: health-only user. Capabilities: `health: true`, mail/calendar
     false.
   - **Revoked Garmin**: run while `garmin_user_tokens.status === 'needs_reauth'`.
     Expect `integrations[*].state === 'revoked'` for garmin with reasonCode
     `NEEDS_REAUTH`. **Regression check**: also confirm `iOS app does NOT show
     "today's read is partial" copy for a user without Garmin** — this was the
     visible symptom of Gap 6.
2. Portal flakiness: if `portal-token-strength.test.ts` fails in CI with
   `Cannot find module '../api/router'`, retry — pre-existing test-order issue,
   not a Gap 6 regression.
3. There is no migration in this change. The canonical state is a derived view over
   existing tables.

## Notes for Agent 10 (polish)

1. The `integrations[]` field is the single source of truth for rendering any
   integration badge anywhere in iOS or the portal. Prefer it over ad-hoc
   `isConnected()` checks. If you find a screen that renders a provider badge from
   somewhere else, migrate it.
2. Provider badge copy should be driven by `reasonCode` → localized string mapping
   (e.g. `NEEDS_REAUTH` → "Reconnect Garmin" in EN / "Reconecta Garmin" in PT). The
   iOS app should not parse `detail` — treat it as operator-diagnostic text.
3. When a provider is `pending` (only Garmin today, via MFA), the UI should not
   treat it as connected yet. The product state for MFA is "show a callout asking
   the user to finish signing in by entering the code from email".
4. The `coming_soon` state is distinct from `not_configured`: both block the connect
   button, but the copy should differ (WHOOP = "Coming soon", a missing env var =
   "Not available in this environment").

## Merge command

```sh
git switch beta/rc && git merge --no-ff beta/gap-6-integration-truth
```
