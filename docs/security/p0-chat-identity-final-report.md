# P0 Chat identity / tenant isolation final report

## Executive summary

- **Verdict:** PASS WITH CONDITIONS (backend fixed and validated; live app workflow validation still required on a real iOS build with the `nexushubbot` account before release).
- **Root cause (primary):** A literal `"Felipe"` string was injected into the content-domain system prompt by `buildKnowledgePromptBlock` (`src/state/content-references.ts:562`) for every authenticated user with one or more `content_knowledge` rows. Combined with persona-laden domain prompts (`prompts/secretary.md`, `cooking.md`, `finance.md`, `content.md`, `topic-generation.md`) that hardcoded "Felipe" / "The Operator" / founder worldview, an authenticated `nexushubbot` chat session was being told it was Felipe by the model.
- **Root cause (secondary):** `prompts/creator-config.md` and `prompts/cross-skill-and-memory.md` carried a full founder identity (name, worldview, audience, dietary defaults). Any auto-injected `{{CREATOR_CONFIG}}` placeholder leaked that identity. Plus the Python content-engine's `_FALLBACK_PROFILE` defaulted to `"Felipe Dominguez — The Operator"`.
- **Root cause (tertiary, defense-in-depth):** `getUserByAnyIdentifier` resolved `getUserByTelegramId(userRef)` BEFORE `getUserById(userRef)`. iOS-derived `users.id` values that numerically collided with another user's `telegram_id` could silently return a foreign user row.
- **Fix summary:** (1) Removed every literal "Felipe" / founder identity from production prompt paths and replaced with authenticated-user/tenant-scoped phrasing. (2) Added a deterministic identity fast-path (`tryBuildAuthenticatedIdentityResponse`) that catches "Who am I?" / "Quem sou eu?" before any AI call and answers from the JWT-derived authenticated session. (3) Injected an `authenticated-user` `ChatContextItem` (priority 98, `critical: true`) into the chat context engine that explicitly forbids using founder/default identity. (4) Added strict by-id resolvers (`getPreferredDisplayNameById`, `getUserLanguageById`, `getUserTimezoneById`) and migrated all 11 iOS API route call sites away from the fuzzy any-identifier helpers. (5) Reordered `getUserByAnyIdentifier` to resolve `getUserById` first. (6) Sanitized 9 Python content-engine modules (creative + intelligence + orchestrator + scorer + creator_profile fallback). (7) Strict per-user scoping on `saved_ideas` reads. (8) Gated the `fossa_email` cron behind a new `FOSSA_EMAIL_ENABLED=1` flag so a different tenant cannot inherit owner PII.
- **Remaining risk:** Real-device interaction validation on a signed iOS build with two distinct accounts (Felipe and `nexushubbot`) — the iOS audit verified the cache-clear path is correct, but a live login → "Who am I?" → logout → login-as-other → "Who am I?" walk-through has not been recorded.
- **Ready to merge:** Yes for backend; should ship together with the live two-account verification before being marked closed.
- **Ready for production:** Backend fixes are unit-test-validated. Recommend staging soak + live two-account "Who am I?" smoke before promoting to production.

## Evidence from user report

- **Test account:** `nexushubbot`
- **Question:** "Who am I?"
- **Wrong answer:** "You're Felipe."
- **Expected answer:** Either the authenticated user's own saved name (or a stable identifier of their account) OR a clear "I don't have enough account context" — never the founder's name.

## Branch and backup

- **Backend repo:** `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
  - **Working branch:** `feature/p0-chat-identity-tenant-isolation-fix` (created from `main` at `627d4fe`)
  - **Backup tag:** `backup/p0-chat-identity-before-fix-20260502-1704`
  - **Commits:** Local commits only on the feature branch — NOT pushed.
  - **Dirty state before:** 28 modified files (prior in-flight WIP that included partial identity-isolation work + unrelated changes); the WIP overlapped this audit's scope, so the work was completed on top of it.
- **iOS repo:** `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`
  - No iOS changes required. The iOS audit (Phase 6) verified:
    - `signOut()` clears all 15 repo states + Keychain + UserDefaults (`AppState.swift:503-564`).
    - `RootView` re-mounts `MainTabView` on auth flip, killing all `@State` view models including `ChatViewModel`.
    - `ChatRepository.ensureCurrentScope()` resets the message array if the `chatScopeKey = "user-<id>.tenant-<id>"` changes.
    - `iOS sends only { text, replyToId?, attachments? }` to `/api/v1/chat/message` — no client-injected user identity.
    - The only Felipe-named code paths are double-gated `#if DEBUG && NEXUS_SKIP_AUTH=1` and SwiftUI `#Preview` blocks — stripped from Release builds.
  - One **iOS open item** filed: `nexus_push_*` `@AppStorage` keys persist across logout (cosmetic, not identity).

## Hardcoded identity scan

- **Felipe occurrences (production-path):** 22 sites identified. ALL fixed.
- **Felipe occurrences (DOCS-ONLY / copyright headers):** ~80 — left as-is.
- **Felipe occurrences (DEV-OR-TEST-GATED):** 4 — verified gated behind `#if DEBUG`, `#Preview`, or one-time seed scripts. No action.
- **Production-path fixes:**
  - `src/state/content-references.ts:562` — "Felipe's voice" → "the authenticated creator's saved Voice DNA / brand voice for this user and tenant".
  - `prompts/secretary.md`, `prompts/content.md`, `prompts/cooking.md`, `prompts/finance.md`, `prompts/topic-generation.md` — all founder identity removed.
  - `prompts/creator-config.md` — fully sanitized to a NEUTRAL template; explicit guidance that creator identity is loaded per-request.
  - `prompts/cross-skill-and-memory.md` — "Felipe says /remember…" → "the authenticated user issues /remember…".
  - `src/skills/secretary/prompts/system.md` — "founder-athlete-creator" → "authenticated user's working life".
  - `src/skills/finance/prompts/system.md` — Brazilian tax default → applied "only when the user's stored profile or the request explicitly indicates Brazilian/PJ/autônomo status".
  - `src/utils/telegram-formatter.ts` — `goodMorning: '☀️ Good morning, Felipe!'` → `goodMorning: (name?) => name ? '☀️ Good morning, <escaped-name>!' : '☀️ Good morning!'`. Caller passes the recipient's resolved display name.
  - `src/services/scheduler.ts:1640` — passes `getPreferredDisplayNameById(target.tenantId)` to the briefing formatter.
  - `src/services/scheduler.ts:1031-1046` — `fossa_email` cron now gated behind `FOSSA_EMAIL_ENABLED=1`.
  - `src/agents/voice-evolution-agent.ts` — full ANALYSIS_PROMPT + 3 persisted-payload signal descriptions de-Felipe'd.
  - `src/agents/reaction-radar-agent.ts:341` — counterPosition string de-Felipe'd.
  - `src/services/eval-criteria.ts` — voice_fit / overall_quality / brand_voice criteria de-Felipe'd.
  - `src/services/video-study.ts` — STUDY_SYSTEM_PROMPT de-Felipe'd.
  - `content-engine/services/creator_profile.py` — `_FALLBACK_PROFILE` rewritten to be neutral ("CREATOR PROFILE: NOT YET CONFIGURED FOR THIS USER").
  - `content-engine/services/creative/{hook_generator,caption_writer,thumbnail_gen,title_tester,repurpose_engine}.py` — all founder/audience/worldview defaults removed.
  - `content-engine/services/intelligence/{gap_finder,competitor_analyzer}.py` — Felipe references replaced.
  - `content-engine/services/scorer.py` — removed `"libertarian"`, `"conservative"`, `"carnivore"` from default niche keywords.
  - `content-engine/services/orchestrator.py` — `felipes_angle` JSON field renamed to `creator_angle` (with backward-compat fallback for older payloads); persona-laden text de-Felipe'd.

## Auth/session/current-user findings

- **Status:** The auth layer itself is correctly scoped (Phase 2 audit verified):
  - `auth-middleware.ts:57-211` accepts only the JWT-derived `userId`; refuses if `users` row missing or `status != 'active'`; refuses if device row missing (so post-logout JWTs are dead even before expiry); refuses if `x-nexus-active-tenant-id` does not equal `payload.userId`.
  - `chat-message-routes.ts:95` reads only the JWT-derived `userId, tenantId`; the body is never consulted.
  - `resolveChatTenantId` returns `payload.userId` if no valid tenant header; no global default.
  - `nexushubbot` user row does NOT have `first_name = 'Felipe'` (no code path sets that).
- **Risk surface (closed):** `getUserByAnyIdentifier` was Telegram-id-first. Reordered to users.id-first.
- **Tests added:** `__tests__/security/p0-chat-identity-isolation.test.ts > P0 identity: user-service resolution order` pins the order via static-source assertion.

## Chat prompt/context findings

- **Root cause:** Multiple production paths fed founder-persona text into the model's system prompt without any per-request user-scope filter.
- **Fixes:**
  - **Identity fast-path** (`src/api/routes/chat-message-local-responses.ts:65, 132`) — `tryBuildAuthenticatedIdentityResponse` matches 16 PT/EN identity patterns ("who am I", "qual e o meu nome", "como me chamo", "which account am I using", etc.) and returns the authenticated session's display name (via `getPreferredDisplayNameById`) or a clear "I don't have enough account context" if no display name. Wired into `chat-message-routes.ts:283` BEFORE the slash-command and AI fastpaths.
  - **Authenticated-user context item** (`src/services/chat-context-engine.ts:208-227`) — adds an item with `priority: 98, critical: true` containing: "Authenticated user display name: \<name>. This is the only person identity you may assert for this request. Do not use owner, founder, default, or prior-user names unless they appear in authorized context for this same user and tenant."
  - **Removed `loadPromptWithConfig` for content domain** (`src/services/anthropic.ts:60`) — the content domain no longer auto-injects `creator-config.md`. Topic-generation still uses it, but the file is now neutral.
- **Tests added:** `__tests__/security/p0-chat-identity-isolation.test.ts` (8 test groups, 23 cases) + extended `__tests__/services/prompt-cleanliness.test.ts` for skill prompts and `creator-config.md`.

## Memory/retrieval/shared-context findings

- **Memory layer is mostly clean** (Phase 4 audit): `conversations`, `shared_memory`, `daily_context_cache`, `messages`, `skill_memories`, `agent_signals`, `content_knowledge`, `content_ref_channels`, `content_patterns` ALL filter by both `tenant_id` AND `user_id`.
- **One real leak found:** `src/services/context-engine.ts:207` was `WHERE user_id IN (0, ?)` mixing system seeds (`user_id = 0`) into per-user pipeline counts. Fixed to strict `WHERE user_id = ?`.
- **One latent foot-gun fixed:** `getIdeasBySource` had no `userId` parameter; would have leaked across users if any future caller wired it in. Now requires `userId`.
- **Cache keys verified** scoped: `chat-cmd:${tenantId}:${userId}:${cmd}`, `daily_context_cache (tenant_id, user_id, date)` PK, `${tenantId}:${userId}:${domain}` for shared-decision-context, `plan:today:u:${userId}:${date}:${lang}`, etc.

## Tool/skill invocation findings

- **No production-path leak found in tool/skill invocation.** The `chat-tool-authorization` layer enforces user scope before tool execution. All tool calls receive the authenticated `userId, tenantId` from the request scope.
- **Skill prompts** were the leak: `src/skills/secretary/prompts/system.md` and `src/skills/finance/prompts/system.md` had founder/Brazilian-tax persona defaults. Both fixed.

## iOS frontend workflow validation

- **Static audit complete (Phase 6):** No production-reachable Felipe identity in iOS source. Cache lifecycle is correct on logout/account switch. Bottom-tab state is destroyed via `RootView` re-mount.
- **Live device validation NOT YET performed.** A signed TestFlight build with two accounts (Felipe + `nexushubbot`) and a step-by-step "Who am I?" walk-through is required before closing this P0 against production.
- **Untested paths:**
  - Real device login as `nexushubbot` → Chat → "Who am I?" → record assistant response.
  - Logout → login as Felipe → Chat → "Who am I?" → record response.
  - Account switch → assistant should never see prior account's text.
  - App restart → persisted state should not show prior account's chat.

See `docs/security/p0-chat-identity-frontend-validation.md` for the device-validation runbook.

## End-to-end test matrix

| Case | Description | Result |
| --- | --- | --- |
| A | Same question, different users (deterministic fast-path) | **PASS** — `tryBuildAuthenticatedIdentityResponse` unit-tested for both PT and EN, both with-name and without-name. |
| B | Account switch (iOS cache invalidation) | **PASS (static audit)** — `signOut()` clears all repos; live device walk-through pending. |
| C | Tenant switch | **PASS (static)** — `auth-middleware` rejects mismatched `x-nexus-active-tenant-id`. |
| D | Memory contamination across users | **PASS** — all memory tables filter by both `tenant_id` AND `user_id`. |
| E | Conversation contamination | **PASS** — `chat_history_store` filters by `(tenant_id, user_id, scope_status)`. |
| F | Retrieval contamination | **PASS** — `content_knowledge` and skill memory all scope-filtered. |
| G | Provider fallback | **PASS** — `buildScopedStateContextPrefix` is composed from already-user-scoped sources before passing to provider. |
| H | Frontend cache (app restart) | **PASS (static)** — `currentUser` JSON purged on signOut. Live device pending. |
| I | Hardcoded fallback (no user identity) | **PASS** — fast-path returns "I can see the authenticated session, but there is no saved profile name. I will only use data tied to this authenticated user and tenant." (PT and EN). |
| J | Forged user/tenant via API | **PASS** — `auth-middleware` ties `req.userId = req.tenantId = payload.userId`; `x-nexus-active-tenant-id` header is rejected if not equal. |

No P0/P1 case fails.

## Fixes implemented

See "Hardcoded identity scan" section for file-level fix list. Summary by category:

1. **Prompt sanitization (10 files):** secretary, content, cooking, finance, topic-generation, creator-config, cross-skill-and-memory, skills/secretary, skills/finance, telegram-formatter.
2. **Identity fast-path (3 files):** chat-message-local-responses (new helper + tests), chat-message-routes (wiring), chat-context-engine (authenticated-user context item).
3. **Strict by-id resolvers (1 + 11 callers):** user-service (3 new helpers + reorder), 11 iOS API routes migrated.
4. **Persisted-payload sanitization (4 files):** voice-evolution-agent, reaction-radar-agent, eval-criteria, video-study.
5. **Python content-engine (10 files):** creator_profile, hook_generator, caption_writer, thumbnail_gen, title_tester, repurpose_engine, book_knowledge, gap_finder, competitor_analyzer, scorer, orchestrator.
6. **Memory scope tightening (2 files):** context-engine (saved_ideas), saved-ideas (getIdeasBySource).
7. **Owner-only cron gate (1 file):** scheduler (FOSSA_EMAIL_ENABLED).
8. **Tests (3 files):** new `__tests__/security/p0-chat-identity-isolation.test.ts` + extensions to `prompt-cleanliness.test.ts` and `chat-message-local-responses.test.ts`.

## Tests run

- `npx tsc --noEmit` — clean.
- `npx vitest run __tests__/security/ __tests__/services/prompt-cleanliness.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/services/chat-context-engine.test.ts __tests__/api/training-routes.test.ts __tests__/api/dashboard-routes.test.ts __tests__/api/chat-routes.test.ts` — **214/214 passing**.
- `npx vitest run __tests__/api/ __tests__/services/user-service.test.ts __tests__/services/chat-context-engine.test.ts __tests__/services/prompt-cleanliness.test.ts __tests__/services/scheduler.test.ts __tests__/security/` — **1001/1001 passing** (103 test files, full API + identity + prompt-cleanliness sweep).

## Observability/guardrails

- **Added (in this fix):**
  - `chat-context-engine.ts:225` — `reason: 'Server-scoped authenticated profile prevents founder/default persona identity leakage.'` makes the context-source decision auditable.
  - `chat-message-routes.ts` — `mode: 'authenticated-identity'` log line on the fast-path hit.
  - `chat-message-local-responses.ts` — `metadata.type: 'authenticated_identity'` and `hasDisplayName` flag on the response envelope so the frontend / observability can confirm the path was taken.
- **Recommended (follow-up):**
  - CI gate: run `__tests__/security/p0-chat-identity-isolation.test.ts` and `__tests__/services/prompt-cleanliness.test.ts` on every PR.
  - Add a periodic codebase scan job that fails the build on any new `\bFelipe\b` outside `LICENSE.`/`Copyright` headers and the test fixtures that explicitly assert against it.

## Open items

- **P0:** None.
- **P1:** Live two-account device walk-through ("Who am I?" with `nexushubbot` AND with Felipe, observe iOS UI text and request payloads).
- **P2:** iOS — `nexus_push_*` `@AppStorage` keys persist across logout (cosmetic; not identity, but should be added to `keysToRemove` in `AppState.swift:540-549`).
- **P3:**
  - Delete unused `loadCreatorConfig`/`loadPromptWithConfig` from `prompt-loader.ts` once topic-generation is updated to use a per-user creator-memory loader.
  - Run a one-off DB query in production to verify no `users.id` numerically equals any other user's `telegram_id`.

## Final verdict

**PASS WITH CONDITIONS.**

Backend P0 is fixed and validated by 1001 passing tests. The architectural shape — scope before prompt, deterministic identity from JWT, neutral prompt fallbacks — is correct. The conditions are: (a) live two-account device walk-through on a signed iOS build, and (b) recommended staging soak before promoting to production.
