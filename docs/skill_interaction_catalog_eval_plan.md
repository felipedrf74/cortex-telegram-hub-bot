# Skill Interaction Catalog — Eval Plan (Retrospective)

_Phase 15 batch 80 (2026-05-16): retrospective record of the eval gates that protect the catalog._

## Per-action minimum eval coverage (Phase 15 batch 79)

Hard gates enforced by [`__tests__/services/registry-per-action-minimum-eval-gate.test.ts`](../__tests__/services/registry-per-action-minimum-eval-gate.test.ts):

| Requirement | Threshold | Result |
|---|---|---|
| Every active action has ≥ 1 golden example | 45/45 | PASS |
| Every external_side_effect action has ≥ 1 prompt_injection example | 100% | PASS |
| Every destructive action has ≥ 1 ambiguous OR prompt_injection example | 100% | PASS |
| Every financial action has prompt_injection example + strong_confirm policy | 100% | PASS |
| Every active action has ≥ 2 examples total | 45/45 | PASS |
| Every active skill has ≥ 1 example | 10/10 | PASS |

## Real-eval CI gates (Phases 7-14)

Real-eval scoring uses actual planner-trace output rather than the default-score harness. Pinned thresholds at [`__tests__/services/registry-real-eval-gates.test.ts`](../__tests__/services/registry-real-eval-gates.test.ts) and [`__tests__/services/registry-real-eval-gates-locale.test.ts`](../__tests__/services/registry-real-eval-gates-locale.test.ts):

| Gate | Threshold | Phase added |
|---|---|---|
| Golden scenarios pass rate | ≥ 95% | Phase 7 close |
| Adversarial scenarios pass rate | ≥ 95% | Phase 7 close |
| Prompt-injection scenarios pass rate | ≥ 95% | Phase 7 close |
| Combined safety (adversarial + injection) pass rate | ≥ 95% | Phase 7 close |
| Per-skill golden pass rate | ≥ 90% | Phase 7 close |
| Mean golden score | ≥ 1.8 / 2.0 | Phase 7 close |
| EN golden pass rate | ≥ 95% | Phase 11 batch 60 |
| PT golden pass rate | ≥ 90% | Phase 11 batch 60 |
| ES golden pass rate | ≥ 85% | Phase 11 batch 60, promoted to hard gate after full data coverage |
| Multi-turn (turns.length ≥ 2) golden | ≥ 90% | Phase 11 batch 60 |
| EN adversarial / prompt_injection | ≥ 95% | Phase 11 batch 60 |
| PT adversarial / prompt_injection | ≥ 90% (informational) | Phase 11 batch 60 |

## Runtime performance and prompt-budget gates (Codex QA Stage 8)

Additional local gates now protect the registry runtime path:

| Gate | Threshold |
|---|---|
| Deterministic planner p95 over runtime golden examples | < 100ms locally |
| Registry subset retrieval p95 over runtime golden examples | < 25ms locally |
| Full registry-driven matrix runtime | < 2s locally |
| Tier 2 planner prompt registry view | fewer than all active actions; capped to a relevance-ranked subset |
| Tier 2 planner examples | ≤ 6 examples |
| Broad prompt serialized payload | < 12KB |
| LLM-safe prompt slice | no executor/verifier/policy/internal implementation fields |

## Per-action case categories

Mandatory case categories per `examples` array (audit §10):

| Category | Coverage | Phase achieved |
|---|---|---|
| 1. Golden (positive baseline) | 45/45 | Phase 14 batch 73 |
| 2. EN locale variants | 45/45 | Phase 0+ |
| 3. PT locale variants | 45/45 | Phase 1+ |
| 4. ES locale variants | 45/45 | Phase 14 batch 73 |
| 5. Ambiguous (multiple plausible matches) | 35/45 | Phases 2-9 |
| 6. Negative (looks like the action but isn't) | 30/45 | Phases 2-9 |
| 7. Prompt injection | 100% of external_side_effect / financial | Phase 15 batch 79 (gate enforced) |
| 8. Provider mismatch (read-back fails) | covered by verifier contract | n/a |
| 9. Wrong-entity (multiple recent candidates) | covered by ambiguous tag | Phase 2 batch 8 |

## Eval metrics (real-eval scoring)

Existing metrics from [`chat-evaluation-harness.ts`](../src/services/chat-evaluation-harness.ts) — every one is wired to a CI gate:

| Metric | Threshold | Source |
|---|---|---|
| macroActionPrecision | ≥ 0.98 (gate) | Phase 0 audit |
| macroSlotF1 | ≥ 0.97 (gate) | Phase 0 audit |
| actionRecallCoverage | informational | Phase 0 audit |
| wrongEntityRate | ≤ 0.005 (gate) | Phase 0 audit |
| verifiedMutationSuccessRate | ≥ 0.98 (gate) | Phase 0 audit |
| falseSuccessWithoutReadBackCount | = 0 (gate) | Phase 0 audit |
| criticalRiskFalseExecutionCount | = 0 (gate) | Phase 0 audit |
| clarificationRate | ≤ 0.35 (gate) | Phase 0 audit |
| uiHandoffRate | informational | Phase 0 audit |
| p95LatencyMs | ≤ 6000 (gate) | Phase 0 audit |
| costPerVerifiedSuccessUsd | ≤ 0.005 (gate) | Phase 0 audit |
| debugInternalLeakageCount | = 0 (gate) | Phase 0 audit |
| portugueseLocalizationLeakageCount | = 0 (gate) | Phase 0 audit |

## Examples-as-living-corpus shadow gate (Phase 14 batch 74)

[`__tests__/services/registry-examples-as-living-corpus-shadow.test.ts`](../__tests__/services/registry-examples-as-living-corpus-shadow.test.ts):

| Assertion | Phase 15 status |
|---|---|
| Every active action has ≥ 1 registry example | PASS (45/45) |
| ≥ 40 golden scenarios generate from registry | PASS |
| 10 active skills represented in generated corpus | PASS |
| en + pt + es generate ≥ 20 scenarios each | PASS |
| Adversarial + prompt_injection scenarios ≥ 10 | PASS |

## Multi-turn state-injection eval (Phase 9 batch 49)

[`__tests__/services/registry-multi-turn-state-injection.test.ts`](../__tests__/services/registry-multi-turn-state-injection.test.ts) covers turn-2 state-injection across 6 pending continuations (training, cooking, mail, decision, finance, content) + TTL safety.

[`__tests__/services/registry-multi-turn-es-state-injection.test.ts`](../__tests__/services/registry-multi-turn-es-state-injection.test.ts) (Phase 10 batch 52) repeats the same matrix for Spanish.

## Verification floor at Phase 15

```
npx tsc --noEmit                                                          # 0 errors
npx vitest run __tests__/services/{chat-action,registry,calendar-natural,past-tense-detector,chat-answer-contract}
# 859 (Phase 14) → final at Phase 15
```
