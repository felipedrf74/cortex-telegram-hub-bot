# Agent Handoff — Training Phase 0 iOS prototype and design validation

## Milestone 6 planning boundary — 2026-07-13

Milestone 6 now has a proposed executable architecture boundary at
`docs/adr/0007-training-external-execution-and-optional-authority-boundaries.md`.
The proposal keeps the immutable user-approved Nexus revision authoritative;
treats WorkoutKit as an asynchronous owned projection, live execution as
separate observed history, and HealthKit as optional permission-gated evidence;
and requires imported, coach-authored and user-authored content to enter as
untrusted provenance-bearing candidates before validation and user approval.
Adaptive notifications cannot apply changes, and animation/video remains a
versioned derivative of approved text-first exercise media.

The ADR proposes independent default-off controls, additive same-scope records,
idempotent external ownership/read-back, privacy/retention/deletion review,
flags-first rollback and separate acceptance criteria for each optional family.
Current iOS evidence is deliberately narrow: the release app has the HealthKit
entitlement and a read-only `HealthKitService` with an empty write-type set, but
there is no WorkoutKit adapter/import or live workout state machine in the
repository. No integration code, schema, entitlement, permission, analytics,
notification, production flag or external effect was added or enabled by this
planning update.

ADR-0007 remains **PROPOSED**, not accepted. Each optional family still requires
its own approved implementation plan, privacy/product/domain decisions, signed
TestFlight and physical iPhone/Apple Watch evidence where applicable, staging
flag-off parity, rollback/compensation proof and explicit owner activation.
Simulator/build evidence cannot close those gates. Milestone 6 therefore
remains unsupported/default-off and outside the current production claim.

Planning-boundary verification: the focused docs-taxonomy regression passed;
the canonical workspace mirror reports in sync; and the post-change docs audit
improved from the pre-change 1,594-issue baseline to 1,569 issues with no
ADR-0007, workspace-mirror or new broken-reference warning. Advisory docs
reward: **PASS**, score 100, run
`880b57d5-1a4f-4805-91ec-697f21c1d376`; no hard failures or skipped mandatory
checks. This is documentation/process evidence only and does not satisfy any
platform, privacy, device, TestFlight or production gate.

## Current execution checkpoint — 2026-07-12

**Maximum current claim**: Phase 0 remains complete; M1 backend draft-PR CI is green; M1 iOS draft PRs are open but their Actions jobs did not start; M2/M5 foundations are local/default-off only; staging with flags off is authorized but held. There is no merge, staging, migration execution, deployment, TestFlight, active production flag, media publication, or production behavior claim.

### Integration and staging

- Backend prerequisite PR [#159](https://github.com/felipedrf74/cortex-telegram-hub-bot/pull/159) is green. Draft M1 PR [#160](https://github.com/felipedrf74/cortex-telegram-hub-bot/pull/160) has a green workflow-dispatch run at exact head `0201037b6e5ea661c2ee37ac2602454d26cabd97`; neither PR is merged. Local final pre-push evidence was 897 files / 13,148 tests.
- iOS prerequisite PR [#6](https://github.com/felipedrf74/nexus-hub-ios/pull/6) and M1 PR [#7](https://github.com/felipedrf74/nexus-hub-ios/pull/7) are open and unmerged. Actions never reached checkout or a test runner because GitHub reported: “The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings”.
- Felipe authorized a staging-only migration rehearsal/deploy with flags off, but it is held until clean iOS prerequisite CI can start and pass. No staging write, migration, deploy, smoke, TestFlight action, provider/calendar write, or production action occurred.

### Gate scope

The exact 2026-07-11 second-gate statement remains recorded later in this handoff and in `/Users/felipedominguez/Developer/Nexus Hub IOS/worktrees/training-prototype-20260710/Nexus Hub/TrainingPrototypeReviewPackage/TrainingProductionImplementationPlan.md`; it approves Milestone 1 engineering/non-production staging only. Subsequent authorization permits M1 draft-PR integration, flags-off staging after clean prerequisites, and local/default-off M2/M5 foundations. It does not approve merge, waive the iOS CI prerequisite, approve candidate media, enable a production flag, or authorize production.

### Local/default-off foundations

- M2 backend commit `db10a0de`: 65 focused / 13,156 full tests. M2 iOS commit `7cbe965a`: 69/69 and Debug build; flag `NO`. This is local engineering evidence only.
- M5 identity freezes exactly 158 canonical IDs under `training-exercise-identity-catalog.v1`, source hash `50ed5bdd523af02dcd36cd258f195d144e3a4ee86aaed8dcf057fe45532e0ed8`. `floor_press` is historical compatibility for `dumbbell_floor_press`; `jumping_lunge` is canonical.
- M5 backend media independent audit passed after closing the composite manifest-replacement scope P2. Current evidence: 905/905 files and 13,249/13,249 tests, focused 69/69, post-fix migration 11/11, migration safety 220. The package is DRAFT, 0 approved, and not activated.
- M5 iOS final exact-source gate is **PASS, 0 P0/P1/P2, high confidence**. Audit history is preserved: the first re-audit closed its original four findings but found three adjacent P2s; final remediation closed all seven. Final evidence is 49/49 focused (`/tmp/nexus-m5-adjacent-p2-focused-v7.xcresult`), 2,124/2,124 signed full (`/tmp/nexus-m5-final-v8-full.xcresult`), Debug UI 1/1 and RWT UI 1/1 (`/tmp/nexus-m5-final-v8-ui-{debug,rwt}.xcresult`), with zero failures/skips. Debug/Release/RWT builds, 19-file parse, plist/project lint and diff check pass; flags remain `NO/NO/NO`, zero Training media is bundled, approved origins are `api.nexushub.me` and `media.nexushub.me`, and plain Release has no fixture/testing seams. Residual notes: no literal process-kill/filesystem-crash run; second remap after provisional recovery lacks a dedicated test; programmatic v1 batch encoding symmetry is not tested because production only decodes.

### Full-catalog media boundary

- Immutable revision `training-media-eligibility-identity-v1-50ed5bdd-draft-v5` selects 158 primaries plus 42 provisional supplementals: 200 mappings over 196 unique candidate objects. Final adversarial visual review rejected ambiguous `seated_leg_curl-v2` and promoted the contracted posterior-calf DRAFT primary.
- External v2 index: 202 content-addressed objects and 334,770,671 unique bytes, including one historical compatibility object and five review sheets. Manifest SHA-256: `88cf2eecc52cc9b3e5a20844d931f74bb21433a13fe4cb1f9b82a9eb1a90e391`; artifact-index SHA-256: `83098cba6a58e9f75ab9c69b6e4b50551a953e77718d9e6f0f12b9719d87c88c`; validator SHA-256: `afec1234ecdc5603eb809995a89288e9be420bf757eda9e9fc475156f4e2399f`.
- Candidate validation passes with zero errors. Production validation returns the expected FAIL with zero structural/identity errors and exactly six open gates: training-domain, legal/license, accessibility, owner/publication, EN/PT-PT/PT-BR localization, and approved host/origin.
- Metadata-only proof began with 0 PNGs, created 206 targets from 202 objects, then verified 206 exact targets with 0 created; deliberate collision refusal exited 1. Production-approved coverage remains 0/158 and required-view policy remains provisional. Historical Phase 0 PNGs must not be pushed or promoted; the future catalog branch is metadata-only and binaries remain external.

### Current advisory rewards

- Backend M5 independent audit: `MANUAL_REQUIRED`, score 69, run `a20478bd…`, before the root handoff.
- iOS M5 independent final gate: PASS, 0 P0/P1/P2, high confidence.
- Media catalog: `WARN`, score 81, run `b1aef54d-d1b2-4f79-97f7-345b075a4155`.
- Root advisory reward: `MANUAL_REQUIRED`, score 88, run `48f7f0c7-bef0-41ce-8c7c-e5dbd6a0a0e2`, no hard failures. Four mandatory checks and optional L2 `verify-deliverable` passed; mandatory `release-verification-evidence` is skipped/manual-review-required because staging smoke is absent and held. This expected release gap does not weaken the exact-source iOS PASS or close the six media human gates.
- Canonical workspace docs audit: exit 0 with exactly 1,594 existing issues in `/tmp/training-docs-audit-20260712-final-v8.json`. Do not substitute the reward worktree's 601-warning mirror audit for this count.

## Historical snapshot — Phase 0 and local-only M1 checkpoint

The remainder of this handoff preserves the accepted Phase 0 evidence and the earlier local-only M1 snapshot. Statements below that say no branch had been pushed or staging was not yet authorized describe that earlier checkpoint and are superseded by the current section above.

**Date**: 2026-07-12
**Repository**: `/Users/felipedominguez/Developer/Nexus Hub IOS/worktrees/training-prototype-20260710/Nexus Hub`
**Branch/base**: `codex/training-prototype-20260710` from verified iOS `origin/main` `8c48d7a`
**Selected concept**: `TrainingPrototypeReviewPackage/Concepts/Option2-Phase-Journey-390x844.png`
**Status at this historical checkpoint**: Phase 0 locally committed and green; source-verified 158-ID raw-union media candidate catalog locally committed but production-fail-closed; Milestone 1 backend and iOS local implementation complete and verified on fresh branches; no push, migration execution, staging/production deploy, TestFlight action, provider/calendar write, or production flag change had yet occurred

Felipe selected the second of exactly three 390 × 844 concepts and then approved all nine demonstrated prototype decisions. The current source implements the isolated, fixture-driven SwiftUI prototype and review package. After the independent QA remediation and green Stage 3 evidence, the separate production plan's second gate was approved for **Milestone 1 engineering/non-production staging only**. Felipe then accepted the design/additive-migration checkpoint and confirmed the local commit plan. Phase 0 and Milestone 1 are now committed locally on their isolated branches; staging, migration execution, Milestones 2–6 and every production promotion remain gated.

## What is implemented

- A `#if DEBUG` prototype root selected only by `-NEXUSTrainingPrototypeReview`, plus DEBUG startup isolation before notification/HealthKit startup work. Production startup remains on `RootView`.
- DEBUG-scoped models, fixture repository, transformations, routes, screens, and prototype-only media under `Nexus Hub/Prototypes/TrainingReview/`.
- Immutable local plan revisions with creation-context version and approval state; proposals and approvals create new local identities instead of mutating approved fixtures.
- Exact adaptation scopes `SESSION`, `WEEK`, `PHASE`, `FULL_PLAN`; ordered block priorities `ESSENTIAL`, `RECOMMENDED`, `OPTIONAL`; typed strength/endurance/interval/mobility/swim/cycling/mixed/recovery/unknown prescriptions.
- Five plan-linked persona profiles: four required/core personas plus a dedicated maintenance profile. A separate scenario-scoped substitution input snapshot is intentionally excluded from persona and plan counts.
  - Maya: beginner, general fitness, 3 × 30, home/no equipment.
  - Theo: same goal, experienced, 5 × 60, gym/broad equipment.
  - Alex: event date, full modalities, calendar conflict.
  - Rui: returning shift worker, two weekly windows with a 35-minute ceiling, one 35-minute strength session plus one 20-minute mobility session, travel constraints, permissions denied, and offline media.
  - Theo maintenance: explicit maintenance goal, temporary 3 × 60 capacity.
- Phase-aware event, continuous/general-fitness, maintenance, and return-to-training plans; standalone/unknown workouts omit inappropriate phase UI.
- Structured workout detail and exact before/after review for busy, tired, substitution, calendar conflict, and plan approval flows; candidate, phase, and active-plan reviews expose linked workouts before approval.
- Purposeful equipment- and exclusion-driven substitutions, eligible only against the explicit profile/input context displayed in the review.
- Phase-specific target distributions remain distinct from the separately labeled composed candidate-week mix.
- Repository-backed coverage of all 21 canonical `SessionType` values with type-specific fixtures/reusable renderer routes, plus an explicitly non-canonical `mixed_session` and honest `future_modal_xyz` fallback.
- Ten prototype-only instructional illustrations covering all nine prescribable prototype identities, with primary, start/end, alternate, loading, retry, missing, offline-cached, and removed states; written/accessibility content survives media failure.
- A separate production-media candidate inventory for all 158 current raw reachable stable IDs: 158 manifest entries, PNGs, provenance records and unique hashes; 19-file backend source verification; denominator recomputation; reproducible sync/candidate/production/render scripts; primary and remediation contact sheets; production eligibility remains false.
- A separate production plan containing the required `Training Plan Generation, Phases, Workout Quality and Adaptation` section and full profile-to-ongoing-adaptation pipeline. Its exact 2026-07-11 gate record authorizes Milestone 1 engineering/non-production staging only; no production promotion is authorized.
- Authorized Phase 0 local commits: `45bbeeb` (`feat(training): add isolated Phase 0 review prototype`), `fe61f7e` (`test(training): cover Phase 0 review contracts and workflows`), and `a47e7fd` (`content(training): add source-verified exercise media candidate catalog`).
- Milestone 1 backend local commits `a35d3dae` and `73e65318` on `feature/training-plan-revision-v1`: additive unexecuted migration 228, default-off capability/rollout boundary, immutable encrypted snapshots/revisions, Decision-bound approval, compare-and-swap activation, compatibility projection/outbox, `LEGACY_ACTIVE` backfill and fail-closed mixed-rollout behavior.
- Milestone 1 iOS local commit `b7f11c11191a3d474159737d831b9e45c9ba750f` on `codex/training-plan-revision-v1-ios`: production capability/revision models, exact registry/unknown fallback, eight-step creation and immutable review, authoritative Decision reconciliation, legacy read-only behavior, secure attempt persistence, deep-link/writer gating, localization and tests.

## Final source facts that replaced stale review-package copy

### Busy-day strength example

- Current duration: 60 minutes; shortened duration: 30 minutes; scope `SESSION`.
- Optional Conditioning 5 and Cooldown 3 are removed first.
- Recommended Accessory work 14 is removed.
- Recommended Preparation reduces 10 → 2.
- Essential Primary work remains 28 minutes and retains the primary objective.
- Split is suppressed at 30 minutes and feasible at 40 minutes, where Part 1 contains 10 minutes preparation + 28 minutes essential work.

### Tired-day reduce-volume example

- Duration 60 → 46 minutes; scope `SESSION`.
- Preparation 10 → 7.
- Primary 28 → 21 and 4 → 3 sets.
- Accessory 14 → 10 and 3 → 2 sets.
- Optional 5 + 3 minutes remain; load/intensity/exercises remain unchanged.
- Evidence is explicit self-report only; no diagnosis or silent broader adaptation.

### Event current week and conflict

- Monday strength 18:00; Tuesday threshold run 07:00; Wednesday technique swim 07:00; Thursday rest; Friday threshold ride 15:00; Sunday brick 18:00.
- Conflict proposal moves Friday 15:00 → 17:00 at `WEEK` scope, preserving Thursday rest and 49 hours before Sunday’s brick.

## Verification truth

### Current source

- Final definition/execution count: 54 prototype unit-test methods and 23 prototype UI-test methods.
- Final-source XCTest passed: 54/54 unit and 23/23 UI with zero failures. Result bundles are `/tmp/nexus-training-prototype-final2-unit-20260711.xcresult` and `/tmp/nexus-training-prototype-final2-ui-20260711.xcresult`.
- Fresh-derived-data Debug, Release, and ReleaseWithTesting simulator builds succeeded. Product isolation is 10/0/0 prototype assets, 1/0/0 launch markers, and zero prototype strings/type strings in both non-Debug products.
- Swift parse, project lint, tracked-patch `git diff --check`, runtime-boundary scan, changed-file containment, and checkout-isolation checks passed. Untracked prototype/review files are separately inventoried and covered by parse, asset, media, or screenshot validation.
- The final rendered matrix contains 48 captures: 47 across iPhone 17 Pro, iPhone 17 Pro Max, and iPad Pro 11-inch plus one exact 390 × 844 comparison capture. All 48 hashes are unique. The clean-install pt-PT evidence visibly shows `outubro de 2026`; corrected mobility, media resilience, and mutually exclusive conflict actions are visible.
- Product Design comparison against both Option 2 and the current Training baseline passed with no remaining P0/P1/P2 issue.
- The source-verified production-media candidate validator passes 158 entries/images/provenance/unique hashes, verifies 19 backend source files, and recomputes 131 seed + 47 emergency − 20 overlaps = 158 with no missing/extra IDs or source/structural errors. Independent emitter review found 67 finite literal names with 35 unresolved plus dynamic/opaque paths, so 158 is complete only for the raw stable-ID union. The production-mode validator intentionally fails closed with zero structural/source errors and 964 blockers until emitter closure, `floor_press`, taxonomy/template/unbounded prescription paths, aliases, required views, domain, rights, localized accessibility, hosting/removal and owner-approval gates complete.
- Native-resolution review initially classified 126 pass, 21 review and 11 regenerate. All 11 anatomy/grip/machine/cable/equipment/identity defects were regenerated and re-inspected; the current result is 137 direct primary passes plus 21 explicit supplemental-teaching-view requirements.
- Candidate originals are committed locally in `a47e7fd` and add roughly 256 MiB to the local branch. They are not configured for Git LFS or durable object storage. Do not push or publish this branch until Felipe approves the storage/publication approach.
- The prototype process was terminated and the retained iPhone 17 Pro, iPhone 17 Pro Max, and iPad Pro 11-inch review simulators were shut down without erase/delete; the temporary 390 × 844 comparison simulator remains absent.

### Milestone 1 local engineering

- Backend worktree `/Users/felipedominguez/.codex/worktrees/training-plan-revision-v1-backend`, branch `feature/training-plan-revision-v1`, commits `a35d3dae` and `73e65318`. It is based on local backend `main` `67989b36`, already five commits ahead of `origin/main`; resolve the intended integration base before any push.
- Backend selected full risk gate passed 896/896 files and 13,141/13,141 tests; focused gate passed 18/18 files and 454/454 tests; typecheck and migration safety passed. The follow-up fail-closed dependency regression passed 5/5, typecheck, and its focused commit hook.
- Final backend advisory reward after documentation closeout: **PASS, 100**, four mandatory checks passed, zero hard failures/skips, run `b9d247d9-1a5a-435f-9d82-3654bc9f0856`; export still requires manual human review. The immediately preceding documentation audit exited 0 with 601 pre-existing workspace warnings. This local verdict does not supply missing staging or production evidence.
- iOS worktree `/Users/felipedominguez/.codex/worktrees/training-plan-revision-v1-ios`, branch `codex/training-plan-revision-v1-ios`, commit `b7f11c11191a3d474159737d831b9e45c9ba750f`.
- iOS Debug/Release/ReleaseWithTesting builds pass and all three built rollout flags are `NO`. Focused unit 41/41, risk unit 78/78, and 200 unique classifier-selected unit tests pass. Revision UI 3/3 passes; classifier-selected UI reports 2 pass, 0 fail, and 1 explicit skip because its local engine was unavailable.
- iOS Verifiable Reward Loop: **PASS, 100**, run `5ed54e62-c262-41c7-a0d4-6a6fc35fcc51`.

### Historical only

- Current Training baseline: 1/1 passed.
- Prototype unit subset: 20/20 passed.
- Prototype UI subset: 12/12 passed.
- These XCTest results predate the latest source changes and are not final-source proof. Exact xcresult paths are retained in `TrainingPrototypeReviewPackage/Verification.md`.

### Remaining external evidence

No signed-device VoiceOver, TestFlight, CDN/low-data/offline stress, training-domain content approval, rights/license review, localized accessibility review, staging, or production evidence is claimed. Candidate generation does not satisfy those gates.

## Isolation and ownership

- Phase 0 itself added no backend route, API, schema, production model, analytics event, HealthKit read, calendar write, production Training behavior, or live workout lifecycle.
- The original dirty iOS/backend Decision Center work must not be copied, stashed, edited, cleaned, or discarded.
- Felipe authorized the recorded local Phase 0 and Milestone 1 commits after the review gate and commit-plan checkpoint. Original dirty checkouts remained untouched; implementation lives in isolated worktrees/branches.
- No push, migration execution, staging/production deploy, TestFlight action, provider/calendar write, production flag change, or release-state update is authorized or claimed.

## Review gate

Primary review: `TrainingPrototypeReviewPackage/README.md`.

Felipe’s prototype feedback is in `TrainingPrototypeReviewPackage/PrototypeFeedback.md`. Current-source visual acceptance passed after comparison against both Option 2 and the current Training baseline.

The separate production plan is `TrainingPrototypeReviewPackage/TrainingProductionImplementationPlan.md`. Its final gate record and Milestone 1-only scope must be read directly; Milestones 2–6 and every production promotion remain separately gated.

Recorded verbatim on 2026-07-11:

> contingent on Stages 1–3 completing with every confirmed finding remediated and re-verification green, I approve `TrainingPrototypeReviewPackage/TrainingProductionImplementationPlan.md`, as amended in this session, under its second mandatory approval gate — scoped to Milestone 1 "Smallest safe end-to-end production slice" only. Milestones 2–6 remain gated per the plan's own release-scope grouping.

Historical checkpoint at the time of this snapshot: review the local Milestone 1 branch bases/integration plan and explicitly authorize any migration rehearsal/execution or staging deployment. The current draft-PR and held-staging state is recorded at the top of this handoff.

## Milestone 1 design/migration checkpoint and local implementation

The existing production plan contains the accepted checkpoint contract. Local migration `228_training_plan_revision_v1.sql` is additive and unexecuted; the implementation adds encrypted profile snapshots, plan families/revisions, immutable approval receipts, CAS active references and scoped operation claims; backfills existing plans as `LEGACY_ACTIVE` without changing schedules/calendar ownership; reuses the generic `event_outbox`; binds activation to the current Decision review/action lifecycle; and implements the additive API, off/shadow/active gates, iOS capability/repository/deep-link boundaries, telemetry and flags-first rollback.

Backend and iOS code now exists on the fresh local branches and commits recorded above. Milestone 1 refuses to replace `LEGACY_ACTIVE`, performs no synchronous provider/calendar write, and cannot promote to production while the Milestone 5 identity/media gate remains closed. The next action is not broader coding by implication: it is owner review of branch integration/base, migration rehearsal evidence, staging scope, and rollout prerequisites.

## Maximum current claim and limits

**Maximum claim: L2 local build/test/static/simulator evidence for Phase 0 and Milestone 1.** Phase 0 remediation and local Milestone 1 implementation are complete on their recorded branches. The generated full-catalog media is candidate evidence only. No L4 staging, L5 production, signed-device, TestFlight, training-science/content approval, live Decision Center integration, migration execution, or deployed production behavior is claimed.

## Verifiable Reward Summary

- **Phase 0 iOS verdict**: PASS, score 100, run `930f52c2-424a-47b8-9cde-9d2e74515150`; 5/5 mandatory checks and L2 handoff hygiene passed with no hard failures/skips.
- **Milestone 1 iOS verdict**: PASS, score 100, run `5ed54e62-c262-41c7-a0d4-6a6fc35fcc51`.
- **Milestone 1 backend advisory verdict after documentation closeout**: PASS, score 100, run `b9d247d9-1a5a-435f-9d82-3654bc9f0856`; four mandatory checks passed with zero hard failures/skips. Export remains manual-human-review-only, and absent staging/release evidence means this must not be upgraded to production readiness.
- **Changed-area evidence**: Phase 0 classifier/build/isolation proof passed; Milestone 1 backend risk gate, typecheck and migration safety passed; Milestone 1 iOS classifier-selected unit/UI evidence and three-configuration builds passed with the one explicit local-engine-unavailable UI skip recorded above.
- **Skipped checks and reasons**: the final Milestone 1 iOS classifier UI run had one explicit AppWide-responsiveness skip because the local Nexus engine at `127.0.0.1:8200` was unavailable; its alternate rapid bottom-tab responsiveness test passed. The backend and Phase 0 reward runs had no skipped mandatory checks.
- **Evidence commands**: fresh Debug/Release/ReleaseWithTesting `xcodebuild`; `assetutil`; binary `strings`; Swift parse; PBX lint; `git diff --check`; full prototype XCTest; Milestone 1 focused/risk/classifier suites; backend `risk-gate.sh`, typecheck and migration safety; simulator capture/inspection; source-verified 158-entry media validation; `npm run docs:audit`; `verify-deliverable.mjs --claim L2`; advisory reward checks
- **Evidence artifacts**: `TrainingPrototypeReviewPackage/`, `TrainingPrototypeReviewPackage/ClaudeCodeQAPrompt.md`, final build/XCTest logs and result bundles, 48 simulator captures, viewport-matched visual comparisons, the 158-entry source-verified candidate catalog, local Milestone 1 commits, this handoff, and ignored raw reward runs
- **Export eligibility**: manual human review required; no export requested
- **Prompt/process improvement**: preserve revision identity, block priority, adaptation scope, and evidence freshness as first-class review concepts
