# User data isolation implementation plan

## Goal

Close the class of bugs where one authenticated Nexus user can receive another
user's identity, memory, prompt context, cached iOS state, or operational data.
Treat every identity mismatch as a P0 release blocker.

## Codex-optimized execution order

1. **Freeze trust at the backend boundary.**
   - Derive `userId` and `tenantId` only from the verified access token and
     server-side membership state.
   - Reject malformed JWT subject values before route handlers run.
   - Fail closed on forged active-tenant headers.

2. **Make prompt identity deterministic.**
   - Answer identity questions from the authenticated session before the model
     pipeline.
   - Remove founder/default identity from production prompts, creator fallback
     profiles, persisted payload writers, and system context.
   - Add prompt-cleanliness tests that fail on reintroduced founder identity.

3. **Scope every cache and persisted read.**
   - Cache keys must include environment, tenant, user, skill/surface, and
     schema/version where relevant.
   - Chat command and conversation history keys must include tenant + user.
   - Shared context/memory reads must be active-tenant and authenticated-user
     scoped.

4. **Harden iOS against stale account state.**
   - Clear all repositories on sign-out and on any authenticated user/tenant
     scope transition.
   - Key chat/local content stores by `userId + tenantId`.
   - Purge deep-link and image-cache residue during scope changes.
   - Run two-account device smoke before TestFlight promotion.

5. **Prove the boundary with tests.**
   - Backend: malformed JWT, forged tenant header, identity fast-path, prompt
     cleanliness, per-user content/history/context tests.
   - iOS: repository scope-change source pin, chat scope tests, local content
     scoped-store tests, and manual signed-device account-switch smoke.

## Implementation in this follow-up

- Added a backend JWT payload guard so non-integer/string/object `userId`
  payloads are rejected before route code can see `req.userId`.
- Added regression coverage for malformed JWT `userId` values.
- Added iOS authenticated-scope reconciliation keyed by `AuthUser.chatScopeKey`
  so account/tenant transitions invalidate repositories before Home/Chat/Tasks
  warmups run.
- Added an iOS source-pin test to preserve the scope reconciliation path.

## Remaining production gate

Run the signed-device two-account walk-through from
`docs/security/p0-chat-identity-frontend-validation.md` before TestFlight or
production promotion. The backend and iOS code paths now fail closed, but the
release gate is only complete after real account-switch validation.
