# Claude Code — Hardening Audit Handoff

**Branch:** `claude/project-hardening-audit`
**Date:** 2026-04-20
**Scope:** Full project hardening scan across backend (`cortex-telegram-hub-bot`) + iOS (`Nexus Hub IOS`). Code-first. Read-heavy, narrow targeted fixes, Codex parallelism preserved.

---

## 1. TL;DR for the next agent

- **Three CRITICAL-tier findings** are in this report. One is **already fixed in this branch** (dashboard cross-tenant leak). Two require **your approval or ownership**:
  1. `.env.agents` on Felipe's Mac holds unmasked production secrets including `IOS_API_JWT_SECRET` and `OAUTH_ENCRYPTION_KEY`. Not in git, but Mac compromise = full blast radius. **Rotate on your schedule.** I did not touch it.
  2. `docs/SKILL_ARCHITECTURE.md` (Phase 1 plan) and `CLAUDE.md` (Phase 0 status) disagree with reality. Phase 0 "orchestration cleanup ✅" is still false — `src/services/quality-scorer.ts`, `src/agents/editorial-coordinator-agent.ts`, and 3 other agents-folder files are multi-agent orchestration residue.
- **28 backend files + 17 iOS files** are parked as `stash@{0}: codex-wip-parked-before-claude-audit-2026-04-20`. **Do NOT pop this stash blindly.** It's Codex's in-flight secretary-orchestrator + i18n-daily-briefing work plus an iOS Home refactor (2,780+ insertions). Coordinate with Felipe/Codex before restoring.
- **5 safe fixes landed.** All validate green: `tsc --noEmit` clean, 4675/4675 vitest passing.

---

## 2. What I fixed (narrow & merge-friendly)

| # | File | Change | Severity addressed |
|---|---|---|---|
| 1 | `src/api/routes/dashboard.ts:1218-1240` | Fixed `getSessionsForWeek(userId)` → `getSessionsForWeek(currentWeek.id)` (plus derive `todaySession` via `day_of_week`). Prior code passed `userId` as `weekId` causing silent primary-path failure + cross-tenant leak risk on `userId == week.id` collisions. | HIGH bug + cross-tenant-leak |
| 2 | `src/api/response-helpers.ts:163-212` | `asyncHandler` now records to `errorMonitor` (→ SQLite `error_log` + Sentry + Telegram alert) with `reqId`/`userId`/route, and returns a stable `INTERNAL server error` without leaking `err.message` to the client. Route-level throws were previously silently lost. | HIGH resilience + MED info-disclosure |
| 3 | `src/portal/server.ts:1806-1826` | Dropped `10.0.0.0/8` auto-allow in the portal-no-token bypass. Was a hidden backdoor if the process ever moves to a VPC or shares a Docker network. Tailscale users unaffected (CGNAT `100.64.*`). | HIGH security posture |
| 4 | `migrations/035_apple_health_data.sql` + `migrations/049_apple_health_data.sql` | Added schema-drift WARNING headers. Both files create the same table with DIFFERENT shapes; `035` wins by sort order; `049` silently no-ops. Runtime in `health-data.ts:73-95` already uses `PRAGMA table_info` as a kludge. No ALTER, just documentation. | HIGH maintainability |
| 5 | `.husky/pre-commit`, `.husky/pre-push`, `scripts/setup-hooks.sh` | Committed hooks + updated installer to `git config core.hooksPath .husky`. Replaces the old imperative write-to-`.git/hooks` approach which drifted per-clone. Run `./scripts/setup-hooks.sh` once after pulling this branch. | MED DX |
| 6 | `__tests__/api/response-helpers.test.ts` | Updated asyncHandler expectation to match the new client-safe message contract (`'Internal server error'` instead of leaked `err.message`). | test |

**Validation:** `npx tsc --noEmit` clean, `npx vitest run` = 4675/4675 pass.

---

## 3. What I found but did NOT fix (triaged by severity)

### CRITICAL
- **`.env.agents` on Felipe's Mac.** Plaintext secrets including `IOS_API_JWT_SECRET`, `OAUTH_ENCRYPTION_KEY`, OpenAI key, Gemini key, Google/Outlook/Strava client secrets + refresh tokens, Notion token, Telegram bot token, INTERNAL_API_SECRET (`local-content-bridge-2026`). Gitignored (`.gitignore:22`), confirmed never committed (`git log --all -- .env.agents` empty for that file). Rotation plan:
  - JWT_SECRET rotation invalidates every iOS device → coordinate with a push-refresh flow
  - OAUTH_ENCRYPTION_KEY rotation requires re-encrypting every `oauth_tokens` row; `src/services/oauth-store.ts:70-91` already supports key-per-boot assertion but no rotation helper exists today
  - Move to macOS Keychain references or a secret manager (1Password CLI, `op run`)
- **Phase 0 "orchestration cleanup ✅" is a lie.** `src/services/quality-scorer.ts` + `src/agents/editorial-coordinator-agent.ts` + `src/agents/performance-agent.ts` + `src/agents/seo-agent.ts` + `src/agents/script-generator-agent.ts` are orchestration residue that CLAUDE.md:~105 claims is gone. Either the claim needs updating or the files need deleting (both exports are only consumed by portal admin panels).

### HIGH (bug / resilience / security)
- **iOS contract decoders**: only `TrainingHomeViewState` has a backward-compat `init(from:)`. `HomeViewState` (`Views/Dashboard/HomeViewState.swift:35-44`), `ContentHomeViewState` (`Views/Content/ContentHomeViewState.swift:137-145`), `DailyStateHeroModel`, `SecretaryPreviewModel`, `NextBestActionHeroModel` are synthesized `Codable` — a server adding ANY non-optional field crashes Home/Content. Promote `TrainingHomeViewState`'s pattern to a shared `ScreenContractDecodable` protocol.
- **9+ iOS tests assert Portuguese strings without `setUp` calling `LanguageRouter.shared.setLanguageCode("pt-BR")`**: `ContentHomeContractResolverTests`, `TrainingHomeContractResolverTests:259`, `MeshWeekConstraintSummaryResolverTests:47`, `InboxRefreshFailureResolverTests:69,90`, `TrainingPresentationTests:27,81,211`, `ContentSkillPresentationTests:42,74`, `SecretarySyncPresentationTests:51`, `TrainingTodayAdjustmentSummaryResolverTests:94,149,151`, `HomeViewStateBuilderTests`, `TrainingViewModelObservationTests`. All fail on any machine whose default language differs from Felipe's. One-line `setUp` fix per file.
- **Auth middleware writes 2 rows on every iOS request**: `src/api/auth-middleware.ts:45-50` does `UPDATE ios_devices` + `UPDATE users` inside the auth verify path. This is a perf cost AND means every `/api/v1/*` 401 from an expired token still DOES NOT trigger because the try-catch hides the UPDATE error. Add a `users.status='active'` check (one indexed SELECT) and either debounce `last_active_at` or move to a queue.
- **Rate limiter is per-userId only**: `src/api/rate-limiter.ts:17-21` returns `next()` when `userId` is absent → `/auth/register`, `/auth/refresh`, webhook endpoints have **no rate limit whatsoever**. Invite code `BETA2026` is brute-forceable.
- **`training/home` double-fetches calendar**: `src/api/routes/training.ts:1515` (`getTodaySession`) + `:1605` (`getWeekPlan`) both call `buildCalendarEventLookup` inside the parallel `Promise.allSettled` — 2 Google+Outlook round-trips per request. ~300-700ms savings on a cold hit.
- **Scheduler lazy `require()` inside cron bodies**: `src/services/scheduler.ts:784, 808` call `require('./database').getDb()` inside a loop despite the module having a top-level import on line 42. Zero functional bug but defeats module-graph tools.
- **Migration runner tolerates 8 colliding numeric prefixes**: `src/services/database.ts:107-125` logs a warning and applies anyway. 008/009/022/023/024 and the drifted 035+049 duplicate pair. Warning has been there for weeks; fix is renaming files to `008a_`/`008b_` but renaming now re-applies. Safe path: write new migrations only with unique prefixes + add a pre-commit lint that rejects collisions.

### MEDIUM (maintainability / perf / dead code)
- **Three hand-rolled `*-home-view-state.ts` files** (`training`, `dashboard`, `content`) re-declare overlapping enums: `*DayStateKind`, `*SemanticTint`, `*HeroActionTarget`, `*HeroActionModel`, `*ReasoningSignal`. Extract a `home-view-state-core.ts` with `HeroActionModel<T>` generic. Same for iOS builders + resolvers.
- **DashboardView.swift = 2497 LOC / 28 state vars / 85 inline view-builders.** `DashboardContentView` is a god struct — `fallbackOrchestrationSummary` (638-736) is domain logic inside a SwiftUI view. Extract to `HomeContractResolver` / dedicated fallback resolver.
- **Metric-chip / status-chip / card-header reimplemented 7+ times** across iOS. `DashboardView.kpiChip`, `HomeDashboardComponents.HomeMetricTile`, `TrainingSecondarySections.TrainingOverviewMetricChip`, `TrainingCoachComponents.TrainingHeroMetricTile`, `WeeklyActivityCard.SummaryMetric`, `WeeklyPlanComponents.WeeklyPlanMetricTile`, `ProfileHubView.ProfileMetricTile`. Single `NexusMetricTile` kills ~800 LOC.
- **86 lazy `require()` in backend routes.** Most are re-requiring `services/database`. No functional bug — but hides circular imports and breaks `madge`/`depcruise` analysis.
- **5 genuine TODOs** (not 36 — constants inflated the grep): `src/services/task-store/task-router.ts:62` (Todoist adapter stubbed), `src/portal/server.ts:3376` (WhatsApp webhook returns 200 and drops data), `src/adapters/whatsapp-adapter.ts:323` (test-infra blocker), `scripts/seed-uber-session.ts` (dead seeder referencing pre-rename dir), and one in `Core/Services/SkillsService.swift:60` iOS.
- **`readiness-scorer.calculateReadiness` has NO internal cache.** `src/services/readiness-scorer.ts:422`. Training-home wraps it in `READINESS_TTL` but `dashboard-readiness:${userId}` and `focus-planner.ts:89` each re-hit. Readiness is Garmin-quota-expensive.
- **Dashboard has two cache keys for the same data**: `dashboard:${userId}:${language}` and `dashboard-home:${userId}:${language}`. Writing to one doesn't invalidate the other.
- **Cache store prepares statements per call** instead of at module load — `src/services/cache-store.ts:56,81,120,167,180,193,205`. Module-level prepared statements = ~50% cache-path reduction.
- **`.task {}` blocks in iOS are unkeyed** (50+ sites). Only one uses `.task(id:)`. Tab-switch dedup is luck.
- **No real linter.** `package.json:17` `"lint": "npm run typecheck"` — lipstick on a type check. Add ESLint or biome.
- **Coverage thresholds are 1% lines, 15% functions** — effectively off. `vitest.config.ts:24-27`.
- **CORS regex on `/waitlist` allows `[a-z0-9-]+\.nexushub-landing\.pages\.dev$`**. Cloudflare Pages project namespace collisions are unlikely but worth making the allowlist exact (`main.` + specific preview pattern).

### LOW (cleanup)
- **6 decommissioned `TASK-*.md`** at repo root say "Status: decommissioned historical implementation spec". Delete.
- **`src/services/microsoft-auth.ts:177` `setRequestUserId`** documents itself as no-op-for-backward-compat. Delete export.
- **`src/adapters/whatsapp-adapter.ts`** — shell adapter with no downstream routing. Activate or delete.
- **`scripts/seed-uber-session.ts`** — dead seeder for deleted integration.
- **CD workflow env**: `.github/workflows/cd-production.yml:16` still says `REMOTE_DIR: /home/dominguez/telegram-hub-bot  # TODO: rename to nexus-hub`. Everything else has renamed — finish it.
- **`.github/workflows/ci.yml:5-7` triggers on `develop` branch** that CLAUDE.md says is unused. Remove from trigger list.

---

## 4. Product-behavior findings

- **Deterministic coach kernel guardrails now reach the iOS contract** (shipped 2026-04-20 in v4.14.55): `WeekProtectionModel.kernelAdjustments` + `hero.originalPrescription`/`adaptedPrescription` + `confidence` enum + `lowAdherenceCard`. iOS decoders are backward-compat only for `TrainingHomeViewState`.
- **Dashboard "today's training" primary path was silently broken** (fix #1 above) — for weeks, every dashboard load fell through to the calendar fallback. Users with no calendar events saw empty training blocks even when they had an active plan. Fix lands here.
- **Readiness banding is opinionated** (`training-coach-kernel-plan-generator.ts`: `scoreToReadinessLevel` — ≥80 green, 60-79 yellow, 40-59 orange, <40 red). High-severity injuries cap at orange even with high score. Document if this ever confuses users.

---

## 5. Risky areas I did NOT deep-audit

- **Prompt injection surface** — user text flowing into `src/services/anthropic.ts`, `src/services/gemini-provider.ts`, `src/services/tool-executor.ts`. Particularly: tool results from external APIs being echoed back to the LLM. Next agent should run a focused injection audit.
- **OAuth state-token CSRF** — `src/services/oauth-state-store.ts` + `src/api/routes/oauth-initiate.ts`. I did not read in depth.
- **Stripe + Apple receipt verification idempotency** — `src/api/routes/billing.ts`. Not validated.
- **Python content-engine input validation** — receives traffic from `/internal/ai-complete`. Out of my scope this pass.
- **WebSocket auth** — `src/api/websocket.ts`. JWT verified on connect? On every message?
- **Portal admin routes** — `src/portal/server.ts` is 3600+ lines. I read ~300; the rest has many admin routes I did not enumerate for `access_level==='admin'` gating.

---

## 6. Open "next workstream" ranking (highest-impact first)

1. **Secrets rotation + secret-manager migration** (Critical, 1-2 days). `.env.agents` → Keychain/op-CLI. Add a per-boot secret-presence check.
2. **iOS contract-decoder hardening** (High, 0.5 day). Introduce `ScreenContractDecodable` protocol, retrofit `HomeViewState` + `ContentHomeViewState` + 4 substructs.
3. **PT-BR test setup fix across 9+ files** (High, 0.5 day). Mechanical edit: add `LanguageRouter.shared.setLanguageCode("pt-BR")` in every affected `setUp`. Make CI fail when it's missing.
4. **Home view-state contract unification** (High, 2-3 days). Extract `home-view-state-core.ts` + `HomeContractResolver<T>` generic. Consolidates ~40% LOC across 3 backend services + 3 iOS resolvers + 3 iOS builders.
5. **DashboardView.swift god-file extraction** (High, 2 days). Pull `fallbackOrchestrationSummary` + `DashboardContentView` computed business logic into resolvers. This blocks Phase 1 skill-split work; the longer it stays monolithic the more merge pain.
6. **`training/home` calendar double-fetch + readiness cross-cache unification** (Medium, 0.5 day). Saves ~300-700ms per cold hit + Garmin quota.
7. **Phase 0 orchestration cleanup** (Medium, 0.5 day). Delete `quality-scorer.ts`, 4 `src/agents/*` files, update CLAUDE.md. Finish the claim.
8. **Rate-limiter IP fallback + `users.status='active'` check in auth middleware** (Medium, 0.5 day). Two small surface-hardening fixes.
9. **ESLint + SwiftLint adoption** (DX, 1 day). Enforce `no-floating-promises` + `no-unused-vars` backend, `.swiftlint.yml` with line-length + force-unwrap lint iOS.
10. **Component consolidation (iOS)** (Medium, 2 days). `NexusMetricTile` + `NexusStatusChip` + `NexusInfoCard` + standard card-header. Retires 800+ LOC of duplicated UI primitives.

---

## 7. Codex-parallelism notes (READ BEFORE EDITING)

**Stashed Codex WIP — `stash@{0}`:**

Backend (28 files):
```
__tests__/api/chat-routes.test.ts
__tests__/handlers/callback-query.test.ts
__tests__/handlers/commands/secretary-commands.test.ts
__tests__/handlers/commands/secretary-helpers.test.ts
__tests__/router/classifier.test.ts
__tests__/services/anthropic-language.test.ts
__tests__/services/daily-brief-orchestrator.test.ts
__tests__/services/dashboard-home-view-state.test.ts
__tests__/services/openai-provider.test.ts
__tests__/services/scheduler-user-scope.test.ts
__tests__/services/secretary-orchestrator.test.ts (NEW)
__tests__/utils/telegram-formatter.test.ts (NEW)
src/api/routes/chat-fastpath.ts
src/api/routes/chat.ts
src/api/routes/dashboard.ts
src/domains/ai-unavailable.ts
src/domains/secretary.ts
src/handlers/callback-query.ts
src/handlers/commands/secretary-helpers.ts
src/handlers/commands/secretary.ts
src/router/classifier.ts
src/services/anthropic.ts
src/services/daily-brief-orchestrator.ts
src/services/dashboard-home-view-state.ts
src/services/openai-provider.ts
src/services/scheduler.ts
src/services/secretary-fastpath.ts
src/services/secretary-orchestrator.ts (NEW)
src/services/weekly-plan-orchestrator.ts
src/utils/telegram-formatter.ts
```

iOS (17 files, sep repo):
```
Nexus Hub/Core/Repositories/DashboardRepository.swift
Nexus Hub/Core/Services/PlanService.swift
Nexus Hub/Models/CalendarEvent.swift
Nexus Hub/Views/Content/ContentHomeContractResolver.swift
Nexus Hub/Views/Dashboard/DashboardSecretaryCalendarComponents.swift
Nexus Hub/Views/Dashboard/DashboardView.swift
Nexus Hub/Views/Dashboard/HomeContractResolver.swift
Nexus Hub/Views/Dashboard/HomeDashboardComponents.swift
Nexus Hub/Views/Dashboard/HomeViewState.swift (+1563 lines planned)
Nexus Hub/Views/ScreenContractMetaVisibility.swift
Nexus Hub/Views/Training/TrainingHomeContractResolver.swift
+ corresponding test + 3 new files (PlanCoordinationModels, SecretaryDayPlanSheet, PlanCoordinationDecodingTests)
```

**Patterns evident in the stash:** (a) secretary-orchestrator abstraction being built, (b) daily-briefing localization (formatter accepts `FormatterLanguage`), (c) iOS Home viewstate expansion that will roughly double the file.

**When you restore:** `git stash pop stash@{0}` after this branch is merged (or in Codex's own branch). If you conflict with my fixes on `dashboard.ts` or `response-helpers.ts`, Codex's hunks are all ABOVE line 645 on dashboard and don't touch `response-helpers.ts` at all — merge should be mechanical.

---

## 8. Validation evidence

```
$ npx tsc --noEmit
(clean)

$ npx vitest run
 Test Files  228 passed (228)
      Tests  4675 passed (4675)
   Duration  68.04s
```

Test additions: `__tests__/api/response-helpers.test.ts` updated (existing test adjusted for new contract; no new tests added — I treat the fix as narrow enough that the existing coverage stays representative).

---

## 9. Final commit / push plan

This branch (`claude/project-hardening-audit`) is pushed to origin as the audit deliverable. **Do not merge to main without:**
- Human review of the 5 fixes
- Coordination with Codex on the `dashboard.ts` + `scheduler.ts` merge (see Section 7)
- Secret-rotation decision (see Section 3 Critical)
- Decision on Phase 0 cleanup (delete orchestration residue or update CLAUDE.md)

---

*Signed: Claude Sonnet 4.6 (1M context), hardening audit pass 2026-04-20.*
