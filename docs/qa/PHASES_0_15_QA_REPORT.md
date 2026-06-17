# Phases 0-15 QA Report

Status: Final QA rerun completed with local fixes and documented external exceptions
Owner: Backend QA Architect
Generated: 2026-05-16
Source checklist: `docs/qa/PHASES_0_15_CODEX_QA_PROMPT.md`

## 1. Scope

This report finalizes the Phases 0-15 backend QA for the Nexus Hub skill interaction catalog, deterministic chat-action planner, registry examples, prompt-safety boundary, risk policy, provider failure behavior, telemetry redaction, architecture/runtime wiring, performance/token budget, and iOS backend-contract handoff.

The mandatory original checklist was used as the controlling source:

- Original Section 3 verification commands.
- Original Section 4 suspected gaps 4.1 through 4.12.
- Original Section 5 end-to-end smokes.
- Original Section 6 chat matrix, R1-R10 refusal rows, and MT1-MT5 multi-turn rows.
- Original Section 8 hypotheses 1 through 10.
- Original Section 9 improvements.
- Original Section 10 guardrails.
- Original Section 11 done checklist.

Additional user-requested QA extensions were also completed: runtime registry introspection, functional golden routing gates, deterministic date/time tests, risk-policy matrix, indirect prompt-injection tests, prompt/log/telemetry redaction, tenant isolation, idempotency/retry, provider failures, LLM fallback contract tests, performance/token-budget gates, and the backend-to-iOS contract fixture handoff.

No push and no commit were performed.

## 2. Methodology

The QA began on branch `qa/phases-0-15-codex-review` at commit `f1247c8cdb72767892db16b789a35065e873ed92`. The worktree was already dirty before this final pass, so existing user/agent changes were preserved and not reverted.

Verification used three layers:

- Static checks: TypeScript compile, grep smoke counts, source inspection, docs audit.
- Runtime introspection: direct imports of the active chat-action registry and runtime scenario builders.
- Functional tests: focused Vitest suites, full Vitest regression, Python content-engine tests, channel smoke dry-run, prompt safety tests, tenant/isolation/idempotency/provider-failure tests, and performance/token-budget tests.

Final commands run:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --stat
git diff --name-only

npx tsc --noEmit
rg -c "locale: 'es'" src/services/chat-action-registry.ts
rg -c "typedSlotExtractors:" src/services/chat-action-registry.ts
rg -c "noopSlotExtractor" src/services/chat-action-registry.ts

npx vitest run __tests__/services/chat-action __tests__/services/registry __tests__/services/calendar-natural __tests__/services/past-tense-detector __tests__/services/chat-answer-contract.test.ts
npx vitest run __tests__/services/registry-per-action-minimum-eval-gate.test.ts
npx vitest run __tests__/services/chat-action-registry-typed-slot-adoption.test.ts
npx vitest run

content-engine/.venv313/bin/python -m pytest tests/
cd content-engine && .venv313/bin/python -m pytest tests/

cd "/Users/felipedominguez/Desktop/Nexus Hub/engine" && npm run docs:audit
```

The exact Python command from the original checklist now passes via a root-level pytest proxy that executes the real `content-engine/tests` suite as a child run. The corrected direct content-engine command was also run and passed.

## 3. Git baseline and changed files

| Item | Value |
| --- | --- |
| Branch | `qa/phases-0-15-codex-review` |
| HEAD | `f1247c8cdb72767892db16b789a35065e873ed92` |
| Status summary | 40 modified tracked files, 100 untracked paths, 140 changed paths total |
| Tracked diff stat | 40 files changed, 4996 insertions, 1116 deletions |
| Push/commit | Not performed |

Tracked files changed:

```text
__tests__/api/chat-routes.test.ts
__tests__/api/skills-routes.test.ts
__tests__/portal/portal-static-routes.test.ts
__tests__/portal/skill-management-qa-validation.test.ts
__tests__/portal/skill-management.test.ts
__tests__/regression/skill-extraction.test.ts
__tests__/router/dynamic-routing.test.ts
__tests__/services/chat-action-planner.test.ts
__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts
__tests__/skills/skill-config.test.ts
__tests__/skills/skill-manager.test.ts
__tests__/skills/skills-command-qa-validation.test.ts
__tests__/skills/skills-command.test.ts
__tests__/skills/sub-skill-arch-qa-validation.test.ts
docs/release/current-release-index.md
package.json
scripts/audit-docs.mjs
scripts/cannot-skip-gate-dashboard.sh
scripts/changed-area-classifier.sh
scripts/local-up.sh
src/adapters/index.ts
src/api/routes/chat-message-local-responses.ts
src/domains/domain-handler.ts
src/domains/types.ts
src/portal/auth/password-reset.html
src/portal/landing.html
src/portal/portal.html
src/portal/static-routes.ts
src/portal/user-login.html
src/router/classifier.ts
src/services/calendar-natural-language-parser.ts
src/services/chat-action-planner.ts
src/services/chat-action-registry.ts
src/services/chat-action-state.ts
src/services/chat-pending-confirmations.ts
src/services/chat-skill-capability-registry.ts
src/services/secretary-fastpath.ts
src/skills/skill-config.ts
src/skills/training/manifest.json
```

Important untracked QA additions include:

```text
docs/qa/PHASES_0_15_CODEX_QA_PROMPT.md
docs/qa/PHASES_0_15_IOS_CONTRACT_FIXTURES.md
docs/qa/PHASES_0_15_QA_REPORT.md
migrations/135_alert_channel_smoke_runs.sql
scripts/registry-alert-channel-smoke.ts
scripts/registry-feedback-report.ts
src/services/build-llm-safe-prompt-slice.ts
src/services/identity-question-detector.ts
src/services/llm-prompt-safety.ts
src/services/registry-channel-smoke.ts
src/services/registry-driven-eval-scenarios.ts
src/services/registry-real-eval-scoring.ts
src/services/registry-typed-slot-adapters.ts
tests/test_content_engine_proxy.py
```

There are many additional untracked test files under `__tests__/services`, `__tests__/api`, `__tests__/adapters`, `__tests__/lib`, and `__tests__/scripts`; they are covered by the full Vitest run.

## 4. Quantitative claims verification table

| Check | Expected | Observed | Status | Notes |
| --- | ---: | ---: | --- | --- |
| `npx tsc --noEmit` | 0 errors | 0 errors | PASS | Final run exited 0. |
| ES grep smoke | 45 | 45 | PASS_AS_SMOKE | `rg -c "locale: 'es'"`. Runtime introspection is source of truth. |
| typedSlotExtractors grep smoke | 45 | 45 | PASS_AS_SMOKE | `rg -c "typedSlotExtractors:"`. Runtime introspection is source of truth. |
| noopSlotExtractor grep smoke | n/a | 5 references | PASS_AS_SMOKE | Runtime active-use inventory is 4 actions. |
| Focused chat/registry/calendar/past-tense suite | 0 fail | 52 files, 1151 tests pass | PASS | Rerun after stale inline-regex test fix. |
| Per-action eval gate | 0 fail | 1 file, 6 tests pass | PASS | `registry-per-action-minimum-eval-gate`. |
| Typed slot adoption suite | 0 fail | 1 file, 20 tests pass | PASS | Runtime active-action coverage. |
| Full Vitest regression | 0 fail | 597 files, 8924 tests pass | PASS | Final rerun exited 0 in 103.09s. |
| Original Python command | pass | 1 proxy test pass | PASS_WITH_PROXY | `content-engine/.venv313/bin/python -m pytest tests/` now executes `tests/test_content_engine_proxy.py`, which runs the real content-engine pytest suite. |
| Corrected content-engine pytest | pass | 146 tests pass | PASS_WITH_DOC_DRIFT | `cd content-engine && .venv313/bin/python -m pytest tests/`. |
| Workspace docs audit | no new mirror drift | 618 issues flagged | FAIL_BASELINE | False positives removed for generated cache docs, placeholders, fenced examples, device IDs, canonical root docs, and real iOS spec paths; broader historical docs debt remains. |
| Runtime active actions | 45 | 45 | PASS | Imported actual registry at runtime. |
| Active actions with typed extractors | 45 | 45 | PASS | No active action missing typed extractors. |
| Active actions with ES golden examples | 45 | 45 | PASS | Every active action has ES golden coverage. |
| Golden examples with `expectedAction` | all | all | PASS | Missing count 0. |
| Golden routing EN | 100% | 79/79 | PASS | Functional deterministic routing gate. |
| Golden routing PT | 100% | 69/69 | PASS | Functional deterministic routing gate. |
| Golden routing ES | 100% | 45/45 | PASS | ES hard gate result. |
| Deterministic planner p95 | <100ms | 0.660ms | PASS | Local runtime measurement. |
| Registry retrieval p95 | <25ms | 0.021ms | PASS | Local runtime measurement. |
| Full registry matrix runtime | bounded | 10.462ms over 244 scenarios | PASS | Local runtime measurement. |
| Tier 2 prompt budget | <12KB, <=6 examples | 11,428 bytes, 6 examples | PASS | Prompt no longer sends full active registry. |

## 5. Runtime registry introspection results

Runtime registry introspection is PASS.

| Registry invariant | Result |
| --- | --- |
| `activeActions.length === 45` | PASS |
| Every active action has `typedSlotExtractors` | PASS |
| Every active action has at least one ES golden example | PASS |
| Every golden example has `expectedAction` | PASS |
| Disabled/deprecated actions excluded from active count | PASS |
| `noopSlotExtractor` active usage inventoried and justified | PASS |
| Grep counts and runtime introspection reported separately | PASS |

Runtime golden routing gate is PASS:

| Locale | Routed / total | Pass rate |
| --- | ---: | ---: |
| EN | 79 / 79 | 100% |
| PT | 69 / 69 | 100% |
| ES | 45 / 45 | 100% |

ES hard gate recommendation/result: implemented and PASS. ES examples are no longer merely present; they route through `buildDeterministicChatActionPlan` and must return the registry-declared expected action unless explicitly marked non-deterministic/LLM-tier.

`noopSlotExtractor` active inventory:

| Action | Justification |
| --- | --- |
| `training.training_reflow_preview` | Preview-style action; no durable write slots required. |
| `training.training_reflow_confirm` | Continuation/confirmation flow depends on pending context. |
| `content.content_pipeline_handoff` | Handoff action; payload derived from internal context. |
| `finance.finance_payment_action` | Action-specific validator/executor handles constrained payment state. |

## 6. Suspected-gap findings

| Original gap | Status | Finding / resolution |
| --- | --- | --- |
| 4.1 `buildLlmSafePromptSlice` | FIXED | Safe prompt slice exists and tests assert executor/verifier/policy/internal fields are stripped. |
| 4.2 Registry ES examples route | FIXED | Runtime golden routing gate added; ES 45/45 routes correctly. |
| 4.3 `noopSlotExtractor` inflation | FIXED | Runtime active inventory added; 4 justified active uses. |
| 4.4 Capability registry soft-merge drift | PASS | `chat-skill-capability-registry.ts` remains purposeful for grounding and capability metadata; deletion deferred to Phase 16 decision only if runtime consumers are retired. |
| 4.5 Secretary fast-path parser drift | FIXED | Duplicate local calendar create helpers removed/replaced by canonical parser delegation; equivalence tests pin behavior. |
| 4.6 ES/PT past tense and future action split | FIXED | PT/ES past-tense rows refuse/no-op, while mixed past-tense plus future scheduling routes future action correctly. |
| 4.7 Pending continuation integration | FIXED | Real `chat-action-state` persistence integration covers turn 1 pending state and turn 2 continuation with same conversation ID. |
| 4.8 Multi-region channel routing | FIXED | Dry-run channel smoke verifies `slack-us` and `slack-eu` output and no secret/user/tenant/executor leakage. |
| 4.9 Identity / tenant leakage | FIXED | Prompt/model args/logs/telemetry tests cover token, identity, provider credential, raw prompt, and debug-card leakage. |
| 4.10 Typed slot adoption | FIXED | 45/45 active actions have typed extractors; runtime test gates this. |
| 4.11 `expectedAction` on examples | FIXED | All golden examples include expected action or explicit null/refusal semantics. |
| 4.12 Retrospective docs accuracy | FIXED_WITH_REMAINING_DOC_AUDIT_DEBT | Seven catalog docs were spot-corrected, but workspace docs audit still reports broader pre-existing issues. |

## 7. Chat test matrix results

The original Section 6 matrix is covered by registry-backed fixtures and focused row-level suites.

| Matrix area | Status | Evidence |
| --- | --- | --- |
| All 92 original chat rows | PASS | Registry fixture builder and end-to-end routing tests cover the original matrix shape; full regression includes these gates. |
| R1-R10 refusal/safety rows | PASS | `chat-action-risk-policy-matrix.test.ts` covers prompt injection, sensitive exfiltration, destructive bulk deletes, and PT/ES past tense. |
| MT1-MT5 multi-turn rows | PASS | `registry-multi-turn-state-injection.test.ts` and `registry-multi-turn-es-state-injection.test.ts` cover real pending state persistence and continuation. |
| Functional golden routing | PASS | EN 79/79, PT 69/69, ES 45/45. |
| Ambiguous/missing-slot behavior | PASS | Missing required slots create clarification/pending state rather than execution. |
| Past-tense statements | PASS | PT/ES/EN past statements do not trigger new actions. |

At least three end-to-end smokes from the original Section 5 scope were executed:

- Registry golden examples as living corpus through the deterministic planner.
- Multi-turn pending continuation through real chat-action state persistence.
- Multi-region registry alert channel smoke dry-run with `slack-us` and `slack-eu`.

No live provider/staging/production smoke was run.

## 8. Safety/refusal/risk-policy results

Risk-policy verification is PASS.

Required expectations:

| Expectation | Status |
| --- | --- |
| Read-only actions may execute immediately | PASS |
| Non-destructive create actions execute only when required slots are complete | PASS |
| Draft email must not send | PASS |
| Send email requires confirmation | PASS |
| Destructive actions require confirmation | PASS |
| Bulk destructive actions refuse or require explicit scoped confirmation | PASS |
| Financial payment/refund actions require strong confirmation | PASS |
| Ambiguous calendar delete/move clarifies or confirms | PASS |
| Prompt-injection and embedded instruction attempts refuse | PASS |
| Past-tense statements do not trigger new actions | PASS |

Risk matrix coverage:

- One row generated for each of 45 active actions.
- Risk level, immediate execution, preview classification, confirmation, and strong-confirmation columns are asserted.
- Financial/admin-security actions are pinned to strong confirmation.
- External side-effect/destructive actions are pinned to confirmation.
- Mail draft/send separation is explicitly tested.
- Decision center choose/dismiss/snooze/follow-up behavior is covered.
- Notification preference changes are covered.

## 9. Tenant isolation results

Tenant isolation verification is PASS.

Coverage added:

- Tenant A/user A cannot read tenant B/user B pending actions.
- Tenant A/user A cannot continue tenant B pending actions.
- Tenant A/user A cannot execute using tenant B resource IDs.
- Tenant A/user A cannot read tenant B telemetry.
- Provider connection status is scoped.
- Notification preferences are scoped.
- Stale conversation IDs cannot cross tenant boundaries.
- Same numeric user ID across different tenants remains isolated in content/training/state paths covered by full regression.

Critical isolation failures found during this QA were fixed before final regression. Final full Vitest run passed.

## 10. Idempotency/retry results

Idempotency and retry verification is PASS.

Covered scenarios:

- Same user message submitted twice with same request/idempotency shape.
- Timeout after provider success.
- Provider success but verifier failure.
- Duplicate confirmation click.
- Duplicate pending continuation turn.
- Repeated send-email/payment commands.

Expected behavior verified:

- No duplicate calendar events/tasks for same request.
- No duplicate finance payment/refund mutation on retry.
- No duplicate send-email execution on confirmation retry.
- Confirmation tokens are single-use where applicable.
- Final responses explain created/already-existed/retry-needed state.

Fixes landed:

- Calendar/task replay now checks verified prior action runs before conflict preflight.
- Provider read-back preflight is bounded by timeout.
- Finance payment replay uses the same duplicate-run replay path.

## 11. Provider failure results

Provider failure verification is PASS.

Covered classes:

- Disconnected provider.
- Expired-token style error.
- Permission denied.
- Rate limit.
- Timeout.
- Provider 500.
- Malformed provider response.
- Verifier cannot confirm.

Expected behavior verified:

- No crash.
- No silent success.
- No internal error leakage.
- Safe actionable user response.
- Correct failed/pending/retryable state.
- Telemetry records safe provider class and does not store raw secret/error payload.

## 12. LLM fallback results

LLM fallback contract verification is PASS.

Mocked LLM responses covered:

- Valid action.
- Unknown action.
- Valid action with forbidden args.
- Destructive action without confirmation.
- Financial action without strong confirmation.
- Malformed JSON.
- Prompt injection inside JSON fields.

Assertions:

- Model output must match strict JSON schema.
- Unknown action names are rejected.
- Forbidden args are stripped.
- Typed validators still run after model output.
- Executor/verifier cannot be supplied by model.
- Risk policy applies after model output.
- Destructive/financial actions cannot bypass confirmation.
- Invalid JSON fails safely.
- Prompt injection inside JSON fields is treated as untrusted data.

Important fix:

- LLM fallback model-proposed `missingFields` no longer bypasses typed slot validators.

## 13. Prompt/log/telemetry redaction results

Prompt/log/telemetry redaction verification is PASS, with one Phase 16 observability recommendation.

Redaction denylist tested across prompts, logs, telemetry, snapshots, and reports:

- Access tokens.
- Refresh tokens.
- OAuth credentials.
- Provider tokens.
- Raw tenant/user IDs unless explicitly allowed.
- Email bodies unless explicitly allowed.
- Payment confirmation data.
- Executor/verifier internals.
- Raw system prompts.
- Internal reasoning/debug cards.

Indirect prompt injection tests covered malicious instructions inside:

- Calendar title.
- Email subject/body.
- Task title.
- Content brief.
- Receipt text.
- Pending context.

Expected result verified: malicious content is treated as untrusted data; destructive actions do not execute; risk policy is not bypassed; secrets do not appear in args, prompts, logs, telemetry, or snapshots.

Slot extractor/validator observability:

- Safe per-slot validation status is recorded.
- Full extractor/validator outcomes are not fully represented as value-free telemetry across all actions. This remains a Phase 16 observability recommendation rather than a release blocker.

## 14. Performance/token budget results

Performance and token-budget gates are PASS locally.

| Metric | Gate | Observed | Status |
| --- | ---: | ---: | --- |
| Deterministic route p95 | <100ms | 0.660ms | PASS |
| Registry retrieval p95 | <25ms | 0.021ms | PASS |
| Full registry matrix runtime | bounded | 10.462ms / 244 scenarios | PASS |
| Max safe prompt slice size | compact | 1378 bytes | PASS |
| Tier 2 examples sent to model | bounded | 6 | PASS |
| Max registry prompt payload | <12KB | 11,428 bytes | PASS |
| Full repo regression runtime | informational | 98.64s | PASS |

Token-budget controls:

- No full registry sent to model.
- Executor/verifier/policy objects absent from prompt slices.
- Example retrieval is relevance-capped and bounded.
- Broad multi-skill prompt view was capped to 11 actions and 6 examples.

## 15. Bugs found

Runtime/test bugs found and fixed during the Phases 0-15 QA:

- Runtime registry validation was previously over-reliant on grep counts.
- Some registry examples lacked or did not enforce `expectedAction` functionally.
- Spanish task-reminder examples misrouted before deterministic parser fixes.
- `noopSlotExtractor` usage lacked a runtime inventory.
- `retrievePlannerExamples` could expose raw/full registry example shape to LLM prompt construction.
- Model-proposed args and deterministic reflected args needed stricter forbidden-key and sensitive-text stripping.
- Risk policy allowed sensitive exfiltration language and bulk destructive requests to proceed too far.
- Secretary calendar fast-path duplicated local date/time parsing logic.
- PT/ES past-tense and mixed past/future utterances needed stronger routing coverage.
- Pending continuation lacked a no-mock persistence integration test.
- Calendar retry could duplicate/conflict after provider success plus verifier failure/timeout.
- Finance payment retry did not initially use the same replay path as other action runs.
- LLM fallback could trust model-proposed missing-slot metadata too much.
- Content scheduling examples could be stolen by the calendar parser before content preflight.
- Broad LLM registry prompt payload exceeded desired budget before relevance cap.
- Stale inline-regex consolidation test still expected removed secretary fast-path helpers.
- Identity question detector failed `"What's my name?"` after punctuation normalization.
- Portal route owner test did not account for the exact static brand asset route.
- WhatsApp adapter barrel export was missing.

Open failures not fixed:

- Workspace docs audit still reports 618 existing documentation issues.
- Live provider, staging, production, and TestFlight validation were not run.

## 16. Bugs fixed

Final fixes made in the closing pass:

- Updated `identity-question-detector` to recognize normalized `"what s my name"`.
- Updated portal static-route source-pin test to include the exact immutable brand asset route before portal page routes.
- Exported `WhatsAppAdapter` and `WhatsAppConfig` from `src/adapters/index.ts`.
- Updated the stale registry inline-regex consolidation test so it now asserts secretary fast-path delegates to the canonical parser instead of expecting removed helpers.
- Added a root-level content-engine pytest proxy so the original Phases 0-15 command verifies the real Python suite.
- Refreshed the workspace docs mirror, adding the seven missing catalog/current docs to `_workspace-mirror`.

Earlier scoped fixes across the QA branch include:

- Runtime registry introspection gates.
- Functional golden routing gates by locale.
- Prompt safe-slice and safe few-shot retrieval hardening.
- Forbidden model arg stripping.
- Indirect prompt-injection protections.
- Risk-policy matrix and R1-R10 safety behavior.
- Date/time deterministic parser tests and canonical parser delegation.
- Pending continuation persistence integration.
- Tenant isolation/idempotency/provider failure tests and fixes.
- LLM fallback schema, typed-slot, and risk-policy enforcement.
- Telemetry/logging redaction tests.
- Channel smoke builder and dry-run script.
- Performance/token-budget gates.
- Backend-to-iOS contract fixtures.

## 17. New tests added

Representative new/expanded test coverage:

```text
__tests__/adapters/whatsapp-adapter-qa-validation.test.ts
__tests__/adapters/whatsapp-adapter.test.ts
__tests__/lib/registry-fixture-builder.test.ts
__tests__/services/calendar-natural-language-parser-determinism.test.ts
__tests__/services/calendar-natural-language-parser-es.test.ts
__tests__/services/chat-action-performance-token-budget.test.ts
__tests__/services/chat-action-production-safety.test.ts
__tests__/services/chat-action-prompt-safety.test.ts
__tests__/services/chat-action-registry-completeness.test.ts
__tests__/services/chat-action-registry-typed-slot-adoption.test.ts
__tests__/services/chat-action-risk-policy-matrix.test.ts
__tests__/services/chat-action-runtime-architecture.test.ts
__tests__/services/identity-question-detector.test.ts
__tests__/services/past-tense-detector-es.test.ts
__tests__/services/past-tense-detector-multi-locale.test.ts
__tests__/services/registry-alert-channels-ci-gate.test.ts
__tests__/services/registry-channel-smoke-builder.test.ts
__tests__/services/registry-channel-smoke.test.ts
__tests__/services/registry-examples-as-living-corpus-shadow.test.ts
__tests__/services/registry-examples-end-to-end-routing.test.ts
__tests__/services/registry-inline-regex-consolidation.test.ts
__tests__/services/registry-multi-turn-es-state-injection.test.ts
__tests__/services/registry-multi-turn-state-injection.test.ts
__tests__/services/registry-per-action-minimum-eval-gate.test.ts
__tests__/services/registry-real-eval-gates-locale.test.ts
__tests__/services/registry-real-eval-gates.test.ts
__tests__/services/registry-telemetry-report.test.ts
tests/test_content_engine_proxy.py
```

Final verification:

- Full Vitest: 597 files, 8924 tests passed.
- Original root Python command: 1 proxy test passed, executing the real content-engine suite.
- Corrected content-engine pytest: 146 tests passed.

## 18. Documentation updates

Documentation artifacts created/updated:

- `docs/qa/PHASES_0_15_CODEX_QA_PROMPT.md`
- `docs/qa/PHASES_0_15_QA_REPORT.md`
- `docs/qa/PHASES_0_15_IOS_CONTRACT_FIXTURES.md`
- `docs/skill_interaction_catalog_architecture_audit.md`
- `docs/skill_interaction_catalog_decision_matrix.md`
- `docs/skill_interaction_catalog_eval_plan.md`
- `docs/skill_interaction_catalog_implementation_plan.md`
- `docs/skill_interaction_catalog_schema_proposal.md`
- `docs/skill_interaction_catalog_security_review.md`
- `docs/release/current-release-index.md`

Docs audit result:

```text
markdown files audited: 665
workspace mirror files skipped: 50
issues flagged: 618
broken-markdown-reference: 69
commit-hash-not-found-in-own-repo: 5
duplicate-or-scattered-current-verdict: 40
markdown-outside-approved-current-or-archive-location: 350
test-count-literal-outside-current-report: 154
```

This is still a FAIL_BASELINE item. The seven workspace mirror misses from the previous report were fixed by running `scripts/workspace-docs-mirror.sh`; the Phases 0-15 prompt's four broken shorthand retrospective-doc links now point at the real catalog docs; and the exact Phases 0-15 prompt/report/iOS fixture artifacts are registered as intentional current QA documents in `scripts/audit-docs.mjs`.

Docs-audit warning triage:

| Warning class | Triage result | Action taken |
| --- | --- | --- |
| Generated `.pytest_cache/README.md` | false positive | `.pytest_cache` added to ignored doc-audit directories. |
| Placeholder/template links such as `<YYYY-MM-DD>` and `{date}` | false positive | Markdown resolver now skips placeholder refs. |
| Markdown-looking paths inside fenced code/status blocks | false positive | Docs audit now masks fenced code blocks before link/count/hash scanning. |
| iOS spec refs under `Nexus Hub IOS/specs` | false positive | Resolver now maps to the real sibling iOS specs root. |
| Xcode destination/device IDs parsed as commit hashes | false positive | Audit now masks UUID/device-id strings before commit-hash checks. |
| Root `BRANCHING`, `CHANGELOG`, `DEPLOY`, `DOCUMENTATION`, `STAGING` docs | false positive location warning | Registered exact root docs listed in `docs/DOCUMENTATION-MAP.md` as canonical/current. |
| Missing historical WhatsApp adapter task doc in `docs/DOCUMENTATION-MAP.md` | true stale link | Removed the nonexistent historical-doc reference. |
| Workspace catalog links to shorthand security/schema proposal docs | true stale links | Updated to the actual catalog doc filenames and refreshed the workspace mirror. |
| Remaining 69 broken references | true or unresolved historical references | Left flagged; most are stale references in old/current QA/release docs that need content-owner archive or rewrite decisions. |
| Remaining 350 location warnings | true under current policy | Left flagged; these docs need archive/current-doc routing decisions. |
| Remaining 154 literal test-count warnings | true under current policy | Left flagged; counts should move to current release/QA surfaces or generated artifacts. |
| Remaining 40 duplicate verdict warnings | true under current policy | Left flagged; scattered verdict language should be archived or consolidated. |
| Remaining 5 commit-hash warnings | unresolved | Left flagged; these need owner confirmation whether they are stale SHAs or external/cross-repo evidence IDs. |

## 19. iOS contract implications

Backend-to-iOS QA handoff artifact:

- `docs/qa/PHASES_0_15_IOS_CONTRACT_FIXTURES.md`

It includes 12 response fixtures:

1. Successful action plan.
2. Pending confirmation.
3. Refusal.
4. Missing slot question.
5. Provider disconnected.
6. Action failed.
7. Action verified.
8. Destructive confirmation required.
9. Financial strong confirmation required.
10. LLM fallback rejected.
11. Provider timeout/retryable state.
12. Duplicate request/idempotent result.

Each fixture documents scenario name, user message, expected backend state, expected UI card type, expected user-facing copy, fields iOS must never show, loading/empty/error state, button enabled/disabled expectation, confirmation requirement, strong-confirmation requirement, and XCUITest notes.

Stable backend fields iOS should preserve:

- `status`
- `cardType`
- `actionId`
- `confirmationRequired`
- `strongConfirmationRequired`
- `retryable`
- `provider`
- `safeMessage`
- `missingSlots`
- `actions`

iOS must never show executor/verifier internals, provider tokens, raw prompts, model traces, raw email bodies unless explicitly part of a user-approved draft UI, payment confirmation data, or tenant/user IDs intended only for backend scoping.

Known iOS contract risks:

- Some response shapes are fixtures rather than live route captures.
- TestFlight/device validation was not run.
- UI card names must stay mapped to backend `cardType` values or the handoff loses value.

## 20. Missing findings

Missing or not fully verified items:

- Workspace docs audit fails because 618 broad documentation hygiene warnings remain after false-positive filtering and obvious link fixes.
- No live provider tests were run against Google, Outlook, Stripe/finance, Slack, APNs, or real calendar/mail APIs.
- No staging deploy, staging smoke, production promote, or production health check was performed.
- No signed TestFlight or iOS XCUITest pass was performed from this backend QA branch.
- No real two-account device walkthrough was performed.
- No load test beyond local latency/token-budget gates was performed.
- Full extractor/validator telemetry is not implemented as value-free aggregate observability across every action.

## 21. Phase 16 recommendations

Recommended Phase 16 follow-ups:

- Keep the root-level content-engine pytest proxy in place or update the original QA prompt to call the direct content-engine path explicitly.
- Clean/archive scattered historical markdown and stale links to reduce the remaining true docs-audit findings.
- Decide whether the manifest loader should run at production startup or remain a test/runtime-direct validator.
- Keep `chat-skill-capability-registry.ts` while it still powers grounding/capability metadata; revisit deletion only if all runtime consumers move to the action registry.
- Add value-free extractor/validator telemetry aggregates per action/slot without recording raw slot values.
- Add live staging smoke for active hybrid planner mode.
- Add signed TestFlight iOS contract validation using the 12 backend fixtures.
- Add provider-level canary tests for real Google/Outlook/Slack/APNs behavior.
- Add longer-running performance/load gates for high-volume registry/prompt construction paths.
- Add periodic adversarial registry example proposal review to keep the living corpus from becoming stale.

## 22. Final verdict: PASS / PASS-WITH-FIXES / PARTIAL / FAIL / NOT-VERIFIED

Result: PARTIAL.

Reasoning:

- PASS for TypeScript, runtime registry introspection, functional golden routing, ES hard gate, focused registry/chat/calendar/past-tense tests, production risk policy, tenant isolation, idempotency/retry, provider failure behavior, LLM fallback contract, prompt/log/telemetry redaction, performance/token-budget gates, full Vitest regression, the original root-level Python command, and corrected content-engine pytest.
- PASS-WITH-FIXES for runtime QA implementation: the final full-regression failures were fixed, the root Python command was repaired with a proxy, and the workspace mirror misses were refreshed.
- FAIL_BASELINE for workspace docs audit because 618 existing documentation issues remain after false-positive filtering.
- NOT-VERIFIED for live provider, staging, production, and signed iOS/TestFlight validation.

This branch is not production-ready by checklist absolutism because the workspace docs audit still fails and live provider/staging/production/iOS validation was not run. It is materially ready for the next backend-runtime review: the runtime/test implementation passes TypeScript, focused Vitest, full Vitest, the original Python command, and the direct content-engine pytest suite.
