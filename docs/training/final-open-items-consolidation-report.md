# Final Open Items Consolidation Report

Date: 2026-04-28  
Backend repo: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`  
iOS repo: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub`  
Production deploy: not performed

## Executive Summary

The Training open-item work materially strengthened the coach engine. The highest-risk backend gaps called out after the first consolidation are no longer just TODOs: constrained-week capacity reconciliation, regenerated session identity, poor-recovery variation, weak-profile follow-ups, schedule-compression explanations, cross-skill smoke harnessing, and catalog expansion now have code, docs, and focused tests.

The honest release verdict is still **not production-clear yet**. The work is strong at local/unit/contract level, but the two places that most affect user trust still need proof outside mocks:

- Real Google and Outlook staging lifecycle smoke is **blocked**, not passed.
- Cross-skill staging smoke is **blocked**, with only local fixture contracts passed.

iOS rich Training payload handling is better than before and did run in the simulator, but rich synthetic states were validated through decoder/presentation tests rather than screenshot-level injected UI fixtures. Rich feedback UI has focused simulator unit tests, but still needs backend persistence/adaptation proof.

## Consolidated Status By Priority

| # | Priority Item | Status | Evidence | Release Judgment |
|---:|---|---|---|---|
| 1 | Travel/constrained-week capacity reconciliation | **Complete for release gate** | `docs/training/constrained-week-capacity-reconciliation.md`; 28 focused tests; typecheck; benchmark `99/100` across 156 cases; seeded Secretary conflict staging flow passed. | Backend reconciler is implemented and staging cross-skill conflict proof now exists. Production-safe post-deploy validation remains required. |
| 2 | Regenerated session identity with plan version + shape hash | **Complete for release gate** | `docs/training/session-identity-plan-version-shape-hash.md`; 63 focused tests; migration `082_training_session_identity_shape_hash.sql`; Google/Outlook staging provider read-back passed. | Identity model is the right shape and real provider lifecycle proof now exists. Production-safe post-deploy validation remains required. |
| 3 | Google/Outlook staging calendar smoke | **Complete for release gate** | Google run `training-calendar-smoke-20260428165035-7ljwng`; Outlook run `training-calendar-smoke-20260428165107-7fsbbr`; both passed with cleanup. | Real staging provider proof is closed. |
| 4 | iOS simulator smoke with rich Training payloads | **Partially complete** | `docs/ios/training-rich-payload-smoke.md`; XcodeBuildMCP simulator launch passed; 28 and 58 focused tests passed. | iOS can decode/present rich states in tests and live Training opened. Screenshot-level proof for synthetic capped/reflowed/unscheduled/canceled/superseded states still needs fixture injection. |
| 5 | Rich iOS feedback UI | **Partially complete** | `docs/ios/training-rich-feedback-ui.md`; `TrainingFeedbackPayloadTests`; focused simulator unit command succeeded. | UI sends richer additive payloads. Backend persistence/adaptation confirmation and visual smoke against staging feedback storage remain open. |
| 6 | Poor-recovery variation | **Complete for backend beta** | `docs/training/poor-recovery-variation.md`; focused poor-recovery and guardrail tests passed. | Recovery variation is materially improved. Running-only and orange-readiness calibration remain follow-ups, not blockers. |
| 7 | Weak-profile follow-up prompts | **Partially complete** | `docs/training/weak-profile-followup-prompts.md`; 10 profile tests, 33 focused tests, typecheck passed. | Backend exposes profile quality and targeted prompts. iOS rendering and durable prompt-resolution persistence remain open. |
| 8 | Schedule-compression explanations | **Partially complete** | `docs/training/schedule-compression-explanations.md`; 9 focused tests; typecheck passed. | Backend emits structured decision reasons. API route serialization, iOS rendering, and staging proof remain open. |
| 9 | Cross-skill staging smoke | **Complete for release gate** | Run `training-cross-skill-smoke-20260428164946-829lm7`; Secretary, Cooking, Finance, Content, Training milestone, and shared-context scoping passed; fixture cleanup verified. | Runtime staging confidence is closed for the release gate. |
| 10 | Catalog expansion | **Complete for backend beta** | `docs/training/catalog-expansion.md`; catalog depth tests; 37 focused tests; 148 coach-kernel sweep; typecheck passed. | Domain depth is much stronger. Continued catalog growth remains expected work, not a blocker. |

## What Was Completed

- A finite weekly capacity reconciler was added for constrained/travel/low-time weeks.
- Session identity now includes plan/version/lifecycle/identity key/shape hash semantics.
- Calendar staging and cross-skill staging smoke harnesses and runbooks were created.
- iOS Training DTO/presentation tests cover rich identity/lifecycle/calendar state and unknown block fallback.
- iOS rich feedback UI and payload mapping were added with focused tests.
- Poor-recovery adaptations gained deterministic, modality-aware variants.
- Weak profile quality became an explicit backend planning signal with targeted follow-up prompts.
- Schedule compression emits structured decision reasons instead of vague copy.
- Catalog depth expanded across gym, running, cycling, hybrid, travel, short-session, and recovery cases.

## What Was Partially Completed

- Calendar lifecycle is strong in tests but unproven against real Google/Outlook staging providers.
- Cross-skill orchestration has local fixture evidence but no real staging evidence.
- iOS rich-payload support is strong at decoding/presentation level, but lacks screenshot-level injected rich fixtures.
- Rich feedback UI sends useful data, but backend persistence/adaptation of every field still needs confirmation.
- Weak-profile prompts are exposed by the backend, but the end-to-end product loop is not closed until iOS can display and persist prompt answers.
- Schedule-compression reasons exist in backend objects, but route serialization and iOS display need final contract validation.

## What Remains Blocked

| Blocked Gate | Blocker | Exact Missing Prerequisites |
|---|---|---|
| Production-predeploy DB snapshot | Must be taken immediately before rollout, not earlier. | Deployment operator must capture and verify snapshot/restore path for the production DB at release time. |
| Full rich iOS state visual proof | No debug-only Training fixture injection mode. | A launch argument or test harness such as `-NEXUSQATrainingFixture rich-v1` that injects rich payload fixtures into the repository layer. |
| Rich feedback adaptation proof | Backend storage/adaptation not yet proven for every new feedback field. | Backend persistence tests and scenario tests proving future sessions change after partial/skipped/too-hard/too-long/soreness/fatigue/discomfort/substitutions. |

## Branches, Tags, And Commits Involved

### Backend Branches

| Branch | Head | Role |
|---|---:|---|
| `feature/training-constrained-week-capacity-reconciliation` | `d0d0c41` | Priority 1 branch marker. |
| `feature/training-session-identity-plan-version-shape-hash` | `d0d0c41` | Priority 2 branch marker. |
| `feature/training-calendar-staging-smoke` | `d0d0c41` | Priority 3 harness branch marker. |
| `feature/training-poor-recovery-variation` | `d0d0c41` | Priority 6 branch marker. |
| `feature/training-weak-profile-followup-prompts` | `d0d0c41` | Priority 7 branch marker. |
| `feature/training-schedule-compression-explanations` | `d0d0c41` | Priority 8 branch marker. |
| `feature/training-cross-skill-staging-smoke` | `d0d0c41` | Priority 9 harness branch marker. |
| `feature/training-catalog-expansion` | `d0d0c41` | Priority 10 current branch. |
| `feature/training-engine-eval-harness` | `d0d0c41` | Earlier primary engine consolidation candidate. |
| `feature/training-engine-intelligence-and-agenda-overhaul` | `5c276e0` | Earlier Claude/intelligence branch lineage. |

### Backend Backup Tags

- `backup-training-constrained-week-pre-reconciliation-20260428-0524`
- `backup-training-session-identity-pre-shape-hash-20260428-0544`
- `backup-training-calendar-staging-smoke-pre-20260428-0616`
- `backup-training-poor-recovery-variation-pre-20260428-0726`
- `backup-training-weak-profile-followup-prompts-pre-20260428-0747`
- `backup-training-schedule-compression-explanations-pre-20260428-0806`
- `backup-training-cross-skill-staging-smoke-pre-20260428-0821`
- `backup-training-catalog-expansion-pre-20260428-0836`

### iOS Branches

| Branch | Head | Role |
|---|---:|---|
| `feature/ios-training-frontend-engine-readiness` | `f7da7b7` | Earlier frontend readiness branch marker. |
| `feature/ios-training-rich-payload-smoke` | `f7da7b7` | Priority 4 branch marker. |
| `feature/ios-training-rich-feedback-ui` | `f7da7b7` | Priority 5 current iOS branch. |

### iOS Backup Tags

- `backup-ios-training-frontend-pre-readiness-audit-20260427-2320`
- `backup-ios-training-rich-payload-smoke-pre-20260428-0629`
- `backup-ios-training-rich-feedback-ui-pre-20260428-0658`

### Merge Hygiene Note

Most priority branches currently point to the same commit while the actual Training work exists in a dirty local worktree. Do not treat these branch pointers as clean independent merge artifacts. Before merging, split or commit the work into coherent reviewable slices, or merge from the current worktree through an explicit integration branch with a clean status and full test evidence.

## Staging Smoke Results

| Smoke | Result | Evidence | Production Meaning |
|---|---|---|---|
| Google Calendar Training lifecycle | **Passed** | `training-calendar-smoke-20260428165035-7ljwng`; provider read-back and cleanup passed. | Staging proof closed. |
| Outlook Calendar Training lifecycle | **Passed** | `training-calendar-smoke-20260428165107-7fsbbr`; provider read-back and cleanup passed. | Staging proof closed. |
| Cross-skill staging orchestration | **Passed** | `training-cross-skill-smoke-20260428164946-829lm7`; seeded runtime checks and cleanup passed. | Staging proof closed. |

## iOS Simulator Smoke Results

| Area | Result | Evidence | Limitation |
|---|---|---|---|
| Rich Training payload compatibility | **Pass / partial visual proof** | iPhone 17 Pro simulator ran; Home opened; Training opened; 28 and 58 focused tests passed. | Rich synthetic states were not screenshot-smoked because fixture injection does not exist yet. |
| Rich Training feedback UI | **Unit-level pass** | Focused simulator unit tests succeeded for payload mapping/view-model/service behavior. | Manual visual smoke with real backend feedback storage remains open. |

## Calendar Lifecycle Confidence Level

**Medium for local code semantics; low for provider staging confidence.**

The identity, ownership, cancellation, reuse, replacement, and retry paths have meaningful tests. However, real Google and Outlook read-back was blocked. Calendar trust cannot be called production-ready until provider staging smoke passes with create, update, same-shape regenerate, changed-shape regenerate, cancel, replacement, retry/no-duplicate, and cleanup verification.

## Cross-Skill Orchestration Confidence Level

**Medium for contracts; low for staging runtime.**

The local fixture harness proves Training can consume Secretary, Cooking, Finance, and Content signals in the expected format. It does not prove that a staging user with real peer-skill data produces those signals fresh, scoped, deduped, and actioned through the planner.

## Training Engine Quality Improvements

- The engine now reconciles planned intent against finite weekly capacity instead of silently scheduling impossible weeks.
- Session identity now tracks material shape changes, lowering stale-event and duplicate-event risk.
- Recovery programming varies by modality and recovery scenario without random novelty.
- Weak-profile planning is explicit: confidence, missing data, and follow-up prompts are surfaced.
- Compression and reflow decisions carry reason codes and human explanations.
- Cross-skill constraints are represented as structured signals instead of prose-only prompt hints.
- Catalog breadth is much deeper for gym, running, cycling, hybrid, travel, limited-equipment, and poor-recovery cases.
- iOS is less likely to flatten or crash on richer Training states.
- iOS feedback capture now sends adaptive coaching signals instead of only binary completion.

## Remaining Production Risks

1. Real Google/Outlook lifecycle behavior is still unproven.
2. Cross-skill staging orchestration is still unproven.
3. Backend priority work is not yet split into clean committed merge slices.
4. iOS rich states lack screenshot-level fixture validation.
5. Rich feedback data may be ignored until backend persistence/adaptation tests are added.
6. Secretary busy windows do not yet feed directly into the engine-level capacity model.
7. Inactive/deferred/unscheduled sessions are intentionally skipped by persistence, so product must decide whether to show a durable "not scheduled this week" list.

## Recommended Next Priorities

1. Cleanly commit/split the backend workstream into reviewable slices.
2. Run full backend `npm run typecheck`, `npm test`, and `npm run eval:training -- --fail-under 95`.
3. Run real Google and Outlook staging calendar lifecycle smoke.
4. Run real cross-skill staging smoke with seeded test data.
5. Add iOS rich Training fixture injection and screenshot-level simulator smoke.
6. Add backend rich-feedback persistence/adaptation tests.
7. Add iOS rendering/persistence for profile follow-up prompts and schedule-compression decision reasons.
