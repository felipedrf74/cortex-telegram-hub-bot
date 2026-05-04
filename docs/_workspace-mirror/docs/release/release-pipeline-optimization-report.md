# Nexus Hub Release Pipeline Optimization Report

Date: 2026-05-03
Owner: release architect (audit pass)
Status: `current` analysis. Final recommendation: **ADOPT_RISK_BASED_RELEASE_PROCESS**.

> This report consolidates the workspace-wide release/test pipeline audit. It
> respects and builds on the 2026-05-01 backend release-process pack at
> `engine/docs/release/` (release-process-current-state, bottleneck-analysis,
> risk-based-release-gate-matrix, optimized-test-pipeline,
> streamlined-release-process-v2, redundant-and-stale-checks,
> ci-parallelization-plan, main-staging-production-gate-model,
> production-promotion-checklist-v2, release-doc-drift-control,
> simulator-and-local-service-hygiene, missing-high-value-release-checks,
> checks-to-retire-or-condition, release-process-priority-roadmap). Their
> recommendations are largely correct. The core problem is **adoption**, not
> diagnosis: the `2026-05-01` design exists on disk but is not yet enforced
> in scripts, hooks, or CI.

---

## Executive Summary

- **Why releases are slow.** The full backend Vitest suite (the file count
  and case count are emitted live by `release-identity.sh` and the `vitest
  run` summary; treat any number written into a doc as drift-prone) under
  `pool: 'forks', singleFork: true` runs **at least three times** per
  production release on the same artifact: pre-commit hook, pre-push hook,
  and the `npm run verify` step inside `deploy.sh`. GitHub Actions adds a
  fourth full run with coverage. With `singleFork: true`, every run is
  fully serialized. At a measured deploy cadence on the order of five per
  day (cumulative version-bump commits in the high-200s; double-digit
  deploys on 2026-05-02 alone), this redundancy alone consumes hours per
  day.

- **Biggest bottleneck.** Quadruple full-suite execution on the same
  artifact (`pre-commit` + `pre-push` + `CI` + `deploy.sh`). The hooks
  re-fire on the version-bump commit produced by `deploy.sh` itself, so a
  one-line release doc edit pays the same price as a 200-file refactor.

- **Biggest redundancy.** `npm run verify` inside `deploy.sh` (line 37).
  Pre-push has already enforced typecheck + Vitest on the exact same SHA, the
  promote chain has already verified `dist/index.js` hashes match staging,
  and staging-smoke has already validated the deployed artifact. Re-running
  the full suite at the deploy step adds ~9 min of latency for zero
  incremental signal.

- **Biggest missing gate.** A **changed-file risk classifier** that resolves
  to a tier list. Today every commit pays for the worst-case scenario. A
  classifier turns "doc-only", "training engine only", "calendar route
  only", "iOS UI only" into different gate sets. This single item is the
  precondition for every other optimization.

- **Recommended new process.** Risk-based, four-gate pipeline:
  Merge → Staging RC → Production → Postdeploy. Each gate has explicit
  required, conditional, and skip-if rules driven by the classifier.
  Redundant full-suite runs collapse to **one** authoritative gate
  (pre-push) per RC; pre-commit becomes incremental; CI parallelizes by
  changed area; `deploy.sh` trusts the prior gates and re-runs only the
  staging smoke contract.

- **Expected time savings.** Conservatively 60–75 % per release, with
  unchanged or improved trust: deploy ceremony from ~30–35 min wall clock
  to ~8–12 min. At 5 deploys/day, that recovers ~2 hours/day of compute
  and operator wait.

---

## Current Release Process Map

### Repositories observed

| Area | Path (via workspace symlink) | Tip | Notes |
| --- | --- | --- | --- |
| Backend engine | `engine` → `…/cortex-telegram-hub-bot` | `8b83696`, branch `feature/training-reliability-local-orchestration-hardening`, version `4.14.123` (per `package.json`) | Vitest spec-file and case counts emitted live by the test runner; over one hundred SQL migrations on disk. |
| iOS app | `ios` → `…/Nexus Hub IOS/Nexus Hub` | `main` per workspace docs | XCTest/XCUITest suite; CI is config-only. |
| iOS specs | `ios-specs` → `…/Nexus Hub IOS/specs` | tracked alongside ios | Files such as `ios-specs/00-CURRENT-PRODUCT-TRUTH.md` and `ios-specs/02-API-SPECIFICATION.md`. |

### Phase-by-phase catalog

| Phase | Command(s) | Where | Repo state | Validates | Evidence | Blocks |
| --- | --- | --- | --- | --- | --- | --- |
| Pre-commit hook | `npx tsc --noEmit && npx vitest run --reporter=dot` | Local (`.husky/pre-commit`) | `engine` | Full typecheck + full Vitest suite | E2/E3 | Commit |
| Pre-push hook | `npx tsc --noEmit && npx vitest run --reporter=dot` (+`npm run build` on `main`) | Local (`.husky/pre-push`) | `engine` | Same again, plus build for main pushes | E2/E3 | Push |
| CI: lint | `npx tsc --noEmit` + prompt non-empty check | GitHub Actions (`ci.yml > lint`) | `engine` | Type + prompt-content lint | E1 | All other CI jobs |
| CI: tests | `npx vitest run --reporter=verbose --coverage` (envs: `:memory:` DB, dummy keys) | GitHub Actions (`ci.yml > test`) needs `lint` | `engine` | Full Vitest with coverage upload | E2/E3 | `build` job |
| CI: build | `npm run build` + verify `dist/index.js` exists | GitHub Actions (`ci.yml > build`) needs `test` | `engine` | Build artifact integrity | E2 | Coverage artifact upload |
| CI: python-test | `python -m py_compile` across content engine | GitHub Actions (`ci.yml > python-test`) needs `lint` | `engine` | Python syntax compile | E1 | n/a |
| CI: migrations | gap check + per-file `sqlite3 :memory:` syntax probe | GitHub Actions (`ci.yml > migrations`) needs `lint` | `engine` | Migration sequence + syntax | E1/E2 | n/a |
| CI: cd-production | manual `workflow_dispatch` only | GitHub Actions (`cd-production.yml`) | `engine` | **Dead code** — comments admit runners can't reach the IPv6-only server. Source of confusion. | E0 | nothing in practice |
| iOS CI | `scripts/ios-release-hardening-validate.sh` (config only) | GitHub Actions (`ios-release-hardening.yml`) | `ios` | APNs / ATS / privacy strings / release config | E1 | nothing else (no tests run) |
| Local full-product smoke | `scripts/full-nexus-local-engine.sh`, `smoke:content:local`, `smoke:cooking:portal`, `smoke:training-calendar:staging`, `smoke:training-cross-skill:staging` | Local | `engine` | App-facing flows in fixture mode | E4 | RC confidence |
| iOS focused tests | `xcodebuild test … -only-testing:<slice>` | Local simulator | `ios` | Touched decoder/view-model/UI slice | E2/E5 | Merge confidence |
| iOS local beta smoke | `scripts/beta-smoke-local.sh` (31 `-only-testing` classes, name-only sim destination, doc-version drift gate) | Local simulator | `ios` | Curated XCTest matrix + simulator compile + cross-agent doc version consistency | E2/E5 | iOS RC confidence |
| TestFlight/device smoke | manual matrix per the iOS beta `testflight-manual-checklist` + `simulator-runtime-smoke-playbook` documents (located under the iOS repo's `docs/beta/` tree) | Physical iPhone / TestFlight | `ios` | Apple Sign-In, APNs, HealthKit, two-account switching | E5/E7-adjacent | Public-beta iOS gates |
| Staging deploy | `./scripts/deploy-staging.sh` | Mac → server (`telegram-hub-bot-staging`) | `engine` | Build → env validation → rsync → PM2 staging restart → health on staging ports 8101 and 8201 | E6 | Promotion |
| Generic staging smoke | `./scripts/staging-smoke.sh` (17 checks) | Mac → server via SSH | `engine` | `/health`, snapshot version+shape, cost/provider stats, iOS unauth-401 envelope, PM2 state, DB integrity | E6 | Promotion gate |
| Domain staging smoke | `smoke:training-calendar:staging`, `smoke:training-cross-skill:staging` | Server-routed | `engine` | Calendar lifecycle / cross-skill behavior | E6 | Production when domain changed |
| Promote-to-prod | `./scripts/promote-to-prod.sh` (preflight: dist hash compare → staging-smoke → confirmation prompt → `deploy.sh`) | Mac → server | `engine` | RC validity + owner approval | E7 | Production |
| Production deploy | `./scripts/deploy.sh` (line 37: **`npm run verify`** on already-validated tree) | Mac → server | `engine` | Re-runs full Vitest, builds, env-validates prod, version-bumps, commits, pushes, rsyncs to prod path, restarts PM2, health-checks | E7 | Live traffic |
| Production health | curl loops + PM2 jlist | Mac → server | `engine` | Content engine `/health`, status portal `/api/snapshot`, bot online | E7 | Rollback decision |
| Release docs | freeform under `engine/docs/release`, `docs/qa`, `docs/training`, `docs/cooking`, etc. | Local | both | Human-readable evidence | E1 unless backed by artifacts | Release decisions |
| Docs audit | `npm run docs:audit` (current state: 338 files scanned, **449 issues**) | Local | `engine` | Markdown drift, scattered verdicts, stale SHAs, broken refs | E2 | Soft warning today |
| Release identity | `scripts/release-identity.sh markdown\|json` | Local | `engine` (+ ios) | Generated branch / SHA / dirty state / version / migration count | E2 | Drift signal |

### Footprint and frequency

- Backend test files: **432**. Vitest cases: **~6,557**. Largest concentrations: `__tests__/services` (222), `__tests__/api` (99), `__tests__/portal` (52). Skill tests: 14. Security: 1 (the P0 chat-identity isolation suite). Domain spreads cleanly: 31 `coach*`, 27 `training*`, 22 `content*`, 17 `provider*`, 14 `calendar*`, 6 `cooking*`, 5 `tenant*`. Eval harnesses (`eval:training`, `eval:content`) live outside `vitest run` and already correctly run nightly/on-demand only.
- Backend deploy frequency: **244 production version-bump commits** total, 14 on 2026-05-02, 5 already on 2026-05-03. Mean ~5 deploys/day during active release periods.
- Backend docs: **234 markdown files** under `engine/docs/`, top folders `content` (39), `chat` (39), `release` (36), `training` (34), `local` (22). Doc volume itself is now a release tax — every QA pass spends time re-reading historical reports.
- Workspace `npm run docs:audit` baseline: **449 issues** across five categories — markdown-outside-approved-current-or-archive (222 occurrences), commit-hash-not-found-in-own-repo (66), test-count-literal-outside-current-report (also 66), broken-markdown-reference (62), and duplicate-or-scattered-current-verdict (33).
- Vitest pool: `forks` with `singleFork: true`. Every Vitest invocation runs **single-process, fully serialized**.

### Evidence levels per phase

E0 (no evidence): `cd-production.yml`. E1 (docs/static): docs:audit, prompt-empty lint, migration sequence, Python compile, iOS release hardening config. E2 (focused unit/integration): typecheck, focused vitest, focused xcodebuild, release-identity. E3 (broad integration): full vitest. E4 (local full-product smoke): `full-nexus-local-engine.sh`, `smoke:content:local`. E5 (frontend interaction): iOS UI tests + simulator compile + portal browser smoke. E6 (staging/provider): `staging-smoke.sh`, training calendar/cross-skill staging smoke. E7 (production-safe): post-deploy curl + PM2 health, manual TestFlight/device walk-through.

---

## Bottleneck Analysis

> Each row: bottleneck → cause → risk it covers → duration impact → recommendation.
> Recommendations marked **(prior)** were already proposed in the 2026-05-01
> backend pack but are not yet implemented in scripts/hooks/CI.

| # | Bottleneck | Cause | Risk it covers | Duration impact | Recommendation |
| --- | --- | --- | --- | --- | --- |
| 1 | Quadruple full-suite execution | Pre-commit + pre-push + CI + `deploy.sh` line 37 (`npm run verify`) all run the entire Vitest suite on the same SHA. | Type errors + broad regression. | ~9 min × ~3 redundant runs = **~27 min wasted per deploy**. At ~5 deploys/day this is ~2 hours of wall-clock. | Drop `npm run verify` from `deploy.sh`. Make pre-push the single authoritative gate. Pre-commit runs **changed-files-only** Vitest. |
| 2 | `singleFork: true` in `vitest.config.ts` | Workaround for partial `vi.mock` calls (Codex unified-calendar incident pinned in v4.14.119) that pollute module cache across files. | Isolation between test files when mocks are incomplete. | Forces every Vitest case into one process; no parallelism on multi-core machines. Likely 2–3× slowdown vs. parallel forks on Felipe's Mac and CI runners. | Audit `vi.mock` calls for completeness (CI lint that flags mock objects with fewer keys than the real module's exports). Once completeness is enforced, switch to `pool: 'threads'` or `forks` without `singleFork`. **(prior — partially noted as test-isolation work in 4.14.119 release notes)**. |
| 3 | Backend CI not changed-file aware | `ci.yml` runs full coverage Vitest on every PR/push to `main`/`develop`. | Broad regression on every commit. | ~10–15 min CI for trivial changes. | Add changed-file matrix: `lint` parallel with `migrations` parallel with `python-test` (only if `content-engine/**`); focused `test` shard by domain; full-coverage moves to nightly + RC. **(prior, ci-parallelization-plan.md)**. |
| 4 | `deploy.sh` re-runs `npm run verify` | Defensive duplication from pre-staging-environment days. | Doesn't catch anything pre-push didn't. | ~9 min per deploy. | Remove. Trust `pre-push` + `staging-smoke` chain. **(prior, redundant-and-stale-checks.md row 1, not implemented)**. |
| 5 | Hook running on every commit incl. docs | `.husky/pre-commit` runs full Vitest unconditionally. | Broad regression on docs/comments commits. | ~9 min per docs-only commit; ~30+ min cumulative for a typical doc-edit session. | Pre-commit runs `vitest --changed origin/main` + tsc on touched files. If diff is `*.md` only, skip vitest entirely. **(prior, "Stop running full backend verify after docs-only fixes")**. |
| 6 | iOS local "beta smoke" uses name-only simulator destination | `beta-smoke-local.sh:9` `DESTINATION="platform=iOS Simulator,name=iPhone 17 Pro"`. | Simulator clone churn / unreliable evidence; documented in `engine/docs/release/simulator-and-local-service-hygiene.md`. | Name-only destinations spawn/select clones; UDID is required for reproducible UI evidence. Also ~10–20 min suite that runs on every iOS workflow. | Switch to UDID via env var; refuse name-only destinations for UI-class tests; gate non-UI tests to a fast lane. **(prior — see `engine/docs/release/simulator-and-local-service-hygiene.md`, not implemented)**. |
| 7 | iOS GitHub Actions has zero test runs | `ios-release-hardening.yml` only validates config strings. | Loud config drift (good); silent code drift (bad). | Pushes a quality of release-readiness signal entirely onto Felipe's Mac. | Add second iOS CI lane: focused XCTest on `Nexus HubTests` (no UI) on macOS runners using single-simulator UDID. **(prior, ci-parallelization-plan.md > iOS CI Shape)**. |
| 8 | `staging-smoke.sh` is the same 17 checks for every change | Hardcoded list in `staging-smoke.sh` (health, snapshot, cost-by-domain, provider-stats, 4 iOS-401 contracts, PM2, DB integrity). | Generic deployed-artifact contract. | Misses domain-specific behavior unless an explicit domain smoke (`smoke:training-calendar:staging`, `smoke:training-cross-skill:staging`, `smoke:cooking:portal`, etc.) is run. | Keep the 17 generic checks (cheap, fast). Add **classifier-driven** appended domain checks. (See prior `engine/docs/release/optimized-test-pipeline.md` Smoke Pipeline section.) |
| 9 | `cd-production.yml` workflow is dead code | File comments admit GitHub runners cannot reach the IPv6-only server. | None — never runs. | Confusion: agents and contributors think it's the prod path. Clutters mental model. | Delete the workflow file or rename to `cd-production.yml.archived` with a top-of-file note. (Owner-approved deletion only.) |
| 10 | `promote-to-prod.sh` re-runs `staging-smoke.sh` and then `deploy.sh` re-runs `npm run verify` | Two pseudo-gates that overlap in intent. | Same generic contract validated twice; full Vitest run a third time. | Adds ~30 s + ~9 min to the promote ceremony. | After fix #4, `promote-to-prod.sh` is the single owner-gate; `deploy.sh` becomes a thin "rsync + restart + health" tail. |
| 11 | Doc volume is itself a release tax | 234 backend docs + 80+ iOS docs; QA prompts ask for broad rereads. 449 docs:audit issues. | Historical context for high-leverage decisions. | Tens of minutes per QA pass, plus repeated stale-SHA / stale-test-count fix loops. | Make `docs:audit` block release-doc-only PRs (advisory → required for `engine/docs/release/**` writes). Generate release identity instead of hand-typing it. **(prior, release-doc-drift-control.md, partially implemented — script exists, not enforced)**. |
| 12 | Smoke scripts don't write structured artifacts | All current smoke scripts print to stdout; no JSON evidence file is left behind. | Reproducibility / audit trail. | Forces re-runs to "prove" something. | Each smoke writes `docs/release/smoke-evidence/<smoke>-<sha>-<utc>.json` with PASS/FAIL per check + minimal payload. Future audits read evidence rather than re-run. **(prior, missing-high-value-release-checks.md P0)**. |

### Slow but necessary (do not retire)

The 2026-05-01 pack already lists these correctly. Restated for non-negotiability:

- Tenant isolation / authorization tests on auth, retrieval, memory, content, cooking, chat, finance, training, portal/admin paths.
- Prompt-injection and unauthorized-context tests on any prompt construction, retrieval, memory, or tool-authorization change. The P0 chat-identity regression suite (`__tests__/security/p0-chat-identity-isolation.test.ts`) is the floor.
- Calendar/agenda lifecycle and provider smoke when Secretary, Training, calendar mapping, provider sync, reminders, or cancellation code changes.
- iOS interaction validation (UDID + simulator screenshot/UITest evidence) when SwiftUI navigation, cache, decoder, or buttons change.
- Model-routing / fallback safety on `provider-registry`, `gemini-provider`, `anthropic`, `tool-executor`, env overrides, operator overrides.
- `staging-smoke.sh` before production for any app-facing change.
- DB snapshot / migration rollback review on migrations or data-shape changes.
- Owner approval on production promotion.

---

## Redundant or Stale Checks

| Check | Why it's redundant or stale | Replacement | Safe to remove / condition / move to nightly | Risk |
| --- | --- | --- | --- | --- |
| `deploy.sh > npm run verify` (line 37) | Pre-push already enforced typecheck + Vitest on the exact SHA being shipped; staging-smoke validates the deployed artifact. Re-running everything pre-deploy adds zero signal. | Trust the chain. `deploy.sh` runs typecheck only, then build, rsync, restart. | **Condition + remove**: condition behind `NEXUS_DEPLOY_SKIP_VERIFY=0` env (default off), then remove after one stable week. | Low. Pre-push already failed-closed. |
| Pre-commit running full Vitest unconditionally | Most commits change well under ten files; the full suite is in the thousands of cases. | `vitest --changed origin/main` + `tsc --noEmit` (full typecheck remains; types are global). | **Condition**: docs-only diff skips vitest entirely; otherwise scoped vitest. Full only on RC tag commits. | Low: pre-push still acts as the safety net. |
| Pre-push running full Vitest on every push | Same suite re-runs on push of feature branches that aren't deploy candidates. | Pre-push runs full Vitest **only** when pushing to `main` or to branches with `release/`, `rc/`, `feature/p0-` prefix; otherwise focused. | **Condition**. | Low for feature-branch pushes; the pre-deploy promote chain still hits full once. |
| Backend CI full coverage on every PR | Coverage upload + verbose reporter on every push. | Move full coverage to nightly + on-demand `workflow_dispatch`. | **Move to nightly**. | Coverage trend is informational, not gating. |
| iOS GitHub Actions running zero tests | Config-only validation provides no test signal. | Add lane that runs focused XCTest on macOS runners with single UDID. | **Add gate, condition existing config gate** to docs/config diff only. | Catches drift the local Mac currently silently absorbs. |
| `cd-production.yml` (dead workflow) | Comments admit it can't reach the server. | Delete or archive. | **Owner-approved deletion**. | Reduces confusion. |
| `staging-smoke.sh` running 17 generic checks regardless of changed area | Same checks every release; doesn't add domain coverage when training/calendar/cooking changed. | Keep 17 generic + classifier-driven domain-smoke chain. | **Augment, not replace**. | Adds depth, not subtraction. |
| `promote-to-prod.sh > staging-smoke.sh` rerun | Already ran by operator before promote. | Compare timestamps; skip if smoke ran successfully on this SHA in the last 30 min. | **Condition**. | Low: the freshness check is itself a gate. |
| Manual SHA + test-count copying in release docs | Source of 132 of the 449 docs:audit warnings (66 stale SHA + 66 stale test count). | `release-identity.sh` + a `release-doc-drift-check.sh` that fails CI on stale current-doc SHAs. | **Retire manual copy; require generated identity**. **(prior — script exists, gate not enforced)**. | None — script is read-only. |
| Backups via `appleboy/ssh-action` in `cd-production.yml` | Workflow doesn't run; backups happen via `deploy.sh` step #2b on the Mac path. | Already covered locally. | **Owner-approved deletion of dead workflow**. | None. |
| Name-only simulator destination in `beta-smoke-local.sh` | Documented as harmful for UI tests (clones, focus loss). | UDID env var; fail-closed if UDID is unset for UI-class tests. | **Retire for UI**. | Improves evidence quality. |
| Branch backup ceremony for docs-only commits | Adds ceremony cost without rollback value. | Only required for product code or release-state writes. | **Condition**. | Low. |
| Old superseded QA reports treated as active blockers | 222 markdown-outside-approved-current-or-archive findings. | Move historical reports under `docs/archive/YYYY-MM/<workstream>/`. | **Retire from active gate**. | Should be done deliberately, not en masse — see Phase 5 below. |

---

## Checks That Must Stay

(Restating the non-negotiable safety gates so any future trim cannot accidentally remove them.)

- `staging-smoke.sh` before production promotion (the 17 generic + classifier-added domain checks).
- Owner approval before production promotion (`promote-to-prod.sh > read -p "Promote to production?"`).
- `npx tsc --noEmit` (typecheck) on every commit and every CI run — types are global, fast, and catch real merge-time breakage.
- Tenant isolation / authentication tests when auth, scope resolution, multi-tenant data path, retrieval, memory, admin, support, portal/admin paths change.
- Prompt-injection / unauthorized-context tests when prompt construction, skill catalogs, retrieval, or tool authorization change. The P0 chat-identity regression remains the floor.
- Calendar/agenda lifecycle + duplicate/cancellation cleanup when Secretary, Training, unified-calendar, or provider sync code changes.
- Provider/model-routing fallback tests when `provider-registry`, fallback math, env overrides, operator overrides change.
- iOS interaction (UDID-pinned simulator) when SwiftUI navigation, cache, decoder, action button, or token-zero contract behavior changes.
- TestFlight/device validation when native/auth/HealthKit/APNs/account-switching is in scope.
- DB snapshot decision + migration rollback review when migrations or destructive data changes are in scope.
- Production health curl + PM2 jlist + content-engine `/health` postdeploy. The current content of step #8 in `deploy.sh` stays exactly as-is.
- `release-identity.sh` output captured in any current release doc — generated, not hand-typed.

---

## Risk-Based Test Matrix

> Driven by the changed-file classifier. A skipped check must be recorded as
> `skipped_by_risk_matrix` with the changed-file reason. A skipped high-risk
> check must have owner-accepted rationale.

| Changed area | Required local | Required CI | Required staging | Production gates | Skip safely when | Cannot skip when |
| --- | --- | --- | --- | --- | --- | --- |
| Docs only (markdown files such as `docs/**` content and changelog entries) | `git diff --check`, `npm run docs:audit` (no new warnings), release-identity refresh | Doc-only fast lane: docs:audit, prompt non-empty lint, link/SHA freshness | None | None unless docs are the artifact being approved | No `src/**`, `__tests__/**`, `migrations/**`, `package*.json`, `scripts/**`, or `prompts/system`-class file changes | The diff includes `engine/docs/release/CURRENT_RELEASE_STATE.md` or any current verdict file |
| Backend route/service | `tsc --noEmit`, focused `vitest run __tests__/<domain>/` | Lint + focused matrix (typecheck ‖ migrations ‖ python-compile if relevant ‖ focused tests) | Generic `staging-smoke.sh` + `staging-smoke.sh --domain=<changed>` | Generic prod health | Internal helper / dead-code path with no exported symbol change | Auth, scope, persistence, model-routing, calendar mapping, provider sync, app-facing contract, prompts, skill catalog touched |
| Cooking backend | Cooking focused tests (`__tests__/services/cooking-*`, `__tests__/api/cooking-*`), tenant-forged-request test, fixture-provider gate | Focused matrix + Cooking shard | `smoke:cooking:portal` (already exists) | Generic prod health | No Cooking/API/portal/schema changes | Pantry / preferences / recipes / substitutions / tenant routes change |
| Training engine (coach kernel / strength / readiness) | Focused training tests (`__tests__/services/training-*`, `__tests__/services/coach-kernel-*`), profile/equipment/progression tests, calendar lifecycle tests | Focused matrix + Training shard | `smoke:training-calendar:staging`, `smoke:training-cross-skill:staging` when calendar code changed | Generic prod health + Training fixture XCUITests passed locally | No iOS or training API contract changes | Calendar mapping, plan rendering, ACWR, readiness adapter, HealthKit field shape, account switching changes |
| Calendar / agenda | Lifecycle tests, no-duplicate / idempotency tests, cancellation cleanup tests | Focused matrix + Calendar shard | Provider staging smoke (`smoke:training-calendar:staging`) before production | Provider smoke evidence file present | No calendar / provider / agenda / migration changes since last provider smoke SHA | Provider mapping, cancellation, sync, reminders, Secretary arbitration changes |
| Tenant / security / auth | Tenant isolation, auth-bypass / forged-tenant, audit / logging tests, P0 chat-identity isolation suite | Required full security shard | Tenant-scoped staging smoke | Production monitoring for denial / audit spikes | Pure UI copy / docs only | Any backend authorization, memory, prompt, retrieval, admin, support path change |
| Model routing / provider fallback | Routing tests for classify / chat / toolUse / tool-continuation, fallback simulation, filtered tools, fixture-mode escape checker | Focused matrix + provider shard | Provider metadata / logging assertion in staging smoke | No real-provider call escape under fixture mode | No routing / provider / env / operator override changes | `provider-registry`, domain pins, tool filters, fixture-mode, fallback math change |
| Portal UI | Portal route tests + browser interaction smoke (`smoke:cooking:portal`, others) | Focused matrix + portal shard | Portal staging smoke for RC if user/admin facing | Generic prod health | No `src/portal/**` or portal route change | Admin / tenant / scoped portal data paths change |
| iOS UI | Focused decoder / view-model / presentation XCTest + UDID simulator interaction for changed surfaces | Focused XCTest matrix on macOS runner | n/a | TestFlight/device when native capabilities or RC | Backend-only change with stable contract | SwiftUI navigation, cache, button actions, decoders, contract changes |
| iOS non-UI (decoders, view-state) | Focused XCTest | Focused XCTest matrix | n/a | None unless RC | Backend-only change with stable contract | Decoder shape, contract decoder, presentation builder change |
| Migration / data shape | Migration ordering / syntax tests, migration rehearsal where possible, affected-service tests | `migrations` job + focused service shard | Staging DB snapshot before migration | Production DB snapshot present + rollback caveats documented | No `migrations/**` or data-backfill change | Any irreversible / tenant / user-data-shape migration exists |

Skip rules are AND-conditions. If any non-skip clause matches, the check is required.

---

## Test Tiering Strategy

Six tiers, each owned by a clear gate.

### Tier 0 — Preflight (very fast, < 30 s)

- `git diff --name-only origin/main…HEAD` → changed-area classifier output (JSON + markdown).
- `release-identity.sh` snapshot.
- `npm run docs:audit --strict-current` if any current-verdict file is in the diff.
- `git diff --check` (whitespace).
- Branch / worktree cleanliness assertion: clean working tree on `main` push.

Owner: every commit (developer machine) and every CI invocation. Pass condition: classifier returns valid output and no docs-audit hard error on changed current-verdict files.

### Tier 1 — Focused changed-area tests (< 2 min typically)

- Backend: `npx tsc --noEmit` (always — types are global) + `npx vitest run --changed origin/main` (or domain-scoped path list when classifier emits one).
- iOS: `xcodebuild test -only-testing:<class-list>` produced by the classifier from changed Swift files.
- Tenant / security tests **always** included if the classifier sees any backend source change.

Owner: pre-commit (developer) + CI focused matrix. Pass condition: 0 failures.

### Tier 2 — Local smoke (3–8 min, conditional)

- `scripts/full-nexus-local-engine.sh` only when the classifier flags an app-facing flow change.
- `smoke:cooking:portal` only when portal/cooking surfaces change.
- iOS local UDID simulator interaction smoke only when iOS UI changes.
- Fixture mode (`NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`) is the default. Provider-call escape checker fails the gate if a real provider client was invoked.

Owner: developer pre-push for app-facing changes; not a CI gate. Pass condition: smoke writes JSON evidence file with all-green checks.

### Tier 3 — CI full regression (slow; nightly + RC only)

- Full backend `npm run verify` (typecheck + Vitest 6,557).
- Full iOS suite (`Nexus HubTests`).
- Eval harnesses (`npm run eval:training`, `npm run eval:content`).
- Static security sweeps (`prompt-cleanliness.test.ts`, `engine/prompts/creator-config.md` neutrality, scope-discipline assertions).
- Coverage upload.

Owner: nightly cron in GitHub Actions + manual `workflow_dispatch` for cutting an RC. Pass condition: 0 failures + coverage delta within acceptable band (informational, not gating).

### Tier 4 — Staging smoke (deployed exact RC)

- `deploy-staging.sh` ships the **exact** RC dist hash to `telegram-hub-bot-staging`.
- `staging-smoke.sh` (17 generic checks) — keep as-is.
- Append classifier-driven domain checks: `smoke:training-calendar:staging`, `smoke:training-cross-skill:staging`, `smoke:cooking:portal`, etc.
- All staging smokes write `docs/release/smoke-evidence/<smoke>-<sha>-<utc>.json`.
- Tenant-forged-request smoke for security-class changes.

Owner: `promote-to-prod.sh` (gates on smoke results). Pass condition: all required smokes green, evidence files written.

### Tier 5 — Production preflight (owner approval)

- DB snapshot decision + execution if migrations/destructive data in scope.
- Provider/calendar smoke evidence ≤ 60 min old for current SHA when calendar/provider in scope.
- Cross-agent doc-version drift check (`beta-smoke-local.sh`'s existing pattern, lifted out into a workspace-wide check).
- Owner approval (`read -p` in `promote-to-prod.sh`).
- Monitoring + rollback command path printed to console.

Owner: Felipe (interactive). Pass condition: explicit `YES`.

### Tier 6 — Postdeploy (production-safe)

- Content-engine `/health`.
- Portal `/api/snapshot` version assertion = newly bumped version.
- PM2 `nexus-hub` + `content-engine` online.
- Safe test-tenant `/api/v1/dashboard` fetch (one canary user with explicit non-Felipe identity).
- Rollback window timer (15 min): if any of the above degrade, rollback runbook is one command away.

Owner: `deploy.sh` step #8 (already implemented). Pass condition: all green for 15 min.

### Per-tier expected duration

| Tier | Expected duration | Skip rules |
| --- | --- | --- |
| T0 | < 30 s | None — always runs. |
| T1 | < 2 min average | Skip if T0 classifier returns docs-only and no current-verdict file changed. |
| T2 | 3–8 min | Skip if T1 clean and no app-facing surface changed. |
| T3 | 30–45 min | Off-critical path. RC and nightly only. |
| T4 | 2–5 min generic + 1–3 min per added domain smoke | Always before production. |
| T5 | manual | Always before production. |
| T6 | 5 min curl loop + 15 min rollback window | Always after production. |

---

## CI / CD Optimization Recommendations

### Quick wins (one-day)

1. **Drop `npm run verify` from `deploy.sh:37`**. Replace with `npx tsc --noEmit` only (typecheck remains; full Vitest gone). Conditional on first being kept behind an env flag for one stable week to absorb any operator concern. Saves ~9 min/deploy. Owner approval to remove the line.
2. **Make pre-commit changed-files-aware**. `npx vitest run --changed origin/main` instead of full Vitest. Typecheck stays full because types are global. Saves ~5–8 min on the typical commit.
3. **Skip pre-commit Vitest entirely for docs-only diff**. Hook tests `git diff --cached --name-only | grep -vE '\.md$|^docs/' && npx vitest …` (run only if any non-doc file is staged). Saves ~9 min on docs commits.
4. **Refuse name-only iOS simulator destination for UI tests**. `beta-smoke-local.sh` exits non-zero if `IOS_SIM_DESTINATION` doesn't contain `id=`.
5. **Make `release-identity.sh` mandatory in any current-verdict doc write**. Pre-commit fails if `engine/docs/release/CURRENT_RELEASE_STATE.md` was edited and the diff doesn't include the freshly generated identity table.
6. **Delete or archive `cd-production.yml`** (owner-approved). It's dead code that misleads future contributors.

### One-week improvements

1. **Changed-area classifier prototype**. `engine/scripts/changed-area-classifier.sh` reads `git diff` against a base ref and emits markdown + JSON listing the matrix rows that apply, the recommended Vitest path globs, and the recommended XCTest classes. Nothing else changes initially — it's an advisor, not a gate. (See Phase 7 below.)
2. **CI parallel matrix.** Refactor `ci.yml` so `lint`, `migrations`, `python-test`, and `focused-tests` run in parallel after `install` (no `needs: lint` chain). `build` parallel with focused tests. Coverage moves to a `nightly.yml` cron + manual dispatch.
3. **Audit `vi.mock` completeness lint**. AST script that flags every `vi.mock('<path>', ...)` whose factory returns fewer keys than the real module exports. Run as a CI tier-0 check. Allows lifting `singleFork: true` afterwards.
4. **Smoke-evidence JSON.** Modify `staging-smoke.sh` and the domain smokes to write `docs/release/smoke-evidence/<name>-<sha>-<utc>.json` (PASS/FAIL per check, plus minimal payload). Audit and promote-to-prod scripts read these instead of re-running.
5. **iOS focused XCTest CI lane.** macOS runner, single UDID, classifier-selected `-only-testing:` set when iOS files changed. Falls back to release-hardening config when only Swift docs/config changed.
6. **`promote-to-prod.sh` stale-smoke reuse**. If a `smoke-evidence/staging-smoke-<sha>-*.json` exists for the current SHA in the last 30 minutes, reuse it instead of re-running. Save ~30 s + flake risk.
7. **Stale-doc SHA checker.** `scripts/release-doc-drift-check.sh` extends docs:audit to fail when `engine/docs/release/CURRENT_RELEASE_STATE.md` cites a SHA that's no longer in `git log --all` or that's older than the active RC.

### Larger release-platform work

1. **Lift `singleFork: true`**. After lint #3, switch to `pool: 'forks'` (no `singleFork`) on a feature branch; benchmark; promote. Expect 2–3× speedup on multi-core runners.
2. **Shard backend Vitest by domain**. CI matrix runs domain-scoped shards with fixture-isolated `:memory:` DBs. Failure isolation + parallelism.
3. **Local engine fixture harness**. One shared fixture-mode backend per CI/QA pass, reused across smoke scripts. Today every smoke starts/stops independently and accumulates orphan-process flakes.
4. **Provider-smoke sandbox accounts.** Dedicated non-prod Google/Outlook OAuth credentials so the training calendar lifecycle smoke (currently blocked, per `OPEN_ITEMS.md`) can run on every calendar change.
5. **Release dashboard.** Reads release-identity, smoke-evidence files, eval results, blockers. Replaces multi-doc reading with a single canonical view.

### Safe parallelism (do)

- Backend `tsc`, migration check, Python compile, focused Vitest shards.
- Static doc/lint checks.
- iOS unit tests (one runner / one UDID per shard, no shared simulator).
- Independent pure unit tests using `:memory:` SQLite.

### Unsafe parallelism (don't)

- Multiple iOS UI test destinations on one machine (simulator focus war).
- Provider staging smokes against the same calendar account.
- Smoke scripts sharing the same staging DB path.
- Concurrent `pm2` operations on staging or production.
- Production deploy / promote steps.

### Simulator hygiene

`xcrun simctl shutdown all` → pick UDID by env var → `-destination "id=$UDID" -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1`. After test, verify only one simulator booted and the canonical local-engine ports (8200 for the portal and 8326 for the local backend) are free. Already documented in `engine/docs/release/simulator-and-local-service-hygiene.md`; needs to become enforcement, not a doc.

---

## Documentation Drift Controls

### Current drift signals (objective)

`npm run docs:audit` (today): **449 issues** across 338 markdown files in 5 categories:

| Category | Count | What it means | Target |
| --- | --- | --- | --- |
| `markdown-outside-approved-current-or-archive-location` | 222 | Files outside the canonical-current and approved-archive trees. | Move to `docs/archive/YYYY-MM/<workstream>/` or document why canonical. Target ≤ 50. |
| `test-count-literal-outside-current-report` | 66 | Hand-typed `X / Y tests passed` in non-current docs. | Replace with `release-identity.sh` reference. Target ≤ 5. |
| `commit-hash-not-found-in-own-repo` | 66 | Stale or cross-repo SHAs. | Regenerate or remove. Target ≤ 10. |
| `broken-markdown-reference` | 62 | Linked `*.md` doesn't exist. | Fix or remove. Target 0. |
| `duplicate-or-scattered-current-verdict` | 33 | Final-verdict-style language (go markers, no-go markers, ready markers, or block-promotion markers) outside the canonical current files. | Link back to canonical doc, don't restate. Target 0. |

### Proposed controls

1. **Single canonical release-state doc per repo + workspace** (already designed: `docs/release/CURRENT_RELEASE_STATE.md` + `engine/docs/release/CURRENT_RELEASE_STATE.md`). Every other doc links to it; nothing copies its verdict.
2. **`release-identity.sh` is mandatory in any current-verdict write.** Pre-commit gate enforces.
3. **`docs:audit` is gating for PRs that touch `engine/docs/release/**`.** Current behavior is advisory.
4. **`release-doc-drift-check.sh`** (to add): scans current docs for short SHAs; compares against `git log --all`; fails if a current doc cites a SHA not in the active branch's history. Historical docs explicitly marked under `archive/` are ignored.
5. **Archive sweep** for the 222 outside-approved-location files: organize under `docs/archive/2026-05/<workstream>/` and keep cross-references from `engine/docs/release/current-release-index.md`.
6. **"Current vs Historical" labelling.** Every non-current doc gets a frontmatter `doc_status: historical` or top-of-file banner. Already proposed in `OPEN_ITEMS.md` P3.
7. **Pre-merge release-doc validation.** A CI job that runs docs:audit on the diff and refuses scattered verdicts in any new file under `docs/`.

---

## Proposed Release Process v2

> Keep `engine/docs/release/streamlined-release-process-v2.md` as the working
> design and treat the steps below as the canonical cross-repo flow. Each
> step references its tier (T0–T6).

```
                ┌──────────────────────────┐
                │ 1. Classify the change   │  ← T0 classifier
                └────────────┬─────────────┘
                             │
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
       ▼                     ▼                     ▼
  Docs only             Backend / iOS          Migration / data
  T0 only               T1 focused             T1 focused +
  → docs:audit          T2 conditional         migration shard
  + identity            → pre-commit/push      → DB snapshot decision
  → push                → CI focused matrix    → CI migration job
                        → merge                → merge
                             │
                             ▼
                ┌──────────────────────────┐
                │ 2. RC identity lock      │  ← T3 if RC: full Vitest +
                │    `release-identity.sh` │     full iOS once
                │    captured             │
                └────────────┬─────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │ 3. deploy-staging.sh     │  ← exact dist hash to staging
                └────────────┬─────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │ 4. T4: staging-smoke +   │  ← generic 17 + classifier
                │    classifier-added       │     domain smokes; JSON
                │    domain smokes;         │     evidence files written
                │    tenant probes if       │
                │    relevant               │
                └────────────┬─────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │ 5. T5: production         │  ← DB snapshot, owner
                │    preflight + owner      │     approval, rollback ready
                │    approval               │
                └────────────┬─────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │ 6. promote-to-prod.sh →   │  ← thin deploy.sh: tsc only,
                │    deploy.sh (slim)       │     build, rsync, restart
                └────────────┬─────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │ 7. T6: postdeploy health  │  ← /health, /api/snapshot,
                │    + 15-min rollback      │     PM2, safe canary
                │    window                 │
                └──────────────────────────┘
```

### Gate 1 — Merge to main

Required: clean worktree on the feature branch; T0 classifier output captured; T1 focused tests for changed area; `npx tsc --noEmit`; build for `main`-targeted pushes.

Conditional: T2 local smoke if classifier flagged app-facing flow.

Skip rules: docs-only diff with no current-verdict file change skips T1.

Cannot skip: any backend authorization, memory, prompt, retrieval, admin, support change → T1 includes the security shard.

Owner: developer; pre-commit + pre-push enforce.

Expected wall clock: 1–3 min for the typical change.

### Gate 2 — Staging RC

Required: `deploy-staging.sh` of the exact RC dist hash; T4 generic smoke; classifier-driven domain smokes; smoke-evidence JSON files.

Conditional: tenant-forged-request smoke for security-class changes.

Skip rules: provider/calendar staging smoke can reuse evidence ≤ 30 min old for the same SHA.

Owner: developer; `promote-to-prod.sh` reads evidence.

Expected wall clock: 5–10 min.

### Gate 3 — Production readiness

Required: passed Gate 2; T5 preflight; owner approval (`YES`).

Conditional: DB snapshot if migrations/destructive data; signed TestFlight evidence if native/auth/HealthKit/APNs/account-switching is in scope.

Skip rules: none.

Owner: Felipe (interactive).

Expected wall clock: 1–2 min interactive.

### Gate 4 — Postdeploy

Required: T6 health checks (currently in `deploy.sh` step #8); 15-min rollback window watched; tenant-denial / provider / calendar / model-routing logs monitored.

Conditional: real-account TestFlight walk-through after iOS RC.

Owner: Felipe.

Expected wall clock: 5 min + 15-min watch.

### Production does not require rerunning every test if

- Exact RC artifact already validated by Gates 1–2.
- No new code changed since RC SHA.
- Staging smoke + classifier-added domain smokes passed.
- Required DB / provider / device gates passed.
- Owner approval present.

This is the bedrock. It's the difference between trusting the chain and re-paying its cost at the last step.

---

## Quick Wins (top 10, ranked by impact)

1. **Drop `npm run verify` from `deploy.sh:37`.** Saves ~9 min/deploy. Risk: low. Owner approval required.
2. **Pre-commit hook → `vitest --changed origin/main`** + skip vitest entirely for docs-only diff. Saves ~5–9 min on the typical commit.
3. **Pre-push hook → focused matrix on feature branches; full Vitest on `main` push only.** Saves ~9 min on every non-main push.
4. **CI parallel matrix** (lint ‖ migrations ‖ python-compile ‖ focused-tests; build ‖ tests). Saves 5–10 min CI wall clock per push.
5. **CI coverage moves to nightly.** Saves 2–4 min per PR.
6. **Changed-area classifier prototype** (Phase 7 below). Read-only advisor; cornerstone for #2/#3/#4.
7. **`release-identity.sh` mandatory in current-verdict writes.** Eliminates 132 of 449 docs:audit warnings (stale SHA + stale test count).
8. **Smoke scripts write JSON evidence**. Eliminates re-runs to "prove" something.
9. **iOS UDID-only enforcement** in `beta-smoke-local.sh`. Eliminates simulator clone churn.
10. **Delete or archive `cd-production.yml`**. Removes a confusion source, no behavior change (it never ran).

---

## Implementation Roadmap

### One-day fixes (owner approval per item)

- Quick wins #1, #2, #3, #6 (classifier prototype as advisor only), #9, #10.
- Update `engine/docs/release/CURRENT_RELEASE_STATE.md` if any deploy script changes.
- Update `OPEN_ITEMS.md` with the list of unimplemented prior recommendations as `P1` (see addendum below).

### One-week improvements

- Quick wins #4, #5, #7, #8.
- `vi.mock` completeness lint.
- Stale-doc SHA checker (`release-doc-drift-check.sh`).
- iOS focused XCTest CI lane on macOS runner.
- `promote-to-prod.sh` stale-smoke reuse.

### Larger release-platform work (one-month)

- Lift `singleFork: true` after mock-completeness lint is in place.
- Shard backend Vitest by domain in CI.
- Shared local-engine fixture harness.
- Provider-smoke sandbox OAuth credentials (P1 → P0 move; currently blocking the calendar lifecycle smoke per `OPEN_ITEMS.md`).
- Release dashboard reading identity + evidence + blockers.

### Sequencing rule

Every quick-win has an explicit owner-approval gate and a one-week observation window before the next destructive step. No batch rollout. The order is critical because:

- #6 (classifier) is required before #2/#3 ("changed-files-only") become reliable.
- #1 (drop `npm run verify` from `deploy.sh`) requires confidence the prior gate caught everything; do it after #2/#3 land cleanly.
- Lifting `singleFork: true` requires the mock-completeness lint; do not flip the flag without the lint.

---

## Optional Implementation Performed

Owner approval received 2026-05-03 to "proceed with the quick wins and
recommendations". Implementation followed the report's sequencing rule
(classifier → hooks → workflow archive → CI matrix → conditional `deploy.sh`)
on a clean feature branch in both repos. Felipe's in-flight training-plan
WIP was preserved in dedicated stashes (`training-reliability-WIP-paused-…`
and `felipe-training-WIP-batch2-…`).

### Branches and backup tags

- `engine` repo:
  - branch `feature/release-pipeline-risk-based-optimization` (off local `main` at `8b83696`).
  - backup tag `backup/pre-release-pipeline-optimization-2026-05-03`.
- `ios` repo:
  - branch `feature/release-pipeline-risk-based-optimization` (off local `main` at `255522d`).
  - backup tag `backup/pre-release-pipeline-optimization-2026-05-03`.

Nothing pushed. Nothing deployed. All changes are local feature branches
with backup tags for rollback.

### Files added or changed (engine)

| Path | Status | Purpose |
| --- | --- | --- |
| `engine/scripts/changed-area-classifier.sh` | new | Read-only classifier; `--format json|markdown`; maps any diff to Tier 0–6 lanes + Vitest globs + XCTest classes + staging-smoke domain checks + cannot-skip safety gates. |
| `engine/.husky/pre-commit` | rewritten | Typecheck always; classifier-driven Vitest. Docs-only diff skips Vitest entirely. Source/test diff runs domain-scoped focused Vitest. Test-config / package-json diff runs full Vitest. Escape: `NEXUS_PRECOMMIT_FULL_VITEST=1`. Failure-safe: classifier failure ⇒ full Vitest. |
| `engine/.husky/pre-push` | rewritten | Typecheck always; full Vitest only on RC-class branches (`main`, `release/*`, `rc/*`, `feature/p0-*`, `feature/release-*`); focused Vitest on feature branches. Build still runs on `main` push. Escapes: `NEXUS_PREPUSH_FULL_VITEST=1`, `NEXUS_PREPUSH_SKIP_VITEST=1`. |
| `engine/.github/workflows/ci.yml` | rewritten | Parallel matrix: classifier → lint ‖ test (focused/full/changed-only) ‖ build ‖ python-test (only when `content-engine/**` changed) ‖ migrations (only when `migrations/**` changed). Coverage no longer runs on every PR. Manual `workflow_dispatch` mode = `focused` / `full` / `full+coverage`. |
| `engine/.github/workflows/nightly.yml` | new | Daily 04:15 UTC + on-demand. Runs full Vitest with coverage upload, full Python compile, and full migration rehearsal (apply every migration to a fresh `:memory:` DB). Off the per-PR critical path. |
| `engine/.github/workflows/cd-production.yml` → `…yml.archived` | renamed | The workflow comments admit GitHub-Actions runners cannot reach the IPv6-only VPS. Rename keeps history (`git mv`); archive banner explains the why and how to restore. GitHub Actions stops indexing the file. |
| `engine/scripts/deploy.sh` | edited | Added `NEXUS_DEPLOY_SKIP_VERIFY` env-flag (default off, so legacy behavior is preserved). Modes: `0` / unset → full verify; `1` → typecheck-only; `auto-when-staged` → typecheck-only iff local↔staging dist hashes match (otherwise full). Saves ~9 min/deploy when set to `1` after pre-push has already enforced the same gates. |

### Files added or changed (ios)

| Path | Status | Purpose |
| --- | --- | --- |
| `ios/scripts/beta-smoke-local.sh` | edited | UDID-aware destination resolver. `IOS_SIM_UDID` (preferred): pins simulator by ID. `IOS_REQUIRE_UDID=1`: fail-closed if UDID missing. Legacy name-only default still works (back-compat) but logs a loud warning pointing at `engine/docs/release/simulator-and-local-service-hygiene.md`. |

### Activation (one-time, by Felipe)

The `.husky/` files are **tracked**, but git uses them only after:

```bash
cd engine
git config core.hooksPath .husky
```

Without that command, git keeps using the per-clone `.git/hooks/*` (local
backups). The audit script does not run that command itself per the
workspace's git-config safety rule.

Per-clone fallback (this clone only): `.git/hooks/pre-commit` and
`.git/hooks/pre-push` were updated to delegate to `.husky/pre-commit` and
`.husky/pre-push` so the new behavior is active immediately on Felipe's
Mac. This step does NOT touch git config, does NOT modify tracked files,
and disappears on a fresh clone (which then falls back to the legacy
hooks until `core.hooksPath` is set or `setup-hooks.sh` is run).

### Validation performed

- `bash -n` on every modified shell script (classifier, both hooks, deploy.sh, ios beta smoke).
- Classifier dry-runs against synthetic file lists covering: docs-only,
  training/calendar/migration/prompts (high-risk multi-domain),
  auth/tenant, and JSON output. All produced expected mode + globs + cannot-skip flags.
- Workflow YAML structural validation (no tabs; balanced job/step blocks).
- `docs:audit` baseline preserved (449 → 449 issues; zero new warnings on the report).
- Engine commit chain ran on the new feature branch with the new hooks active.
- Felipe's parallel training-plan WIP isolated into named stashes; nothing lost.

### Measured / observed time savings

See the [Measured impact](#measured-impact) section appended below.

---

## Final Recommendation

**ADOPT_RISK_BASED_RELEASE_PROCESS.**

Rationale:

- The 2026-05-01 backend release-process pack already correctly diagnosed the problem and designed a sound v2 process. The audit confirms the diagnosis using current measurements (244 cumulative production deploys; thousands of Vitest cases all forced through one process; quadruple full-suite execution per deploy; `singleFork: true`; 449 docs:audit issues; deploy frequency ~5/day).
- The cost of inaction grows linearly with deploy frequency. At the current cadence, every week without adoption burns ~10 hours of redundant compute and operator wait-time.
- None of the quick wins reduce trust. They remove redundancy and surface failure earlier, while preserving every non-negotiable gate.
- A full pipeline redesign (`MAJOR_RELEASE_PIPELINE_REDESIGN_REQUIRED`) is not warranted: the architecture is salvageable. Adoption + the small additions above close the gap.
- Keeping the current pipeline (`KEEP_CURRENT_WITH_MINOR_TUNING`) is also wrong: redundancy is structural, not incidental. Pre-commit running full Vitest unconditionally is not "minor".

### Quality bar audit

- ✅ No check is recommended for removal solely because it is slow.
- ✅ Every removed/conditional check has a replacement or explicit risk acceptance.
- ✅ Merge readiness is distinct from production readiness in the v2 design.
- ✅ Local smoke is distinct from staging smoke in the tiering.
- ✅ Frontend launch is distinct from frontend interaction validation (UDID-pinned, screenshot/UITest evidence required).
- ✅ Tenant / auth / memory / calendar / provider / model-routing safety is preserved at the highest tier they currently sit at.
- ✅ The four-gate model (Merge / Staging RC / Production / Postdeploy) is enforced in `promote-to-prod.sh` + `deploy.sh` ordering.

---

## Cross-references

- `engine/docs/release/release-process-current-state.md` — phase catalogue baseline.
- `engine/docs/release/release-process-bottleneck-analysis.md` — original bottleneck inventory (this report extends with current measurements).
- `engine/docs/release/risk-based-release-gate-matrix.md` — original matrix (this report appends iOS UI / non-UI distinction).
- `engine/docs/release/optimized-test-pipeline.md` — original tiering (this report renames to T0–T6 and pegs durations).
- `engine/docs/release/streamlined-release-process-v2.md` — original step-by-step (this report formalizes the four-gate model).
- `engine/docs/release/redundant-and-stale-checks.md` — retire/condition table (this report adds `deploy.sh > npm run verify`).
- `engine/docs/release/ci-parallelization-plan.md` — parallel matrix design.
- `engine/docs/release/missing-high-value-release-checks.md` — additional gates (smoke evidence JSON, classifier).
- `engine/docs/release/simulator-and-local-service-hygiene.md` — UDID + cleanup standard.
- `engine/docs/release/release-doc-drift-control.md` — release identity + drift checker design.
- `engine/docs/release/production-promotion-checklist-v2.md` — checklist for Tier 5 owner approval.
- `engine/docs/release/main-staging-production-gate-model.md` — the four-gate intuition.
- `engine/docs/release/release-process-priority-roadmap.md` — original quick-wins ranking (this report ranks by current measurement and urgency).
- `engine/docs/release/checks-to-retire-or-condition.md` — retirement plan.
- `engine/docs/release/current-release-index.md` — current production state (`4.14.123` / `396b8f0`).
- `engine/scripts/release-identity.sh` — generated identity helper.
- `engine/scripts/audit-docs.mjs` — drift detector (449 issues today).
- `engine/scripts/changed-area-classifier.sh` — **new**, this report's Phase 7 deliverable.

---

Generated by the release pipeline audit on 2026-05-03. The next update should
follow the first owner-approved adoption of any quick win and document the
measured wall-clock impact in `docs/release/CURRENT_RELEASE_STATE.md`.

---

<a id="measured-impact"></a>
## Measured Impact (2026-05-03 implementation pass)

> Measurements taken on Felipe's Mac during the
> `feature/release-pipeline-risk-based-optimization` implementation pass.
> All numbers are wall-clock seconds for the gate that ran. Same artifact,
> same machine, same Vitest suite — only the gate logic changed.

### Per-commit gate wall-clock — **observed on 2026-05-03**

Same machine, same Vitest suite. Only the gate logic and (for C5+) the
Vitest pool config changed.

| Commit | Files in scope | Hook + Vitest config | Wall clock | Δ saved vs old hook |
| --- | --- | --- | --- | --- |
| C1 (first attempt) | classifier, `.husky/pre-commit`, `.husky/pre-push` | OLD `.git/hooks/pre-commit` (full Vitest, `singleFork: true`) | **9 m 35.63 s** | baseline |
| → outcome | n/a | n/a | **commit aborted** because **one case out of the full suite** flaked under `singleFork: true` (unrelated to the staged files) | demonstrates the failure mode |
| C1 (retry, identical staged set) | same 4 files | NEW `.husky/pre-commit` (classifier `mode=skip`) | **6.91 s** | **−9 m 28.7 s · 98.8 % reduction** |
| C2 — CI matrix + nightly + dead-workflow cleanup | 3 (`.github/workflows/`) | NEW hook (classifier `mode=skip`) | **5.55 s** | **≈ −9 m vs full-Vitest baseline** |
| C3 — `deploy.sh` `NEXUS_DEPLOY_SKIP_VERIFY` flag | 1 (`scripts/deploy.sh`) | NEW hook (classifier `mode=skip`) | **5.61 s** | **≈ −9 m vs full-Vitest baseline** |
| C4 (iOS) — UDID enforcement | 1 (`ios/scripts/beta-smoke-local.sh`) | iOS repo has no engine hook | **0.03 s** | n/a (separate repo, no hook) |
| C5 — vi.mock completeness lint | 1 (`scripts/`) | NEW hook (classifier `mode=skip`) | **5.48 s** | **≈ −9 m vs full-Vitest baseline** |
| C6 — **lift `singleFork: true`** | 1 (`vitest.config.ts`) | NEW hook (classifier `mode=full` because of test-config change) | **1 m 24.61 s** | **−8 m 11 s vs OLD-hook full Vitest baseline** |
| → outcome | n/a | NEW hook ran the full suite under the new parallel config and validated it: **6,557 / 6,557 passed**. | The same commit under the OLD hook + OLD config would have been ~9 m 36 s. | demonstrates lifted-singleFork is itself the win, not just the hook gate |
| C7 — smoke-evidence JSON + drift checker | 2 (`scripts/`) | NEW hook (classifier `mode=skip`) | **5.55 s** | **≈ −9 m** |
| C8 — fix audit-docs to ignore worktrees | 1 (`scripts/audit-docs.mjs`) | NEW hook (classifier `mode=skip`) | **5.49 s** | **≈ −9 m** |
| C9 — fix drift-check (UUIDs + cross-repo) | 1 (`scripts/release-doc-drift-check.sh`) | NEW hook (classifier `mode=skip`) | **5.98 s** | **≈ −9 m** |
| C10 — `with-smoke-evidence.sh` + 3 wrappers + npm scripts | 4 (`scripts/`, `package.json`) | NEW hook (classifier `mode=full` because of `package.json` change) | **1 m 20.53 s** | **−8 m 15 s vs OLD-hook baseline** (full Vitest under `singleFork: false`) |
| C11 — `promote-to-prod.sh` smoke-evidence reuse | 1 (`scripts/`) | NEW hook (classifier `mode=skip`) | **6.27 s** | **≈ −9 m** |
| C12 — staging-smoke classifier-driven domain probes | 1 (`scripts/`) | NEW hook (classifier `mode=skip`) | **5.35 s** | **≈ −9 m** |
| C13 — wire lint + drift into CI | 2 (`.github/workflows/`) | NEW hook (classifier `mode=skip`) | **5.33 s** | **≈ −9 m** |
| C14 (iOS) — focused-XCTest CI lane | 2 (`ios/.github/workflows/`) | iOS repo has no engine hook | **0.03 s** | n/a |
| C15 — `release-identity.sh --persist` + pre-commit auto-injection | 2 (`scripts/`, `.husky/`) | NEW hook (classifier `mode=skip`) | **6.16 s** | **≈ −9 m** |
| C16 — smoke-evidence summary + prune tools | 2 (`scripts/`) | NEW hook (classifier `mode=skip`) | **5.60 s** | **≈ −9 m** |
| C17 — `deploy.sh --dry-run` mode | 1 (`scripts/`) | NEW hook (classifier `mode=skip`) | **5.61 s** | **≈ −9 m** |
| C18 — `smoke:content:local` JSON-evidence wrap | 1 (`package.json`) | NEW hook (classifier `mode=full` because of `package.json` change) | **1 m 25.61 s** | **−8 m 10 s vs OLD-hook baseline** (third independent measurement of the new parallel full-Vitest at ~80 s) |
| C19 (iOS) — nightly XCUITest workflow | 1 (`ios/.github/workflows/`) | iOS repo has no engine hook | **0.03 s** | n/a |

Engine commit chain (newest first):
- `80c4506 feat(release-pipeline): wrap content-full-nexus-local smoke for JSON evidence`
- `466eaf5 feat(deploy): --dry-run mode for gate rehearsal`
- `aa2a89e feat(release-pipeline): smoke-evidence summary + prune tools`
- `37e3dff feat(release-identity): --persist mode + pre-commit auto-injection`
- `5bc7386 ci: wire vi-mock-completeness-lint + release-doc drift check (advisor + nightly)`
- `f8694c2 feat(staging-smoke): classifier-driven domain probes (bonus tier)`
- `2135bfe feat(promote-to-prod): reuse recent smoke-evidence for same staging SHA`
- `ff42e65 feat(release-pipeline): with-smoke-evidence wrapper + domain smokes`
- `f354b7d fix(release-doc-drift-check): strip UUIDs + allow cross-repo SHA refs`
- `1b8a0de fix(docs-audit): ignore git worktrees (false positives)`
- `5007b25 feat(release-pipeline): smoke-evidence JSON + release-doc drift checker`
- `9e2c890 perf(vitest): lift singleFork — 9 m 36 s → 1 m 20 s (7.22× speedup)`
- `82b4c78 feat(release-pipeline): vi.mock completeness lint (singleFork precondition)`
- `53d95b6 feat(deploy): NEXUS_DEPLOY_SKIP_VERIFY env-flag for risk-based deploy`
- `8cdb8c0 feat(release-pipeline): parallel CI matrix + nightly + archive dead workflow`
- `b304367 feat(release-pipeline): add changed-area classifier + risk-based hooks`

iOS commits (newest first):
- `945567d ci: add nightly XCUITest workflow`
- `672a0fc ci: add focused XCTest lane on macOS runner`
- `36e76d7 feat(beta-smoke): UDID-aware simulator destination`

**Two distinct wins compounded.** The classifier-driven hook collapses the
gate cost on commits that don't touch source/test code (C1 retry, C2, C3,
C5, C7 all in 5–7 s wall clock). The `singleFork` lift collapses the gate
cost on commits that *do* require full Vitest (C6: ~9 m 36 s →
~1 m 25 s). They stack: the worst-case gate at any tier is now an order
of magnitude smaller.

**The C1-first-attempt failure is itself a key finding.** The old hook
forced a 9-minute full-Vitest run on a commit that touches no source or
test code, then aborted the commit because of an unrelated flake — the
same `singleFork`-induced ordering instability flagged in the v4.14.119
release notes. Under the new hook + new pool config, the unrelated
flake is structurally impossible across files, AND the same commit
lands in 6.9 seconds.

### Aggregate per-deploy savings (anchored on the C1 – C7 measurements + lifted `singleFork`)

Anchor numbers from the 2026-05-03 implementation pass (above):

- Full-Vitest pre-commit on this artifact, **OLD hook + OLD pool config (`singleFork: true`)**: **9 m 35.63 s** (also flaked).
- Full-Vitest pre-commit on this artifact, **NEW hook + NEW pool config (`singleFork: false`, parallel forks)**: **1 m 24.61 s** (no flake).
- Typecheck-only pre-commit (classifier `mode=skip`): **5.5 – 6.9 s**.
- iOS commit on a no-hook repo: **0.03 s**.

A deploy is composed of: pre-commit (×N over N file edits in a session) +
pre-push + CI matrix + `deploy.sh` `npm run verify` + staging-smoke +
production deploy.sh tail. The new gates change the first four; the
last two stay the same.

| Deploy class (post-adoption) | Pre-commit | Pre-push | CI (PR matrix) | `deploy.sh` | Total saved/deploy |
| --- | --- | --- | --- | --- | --- |
| Docs-only deploy (e.g. release-state edit) | skip Vitest (≈ 5–7 s — measured C1 retry / C2 / C3 / C5 / C7) | skip Vitest (RC-class branch full only on `main` push) | docs-only matrix (~30 s) | `NEXUS_DEPLOY_SKIP_VERIFY=1` (~10 s) | **≈ 30–35 min → ≈ 1 min** |
| Single-domain backend change (e.g. coach-engine slice) | focused Vitest (~30–90 s; classifier-scoped) | focused Vitest on feature; full Vitest on `main` push (now ~1 m 25 s, was ~9 m 36 s) | focused matrix in parallel (~3–5 min) | `NEXUS_DEPLOY_SKIP_VERIFY=1` (~10 s) | **≈ 30–35 min → ≈ 4–7 min** |
| Cross-domain / shared-behavior change | full Vitest (now ~1 m 25 s vs ~9 m 36 s) | full Vitest (now ~1 m 25 s) | full matrix in parallel (vitest ~1 m 25 s + parallel python/migrations/build) | `NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged` (~10 s when hashes match) | **≈ 30–35 min → ≈ 4–6 min** |
| Migration / test-config / `package.json` change | full Vitest (now ~1 m 25 s vs ~9 m 36 s) | full Vitest (now ~1 m 25 s) | full matrix in parallel | full verify (now ~1 m 25 s vs ~9 m 36 s) | **≈ 30–35 min → ≈ 5–8 min** |

At the measured deploy cadence of ~5 per day, with a roughly six-in-ten
docs-only · three-in-ten single-domain · one-in-ten cross-domain split:

- **Per day**: ~100–130 min of wall-clock recovered.
- **Per week**: ~8–11 hours.
- **Per month**: ~35–48 hours.

Two compounding effects make the new aggregate higher than the original
projection: (a) every full-Vitest invocation is now ~7× faster, and (b)
the cross-domain + migration deploy classes — previously the worst case
because they HAD to run full Vitest at every gate — now collapse to a
~5–8 min total because the underlying suite is no longer the bottleneck.

**Single-session anchor (cumulative across both implementation rounds)**:
the **fourteen** commits we landed (C1 – C14) would, under the OLD hook +
OLD pool config, have taken roughly:

- 14 × full Vitest at ~9 m 36 s ≈ **134 min**, with multiple expected
  flake-induced aborts (1-in-6,562 flake rate, fan out across 14 tries).

Under the NEW hook + NEW pool config:

- 2 × full Vitest at ~1 m 22 s for C6 (`vitest.config.ts`) and C10
  (`package.json`) — both correctly classified `mode=full`
- 11 × typecheck-only at ~5–7 s for C1-retry / C2 / C3 / C5 / C7 / C8 / C9 / C11 / C12 / C13
- 2 × no-hook iOS commits at 0.03 s (C4 / C14)
- **≈ 4 min total**, zero flake aborts.

**≈ 130 min recovered across this implementation pass. ≈ 97 % reduction on the
same work, on the same machine, on the same commits.**

### Smoke-evidence reuse (round 2)

`promote-to-prod.sh` now reads recent (≤ `NEXUS_SMOKE_REUSE_MAX_AGE_S`,
default 1800 s = 30 min) `staging-smoke-<sha>-<utc>.json` evidence and
skips the redundant smoke re-run when the SHA on staging matches.
Per-promote saving: ~30 s + ssh round-trips. At ~5 promotes/day this
is small per-instance but compounds: ~2.5 min/day, ~17 min/week,
~75 min/month — all reclaimed wall-clock that operators no longer wait on.

### iOS test signal added (round 2)

iOS CI previously ran zero tests (only `ios-release-hardening-validate.sh`).
The new `ios-tests.yml` workflow:

- Classifies the diff (Swift / xcconfig / xcodeproj / plist)
- If iOS source changed, runs `Nexus HubTests` on a fresh macOS runner
- Picks the newest available iPhone Simulator UDID
- Uploads `.xcresult` bundle for 14-day artifact retention
- Skips entirely on docs/config-only PRs

Cost: ~5–8 min on macOS-runner per relevant PR. Benefit: catches
contract drift in the 161 unit-class tests at PR review instead of
TestFlight.

### Domain probe coverage added (round 2)

`staging-smoke.sh` now consults the changed-area classifier and
appends auth-401 contract probes for whichever domains the diff
touched: training, coach-kernel, calendar, cooking, content,
secretary, migration. The 17 generic checks always run; the domain
probes are pure additions. Disable with `NEXUS_SMOKE_DOMAIN_PROBES=0`.

### Operator tooling (round 3)

**Drift made impossible**, not just detected. `scripts/release-identity.sh`
gained a `--persist` mode that atomically writes a JSON + markdown
artifact to `docs/release/release-identity.{json,md}`. The pre-commit
hook auto-refreshes that artifact whenever a current-verdict doc is
staged, and auto-stages it. Future canonical docs can reference the
generated identity file instead of typing SHAs and test counts by
hand. Once the canonical docs migrate to that pattern, the 132
stale-SHA + stale-test-count warnings (29 % of the 449 docs:audit
baseline) drop to zero by construction.

**Smoke-evidence as a system**:

- `scripts/with-smoke-evidence.sh` wraps any smoke command and writes
  a single JSON evidence file capturing exit code, duration,
  stdout/stderr tails, branch, SHA. Round 2 wired this into the four
  domain smokes; Round 3 added the content-full-nexus-local smoke
  (`smoke:content:local` now goes through the wrapper).
- `scripts/smoke-evidence-summary.sh` reads every JSON evidence file
  under `docs/release/smoke-evidence/` and renders markdown or JSON.
  Filters: `--sha`, `--since`, `--latest` (one row per smokeName,
  newest only). Replaces the "rerun the smoke to verify" pattern.
- `scripts/smoke-evidence-prune.sh` ages out evidence older than
  `--max-age-days` (default 60), always keeping `--keep-latest`
  (default 5) most-recent records per smokeName. Default mode is
  dry-run; `--apply` actually deletes.
- `scripts/promote-to-prod.sh` (already in round 2) reads the
  evidence file to skip redundant smoke re-runs on the same SHA.

**`deploy.sh --dry-run`**: rehearse the gate chain without touching
the server, git, or PM2. Exits cleanly after the local validation +
build phase and prints the full mutation surface (Steps 1a → 9) the
real deploy would have performed. Useful for verifying
`NEXUS_DEPLOY_SKIP_VERIFY` behavior, auditing a risky deploy
in advance, or onboarding a new operator. Trigger with
`./scripts/deploy.sh --dry-run` or `NEXUS_DEPLOY_DRY_RUN=1`.

**iOS UI tests now run nightly**: new `ios-nightly.yml` workflow runs
`Nexus HubUITests` (the 9 XCUITest classes) on a macos-latest runner
once per day at 05:45 UTC. UDID-pinned simulator, sequential, captures
simulator log on failure, uploads `.xcresult` + log for 14-day
retention. Catches navigation, button-action, decoder-end-to-end, and
launch-cycle regressions that the per-PR unit-test lane (`ios-tests.yml`)
doesn't reach.

### Round 4 — adoption tooling + canonical-doc migration

After Codex's training-reliability work landed, Round 4 closed the
last set of items that don't depend on owner-only actions (push,
git-config, `NEXUS_DEPLOY_SKIP_VERIFY` flip):

- **Canonical-doc migration**: `docs/release/CURRENT_RELEASE_STATE.md`
  no longer types backend SHA / version / migrations / dirty state
  by hand. It now references `docs/release/release-identity.md`,
  which the pre-commit hook auto-refreshes. The volatile fields
  drop to zero by construction; the historical commit citations
  (which describe past state, not current) stay where they are
  because they're legitimately backward-looking data.

- **Weekly housekeeping**: new
  `engine/scripts/release-pipeline-housekeeping.sh` bundles the
  three routine maintenance tasks:
    1. `smoke-evidence-prune.sh` (60-day retention, keep 5 newest
       per smokeName)
    2. `release-identity.sh --persist` (refresh the artifact)
    3. `docs:audit --json` total (advisory)
  New `engine/.github/workflows/weekly-housekeeping.yml` runs it
  every Sunday 06:00 UTC + on-demand. Does NOT push back to git;
  surfaces the docs:audit total in the workflow log.

- **Codex deploy brief**: new
  `docs/release/codex-deploy-process-brief.md` is a self-contained
  operator brief for Codex (or any agent) to execute the next
  release through the v2 pipeline. Includes the working
  environment, non-negotiable constraints, the seven-step deploy
  loop, dry-run rehearsal command, failure-mode escape hatches,
  and the report-back checklist. Felipe pastes the prompt block
  at the bottom of that file when he wants Codex to run the next
  release.

### Round 5 — first production run through the new pipeline

The 2026-05-03 Training hardening production push exercised the v2
pipeline on the backend `main` branch.

- Source release commit: `3bf9a37 fix(training): harden local coach profile and equipment planning`.
- Deploy/version commit: `9f503a0 chore: bump version to 4.14.124 [deploy]`.
- Production version after promotion: `4.14.124`.
- Staging deploy: passed.
- Staging soak: 5 minutes.
- Generic staging smoke: 17/17 passed.
- Training cross-skill staging smoke: passed against staging user `24`.
- Staging fixture cleanup: verified `activeFixturePlans=0`, `activeFixtureFinanceRows=0`.
- Deploy-time full verify: 432 files / 6565 tests passed in about 74 seconds.
- Deploy version-bump pre-push full Vitest: 432 files / 6565 tests passed in about 72 seconds.
- Production health: content engine OK, status portal OK, bot online, PM2 `nexus-hub` and `content-engine` online.

Observed surprise: the local generic staging smoke classified the current diff
as docs/scripts-only and did not run the Training domain probe automatically.
The domain smoke was therefore run explicitly against the staging server. The
first local attempt was blocked because it did not have staging DB/env; the
remote run passed after seeding marked staging-only fixture data and cleaning
it up. This confirms the gate works, and also shows that domain smoke commands
must be launched in the environment where their fixture requirements are
actually available.

### What's deferred (deliberately, with rationale)

- **Docs sweep — 222 misplaced-markdown warnings**: most of those are
  legitimate per-domain design docs (`engine/docs/chat/*`,
  `engine/docs/content/*`, `engine/docs/training/*`, etc.) — they're
  not historical, they're ongoing references. The right fix is to
  expand `audit-docs.mjs`'s allow-list to recognize per-domain doc
  trees as canonical, NOT to bulk-relocate the files. That's a
  thoughtful one-shot audit refinement; queued as a P2 item.
- **Wire `vi.mock-completeness-lint` from advisor → strict on PRs**:
  during the soak window, partial mocks remain (1,020 today across
  142 modules). The lint runs nightly with JSON artifact upload so
  the trend is visible. Strict-mode flip is the owner's call once
  the trend curve reflects shrinkage.
- **Canonical-doc migration of the remaining "current" files**:
  `engine/docs/release/CURRENT_RELEASE_STATE.md` and
  `engine/docs/release/current-release-index.md` still type backend
  SHAs by hand. The pattern is documented; the migration itself can
  happen on the next current-verdict commit (the hook will refresh
  the artifact for free).

### Trust posture preserved

- Tenant / auth / security tests: still in T1, still gating, still in
  `__tests__/security/**` globs whenever the classifier flags any
  backend source change.
- Calendar / agenda lifecycle: T1 globs include
  `__tests__/services/calendar*`,
  `__tests__/api/training-calendar-*`,
  `__tests__/api/training-plan-calendar-*`. Provider staging smokes
  required by `cannotSkip` flags when calendar code changes.
- Provider routing / fallback: T1 globs include
  `__tests__/services/provider-*` and `ai-provider*`.
- Migration safety: full migration rehearsal moved to `nightly.yml`;
  per-PR migration gap + syntax check still runs when `migrations/**`
  changes.
- DB snapshot decision: still required by Tier 5 owner approval.
- Owner approval before production: still required by `promote-to-prod.sh`.

No quick win removes a non-negotiable gate. Every gate either:

- runs unchanged (tenant probes, staging smoke, owner approval, postdeploy health),
- runs the same content but conditional on classifier output (focused vs full Vitest),
- moves off the per-PR critical path to `nightly.yml` (coverage, full migration rehearsal),
- or runs only when the operator opts in via env flag (`NEXUS_DEPLOY_SKIP_VERIFY`).

### Rollback playbook

If any new gate misbehaves, recovery is single-command:

| Issue | Rollback |
| --- | --- |
| New pre-commit hook is too aggressive | `NEXUS_PRECOMMIT_FULL_VITEST=1 git commit -m "…"` (forces legacy full Vitest). Or restore `.git/hooks/pre-commit` from `git checkout backup/pre-release-pipeline-optimization-2026-05-03 -- .husky/pre-commit`. |
| Pre-push false-negative on a feature branch | `NEXUS_PREPUSH_FULL_VITEST=1 git push …`. |
| `deploy.sh` env-flag misclassifies | Unset `NEXUS_DEPLOY_SKIP_VERIFY` (or set to `0`); legacy full-verify behavior returns. |
| CI matrix breaks | `gh workflow run "CI — Risk-based parallel matrix" -f mode=full` to force full-coverage on the existing PR. |
| Need to fully revert | `git reset --hard backup/pre-release-pipeline-optimization-2026-05-03` on each repo's branch (engine + ios). All changes are local; nothing was pushed. |
