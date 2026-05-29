# ChatCoreV2 Module Inventory And Gap Analysis

**Generated:** 2026-05-27
**Work Order:** `docs/qa/work-orders/WO-chatcore-v2-production-activation.md`
**Branch:** `codex/chatcore-v2-production-activation-wo`
**Base commit:** `e5ca0034`
**Scope:** `src/services/chat-core-v2/`

This inventory maps existing ChatCoreV2 modules to the production activation
plan. The default is reuse or extension. A new module must justify why the
existing equivalent cannot be extended.

## Existing Module Map

| Existing module | Current role | Reused | Extended | Replaced | New module needed |
|---|---|---:|---:|---:|---|
| `action-authorization.ts` | action permission/risk authorization | yes | yes | no | no |
| `batch-policy.ts` | batch command constraints | yes | maybe | no | no |
| `capability-registry.ts` | capability definitions and rollout metadata | yes | yes | no | no |
| `command-bus.ts` | write preview/execution gate | yes | yes | no | no |
| `command-events.ts` | command event persistence/types | yes | yes | no | no |
| `command-executor.ts` | command execution orchestration | yes | yes | no | no |
| `command-preview-route.ts` | current command preview route | yes | yes | no | no |
| `command-status-policy.ts` | command status rules | yes | maybe | no | no |
| `deterministic-read-route.ts` | deterministic read router | yes | yes | no | no |
| `deterministic-read/*` | concrete read routes | yes | yes | no | no |
| `entity-resolution.ts` | entity/reference resolution primitives | yes | yes | no | `reference-resolver.ts` may wrap it for turn-level use |
| `evidence-policy.ts` | evidence sensitivity/trust policy | yes | yes | no | `evidence-compiler.ts` for per-turn bundles |
| `fallback-policy.ts` | fallback verdicts/policy | yes | yes | no | no |
| `finance-action-policy.ts` | finance safety policy | yes | yes | no | no |
| `human-review-queue.ts` | human review queue | yes | maybe | no | no |
| `index.ts` | exports | yes | yes | no | no |
| `locale-policy.ts` | locale normalization | yes | yes | no | no |
| `memory-store.ts` | memory abstractions | yes | yes | no | no |
| `model-run-audit.ts` | model run audit records | yes | yes | no | no |
| `online-eval-sampler.ts` | online eval sampling | yes | yes | no | no |
| `pending-commands.ts` | pending command storage | yes | yes | no | no |
| `prompt-registry.ts` | prompt/version registry | yes | yes | no | no |
| `provider-capabilities.ts` | provider capability metadata | yes | yes | no | no |
| `provider-data-policy.ts` | input policy for provider data handling | yes | yes | no | `cloud-allowlist-packet.ts` for stricter enforcement |
| `read-models.ts` | read model types | yes | yes | no | no |
| `reasoning-policies.ts` | reasoning tier/policy metadata | yes | yes | no | no |
| `response-contracts.ts` | final response contract validation | yes | yes | no | no |
| `route-decision.ts` | authoritative route decision | yes | yes | no | no |
| `runtime-budget.ts` | runtime budget rules | yes | yes | no | no |
| `shadow-orchestrator.ts` | existing shadow orchestration | yes | yes | no | no |
| `shadow-replay.ts` | shadow replay tooling | yes | yes | no | no |
| `shadow-route-classifier.ts` | route classifier shadow helpers | yes | yes | no | no |
| `shadow-route-hook.ts` | current chat route shadow hook | yes | yes | no | no |
| `tool-selection.ts` | capability/tool selection | yes | yes | no | no |
| `trace-recorder.ts` | trace spans | yes | yes | no | no |
| `training-safety-policy.ts` | training safety policy | yes | yes | no | no |
| `types.ts` | shared ChatCoreV2 types | yes | yes | no | no |
| `unsupported-policy.ts` | unsupported response policy | yes | yes | no | no |
| `workflow-state-machine.ts` | write/workflow states | yes | yes | no | no |

## Proposed New Modules

| Proposed module | Why existing modules are not enough | Phase |
|---|---|---:|
| `orchestrator.ts` | coordinates prepass, planner, validation, reads/writes, verification, composition; should stay thin | 2 |
| `context-compiler.ts` | single natural-language context packet owner; existing context paths are fragmented outside ChatCoreV2 | 1/2 |
| `reference-resolver.ts` | turn-level wrapper over `entity-resolution.ts` for "it", "that", pending confirmations, recent commands | 1/2 |
| `plan-schema.ts` | `ChatTurnPlanMicro` schema, bounds, zod/ajv validation | 1/2 |
| `model-planner.ts` | provider-agnostic local 3B planner interface and repair loop | 2 |
| `plan-validator.ts` | typed plan rejection reasons and capability/policy validation | 2 |
| `evidence-compiler.ts` | converts reads, memory, policies, and tool results into per-turn evidence bundles | 2/3 |
| `cloud-allowlist-packet.ts` | positive allowlist cloud packet builder; stricter than `provider-data-policy.ts` | 7 |
| `final-answer-composer.ts` | converts `ComposedAnswerDraft` plus evidence/verification into `ChatCoreV2Response` | 3 |
| `domain-adapters/` | tenant-scoped `DomainAdapterV1` implementations wrapping existing domain services | 4/5/6 |

## Corrections To Carry Forward

- The existing audit module is `model-run-audit.ts`, not `model-audit.ts`.
- The existing budget module is `runtime-budget.ts`, not
  `runtime-guardrails.ts`.
- There is a test named `chat-core-v2-runtime-guardrails.test.ts`, but no
  runtime module with that name at base commit `e5ca0034`.
- `provider-data-policy.ts` is an input to cloud egress decisions, not the
  full cloud enforcement boundary.

## Existing Test Surface

Current focused tests include:

- `__tests__/services/chat-core-v2-action-authorization.test.ts`
- `__tests__/services/chat-core-v2-batch-policy.test.ts`
- `__tests__/services/chat-core-v2-command-bus.test.ts`
- `__tests__/services/chat-core-v2-command-events.test.ts`
- `__tests__/services/chat-core-v2-command-preview-route.test.ts`
- `__tests__/services/chat-core-v2-deterministic-read-route.test.ts`
- `__tests__/services/chat-core-v2-entity-resolution.test.ts`
- `__tests__/services/chat-core-v2-evidence-policy.test.ts`
- `__tests__/services/chat-core-v2-finance-action-policy.test.ts`
- `__tests__/services/chat-core-v2-foundation.test.ts`
- `__tests__/services/chat-core-v2-human-review.test.ts`
- `__tests__/services/chat-core-v2-locale-policy.test.ts`
- `__tests__/services/chat-core-v2-memory-store.test.ts`
- `__tests__/services/chat-core-v2-model-audit.test.ts`
- `__tests__/services/chat-core-v2-online-eval-sampler.test.ts`
- `__tests__/services/chat-core-v2-prompt-registry.test.ts`
- `__tests__/services/chat-core-v2-read-models.test.ts`
- `__tests__/services/chat-core-v2-response-contracts.test.ts`
- `__tests__/services/chat-core-v2-route-decision.test.ts`
- `__tests__/services/chat-core-v2-runtime-guardrails.test.ts`
- `__tests__/services/chat-core-v2-shadow-orchestrator.test.ts`
- `__tests__/services/chat-core-v2-shadow-replay.test.ts`
- `__tests__/services/chat-core-v2-shadow-route-hook.test.ts`
- `__tests__/services/chat-core-v2-tool-selection.test.ts`
- `__tests__/services/chat-core-v2-trace-recorder.test.ts`
- `__tests__/services/chat-core-v2-training-safety-policy.test.ts`
- `__tests__/services/chat-core-v2-unsupported-policy.test.ts`
- `__tests__/services/chat-core-v2-workflow-state-machine.test.ts`

## Phase 0 Gap Summary

1. There is no single ChatCoreV2 natural-language orchestrator yet.
2. There is no bounded `ChatTurnPlanMicro` schema or repair loop yet.
3. Context compilation is still split across route-level helpers, legacy chat
   services, domain handlers, and ChatCoreV2 read routes.
4. Final answer composition is not yet centrally enforced through
   evidence-bound `ComposedAnswerDraft` conversion.
5. Cloud egress needs a new positive allowlist packet builder. Existing
   provider policy is useful input but not sufficient enforcement.
6. Domain handlers need a tenant-scoped `DomainAdapterV1` contract before they
   stop owning natural-language chat directly.
7. Kill switch, auto-revert, and legacy-fallback telemetry need to be promoted
   from policy to tested runtime behavior before Phase 2.

## Next Phase 0/1 Work

- Complete the Layer 1 assembly map against existing shortcut/context services.
- Run the 3B planner benchmark with 2k and 3k prompt sizes on the production
  VPS and link the artifact from the Work Order.
- Define `ChatTurnPlanMicro` and `ComposedAnswerDraft`.
- Define `DomainAdapterV1`.
- Define iOS turn-state event and reconnect contract.
- Add the golden corpus structure and initial seeded regression cases.
