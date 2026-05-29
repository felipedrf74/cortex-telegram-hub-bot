# ChatCoreV2 Implementation Readiness Matrix

**Generated:** 2026-05-27
**Work Order:** `docs/qa/work-orders/WO-chatcore-v2-production-activation.md`
**Branch:** `codex/chatcore-v2-production-activation-wo`
**Base commit:** `e5ca0034`

This matrix verifies the full implementation plan against the current branch.
Items are either complete in this non-runtime slice or marked impossible to
complete now with a specific reason and unblocker.

## Overall Status

The full plan is not complete. Runtime implementation is impossible in this
branch at this point because the Work Order itself blocks runtime behavior until
D1-D16, D3 benchmark readiness, corpus labels, and peer validation are complete.
This branch now includes starter implementations plus one scoped runtime
hotfix for task write-intent sandbox regressions: the bounded
`ChatTurnPlanMicro` validator, plan validator, bounded repair/prompt-budget
helpers, activation/cloud/evidence/prepass/observability/golden-corpus
contract helpers, auto-revert/staleness/write-verification policy helpers,
locale preservation policy helper, focused tests, and a read-only D3
full-suite benchmark harness. It also includes the V1 ChatCoreV2 write-intent
firewall for exact task create/complete and local Docker SQLite journal-mode
configuration for reliable simulator verification.

No Claude Code final QA prompt should be created yet.

## Work Order And Inventory

| Item | Status | Evidence | Why not further now |
|---|---|---|---|
| Fresh Work Order | complete | `WO-chatcore-v2-production-activation.md` | n/a |
| Branch/worktree declared | complete | Work Order header | n/a |
| Owned areas declared | complete | Work Order ownership section | n/a |
| Non-runtime delivery boundary | complete | Work Order current delivery boundary | n/a |
| iOS dependency surfaced | complete | Work Order cross-team dependency | n/a |
| Route-exit inventory | complete for Phase 0 | `chat-route-exit-inventory.md` | Peer validation still required |
| Module/gap inventory | complete for Phase 0 | `chatcore-v2-module-inventory.md` | Peer validation still required |
| Layer 1 assembly map | complete for docs plus pure selector helper | `chatcore-v2-layer1-assembly-map.md`, `src/services/chat-core-v2/prepass-candidate-selection.ts` | Runtime integration blocked by D3/D1-D16 gates |

## Phase 0 Benchmark

| Item | Status | Evidence | Why impossible now |
|---|---|---|---|
| Read-only VPS readiness | complete | `chatcore-v2-planner-calibration-2026-05-27.md` | n/a |
| 3B tiny probes | complete | 3.3s/4.4s values in benchmark doc | n/a |
| 2k/3k prompt probes | complete as calibration, failed gate | 58.6s/37.5s values in benchmark doc | n/a |
| Ultra-compact sequential probe | complete as latency calibration, promising | p50 2085.1 ms / p95 4582.4 ms over 10 calls with `num_predict=12` | Does not prove full schema |
| Strict-schema qwen 3B tiny validation | complete, failed latency gate | 3 sequential calls, `num_predict=180`, p50 12564 ms / p95 14922 ms, zero transport failures, zero schema failures | Misses 5s p95 target |
| Strict-schema Gemma 2B tiny comparison | complete, failed latency gate | 3 sequential calls, `num_predict=180`, p50 14240 ms / p95 18231 ms, zero transport failures, zero schema failures | Slower than qwen in this check |
| Strict-schema qwen output-cap probes | complete, failed latency/schema gate | one call each: `num_predict=60` 5747 ms invalid JSON; `80` 7244 ms invalid JSON; `100` 9373 ms invalid JSON; `120` 17501 ms valid | Lowering output cap alone is not enough |
| Compact wire-plan qwen probe | complete, improved but failed full gate | `num_predict=28`, `num_ctx=512`, `think=false`, 10 warmed sequential calls, 0 failures, 0 schema failures, p50 4705 ms / p95 5325 ms | Still misses p50 <= 2s and p95 <= 5s; `num_predict=20` p95 passed but caused 6/10 schema failures |
| Atom-packet qwen probe | complete, p95 passes, p50 fails | `num_predict=8`, `num_ctx=512`, 2 warmups + 10 measured calls, 0 failures, 0 schema failures, p50 3577 ms / p95 4194 ms | p95 <= 5s is viable; p50 <= 2s still fails |
| Atom-packet Gemma 2B comparison | complete, p95 passes, p50 fails | `num_predict=10`, `num_ctx=512`, 2 warmups + 10 measured calls, 0 failures, 0 schema failures, p50 3274 ms / p95 3580 ms | Faster than qwen, but still misses p50 <= 2s and would require a planner model decision |
| Raw-prompt atom Gemma 2B probe | complete, best current installed-model p50, still fails | `/api/generate`, `--raw-prompt=true`, `num_ctx=256`, `num_predict=10`, 0 failures, 0 schema failures, p50 3138 ms / p95 3484 ms | Reduces template overhead but still misses p50 <= 2s |
| Raw-prompt atom qwen probe | complete, p95 passes, p50 fails | `/api/generate`, `--raw-prompt=true`, `num_ctx=256`, `num_predict=8`, 0 failures, 0 schema failures, p50 3368 ms / p95 3688 ms | Still misses p50 <= 2s |
| Raw-prompt `num_ctx=128` probes | complete, failed | Gemma p50 4337 ms / p95 5124 ms, 0 schema failures; qwen p50 5632 ms / p95 6041 ms, 4/10 schema failures | Further context reduction worsened latency and qwen schema compliance |
| Full-suite benchmark harness | complete | `scripts/llm/chatcore-v2-planner-benchmark.ts --suite=all` supports sequential, burst, concurrent, and sustained phases | Actual production-sized run still needs safe window |
| Full 100 sequential benchmark execution | impossible now | D3 full suite not scheduled | Needs safe benchmark window or staging-equivalent hardware |
| Burst benchmark execution | impossible now | D3 full suite not scheduled | Same |
| 5-concurrent benchmark execution | impossible now | Could affect production users without a scheduled window | Needs safe benchmark window or staging-equivalent hardware |
| 5-minute sustained benchmark execution | impossible now | Unsafe against production without an approved window | Needs safe benchmark window or staging-equivalent hardware |

Unblocker: perform another latency-tuning pass that changes more than
`num_predict` alone, then run the full D3 suite with schema validation in a
safe window or staging-equivalent environment.

## Phase 1 Contracts

| Item | Status | Evidence | Why not further now |
|---|---|---|---|
| `ChatTurnPlanMicro` contract | implemented for first validator slice | `chatcore-v2-phase1-contracts.md`, `src/services/chat-core-v2/plan-schema.ts`, strict Ollama JSON schema export, focused vitest | Needs full D3 schema-valid benchmark and peer review |
| Plan validator | first helper implemented | `src/services/chat-core-v2/plan-validator.ts` | Runtime route-decision integration blocked until Phase 2 |
| Planner repair loop | first bounded helper implemented | `src/services/chat-core-v2/planner-repair.ts` | Runtime retry integration blocked until Phase 2 |
| Prompt-size budget | helper implemented | `src/services/chat-core-v2/prompt-budget.ts` | Exact production budget still depends on D3 |
| Evidence taxonomy | first binding helper implemented | `chatcore-v2-phase1-contracts.md`, `src/services/chat-core-v2/answer-composition.ts` | Needs domain owner taxonomy review |
| Prepass candidate algorithm | helper-backed draft | same, Layer 1 map, `src/services/chat-core-v2/prepass-candidate-selection.ts`, `src/services/chat-core-v2/prepass-contract.ts`, `src/services/chat-core-v2/prepass-miss-log.ts` | Needs corpus validation |
| Golden corpus spec | schema and spec complete | `chatcore-v2-golden-corpus-spec.md`, `src/services/chat-core-v2/golden-corpus.ts` | Actual corpus needs real labeled failures |
| `DomainAdapterV1` | first interface implemented | Phase 1 contracts, `src/services/chat-core-v2/domain-adapter.ts` | Domain adapter implementations later |
| iOS turn-state contract | first helper implemented | Phase 1 contracts, `src/services/chat-core-v2/turn-state-events.ts` | iOS repo/team implementation separate |
| Background lifecycle | first helper implemented | Phase 1 contracts, `src/services/chat-core-v2/background-lifecycle.ts` | Requires runtime queue implementation later |
| Answer composition budgets | first constants/validator implemented | Phase 1 contracts, `src/services/chat-core-v2/answer-composition.ts` | Measurement requires runtime traffic |
| Kill switch and auto-revert spec | first config/policy helpers implemented, action gateway now honors master off | Work Order, Phase 1 contracts, `src/services/chat-core-v2/activation-flags.ts`, `src/services/chat-core-v2/auto-revert-policy.ts`, `src/services/chat-core-v2/action-gateway.ts` | Broader orchestrator mode mutation remains blocked by Phase 2 start |
| Local LLM answer sandbox path | implemented for Mac Docker/iOS validation only | `src/services/chat-core-v2/local-chat-orchestrator.ts`; `CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE=canary`; live sandbox request returned `routeMethod=chat-core-v2-local-llm`, provider `ollama`, model `qwen2.5:3b-instruct-q4_K_M` | Not a production Phase 3 canary; Phase 2 shadow gates still block broader rollout |
| Model residency policy | config resolver/validator implemented | Phase 1 contracts, `src/services/chat-core-v2/model-residency-policy.ts` | Actual daemon/runtime application needs deployment work |
| Cloud allowlist spec | first HMAC/packet helper implemented | Phase 1 contracts, `src/services/chat-core-v2/cloud-allowlist-packet.ts` | Runtime cloud fallback blocked until Phase 7 |
| Write risk gradient | first helper implemented | Phase 1 contracts, `src/services/chat-core-v2/write-risk-policy.ts` | Runtime enforcement blocked until Phase 5/6 |
| Observability matrix | constants plus allowlisted safe event normalizer implemented | Phase 1 contracts, `src/services/chat-core-v2/failure-observability.ts` | Dashboards/tables require runtime implementation |
| Pure-deterministic prepass audit | initial audit complete plus CI-friendly source guard implemented | Layer 1 assembly map, `src/services/chat-core-v2/prepass-contract.ts` | Repo-wide CI wiring can be added when Layer 1 runtime modules exist |

## Runtime Phases

| Phase | Status | Why impossible now | Required unblocker |
|---|---|---|---|
| Phase 2 plan-only shadow | impossible now | D3 latency gate failed; D1-D16 are not peer-reviewed; no kill switch, shadow table, repair loop, or rollout tests exist | Tune D3 latency, implement remaining contracts, peer-review D1-D16 |
| Phase 3 answer canary | impossible now | Requires Phase 2 shadow evidence and iOS UX decision | Phase 2 pass plus dashboards |
| Phase 4 deterministic reads | impossible now | Requires orchestrator runtime and tenant/user isolation tests | Phase 2/3 pass |
| Phase 5 write preview | impossible now | Requires command bus integration from orchestrator and visible diff tests | Phase 4 pass and Class A corpus |
| Phase 6 confirmed writes | impossible now | Requires background lifecycle, idempotency, readback verification | Phase 5 pass |
| Phase 7 cloud allowlist | impossible now | Requires positive allowlist module, telemetry, budget gates | Earlier local paths stable |
| Phase 8 legacy retirement | impossible now | Requires route-level parity >= 95% over at least 50 rows and fallback rate < 2% | Shadow/canary production data |

## Required Tests And Gates

| Test/gate | Status | Why impossible now |
|---|---|---|
| Master kill switch beats all flags | config helper and task action-gateway mode test complete; broader runtime path blocked | `src/services/chat-core-v2/activation-flags.ts`, `src/services/chat-core-v2/action-gateway.ts`; Phase 2 orchestrator integration still required |
| Auto-shadow-revert threshold behavior | policy helper complete; runtime mutation blocked | `src/services/chat-core-v2/auto-revert-policy.ts`; needs telemetry counters and mode mutation path |
| WebSocket reconnect sequenceNumber resume | sequence helper test complete; server/iOS runtime blocked | `src/services/chat-core-v2/turn-state-events.ts`; requires iOS/server progress event implementation |
| Background `superseded` transition | policy helper test complete; runtime queue blocked | `src/services/chat-core-v2/background-lifecycle.ts`; requires background queue implementation |
| HMAC-only shadow/cloud identifiers | cloud/prepass HMAC helpers complete; shadow storage blocked | `src/services/chat-core-v2/cloud-allowlist-packet.ts`, `src/services/chat-core-v2/prepass-miss-log.ts`; shadow table runtime not implemented |
| No raw private strings in cloud packets | allowlist packet helper test complete; runtime egress blocked | `src/services/chat-core-v2/cloud-allowlist-packet.ts`; no cloud runtime path wired |
| No unvalidated writes | validator/write policy helpers complete; orchestrator blocked | `src/services/chat-core-v2/plan-validator.ts`, `src/services/chat-core-v2/write-risk-policy.ts`; orchestrator write path not implemented |
| No write success without verification | policy helper complete; runtime readback blocked | `src/services/chat-core-v2/write-verification-policy.ts`; verification/readback path not implemented |
| Context hash mismatch re-read/replan | policy helper complete; runtime orchestration blocked | `src/services/chat-core-v2/context-staleness-policy.ts`; context compiler/orchestrator not implemented |
| Locale preservation | policy helper complete; composer runtime blocked | `src/services/chat-core-v2/locale-preservation-policy.ts`; final composer/runtime not implemented |
| Task write-intent firewall hotfix | complete for V1 sandbox scope | Exact task completion resolves by canonical ID and verifies before success; unresolved/negated/hypothetical task writes stop before legacy paths; duplicate-title completion asks clarification even when sandbox auto-execute is enabled; task-with-subtasks is preview-only. Full Phase 5/6 remains blocked by orchestrator runtime gates. |
| Golden corpus seed | complete for regression seed, not final gate | `src/services/chat-core-v2/golden-corpus-seed.ts` has 263 safe-paraphrase items, 7 operator-reported real failure seeds, all required languages, and validator coverage | Needs peer-reviewed private-evidence promotion before Phase 2 shadow |
| Local Docker SQLite visibility | complete for simulator sandbox | `SQLITE_JOURNAL_MODE=DELETE` is documented for `.env.local.example`, and `src/services/storage-provider.ts` supports `SQLITE_JOURNAL_MODE`. Local Docker smoke and manual chat create/complete checks now read the same committed task rows via REST and SQLite. |
| Recipe/action-success regression | impossible now | Requires final composer/critic implementation |
| Content-published claim regression | impossible now | Requires final composer/critic implementation |
| Finance account-access regression | impossible now | Requires final composer/critic implementation |
| Triathlon scheduled-without-verification regression | impossible now | Requires final composer/critic implementation |
| Focused ChatCoreV2 contract vitest | complete | 42/42 passing across `chat-core-v2-plan-schema.test.ts` and `chat-core-v2-activation-contracts.test.ts` after atom-packet, source-audit, safe-metadata guard additions, and golden-corpus seed validation |
| Broad ChatCoreV2 vitest sweep | complete | 264/264 passing across 31 `chat-core-v2-*.test.ts` files after atom-packet, source-audit, safe-metadata guard additions, and golden-corpus seed validation |
| Focused schema/harness TypeScript check | complete | Passed for the new ChatCoreV2 contract modules, benchmark harness, and focused tests |
| Full `npm run verify` for current branch | complete | 730/730 test files and 10,802/10,802 tests passed after the scoped write-intent firewall, local SQLite journal-mode fix, legacy-schema-safe plan resolver fix, atom-packet benchmark tuning, source-audit, safe-metadata guard additions, and golden-corpus seed validation |
| Agent lane helper check | complete | Added `scripts/verify-agent-lanes.mjs` plus `docs/qa/AGENT_WORK_REGISTRY.md`; both AGENTS commands pass locally |

## Cleanup And Integration

| Item | Status | Why impossible now |
|---|---|---|
| Runtime cleanup | partial | Runtime changes are intentionally scoped to the task write-intent firewall and local SQLite journal-mode configurability; broader orchestrator runtime is not implemented. |
| Integration hook in `chat-message-routes.ts` | complete for V1 task firewall only | Broader ChatCoreV2 orchestrator behavior remains blocked until Phase 2 gates. |
| Production deploy | impossible now | No production deploy authorized; this branch is local/sandbox only. |
| Production verification | impossible now | Nothing deployed from this branch |
| Final Claude Code QA handoff | impossible now | Full implementation not complete |

## Stop Condition

The only honest stop condition for this branch is: documentation/schema/
contract/harness slice complete, V1 task write-intent sandbox hotfix verified,
broader runtime implementation explicitly blocked by D3 and upstream evidence
requirements, and no final QA prompt created.
