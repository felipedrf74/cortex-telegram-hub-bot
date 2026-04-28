# Final Training Engine Open Risks

Date: 2026-04-28

## Risk Register

| ID | Severity | Area | Risk | Evidence | Required Action | Release Gate |
| --- | --- | --- | --- | --- | --- | --- |
| FTR-001 | High | Schedule resilience | Overloaded travel/poor-recovery weeks can retain too many active sessions or missing calendar times. | `travel-week-hotel-gym__poor-recovery` scored `92`; penalties for max sessions and missing times. | Add final capacity reconciler that converts overflow to explicit deferred/optional/recovery state with guardrail explanation. | Required before production. |
| FTR-002 | High | Agenda lifecycle | Regenerated sessions can reuse IDs when the session shape changed. | Plan-cancel-regenerate scenarios report reused IDs for changed shapes. | Add plan-version plus stable shape hash/role revision to agenda-owned identity. Preserve IDs only for materially equivalent sessions. | Required before production. |
| FTR-003 | High | Provider trust | Latest agenda lifecycle path has not been live-smoked against real Google/Outlook providers. | Tests pass, but docs still require staging provider smoke. | Run staging create/sync/cancel/regenerate/orphan-retry smoke. | Required before production. |
| FTR-004 | Medium | iOS rendering | Rich backend payload states have not all been runtime-smoked in iOS. | iOS docs say compatibility layer exists; red-team notes no simulator smoke in backend-only pass. | Run iOS simulator with rich fixtures and live payloads. | Required before TestFlight confidence. |
| FTR-005 | Low | Recovery coaching quality | Poor-recovery variation now has deterministic role-preserving variants, but orange-readiness calibration still needs beta feedback. | `docs/training/poor-recovery-variation.md` and `__tests__/services/coach-kernel-poor-recovery-variation.test.ts` cover cycling, hybrid, strength, travel, repeated weeks, and warning dedupe. | Add dedicated orange-readiness and running-only follow-up tests if beta feedback shows the downshift is too conservative. | Not a blocker after this slice; monitor during beta. |
| FTR-006 | Low | Profile follow-up UX | Backend now exposes structured profile confidence and targeted follow-up prompts, but iOS still needs to render and persist prompt answers. | `docs/training/weak-profile-followup-prompts.md`, `docs/training/profile-confidence-model.md`, and `__tests__/services/training-profile-model.test.ts` cover weak-profile detection, risk flags, conservative planning, prompt dedupe, and confidence improvement after answers. | Add iOS rendering and durable prompt-resolution storage. | Backend blocker closed; remains an app/product follow-up. |
| FTR-007 | Medium | Feedback loop data | Backend can use richer feedback, but iOS UI still does not collect enough of it. | iOS open items list rich feedback UI as high priority. | Add partial completion, actual duration, difficulty, soreness/fatigue, discomfort, substitutions, notes. | Should precede claiming "adaptive coach." |
| FTR-008 | Low | Schedule-compression explainability | Backend now emits structured decision reasons for compression, reflow, unscheduled sessions, weekly caps, and recovery-driven volume/intensity reductions. | `docs/training/schedule-compression-explanations.md`, `docs/training/decision-reason-model.md`, and focused tests cover evidence-based explanation generation and dedupe. | Add route-level serialization tests and iOS rendering for `decisionReasons`. | Backend blocker closed; remains an app/contract hardening follow-up. |
| FTR-009 | Medium | Cross-skill runtime behavior | Cross-skill contracts exist, but end-to-end runtime signal flow needs smoke. | Backend tests cover shared decision context; no full product smoke cited. | Staging smoke: Secretary conflict, Cooking fueling gap, Finance budget constraint, Content workload. | Should precede public beta. |
| FTR-010 | Low | Catalog breadth continuation | Catalog is stronger but will need ongoing expansion. | Current eval is high; remaining recovery variants are the main breadth gap. | Continue adding tested archetypes and substitutions. | Not a blocker. |

## Production Blockers

The following are true blockers for production promotion:

1. FTR-001 schedule capacity reconciliation.
2. FTR-002 regenerated session identity.
3. FTR-003 real provider agenda smoke.

## Beta Blockers

For a beta where Training is visible and users will trust the calendar:

1. FTR-001
2. FTR-002
3. FTR-003
4. FTR-004
5. FTR-006 iOS rendering/persistence if onboarding/profile completeness is part of the beta funnel
6. FTR-007 if "adaptive coach" is part of the beta promise

## Not Blockers, But High Leverage

- FTR-005 orange-readiness recovery calibration
- FTR-008 iOS/API route hardening for schedule-compression explanations
- FTR-009 cross-skill runtime smoke
- FTR-010 catalog continuation

## Risk Acceptance Position

Do not accept FTR-001 or FTR-002 silently. They sit directly on the user's trust boundary: "what should I do, and is it correctly on my calendar?" A coach can survive imperfect recovery wording. It cannot survive stale or misleading schedules.
