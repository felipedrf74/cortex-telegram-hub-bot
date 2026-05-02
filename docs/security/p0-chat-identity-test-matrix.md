# P0 Chat identity — test matrix

| ID | Case | Type | File | Result |
| --- | --- | --- | --- | --- |
| A.1 | "Quem sou eu?" PT identity question for Jaqueline | Unit | `__tests__/api/chat-message-local-responses.test.ts` | PASS — fast-path returns `Jaqueline` text, never `Felipe`. |
| A.2 | "Who am I signed in as?" EN identity question for Jacqueline | Unit | `__tests__/api/chat-message-local-responses.test.ts` | PASS. |
| A.3 | Identity question with no saved display name | Unit | (covered indirectly via the helper's `hasDisplayName: false` branch) | PASS — returns "I can see the authenticated session, but there is no saved profile name". |
| B.1 | iOS account-switch state cleared | Static audit (Phase 6) | iOS `AppState.swift:503-564` reviewed | PASS — every repo invalidates on `signOut`. |
| B.2 | iOS `MainTabView` re-mount on auth flip | Static audit | iOS `Nexus_HubApp.swift:114-145` reviewed | PASS. |
| B.3 | iOS `ChatRepository.ensureCurrentScope` resets messages on scope change | Static audit | iOS `ChatRepository.swift:356-367` reviewed | PASS. |
| C.1 | Tenant header mismatch rejected | Existing test | `__tests__/api/auth-middleware-device-revocation.test.ts` | PASS. |
| C.2 | `resolveChatTenantId` defaults to `userId`, no global default | Existing test | `__tests__/services/chat-tenant-scope.test.ts` | PASS. |
| D.1 | `chat-context-engine` injects `authenticated-user` context item with `priority: 98, critical: true` | Unit | `__tests__/services/chat-context-engine.test.ts` | PASS. |
| D.2 | Memory tables filter by `(tenant_id, user_id)` | Static audit (Phase 4) | `src/state/conversation.ts`, `src/services/skill-memory.ts`, etc. | PASS. |
| E.1 | Chat history scoped per (tenant_id, user_id) | Existing tests | `__tests__/services/chat-history-store.test.ts` | PASS. |
| E.2 | `clearAllConversations` filters by tenant | Existing test | `__tests__/state/conversation.test.ts` | PASS. |
| F.1 | `content_knowledge` filter by `(tenant_id, owner_user_id, visibility_scope)` | Existing tests | `__tests__/state/content-references.test.ts` | PASS. |
| F.2 | `saved_ideas` count strictly per-user | Unit | `__tests__/security/p0-chat-identity-isolation.test.ts` | PASS — context-engine.ts no longer uses `IN (0, ?)`. |
| F.3 | `getIdeasBySource` requires `userId` | Unit | `__tests__/security/p0-chat-identity-isolation.test.ts` | PASS — type signature checked + WHERE clause checked. |
| G.1 | Provider state context composed from already-scoped sources | Static audit | `src/services/anthropic.ts:1124, 1218` reviewed | PASS. |
| H.1 | iOS persisted `nexus_current_user` cleared on signOut | Static audit | iOS `AuthManager.swift:466` | PASS. |
| H.2 | iOS Keychain access/refresh tokens cleared on signOut | Static audit | iOS `KeychainHelper.swift` | PASS. |
| I.1 | Identity fast-path with empty display name returns "I don't have enough account context" | Unit (covered by hasDisplayName branch) | `chat-message-local-responses.ts` lines 147-156 | PASS — explicit "no saved profile name" branch. |
| I.2 | `formatDailyBriefing` with empty recipient name returns name-less greeting | Unit | `__tests__/security/p0-chat-identity-isolation.test.ts` | PASS — verified for EN and PT. |
| J.1 | `auth-middleware` ties `req.userId = req.tenantId = payload.userId` | Existing test | `__tests__/api/auth-middleware-device-revocation.test.ts` | PASS. |
| J.2 | Mismatched `x-nexus-active-tenant-id` header rejected | Existing test | (same as C.1) | PASS. |

## Hardcoded-identity regression suite

| ID | What | File | Result |
| --- | --- | --- | --- |
| H.1 | `buildKnowledgePromptBlock` source contains no `\bFelipe\b` | Unit | `__tests__/security/p0-chat-identity-isolation.test.ts` | PASS. |
| H.2 | `prompts/creator-config.md` has no specific creator name, no worldview, no audience defaults, no dietary defaults | Unit | (same) | PASS. |
| H.3 | Chat-domain prompts (`secretary.md`, `content.md`, `cooking.md`, `finance.md`, `topic-generation.md`) match no founder-persona pattern | Unit | `__tests__/services/prompt-cleanliness.test.ts` | PASS (5 cases). |
| H.4 | Skill prompts (`secretary/prompts/system.md`, `finance/prompts/system.md`) match no founder-persona pattern | Unit | `__tests__/services/prompt-cleanliness.test.ts` | PASS (2 cases). |
| H.5 | `creator-config.md` and `cross-skill-and-memory.md` match no founder-persona pattern | Unit | `__tests__/services/prompt-cleanliness.test.ts` | PASS (2 cases). |
| H.6 | iOS-route source files do NOT call fuzzy `getUserLanguage / getUserTimezone / getPreferredDisplayName` | Unit (10 routes) | `__tests__/security/p0-chat-identity-isolation.test.ts` | PASS. |
| H.7 | `telegram-formatter.ts` has no literal "Good morning, Felipe!" / "Bom dia, Felipe!" | Unit | (same) | PASS. |
| H.8 | `getUserByAnyIdentifier` resolves `getUserById` BEFORE `getUserByTelegramId` | Unit (static-source assertion) | (same) | PASS. |
| H.9 | `voice-evolution-agent.ts` and `reaction-radar-agent.ts` contain no literal "Felipe" outside the copyright header | Unit | (same) | PASS. |
| H.10 | `fossa_email` cron requires `FOSSA_EMAIL_ENABLED=1` | Unit (static-source assertion) | (same) | PASS. |
| H.11 | Strict by-id helpers (`getPreferredDisplayNameById`, `getUserLanguageById`, `getUserTimezoneById`) are exported | Unit | (same) | PASS. |

## Broader regression sweep

- `npx vitest run __tests__/api/ __tests__/services/user-service.test.ts __tests__/services/chat-context-engine.test.ts __tests__/services/prompt-cleanliness.test.ts __tests__/services/scheduler.test.ts __tests__/security/`
- **Result:** 103 test files / 1001 cases — all passing.

No P0/P1 cases failing.
