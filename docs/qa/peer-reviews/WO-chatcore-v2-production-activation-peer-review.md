# ChatCoreV2 Production Activation — Lead Peer Review

| Field | Value |
|---|---|
| **Work Order** | `docs/qa/work-orders/WO-chatcore-v2-production-activation.md` (ChatCoreV2 Production Activation) |
| **Reviewer** | Independent Claude peer-review workflow (lead reviewer synthesizing per-deliverable adversarial sub-reviews) |
| **Date** | `2026-05-29` |
| **Standard** | Delivered-Means-Verified (DMV) |
| **Scope** | D1–D16 plus the D4 packet validators (`plan-schema.ts`, `prompt-budget.ts`, `planner-repair.ts`, `plan-validator.ts`) |
| **Source under review** | branch `codex/chatcore-v2-production-activation-wo`, deliverable commit `fa31f0f3`, base pin `e5ca0034` |

---

## How to read this review

This review applies **Delivered-Means-Verified**: a deliverable is only "delivered" if its *claimed* scope was independently re-verified against the code, tests, and docs — not if it merely looks complete. Each deliverable was put through an adversarial refutation pass that actively tried to break the verdict on four fronts: (1) stub / placeholder code, (2) a helper or contract with no real caller, (3) vacuous (always-true) tests, and (4) overclaiming beyond the stated scope.

**One framing point governs the entire review and the GATE 0b verdict below.**

> Almost every D1–D16 artifact is a **tested-but-unwired helper, contract, validator, or documentation deliverable**. The Layer 1 selector, the `ChatTurnPlanMicro` schema and its validators, the evidence taxonomy, the domain adapter interface, the iOS turn-state and background-lifecycle contracts, the model-residency policy, the write-risk gradient, and the failure-observability matrix are real, correct, and unit-tested — but they are **not invoked on any live planner/route/decision path**. Their barrel (`src/services/chat-core-v2/index.ts`) is imported by live routes, but the routes consume *other* symbols; an `export *` re-export never executes the re-exported module.

This is **honestly disclosed** by the work order, the readiness matrix, the contract docs, and the per-deliverable claims — none of them launder helper-completeness into production-readiness. That honesty is why most deliverables earn "delivered" against their *declared* (Phase 0/1, runtime-deferred) scope. But it is also exactly why **GATE 0b — which governs production activation — cannot pass on this work alone**: helper-complete is not runtime-wired, and runtime-wired is the thing GATE 0b is supposed to certify.

The one path that *is* runtime-reachable is the local-chat orchestrator (`runChatCoreV2LocalChatTurn`), imported at `src/api/routes/chat-message-routes.ts:105` and invoked at line 1332 of the live iOS chat route. It is gated **default-off** by the D11 master kill switch (`CHAT_CORE_V2_ORCHESTRATOR_MODE` defaults to `off`; `allowCloudFallback` defaults false). So the system can be safely shipped *dormant*, but it is not yet safe to *activate*.

---

## Per-deliverable verdict table

| ID | Title | Final verdict (post-adversarial) | Confidence | Key evidence | Gaps / false-claims |
|---|---|---|---|---|---|
| **D1** | Layer 1 assembly map + pure candidate selector | **Delivered** (doc + helper; runtime wiring Phase 2) | High | `chatcore-v2-layer1-assembly-map.md:13-27` concrete assembly table; `prepass-candidate-selection.ts:32-78` real pure selector; determinism test `activation-contracts.test.ts:335-339` reads real source and asserts `audit…() === []`. | `slice(0, Math.max(MIN,MAX))` code smell (MIN floor inert); selector has no live caller (only eval primitive + tests); no dedicated test file. No false claims. |
| **D2** | ChatCoreV2 module inventory + gap analysis | **Delivered** | High | Inventory pinned to `e5ca0034`; 38-module map is 1:1 with `git ls-tree`; 9 proposed-new modules confirmed absent at base; 28-test surface exact match. | Point-in-time snapshot (tree has since advanced); WO row still says "peer review pending" — this review supplies that sign-off. No false claims. |
| **D3** | Hardware benchmark baseline (3B planner) | **Delivered** (serialized baseline; production-sized run pending) | High | 450-line real harness; correct nearest-rank percentiles; artifact `2026-05-28T22-30-16-965Z.json` reproduces doc table exactly; concurrency gate `runWithLocalInferenceSlot` wired at two foreground call sites. | Full production-sized suite (100-seq / 5-concurrent / 5-min) **not** run — bounded 66-call run; burst/concurrent/sustained **FAIL** the p95≤5s gate (~10-15s). Honestly disclosed negative result. Stale "11 tests" count (actually 16). |
| **D4** | `ChatTurnPlanMicro` schema + prompt budget + validators | **Delivered** (validators correct; runtime wiring Phase 2) | High | `plan-schema.ts:415-497` full hand-written validator; 4 strict JSON schemas w/ `additionalProperties:false`; `plan-validator.ts`, `prompt-budget.ts`, `planner-repair.ts` real; 45 focused tests pass (42/42 sub-claim holds). | **All four runtime entry points have zero production callers** — validators never run against real Ollama output; ≥99% schema-validity-under-benchmark not executed (depends on D3 full run). |
| **D5** | Evidence taxonomy per domain | **Delivered** (drafted taxonomy + first binding helper) | High | `chatcore-v2-phase1-contracts.md:81-106` per-domain taxonomy; `validateComposedAnswerDraft` real + wired at `local-chat-orchestrator.ts:281`; `evidence-policy.ts` substantive + 5 tests. | **Runtime binding gap**: `normalizeDraft`/`buildDraftFromPlainText` always set `factualClaims:[]`, so the "every claim binds to evidence" branch never fires in production. Per-domain field-level enforcement is doc-only. `buildChatCoreV2EvidenceItem` has no prod caller. Domain-owner review pending. |
| **D6** | Prepass candidate algorithm + golden corpus | **Delivered** (synthetic baseline; real corpus + gate pending) | High | All 7 files real; HMAC-SHA256 miss log proven to drop PII; recall@8 independently reproduced = 148/263 = 0.563; `validateGoldenCorpus(SEED) === []`. | Recall@8-per-language gate **UNMET**; entire surface has **no live runtime caller**. **Minor false claim**: acceptance says "7 real-failure seeds across en/pt-BR/pt-PT/mixed" but no `mixed` real-failure seed exists. 263 items = only 112 unique messages. |
| **D7** | Tenant-scoped `DomainAdapterV1` interface | **Delivered** (interface only; adapters Phase 4/5/6) | High | `domain-adapter.ts:50-84` real interface, tenant+user at every method boundary; imports resolve to real types; `tsc` clean. | Zero `implements DomainAdapterV1` anywhere (by design); no direct test; spec/impl naming drift (`CapabilityManifest` vs `CapabilityDefinition`). No false claims. |
| **D8** | iOS turn-state event contract helper | **Delivered** (contract + helper; server/iOS wiring pending) | High | `turn-state-events.ts` real `buildTurnStateEvent` + monotonic `shouldApplyTurnStateEvent`; test asserts both branches. | No runtime caller (contract only); `serverTime` default branch + most fields untested; cosmetic 38-vs-39 line miscount. No false claims. |
| **D9** | Background lifecycle | **Delivered** (contract + helper; queue Phase 6) | High | `background-lifecycle.ts` real `VALID_TRANSITIONS` + `canTransitionBackgroundJob`/`backgroundJobRequiresAbortSignal`; test asserts superseded-terminal + abort-required. | Runtime-dead today (no queue/scheduler consumer); only the `superseded` path asserted; no expiry/clock logic. No false claims. |
| **D10** | `AnswerCompositionMode` budget **and measurement** | **Partially delivered** (downgraded from "delivered") | High | Budget half real: `AnswerCompositionMode` union, `ANSWER_COMPOSITION_MODE_BUDGETS`, `validateComposedAnswerDraft` wired at `local-chat-orchestrator.ts:281`. | **Measurement half unimplemented**: budget constants have **zero consumers**; `composer_mode_drift` gate is **never emitted** (sole runtime caller hard-codes `local_queue_saturation`); no code computes mode-usage share. **Budget value diverges from spec** (code `0.35` vs contract ceiling `0.30`). |
| **D11** | Single kill switch behavior + CI test | **Delivered** | High | `resolveChatCoreV2ActivationConfig` force-collapses all flags when mode `off`; gateway honors orchestrator-`off` first; **genuinely wired** at `chat-message-routes.ts:1024,1146` and `local-chat-orchestrator.ts:129-130`; 37/37 tests pass. | "off beats all flags on EVERY path" proven for the two resolvers + gateway, not literally repo-wide (Phase 2 CI sweep pending). No false claims. |
| **D12** | Model residency policy → keep-alive config | **Delivered** (declarative policy; runtime keep-alive pending) | High | 4 real policy constants (3B `-1` foreground; 35B `5m` background-only); real resolver + validator; 2 residency tests pass. | Policy has **no runtime consumer**; `ollama-provider.ts` hardcodes `keep_alive:-1` independently. Validator's 3 negative branches are **unreachable** via `resolve(env)` and **untested**; string-vs-numeric keep-alive adapter still needed. |
| **D13** | Cloud allowlist composition (positive-allowlist + HMAC, producer + dispatcher) | **Delivered** | High | Positive-only packet (no raw text); real tenant-scoped HMAC-SHA256; fail-closed deny-when-uncertain; sensitive-topic deny regexes proven load-bearing; quad-gated default-off; dispatcher wired at `local-chat-orchestrator.ts:165,190`. | No isolated unit test for `cloud-allowlist-packet.ts` branch ordering (covered transitively); orchestrator e2e path outside owned files (Phase 7 pending); deny regexes intentionally keyword-incomplete (conservative-only). No false claims. |
| **D14** | Write risk gradient helper | **Partially delivered** | High | `write-risk-policy.ts` real `A/B/C` classes, escalation reasons, `WRITE_RISK_POLICIES` (all readback-required), `requires35BOrBackgroundEscalation` tested true/false/override. | **False claim**: "writes require idempotency keys" — owned file has **no** idempotency logic. **Overstated**: "classifying writes" — class is an *input*, not computed. `getWriteRiskPolicy`/`WRITE_RISK_POLICIES`/`requiresReadbackVerification` have **zero callers** and zero test coverage (inert data). |
| **D15** | Failure observability matrix | **Delivered** (matrix + sanitizer; broader wiring Phase 2+) | High | 10-mode matrix fully populated; two-stage allowlist sanitizer proven to drop PII (positive+negative assertions); wired via queue-fallback at `local-chat-orchestrator.ts:499`; exported. | Only `local_queue_saturation` emits at runtime — the other 9 modes (incl. tested `legacy_fallback_rate`/`ollama_daemon_unhealthy` mappings) have **no producer**. WO scores this `1/2` honestly. |
| **D16** | Pure-deterministic prepass audit | **Delivered** (initial audit + source guard; repo-wide CI pending) | High | Audit doc flags LLM-importing modules to keep out of Layer 1; `validatePrepassOutputBounds` + `auditPrepassSourceForDeterminism` real (4 forbidden-pattern rules); test fires on bad source AND passes real selector source; CI-runnable path confirmed. | Guard is **regex/textual (no AST)** and audits **exactly one file** via one test — not a repo-wide sweep. Minor doc-completeness gap (helpers not named in assembly map). No false claims. |

**Tally:** 14 Delivered · 2 Partially delivered (D10, D14) · 0 Not delivered.
**Confirmed false/overstated claims:** D6 (real-failure language spread), D10 (measurement defined-but-inert + spec value divergence), D14 (idempotency-key enforcement, "classifying" writes).

---

## Prose findings — deliverables that need attention

### D10 — `AnswerCompositionMode` budget and measurement (DOWNGRADED to Partially delivered)

This is the one deliverable whose original verdict did **not** survive the adversarial pass, and the downgrade is load-bearing for GATE 0b.

Every individual code citation in the D10 claim is literally accurate, and the deliverable is **not** refutable on stub / no-caller / vacuous-test / fabrication grounds: `validateComposedAnswerDraft` (`answer-composition.ts:50-68`) has four real branches, is genuinely called at `local-chat-orchestrator.ts:281`, and the `model_constrained` draft → `ChatCoreV2Response` conversion is wired (lines 291-315). The **budget half** is delivered.

The **measurement half is not.** The deliverable is titled "budget **and measurement**," and the work order's own status line (`WO…activation.md:739`) says "**measurement pending**." I independently confirmed three things:

1. **The budget constants are dead.** `ANSWER_COMPOSITION_MODE_BUDGETS` / `targetMaxShare` / `targetMinShare` (`answer-composition.ts:16-23`) have **zero consumers** in `src/` or `__tests__/` — `git grep` returns only the definitions. Nothing reads them.
2. **The drift gate cannot fire.** `failure-observability.ts:53` defines a `composer_mode_drift` rule, but the sole runtime caller of `buildChatCoreV2FailureObservabilityEvent` (`local-chat-orchestrator.ts:499`) hard-codes `failureMode: 'local_queue_saturation'`. No code computes composition-mode usage share or feeds `compositionMode` into any metrics/`api_usage` sink. So "the measurement gate is defined" is true **only as a static matrix string with no producer** — it is unmeasurable today.
3. **Spec value divergence.** The D10 contract (`chatcore-v2-phase1-contracts.md:254`) specifies `model_constrained` target share **15–30%**, but the code encodes `targetMaxShare: 0.35` and the alert threshold is `>35% sustained`. Verified live: `{ mode: 'model_constrained', targetMinShare: 0.15, targetMaxShare: 0.35 }`.

No dedicated test covers the budget/drift surface. Verdict: **Partially delivered**.

### D14 — Write risk gradient helper (Partially delivered — confirmed)

`write-risk-policy.ts` is real, but two parts of the claim are inaccurate and one structural gap keeps it below "delivered":

- **Idempotency keys are not enforced here.** `grep -i idempot` on the owned file returns nothing; idempotency lives in unrelated files and is not tied to the risk gradient. **Not delivered in the owned path.**
- **The helper does not "classify" writes.** `riskClass` is an **input**, not an output.
- **Most of the surface is inert.** `getWriteRiskPolicy`, `WRITE_RISK_POLICIES`, and `requiresReadbackVerification` have **zero callers** and zero test coverage; only `requires35BOrBackgroundEscalation` and the type are exercised.

### D5 — Evidence taxonomy (Delivered, with a real runtime-binding gap)

`validateComposedAnswerDraft` is wired into the live path, but in the runtime path `normalizeDraft` and `buildDraftFromPlainText` always produce `factualClaims:[]`, so **nothing in production binds read-model evidence to claims**. The rule is documented and unit-tested in isolation, not enforced end-to-end.

### D3 — Hardware benchmark baseline (Delivered, must not be over-read)

The production-sized suite was never run. The cited artifact is a bounded 66-call run, not the 100-sequential / 5-concurrent / 5-minute-sustained run named in the doc. The serialized gate passes (p95 ≈ 3.7s), but **burst, concurrent, and sustained all FAIL** the p95≤5s gate at ~10-15s. A valid, honestly-reported negative baseline.

### D6 — Prepass corpus (Delivered, one minor false claim)

Recall@8 = 148/263 = 0.563 reproduces exactly. The acceptance line claims "7 real-failure seeds across en/pt-BR/pt-PT/**mixed**," but there is **no `mixed` real-failure seed**. The "263-item" corpus contains only **112 unique messages**. The per-language recall gate remains **UNMET**; surface is unwired.

### D12 — Model residency policy (Delivered, validator has no teeth)

The validator's three issue branches are **unreachable** via `resolve(env)` because the resolver copies `keepAlive`/`foregroundAllowed` verbatim from hardcoded-correct constants; `validate(resolve(env)) === []` is true by construction and untestable for regression. Policy is unwired; `ollama-provider.ts` hardcodes `keep_alive:-1` independently.

### D15 — Failure observability matrix (Delivered at 1/2)

Matrix + sanitizer are real (PII drop proven). Only `local_queue_saturation` emits at runtime; the other 9 modes — including tested `legacy_fallback_rate`/`ollama_daemon_unhealthy` mappings — have no producer. WO scores `1/2` honestly.

### D2 / D7 — documentation/contract deliverables with open WO status

D2's WO row still reads "peer review pending"; this review constitutes that sign-off and the inventory passes. D7's interface is complete but has zero implementors by design with a minor spec/impl naming drift. Neither blocks anything; both should have tracking rows reconciled.

---

## GATE 0b — Go / No-Go verdict

### Verdict: **NO-GO (CONDITIONAL)** for production *activation*. **GO** only for shipping the code *dormant* (default-off).

GATE 0b governs **production activation** of ChatCoreV2. Under DMV, activation readiness requires that the components doing the work are runtime-wired, validated against real model output, and within performance/measurement budgets — not merely that helpers exist and unit-test green. That bar is **not met**, for reasons that are real and honestly documented:

1. **The planning/validation/evidence/taxonomy stack is not runtime-wired.** D1, D4, D5 (binding), D6, D7, D8, D9, D12, D14 are tested-but-dormant. The authoritative runtime path remains `route-decision.ts` + the orchestrator's plain-text draft path; the `ChatTurnPlanMicro` validators never run against a real Ollama planner response. Helper-complete ≠ production-ready.
2. **D10 measurement is unimplemented.** The `model_constrained ≤ budget` guarantee has **no producer** and **no counter**; the `composer_mode_drift` auto-revert cannot fire.
3. **The performance baseline fails under concurrency.** D3 shows burst/concurrent/sustained p95 at ~10-15s vs a 5s gate; the production-sized suite was never run.
4. **The per-language prepass recall gate is UNMET** (D6) and depends on a peer-reviewed real corpus that does not exist.
5. **D14 risk-gradient governance and D15's 9 non-queue failure modes are inert.**

What **is** solid and de-risks a *dormant* ship: the **D11 master kill switch is genuinely wired and authoritative** (verified at `chat-message-routes.ts:1024,1146` and `local-chat-orchestrator.ts:129-130`), the **D13 cloud egress path is quad-gated default-off** with positive-allowlist + HMAC + fail-closed semantics, and the orchestrator entry point is reachable but blocked by default.

### Precise list of what must change for GATE 0b to PASS

Production *activation* (flipping `CHAT_CORE_V2_ORCHESTRATOR_MODE` off → shadow/canary/on) must not proceed until **all** of the following are true and independently re-verified:

1. **Wire Layer 1 + the planner contract into the live decision path.** `route-decision.ts` must call `selectPrepassCandidateCapabilities` (D1) and run real Ollama planner output through `parseAndValidateChatTurnPlanMicro*` + `validateChatTurnPlanMicroAgainstContext` + `decidePlannerPromptBudget` + the repair path (D4), with passing integration tests — not just the barrel re-export.
2. **Implement D10 measurement, not just the budget.** Add a producer that computes `AnswerCompositionMode` usage share from a metrics sink, feed it to `buildChatCoreV2FailureObservabilityEvent` with `composer_mode_drift`, and prove the `>35% sustained` auto-revert can fire. **Reconcile the budget value** (code `0.35` vs spec `0.30`). Add tests for the budget table and a produced drift event.
3. **Run the production-sized D3 benchmark and meet the concurrency gate** (full 100-seq / 5-concurrent / 5-min on target hardware) — or formally ratify a serialized-only (concurrency 1) activation profile with `runWithLocalInferenceSlot` wired and documented as the production constraint.
4. **Close the D6 prepass recall gate with a real ≥200-turn peer-reviewed corpus** meeting en≥98 / pt-BR≥97 / pt-PT≥92 / mixed≥90. Promote the 5 operator-authored seeds; fix the "mixed real-failure seed" overstatement.
5. **Make D5 evidence binding actually bind in the runtime path** (populate `factualClaims` with real read-model evidence IDs) and obtain the pending per-domain taxonomy sign-off.
6. **Wire D14 write-risk governance to the write path (if writes are in activation scope)** — have `action-gateway.ts`/`command-executor.ts` consult the policy, and **either implement idempotency-key enforcement tied to the gradient or correct the claim**; reword "classifying writes"; add enforcement tests.
7. **Wire the activation-critical D15 failure modes** (`legacy_fallback_rate`, `ollama_daemon_unhealthy`) so the auto-revert policy has live inputs, and connect them to a dashboard/alert sink.
8. **Wire D12 model residency to actual keep-alive** (string→numeric adapter; `ollama-provider.ts` reads the policy instead of hardcoding `-1`); add tests exercising the validator's three negative branches.
9. **Land repo-wide D16 determinism CI** over all Layer 1 runtime modules, and move the LLM-importing modules the audit flagged (`chat-message-shortcuts.ts`, `chat-action-fixer-worker.ts`) out of any Layer 1 path before activation.
10. **Keep the D11 kill switch and D13 default-off posture intact** throughout, and only flip activation after a staging shadow run produces the threshold evidence the readiness matrix requires — following the standard staging-smoke-before-production gate.

Until items 1–9 are delivered-and-verified (item 10 being the always-on guard), **GATE 0b is a NO-GO for activation**. It is a **conditional GO for merging the dormant code**, because the work is honest about its own scope, the master kill switch is real and wired, and cloud egress is fail-closed default-off.

---

## Note on the standard

No deliverable was failed for *being* scoped as a Phase 0/1 helper — DMV grades against the *declared* scope, and the declared scope was overwhelmingly honest. Verdicts were lowered (D10, D14) only where the **claim's own words** promised behavior (measurement; idempotency-key enforcement; write classification) that the code does not perform. The GATE 0b NO-GO is **not** a quality judgment on the helpers — it is the direct consequence of the gap between "helper-complete and unit-tested" and "runtime-wired, validated against real model output, and within budget," which is the only thing a production-activation gate is allowed to certify.