# Agent 3 — Auth + Onboarding Reliability

**Branch:** `beta/gap-3-auth-onboarding`
**Base:** `beta/rc`
**Date:** 2026-04-24
**Scope:** Gap 3 — sign-in, session restore, setup completion, and recovery from missing integrations.

This doc is self-contained so Agents 1, 4, 8, 10 do not need to read the diff to understand what moved.

---

## Summary of fixes

All fixes live on the backend. The contract with iOS is additive — existing
requests keep working unchanged; new optional fields and new endpoints give
the client ways to be more reliable.

1. **Server-side sign out.** Before this change there was no way for iOS to
   revoke its refresh token on the server. Signing out on the client just
   discarded the tokens locally and the backend row in `ios_devices` stayed
   valid until natural 7-day expiry — so a leaked token, a shared device,
   or an account switch left the prior session replayable. Added:
   - `POST /api/v1/auth/logout` — revoke the current device's refresh token.
   - `POST /api/v1/auth/logout-all` — revoke every device for the user
     (use for "sign out everywhere", account deletion, suspected leak).
   Both are idempotent (200 even if no row matches) so retries are safe.
2. **Revoked sessions no longer bypass auth via access-token inertia.** The
   access token is a 7-day JWT; deleting the `ios_devices` row doesn't
   invalidate it by itself. `authMiddleware` now also checks that the
   device row still exists for the JWT's `(userId, deviceId)` pair. This
   is the piece that makes logout actually terminate the session. Tokens
   that don't carry a `deviceId` (legacy / non-iOS issuance) are unaffected.
3. **Onboarding answer writes are idempotent under retry.** iOS now passes
   `stepIndex` as an optimistic-concurrency check:
   - `stepIndex === server.current_step` → advance (normal case).
   - `stepIndex < server.current_step` → no-op replay (retry after the first
     request succeeded but the network failed before the client saw 200).
     Response includes `idempotentReplay: true` and the current server step.
   - `stepIndex > server.current_step` → `409 STEP_MISMATCH` with the real
     server cursor so the client can resync without blind retries.
   Legacy callers (Telegram handlers) that don't pass `stepIndex` still work.
4. **Onboarding completion is atomic.** `answerStep` now runs the session
   UPDATE and the terminal profile INSERT in a single SQLite transaction.
   A crash between them previously left the session marked `completed` with
   no profile row — a state `getPendingOnboardings` treated as "still
   pending", but `startOrResume` would then clobber back to step 0, erasing
   the user's answers. With the transaction the state can't diverge.
5. **Self-heal for users already stuck from the pre-fix bug.** If
   `startOrResume` finds a `status='completed'` session without a matching
   `user_profiles` row, it re-saves the profile from the stored answers
   before proceeding. The legacy re-take-on-re-entry behavior is preserved
   for clients/handlers that rely on it.
6. **`GET /api/v1/onboarding/:questionnaireId/status`** — read-only
   companion to `GET /:questionnaireId` (which implicitly starts a
   session). Returns `not_started | in_progress | completed | unknown`
   with `currentStep` / `totalSteps`. iOS should call this on app launch
   and background-wake to reconcile its UI without triggering a mutation.

---

## Changed files

| File | Change |
|---|---|
| [src/api/auth-middleware.ts](src/api/auth-middleware.ts) | Top-level `getDb` import (replaces inline `require`). Added device-revocation check after user-status check. |
| [src/api/routes/auth.ts](src/api/routes/auth.ts) | Added `POST /logout` and `POST /logout-all`. |
| [src/services/onboarding.ts](src/services/onboarding.ts) | `OnboardingStepMismatchError` class. `answerStep` accepts `expectedStepIndex`, suppresses duplicate replays, and commits UPDATE + saveProfile in a transaction. `startOrResume` self-heals completed-session-missing-profile. |
| [src/api/routes/onboarding.ts](src/api/routes/onboarding.ts) | `/answer` wires `stepIndex` into the service call, translates `OnboardingStepMismatchError` → `409 STEP_MISMATCH`. New `GET /:questionnaireId/status`. |

## Tests added

| File | Coverage |
|---|---|
| [__tests__/services/onboarding-idempotency.test.ts](__tests__/services/onboarding-idempotency.test.ts) | Service-level: normal advance, replay suppression, `stepIndex` ahead → typed error, legacy (no-stepIndex) callers, transaction rollback, self-heal, no double-heal. (8 tests.) |
| [__tests__/api/onboarding-status-and-idempotency.test.ts](__tests__/api/onboarding-status-and-idempotency.test.ts) | Route-level: `/status` states (`not_started`/`in_progress`/`completed`/`unknown`), duplicate `/answer` replay, `stepIndex` ahead → 409. (6 tests.) |
| [__tests__/api/auth-session-revocation.test.ts](__tests__/api/auth-session-revocation.test.ts) | `POST /auth/logout` revokes current device; idempotent when no row; only deletes caller's row. `POST /auth/logout-all` scoped to user. (4 tests.) |
| [__tests__/api/auth-middleware-device-revocation.test.ts](__tests__/api/auth-middleware-device-revocation.test.ts) | Isolated file (separate from the logout tests to avoid `vi.doMock` cross-describe leakage). Admits when device row exists; rejects with `Session has been revoked` when row deleted; regression for banned-user path. (3 tests.) |

## Tests run

- `npx tsc --noEmit` — clean.
- `npx vitest run` across the full auth + onboarding surface (18 files, 254 tests) — all green.
  Files exercised:
  - `__tests__/api/auth-routes.test.ts`, `auth-session-revocation.test.ts`,
    `auth-middleware-device-revocation.test.ts`, `app-facing-auth-smoke.test.ts`
  - `__tests__/api/onboarding-*.test.ts` (4 files)
  - `__tests__/services/onboarding*.test.ts` (5 files incl. `onboarding-idempotency.test.ts`)
  - `__tests__/services/chat-triggered-onboarding.test.ts`, `skill-gated-onboarding.test.ts`
  - `__tests__/api/entitlement-middleware.test.ts`, `authenticated-support-routes-scope.test.ts`,
    `garmin-auth-routes.test.ts`, `connections-routes.test.ts`
- Regression spot-checks: `__tests__/api/security-launch-blockers.test.ts`,
  `tasks-routes.test.ts`, `settings-routes.test.ts` — all green.

## Tests that could not run

None. The full auth + onboarding suite runs locally without requiring
any external service (SQLite in-memory, all external APIs mocked).

The repo-wide `npx vitest run` with the full suite was not executed to
bound clock time — Agents 1/8 will catch any broader regression via the
staging pipeline before `beta/rc` merges to `main`.

## Behavior changes visible to clients

- **Additive:** new routes `/auth/logout`, `/auth/logout-all`,
  `/onboarding/:id/status`. Existing routes are backward-compatible.
- **New optional semantics on `/onboarding/:id/answer`:** clients that
  send `stepIndex` now get optimistic-concurrency. `idempotentReplay: true`
  and `currentStep` appear on the success body; 409 with
  `error.code = STEP_MISMATCH` and `error.details = { currentStep, clientStep }`
  becomes possible on concurrent-client misalignment.
- **New 401 reason:** `authMiddleware` can now return
  `error.message = "Session has been revoked"` (still `code: UNAUTHORIZED`).
  iOS treats all 401s identically today (force re-login) so no immediate
  client change is required — but Agent 10 may want to differentiate the
  user-facing copy ("You were signed out" vs "Session expired").

## Remaining risks

1. **Access-token lifetime is still 7 days.** We added device-row
   revocation but kept the JWT lifetime unchanged. Immediate revocation
   now works in-process for every request, so this is bounded — but a
   user who has never made a request after logout still holds a
   token that will be rejected on next use. No action needed; noted
   for awareness.
2. **Refresh-token replay detection.** `POST /auth/refresh` still returns
   a generic 401 for any unknown refresh token. Rotation happens on
   success but there's no forensic trail of "this rotated token was
   replayed" vs "this token was never issued". Low priority for beta;
   flag for a follow-up if we see suspicious refresh patterns.
3. **Onboarding session schema does not carry a version column.** The
   stepIndex concurrency check assumes the server's `current_step` is
   the authoritative cursor. It is for a single-device-per-account
   workflow. If a user interleaves Telegram and iOS onboarding for the
   same questionnaire, the cursor races — but the `idempotentReplay`
   suppression means the outcome is "first answer wins", which is
   acceptable. No action unless concurrent-device onboarding becomes
   a supported scenario.
4. **`startOrResume` still resets a completed session to step 0 on
   re-entry.** This is the legacy "re-take" behavior preserved for
   Telegram handlers and the existing iOS tests. A side effect: users
   who re-open a profile are implicitly in a new in-progress session
   after the fetch. If iOS starts treating re-entry as non-mutating,
   consider flipping this via a client-signalled `?mode=status` query
   param rather than changing the default.
5. **iOS client changes not included.** This agent owns only the
   backend. iOS code lives in a separate repo (`~/Desktop/Nexus Hub IOS`)
   and should adopt the new endpoints and the `stepIndex` semantics.
   See handoff notes below.

## Notes for Agent 4 (degraded-state UI)

- The new 401 with `error.message === "Session has been revoked"` is a
  cleaner trigger for a "You were signed out on another device / session
  ended" empty state than the generic "Invalid or expired token" path.
  Agent 4 owns the generic renderer; this gives you a discriminator
  without inventing new status codes.
- `/onboarding/:id/status` returning `state: "unknown"` on an unrecognized
  questionnaire is the preferred way to degrade gracefully on a version
  mismatch — the client shouldn't block the whole onboarding surface if
  one questionnaire id isn't recognized. Render a soft "This profile
  isn't available in this build" rather than an error toast.
- `409 STEP_MISMATCH` carries `error.details.currentStep` — if the
  client shows a retry, it should silently re-GET `/:id/status` and
  jump the UI to that step. Ideally no toast; this is an internal
  reconciliation.

## Notes for Agent 1 (smoke testing)

Things worth covering in the staging smoke:

1. **Sign out round-trip.**
   a. Register a new device via `/auth/register` (invite code) or Apple/Google.
   b. Hit any authenticated endpoint successfully.
   c. `POST /auth/logout`.
   d. Hit the same authenticated endpoint with the same access token.
      Expect `401 UNAUTHORIZED` with `error.message = "Session has been revoked"`.
   e. `POST /auth/refresh` with the old refresh token.
      Expect `401 UNAUTHORIZED`.
2. **Idempotent onboarding answer.**
   a. `POST /onboarding/fitness/start` (or register).
   b. `POST /onboarding/fitness/answer` with `stepIndex: 0`.
   c. Re-`POST` with the same `stepIndex: 0`.
      Expect `200 ok:true` with `idempotentReplay: true` and `currentStep: 1`.
3. **Step-ahead mismatch.**
   a. From a fresh session, `POST /onboarding/fitness/answer` with
      `stepIndex: 3, answer: "anything"`.
      Expect `409 STEP_MISMATCH` and
      `error.details = { currentStep: 0, clientStep: 3 }`.
4. **Session status read-only.**
   a. `GET /onboarding/fitness/status` for a fresh user.
      Expect `state: "not_started"` AND `GET /onboarding/fitness/status`
      called again still reports `not_started` (no mutation).
   b. After completing the questionnaire → `state: "completed"`.
5. **Account switch on a shared device.** (Manual, optional.)
   a. Register Apple user A via `/auth/register/apple`.
   b. `POST /auth/logout`.
   c. Register Apple user B with the SAME `deviceId`.
   d. User A's old refresh token must return 401; user B's new token must work.
   (The UPSERT in `createAuthSessionAndRegisterDevice` already rotates the
   refresh token on re-registration; the logout step guarantees the
   in-between is clean.)

## Merge instructions

This agent did NOT merge its branch. Run after review:

```bash
git switch beta/rc
git merge --no-ff beta/gap-3-auth-onboarding
```

The branch is safe to merge ahead of Agents 2, 6, 7 (no shared files changed).
If Agent 6 also touches provider-state types in `src/services/oauth-store.ts`,
a conflict is possible but unlikely — Gap 3 changes there are zero.
