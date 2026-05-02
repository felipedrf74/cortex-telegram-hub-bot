# P0 Chat identity / tenant isolation audit

**Engagement:** End-to-end audit of identity / tenant scoping in Nexus Hub triggered by a P0 user report.

**Trigger:** A non-Felipe user (`nexushubbot`) typed "Who am I?" in the iOS chat and received "You're Felipe" — proof of cross-user identity contamination in the chat path.

**Date:** May 2, 2026.

**Auditor:** Claude Opus 4.7 (max effort), running 4 parallel investigation subagents (general-purpose, hardcoded-identity scan / auth resolver / memory-retrieval / iOS cache state).

## Scope

End-to-end across:

- Backend / runtime: auth/session, current-user resolution, chat routes, prompt construction, memory + retrieval + summaries, Secretary identity path, tool calls, skill invocation, model provider context, local fixtures, log/observability.
- iOS: login/session, account switch, tenant switch, current-user cache, chat conversation cache, chat screen state, local fixtures, app launch, bottom-tab navigation, stale data after logout/login or tenant switch.
- Portal: not modified by this audit (no portal code paths in the contamination chain).

## Methodology

Phase 0 — reproduce + map state. Verified the issue at the source-code level: `nexushubbot` user row does NOT have `first_name = 'Felipe'`; therefore the answer "You're Felipe" must come from a different path than the user record itself.

Phase 1 — hardcoded-identity scan (subagent 1). Searched the entire backend + iOS + Python for: `Felipe`, `Dominguez`, `The Operator`, `founder`, `OWNER_USER_ID`, `defaultUser`, `preferredName`, `displayName`, `mockUser`, `seedUser`, `fixtureUser`, `Você é Felipe`, `You're Felipe`. Each occurrence classified as PRODUCTION-PATH-RISK / DEV-OR-TEST-GATED / DOCS-ONLY / SAFE-CONTEXT.

Phase 2 — auth/session/current-user audit (subagent 2). Traced the iOS Chat request from `Authorization: Bearer <jwt>` through `authMiddleware` to `req.userId, req.tenantId`. Verified single source of truth (signed JWT → users.id), refused header-echo widening, refused post-logout JWTs via the device-row check.

Phase 3 — chat prompt context audit (manual + subagent context). Inspected `getDomainSystemPrompt`, `buildKnowledgePromptBlock`, `loadPromptWithConfig`, `buildScopedStateContextPrefix`, the chat context selector. Found the smoking gun.

Phase 4 — memory/retrieval/shared-context audit (subagent 3). Inventoried every memory/retrieval/cache surface, verified scope columns (tenant_id, user_id) on each table and read site. Found two minor leaks (`saved_ideas` count `IN (0, ?)` and `getIdeasBySource` no userId).

Phase 5 — tool/skill invocation audit (manual). Verified `chat-tool-authorization` enforces user scope before tool execution. Found that `src/skills/secretary/prompts/system.md` and `src/skills/finance/prompts/system.md` had founder defaults.

Phase 6 — iOS cache + frontend workflow validation (subagent 4). Verified iOS state lifecycle: `signOut()` → all repos invalidate, `MainTabView` re-mount kills `@State` view models, `ChatRepository.ensureCurrentScope()` resets messages on scope change. Live device walk-through deferred to follow-up runbook.

Phase 7 — end-to-end test matrix. Designed and executed cases A through J against the fixed code. All P0 cases pass under unit/static-source assertions; live two-account device test pending.

Phase 8 — implementation. Fixes applied across 28 files. See `p0-chat-identity-fixes-applied.md` for the exhaustive list.

Phase 9 — tests. 1001/1001 passing across 103 test files; new regression suite at `__tests__/security/p0-chat-identity-isolation.test.ts` (23 cases).

Phase 10 — observability. Added structured logs / metadata: `mode: 'authenticated-identity'`, `metadata.type: 'authenticated_identity'`, `reason: 'Server-scoped authenticated profile prevents founder/default persona identity leakage.'` Recommended CI gate for `prompt-cleanliness` + `p0-chat-identity-isolation` test files on every PR.

Phase 11 — cleanup. Backend running locally for tests only (no production processes started). No simulators, no provider-call loops, no orphan processes. The investigation stash from earlier in the session was popped and restored before commits.

Phase 12 — final report. See `p0-chat-identity-final-report.md`.

## Findings summary

- 1 PRIMARY production leak (chat domain prompts + buildKnowledgePromptBlock).
- 2 SECONDARY production leaks (creator-config.md auto-injection, Python content-engine fallback).
- 1 TERTIARY foot-gun (getUserByAnyIdentifier ordering).
- 2 minor production leaks (saved_ideas count, getIdeasBySource no scope).
- 1 single-tenant cron leak (fossa_email).
- ~22 hardcoded persona references in persisted-payload writers (voice-evolution-agent, reaction-radar-agent, eval-criteria, video-study) and iOS-served Python content-engine modules.

All fixed. Validated by 1001 passing tests.

## Models / tier used

- Audit driver (this Claude Code session): Claude Opus 4.7, max effort. Verified by `model: opus` setting and the `<system-reminder>` confirming `claudeMd` instructions.
- 4 parallel subagents (`Agent` tool, `general-purpose` type): each inheriting the parent's model + effort. The system does not expose explicit per-subagent model overrides for general-purpose, so all critical subagent work in this audit ran on the parent's tier (Opus 4.7, max effort).
- Recommendation for future critical security audits: explicit `model: "opus"` override on each `Agent` call for paranoia, even though general-purpose inherits.

## Confidence

- High confidence on the primary smoking gun + fix.
- High confidence on the auth-layer scoping (verified multiple times with explicit static-source assertions).
- High confidence on the prompt-cleanliness regression suite preventing reintroduction.
- Medium confidence on the iOS side — static audit was thorough but live two-account device walk-through is the only way to fully close the iOS cache claim.

## Out of scope (deferred)

- Live signed-TestFlight two-account device walk-through (filed in `p0-chat-identity-frontend-validation.md`).
- Portal admin / operator surfaces — not implicated in this incident.
- Periodic codebase-scan job for new "Felipe" hardcoding — recommended as CI follow-up.
- One-off DB query in production to confirm no `users.id`/`telegram_id` numeric collision currently exists — recommended as ops follow-up.
