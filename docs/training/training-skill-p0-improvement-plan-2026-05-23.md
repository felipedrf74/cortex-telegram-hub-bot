# Training Skill - Security Gate + Cleanup Implementation Plan

**Date**: 2026-05-23
**Branch**: `claude/cool-keller-56fedc` (worktree off `main`)
**Status**: revised after critical review. The original plan bundled true P0 security work with cleanup, deletion, linter expansion, and skill-manifest deprecation. This version splits those concerns so the security gate can land fast and safely.

## Scope

### PR 1 - P0 security gate

Land first. Keep narrow.

- Gate Garmin write/auth routes behind the Training entitlement.
- Correctly leave Garmin revoke/status paths available to downgraded users.
- Audit `/api/v1/plan/*` usage and apply the smallest safe entitlement policy. Do not blanket-gate `/plan/today` until product/iOS usage is verified.
- Add route-level security tests.

### PR 2 - Low-risk cleanup and sanitizer hardening

- Collapse duplicate cache invalidator/readiness helpers.
- Harden coach-briefing sanitizer.
- Add focused behavior tests.

### PR 3 - Training kernel module disposition

- Revisit zero-caller modules as "not integrated" rather than automatically dead.
- Prefer keep-and-wire, keep-and-document, or explicit defer over deletion.
- Delete only with matching docs/open-item cleanup and reviewer agreement that the capability is intentionally removed.

### PR 4 - Skill manifest deprecation, if still desired

- Treat manifest removal as an architecture deprecation project, not a P0 cleanup.
- First prove runtime/test/doc contracts no longer require the manifests.

### Separate follow-up - Coach-rules linter enforcement

- Add uncovered coach-rules to the linter in warning-only mode.
- Run a false-positive/red-team pass before promoting any new finding to blocker.

## Evidence and surrounding context

- Most recent full audit: `docs/training/training-skill-full-audit-20260522.md`
- Coaching quality QA (2026-05-13): `docs/release/training-coaching-quality-claude-qa.md`
- Engine open items: `docs/training/training-engine-open-items.md`
- Codex open items: `docs/training/codex-training-open-items.md`
- Current router mounts:
  - `src/api/router.ts:276` gates `/training` with `requireEntitlement({ skill: 'training' })`.
  - `src/api/router.ts:283` mounts `/garmin` without entitlement middleware.
  - `src/api/router.ts:325` mounts `/plan` without entitlement middleware.

## Critical revisions from review

1. Entitlement/security work must come before cleanup. If A1/A2 are P0, land them first.
2. `/api/v1/plan/today` is cross-domain and may power Home/daily-planning flows. Do not block it for free users until iOS usage and product intent are confirmed.
3. Garmin disconnect is `DELETE /api/v1/garmin/disconnect`, not POST.
4. Zero production callers do not automatically mean safe deletion when modules have dedicated tests, docs, and documented future wiring.
5. `src/skills/*/manifest.json` files are referenced by real architecture/package tests. Manifest deletion is not safe as currently claimed.
6. Coach-rule linter enforcement is useful but not part of a one-day P0 sweep.

## Track A - Add missing entitlement gates

### A0. Build a route entitlement matrix before coding

Create or update the PR description with a matrix like:

| Route | Free user | Training-entitled user | Notes |
|---|---:|---:|---|
| `POST /api/v1/garmin/login` | 403 | Existing behavior | No real OAuth in tests |
| `POST /api/v1/garmin/verify` | 403 | Existing behavior | Mock verification |
| `POST /api/v1/garmin/reauth` | 403 | Existing behavior | Cover credentials and no-credentials branches if possible |
| `GET /api/v1/garmin/status` | 200 | 200 | Decide whether email remains visible to downgraded users |
| `DELETE /api/v1/garmin/disconnect` | 200 | 200 | Revoke must remain available |
| `POST /api/v1/plan/recompute` | 403 or filtered no-op | Existing behavior | Recommended immediate gate |
| `GET /api/v1/plan/week` | TBD | Existing behavior | Gate if training-specific |
| `GET /api/v1/plan/week/explain` | Existing max/owner gate or training gate | Existing behavior | Preserve stricter rule if still required |
| `GET /api/v1/plan/today` | 200 degraded/filter preferred | Existing behavior | Audit iOS/Home usage first |

### A1. `/api/v1/garmin/*` - gate the write/auth surface

`src/api/router.ts:283` mounts `garminAuthRoutes()` with no `requireEntitlement` middleware. The parallel `/training` mount at `src/api/router.ts:276` does gate. A free-tier user can initiate Garmin login and persist tokens even though the Training feature is not accessible.

**Approach**:

- Add route-level `requireEntitlement({ skill: 'training' })` inside `src/api/routes/garmin-auth.ts` for:
  - `POST /login`
  - `POST /verify`
  - `POST /reauth`
- Leave open:
  - `GET /status`
  - `DELETE /disconnect`
- Do not mount the entire `/garmin` router behind entitlement unless the open revoke/status paths are re-mounted separately.
- Decide explicitly whether `GET /status` may continue returning Garmin email to downgraded users. It is the user's own data, but the behavior should be documented.

**Tests**:

- Free-tier JWT against `POST /api/v1/garmin/login` returns `403` with error code `TIER_REQUIRED`.
- Free-tier JWT against `POST /api/v1/garmin/verify` returns `403` with error code `TIER_REQUIRED`.
- Free-tier JWT against `POST /api/v1/garmin/reauth` returns `403` with error code `TIER_REQUIRED`.
- Entitled user requests still reach the existing Garmin handlers.
- `GET /api/v1/garmin/status` and `DELETE /api/v1/garmin/disconnect` remain available to free-tier users.
- No test performs real OAuth login, real verification, or real disconnect against a provider.

**Recommended test placement**:

- Prefer a dedicated `__tests__/security/garmin-routes-entitlement.test.ts` if the setup needs Garmin-specific mocks.
- Reuse `__tests__/security/training-routes-entitlement.test.ts` only if it stays simple and readable.

### A2. `/api/v1/plan/*` - do not blanket-gate until usage is verified

`src/api/router.ts:325` mounts `planRoutes()` with no entitlement gate. `src/api/routes/plan.ts` exposes:

- `GET /week`
- `GET /today`
- `POST /recompute`
- `GET /week/explain`

The original plan recommended gating the whole router behind Training entitlement. That may be product-damaging because `/plan/today` composes a daily brief and may be used by Home or non-training planning surfaces.

**Recommended approach for PR 1**:

1. Audit iOS/backend callers for `/api/v1/plan/today`, `/plan/week`, and `/plan/recompute`.
2. Gate `POST /api/v1/plan/recompute` behind Training entitlement unless the route is proven cross-skill and safe to degrade.
3. Gate `GET /api/v1/plan/week` only if its response is training-specific in current production.
4. Preserve or tighten `GET /api/v1/plan/week/explain` without weakening the existing `max`/`owner` behavior.
5. Prefer keeping `GET /api/v1/plan/today` available for free users with training sections filtered/omitted. If filtering is too large for PR 1, leave `/today` unchanged and document the follow-up instead of blanket-blocking it.

**Acceptance**:

- Tests cover free and entitled behavior for each changed `/plan` route.
- If `/today` remains open, tests assert that unpaid users do not receive paid Training-only blocks.
- If `/today` is gated, the PR must include explicit product/iOS confirmation and a UX check for the free-tier Home/daily-plan screen.
- Entitled users continue to receive the pre-existing response shape.

## Track B - Symbol deduplication

### B1. Collapse `invalidateTrainingDerivedCaches`

Two definitions today:

- `src/services/training-cache-invalidator.ts`
- `src/services/cache-coherence-registry.ts`

Importers are split between the registry implementation and the shim.

**Approach**:

- Keep `cache-coherence-registry.ts` as the source of truth.
- Either delete `training-cache-invalidator.ts` after updating all importers, or make it a pure re-export with no cache logic.
- Update production importers to use the registry directly unless a compatibility re-export is intentionally kept.

**Acceptance**:

- No duplicate cache invalidation logic remains.
- Production importers resolve to one implementation.
- Tests that import the shim are either updated or intentionally kept as compatibility tests.
- Avoid brittle acceptance based only on `grep "^export function"`, because a re-export can hide duplicate API surface without duplicate logic.

### B2. Collapse `scoreToReadinessLevel`

Two definitions today:

- `src/services/training-coach-kernel-plan-generator.ts`
- `src/services/coach-kernel/readiness-snapshot-adapter.ts`

The adapter version handles non-finite scores. The plan generator currently clamps non-finite inputs before calling its private copy, so dedupe must preserve input-level behavior.

**Approach**:

- Import the adapter export into the plan generator.
- Delete the private copy.
- Confirm current generator behavior for `NaN`, `Infinity`, low/medium/high boundary values, and missing readiness.

**Acceptance**:

- Exactly one implementation remains.
- Add or extend tests at the generator input level, not only the adapter helper level.
- Existing readiness snapshot adapter tests continue to pass.

## Track C - Sanitizer hardening

### C1. Anchorless debug-marker filter in coach report

`src/api/routes/training-coach-briefing.ts` filters debug/provider markers too narrowly. Mid-line markers can leak through.

**Approach**:

- Strip embedded debug tokens such as `[DEBUG]`, `[TRACE]`, `[VERBOSE]`, `[INFO]`, `[WARN]`, and `[ERROR]` when the surrounding sentence is useful.
- Drop provider-only or raw-infrastructure lines instead of turning them into confusing user-facing fragments.
- Extend provider-error detection to catch mid-line provider/HTTP failures.
- Keep the final output human-readable and coaching-safe.

**Acceptance**:

- Tests in `__tests__/api/training-coach-briefing.test.ts` cover:
  - useful line with embedded `[DEBUG]` token is preserved with token removed;
  - provider-only `Garmin: timeout` style line is dropped;
  - embedded `HTTP 503` does not leak;
  - existing safe coaching text remains intact.

## Track D - Module disposition, not blind dead-code deletion

### D1. `src/services/coach-kernel/safety-guardrails.ts`

The file may have zero production callers, but it has dedicated tests and training docs that describe it as planned safety capability. Treat it as "not integrated" unless evidence proves it is obsolete.

**Recommended approach**:

- Do not delete in PR 1 or PR 2.
- Choose one in PR 3:
  - keep and export/document its intended integration point;
  - wire a minimal read-only path into the coach briefing/read model if low risk;
  - explicitly defer with an open item and keep tests;
  - delete only if docs, tests, and product intent all agree the capability is removed.

**Acceptance if kept**:

- `coach-kernel/index.ts` exports it or a doc/open-item explains why it remains internal.
- Tests remain meaningful.
- Docs no longer imply a runtime guarantee that does not exist.

**Acceptance if deleted**:

- Matching tests/docs/open-items are updated with a clear closure note.
- A reviewer agrees the safety capability is intentionally removed, not merely unwired.

### D2. `src/services/coach-kernel/athlete-lifecycle-state.ts`

Same disposition as D1. It appears to represent planned derived state, not disposable dead code.

**Recommended approach**:

- Do not delete as part of the P0 gate.
- In PR 3, either wire it, document the deferred integration, or remove it with matching docs/tests cleanup.

### D3. `src/services/coach-kernel/adaptation-engine.ts`

Exactly one production caller is not enough reason to inline/delete a domain module. Training adaptation logic benefits from a dedicated module and focused tests.

**Recommended approach**:

- Keep the module by default.
- Export it from `coach-kernel/index.ts` if that matches local patterns.
- Add a short comment or doc note explaining the role split versus `poor-recovery-variation.ts`.
- Inline/delete only if implementation review proves it is truly duplicate logic with no independent domain responsibility.

**Acceptance**:

- Either the module is kept and its role is documented, or deletion comes with test/doc updates and a clear rationale.
- No route-layer file absorbs complex training adaptation rules merely to reduce file count.

### D4. Wire `coach-rules.ts` into plan-linter as enforcement

This is valuable, but it is not part of the P0 sweep. It adds new behavior and can block live plan generation if false positives are promoted too quickly.

**Follow-up approach**:

- Add uncovered coach-rules as warning-only findings first.
- Add dedicated tests for each new rule.
- Run a red-team corpus pass against recent training plans.
- Define a false-positive budget before promoting any warning to blocker.
- Do not mark the QA item closed until staging confirms no blocker wave on existing users.

### D5. Skill manifests and dead prompt fixtures

The original claim that real manifests are only referenced by temp-dir tests is incomplete. Real manifests/prompt fixtures are used by architecture/package/prompt-cleanliness tests. Treat this as deprecation, not deletion.

**Follow-up approach**:

1. Run `rg "loadManifest|manifest.json|prompts/system.md" src __tests__ docs`.
2. Classify each reference as runtime, package contract, security/prompt cleanliness, or obsolete test fixture.
3. If runtime has moved fully to `skill-config.ts`, update package tests to validate that config directly.
4. Add a short deprecation note or ADR explaining why manifests are no longer the source of truth.
5. Delete manifests only after tests/docs no longer assert their existence.

**Acceptance**:

- No real manifest/prompt deletion in the P0 gate PR.
- If a later PR deletes them, `npx tsc --noEmit`, relevant skill tests, prompt-cleanliness tests, and `npm run docs:audit` all pass.

## Revised decisions

1. **A1 Garmin**: gate only write/auth paths; keep `GET /status` and `DELETE /disconnect` open.
2. **A2 Plan**: do not blanket-gate `/plan`. Audit usage first. Gate or filter route by route.
3. **D1/D2**: do not delete in the P0 sweep. Reclassify as not-integrated capability modules pending PR 3 disposition.
4. **D3**: keep by default and document/export unless deeper review proves duplication.
5. **D4**: separate warning-only linter PR.
6. **D5**: separate manifest-deprecation PR.

## Revised order of implementation

1. Record baseline repo state and current test floor.
2. Implement PR 1:
   - A0 route matrix.
   - A1 Garmin entitlement gate.
   - A2 `/plan` route audit and smallest safe gate/filter change.
   - Route-level tests.
3. Run focused backend verification and staging smoke.
4. Implement PR 2:
   - B1 cache invalidator dedupe.
   - B2 readiness helper dedupe.
   - C1 sanitizer hardening.
5. Implement PR 3 only after review:
   - D1/D2/D3 keep/wire/defer/delete decisions with docs/tests.
6. Implement PR 4 only if still desired:
   - D5 manifest deprecation.
7. Implement D4 as its own warning-only linter improvement.

## Risks and rollback

- Track A is user-visible. Rollback is reverting the route gate/filter change. Verify iOS Home, Training, and any daily-plan screens before staging promote.
- `/plan/today` is the highest product-risk endpoint. Do not gate without UX confirmation.
- Garmin auth gates are lower product risk because free users should not create paid Training integrations, but revoke/status must remain available.
- Track B/C should be behavior-preserving except sanitizer output. Rollback is straightforward.
- Track D deletion is high review risk despite low current runtime usage because tests/docs indicate planned capability.
- D4 can create false-positive blockers. Keep warning-only first.
- D5 can break package/security tests. Split it.

## Validation gate

Before promote-to-prod for PR 1:

- `npx tsc --noEmit`
- Focused entitlement/security tests for Garmin and Plan.
- Existing training route entitlement tests.
- `npm run docs:audit` if docs are changed.
- `./scripts/deploy-staging.sh`
- `./scripts/staging-smoke.sh`

Manual checks for PR 1:

- Free-tier JWT:
  - `POST /api/v1/garmin/login` -> `403` with error code `TIER_REQUIRED`
  - `POST /api/v1/garmin/verify` -> `403` with error code `TIER_REQUIRED`
  - `POST /api/v1/garmin/reauth` -> `403` with error code `TIER_REQUIRED`
  - `GET /api/v1/garmin/status` -> 200
  - `DELETE /api/v1/garmin/disconnect` -> 200
- Training-entitled JWT:
  - Garmin login/verify/reauth reach existing handler behavior.
  - Changed `/plan` endpoints preserve response shape.
- iOS:
  - Training tab remains unchanged for entitled user.
  - Home/daily-plan surfaces do not regress for free or downgraded users.

Before promote-to-prod for PR 2:

- `npx tsc --noEmit`
- Focused tests for cache invalidation, readiness conversion, and coach-briefing sanitizer.
- `npx vitest run` at or above current passing floor.

Before deleting or deprecating anything in PR 3/PR 4:

- Prove no runtime caller, no test contract, and no docs/open-item dependency remains.
- Update docs/open items in the same PR.
- Include reviewer-facing rationale for each removed module/file.
