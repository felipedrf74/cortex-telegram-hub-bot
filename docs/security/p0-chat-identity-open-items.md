# P0 Chat identity — open items

## P0 — None.

The original P0 (`nexushubbot` told it was Felipe) is closed by:
- Removed every founder-identity reference from production prompts.
- Added deterministic identity fast-path before any AI call.
- Added explicit "do not assert founder/owner/default identity" instruction in the system context.
- Closed defense-in-depth gaps (id-collision, saved_ideas count, fossa cron).
- 1001/1001 tests passing.

## P1 — Live device validation

Walk-through still required on a signed iOS build with two real accounts (Felipe + `nexushubbot`). See `p0-chat-identity-frontend-validation.md` for the runbook.

The static iOS audit (Phase 6) is high-confidence — the cache-clear path is correct and per-user scoped — but the project policy says "Do not claim frontend validated unless the app was actually navigated and the question was asked through the UI." Treat this as PASS WITH CONDITIONS until a screenshot of the live walk-through is appended.

## P2 — Cosmetic / hygiene

- **iOS — `nexus_push_*` `@AppStorage` keys persist across logout** (`Nexus Hub/Views/Settings/SettingsView.swift:45-49`, `Nexus Hub/Core/AppState.swift:540-549`). User B inherits user A's push toggles. Add to `keysToRemove` in `signOut()`.
- **iOS — `ResponseCache.swift` singleton** with no scope keys. Currently dead code (no usages). Either delete the file OR add a `clear()` call to `signOut()` and gate every put/get behind a scope key.
- **iOS — `ContentIntelligenceView.swift:1443,1452`** has hardcoded `["@felipe", "@danielbarada"]` literals inside (apparently) preview/seed data. Verify they are not displayed to non-preview users.

## P3 — Defense-in-depth follow-ups

- **Delete unused `loadCreatorConfig` / `loadPromptWithConfig`** from `src/utils/prompt-loader.ts` once the topic-generation pipeline is migrated to a per-user creator-memory loader. Today the file is referenced but the only domain that triggers it (`topic-generation`) has had `{{CREATOR_CONFIG}}` removed; the legacy plumbing is dead. Removing it eliminates the temptation to re-introduce.
- **Production DB sweep** — run `SELECT id, telegram_id FROM users WHERE id IN (SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL) OR telegram_id IN (SELECT id FROM users)` to confirm no `users.id` numerically collides with another user's `telegram_id`. If any collision exists, plan a migration to either bump one ID or namespace the lookup.
- **CI gate** — fail the build on any new `\bFelipe\b` outside `LICENSE.`/`Copyright` headers and explicitly-flagged test fixtures. Implementation: a tiny grep step in CI scaffolded against the same allow-list as `prompt-cleanliness.test.ts`.
- **Skill prompt audit** — extend the `prompt-cleanliness` regression test to cover every `src/skills/<skill>/prompts/system.md` automatically (current test enumerates 2 skills explicitly; should auto-discover).
- **Periodic dependency review** — verify any new domain or skill prompt added in the future passes the cleanliness gate before being marked production-ready.

## P3 — Observability follow-ups

- Wire a Sentry breadcrumb on every `tryBuildAuthenticatedIdentityResponse` hit so we can see when users explicitly ask "Who am I?" in production. Pattern: `pushEvent({ category: 'chat', subcategory: 'authenticated-identity-fastpath', userId, tenantId, hasDisplayName })`.
- Emit a structured warning if `getPreferredDisplayNameById(userId)` returns empty in the chat context engine — that means a real user has no saved name and is at risk of confusing-but-safe fallback behavior.
- Add a metric `chat_identity_response_total{path="fastpath" | "model" | "fallback"}` to track how often the fast-path wins vs falls through. Production should be ~100% fast-path for identity questions.

## P3 — Documentation drift watch

- Every founder-identity statement in `prompts/` is now flagged by the cleanliness test. Verify any new prompt added under `prompts/` or `src/skills/*/prompts/` enters that test's allow-list explicitly (don't relax the regex).
- The narrowed `creator-config.md` is the canonical neutral template. Future creator-config edits should keep it neutral; identity should ALWAYS be loaded per-request from the authenticated user's `content_creative_memory`.

## P4 — Unrelated-but-noticed during audit

- `src/api/routes/dashboard.ts:316-320` previously did `const { getPreferredDisplayName } = require('../../services/user-service')` inside a try-catch. The dynamic require pattern is unsafe in TS — replaced with a static import. This is now closed but the pattern existed elsewhere — search and stamp out any other dynamic `require('../../services/user-service')` if found.

---

**Summary:** The P0 itself is closed. P1 is the device walk-through. P2/P3 are hygiene and defense-in-depth. P4 is a code-quality smell uncovered during the audit (already fixed for this site).

---

## Training slice addendum (May 2026 Training deep-audit pass)

Filed during the Codex Training/Coach hardening audit (commits 8ac0b50 + 4d971c1). These items overlap with the P0 audit's findings but are surfaced from the Training perspective:

## P0

- None reproduced in this Training deep-audit pass.

## P1

- Make mesh readers tenant-explicit (`userId` + `tenantId`) before claiming full cross-skill shared-context safety.
- Add a cross-account iOS smoke that logs in as user A, loads Training/Chat, switches to user B, and verifies no prior plan/profile/name is visible.

## P2

- Add a provider-enabled tenant smoke once non-production provider credentials are available, so model fallback behavior is validated beyond local fixture mode.
- Add a QA guard that fails if DEBUG identity bypass arguments are present in TestFlight/Release launch configurations.
