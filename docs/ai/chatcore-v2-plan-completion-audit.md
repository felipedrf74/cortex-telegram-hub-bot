# ChatCoreV2 Production Activation Completion Audit

**Generated:** 2026-05-27
**Work Order:** `docs/qa/work-orders/WO-chatcore-v2-production-activation.md`
**Branch:** `codex/chatcore-v2-production-activation-wo`
**Base commit:** `e5ca0034`

## Verdict

The full implementation plan is not 100% complete.

No Claude Code QA prompt has been created because the Work Order is not ready
for final QA. The current branch contains Work Order support plus deliberately
scoped local-sandbox runtime bridges: documentation, the initial bounded
planner schema validator, plan validator, bounded repair/prompt-budget helpers,
first-slice activation/cloud/evidence/prepass/observability/golden-corpus
contract helpers, auto-revert/staleness/write-verification policy helpers,
focused tests, a locale preservation policy helper, and a read-only D3
full-suite benchmark harness. It also includes a pure Layer 1 candidate selector
that is not wired into the future 3B-planner runtime. Runtime behavior changes
remain limited to the V1 ChatCoreV2 write-intent firewall for task
create/complete sandbox regression testing, provider-aware local task reads,
iOS chat task-create server routing, iOS recipe parsing/progress fixes, and
local Docker SQLite journaling configuration so simulator verification reads
committed task rows reliably.

## Completed In This Branch

| Item | Status | Evidence |
|---|---|---|
| Work Order created | complete | `docs/qa/work-orders/WO-chatcore-v2-production-activation.md` |
| Route-exit inventory | complete for Phase 0 draft | `docs/ai/chat-route-exit-inventory.md` |
| ChatCoreV2 module inventory | complete for Phase 0 draft | `docs/ai/chatcore-v2-module-inventory.md` |
| Layer 1 assembly map | complete for documentation | `docs/ai/chatcore-v2-layer1-assembly-map.md` |
| Phase 1 D4-D16 contracts | drafted | `docs/ai/chatcore-v2-phase1-contracts.md` |
| Golden corpus specification | drafted | `docs/ai/chatcore-v2-golden-corpus-spec.md` |
| Implementation readiness matrix | complete | `docs/ai/chatcore-v2-implementation-readiness-matrix.md` |
| Initial `ChatTurnPlanMicro` validator | complete for D4 first slice | `src/services/chat-core-v2/plan-schema.ts`; focused vitest 8/8 |
| Plan validator | complete for Phase 2 first slice | `src/services/chat-core-v2/plan-validator.ts`; focused contract tests |
| Planner repair helper | complete for Phase 2 first slice | `src/services/chat-core-v2/planner-repair.ts`; focused contract tests |
| Prompt-budget helper | complete for D4 first slice | `src/services/chat-core-v2/prompt-budget.ts`; focused contract tests |
| Activation/config contract helper | complete for D11 first slice | `src/services/chat-core-v2/activation-flags.ts`; focused contract tests |
| Auto-revert threshold helper | complete for D11 first slice | `src/services/chat-core-v2/auto-revert-policy.ts`; focused contract tests |
| Answer draft/evidence binding helper | complete for D5/D10 first slice | `src/services/chat-core-v2/answer-composition.ts`; focused contract tests |
| Cloud allowlist/HMAC helper | complete for D13 first slice | `src/services/chat-core-v2/cloud-allowlist-packet.ts`; focused contract tests |
| Shadow-route hook HMAC identifiers | complete for current hook slice | `src/services/chat-core-v2/shadow-route-hook.ts`; skips recording without `CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET` / fallback secret; focused tests cover secret/tenant/user sensitivity |
| Write-intent HMAC telemetry | complete for current gateway slice | `src/services/chat-core-v2/action-gateway.ts`; missing `CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET` no longer uses a hardcoded fallback secret and emits `hmac_unavailable` instead |
| DomainAdapterV1 interface | complete for D7 first slice | `src/services/chat-core-v2/domain-adapter.ts` |
| Turn-state event helper | complete for D8 first slice | `src/services/chat-core-v2/turn-state-events.ts`; focused contract tests |
| Background lifecycle helper | complete for D9 first slice | `src/services/chat-core-v2/background-lifecycle.ts`; focused contract tests |
| Model residency policy resolver/validator | complete for D12 first slice | `src/services/chat-core-v2/model-residency-policy.ts`; focused contract tests |
| Failure observability safe event normalizer | complete for D15 first slice | `src/services/chat-core-v2/failure-observability.ts`; string metadata is allowlisted; focused contract tests |
| Prepass bounds/source guard helper | complete for D16 first slice | `src/services/chat-core-v2/prepass-contract.ts`; actual Layer 1 selector source-audit test added |
| Prepass candidate selector | complete for D1/D6 first slice | `src/services/chat-core-v2/prepass-candidate-selection.ts`; focused contract tests |
| Prepass recall-miss HMAC helper | complete for D6 first slice | `src/services/chat-core-v2/prepass-miss-log.ts`; focused contract tests |
| Golden corpus validator | complete for D6 first slice | `src/services/chat-core-v2/golden-corpus.ts`; focused contract tests |
| Write-risk helper | complete for D14 first slice | `src/services/chat-core-v2/write-risk-policy.ts`; focused contract tests |
| Context staleness helper | complete for context-hash first slice | `src/services/chat-core-v2/context-staleness-policy.ts`; focused contract tests |
| Write success verification helper | complete for write-claim first slice | `src/services/chat-core-v2/write-verification-policy.ts`; focused contract tests |
| Locale preservation helper | complete for composer first slice | `src/services/chat-core-v2/locale-preservation-policy.ts`; focused contract tests |
| D3 benchmark harness | complete for safe rerun | `scripts/llm/chatcore-v2-planner-benchmark.ts` supports sequential, burst, concurrent, sustained, and `--suite=all` |
| VPS benchmark readiness probe | complete, read-only | SSH OK, Ollama active, `qwen2.5:3b-instruct-q4_K_M` present |
| 3B planner calibration | serialized gate accepted, multi-user scaling blocked | Operator revised the D3 foreground gate to p95 <= 5s at `num_ctx=256` with p50 <= 2s deferred. The bounded full `--suite=all` run produced zero transport/schema failures across 66 calls; sequential p50 3378 / p95 3669 ms PASS, while burst/concurrent/sustained p95 ~10-15s FAIL on CPU-only Ollama serialization. The local-inference concurrency cap mitigates per-call latency for L2 sandbox; multi-user Phase 2 still needs queue/hardware/model work. See `docs/ai/benchmarks/chatcore-v2-planner-calibration-2026-05-27.md` |
| Queue-aware cloud fallback policy | complete for Phase 2 contract slice | `src/services/chat-core-v2/queue-fallback-policy.ts`; cloud is eligible only when queue pressure crosses threshold, ChatCoreV2 cloud fallback is enabled, and a positive-allowlist packet is already safe. Denied packets background/wait/fail visibly without widening context. |
| Packet-only cloud answer dispatcher and safe generic-answer packet producer | complete for Phase 2 slice | `src/services/chat-core-v2/cloud-allowlist-answer.ts`, `src/services/chat-core-v2/cloud-allowlist-answer-packet.ts`; cloud calls receive only the allowlist packet prompt, while the producer is opt-in, budget/HMAC-gated, denies private/app-state requests, and emits HMAC-scoped turn/evidence fingerprints plus coarse capability IDs only. Broader domain-specific answer packets remain blocked. |
| Write-intent firewall hotfix | complete for task V1 sandbox scope | `src/services/chat-core-v2/action-gateway.ts` plus route wiring now blocks unresolved/negated/hypothetical task writes before legacy paths, resolves exact task completion by canonical ID, keeps task-with-subtasks preview-only, and requires explicit task auto-execute flags for local sandbox execution. Duplicate-title completion is preview-only unless `CHAT_CORE_V2_TASK_COMPLETE_AUTO_EXECUTE=sandbox_only|canary` is explicitly set. |
| Provider-aware deterministic task read | complete for sandbox scope | `src/services/task-store/task-service.ts` now exposes `listTasksForUser`, merging `native_tasks` and local/unified Nexus rows for native users without provider API calls; `task-summary-route.ts` uses it so chat-created tasks appear in deterministic task reads after writes. |
| Local Docker SQLite visibility | complete for simulator sandbox | `src/services/storage-provider.ts` honors `SQLITE_JOURNAL_MODE`; `.env.local.example` documents `SQLITE_JOURNAL_MODE=DELETE` for macOS Docker bind mounts. This prevents orphaned WAL sidecars from making chat-created tasks visible only to the Node process but invisible to fresh SQLite/API verification. |
| iOS chat task-create bridge | complete for local sandbox scope | `ChatViewModel` now routes natural-language task creation typed in chat through `/api/v1/chat/message` instead of the local task REST fastpath, preserving ChatCoreV2 preview/confirmation and subtask parsing. |
| iOS recipe parser/progress fixes | complete for local sandbox scope | `MessageBubble.parseRecipeFromChat` now accepts labelled backend title output and avoids section-label ingredients; slow local-LLM progress copy no longer shows internal action/idempotency wording. |

## Not Complete / Blocked

| Plan item | Status | Specific reason |
|---|---|---|
| D3 multi-user hardware benchmark execution | blocked for Phase 2 | Serialized foreground planning meets the operator-revised p95 <= 5s gate, but burst/concurrent/sustained p95 remains ~10-15s on CPU-only Ollama. A queue-aware cloud-allowlist policy helper and packet-only cloud answer dispatcher now exist; full Phase 2 still needs deterministic positive answer-packet production, decision counters, and measured load evidence before any rollout. |
| Peer review of D1-D16 | blocked | Requires a separate read-only Claude/Codex review pass under Delivered-Means-Verified. |
| Golden corpus >= 200 turns | partially unblocked | `src/services/chat-core-v2/golden-corpus-seed.ts` now provides 263 safe-paraphrase labeled seed items across en, pt-BR, pt-PT, and mixed, including 7 operator-reported real failure seeds. Phase 2 still needs peer-reviewed labels/private evidence promotion before this can count as the final shadow gate corpus. |
| Local LLM chat sandbox path | complete for sandbox validation | `src/services/chat-core-v2/local-chat-orchestrator.ts` uses Ollama localReasoning with bounded `ComposedAnswerDraft`; local Docker/iOS env enables `CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE=canary`; live sandbox API request returned `chat-core-v2-local-llm` via `qwen2.5:3b-instruct-q4_K_M`. This is not a production Phase 3 canary claim. |
| Phase 2 plan-only shadow runtime | blocked | Gated on peer-reviewed D1-D16, full schema-valid D3 benchmark, kill switch, repair loop, shadow storage, privacy tests, and rollout tests. |
| Phase 3 answer canary | blocked | Requires Phase 2 shadow evidence, iOS UX decision, dashboards, and live canary rollout. |
| Phase 4 deterministic reads migration | blocked | Requires ChatCoreV2 orchestrator runtime and tenant/user isolation tests. |
| Phase 5 write preview | blocked | The focused task V1 preview/execute bridge exists for sandbox regression testing, including preview-only task-with-subtasks, but full Phase 5 still requires command bus integration from the new orchestrator and complete visible-diff tests. |
| Phase 6 confirmed writes | blocked | The focused task V1 readback path exists for sandbox regression testing, but full Phase 6 still requires background lifecycle, broader idempotency, readback verification across all Class A/B/C commands, and runtime policies. |
| Phase 7 cloud allowlist | blocked | Requires positive allowlist module, denial telemetry, budget gates, and audit tests. |
| Phase 8 legacy retirement | blocked | Requires per-route shadow parity >= 95% over at least 50 rows and `legacy_fallback_rate_24h < 2%`. |
| iOS full turn-state/background implementation | partially blocked | Local sandbox iOS bridges for server-routed task creation, recipe parsing, progress copy, and default unit-test execution are implemented and tested. The full Phase 1/3 turn-state event/reconnect/background UX remains a broader iOS/server contract implementation item. |
| Production verification | blocked | No runtime code has been deployed from this branch. |

## Read-Only VPS Probe And Calibration

Commands performed:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=5 dominguez@serverdominguez \
  'hostname && curl -s --max-time 3 http://127.0.0.1:11434/api/tags | head -c 500'

ssh -o BatchMode=yes -o ConnectTimeout=5 dominguez@serverdominguez \
  'uptime; systemctl is-active ollama.service; systemctl show ollama.service -p MemoryCurrent -p NTasks --no-pager'
```

Observed:

- host: `ServerDominguez`
- Ollama service: `active`
- `qwen2.5:3b-instruct-q4_K_M` present in `/api/tags`
- load at probe time: `0.08, 0.04, 0.00`
- Ollama memory current at probe time: approximately 6.47 GB
- corrected tiny probes: 20 context words in 3294.1 ms, 100 context words in
  4435.3 ms
- corrected prompt sweep: 200 context words in 11487.2 ms, 400 context words
  in 9598.1 ms, 800 context words in 20414.9 ms
- corrected 2k/3k probes: 1200 context words in 58600.5 ms, 1800 context
  words in 37475.7 ms
- comparison probes: Gemma 2B and qwen `/api/generate` did not produce a clear
  latency win
- ultra-compact qwen latency lower-bound packet: 10 sequential calls,
  `num_predict=12`, p50 2085.1 ms, p95 4582.4 ms, zero transport failures,
  but no full schema proof
- strict-schema qwen 3B harness validation: 3 sequential calls,
  `num_predict=180`, p50 12564 ms, p95 14922 ms, zero transport failures,
  zero schema failures
- strict-schema Gemma 2B comparison: 3 sequential calls, `num_predict=180`,
  p50 14240 ms, p95 18231 ms, zero transport failures, zero schema failures
- result: strict schema enforcement works, but the current CPU-only VPS misses
  the foreground p95 target even for the ultra-compact packet
- 2026-05-28 compact wire-plan follow-up: server expands a tiny model-emitted
  wire JSON response into canonical `ChatTurnPlanMicro`; `num_predict=28`,
  `num_ctx=512`, `think=false`, 10 warmed sequential calls, zero transport
  failures, zero schema failures, p50 4705 ms, p95 5325 ms. Artifact:
  `data/chatcore-v2-planner-benchmarks/2026-05-28T10-29-40-953Z.json`.
  Lowering to `num_predict=20` reached p95 4958 ms but caused 6/10 schema
  failures from truncation, so D3 remains blocked.

No VPS files or environment variables were modified.

## Local Verification

Passed:

```bash
git diff --check
npm run typecheck
npm run verify
npx vitest run __tests__/services/chat-core-v2-plan-schema.test.ts
npx vitest run __tests__/services/chat-core-v2-plan-schema.test.ts __tests__/services/chat-core-v2-activation-contracts.test.ts
npx vitest run __tests__/services/chat-core-v2-*.test.ts
npx tsc --noEmit --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --types node --lib ES2022,DOM --skipLibCheck src/services/chat-core-v2/plan-schema.ts scripts/llm/chatcore-v2-planner-benchmark.ts __tests__/services/chat-core-v2-plan-schema.test.ts
npx tsc --noEmit --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --types node --lib ES2022,DOM --skipLibCheck src/services/chat-core-v2/plan-schema.ts src/services/chat-core-v2/plan-validator.ts src/services/chat-core-v2/planner-repair.ts src/services/chat-core-v2/prompt-budget.ts src/services/chat-core-v2/prepass-candidate-selection.ts src/services/chat-core-v2/prepass-miss-log.ts src/services/chat-core-v2/activation-flags.ts src/services/chat-core-v2/answer-composition.ts src/services/chat-core-v2/auto-revert-policy.ts src/services/chat-core-v2/background-lifecycle.ts src/services/chat-core-v2/cloud-allowlist-packet.ts src/services/chat-core-v2/context-staleness-policy.ts src/services/chat-core-v2/domain-adapter.ts src/services/chat-core-v2/failure-observability.ts src/services/chat-core-v2/golden-corpus.ts src/services/chat-core-v2/locale-preservation-policy.ts src/services/chat-core-v2/model-residency-policy.ts src/services/chat-core-v2/prepass-contract.ts src/services/chat-core-v2/turn-state-events.ts src/services/chat-core-v2/write-verification-policy.ts src/services/chat-core-v2/write-risk-policy.ts scripts/llm/chatcore-v2-planner-benchmark.ts __tests__/services/chat-core-v2-plan-schema.test.ts __tests__/services/chat-core-v2-activation-contracts.test.ts
```

Latest broader ChatCoreV2 sweep after the M1/M2 peer-review fixes:

```text
Test Files  37 passed (37)
Tests       312 passed (312)
```

Latest full repo verification after the provider-aware task read, iOS sandbox
bridges, shadow-route HMAC fix, and write-intent HMAC fallback removal:

```text
npm run verify
Test Files  736 passed (736)
Tests       10864 passed (10864)
```

Full repo verification after installing the already-declared
`express-rate-limit` dependency into local `node_modules` and applying a
type-only annotation fix in `src/api/routes/training-coach-v2.ts`:

```text
Test Files  729 passed (729)
Tests       10772 passed (10772)
```

Latest focused verification after the write-intent firewall and local Docker
SQLite journal-mode fix:

```text
npx tsc --noEmit
PASS

npx vitest run __tests__/api/chat-routes.test.ts --testNamePattern "duplicate-title|duplicate native task|native task completion|action gateway|task-with-subtasks|task-complete"
Test Files  1 passed (1)
Tests       11 passed | 89 skipped (100)

npx vitest run __tests__/services/chat-core-v2-command-preview-route.test.ts __tests__/services/chat-core-v2-command-executor.test.ts
Test Files  2 passed (2)
Tests       35 passed (35)

./scripts/local-reset.sh --yes && ./scripts/local-up.sh && ./scripts/local-smoke.sh -v
5/5 checks passed
```

Manual Docker action smoke:
- chat create returned `routeMethod=chat-core-v2-command-confirmation` and
  a created task card
- `/api/v1/tasks/filtered?filter=all` returned the created Nexus task as
  `notStarted`
- chat complete returned `routeMethod=chat-core-v2-command-confirmation` and
  a completed task card
- `/api/v1/tasks/filtered?filter=all` no longer returned the completed task
- SQLite showed the same `native_tasks` row with `status='completed'`
- SQLite `PRAGMA journal_mode; PRAGMA integrity_check;` returned `delete` /
  `ok`

Full repo verification after the scoped write-intent firewall, local
SQLite journal-mode fix, legacy-schema-safe plan resolver fix,
atom-packet benchmark tuning, source-audit/safe-metadata guards, and
golden-corpus seed validation:

```text
npm run verify
Test Files  730 passed (730)
Tests       10802 passed (10802)
```

The `training-coach-v2.ts` change is intentionally limited to import/type
annotations for the rate-limit handler. It removes an unrelated local
typecheck blocker and does not alter runtime behavior.

Agent-lane helper check originally could not be run because this post-main
worktree did not contain the script referenced by `AGENTS.md`:

```text
Cannot find module '.../scripts/verify-agent-lanes.mjs'
```

Codex added a conservative read-only helper and active registry row, then ran:

```text
node scripts/verify-agent-lanes.mjs --registry docs/qa/AGENT_WORK_REGISTRY.md
[verify-agent-lanes] OK

node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-chatcore-v2-production-activation.md
[verify-agent-lanes] OK
```

After adding Work Order frontmatter, running the source-repo copy of that
script succeeds at parsing but still fails until a commit is authorized because
`candidate_commit` intentionally remains equal to `base_commit`.

## Required Next Actions

1. Finish Phase 2 queue fallback runtime wiring: keep local first, produce
   positive answer packets deterministically where safe, pass only those packets
   to cloud, and record queue fallback decision counters under load.
2. Run the full D3 benchmark with
   `scripts/llm/chatcore-v2-planner-benchmark.ts --suite=all --runs=100 --burst-size=10 --concurrency=5 --duration-ms=300000`
   in a maintenance window or staging-equivalent hardware environment and link
   the artifact from the Work Order.
3. Peer-review D1-D16 documentation and the initial D4 validator under
   Delivered-Means-Verified.
4. Build the golden corpus with real product failures and labels.
5. Implement the Phase 2 kill switch, repair loop, shadow storage, privacy
   checks, and rollout tests only after the gates above pass.

## QA Prompt Status

Not created. Creating a final Claude Code QA prompt now would be misleading
because the implementation plan is intentionally incomplete and blocked before
runtime phases.
