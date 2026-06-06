# iOS chat identity / cache validation

This doc captures the May 2026 P0 security audit's iOS-side findings. The static audit verified the cache-clear and account-switch paths; live device walk-through is required to fully close the iOS claim.

## What was audited

- iOS path: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`
- Subagent run: `iOS identity cache audit` (Phase 6 of the P0 audit)

## Architecture summary

### Identity cache lifecycle

**Login** caches `AuthUser` (id, firstName, lastName, email, language, tenantId, tenantName) in:
- `Keychain` (service `me.nexushub.app`): `nexus_access_token`, `nexus_refresh_token` (`KeychainHelper.swift`)
- `UserDefaults`: `nexus_current_user` JSON (written by `AuthManager.persistCurrentUser` on every `currentUser` `didSet`, `AuthManager.swift:11,464-475`)
- `UserDefaults`: `subscription.snapshot.user.<id>` (entitlement, scoped per-user, `SubscriptionManager.swift:107,334-336`)
- In-memory: `AuthManager.shared.currentUser` singleton
- In-memory: every repository under `AppState`

**Logout** (`AppState.signOut()`, `AppState.swift:503-564`) clears:
- Keychain access + refresh tokens
- Persisted `nexus_current_user`
- Every repo's in-memory state via `handleScopeChange()`
- `SubscriptionManager.reset()`
- `NotificationManager.reset()`
- `DeepLinkRouter.shared.clearRoute()`
- `DebugAuthTokenExporter.purge()`
- `URLCache.shared` via `NexusImageCache.purgeCache()`
- `ContentReferenceLocalStore.resetAll()`
- `profilePreferences.reset()`
- 9 named UserDefaults keys

**Account switch** is effectively logout + login. `RootView` (`Nexus_HubApp.swift:114-145`) gates on `authManager.isAuthenticated && authManager.isOnboardingComplete`. On `false` it swaps in `OnboardingFlowView`, **destroying** `MainTabView` and every `@State` ViewModel underneath, so `ChatRootView`'s `@State didStartInitialLoad` and the `ChatViewModel` itself are torn down. `.task(id: authManager.currentUser?.id ?? -1)` re-fires when the user id changes.

`ChatRepository.ensureCurrentScope()` (`ChatRepository.swift:356-367`) double-checks: it reads `AuthManager.shared.currentUser.chatScopeKey` (`user-<id>.tenant-<id>`) and resets `messages` if the key changes since last load.

### Chat message lifecycle on user change

Logout flow tears down `MainTabView`, so `ChatRootView`'s `@State viewModel: ChatViewModel` instance is destroyed. On login, a fresh `ChatViewModel` is constructed with a fresh `ChatRepository` (`ChatRepository.swift:21-29`). Even if the repository instance survived (it lives on `AppState`, which is itself rebuilt only on app cold-start, NOT on logout), `signOut()` calls `chatRepo.invalidateForScopeChange()` → `reset()` → `messages.removeAll()`, `activeDomain = nil`, `historyLoaded = false`, `loadedScopeKey = nil` (`ChatRepository.swift:323-336`). On the next `loadHistory()` call, `/api/v1/chat/history` is hit fresh with the new user's Bearer token; backend returns the new user's messages only.

`ensureCurrentScope()` is called at the top of `send()`, `appendLocalExchange()`, `appendUserMessage()`, `upsertStreamingChunk()`, `completeStreamingMessage()`, `handleCallback()` — providing belt-and-suspenders defense if the user changes without the formal logout flow firing.

The local-clear-cutoff for `clearHistory` is keyed per `scopeKey` (`ChatRepository.swift:399-401`).

### iOS sends NO identity in chat requests

`ChatService.swift:19-32` posts to `/api/v1/chat/message` with body `{ text, replyToId?, attachments? }` only. No `userId`, `tenantId`, `displayName`, `profileName`. The backend resolves user identity from the JWT in `Authorization: Bearer <jwt>`.

### Felipe / Dominguez occurrences

| Location | Production-reachable? | Notes |
| --- | --- | --- |
| `Nexus Hub/Core/AuthManager.swift:48` | **No** | `currentUser = AuthUser(id: 12345, firstName: "Felipe", lastName: "Dominguez", language: "pt-BR")` — wrapped in `#if DEBUG` (line 28) AND `ProcessInfo.environment["NEXUS_SKIP_AUTH"] == "1"`. Stripped from Release. |
| `Nexus Hub/Core/AuthManager.swift:32` | **No** | Preview-runtime `id: 12345, firstName: "Preview"` — gated by `PreviewRuntime.isRunning` (`XCODE_RUNNING_FOR_PREVIEWS=1`), inside `#if DEBUG`. |
| `Nexus Hub/Models/Message.swift:403,418` | **No** | `mockUser` / `mockAssistant` ChatMessage statics — only used inside `#Preview` blocks. |
| `Nexus Hub/Views/Settings/AboutView.swift:327` | **Yes (cosmetic)** | `Text("2025–2026 Felipe Dominguez")` — copyright credit, not user identity. |
| `Nexus Hub/Core/NexusBrandURL.swift:75` | **Yes (cosmetic)** | `mailto:felipedrf74@gmail.com` support email. |
| `Nexus Hub/Core/NexusConfig.swift:166` | **Yes (cosmetic)** | string check for hostname `serverdominguez` — local-network detection. |
| `Nexus Hub/Views/Content/ContentIntelligenceView.swift:1443,1452` | Verify before close | hardcoded `["@felipe", "@danielbarada"]` — appears as preview/sample data; needs visual confirmation. |
| `Nexus Hub/Core/TrainingLocalSmokeFixtures.swift` | **No** | entire file `#if DEBUG`. |

## What was verified

- `signOut()` clears tokens, persisted user, all 15 repos.
- `RootView` re-mounts `MainTabView` on auth flip.
- `ChatRepository.ensureCurrentScope()` resets messages on scope change.
- `iOS sends only { text, replyToId?, attachments? }` — no client-injected identity.
- All Felipe-named code paths are double-gated `#if DEBUG` + env flag, OR inside `#Preview` blocks.
- `URLCache.shared` purged on logout via `NexusImageCache.purgeCache()`.
- `Resources/en.lproj`, `pt-BR.lproj`, `pt-PT.lproj` contain no Felipe/Jaqueline strings.
- `SubscriptionManager` cached snapshot is keyed per `user.<id>`.
- Keychain tokens cleared on logout.

## What still needs live validation

A signed iOS device walk-through with two distinct accounts (`nexushubbot` and Felipe). See `docs/security/p0-chat-identity-frontend-validation.md` for the runbook.

## Conclusion

**iOS architecture is correct.** No production-reachable identity leak found in the iOS source. The `nexushubbot` "You're Felipe" leak was entirely backend (sources documented in `docs/security/p0-chat-identity-root-cause.md`). The static audit gives high confidence in the iOS cache lifecycle. Live device verification is the only remaining iOS-side condition for closing this P0.
