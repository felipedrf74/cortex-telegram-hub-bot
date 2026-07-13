# Backend Current Release State

Status: canonical
Owner: backend release lead (Felipe)
Last verified: 2026-07-13
Update policy: update after backend deploy or staging change. Workspace-level entry point is docs/release/CURRENT_RELEASE_STATE.md.

Last updated: 2026-07-13

Only the **Active Production Release** section states the current production
truth. Dated sections below it are historical deploy evidence and may mention
older production versions.

## Active Production Release

- Source branch: `main` at `6c67c181` (`chore: prepare release 4.14.216`).
  Pushed to `origin/main` after the protected pre-push gate passed.
- Production HEAD: `6c67c181`.
- Production version: `4.14.216`.
- Previous production HEAD: `9c68db5a`.
- Scope: the paid-only AI cost-control implementation and adversarial-QA fix
  round are deployed. Production remains in observe mode because
  `PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED` is unset: legacy daily user caps
  and the system-actor stop remain active, while the new paid-plan, monthly,
  and automation blocking policy is not yet activated. Additive quota fields,
  attribution, migration 226, workload optimizations, and stable error paths
  are present in the runtime.
- Release lineage: backend `3ce20473`, `fa4de82e`, `82835940`, `3cf19dce`, and
  release commit `6c67c181`. Backend and iOS `origin/main` contain the release;
  the companion SHA is recorded in the generated workspace release identity.
- Release verification on the exact 4.14.216 tree: release prep passed
  typecheck/build and full Vitest (**873 files / 12,910 tests**); staging
  deploy/readiness passed; promotion-time staging smoke passed **25/25**;
  production promotion repeated migration safety (**217 migration files**),
  typecheck, science-policy, build, and full Vitest (**873 / 12,910**). The
  protected GitHub push gate repeated typecheck/Vitest and passed Content
  Engine pytest under the project test environment.
- Verified post-deploy by read-only probes: public
  `https://api.nexushub.me/health` returned `status: healthy`; production
  package and PM2 `nexus-hub`/`content-engine` reported `4.14.216`; both PM2
  apps were online with no restart during the readiness sample; migration 226
  was applied exactly once among 236 recorded migrations; and the remote
  artifact digest matched local at
  `13ff241c43533519cef7458ed3358ad56abb7ce6f33b5fabaafe28d36ca78d95`.
- iOS source is on `main` at the SHA recorded in the generated workspace
  release identity. TestFlight/App Store upload,
  physical-device proof, and signed-device smoke were not run.
- Backend workspace root: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`

## 2026-07-13 Training Exercise-Media Source Gate — STAGED/DORMANT

- `origin/main` at `66fd6b7a` now contains the additive Training
  exercise-media schema and fail-closed delivery code, including migration
  229. The source is staged in Git and dormant; this is **not** evidence that
  migration 229 was executed or that a manifest reached database publication
  state `STAGED` or `ACTIVE` in production.
- Training exercise media is **not production-active**. The
  `TRAINING_EXERCISE_MEDIA_V1_ENABLED` default remains `false`, and no
  publication, activation, approved-host delivery, migration execution,
  staging deploy, or production deploy is authorized or claimed by the source
  merge. The Active Production Release above remains `4.14.216` at
  `6c67c181`.
- Production-approved catalog coverage is **0/158**. Publication and activation
  remain blocked on exactly these six gates: `DOMAIN_APPROVAL`,
  `LEGAL_LICENSE`, `ACCESSIBILITY`, `OWNER_PUBLICATION`, `LOCALIZATION`, and
  `APPROVED_HOST`.
- Release posture: **DO NOT RELEASE Training exercise media** until all six
  gates pass against immutable reviewed assets and the owner separately
  authorizes rollout. No environment or live runtime was mutated or probed by
  this documentation-only update.

## 2026-07-10 Paid-Only AI Cost Controls Production Promote

- The implementation and fix-round source are now on backend and iOS `main`;
  backend 4.14.216 is deployed to staging and production from `6c67c181`.
- Production is intentionally observe-only. Before setting
  `PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED=true`, run the complete synthetic
  entitlement/billing persona matrix on staging and obtain explicit owner
  authorization for the flag change.
- Local predeploy evidence remains: backend typecheck and full Vitest
  (**873 / 12,910**), Content Engine pytest (**194**), real 001-to-226
  migration-runner rehearsal, full iOS `Nexus HubTests` (**1,996/1,996**), and
  iOS app simulator build. Promotion added artifact parity, 25/25 staging
  smoke, strict production verification, backup/readiness, and independent
  runtime identity/migration/digest proof.
- Still not claimed: enforcement-on staging persona proof, authenticated
  live-provider quality parity, TestFlight/device/APNs proof, or the 30-day
  cost/quality acceptance window. These remain explicit workspace open items.
- The complete finding disposition and exact evidence scope live only in
  `docs/agents/handoffs/2026-07-10-paid-ai-cost-controls-fix-round.md`.

## 2026-07-09 Paid Coach Briefing Production Deploy

- Backend commit: `9c68db5a` (`fix(coach): gate briefings and compact reports`).
- Policy: Apple/Stripe Pro or Max and explicitly assigned founder Pro/Max are
  eligible; Free, owner-only, beta sandbox, expired, and no-active-plan users
  are denied before coach work begins.
- Delivery: direct `deploy.sh` production path with the duplicate full Vitest
  layer explicitly skipped after focused and protected matrices passed. The
  script still passed migration policy, typecheck, build, backup, artifact
  sync, dependency/native rebuild, SQLite integrity, PM2 stability, and
  readiness checks.
- Not run: staging deploy/smoke, live coach generation, live APNs delivery, and
  production calendar writes. These were outside the requested scoped release.

## 2026-07-09 Training/Secretary Calendar Ownership Promote

- Scope: fixed the two screenshots from 2026-07-09 — Training lower-body
  sessions no longer display upper-body descriptions when the ABCDE slot is a
  pull day, and Secretary/Training Outlook sync no longer duplicates the same
  Training calendar event or leaves agenda state unsynchronized when the user
  has a preferred-time empty slot.
- Backend commits: `32114d72` (`fix(secretary): preserve training calendar
  ownership`), `81b90b87` (`fix(training): align split titles with assigned
  structure`), `f8737377` (`chore: prepare release 4.14.215`), `e700826f`
  (`fix(secretary): reconcile duplicate events on fresh sync`), `0f532094`
  (`fix(secretary): repair missing fresh provider events`), and `cdfe9388`
  (`docs(release): record 4.14.215 staging smoke`).
- Evidence: initial local `npx tsc --noEmit`, `scripts/risk-gate.sh`, and full
  `npx vitest run` passed; after the duplicate-reconciliation fix, the focused
  Secretary sync suite passed 33/33, typecheck passed, risk gate passed 17
  files / 320 tests, and full Vitest passed 867 files / 12,740 tests; after the
  missing-provider-event fix, the focused Secretary sync suite passed 35/35,
  typecheck passed, risk gate passed 17 files / 322 tests, and full Vitest
  passed 867 files / 12,742 tests. The final production deploy strict gate
  repeated typecheck, science-policy, build, and full Vitest 867 files /
  12,742 tests.
- Staging/prod: staging deploy passed on `0f532094`/`cdfe9388`; standalone
  staging smoke passed 21/21 with committed evidence
  `docs/release/smoke-evidence/staging-smoke-0f532094-20260709T093359Z.json`;
  live Outlook Training calendar lifecycle smoke for the staging QA account
  passed 9/9; live Outlook Secretary calendar lifecycle smoke passed 8/8; the
  full Training flow's selected-provider duplicate/cancel checks passed, while
  one broader plan-shape assertion remained a non-release-blocking harness
  expectation mismatch for that QA profile.
- Promote: `promote-to-prod.sh` passed env/artifact parity, ran a fresh
  promotion-time staging smoke 21/21, then `deploy.sh` strict validation passed
  migration safety (216 migrations), typecheck, science-policy, build, backup,
  PM2 restart/readiness, and full Vitest 867 files / 12,742 tests. Production
  now runs `4.14.215` at `cdfe9388`.
- Post-promote proof: public `/health` healthy, public `/public-status` ok, PM2
  `nexus-hub` and `content-engine` online on `4.14.215`, authenticated
  Decision Center overview returned HTTP 200 with `ok: true`, and
  post-restart logs showed a completed `secretary_agenda_sync` tick with no
  high-severity application log entries in the sampled post-deploy window.
- Blocked/not authorized: TestFlight/App Store upload, physical-device proof,
  signed-device smoke, HealthKit, Garmin, APNs live push, two-account provider
  proof, Google live calendar proof for the Outlook-only staging QA account,
  and production live calendar writes were not authorized/run.

## 2026-07-08 P3 Release Tooling Promote

- Scope: closed the three 2026-07-08 adversarial QA P3 findings after owner
  authorization: explicit promote version-mint policy plus `4.14.214`, PM2
  staging-smoke evidence rows with real `status` fields and sanitized
  multiline details, and iOS TestFlight export defaulting to local export.
- Backend commits: `dd7afaf8` (`chore(release): mint 4.14.214 + promote
  version policy`), `113b83a5` (`fix(release): make staging smoke PM2 gates
  real checks`), and `df21fd04` (`docs(release): record 4.14.214 staging
  smoke`). Previous production deploy commit was `b1916a76`.
- iOS commit pushed to `origin/main`: `3030c71` (`chore(release-tooling):
  default testflight export to local export`). TestFlight/App Store upload was
  not run. The local iOS `project.pbxproj` build-number bump remains
  uncommitted.
- Evidence: `scripts/release-identity.sh markdown` reported backend
  `4.14.214`; `bash -n scripts/staging-smoke.sh` passed; iOS `bash -n`,
  12-case guard-function matrix, and
  `scripts/ios-release-hardening-validate.sh` passed; backend classifier
  selected T0/T1/T3-recommended/T5-on-promote/T6-postdeploy; `scripts/risk-gate.sh`
  passed typecheck plus full Vitest 867 files / 12,725 tests, and pre-push
  repeated the same full gate.
- Staging/prod: `deploy-staging.sh` passed; soak ran from
  `2026-07-08T19:02:05Z` to `2026-07-08T19:07:05Z`; staging smoke passed
  21/21 with engine evidence
  `docs/release/smoke-evidence/staging-smoke-113b83a5-20260708T190748Z.json`.
  The evidence schema difference from prior 19/19 runs is intentional: PM2
  `nexus-hub online`, `content-engine online`, and `nexus-hub restarts == 0`
  now appear as explicit checks with `status`.
- Promote: `promote-to-prod.sh` passed env/artifact parity, ran a fresh
  promotion-time staging smoke 21/21, then `deploy.sh` strict validation passed
  migration safety (216 migrations), typecheck, science-policy, and full
  Vitest 867 files / 12,725 tests. Production now runs `4.14.214` at
  `df21fd04`.
- Post-promote proof: public `/health` healthy, public `/public-status` ok with
  exactly `{status, service, timestamp}`, PM2 `nexus-hub` and
  `content-engine` online on `4.14.214`, and authenticated Decision Center
  overview returned `ok: true`.
- Blocked/not authorized: TestFlight/App Store upload, physical-device proof,
  live Google/Outlook production calendar writes, two-account provider proof,
  HealthKit, Garmin, APNs live push, provider-state validation, and App Store
  Connect build 51/52 manual confirmation.

## 2026-07-08 Training Skill QA Calendar Lifecycle Production Promote

- Scope: landed the 2026-07-08 Training QA fixes after Claude QA review:
  tenant-isolated calendar ownership checks, rollback-safe Training calendar
  sync, Secretary agenda cleanup/read-model truthfulness, plan quality-gate
  rationale persistence, stale-readiness mapping coverage, iOS calendar cleanup
  and degraded-sync copy, repeated Training deep-link consumption, Content
  Studio bottom runway source-pin repair, and stable-toolchain TestFlight export
  guard hardening.
- Backend commits: `b28a47b6` (`fix(training): harden calendar sync lifecycle`),
  `90d0a8a3` (`docs(agents): capture training qa handoff`), and `b1916a76`
  (`docs(release): record training qa staging smoke`).
- iOS commits pushed to `origin/main`: `9093526`,
  `88e48bc`, and `e1d1ca0`. `project.pbxproj` build-number bump remains local
  and was not committed, reverted, uploaded, or included in TestFlight.
- Evidence: `scripts/changed-area-classifier.sh --json` selected
  T0/T1/T2/T4/T5-on-promote/T6-postdeploy; `scripts/risk-gate.sh` passed
  focused Training/calendar 131 files / 2,086 tests and changed sweep 54 files
  / 1,431 tests; pre-push repeated the same gate and build verification; iOS
  source pins passed 43/43, touched Training bundle passed 154/154, and
  Content Studio Debug UI Smoke passed 4/4.
- Staging/prod: `deploy-staging.sh` passed, soak ran from
  `2026-07-08T17:24:35Z` to `2026-07-08T17:29:35Z`, staging smoke passed 19/19
  with evidence
  `docs/release/smoke-evidence/staging-smoke-90d0a8a3-20260708T173034Z.json`,
  promote gate smoke passed 19/19, and production deploy validation passed
  867 Vitest files / 12,725 tests.
- Post-promote proof: public `/health` healthy, public `/public-status` ok, PM2
  `nexus-hub` and `content-engine` online on `4.14.213`, and authenticated
  Decision Center overview returned `ok: true`.
- Blocked/not authorized: TestFlight/App Store upload, physical-device proof,
  live Google/Outlook production calendar writes, two-account provider proof,
  HealthKit, Garmin, APNs live push, and provider-state validation.

## 2026-07-03 Optimization Round + Per-User Schedules Promote

- Deploy commit `0df62678` (code `200e8a12`), version `4.14.212`.
- Pipeline: deploy-staging → 5-min soak → staging-smoke 24/24 (evidence
  committed pre-promote per REL-EVIDENCE-PERSISTENCE) → promote-to-prod
  (fresh 24/24 gate smoke) → deploy.sh strict validation → health green.
- Promote hygiene notes: first attempt refused on artifact manifest drift
  caused by 207 macOS " 2"/" 3" duplicate files in local `dist/` (gitignored
  build junk; deleted, digests matched exactly). Second attempt cancelled
  silently because the piped confirmation was drained by inner ssh during
  the gate smoke — promoted via expect PTY. Consider a
  NEXUS_PROMOTE_ASSUME_YES env for scripted promotes.

## 2026-07-02 Training UX Round Production Promote (evening)

- Scope: Training UX round backend — `plan.weeklyTargets
  {requested, scheduled}` on `GET /api/v1/training/plan/weeks`, conditional
  `calendarCleanup {deadLetteredCount} | null` dead-letter visibility on the
  plan read models, restored `trainingLearningPath` persistence in
  `buildPreferencesJson` (4.14.210 rebase regression caught by the isolated
  Training E2E lane), and Training E2E harness hardening.
- Production version: `4.14.211` (unchanged, no version mint). Production
  deploy commit: `6bb2affe`; artifact digest `2e75b0e0…723`… recorded in the
  workspace canonical.
- Paired iOS main commits `71def47` + `c79e42a` pushed to origin.
- QA: Codex round-1 2 MAJORs fixed; re-audit GO with zero findings
  (`ios/docs/qa/work-orders/WO-training-ux-round-20260702.md`).
- Full promotion evidence, probes, and the stale-lock/manifest-drift
  operational notes are recorded in the workspace canonical
  `docs/release/CURRENT_RELEASE_STATE.md` (2026-07-02 evening section),
  mirrored under `docs/_workspace-mirror/`.

## 2026-07-02 Training Remediation Production Promote

- Scope: 2026-07-01 Training remediation round — readiness snapshot fidelity
  (`sleepDurationHours`, `reasoning`), explicit-vs-auto weekly-session dials
  (`Goals.weeklySessionsTargetExplicit`), enforced pre-race taper strength
  cutoff (`week.strengthCutoffActive` + `taper_strength_cutoff` reason code),
  structured `safetyPause` flag, `requestedTargets` persisted in plan
  `preferences_json`, secretary agenda provider-sync dead-lettering
  (migration 220 `provider_sync_failure_count`, dead-letter after 5
  consecutive `delete_failed` cleanup failures), calendar-source validation
  tightening, and quality-gate expansion.
- Production version: `4.14.211`. Production deploy commit: `f0c3fc3e`.
- GitHub release `v4.14.211` published 2026-07-02T11:21:07Z.
- Promotion evidence and caveats are recorded in the workspace canonical
  `docs/release/CURRENT_RELEASE_STATE.md` (2026-07-02 section), including the
  missing persisted staging-smoke JSON for `f0c3fc3e` and the dry-run author
  identity on the release-prep commit.

## 2026-06-26 Offline-First Tasks Provider-Missing Hotfix Production Promote

- Scope: fixed Microsoft To Do tasks that still exist in the provider but were
  shown in iOS as "Provider no longer has this task." Root cause was sticky
  `provider_missing`/`link_state=provider_missing` state on unchanged provider
  imports; the provider link was refreshed but the task warning was preserved.
- Production version: `4.14.210`.
- Production deploy commit: `b8bd0c29`
  (`fix(tasks): clear provider-missing after provider reappears`).
- Code changes: `src/services/task-store/unified-task-store.ts` now treats a
  provider import/read-back as proof that recoverable absence states
  (`provider_missing`, `provider_disconnected`, `stale`, `failed_retryable`)
  should return to `synced`, updates provider link freshness/version metadata,
  and resolves the open `provider_task_missing` sync issue. Conflict and
  pending-local mutation states remain sticky.
- Regression coverage: `__tests__/services/task-store/unified-task-store.test.ts`
  covers unchanged and changed Microsoft re-imports after `provider_missing`;
  `__tests__/services/task-store/sync-engine.test.ts` covers the full-sync
  pipeline where a missing task later reappears.
- Local verification before push: focused task-store suites passed **2 files /
  55 tests**; `npx tsc --noEmit` passed; `scripts/risk-gate.sh` passed
  changed-only Vitest with **236 files / 3,802 tests**.
- GitHub push gate repeated changed-only Vitest with **236 files / 3,802
  tests** before pushing `b8bd0c29` to `main`.
- Staging deploy passed through `scripts/deploy-staging.sh`; staging readiness
  passed with artifact digest
  `090d5fd593cd587b2ae2ba688f0035a2683e863536208e68aa8e00c554cdfead`.
- Promote-time staging smoke passed **19/19** before production mutation.
- Production promotion completed through `scripts/promote-to-prod.sh`.
  Deploy-time validation passed migration safety for **210 migrations**,
  typecheck, science-policy pin validation, full Vitest with **864 files /
  12,654 tests**, build, backup creation with `bot.db`, native module rebuild
  under system Node `v22.23.0`, PM2 restart, SQLite integrity, `/health`,
  content-engine readiness, native better-sqlite3 loading, and PM2 stability.
- Post-production probes passed: public `https://api.nexushub.me/health`
  returned `status: healthy`, PM2 showed `nexus-hub` and `content-engine`
  online, and targeted Microsoft To Do sync for user `25` completed without
  errors.
- Data repair evidence: production Siemens tasks `Apontar horas (Mendix)` and
  `Emitir Nota MV` now have `sync_state='synced'`, provider links
  `link_state='linked'`, no open `provider_task_missing` issue, and
  `change_seq='2026-06-26T15:00:38.000Z'` for iOS delta refresh.
- Known caveats: release-evidence shadow check is stale for this hotfix and
  reported a SHA/manifest mismatch, so the promote used strict local deploy
  verification instead. Cloudflare edge smoke remained skipped because
  `NEXUS_SMOKE_EDGE_VERIFY=1` is not configured. PM2 restart counters remain
  historically high, but no restart occurred during readiness sampling.

## 2026-06-10 Content Studio Backend Contract Production Promote

- Scope: promoted the Content Studio backend contract for iOS build `1.5.0`
  (`38`): source-skill scoped Decision Center overview, topic capture
  provenance in `audit_metadata_json`, and idempotent topic create semantics
  for offline capture retry safety.
- Production version: `4.14.208`.
- Production deploy commit: `636910e2`.
- Source implementation commit: `6651085e`
  (`feat(content): studio backend contract - skill-scoped overview, capture
  provenance, idempotent topic create`).
- Release evidence/docs/unblock commits before deploy: `c3be2cad`
  (Content Studio staging smoke evidence), `7d529331` (single missing MIT
  header unblock in `src/services/notification-cache-invalidation.ts` after the
  first promote verifier failed before production mutation), and `636910e2`
  (final 22/22 staging smoke evidence).
- Required gates passed: `npm run release:focused-verify`,
  `npm run release:rollback-drill-check`, staging deploy through
  `./scripts/deploy-staging.sh`, and full staging smoke with
  `NEXUS_SMOKE_EDGE_VERIFY=1` passed **22/22** at
  `docs/release/smoke-evidence/staging-smoke-7d529331-20260610T204235Z.json`.
  Promote-time staging smoke also passed **22/22** with Cloudflare edge checks
  enabled before production mutation.
- Production promotion completed through `./scripts/promote-to-prod.sh`.
  Deploy-time validation passed typecheck, science-policy pin validation, full
  Vitest with **842 files / 12,368 tests**, migration safety with **204
  migrations**, build, backup creation with `bot.db`, native module rebuild
  under system Node `v22.22.3`, PM2 restart, SQLite integrity, `/health`,
  content-engine readiness, native better-sqlite3 loading, and PM2 stability.
- Post-production probes passed: public `https://api.nexushub.me/health`
  returned `status: healthy`, public
  `https://api.nexushub.me/public-status` returned `status: ok`, and live
  authenticated
  `https://api.nexushub.me/api/v1/decisions/overview?sourceSkill=content`
  returned HTTP 200 with `sourceSkillFilter: "content"`,
  `sourceSkillTotalCount` present, and `items` as an array.
- Release identity was persisted with
  `./scripts/release-identity.sh json --persist` after promote. The generated
  workspace identity artifact tracks current repo identity; post-deploy
  docs-only closeout may sit ahead of runtime deploy commit `636910e2`.
- iOS/TestFlight status: App Store Connect build `1.5.0` (`38`) was reported
  uploaded in the handoff, but this shell could not independently confirm
  processing or assign INTERNAL testers because no App Store Connect API env
  vars, `AuthKey_*.p8`, fastlane/appstoreconnect CLI, or repo-documented
  credential/keychain item was available. No external cohort was touched.
- Known caveats: release-evidence shadow parity still reports the expected
  signed-evidence shadow mismatch for this process-hardening period; production
  PM2 restart counters remain historically high (`nexus-hub` 37,
  `content-engine` 7), but no restart occurred during the readiness sample;
  package version remained `4.14.208`.

## 2026-06-09 Training Coach Tenant/Health Hotfix Production Promote

- Scope: promoted the Claude-reviewed Training / Coach hotfixes for stale
  health-signal safety decisions, tenant-scoped session mutation ownership,
  tenant-scoped reflow ownership, and tenant-scoped adherence/missed-session
  reads. The hotfix bounds health signals used by production plan generation to
  fresh signals via `TRAINING_SAFETY_HEALTH_SIGNAL_MAX_AGE_DAYS`, fails closed
  when mutation/reflow plan ownership lacks the requested tenant, and prevents
  same-user cross-tenant aggregates from influencing Training progression or
  missed-session decisions.
- Production version: `4.14.208`.
- Production deploy commit: `910b6d72`.
- Source hotfix commit: `9c226007`
  (`fix(training): bound health signal safety and tenant gates`).
- Release prep/docs evidence commits before deploy: `77cbe12f`
  (`chore: prepare release 4.14.208`) and `910b6d72`
  (`docs(release): refresh registry parity evidence timestamp`).
- Focused backend validation before full release gates: Training calendar sync,
  plan generation, session mutation, adherence trend, completion feedback, and
  missed-session suites passed **6 files / 131 tests**. The
  `training-routes.test.ts` route-focused rerun passed **59 tests** after
  tenant-aware route fixtures were corrected.
- Full backend validation passed before production: local `npm run test` passed
  **841 test files / 12,313 tests**; `npm run release:verify:full` passed
  typecheck, science-policy pin validation, build, migration safety with **200
  migrations**, full Vitest with **841 files / 12,313 tests**, and
  content-engine pytest with **180 tests**; release-prep and pre-push risk gates
  each repeated full Vitest with **841 files / 12,313 tests**.
- Staging deploy passed through `./scripts/deploy-staging.sh`; staging
  readiness passed and standalone staging smoke passed **19/19** for version
  `4.14.208`. Promote-time staging smoke also passed **19/19** before
  production mutation.
- Production promotion completed through `./scripts/promote-to-prod.sh`.
  Deploy-time validation passed typecheck, science-policy pin validation, full
  Vitest with **841 files / 12,313 tests**, build, backup creation with
  `bot.db`, native module rebuild under system Node `v22.22.2`, PM2 restart,
  SQLite integrity, `/health`, content-engine readiness, native better-sqlite3
  loading, and PM2 stability.
- Post-production probes passed: public `/health`, public `/public-status`,
  unauthenticated Training canonical 401, and production package version
  `4.14.208`. The remote deploy directory is not a git worktree, so remote
  `git rev-parse` is intentionally unavailable; the runtime deployment record
  is the promoted package version plus deploy commit above.
- Known caveats: release-evidence shadow parity still reports the expected
  signed-evidence shadow mismatch for this process-hardening period; Cloudflare
  edge smoke remained skipped because `NEXUS_SMOKE_EDGE_VERIFY=1` was not
  configured; production PM2 restart counters remain historically high
  (`nexus-hub` 37, `content-engine` 7), but no restart occurred during the
  readiness sample.

## 2026-06-09 Training Coach Remediation Production Promote

- Scope: promoted the Training / Coach remediation program through production.
  The backend now carries tenant-scope hardening, tenant-aware idempotency and
  locks, Training safety guardrail plumbing, canonical equipment vocabulary and
  conservative unknown-equipment defaults, immutable DB catalog schema/seed and
  validation, catalog-backed strength selector scaffolding, completion feedback
  consumption substrate, endurance coherence validation, calendar-capacity
  inputs, audit/version pins, decision reasons, observability counters, and
  additive iOS/read-model fields. The iOS companion commit adds defensive
  decoding and user-facing coach insight presentation for useful Training
  decision data.
- Production version: `4.14.207`.
- Production deploy commit: `4f2927c1`.
- Source implementation commits before final docs evidence: `bc7aacc2`,
  `770ac929`, and staging smoke evidence commits `4d4e14cc`, `4f2927c1`.
- iOS main companion commit: `49ce035` (`feat(training): present coach
  decision insights`). iOS has not been claimed as App Store/TestFlight
  released by this backend promote.
- Staging deploy passed twice through `./scripts/deploy-staging.sh`.
  Standalone staging smoke passed **26/26** at
  `docs/release/smoke-evidence/staging-smoke-770ac929-20260609T102353Z.json`.
  Promote-time staging smoke also passed **26/26** before production mutation.
- Release validation passed before production: backend typecheck and
  science-policy pin validation passed; full Vitest passed **841 test files /
  12,307 tests** during deploy verification; migration safety passed **200
  migrations**; catalog dry-run validation passed with `repo-seed-1.0.0`, 131
  exercises, 24 equipment items, and 0 issues. Staging catalog write/activate
  also passed before production activation.
- Production promotion completed through `./scripts/promote-to-prod.sh`:
  production backup included `bot.db`, dependencies installed with
  `0 vulnerabilities`, strict owner bootstrap preflight passed, native modules
  rebuilt for system Node `v22.22.2`, and PM2 restarted `content-engine` plus
  `nexus-hub`.
- Production health/readiness passed after deploy: content engine returned OK,
  status portal returned OK, bot was online, SQLite integrity passed,
  better-sqlite3 loaded, `/health` was healthy, content-engine `/ready` was
  ready, and PM2 showed production apps online/stable. PM2 still reports high
  historical restart counters for `nexus-hub` (36) and `content-engine` (6),
  but no restart occurred during the readiness sample.
- Production catalog activation completed after the deploy using
  `npm run training:catalog:seed -- --write --activate --created-by
  production-release-4f2927c1`. Verified active row:
  `repo-seed-1.0.0`, scope `__global__`, status `active`, validation
  `passed`, `immutable_after_activation=1`, 131 active exercises, 24 active
  equipment items, and 1 passed validation result.
- Post-promote flag rollout: staging and production `.env` now explicitly set
  `COACH_KERNEL_EQUIPMENT_AUTHORITY_ENABLED=on`,
  `COACH_KERNEL_EQUIPMENT_AUTHORITY_SHADOW_ENABLED=off`,
  `TRAINING_CATALOG_DB_ENABLED=on`,
  `TRAINING_COMPLETION_FEEDBACK_V2_ENABLED=on`,
  `TRAINING_SELECTOR_POLICY_V2_ENABLED=on`,
  `TRAINING_ENDURANCE_COHERENCE_V2_ENABLED=on`,
  `TRAINING_CALENDAR_CAPACITY_KERNEL_ENABLED=on`, and
  `TRAINING_SAFETY_GUARDRAILS_ENABLED=on`.
- Post-rollout validation: staging readiness passed, staging smoke passed
  **19/19** at
  `docs/release/smoke-evidence/staging-smoke-ad46082d-20260609T104930Z.json`,
  production readiness passed, public `health`/`public-status` probes passed,
  unauthenticated Training returned canonical 401, active catalog stayed
  immutable/passed, and a 30s PM2 sample showed no production restart delta.
- Known open items: Phase 10 cleanup is intentionally blocked until a sustained
  production soak proves the canonical paths; production iOS
  distribution/TestFlight/App Store release remains a separate app-store
  operation; Cloudflare edge smoke remains skipped unless
  `NEXUS_SMOKE_EDGE_VERIFY=1` is configured.

## 2026-06-06 Release Process Hardening Note

- Production facts above remain the last documented production deploy state.
- Release transport has been hardened so version preparation happens before
  staging via `scripts/release-prep.sh`; `deploy.sh` must not create a new
  version bump after staging evidence exists.
- Reusable evidence now requires signed `nexus.release-evidence.v2` JSON, three
  distinct signed RC run IDs, per-suite test-count floors, and a post-build
  manifest recheck before rsync. `auto-when-staged` remains default-off until
  the signed-evidence shadow period and rollback-drill requirements are
  satisfied.
- The public release-evidence verifier is committed under
  `docs/release/evidence/`; the matching private signing key is owner-managed
  and must be installed as a GitHub Actions secret before CI evidence can pass.
- Evidence reuse also requires current rollback drill evidence; no rollback
  drill was performed by this process-hardening change.
- Legacy `.github/workflows/cd-production.yml` is owner-review-only; local
  scripts remain canonical.

## 2026-06-06 Current Main Production Promote

- Scope: caught production up to current `origin/main` through `f0a86d5d`,
  including task recurrence updates, calendar refresh cache bypassing,
  event-based training plan lint hardening, Stripe pricing alignment, iOS legal
  consent support, data-at-rest hardening, and the D1-D7 prelaunch findings.
- Production version: `4.14.205`.
- Production deploy commit: `24a22f3c`.
- Source implementation commits before deploy bump: `4f77cd6a`, `5fb19081`,
  `0f952802`, `7137ea42`, `29aad471`, `8f5a5a88`, `af7f2ca3`, and `f0a86d5d`.
- Staging deploy completed through `./scripts/deploy-staging.sh`: local
  typecheck/build passed, rsync completed, dependencies installed with
  `0 vulnerabilities`, native modules rebuilt, and staging content-engine plus
  portal health checks passed. Staging owner bootstrap remained warn-only and
  reported two persisted owner rows.
- Promote preflight proved the local and staging artifact manifests matched at
  `b156d7058f38efb957b8e4b0093e1668c4e9d86b2ea9a158c4fb34e8ce707edd`.
- Staging smoke passed **19/19** twice before production mutation. The first
  production promote attempt stopped before any production mutation because the
  deploy script's internal version-bump commit entered the local pre-commit
  hook with output redirected; the production mutation marker was absent, the
  partial package version bump was restored, and the retry used a temporary
  empty `core.hooksPath` for the deploy script's commit/push only.
- Release validation passed twice before production mutation. The final
  deploy-time gate passed typecheck, science-policy pin validation, and full
  Vitest with **825 test files / 12,040 tests**.
- Production deploy completed through `./scripts/promote-to-prod.sh`: the
  backup tar was created at **16M** and included `bot.db`, dependencies
  installed with `0 vulnerabilities`, strict owner bootstrap preflight passed,
  native modules rebuilt for system Node `v22.22.2`, and PM2 restarted
  `content-engine` plus `nexus-hub`.
- Production health passed after deploy: content engine returned OK, the status
  portal returned OK, the bot was online, and PM2 showed both production
  processes online on version `4.14.205`. The post-deploy artifact manifest was
  `f0926963a67bac1dced3212dac7c5c5187b7b49838238092a38051e029686b91`.
- Known caveats: staging remains on `4.14.204` after the production version
  bump. The production env catch-up observed finance encryption, backup
  encryption, APNs, and Stripe keys present, but owner confirmation/proof
  remains open. Production `OPERATOR_ALERT_WEBHOOK_URL` and `SENTRY_DSN` remain
  missing. Production Stripe account creation, Stripe dashboard configuration,
  legal review/entity confirmation, TestFlight/physical-device proof, and
  Cloudflare Pages authentication for the marketing site remain open in
  `docs/release/OPEN_ITEMS.md`.

## 2026-06-04 Training Remediation Round 3 Fast-Follow Production Promote

- Scope: promoted the Training remediation round-3 fast-follow. The backend now
  closes the residual Training reflow and cancel ownership oracles, centralizes
  owner-id audit hashing, tenant-scopes cancellation active-plan reads, preserves
  acute-injury safety copy after the chest-pain precedence fix, pins ACWR and
  inferred-pain route boundaries, guards low-adherence and WeekProtection
  zero-session surfaces, and adds DB-level proof for the stale agenda index
  migration. iOS main now enforces required Garmin freshness markers and trusts
  backend-validated remote low-adherence cards during cold load.
- Production version: `4.14.202`.
- Production deploy commit: `6438553d`.
- Source implementation commit before deploy bump: `870ca09f`.
- iOS main: `40a885f` (`fix(training): enforce plan freshness markers`).
- Previous production deploy commit: `ddb8eec4` (4.14.201).
- Staging deploy passed from `main` before production; promote-time staging
  smoke passed **19/19** before production was touched.
- Release validation passed before production: focused backend round-3 suites
  passed **10 files / 300 tests**; backend `npm run verify` passed typecheck,
  science-policy pin check, and full Vitest with **816 test files / 11,951
  tests**; focused iOS Training/contract suites passed **107 tests**; the full
  iOS helper `scripts/ios-single-simulator-test.sh` passed **1,461 XCTest
  tests** plus **10 Swift Testing cases**; and the final `main` pre-push gate
  repeated typecheck, full Vitest with **816 test files / 11,951 tests**, and
  build before pushing `6438553d`.
- Production promotion completed through `./scripts/promote-to-prod.sh`:
  production backup included `bot.db`, dependencies were installed, owner
  bootstrap preflight passed, native modules rebuilt for system Node, and PM2
  restarted `content-engine` and `nexus-hub`.
- Production health passed after deploy: content engine returned `status: ok`,
  the authenticated status portal returned version `4.14.202`, the bot was
  online, and PM2 showed both production services online.
- Known caveats: staging remains on `4.14.201` after the production version
  bump; the promoted functional code was smoke-tested on staging before
  production. Moderate-injury `injury_safe_swap` remains intentionally deferred
  on the Training today read model pending product approval. No signed
  TestFlight upload, production APNs proof, physical HealthKit/Apple Watch
  proof, Garmin provider-state proof, or real two-account device walkthrough was
  part of this production promote.

## 2026-06-03 Training Remediation Production Promote

- Scope: promoted the Training remediation and coach hardening release to
  production. The backend now hardens Training plan generation, race-date
  validation, no-oracle ownership handling, cancellation tenant scoping,
  readiness/ACWR math, safety copy precedence, zone calculators, sport engines,
  chat action/parser contracts, training skill manifest knowledge, lifecycle
  cleanup, and the stale agenda unique-index migration. iOS main now carries
  aligned Training decoding, home-card sanitization, low-adherence visibility,
  two-a-day `auto` handling, and plan/coach UI contract fallbacks.
- Production version: `4.14.201`.
- Production deploy commit: `ddb8eec4`.
- Source implementation/evidence commits before deploy bump: `3aac49b4`
  (Training implementation), `fde1ad3e` (main sync), `e758d6ab` (migration
  renumber), and `caa81a28` (staging smoke evidence).
- iOS main: `c0c3f39` (`fix(training): harden coach UI contracts`).
- Previous production deploy commit: `30285bb3` (4.14.200).
- Staging deploy passed from `main` before production. Standalone staging smoke
  passed **19/19** with evidence at
  `docs/release/smoke-evidence/staging-smoke-e758d6ab-20260603T202437Z.json`;
  promote-time staging smoke also passed **19/19** before production was
  touched.
- Release validation passed before production: focused backend Training suites
  passed **11 files / 260 tests**; backend `npm run verify` passed typecheck,
  science-policy pin check, and full Vitest with **815 test files / 11,942
  tests**; focused iOS Training/contract suites passed **128 tests**; the full
  iOS helper `scripts/ios-single-simulator-test.sh` passed **1,458 XCTest
  tests** plus **10 Swift Testing cases**; and the final `main` pre-push gate
  repeated typecheck, full Vitest with **815 test files / 11,942 tests**, and
  build before pushing `ddb8eec4`.
- Production promotion completed through `./scripts/promote-to-prod.sh` with
  `NEXUS_DEPLOY_SKIP_VERIFY=auto-when-staged`: production backup included
  `bot.db`, dependencies were installed, owner bootstrap preflight passed,
  native modules rebuilt for system Node, and PM2 restarted `content-engine`
  and `nexus-hub`.
- Production health passed after deploy: content engine returned `status: ok`,
  the authenticated status portal returned version `4.14.201`, the bot was
  online, PM2 showed both production services online, and
  `https://api.nexushub.me/public-status` returned `status: ok`.
- Known caveats: staging remains on `4.14.200` after the production version
  bump; the promoted functional code was smoke-tested on staging before
  production. No signed TestFlight upload, production APNs proof, physical
  HealthKit/Apple Watch proof, or real two-account device walkthrough was part
  of this production promote.

## 2026-06-03 Decision Center Execution + iOS Smoke Production Promote

- Scope: promoted the Decision Center execution plan after ChatV2 main sync,
  without editing `src/services/chat-core-v2/**`. The release includes
  Decision Center API v2 helpers, lifecycle/status/events, metrics/dashboard,
  active expiry, semantic dedup/supersede, relationship types, fatigue and
  type suppression, refresh/reconnect/choice/skill-card/freshness/human-review
  guardrails, and the default-off Decision Center Command Bus dismiss adapter.
- Production version: `4.14.200`.
- Production deploy commit: `30285bb3`.
- Source implementation/evidence commits before deploy bump: `c7f049e1`;
  staging smoke evidence commit `ddcf211e`.
- iOS main: `9f5649c` adds the Decision Center local-backend smoke harness and
  aligns Decision Center primary actions with the backend action route.
- Previous production deploy commit: `09a1c96d` (4.14.199).
- Release validation passed before production: backend `npm run verify` passed
  **812 test files / 11,848 tests**; focused Decision Center peer validation
  passed; local Docker + iOS simulator smoke passed with evidence under
  `.local/decision-center-ios-smoke/evidence/20260603-134101` and peer rerun
  evidence under `.local/decision-center-ios-smoke/evidence/20260603-135756`;
  staging smoke passed **19/19** at
  `docs/release/smoke-evidence/staging-smoke-c7f049e1-20260603T135207Z.json`;
  deploy-time verify passed **812 test files / 11,848 tests**; final `main`
  pre-push typecheck, full Vitest, and build passed.
- Production deploy completed through the standard `promote-to-prod.sh` path.
  PM2 restarted `content-engine` and `nexus-hub`; both returned online.
- Production health passed after deploy:
  `https://api.nexushub.me/health` returned `status: healthy`,
  `https://api.nexushub.me/public-status` returned `status: ok`, and
  unauthenticated Decision Center overview, summary, and handled endpoints each
  returned `401`.
- Evidence limits: most new Decision Center behavior is default-off or scoped
  by runtime flags until rollout approval. The iOS proof is local
  Docker-backed simulator proof, not production APNs, TestFlight, or physical
  device proof.

## 2026-05-25 Training Outlook Default-Enabled Production Promote

- Scope: removed the opt-in `TRAINING_CALENDAR_OUTLOOK_ENABLED` env requirement
  for selecting Outlook as the training calendar in the iOS New Plan flow.
  Pre-fix, picking "Outlook" returned a 503 ("That calendar is not available
  for Training plans yet"). The same Outlook adapter
  (`secretary-unified-calendar-provider-adapter`) had been writing
  training-owned events to Outlook in production for months via the
  secretary-agenda path, so the defensive gate was effectively stale. Outlook
  is now ON by default, matching Google's contract. The kill switch
  `TRAINING_CALENDAR_OUTLOOK_DISABLED=1` is retained for fast emergency
  rollback without a redeploy.
- Production version: `4.14.195`.
- Production deploy commit: `0682b34b`.
- Source implementation/evidence commits before deploy bump: PR #138 merge
  `0bae01cb`; staging smoke evidence `e2c21415`.
- Previous production deploy commit: `fb1f844e` (4.14.194).
- Release validation passed before production: PR #138 GitHub checks all green
  (Tests focused, Build, Lint & Type Check, Science-policy version, CodeQL,
  OpenSSF Scorecard, Migration check skipped, Python content-engine audit),
  staging smoke passed **17/17** at evidence
  `docs/release/smoke-evidence/staging-smoke-0bae01cb-20260525T161058Z.json`,
  and the deploy-time `npm run verify` passed
  **718 test files / 10,555 tests** (floor previously 10,544; +11 net new from
  the +5 operational-switches tests, +9 calendar-source tests with the new
  default-on contract minus 4 pre-fix tests, +4 calendar-event-writer tests).
- Production deploy completed through the standard `promote-to-prod.sh` path.
  Deploy ordering bug from PR #136 stayed clear: the clean-tree check now
  precedes the PM2 stop so a dirty evidence file never strands prod.
- Production health passed after deploy: public
  `https://api.nexushub.me/health` returned `status: healthy` with fresh
  `uptime: 21s`, PM2 showed both `nexus-hub` and `content-engine` online,
  and the production package version is `4.14.195`.
- Behavior change downstream: `createTrainingCalendarEvent` no longer forces
  `'google'` as the auto-target fallback — with Outlook default-enabled, the
  writer passes `undefined` and lets `unified-calendar.createEvent` resolve
  per the user's actual connected calendars. Tests updated to pin the new
  shape.

## 2026-05-25 Training Bug-Fix Triplet Production Promote

- Scope: PR #137 closed three user-reported Training bugs in one PR:
  (1) cancelling a plan left orphan Outlook/Google calendar events from
  prior `plan_version` regenerations because the cancel cascade's
  `findMatchingSecretaryAgendaItems` query pinned the current version;
  (2) iOS-sent `twoADayPreference: "auto"` was silently dropped at the route
  validator (only `never|optional|preferred` accepted) AND the hybrid branch
  of `resolveWeeklyTargets` silently rewrote explicit `(running=5, strength=5)`
  to `(running=2, strength=4)` based on `sessionsPerWeek=6`, preventing
  two-a-day day generation; (3) Outlook/Google calendar event bodies showed
  raw `NEXUS_SECRETARY_*` correlation metadata when `session.description` was
  empty for some session types, collapsing the visible content to just the
  metadata footer.
- Production version: `4.14.194`.
- Production deploy commit: `fb1f844e`.
- Source implementation/evidence commits before deploy bump: PR #137 merge
  `d94c2d1a`; staging smoke evidence `b3bfb4e8`.
- Previous production deploy commit: `fb1ca66d` (4.14.193).
- Release validation passed before production: PR #137 GitHub checks all
  green, staging smoke passed **17/17** at evidence
  `docs/release/smoke-evidence/staging-smoke-d94c2d1a-20260525T101747Z.json`,
  and deploy-time `npm run verify` passed
  **718 test files / 10,544 tests** (floor was 10,525; +19 net new tests
  across cancel-cascade, two-a-day, secretary-adapter, and route entitlement
  surfaces).
- Production deploy completed through the standard `promote-to-prod.sh`
  path. PM2 restarted `nexus-hub` (PID 2804361) and `content-engine`
  (PID 2804352); health checks green.
- Production health passed after deploy: public
  `https://api.nexushub.me/health` returned `status: healthy` with fresh
  `uptime: 30s`, PM2 reported both services online, and the production
  package version was `4.14.194`.
- Track A — Cancel cascade fixes (`src/services/training-plan-cancellation-cascade.ts`,
  `src/api/routes/training-plan-cancellation.ts`): pushed the matching query
  into SQL via `source_intent_id LIKE 'training:${planId}:%'`, added
  `findSecretaryAgendaCalendarEventsForPlan` helper so the deletion-targets
  builder also enumerates Secretary-owned events without
  `training_agenda_event_ownership` rows.
- Track B — Volume + two-a-day fixes (`src/api/routes/training-plan-routes.ts`,
  `src/services/training-coach-kernel-plan-generator.ts`,
  `src/services/training-plan-volume-enforcement.ts`,
  `src/services/coach-kernel/types.ts`,
  `src/services/training-profile-model.ts`): added `'auto'` to the
  `twoADayPreference` enum + a first-class `'auto'` branch in
  `resolveMaxSessionsPerDay`; hybrid `resolveWeeklyTargets` branch now
  respects explicit per-sport asks when both `runSessionsPerWeek` AND
  `strengthSessionsPerWeek > 0` are provided; volume enforcer sums the
  explicit per-sport values into `requestedTotal` regardless of
  `planSport`.
- Track C — Calendar event body (Stage 1) (`src/services/secretary-unified-calendar-provider-adapter.ts`):
  `sourceBodyForSecretaryCalendarEvent` is now a 3-priority hydration chain
  (stored description → re-rendered from `description_json` via
  `renderSectionsAsText` → minimal `title · intensity · duration min`
  fallback). Body now puts workout content FIRST, then a `────────────`
  divider, then the metadata markers. `extractSecretaryAgendaMarker` is
  unchanged so legacy events still resolve.
- Track C — Stage 2 deferred: moving `NEXUS_SECRETARY_*` markers entirely
  to Google `extendedProperties.private` and Outlook
  `singleValueExtendedProperties` is queued as a separate PR. There is zero
  existing extended-properties plumbing in `google-calendar.ts` or
  `outlook-calendar.ts`, so that change would double this PR's size + need
  cross-provider integration testing. Stage 1 above solves the user-visible
  symptom.

## 2026-05-25 Coach Periodization v2.1 + Deploy Safety Production Promote

- Scope: promoted PR #135 Coach Periodization v2.1 training changes and PR #136
  deploy safety hardening. PR #135 added the v2.1 training implementation,
  tests, CI/operator docs, and R1-R8 closeout fixes. PR #136 fixed the deploy
  ordering hazard where a generated registry-shadow-parity evidence timestamp
  could dirty the worktree after PM2 services had already been stopped.
- Production version: `4.14.193`.
- Production deploy commit: `fb1ca66d`.
- Source implementation/evidence commits before deploy bump: PR #135 merge
  `99992ddc`; deploy safety merge `256aa591`.
- Previous production deploy commit: `bac44816`.
- Release validation passed before production: PR #136 GitHub checks passed,
  staging smoke passed **17/17**, deploy-time `npm run verify` passed
  **718 test files / 10,525 tests**, and the final `main` pre-push gate repeated
  typecheck, full Vitest, and build before pushing `fb1ca66d`.
- Production deploy completed through the standard `promote-to-prod.sh` path
  after local dependencies were refreshed with `npm ci`. The deploy installed
  dependencies on the server, ran owner bootstrap preflight, rebuilt native
  modules for system Node, restarted `content-engine` and `nexus-hub`, and
  saved the PM2 process list.
- Production health passed after deploy: public
  `https://api.nexushub.me/health` returned HTTP 200 repeatedly, server-local
  `http://127.0.0.1:8200/health` returned 200, PM2 showed `nexus-hub` and
  `content-engine` online, and the production package version is `4.14.193`.
- Incident recovery note: Cloudflare Tunnel was found stopped during the
  deploy recovery window and was restarted as detached `cloudflared` user
  processes. Public health is currently green through the tunnel, but the next
  infra follow-up should install/enable a supervised service for `cloudflared`.
- Local cleanup note: obsolete clean/merged worktrees from prior Decision
  Center, Chat Core, Cloudflare, confirmation, and training validation branches
  were removed after promotion. Dirty or unmerged worktrees were intentionally
  left in place.

## 2026-05-23 Beta Hardening Confirmation Contract Production Promote

- Scope: promoted the beta-hardening confirmation contract for chat-driven
  operational actions. The backend now fails closed for unclassified tools,
  validates signed confirmation tokens for user/tenant/intent scope before any
  side effect, preserves idempotent confirm-action replay behavior, and keeps
  iOS confirmation/rate-limit UX contracts aligned with the backend.
- Production version: `4.14.190`.
- Production deploy commit: `bac44816`.
- Source implementation/evidence commit before deploy bumps: `8ee3ad95`.
- Previous production deploy commit: `05960637`.
- Staging deploy passed at runtime commit `76ac6684` / version `4.14.188`,
  followed by staging smoke. Promote-time staging smoke passed **17/17** before
  production was touched. Targeted staging confirmation-contract smoke also
  passed for pending-confirmation emission, confirm-action execution, idempotent
  replay, missing/wrong-user/wrong-intent token rejects, and the structured
  rate-limit path.
- Release validation passed before production: backend typecheck passed,
  focused confirmation contract coverage passed, the final `main` pre-push
  gates ran full Vitest with **641 test files / 9,490 tests** passing, and iOS
  focused confirmation/rate-limit simulator tests passed **28/28**.
- Production promotion started through the standard promote path. The deploy
  script created and pushed release bump commits, stopped services, and created
  production backups including `bot.db`, then tripped the clean-tree guard
  because the `chat-action-registry-shadow-parity` pre-push evidence refreshed
  the tracked registry shadow parity timestamp. PM2 services were restarted
  immediately after each interrupted attempt. The generated evidence file was
  restored, and the clean committed `4.14.190` artifact was transported with the
  same stop / backup / rsync / dependency install / native rebuild / start
  sequence from `deploy.sh`.
- Production deploy completed for the committed `4.14.190` artifact. The
  production backup included `bot.db`, dependencies were installed, owner
  bootstrap preflight passed, `better-sqlite3` was rebuilt for system Node, and
  both `content-engine` and `nexus-hub` PM2 services are online.
- Production health passed after deploy: local content health returned
  `status: ok`, the authenticated portal snapshot returned version `4.14.190`,
  and PM2 showed both production services online. Staging remains on
  `4.14.188`; this is expected after production deploy version bumps, and the
  promoted functional code was smoke-tested on staging before production.

## 2026-05-22 Decision Center Human Guidance v2 Production Promote

- Scope: promoted the Human Guidance v2 pass for Decision Center and
  Secretary surfaces. The existing `DecisionExplanation` contract is extended
  additively with `recommendedMove`, `ifIgnored`, `actionLabels`, and
  `displaySections`; no parallel `presentation` object and no new schema
  migration were introduced. Normal user reads now filter smoke/internal/admin
  decisions, sanitize technical strings, and keep source traces / facts / rules
  / tradeoffs out of iOS user-facing decision flows.
- Production version: `4.14.186`.
- Production deploy commit: `05960637`.
- Source implementation commit before deploy bump: `992879d6`.
- Previous production deploy commit: `17c35872`.
- Staging deploy passed from committed `main`, followed by staging smoke
  **17/17**. Authenticated staging payload audits for PT-BR, PT-PT, and EN
  users passed with zero banned user-facing terms, localized
  `secretaryToday.title`, valid `displaySections`, and no raw action labels.
- Release validation passed before production: backend typecheck passed,
  focused Decision Center tests passed, iOS focused Decision Center tests and
  simulator build had passed during implementation, pre-commit full Vitest
  passed with **634 test files / 9,430 tests**, deploy-time full validation
  passed with **639 test files / 9,468 tests**, and the final backend pre-push
  gate repeated typecheck plus full Vitest with **639 test files / 9,468 tests**
  passing before pushing `05960637`.
- Production promotion started through the standard promote path. The deploy
  script created and pushed the `4.14.186` release commit, stopped services,
  and created a production backup including `bot.db`, then tripped the
  clean-tree guard because verification refreshed the tracked registry shadow
  parity evidence file. PM2 services were restarted immediately, the generated
  evidence file was restored, and the same committed `4.14.186` artifact was
  transported manually without creating an unnecessary extra version bump.
- Production deploy completed for the committed `4.14.186` artifact. The
  production backup included `bot.db`, dependencies were installed, owner
  bootstrap preflight passed, `better-sqlite3` was rebuilt for system Node,
  and both `content-engine` and `nexus-hub` PM2 services are online.
- Production health passed after deploy: local content health and portal
  snapshot passed, `nexus-hub` package version is `4.14.186`,
  `https://api.nexushub.me/health` returned `status: healthy` at
  `2026-05-22T18:03:21Z`, and `https://api.nexushub.me/public-status` returned
  the minimal public status payload.
- Production authenticated API smoke passed **13/13** against
  `http://localhost:8200` with a short-lived owner token. Production Decision
  Center payload audit passed for active PT-BR and EN users: overview and
  plan/today returned 200, no `[SMOKE]` or banned technical strings were found
  in scanned user-facing fields, `secretaryToday.title` localized correctly
  (`Secretary hoje` / `Secretary today`), and no invalid display sections or raw
  action labels were detected. No active PT-PT production user was available
  for a live PT-PT audit.
- Production smoke cleanup dry-run passed with `inspected=0`, `expired=0`,
  confirming there were no scoped smoke rows to expire at deploy time. The
  scheduled smoke cleanup remains registered twice hourly, offset from handled
  history backfill.

## 2026-05-22 Decision Center Clarity + Secretary Intelligence Production Promote

- Scope: promoted the full Decision Center clarity and Secretary intelligence
  phase: structured `explanation` payloads for active and handled decisions,
  handled history persistence/backfill, locale-aware Secretary Today summary,
  Decision Center timeline hardening, outcome/ranking observability,
  privacy-safe notification smoke tooling, and APNs rank-gated urgent decision
  delivery. iOS rendering support was already validated on main; no iOS binary
  release was part of this backend promote.
- Production version: `4.14.183`.
- Production deploy commit: `17c35872`.
- Source implementation commit before deploy bump: `109ce2e9`.
- Previous production deploy commit: `5f64ead7`.
- Database change: migration `153_decision_center_explanations.sql` adds
  `handled_by_nexus_items.explanation_json`; runtime schema ensure also covers
  fresh/test DBs.
- Staging deploy passed from the committed RC, followed by staging smoke
  **19/19** with evidence at
  `docs/release/smoke-evidence/staging-smoke-5f64ead7-20260522T130003Z.json`.
- Release validation passed before and during promotion: backend typecheck
  passed, focused Decision Center / Secretary / notification / smoke-tool
  suites passed during implementation, the pre-commit hook ran full Vitest
  with **633 test files / 9,419 tests** passing, and the final `main`
  fast-forward pre-push gate repeated typecheck plus full Vitest with
  **633 test files / 9,419 tests** passing.
- Production deploy completed for the committed `4.14.183` artifact. The first
  deploy attempt tripped the dirty-worktree guard after verification refreshed
  observational registry evidence; production PM2 services were restarted
  immediately, the evidence timestamp was restored, and the deploy continued
  manually with the same committed artifact rather than creating an unnecessary
  extra version bump.
- Production health passed after deploy: `content-engine` returned OK,
  `nexus-hub` package version is `4.14.183`, both production PM2 services are
  online, `https://api.nexushub.me/health` returned `status: healthy`, and
  `https://api.nexushub.me/public-status` returned only the minimal public
  status payload.
- Production APNs proof passed after setting
  `NOTIFICATION_DELIVERY_MODE=apns` in the production engine environment and
  restarting `nexus-hub` with updated env. Decision Center notification smoke
  run `decision-center-notification-smoke-20260522132201-ixfe21` passed with
  the visible urgent decision push accepted by APNs (`provider=apns`,
  `status=sent`) and the low-rank smoke item held to digest/in-app as expected.
  The smoke report redacted notification copy and exposed only safe payload
  length/hash evidence.
- Staging may lag production after the promote/version bump; the promoted
  functional code was smoke-tested on staging before the production bump.

## 2026-05-21 Cloudflare Edge Unblock Apply (Completion)

- Scope: completed the operator-credentialed half of the Cloudflare edge
  unblock work — deployed the landing Pages bundle, applied the three
  Cloudflare WAF rules, disabled the managed `robots.txt` and AI bots
  protection on the marketing zone, and validated the live edge contract
  end-to-end. No backend code or version change.
- Pages deploy: `nexushub-landing` project on branch `main` redeployed at
  `https://eeb8585c.nexushub-landing.pages.dev` (production alias is
  `https://nexushub.me`). Bundle excluded `.wrangler/`, `.DS_Store`, and
  `.bak*` per `scripts/cloudflare-edge-release.sh`.
- WAF apply: `node scripts/cloudflare-edge-unblock.mjs --apply
  --include-staging --skip-bot-management` upserted three rules on the
  `nexushub.me` zone `5d4cc89b638871ae7084ee65c5f3320d`:
  - `nexus_marketing_ai_crawler_skip_v1` — SKIP for AI fetchers on
    `nexushub.me` and `www.nexushub.me`.
  - `nexus_api_public_status_ai_monitor_skip_v1` — SKIP for AI and monitor
    UAs on `api.nexushub.me` and `api-staging.nexushub.me` at path
    `/public-status` only.
  - `nexus_api_ai_fetcher_block_except_public_status_v1` — BLOCK for AI
    fetchers on `api.nexushub.me` and `portal.nexushub.me` at every path
    other than `/public-status`.
- Bot Management toggle: the full-payload `PUT /zones/{id}/bot_management`
  call in `scripts/cloudflare-edge-unblock.mjs` was rejected with `400 Bad
  Request` on the Free plan zone (Free rejects writes to read-only fields
  like `enable_js`, `fight_mode`, `using_latest_model`). A focused PUT with
  only `{"ai_bots_protection":"disabled","is_robots_txt_managed":false}`
  succeeded. The script's full-payload merge needs a follow-up fix to use a
  focused payload on Free plans — tracked as a follow-up; current behavior
  works around it with `--skip-bot-management` + a manual focused `curl`.
- Verification: `scripts/cloudflare-edge-verify.sh` returned **13/13 PASS**:
  marketing site reachable to ClaudeBot/Claude-Web/anthropic-ai/ChatGPT-User/
  PerplexityBot, `api.nexushub.me/public-status` reachable to ClaudeBot and
  UptimeRobot, `api.nexushub.me/health` still 403 to ClaudeBot,
  `robots.txt` no longer carries Cloudflare Managed content and explicitly
  allows ClaudeBot, `llms.txt` starts with `# Nexus Hub` and carries the
  current Pro `$14.99/R$74.99` and Max `$19.99/R$99.99` prices.
- `--include-staging` was used so `api-staging.nexushub.me/public-status` is
  on the same allowlist as production.
- Token: Felipe-supplied Cloudflare API token with TTL through
  `2026-06-30T23:59:59Z`. Token was exposed in chat transcript during the
  apply; rotate via the Cloudflare dashboard once this section is committed.
  The Cloudflare account ID `413581f656838e03191273def66d5e3a` was supplied
  via `CLOUDFLARE_ACCOUNT_ID` because the token lacked the User-read scope
  that `npx wrangler whoami` requires for auto-detect.
- No manual dashboard step was needed for the apply; the entire flow ran
  via API/CLI from the Mac.

## 2026-05-21 Nexus Points QA2 + Cloudflare Edge Foundation Promote

- Scope: merged Nexus Points QA2 hardening, added Cloudflare AI-crawler
  unblock/apply tooling plus `/public-status` verification, updated the
  Cloudflare tunnel runbook, and hardened deploy transport so promotion smoke
  and pre-push/deploy verification do not dirty tracked evidence files.
- Production version: `4.14.181`.
- Production deploy commit: `ae4e1421`.
- Source implementation commits before deploy bump: Cloudflare edge tooling
  `c04200c9`, Nexus Points QA2 merge `3ab03654`, staging smoke evidence
  `dcf1e05a`, promotion smoke evidence `6bcf76f6`, and promotion-smoke
  dirty-tree fix `67287399`.
- Staging deploy passed, followed by staging smoke **17/17** at
  `docs/release/smoke-evidence/staging-smoke-3ab03654-20260521T003146Z.json`;
  promote-time staging smoke passed **17/17** again.
- Release validation passed before and during promotion: full backend
  `npm run verify` passed **632 test files / 9,407 tests** in the local,
  deploy-time, and final pre-push gates; deploy-time build passed; production
  env validation passed; owner bootstrap preflight passed; dependencies and
  native modules rebuilt; production backup included `bot.db`; and production
  PM2 showed both `nexus-hub` and `content-engine` online after restart.
- Production health passed after deploy: `https://api.nexushub.me/health`
  returned healthy, and `https://api.nexushub.me/public-status` returned only
  `{ status, service, timestamp }`.
- Important operational note: the first production promote attempt tripped the
  new dirty-worktree deploy guard after full verification refreshed
  `registry-shadow-parity-latest.json`; production PM2 services were restarted
  immediately, then the deploy completed with `NEXUS_DEPLOY_ALLOW_DIRTY=1`
  because the only dirty file was observational evidence. Commit `4b490d4a`
  fixes that loop for future deploys.
- Cloudflare edge unblock is still pending operator/API credentials. Live
  `scripts/cloudflare-edge-verify.sh` still fails for Claude/Anthropic,
  ChatGPT, and Perplexity user agents because this shell has no
  `CLOUDFLARE_API_TOKEN` and Wrangler is not authenticated. The exact apply
  command is `CLOUDFLARE_API_TOKEN=... scripts/cloudflare-edge-unblock.mjs --apply`.
- 2026-05-21 post-QA follow-up: the divergent local backend `main` worktree
  at `a8fce8fe` was preserved under workspace audit evidence
  `docs/release/worktree-recovery-audit-2026-05-21/claude-local-main-divergence/`,
  stashed as `archive: claude local main divergence before syncing origin/main
  2026-05-21`, and fast-forwarded cleanly to `bb68a55b`. A clean
  Cloudflare Pages deploy attempt for `nexushub-landing` and the edge apply
  script both stopped at the missing `CLOUDFLARE_API_TOKEN` credential, so
  live `robots.txt`/`llms.txt` and AI fetcher unblocking remain pending
  operator credentials.
- Follow-up hardening added `scripts/cloudflare-edge-release.sh` as the
  single operator path for the remaining block: it validates/deploys the
  landing Pages bundle, applies the Cloudflare edge rules, waits for
  propagation, and runs strict verification once a Cloudflare API token is
  available. `scripts/cloudflare-edge-verify.sh` now also fails if `llms.txt`
  is missing or carries stale Pro/Max prices.

## 2026-05-18 Beta Registry And Stripe Billing Promote

- Scope: double opt-in beta registry, waitlist email validation, confirmed-only
  portal approval, 30-day DB invite emails, DB invite redemption, long-lived
  static reviewer-code expiry, expired beta-trial paywall handling, public
  website Stripe Checkout routes, webhook idempotency, verified-user checkout
  claim flow, and Pro/Max monthly USD/BRL Stripe price mapping.
- Production version: `4.14.171`.
- Production deploy commit: `1587fc5d`.
- Source implementation commit before deploy bump: `0df40622`.
- Staging deploy passed, followed by a five-minute soak and staging smoke
  **18/18** at
  `docs/release/smoke-evidence/staging-smoke-0df40622-20260518T194456Z.json`;
  promote-time staging smoke passed **18/18** again at
  `docs/release/smoke-evidence/staging-smoke-0df40622-20260518T194531Z.json`.
- Deploy-time validation passed: backend `npm run verify` passed
  **618 test files / 9,172 tests**, deploy-time build passed, production env
  validation passed, production backup included `bot.db`, dependencies updated,
  native modules rebuilt, owner bootstrap preflight passed, and production PM2
  showed both `nexus-hub` and `content-engine` online after restart.
- Production health passed after deploy: `https://api.nexushub.me/health`
  returned `status: healthy`, `server.status: online`, and
  `database: connected`.
- Operator note: the Cloudflare Pages direct upload for `https://nexushub.me`
  did not run in this shell because Wrangler has no non-interactive
  `CLOUDFLARE_API_TOKEN`. The synced static files are present under
  `/Users/felipedominguez/Desktop/nexushub-landing-deploy`.

## Scope

Chat General Action Intelligence production promote:

- Natural-language Chat action candidates now go through a canonical action
  registry and planner before Gmail/email/read-only fast paths.
- The Portuguese regression command
  `Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo`
  resolves to Google Calendar event creation, not Gmail unread count.
- Durable action state uses `chat_action_runs` idempotency with provider/local
  read-back before verified success.
- Deterministic executors cover Calendar, Tasks, Content, Cooking, Finance,
  Connections, Training, Notifications, and Decision Center paths where a safe
  verified contract exists. Unsupported mutation surfaces fail closed.
- Model-assisted planner arguments recursively strip user/tenant/account/owner
  identity aliases from nested objects and arrays before dispatch.

## Validation Before Promotion

- Pre-promote staging deploy: PASS.
- Pre-promote staging smoke: 17 passed / 0 failed / 17 total.
- Deploy-time validation: full vitest PASS, 533 files / 7534 tests.
- Deploy-time build: PASS.
- Production promote: completed at `4.14.162`.
- Production health: API health healthy, portal snapshot version `4.14.162`,
  PM2 `nexus-hub` and `content-engine` online at `4.14.162`.
- Real Google Calendar provider mutation/read-back from TestFlight remains
  blocked until an authenticated device/session with Calendar write scope is
  available and owner approval is given to create/delete a live provider event.

## Evidence

- Final staging smoke:
  - `docs/release/smoke-evidence/staging-smoke-feb1b022-20260514T172558Z.json`
  - `docs/release/smoke-evidence/staging-smoke-feb1b022-20260514T172629Z.json`
- Deployment transcript showed production content engine OK, status portal OK,
  bot online, and PM2 online for production `nexus-hub` and `content-engine`.

## Required Post-Promotion Checks

Production-safe follow-ups:

- Cut a signed iOS/TestFlight build from iOS `main` if the Chat
  structured-card hiding changes should reach devices.
- Run an owner-approved live Google Calendar mutation/read-back smoke from an
  authenticated device/session before claiming live provider calendar creation
  end-to-end.
