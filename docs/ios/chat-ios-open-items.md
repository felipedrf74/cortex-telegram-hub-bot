# iOS chat — open items

Filed during the May 2026 P0 chat-identity audit. None of these are P0 (the core chat-identity isolation issue is closed by backend changes; iOS is verified architecturally clean).

## P1 — live device validation

A signed iOS build walk-through with two distinct accounts. Runbook at `docs/security/p0-chat-identity-frontend-validation.md`.

## P2 — `nexus_push_*` `@AppStorage` keys persist across logout

Files: `Nexus Hub/Views/Settings/SettingsView.swift:45-49`, `Nexus Hub/Core/AppState.swift:540-549`.

These are user push-notification preferences. Today they are NOT in the `keysToRemove` list at `signOut()` time. So User B inherits User A's push toggles. This is cosmetic (not identity), but it's worth fixing for consistency — preferences should be partitioned per account.

Suggested fix: add the `nexus_push_*` keys to the `keysToRemove` list, OR rekey them per-user (`nexus_push_<userId>_*`).

## P2 — `ResponseCache.swift` singleton with no scope keys

File: `Nexus Hub/Core/ResponseCache.swift`.

The `actor ResponseCache` is a global singleton with no per-user partitioning. Currently it is dead code (no callers found by grep), but if anyone wires it up later without scoping by user, it would leak responses across accounts.

Suggested fix:
- Option A: delete the file (it's unused).
- Option B: add a `clear()` call to `signOut()` AND require all put/get callers to pass a scope key.

## P2 — `["@felipe", "@danielbarada"]` literals in ContentIntelligenceView

File: `Nexus Hub/Views/Content/ContentIntelligenceView.swift:1443,1452`.

These appear inside what looks like sample/seed UI for a not-yet-fully-wired feature. Need a 30-second visual confirmation that they are NOT displayed to a logged-in non-Felipe user. If they are, sanitize.

## P3 — Refactor doc

The Phase 6 audit catalog shows the iOS scope-clear path is correct but spans many small services (`AppState.signOut`, repo `invalidateForScopeChange`, `RootView` mount toggle, `ChatRepository.ensureCurrentScope`, `KeychainHelper`, `URLCache.shared`, `NexusImageCache.purgeCache`, `ContentReferenceLocalStore.resetAll`, `profilePreferences.reset`, etc.). Consider consolidating into a single `IdentityScopeManager` so future repos auto-register their `invalidate()` callback and there is no risk of forgetting one.

Not blocking; a hygiene improvement.

## P3 — Tab-switch performance regression watching

The May 2026 audit also touched on prior iOS performance work (commits `827511f`, `f9236b1`, `18678a3`). Those are not identity-related, but the May 2 issue list mentions "lag returns after minutes navigating" as Issue 2. That is documented as blocked on physical device profiling (iOS 26.5 / Xcode 26.4.1 device-support mismatch). When unblocked, run an OSSignposter trace on tab-switch latency.

## Closed

- Chat message contamination on user change → verified architecturally closed (Phase 6 audit).
- `MainTabView` re-mount on auth flip → verified.
- `currentUser` JSON purged on signOut → verified.
- Token Keychain cleanup on signOut → verified.
- iOS does not inject `userId` or `displayName` in chat requests → verified.
