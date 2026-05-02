# P0 Chat identity root cause

**Reported symptom:** logged in as `nexushubbot`, asked "Who am I?", assistant replied "You're Felipe."

## Primary root cause

`src/state/content-references.ts:562` — `buildKnowledgePromptBlock` returned a literal `"adapt to Felipe's voice, never copy verbatim"` instruction inside the system prompt for any authenticated user with at least one row in `content_knowledge`. Combined with `prompts/secretary.md` (`"Felipe's personal assistant…"`), `prompts/cooking.md` (`"Felipe's practical chef…"`), `prompts/finance.md` (`"Felipe's personal finance advisor…"`), and `prompts/content.md` (`"Felipe's content creation partner for The Operator brand"`), the model was being told the user IS Felipe by the system prompt, and naturally answered "You're Felipe" when asked.

This was the smoking gun: the prompt itself asserted Felipe's identity for every chat turn.

## Secondary root cause

`prompts/creator-config.md` was a fully fleshed-out founder identity document (name, location, brand, worldview, audience, dietary preferences, political stance) auto-injected anywhere `{{CREATOR_CONFIG}}` placeholder was used (originally `prompts/content.md` and `prompts/topic-generation.md`). And `prompts/cross-skill-and-memory.md` referenced "Felipe says /remember…" / "Felipe's active projects" in the doc spec.

The Python content-engine had a parallel leak: `content-engine/services/creator_profile.py:_FALLBACK_PROFILE` defaulted to `"CREATOR: Felipe Dominguez — \"The Operator\""`, which meant any non-Felipe user calling content-engine endpoints (caption_writer, hook_generator, thumbnail_gen, title_tester, repurpose_engine, book_knowledge) when the per-request creator profile was unavailable received Felipe identity instead.

## Tertiary root cause (defense-in-depth)

`src/services/user-service.ts:206-211` `getUserByAnyIdentifier(userRef)` resolved `getUserByTelegramId(userRef)` BEFORE `getUserById(userRef)`. iOS API requests carry the canonical `users.id` in JWTs; if that ID happens to numerically match a foreign user's `telegram_id`, the foreign row is silently returned. The fuzzy helper was called from `getUserLanguage`, `getPreferredDisplayName`, and `getUserTimezone`, all consumed by 11 iOS-route call sites.

Telegram IDs are typically 7-10 digits while `users.id` autoincrements from 1, so the practical collision is rare — but it is a real foot-gun for any future state where the sequences could overlap, and the audit's recommendation to fortify it is correct.

## How the user's experience was generated

When the iOS app sent the `nexushubbot` user's "Who am I?" message:

1. The chat router picked the `secretary` (or `content`) domain.
2. `getDomainSystemPrompt('secretary')` loaded `prompts/secretary.md` (which began "You are Felipe's personal assistant…").
3. For content-domain calls, `buildKnowledgePromptBlock` appended "adapt to Felipe's voice".
4. The model received a prompt that asserted the user IS Felipe.
5. The model answered "You're Felipe."

No memory leak, no auth bug, no cross-tenant retrieval — the ANSWER was hardcoded in the SYSTEM PROMPT.

## Why the iOS audit cleared the cache layer

The iOS app:
- Sends only `{ text, replyToId?, attachments? }` on `/api/v1/chat/message` (`ChatService.swift:19-32`).
- Re-mounts `MainTabView` on auth flip, killing all `@State` view models including `ChatViewModel`.
- Clears all 15 repos + Keychain + UserDefaults on `signOut()` (`AppState.swift:503-564`).
- Keys chat history per `chatScopeKey = "user-<id>.tenant-<id>"` (`ChatRepository.swift:356-367`).

iOS was correctly partitioning per-user state. The leak was entirely backend.

## Why prior `4.14.74` "remove founder defaults" pass missed this

The `4.14.74` pass focused on TRAINING coach engine prompts (Felipe/carnivore/high-volume defaults). It did not audit the chat-domain prompts (`secretary.md`, `cooking.md`, `finance.md`, `content.md`), the knowledge-pattern injector (`buildKnowledgePromptBlock`), or the Python content-engine creative modules. The May 2026 audit closes that gap.

## Next layer of defense (now in place)

1. The `tryBuildAuthenticatedIdentityResponse` fast-path catches identity questions BEFORE the AI pipeline runs, answering deterministically from the JWT.
2. The `authenticated-user` `ChatContextItem` (priority 98, `critical: true`) injects the authenticated display name and an explicit "do not use owner/founder/default names" rule into every chat prompt.
3. Prompt-cleanliness regression tests (`__tests__/services/prompt-cleanliness.test.ts`) gate any future "Felipe" reintroduction in the production prompts.
4. The strict by-id resolvers + reordered `getUserByAnyIdentifier` close the id-collision foot-gun.
