# P0 Chat identity — fixes applied

## Files modified (28)

### Production prompts

| File | Fix |
| --- | --- |
| `prompts/secretary.md` | Removed founder name + Felipe-specific routine; replaced with authenticated-user scope. |
| `prompts/content.md` | Removed "Felipe's content creation partner / The Operator" persona; switched to authenticated creator with explicit "do not use founder, owner, or default brand assumptions". |
| `prompts/cooking.md` | Removed "Felipe's practical chef"; switched to authenticated-user-stored dietary pattern, household, etc. |
| `prompts/finance.md` | Brazilian-tax default downgraded to "apply only when the user's stored profile or the request explicitly indicates Brazil/PJ/autônomo". |
| `prompts/topic-generation.md` | Removed `{{CREATOR_CONFIG}}` placeholder + "The Operator brand" framing; switched to authenticated creator with neutral fallback. |
| `prompts/creator-config.md` | **Fully sanitized** — no name, no worldview, no audience, no political/religious/dietary defaults. Now a NEUTRAL TEMPLATE with explicit guidance that real identity is loaded per-request from the authenticated user's saved Voice DNA. |
| `prompts/cross-skill-and-memory.md` | "Felipe says /remember…" → "the authenticated user issues /remember…"; "Felipe's active projects" → "the authenticated user's active projects". |
| `src/skills/secretary/prompts/system.md` | Removed "founder-athlete-creator life" framing; switched to "the authenticated user's working life" + per-tenant scope guidance. |
| `src/skills/finance/prompts/system.md` | Removed "strong Brazilian tax literacy" hardcoded default; conditional on user's stored profile. |

### Production code (TypeScript)

| File | Fix |
| --- | --- |
| `src/state/content-references.ts:560-573` | `buildKnowledgePromptBlock` — replaced literal `"adapt to Felipe's voice"` with `"adapt to the authenticated creator's saved Voice DNA / brand voice for this user and tenant, never copy verbatim. Do not assume any founder, owner, or default creator identity."` |
| `src/services/anthropic.ts:60` | Removed `loadPromptWithConfig` for content domain (was the auto-injection vector for `creator-config.md`). |
| `src/services/content-discovery.ts:25-43` | `buildDiscoverySystemPrompt` — replaced founder block with authenticated-creator scope. |
| `src/services/content-workflow.ts:174-270` | Taste-profile + topic-candidate strings switched to "the authenticated creator". |
| `src/handlers/commands/content.ts:1036-1212` | Telegram /calendar /brandcheck /repurpose prompts de-Felipe'd; userId now correctly propagates. |
| `src/handlers/media.ts:79` | Same fix as `commands/content.ts` for media-attached repurpose. |
| `src/domains/content-creator.ts` | `handleContent` now accepts an explicit `userId` parameter so the propagation chain is tight. |
| `src/services/user-service.ts:206-225` | `getUserByAnyIdentifier` reordered to try `getUserById` FIRST. New strict by-id helpers: `getPreferredDisplayNameById`, `getUserLanguageById`, `getUserTimezoneById`. |
| `src/services/chat-context-engine.ts:208-227` | New `authenticated-user` `ChatContextItem` (priority 98, `critical: true`) injecting the JWT-derived display name and explicit "do not use owner/founder/default names" instruction. |
| `src/api/routes/chat-message-local-responses.ts:36-176` | New `tryBuildAuthenticatedIdentityResponse` + 16 PT/EN identity-question regex patterns. |
| `src/api/routes/chat-message-routes.ts:283-296, 13` | Wired `tryBuildAuthenticatedIdentityResponse` BEFORE the slash-command and AI fastpaths. Migrated all `getUserLanguage(userId)` to `getUserLanguageById(userId)`. |
| `src/api/routes/chat-callback-routes.ts:6, multiple` | Migrated to `getUserLanguageById`. |
| `src/api/routes/chat-fastpath.ts:41, multiple` | Migrated to `getUserLanguageById`. |
| `src/api/routes/chat-message-request.ts:6, 49` | Migrated to `getUserLanguageById`. |
| `src/api/routes/training.ts:7, 54` | Migrated to `getUserLanguageById`. |
| `src/api/routes/content.ts:41, 253` | Migrated to `getUserLanguageById`. |
| `src/api/routes/content-script-routes.ts:7, 138` | Migrated to `getUserLanguageById`. |
| `src/api/routes/dashboard.ts:12, 213, 241, 316-320` | Migrated to `getUserLanguageById` + `getPreferredDisplayNameById`. Removed legacy `require()` fuzzy lookup. |
| `src/api/routes/dashboard-data-fetchers.ts:14, multiple` | Migrated to `getUserTimezoneById`. |
| `src/api/routes/tasks.ts:12, multiple` | Migrated to `getUserTimezoneById`. |
| `src/utils/telegram-formatter.ts:109-118, 221, 271` | `formatDailyBriefing` now takes a `recipientDisplayName` parameter; `goodMorning` is a function of name (with HTML escaping); never falls back to "Felipe". |
| `src/services/scheduler.ts:41, 1031-1046, 1640-1644` | Briefing caller passes `getPreferredDisplayNameById(target.tenantId)`. `fossa_email` cron gated behind `FOSSA_EMAIL_ENABLED=1` env flag. |
| `src/agents/voice-evolution-agent.ts:5, 30-86, 157, 239, 255, 271, 298` | ANALYSIS_PROMPT + persisted-payload signal descriptions de-Felipe'd. |
| `src/agents/reaction-radar-agent.ts:341, 385` | counterPosition + cross-agent comment de-Felipe'd. |
| `src/services/eval-criteria.ts:245, 275, 303, 338` | voice_fit / overall_quality / brand_voice / scope description de-Felipe'd. |
| `src/services/video-study.ts:5, 179, 181, 216` | STUDY_SYSTEM_PROMPT + JSDoc de-Felipe'd. |
| `src/services/context-engine.ts:206-208` | `saved_ideas` count strictly per-user (no `IN (0, ?)`). |
| `src/state/saved-ideas.ts:80-93` | `getIdeasBySource` now requires `userId`. |

### Production code (Python)

| File | Fix |
| --- | --- |
| `content-engine/services/creator_profile.py` | `_FALLBACK_PROFILE` and `_FALLBACK_SHORT` rewritten to be NEUTRAL — "CREATOR PROFILE: NOT YET CONFIGURED FOR THIS USER. The authenticated creator's saved Voice DNA, audience, references, and brand voice were not available at request time." |
| `content-engine/services/creative/hook_generator.py` | SYSTEM_PROMPT + worldview / audience defaults de-Felipe'd. |
| `content-engine/services/creative/caption_writer.py` | Same. |
| `content-engine/services/creative/thumbnail_gen.py` | Same + dietary aesthetic now conditional on creator's saved profile. |
| `content-engine/services/creative/title_tester.py` | SYSTEM_PROMPT + audience defaults de-Felipe'd. |
| `content-engine/services/creative/repurpose_engine.py` | Same. |
| `content-engine/services/book_knowledge.py` | Brazilian-creator framing replaced with authenticated-creator. |
| `content-engine/services/intelligence/gap_finder.py` | "Felipe should approach" → "the authenticated creator should approach". |
| `content-engine/services/intelligence/competitor_analyzer.py` | "actionable_insights for Felipe" → "for the authenticated creator". |
| `content-engine/services/scorer.py` | Removed `"libertarian"`, `"conservative"`, `"carnivore"` from default niche keywords; documented as setup-safe defaults. |
| `content-engine/services/orchestrator.py` | `felipes_angle` JSON field → `creator_angle` (with backward-compat fallback `synthesis.get("creator_angle", synthesis.get("felipes_angle", ""))`); persona-laden text de-Felipe'd. |

### Tests

| File | Change |
| --- | --- |
| `__tests__/security/p0-chat-identity-isolation.test.ts` | **NEW** — 23 cases pinning every fix above. |
| `__tests__/services/prompt-cleanliness.test.ts` | Extended to cover `creator-config.md`, `cross-skill-and-memory.md`, and skill-bundled prompts (`src/skills/<skill>/prompts/system.md`). |
| `__tests__/api/chat-message-local-responses.test.ts` | New cases for `tryBuildAuthenticatedIdentityResponse` (PT and EN). |
| `__tests__/services/chat-context-engine.test.ts` | New cases for the `authenticated-user` ChatContextItem. |
| `__tests__/api/{training-routes,chat-message-request,chat-callback-routes,dashboard-routes,calendar-focus-recommendation,app-facing-happy-path-smoke,content-home-route,content-script-duration,content-script-quota,tasks-routes}.test.ts` | Mocks updated to expose strict by-id helpers (`getUserLanguageById`, `getUserTimezoneById`, `getPreferredDisplayNameById`) so the migrated routes resolve cleanly. |

## Test results

- `npx tsc --noEmit` — clean.
- 7 focused identity-related test files: **214/214 passing**.
- Broader sweep (`__tests__/api/`, `services/user-service`, `chat-context-engine`, `prompt-cleanliness`, `scheduler`, `security/`): **1001/1001 passing across 103 test files**.

## Branch / commit policy

- All changes on `feature/p0-chat-identity-tenant-isolation-fix`.
- Backup tag: `backup/p0-chat-identity-before-fix-20260502-1704`.
- Local commits only — NOT pushed, NOT deployed, NOT amended.
- The pre-existing 28-file WIP that overlapped this audit's scope was completed on top of (not reverted), since most of it was the in-flight identity-isolation work.
