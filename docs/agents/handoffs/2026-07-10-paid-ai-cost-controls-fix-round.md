# 2026-07-10 Paid-Only AI Cost Controls Fix Round

Status: implementation/fix round complete; backend code deployed to staging and
production in observe mode; backend and iOS source published to `main`.

## Original Goal

Make model-backed AI available only to active paid/founder users, enforce
cost-equivalent daily, monthly, automation, and system limits without spending
Nexus Points in background work, preserve token-zero Secretary behavior, reduce
the dominant Coach, Content, Channel Learning, and Autoresearch workloads, and
expose additive quota state and stable errors to the portal and iOS app.

This fix round independently reproduced the 2026-07-10 adversarial QA findings
and repaired the confirmed P1/P2 issues plus the requested quick P3 issues.

## Branches and Commits

- Backend worktree: `/Users/felipedominguez/.codex/worktrees/paid-ai-cost-controls-backend`
- Backend base: `bbd8205b`
- Backend implementation: `3ce20473` (`feat(ai): add paid-only cost controls`)
- Backend fix round: `fa4de82e` (`fix(ai): harden paid cost controls`)
- Backend verification docs: `82835940`, `3cf19dce`
- Backend release: `6c67c181` (`chore: prepare release 4.14.216`)
- iOS worktree: `/Users/felipedominguez/.codex/worktrees/paid-ai-cost-controls-ios`
- iOS base, implementation, and fix-round SHAs: see the workspace canonical
  ledger and the final independent-QA prompt; the two commit subjects are
  `feat(ai): add paid quota entitlement UX` and
  `fix(ai): harden quota reset handling`.

Backend `origin/main` now points at `6c67c181`; iOS `origin/main` points at the
companion SHA in the generated release identity. Backend 4.14.216 was deployed
through staging and promoted to production. No TestFlight/App Store upload,
physical-device run, production
`.env` write, or manual `data/` mutation occurred. The enforcement flag is
unset in production, so the runtime is intentionally observe-only.

## Implemented Behavior

- Observe mode preserves legacy per-user daily caps and the system actor's
  $1/day stop while leaving new plan, monthly, and automation policy disabled.
- Enforcement mode uses canonical entitlement, UTC/billing-cycle windows,
  SQLite-serialized reservations, actual-usage settlement, stable plan/quota
  error contracts, and interactive-only Nexus Points overage.
- Coach admission and reserve units compose, provider locking excludes data
  collection, lock timeouts release cron claims, prompts retain complete
  instruction blocks, and monthly deferral notices deduplicate through reset.
- Provider fallback preserves budget/persistence errors; timeout-orphan usage is
  conservatively metered; the process latch can self-heal after a successful
  probe.
- Content inventory, engagement, and grounded-first routing are enforcement
  policy; observe mode retains production behavior. Friday output is batched.
- Channel Learning records real shared-knowledge-consumption evidence, defers
  visibly when evidence is absent, preserves fingerprint skips, and documents
  the current default-tenant limitation.
- Scheduled Autoresearch is pinned to `evaluate_only`, validates the live
  `topic_gen` contract, never writes production prompt files or performs Git
  operations, and reverts non-production apply-mode files in `finally`.
- Migration 226 normalizes fallback category suffixes, documents rollback and
  repair behavior, seeds explicit monthly limits, and adds attribution/evidence
  indexes and tables.
- iOS expires stale local quota mirrors, refreshes usage on foreground,
  decodes additive fields, maps stable REST/WebSocket errors, uses server plan
  details, parses numeric and HTTP-date retry headers safely, and presents
  daily/monthly reset-specific quota UX.

## Finding Dispositions

All P1 and P2 findings were confirmed and fixed except P2-12, which the QA
brief explicitly allowed to be closed by documenting the default-tenant
limitation. No finding was silently discarded.

| ID | Disposition | Evidence / regression test |
|---|---|---|
| P1-1 | fixed (`fa4de82e`) | `paid-ai-budget.test.ts`: observe-mode legacy user/system caps and no new-policy block |
| P1-2 | fixed (`fa4de82e`) | `paid-ai-budget.test.ts`: Tuesday Content then 21:00 Coach admission |
| P1-3 | fixed (`fa4de82e`) | `scheduler-user-scope.test.ts`, `garmin-coach-user-scope.test.ts`: provider-only lock, interleave, released claim/global copy |
| P1-4 | fixed (`fa4de82e`) | `gemini-provider.test.ts`, `provider-fallback.test.ts`: unchanged budget error, no breaker/fallback advance |
| P1-5 | fixed (`fa4de82e`) | `cost-guardrail.test.ts`: explicit enforcement state and system-source rows |
| P1-6 | fixed (iOS fix round) | full `Nexus HubTests` compiled and passed with no failures |
| P1-7 | fixed (docs closeout) | canonical release state, ledger, workspace mirrors, and this dated evidence record |
| P2-1 | fixed (`fa4de82e`) | migration + attribution tests agree on suffix normalization |
| P2-2 | fixed (`fa4de82e`) | migration 226 rollback/repair notes pin safe legacy restoration |
| P2-3 | fixed (`fa4de82e`) | `paid-ai-budget.test.ts`: entitlement lookup failure is retryable 429 `SERVICE_DEGRADED` |
| P2-4 | fixed (`fa4de82e`) | cost-guardrail fallback test gates effective `over` in observe mode |
| P2-5 | fixed (`fa4de82e`) | new `usage-routes.test.ts`: legacy enum and effective `exceeded` |
| P2-6 | fixed (`fa4de82e`) | API-usage fallback tests cover successful probe recovery and honest retry |
| P2-7 | fixed (`fa4de82e`) | `garmin-coach-user-scope.test.ts`: complete prompt block under cap and identical fallback compaction |
| P2-8 | fixed (`fa4de82e`) | scheduler test holds monthly notice through `unblocksAt` |
| P2-9 | fixed (`fa4de82e`) | paid-budget test excludes coach reserve for ineligible health/plan/skill scopes |
| P2-10 | fixed (`fa4de82e`) | timeout tests persist conservative `timeout-estimate` usage for orphan completion |
| P2-11 | fixed (`fa4de82e`) | channel/content-reference tests cover real marker and no-evidence operator deferral |
| P2-12 | fixed by documented limitation (`fa4de82e`) | `TOKEN-QUOTA-CONTRACT.md`: default-tenant evidence and cross-tenant p95 contract |
| P2-13 | fixed (`fa4de82e`) | content workflow test keeps observe mode ungrounded-first |
| P2-14 | fixed (`fa4de82e`) | scheduler tests preserve observe-mode delivery and enforce-only gating |
| P2-15 | fixed (iOS fix round) | `AppEntitlementResolverTests`: expired mirror; app foreground refresh wiring |
| P2-16 | fixed (`fa4de82e`) | new real-runner 001-to-226 rehearsal with historical rows and double apply |
| P2-17 | fixed (`fa4de82e` + iOS fix round) | denial/no-fallback, no-evidence, evaluate-only, WS frame, route flag, Points automation, founder month tests |
| P2-18 | fixed (docs closeout) | mirrors recopied from workspace truth including 4.14.215 Coach row |
| P2-19 | fixed (`fa4de82e`) | `reward-check.test.ts`: explicit example allowlist, `.env.staging`, arbitrary `*.example` |
| P3-1 | fixed (`fa4de82e`) | quota notice copy branches on `blockReason` |
| P3-2 | fixed (`fa4de82e`) | `stripe-service.test.ts`: date-safe Apple month subtraction |
| P3-3 | fixed (`fa4de82e`) | Content Engine contract tests: allowed details and clamped retry seconds |
| P3-4 | fixed (`fa4de82e`) | zero caps do not set misleading fraction over-limit flags |
| P3-5 | fixed (`fa4de82e`) | portal plan PUT uses own-property guards |
| P3-6 | fixed (`fa4de82e`) | dead guardrail/provider/script exports and wrappers removed |
| P3-7 | fixed (`fa4de82e`) | Anthropic clients set `maxRetries: 0` |
| P3-8 | fixed (`fa4de82e`) | engagement recency reads `updated_at` |
| P3-9 | fixed (`fa4de82e`) | automation priority requires exact slot category |
| P3-10 | fixed (`fa4de82e`) | Autoresearch apply mode reverts in `finally` |
| P3-11 | fixed (`fa4de82e`) | Autoresearch imports the live exported `topic_gen` validator |
| P3-12 | fixed (iOS fix round) | legacy `DAILY_LIMIT_EXCEEDED` maps to daily limit |
| P3-13 | fixed (iOS fix round) | server `details.requiredPlan` wins over fallback copy |
| P3-14 | fixed (iOS fix round) | Free-to-Pro substitution is shared by lock reason/title |
| P3-15 | fixed (iOS fix round) | HTTP-date Retry-After plus exact/clamped numeric conversion tests |
| P3-16 | fixed (docs closeout) | ledger status totals recounted after mirror reconciliation |
| P3-17 | fixed (`fa4de82e`) | routing docs qualify terminal budget failure scope |
| P3-18 | fixed (`fa4de82e`) | stale Content cron log copy corrected |
| P3-19 | fixed (`fa4de82e`) | `.env.example` documents `CONTENT_CRON_ENGAGEMENT_GATE` |
| P3-20 | fixed (`fa4de82e`) | `.env.example` documents `CHAT_ACTION_FIXER_MODEL` |
| P3-21 | deferred (owner-directed) | attribution interactive-default lint is useful but not required for this contract fix |
| P3-22 | deferred with owner sign-off | flag-off Points checkout 403 is intentionally retained per the QA brief |
| P3-23 | deferred | non-Secretary WS token-zero parity needs a separate product contract decision |
| P3-24 | deferred | OCR fallback-versus-denial ordering needs a focused attachment policy review |
| P3-25 | deferred | portal manual relearn attribution should become `automation`, pending Felipe confirmation |
| P3-26 | deferred | per-process plan-cap overrides need distributed-runtime design before scaling |
| P3-27 | deferred | conservative billing for missing search-fee substructures needs provider fixtures |
| P3-28 | deferred, risk documented | cross-tenant p95 is explicitly limited in `TOKEN-QUOTA-CONTRACT.md` |
| P3-29 | deferred | Ollama preflight ordering needs a provider-availability policy decision |
| P3-30 | deferred, risk documented | Python re-entry TOCTOU remains bounded by signed callback and outer reservation |
| P3-31 | deferred | failure-report-as-delivery needs a delivery metric schema decision |
| P3-32 | deferred | fixer JSON retry cost needs quality/cost evidence before changing retries |
| P3-33 | deferred | iOS cold-launch stale-cache disable window needs a launch UX policy decision |
| P3-34 | deferred | iOS Free-to-Secretary hardcode is outside the paid-model contract and needs product review |

## Verification Evidence

Executed on the committed feature trees and, where explicitly labeled, the
4.14.216 staging/production release path.

- Backend `npx tsc --noEmit`: passed in the normal commit gate for
  `fa4de82e`.
- Backend `npx vitest run --reporter=dot`: the complete suite passed in the
  same commit gate; exact counts are in `docs/release/CURRENT_RELEASE_STATE.md`.
- The focused paid-AI regression batch passed.
- Content Engine full and focused error-contract pytest runs passed with one
  pre-existing warning; exact counts are in the current release state.
- Migration safety passed. Real runner rehearsal:
  `paid-ai-cost-controls-migration-runner.test.ts` passed the full 001-to-226
  chain, seeded fallback/legacy/beta/NULL-tier rows, and double apply.
- iOS full unit target passed with zero failures/skips; result bundle
  `/tmp/paid-ai-ios-full-fixed-20260710-1140.xcresult`. Exact counts are in the
  current release state.
- iOS app simulator build: passed; result bundle
  `/tmp/paid-ai-ios-build-20260710-1141.xcresult`.
- Docs audit, changed-area classifier, dry-run risk gate, and Verifiable Reward
  advisory are recorded in the final docs closeout below after they run on the
  reconciled documentation tree.

### Release and publication evidence

- Authorization: Felipe requested and authorized the staging/production
  deployment and subsequent backend/iOS `main` pushes on 2026-07-10.
- `scripts/release-prep.sh --patch` minted 4.14.216 at `6c67c181`; typecheck,
  build, and the protected full Vitest gate passed with the exact counts in the
  canonical current release state. Local artifact digest:
  `13ff241c43533519cef7458ed3358ad56abb7ce6f33b5fabaafe28d36ca78d95`.
- `scripts/deploy-staging.sh` passed staging env validation, build/digest,
  SQLite integrity, native binding, content-engine/portal health, and stable
  PM2 readiness.
- `scripts/promote-to-prod.sh` passed environment parity, local/staging
  artifact parity, all staging smoke checks, and the strict production gate
  before mutation. Exact smoke, migration, and full-suite counts are kept in
  the canonical current release state. Backup including `bot.db`, owner
  bootstrap, native rebuild, health, and PM2 readiness also passed.
- Independent post-deploy reads confirmed public `/health` `status: healthy`,
  production package 4.14.216, both production PM2 apps online on 4.14.216,
  migration 226 recorded once among 236 applied migrations, and remote/local
  digest equality.
- The first backend `git push origin HEAD:main` attempt was correctly rejected
  before remote mutation because the default Python 3.14 lacked pytest. The
  retry prepended the existing project pytest environment, reran the protected
  typecheck/full Vitest/Content Engine gates, and fast-forwarded backend main
  from `bbd8205b` to `6c67c181`. No hook was bypassed.
- iOS `git push origin HEAD:main` fast-forwarded the supplied base to the exact
  companion HEAD in the generated release identity. The previously recorded
  full `Nexus HubTests` result and app simulator build cover that iOS HEAD.

## Acceptance Criteria That Require External State

The code, regression coverage, migration rehearsal, app compatibility,
production code promotion, and documentation work are complete. The following
criteria remain external-state acceptance gates and are tracked in workspace
`docs/release/OPEN_ITEMS.md`:

- Enforcement-on staging persona matrix: not run. The production flag remains
  unset, so no new paid-plan/monthly/automation denial policy was activated.
  Complete the matrix and obtain explicit owner authorization before changing
  the flag.
- Live-provider quality parity and real APNs/device proof: impossible without
  authenticated provider/device execution; TestFlight/device proof was not
  part of this source-main publication.
- Coach p95 input reduction and 30-day cost-per-consumed-artifact reduction:
  impossible before rollout plus a representative elapsed observation window.

## Verifiable Reward Summary

- Claim: **L3 staging + production-release evidence** for backend code in
  observe mode, plus source-main publication for backend and iOS. This does not
  claim enforcement-on persona coverage, live-provider quality, TestFlight,
  physical-device/APNs proof, or 30-day economics.
- Verdict: **PASS**, score **100**, area `release`.
- Evidence: full backend/iOS verification, migration rehearsal, staging smoke,
  strict production promotion, independent runtime proof, docs audit,
  classifier/risk gate, and the exact source/test disposition matrix.
- Hard failures: none.
- Mandatory checks: **PASS 5**.
- Skipped checks: none. The claim is deliberately scoped away from
  enforcement-on personas, live providers, TestFlight/devices/APNs, and the
  30-day economics window.
- Raw reward JSON remains under ignored `.local/reward-runs/` and is not
  committed or export-eligible without human review.
