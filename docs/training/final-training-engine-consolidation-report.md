# Final Training Engine Consolidation Report

Date: 2026-04-28  
Backend branch assessed: `feature/training-engine-eval-harness`  
Backend head at assessment start: `d0d0c41` plus local Training workstream changes  
iOS readiness branch referenced: `feature/ios-training-frontend-engine-readiness`  
Production deploy: not performed

## 1. Executive Decision

The Training engine is no longer a shallow template generator. It now has a credible coach-kernel architecture with explicit catalog metadata, session coherence validation, profile normalization, feedback analysis, biomechanics-aware substitutions, agenda ownership hardening, cross-skill signals, and an evaluation harness that can be rerun.

The decisive recommendation is:

**Use `feature/training-engine-eval-harness` as the primary backend merge candidate after final review and cleanup. Do not use Claude's branch directly as the primary candidate. Do not promote to production until the high open risks in agenda/session identity and travel-week capacity are fixed or explicitly accepted.**

This is the strongest branch because it contains the useful Claude foundation plus Codex second-opinion corrections, subsequent domain-depth/profile/adaptation/lifecycle/cross-skill/eval work, and final red-team fixes. It also has the benchmark framework needed to stop future regressions.

## 2. What Is Now Production-Strong

| Area | Production-strong now? | Evidence | Judgment |
| --- | --- | --- | --- |
| Time-volume coherence | Yes | Final eval `time_volume_coherence = 100`; regression tests cover sparse and overstuffed strength sessions. | Strong enough for production review. |
| Strength session credibility | Yes | Coherence gate, sparse-session repair, red-readiness technique trimming, richer catalog. | The original "48 min for tiny work" class is fixed at engine level. |
| Catalog depth foundation | Yes | Expanded strength, running, cycling templates and exercise metadata. | Good foundation; still not exhaustive, but no longer thin. |
| Biomechanics/substitution guardrails | Yes | Equipment, pain, fatigue, complexity, spinal loading, and short-window logic are represented and tested. | Production-credible as a non-medical safety layer. |
| Feedback/autoregulation pipeline | Mostly yes | Typed feedback analysis, recent-session normalization, difficulty/adherence/readiness decisions, coherence after duration cuts. | Strong backend layer; UI capture still lags. |
| Evaluation/benchmark harness | Yes | `156` persona-scenario cases; final score `99/100`; dimension scoring and docs exist. | Strong enough to become a release gate. |
| Warning dedupe / decision trail | Yes | Final eval `warning_quality_deduplication = 100`; decision-trail tests. | Product should be less noisy. |

## 3. What Is Improved But Still Risky

| Area | Current State | Risk | Decision |
| --- | --- | --- | --- |
| Plan lifecycle and agenda sync | Ownership table, exact orphan reconciliation, scoped deletion, calendar sync tests exist. | Regenerated sessions can still reuse IDs after shape changes; travel overload can leave unscheduled sessions. | Improved but still high-risk until identity/version hardening lands. |
| Travel-week schedule resilience | Short-window capping works; scheduler no longer blindly overflows windows. | Travel persona with too few windows still exceeds max sessions in benchmark and can have missing times. | Must fix before claiming "boringly reliable." |
| Poor-recovery variety | Intensity downshifts and role-preserving titles improved. | Recovery weeks can collapse into repeated recovery signatures, especially cycling and travel cases. | Medium risk; acceptable only if framed as next iteration. |
| Profile follow-up visibility | Normalized profile and profile quality exist. | Weak-profile warnings can be lost in some scenario combinations. | Needs follow-up warning promotion. |
| iOS frontend readiness | iOS can decode richer contracts, dynamic blocks, plan version/status, unknown enum values, richer feedback payload. | Rich feedback UI and fixture-backed modality UI tests are not complete; live simulator saw old generic data. | Ready as compatibility layer, not final Training UX. |
| Cross-skill orchestration | Training consumes/expresses Secretary, Cooking, Finance, Content signals. | Runtime end-to-end cross-skill smoke remains limited. | Solid backend contract, still needs product smoke. |

## 4. What Remains Open

High-priority open risks:

1. Final availability capacity reconciliation for overloaded travel/poor-recovery weeks.
2. Session identity/version semantics for regenerated plans where session shape changes.
3. Staging Google/Outlook provider smoke for create, cancel, regenerate, and orphan retry.
4. iOS runtime smoke for richer plan/session tags, dynamic blocks, agenda statuses, and stale-plan cleanup.

Medium-priority open risks:

1. Poor-recovery role variety for cycling/hybrid/travel users.
2. Explicit schedule-compression explanation when volume drops because availability shrank.
3. Stronger surfacing of weak-profile/follow-up questions.
4. Rich iOS feedback UI: partial completion, actual duration, RPE/RIR, soreness/fatigue, discomfort, substitutions.
5. Visual fixture tests for gym, running, cycling, and hybrid weeks.

## 5. Architecture Quality

Verdict: **Strong, but merge carefully.**

The engine now has explicit layers rather than one template path:

- `coach-kernel` planning and modality engines
- catalog knowledge under `knowledge/`
- `session-coherence.ts` for deterministic strength time validation
- `feedback-analysis.ts` for typed adaptation decisions
- `training-profile-model.ts` for normalized profile quality
- `biomechanics-and-ordering.ts` for safer selection/substitution
- lifecycle/agenda services for ownership and reconciliation
- evaluation harness under `coach-kernel/evaluation/` and `src/tools/training-eval-harness.ts`

This is the right direction. The main architectural concern is that final schedule capacity reconciliation and plan identity/version ownership still need one more hardening slice.

## 6. Coach-Intelligence Quality

Verdict: **Materially improved and now credible.**

The coach now reasons across:

- profile constraints
- modality targets
- session roles
- training history
- recovery/readiness
- adherence
- pain/equipment constraints
- schedule windows
- cross-skill signals

The engine is not yet a complete professional coaching platform. It still needs stronger recovery-week variety, richer periodization semantics, and better schedule-compression explanations. But it is no longer just "template plus copy."

## 7. Catalog Depth

Verdict: **Strong foundation.**

Strength, running, cycling, and hybrid domains all have improved depth:

- strength variants across lower, upper, full-body, support, posterior-chain, trunk, unilateral, max-strength/hypertrophy roles
- running key-session rotation and support-session variety
- cycling threshold/tempo/VO2/cadence support
- deterministic novelty rather than randomization
- richer exercise metadata and substitution families

Remaining gap: recovery mode needs more role-preserving variants, especially for cycling and travel users.

## 8. Profiling Quality

Verdict: **Good backend model; UI/product loop still needs work.**

The backend now normalizes questionnaire answers into profile fields, quality scores, missing critical data, and follow-up prompts. This is a real model, not raw questionnaire storage.

Remaining gap: weak-profile follow-up prompts are not consistently prominent in final plan notes, and iOS still needs a dynamic profile/follow-up editing flow.

## 9. Adaptation Quality

Verdict: **Strong for deterministic backend adaptation; product UX needs catch-up.**

The engine handles:

- low recovery and soreness downshifts
- poor adherence/re-entry
- too-long/too-hard/too-easy feedback
- plateau variation
- schedule compression
- short-window caps
- repeated substitution review

Remaining gap: some large volume drops need clearer explanation, and UI feedback capture is still too narrow compared with backend capability.

## 10. Metrics / Feedback Quality

Verdict: **Backend strong enough for beta; data capture remains the bottleneck.**

Recent completions and training history are normalized into typed recent sessions. The feedback analyzer produces structured decisions and applies them before final guardrails.

Remaining gap: the app must capture richer feedback, and production data must be monitored to ensure users actually provide enough signal for the adaptation layer.

## 11. Biomechanics / Substitution Quality

Verdict: **Production-credible as a safety-aware selection layer.**

Substitution considers equipment, pain/discomfort, fatigue, user level, complexity, spinal loading, movement pattern, session role, and short-window fit. It is intentionally not a medical diagnosis system.

Remaining gap: continue expanding metadata coverage and test additional discomfort/equipment combinations as catalog grows.

## 12. Plan Lifecycle And Agenda Sync Quality

Verdict: **Improved, but still the highest production-trust risk.**

Strong improvements:

- agenda ownership rows
- active/orphaned/deleted transitions
- exact orphan reconciliation
- scoped ownership transitions
- stale linked event cleanup
- cross-plan deletion protection

Open risk:

- regenerated sessions can reuse IDs after material shape changes
- overloaded travel weeks can leave unscheduled active sessions
- live provider smoke is still required

Do not claim final calendar reliability until those are closed.

## 13. iOS Frontend Readiness

Verdict: **Ready as a compatibility layer; not finished as a rich Training UX.**

iOS readiness work supports:

- plan ID/version/status
- richer week-session lifecycle fields
- dynamic session blocks
- tolerant enum decoding
- richer exercise metadata
- richer completion feedback payload
- safer calendar sync response decoding

Open iOS needs:

- rich completion/feedback UI
- fixture-backed UI tests for gym/running/cycling/hybrid weeks
- per-session agenda sync/error display once backend consistently returns it
- runtime smoke with `availability_capped`, `availability_reflowed`, and `availability_unscheduled`

## 14. Cross-Skill Orchestration Quality

Verdict: **Good contract-level foundation.**

Training now has explicit bridges for:

- Secretary schedule stale/conflict signals
- Cooking fueling-gap risks
- Finance budget constraints
- Content workload/milestone context

This is the right ownership model. It still needs end-to-end staging smoke where peer skills publish signals and Training reflows or explains decisions.

## 15. Test Coverage And Benchmark Quality

Verdict: **Strong and unusually useful.**

Latest red-team evidence:

- `npm run eval:training -- --out-dir reports/training-red-team --week-start 2026-04-27 --fail-under 75`
- Result: `99/100`, `156` cases
- Latest JSON: `reports/training-red-team/training-eval-2026-04-28T01-40-32-426Z.json`

Focused Training regression slice:

- `17` files passed
- `224` tests passed

The benchmark is now a real release gate, not a toy snapshot suite. Keep it required before future Training engine merges.

## 16. Top Remaining Risks

| Rank | Risk | Severity | Why It Matters |
| --- | --- | --- | --- |
| 1 | Regenerated session identity can reuse IDs after shape changes | High | Can pollute agenda diffing and stale calendar cleanup. |
| 2 | Travel-week capacity overload | High | Users with constrained weeks can still see too many active sessions or missing times. |
| 3 | Live provider agenda behavior not smoke-tested after latest changes | High | Calendar trust depends on real Google/Outlook behavior, not only mocks. |
| 4 | iOS rich runtime rendering not fully smoke-tested | Medium | Backend can emit richer states than older UI paths were built around. |
| 5 | Poor-recovery variety collapse | Medium | Recovery weeks can feel repetitive and less intelligently coached. |
| 6 | Weak-profile prompts can be under-surfaced | Medium | The engine may know it needs data but not ask visibly enough. |
| 7 | Rich feedback capture not yet user-facing | Medium | Backend adaptation quality depends on data the UI may not collect yet. |

## 17. Next High-Leverage Improvements

1. Implement final availability capacity reconciler: explicit defer/optional/recovery placeholder for overflow sessions.
2. Harden regenerated session identity with plan version plus shape hash or role revision.
3. Run staging provider smoke for agenda create/cancel/regenerate/orphan retry.
4. Add iOS fixture and simulator smoke for rich Training payloads.
5. Add recovery-week variant catalog for cycling, running, and strength technique days.
6. Promote weak-profile follow-ups to durable warnings with UI-ready metadata.
7. Add rich feedback capture in iOS and ensure backend persists every field used by adaptation.

## 18. Final Recommendation

**Merge candidate:** `feature/training-engine-eval-harness`

**Merge target:** review/integration first, then `main` only after high-risk gates.

**Production recommendation:** not yet. The engine is strong enough to be the primary candidate, but production promotion should wait for:

1. schedule overload fix
2. regenerated identity fix
3. full backend typecheck/test
4. staging Google/Outlook smoke
5. iOS runtime smoke against rich Training payloads

