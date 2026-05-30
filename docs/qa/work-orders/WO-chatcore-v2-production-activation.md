---
work_order_id: WO-chatcore-v2-production-activation
title: ChatCoreV2 production activation and write-intent firewall
repository: backend
repo_path: "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
project_area: chat-core-v2
mode: Implementation
implementer: Codex
peer_reviewer: Claude
release_gatekeeper: Felipe
base_commit: e5ca00348175e50426c97cff27a768f41681c2a1
candidate_commit: 762828f728ce3830fa6466448551495adcb19755
branch: codex/chatcore-v2-production-activation-wo
worktree: "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-chatcore-v2-activation"
owned_paths:
  - "AGENTS.md"
  - "CLAUDE.md"
  - "__tests__/api/chat-routes.test.ts"
  - "__tests__/services/chat-action-planner.test.ts"
  - "__tests__/services/chat-core-v2-*.test.ts"
  - "docs/ai/**"
  - "docs/qa/work-orders/WO-chatcore-v2-production-activation.md"
  - "docs/release/eval-evidence/registry-shadow-parity-latest.json"
  - "scripts/local-*.sh"
  - "scripts/wait-for-health.sh"
  - "scripts/verify-agent-lanes.mjs"
  - "scripts/llm/chatcore-v2-planner-benchmark.ts"
  - "scripts/llm/chatcore-v2-corpus-eval.ts"
  - ".env.local.example"
  - "src/api/routes/billing.ts"
  - "src/api/routes/chat-message-routes.ts"
  - "src/api/routes/content-script-routes.ts"
  - "src/api/routes/dashboard.ts"
  - "src/api/routes/training-coach-v2.ts"
  - "src/services/cost-guardrail.ts"
  - "src/services/entitlement.ts"
  - "src/services/health-sleep-agenda.ts"
  - "src/services/home-day-dial.ts"
  - "src/services/storage-provider.ts"
  - "src/services/chat-core-v2/**"
  - "src/services/chat/planner/**"
  - "src/services/skills/tasks/executor.ts"
  # Added 2026-05-29: provider-aware token-zero task read so the chat
  # deterministic-read sees native_tasks (read-after-write fix).
  - "src/services/task-store/native-adapter.ts"
  - "src/services/task-store/task-service.ts"
  - "__tests__/services/task-store/task-service.test.ts"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/AGENTS.md"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/CLAUDE.md"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/AppEntitlementResolver.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Repositories/TaskRepository.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Services/ContentService.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Components/AppEntitlementComponents.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Models/Message.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/ViewModels/ChatViewModel.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Chat/ChatView.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Chat/MessageBubble.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Chat/StructuredCards.swift"
  # Added 2026-05-29: iOS test files updated to match the chat task-create
  # server-routing and recipe-parser fixes.
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus HubTests/ChatViewModelFastpathTests.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus HubTests/MessageBubbleRecipeParsingTests.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Billing/UsageMeterView.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Content/ScriptGeneratorView.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Cooking/RecipeEditorView.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Dashboard/DashboardHomePrimarySections.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Finance/FinanceFiscalProofDetailSheet.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Finance/FinanceSkillView.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Finance/VendorsListView.swift"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus HubTests/**"
  - "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj/xcshareddata/xcschemes/Nexus Hub.xcscheme"
  - "docs/qa/AGENT_WORK_REGISTRY.md"
read_only_paths:
  - "docs/templates/**"
status: in-progress
parallel_safe: false
shared_refactor: false
dependencies: []
blocks: []
blocked_by: []
api_contract_changed: false
requires_ios_validation: true
requires_backend_validation: true
requires_simulator_validation: true
requires_production_validation: false
max_claim_level: L2
evidence_checklist: docs/qa/evidence-checklists/WO-chatcore-v2-production-activation-evidence.md
peer_review_checklist: docs/qa/peer-reviews/WO-chatcore-v2-production-activation-peer-review.md
final_handoff: docs/qa/final-handoffs/WO-chatcore-v2-production-activation-final-handoff.md
created_at: 2026-05-27
updated_at: 2026-05-30
---

# Work Order: WO-chatcore-v2-production-activation

**Status:** Phase 0/1 activation slice locally complete plus local-sandbox runtime bridges: inventory docs, initial `ChatTurnPlanMicro` validator, plan validator, bounded repair/prompt-budget helpers, activation/cloud/evidence/prepass/observability/golden-corpus/auto-revert/staleness/write-verification/locale contract helpers, Layer 1 candidate selector, focused tests, D3 full-suite benchmark harness, local Docker sandbox fixes, iOS native-task completion resolution in the existing ChatCoreV2 preview/executor path, and the ChatCoreV2 write-intent firewall for task create/complete hotfix coverage. Full D3 benchmark execution, peer review, real corpus labeling, and runtime shadow remain blocked. No production deploy authorized.
**Created:** 2026-05-27
**Owner:** Codex on Mac source repo
**Mode:** Implementation, local sandbox + focused ChatCoreV2 preview/executor fix; no production deploy
**Branch:** `codex/chatcore-v2-production-activation-wo`
**Worktree:** `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-chatcore-v2-activation`
**Base commit:** `e5ca0034` (`origin/main`, post-Ollama/post-Option-3)
**Related docs:** `docs/ai/chat-route-exit-inventory.md`, `docs/ai/chatcore-v2-module-inventory.md`, `docs/ai/chatcore-v2-layer1-assembly-map.md`, `docs/ai/chatcore-v2-phase1-contracts.md`, `docs/ai/chatcore-v2-golden-corpus-spec.md`, `docs/ai/benchmarks/chatcore-v2-planner-calibration-2026-05-27.md`, `docs/ai/chatcore-v2-plan-completion-audit.md`, `docs/ai/chatcore-v2-implementation-readiness-matrix.md`

## Update 2026-05-30 — Phase 2/3 Closeout Waves (post-WP)

After the 17 work-package build, a code-grounded audit ranked the remaining
autonomously-doable engineering (8 items; everything else is gated on a real
labeled corpus, the D3 multi-user hardware decision, or operator
canary/production/cloud-on authorization). Those 8 items shipped on PR #148 as
three default-off / inert waves. The live `chat-routes` suite held green
throughout, and every wave passed an adversarial safety gauntlet plus the
pre-commit and pre-push gates.

- Wave 1 `bb864937` — Phase 2 closeout: `enforceAndRepairChatTurnPlanMicro`
  (bounded validate→repair-once, injected model = Ollama-optional), a default-off
  shadow planner (`planChatCoreV2ShadowTurnWithPlanner`) so shadow-path schema
  validity is finally *measurable*, the shadow-gate-readiness integration test,
  and local-only shadow evidence scripts. The existing synchronous shadow path
  and the live route are byte-unchanged (the new planner has zero production
  callers — injection-gated, not just flag-gated).
- Wave 2 `aff3d11a` — auto-revert/observability: `chat_v2_prepass_miss_log`
  (mig 175, HMAC-only) and per-tenant per-hour schema-compliance /
  legacy-fallback counters (mig 177), with `metrics-aggregator` wired off its
  hardcoded placeholders. Off-mode inert; empty-table reads preserve the
  revert-safe 1.0 / 0.0 defaults so the auto-revert valve cannot false-fire.
- Wave 3 `f88d72bd` — Phase 3 inert plumbing: `canary-gate-guard`
  (synthetic-seed boot floor, cohort filter, prod-override refusal, throw-not-
  exit, wired into `main()` only when `mode=canary`), `chat_v2_canary_turn_log`
  (mig 178), and the per-locale `chat_v2_answer_acceptance_counter` (mig 179).

Honesty unchanged: `gateCanPromote` stays the sole promotion authority and stays
false until a real (non-synthetic) labeled corpus is measured; the rank-7 boot
floor is a coarse "selector not grossly broken" sanity check, never the
promotion gate. No activation flip, deploy, or cloud-on is performed by these
waves. Full per-item detail and verification counts are in the PR #148
description.

### Live shadow validation (2026-05-30, local sandbox, commit `1a1e6446`)

The shadow path was exercised end-to-end in the local Docker sandbox
(`CHAT_CORE_V2_ORCHESTRATOR_MODE=shadow` + `CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED`
+ `CHAT_CORE_V2_SHADOW_PLANNER_ENABLED`, planner `modelOverride` = the fast 3B
slot `qwen2.5:3b-instruct-q4_K_M`) against real Ollama. This surfaced and closed a
genuine doctrine-#10 gap (the planner had shipped with NO system instruction and
NO `outputSchema`, so qwen produced schemaValid=false on every span — invisible to
the mocked unit tests; fixed in `1a1e6446` via the proven wire method).

Evidence (authoritative `chat_v2_schema_compliance_counter`, which excludes
`planner_threw` timeouts by construction):

- 3B window: **pass=20 / fail=0 — 100% schema-valid among RESPONDING calls.**
- `shadow_planner` span split: `planner_ok|valid`=20, `planner_ok|unrepairable`=3
  (all in the earlier 35B window — the small model + wire prompt is the correct
  pairing), `planner_threw|unrepairable`=14 (Ollama **timeouts** under 50
  concurrent turns on the serialized concurrency gate, NOT schema failures).
- Privacy re-confirmed on real rows: every current-run replay bundle carries a
  64-hex HMAC `messageHash` + safe metadata only; zero raw text. (Pre-2026-05-30
  rows use a legacy 16-hex hash; the readback now treats those as a WARN, not a
  hard fail, while a true raw-text leak still hard-fails.)
- Default-off / fire-and-forget / non-blocking preserved; the live route is
  byte-unchanged; `gateCanPromote` stays honestly false.

Interpretation: schema validity is effectively SOLVED on the 3B model (100% of
responses valid). The remaining failure mode is request TIMEOUTS under concurrent
load — the WO's already-documented, GATED D3 concurrency/latency/hardware item
(single-instance CPU Ollama serializes under load). The live shadow schema-valid
rate among responding calls — not the seeded benchmark figure — is the
authoritative gate signal going forward.

## Summary

Activate `src/services/chat-core-v2/` as the single owner of ordinary
natural-language chat through a strangler migration. Existing deterministic
services remain, but natural-language planning, validation, evidence,
composition, and rollout control move into ChatCoreV2.

Target architecture:

1. Layer 1 deterministic prepass produces hints only.
2. Layer 2 local 3B micro-planner emits bounded JSON.
3. Layer 3 validates, executes deterministic adapters, verifies, composes,
   and escalates only when needed.
4. Cloud fallback uses positive allowlist packets only. No regex
   sanitization and no raw private context.

## Ownership

Initial owned areas:

- `src/services/chat-core-v2/`
- `src/api/routes/chat-message-routes.ts` only for integration hooks
- focused ChatCoreV2 tests
- Chat architecture docs
- local Docker sandbox helpers (`scripts/local-up.sh`,
  `scripts/local-smoke.sh`, `scripts/local-down.sh`,
  `scripts/local-reset.sh`, `scripts/wait-for-health.sh`) only to make the
  activation worktree testable from the iOS Simulator against
  `127.0.0.1:8200`
- `src/api/routes/training-coach-v2.ts` only to remove an unrelated local
  typecheck blocker that prevents `npm run verify` from reaching the
  ChatCoreV2 evidence gates
- `src/services/skills/tasks/executor.ts` and task-route/cache tests only for
  the sandbox regression where chat-confirmed task writes succeed in
  `native_tasks` but leave `/api/v1/tasks/filtered` and list-count caches
  stale
- Paired local iOS confirmation-card presentation fix in
  `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Chat/StructuredCards.swift`
  only to render confirmation actions as icon-only buttons while preserving
  accessibility labels
- Scoped out-of-plan sandbox QA addendum requested on 2026-05-27:
  investigate and fix Content script generation access for the local sandbox
  and `nexushubbot@gmail.com`, remove raw AI dollar-limit copy from
  customer-facing iOS usage surfaces, and restore Sleep data in the Home
  24-hour pie chart. These changes may touch only the backend/iOS files listed
  above and must remain local-branch only until Felipe explicitly authorizes a
  commit/deploy.

This Work Order does not own unrelated domain implementation, iOS code, or
production deploy configuration except where explicitly called out as a
contract or future integration hook.

## Current Delivery Boundary

The first delivery claim is documentation and planning-support code, plus one
focused local-sandbox fix needed to make existing ChatCoreV2 action previews
testable from the iOS Simulator:

- create this Work Order
- inventory current chat route exits
- inventory existing ChatCoreV2 modules and gaps
- map Layer 1 prepass assembly to existing services
- draft Phase 1 contracts for D4-D16
- implement the initial bounded `ChatTurnPlanMicro` validator and tests
- implement first-slice contract helpers for activation flags, answer drafts,
  cloud allowlist packets, domain adapters, turn-state events, and write-risk
  policies, background lifecycle, model residency, observability, and prepass
  bounds
- implement a golden-corpus schema validator so future real labels have a gate
- implement policy-layer helpers for auto-revert thresholds, context staleness,
  and write-success claim verification
- implement locale preservation policy helper for future composers
- implement first-slice plan validator, prepass recall-miss HMAC records,
  bounded planner repair prompt, and prompt-budget decisions
- implement a pure Layer 1 candidate selector that emits bounded hints only
- add a read-only Ollama benchmark harness for D3 sequential, burst,
  concurrent, and sustained phases
- configure the local Docker sandbox helpers so this sibling worktree boots
  the fixed-name containers consistently and the iOS Simulator can test the
  current ChatCoreV2 deterministic hooks against local port `8200`
- configure the local Docker sandbox SQLite journal mode to `DELETE` via
  `SQLITE_JOURNAL_MODE` so macOS Docker bind-mount smoke checks and the
  simulator read the same committed rows. Production/default runtime remains
  `WAL`.
- bridge existing ChatCoreV2 task-complete preview/execution to iOS native
  tasks (`native_tasks`) as well as the unified task store, so the simple
  action "Mark comprar suplementos task as done" can produce a confirmation
  preview and readback-verified execution in the local sandbox
- add the ChatCoreV2 write-intent firewall before legacy model/tool routing:
  exact task completion resolves by canonical task ID and verifies before a
  success claim; unresolved, negated, or hypothetical write intents stop in
  ChatCoreV2 instead of falling through to scoped-read or generic secretary
  paths; task-with-subtasks requests return preview-only ChatCoreV2 cards
  rather than claiming creation; local sandbox auto-execute now uses the
  explicit `CHAT_CORE_V2_TASK_COMPLETE_AUTO_EXECUTE` /
  `CHAT_CORE_V2_TASK_CREATE_AUTO_EXECUTE` flags; duplicate-title completion
  now asks clarification even when sandbox auto-execute is enabled
- add a sandbox/canary-only ChatCoreV2 local LLM answer path for ordinary
  non-write chat, using `dispatchLocalReasoning` against Ollama
  `qwen2.5:3b-instruct-q4_K_M` with bounded `ComposedAnswerDraft` JSON,
  `think=false`, and the server-side anti-success-claim guard. This path runs
  after the write firewall/command preview block and before legacy
  model/tool routing so local-LLM chat can be tested in Docker/iOS while
  write intents still resolve/verify through ChatCoreV2 commands.
- record completion/readiness matrix for unfinished tasks and tests
- document gates, flags, rollback, and cross-team dependencies
- local sandbox addendum: content/script access must succeed for sandbox and
  `nexushubbot@gmail.com` when unlimited beta/internal access is present; iOS
  usage warnings must show percentage/proximity copy only, never raw dollar
  caps; Home day-dial Sleep must appear when backend sleep evidence exists
  and remain honestly unavailable only when no sleep evidence can be read

No production runtime ownership change is allowed until Phase 2 shadow
prerequisites pass. The local native-task bridge is intentionally scoped to
an existing ChatCoreV2 preview/executor path. The local LLM answer path is
sandbox/canary-gated by `CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE` and the master
`CHAT_CORE_V2_ORCHESTRATOR_MODE`; it is for Mac Docker/iOS validation of the
intended local-first UX, not a Phase 3 production canary claim. Phase 0/1
documentation may proceed before benchmark numbers are available, but Phase 2
shadow is blocked by D1-D16 and the Phase 0 benchmark.

## Cross-Team Dependency

The iOS turn-state contract must be delivered in Phase 1. iOS implementation
starts no later than Phase 2 shadow. If iOS progress UX is not ready by Phase
3, canary must use existing response UX only and must not expose new progress
or reconnect semantics.

## Required Amendments Before Coding

- D1-D2 inventory may run in parallel with D3 benchmark. D1-D16 block Phase 2
  shadow, not Phase 1 documentation/schema-support work.
- If the 3B planner p95 misses 5 seconds, tune prompt/model or reduce prompt
  budget before shadow. Do not abandon the architecture on the first miss.
- 2026-05-27 calibration found the original 2k/3k foreground prompt budget is
  not viable on the current CPU-only VPS. An ultra-compact qwen packet reached
  p50 2085.1 ms / p95 4582.4 ms over 10 sequential latency-lower-bound calls,
  but that run used `num_predict=12` and did not prove full schema validity.
  A later strict-schema qwen run with `num_predict=180` produced zero schema
  failures but still missed latency targets (p50 12564 ms / p95 14922 ms over
  3 tiny sequential calls). Phase 2 must tune latency and fully benchmark that
  packet shape before shadow.
- 2026-05-28 operator decision: the foreground D3 latency gate is formally
  revised to p95 <= 5s at `num_ctx=256`; the p50 <= 2s target is relaxed/
  deferred on CPU-only hardware (sequential atom/raw-prompt runs meet the
  revised gate). Full `--suite=all` confirmation across burst/concurrent/
  sustained is still recommended before Phase 2 shadow. See the calibration
  doc's "2026-05-28 Operator decision" section.
- Use actual module names: `model-run-audit.ts`, `runtime-budget.ts`. Do not
  reference nonexistent modules unless intentionally added.
- Prepass miss logging stores HMAC message hash, locale, candidate
  capabilities, final capability, reason codes, and safe metadata only.
- Cloud packet entity IDs use tenant-scoped HMAC, not plain hashes.
- `model_constrained` returns structured `ComposedAnswerDraft`; the server
  converts to `ChatCoreV2Response`.
- `provider-data-policy.ts` is an input, not sufficient enforcement. Cloud
  allowlist packet rules are stricter.
- ChatCoreV2 write-intent firewall addendum: natural-language writes must
  resolve to ChatCoreV2 command preview/execution/verification, ask
  clarification, or stop. They must not continue into legacy secretary,
  generic model/tool routing, or scoped-read fallback. V1 enforces exact
  `tasks.complete`, simple `tasks.create`, preview-only task-with-subtasks,
  negation/hypothetical guards, HMAC-only telemetry, and canonical task-ID
  execution/readback.
- Sandbox QA addendum: user-facing quota/usage copy must not expose raw price
  limits; unlimited beta/internal access should bypass AI usage and content
  feature gates in sandbox; sleep chart fixes must preserve tenant/user scope
  and avoid inventing sleep when evidence is absent.

## Binding Doctrine

1. The deterministic prepass produces hints, not decisions. Authoritative
   routing remains in `route-decision.ts`.
2. No LLM calls inside Layer 1.
3. No raw model text as final answer. Every final answer validates as a
   `ChatCoreV2Response`.
4. Every factual claim requires evidence linkage.
5. Cloud fallback is positive allowlist composition, not subtraction-based
   sanitization.
6. Tenant ID and user ID are required at every domain-adapter boundary.
7. Writes require idempotency keys and readback verification.
8. 35B foreground latency is not required for success.
9. The 3B planner sees only 3-8 candidate capabilities, not the full catalog.
10. Schema validation backstops Ollama `format` enforcement on every planner
    response.
11. `CHAT_CORE_V2_ORCHESTRATOR_MODE=off` wins over every other flag.
12. No hidden fallback to the legacy path. Every fallback emits reason-coded
    telemetry.

## Phases, Gates, And Rollback

### Phase 0 - Inventory + Benchmark

Workstreams: route/module inventory and 3B hardware benchmark can run in
parallel.

Prerequisites:

- active Work Order
- branch and worktree declared
- owned files declared

Deliverables:

- route-exit inventory
- ChatCoreV2 module and gap table
- Layer 1 assembly map
- 3B planner benchmark at 2k and 3k prompts with p50/p95/p99, burst,
  concurrent, and sustained results

Exit:

- `docs/ai/chat-route-exit-inventory.md` complete
- `docs/ai/chatcore-v2-module-inventory.md` complete
- `docs/ai/chatcore-v2-layer1-assembly-map.md` complete
- benchmark artifact captured and linked from this Work Order

Current D3 note:

- `docs/ai/benchmarks/chatcore-v2-planner-calibration-2026-05-27.md`
  records read-only VPS calibration attempts. Tiny probes returned in 3.3-4.4s,
  but 200+ context-word probes exceeded target and 2k/3k prompt-size probes
  took 58.6s and 37.5s. An ultra-compact qwen packet reached p50 2085.1 ms /
  p95 4582.4 ms over 10 sequential latency-lower-bound calls with
  `num_predict=12`. The strict-schema qwen packet with `num_predict=180`
  reached 0/3 schema failures but p95 14922 ms. Lowering `num_predict` alone
  did not unblock the gate: 60/80/100 truncated invalid JSON and 120 was valid
  but slower. A later atom-packet shape reduced valid qwen 3B output to
  p50 3577 ms / p95 4194 ms and valid Gemma 2B output to p50 3274 ms /
  p95 3580 ms. Raw-prompt `/api/generate` improved the best installed-model
  result to Gemma 2B p50 3138 ms / p95 3484 ms. A final `num_ctx=128`
  check regressed to Gemma p50 4337 ms / p95 5124 ms and qwen p50 5632 ms /
  p95 6041 ms with 4/10 qwen schema failures. D3 remains blocked because the
  p95 <= 5s gate is viable at `num_ctx=256` but the formal p50 <= 2s gate
  still fails on CPU-only hardware. The next unblocker is a smaller planner model,
  hardware change, or operator-approved latency-target revision, followed by
  the full benchmark suite in a safe window. The harness at
  `scripts/llm/chatcore-v2-planner-benchmark.ts` can
  run `--suite=all` across sequential, burst, concurrent, and sustained
  phases when that window exists.

Rollback:

- documentation-only; close or supersede Work Order with evidence.

### Phase 1 - Schemas, Corpus, Operational Contracts

Prerequisite:

- Phase 0 inventory complete enough to identify module gaps

Deliverables:

- `ChatTurnPlanMicro` schema v1 and prompt-size budget
- evidence taxonomy
- `DomainAdapterV1`
- iOS turn-state event contract
- background lifecycle with `superseded` and abort-token semantics
- kill-switch spec and CI requirement
- model residency policy
- cloud allowlist spec
- write risk gradient
- failure observability matrix
- pure-deterministic prepass audit

Exit:

- golden corpus has at least 200 turns across en, pt-BR, pt-PT, and mixed
- D1-D16 documented and peer-reviewed
- focused `ChatTurnPlanMicro` validator tests pass

Rollback:

- documentation-only; mark Work Order blocked with missing deliverables.

### Phase 2 - Plan-Only Shadow

Prerequisites:

- single kill switch implemented and tested
- model residency applied
- shadow table privacy rules implemented
- schema validator and bounded repair loop implemented
- HMAC-only identifiers and retention TTL documented

Exit:

- at least 50 shadow rows
- schema validity >= 99% with repair loop
- recall@8 meets language targets
- zero raw message strings in shadow tables

Rollback:

- set `CHAT_CORE_V2_ORCHESTRATOR_MODE=off`
- emit `chat_core_v2_rollback` audit/event row
- file follow-up Work Order with failure evidence

### Phase 3 - Answer-Only Canary

Prerequisites:

- auto-revert thresholds dashboarded
- failure observability active
- iOS progress UX ready, or canary limited to existing UX

Enable order:

1. training reads
2. cooking
3. content
4. finance education

Exit:

- en answer acceptance >= 90%
- pt-BR answer acceptance >= 85%
- pt-PT answer acceptance >= 80%
- mixed answer acceptance >= 75%
- deterministic critic catches >= 95% of seeded unsupported claims
- p95 first progress event <= 2 seconds
- zero raw private cloud leaks

Rollback:

- flip mode to `shadow`
- record affected users, domains, metrics, and failing corpus examples

### Phase 4 - Deterministic Reads

Prerequisite:

- iOS turn-state/reconnect contract covered where progress events are surfaced

Scope:

- "today"
- "calendar"
- "tasks"
- "training today"
- "what changed"

Exit:

- read responses validate as `ChatCoreV2Response`
- tenant/user isolation tests pass
- explicit slash/button/API token-zero reads still work

Rollback:

- disable affected domains via `CHAT_CORE_V2_ALLOWED_DOMAINS`
- keep global mode if other domains are healthy

### Phase 5 - Write Preview

Prerequisites:

- command bus gate wired
- visible-diff contract tests in place

Scope:

- Class A previews only

Exit:

- 100% Class A preview corpus produces valid cards
- zero unvalidated executions
- diff-required cards include visible diffs

Rollback:

- set `CHAT_CORE_V2_ALLOW_WRITE_PREVIEWS=false`
- record affected capability IDs

### Phase 6 - Confirmed Writes

Prerequisites:

- background lifecycle with `superseded` and abort-token semantics implemented
- idempotency/readback tests green

Scope:

- Class A execution
- Class B with 3B critic
- Class C 35B/background escalation

Exit:

- zero writes claimed successful without readback verification
- Class C escalates per policy
- retry/cancel/idempotency tests pass

Rollback:

- set `CHAT_CORE_V2_ALLOW_WRITE_EXECUTION=false`
- leave previews enabled only if safe

### Phase 7 - Cloud Allowlist + Escalated Critic

Prerequisites:

- cloud allowlist denial reasons logged and dashboarded
- budget gates active

Exit:

- zero raw private fields in cloud-bound packets
- denial reasons observable
- cloud usage < 2% of turns unless explicitly approved

Rollback:

- set `CHAT_CORE_V2_ALLOW_CLOUD_FALLBACK=false`
- keep local paths

### Phase 8 - Retire Legacy NL Owners

Prerequisite:

- each route-exit inventory row marked replaced and tested

Exit:

- per replaced row shadow parity >= 95% over at least 50 rows
- `legacy_fallback_rate_24h < 2%`
- full `npm run verify` clean

Rollback:

- restore row flag or global mode to previous value
- record reason-coded telemetry

## Flags

```bash
CHAT_CORE_V2_ORCHESTRATOR_MODE=off|shadow|canary|on
CHAT_CORE_V2_ALLOWED_SURFACES=ios,web
CHAT_CORE_V2_ALLOWED_DOMAINS=training,cooking,content,finance
CHAT_CORE_V2_ALLOW_DETERMINISTIC_READS=true
CHAT_CORE_V2_ALLOW_WRITE_PREVIEWS=false
CHAT_CORE_V2_ALLOW_WRITE_EXECUTION=false
CHAT_CORE_V2_ALLOW_CLOUD_FALLBACK=false
CHAT_CORE_V2_DISABLE_NL_TOKEN_ZERO=true
CHAT_CORE_V2_FORCE_CLARIFICATION_ON_PLAN_INVALID=true
CHAT_CORE_V2_FORCE_EVIDENCE_FOR_FACTUAL_CLAIMS=true
CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED=false
CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET=<generate-stable-secret>
CHAT_CORE_V2_LOCAL_INFERENCE_MAX_CONCURRENCY=1
CHAT_CORE_V2_QUEUE_FALLBACK_MODE=off|cloud_allowlist|background|fail_visible
CHAT_CORE_V2_QUEUE_CLOUD_AFTER_QUEUED_COUNT=1
CHAT_CORE_V2_QUEUE_CLOUD_AFTER_WAIT_MS=5000
CHAT_CORE_V2_MAX_LOCAL_PLANNER_MS=15000
CHAT_CORE_V2_MAX_COMPOSER_MS=15000
CHAT_CORE_V2_PROGRESS_AFTER_MS=2000
CHAT_CORE_V2_BACKGROUND_AFTER_MS=20000
```

Master switch rule: `CHAT_CORE_V2_ORCHESTRATOR_MODE=off` wins over all
other flags and returns to legacy in one code path. CI must prove this.

Queue fallback rule: local queue pressure may use cloud only when
`CHAT_CORE_V2_ALLOW_CLOUD_FALLBACK=true`, `CHAT_CORE_V2_QUEUE_FALLBACK_MODE`
is `cloud_allowlist`, and the turn already has a positive-allowlist cloud
packet. If the packet is denied, the runtime must background, wait, or fail
visibly; it must never widen the packet or send raw message text to cloud just
because Ollama is busy.

## Numerical Gates

- schema validity >= 99%
- recall@8: en >= 98%, pt-BR >= 97%, pt-PT >= 92% initial, mixed >= 90%
- p95 first progress <= 2 seconds
- `model_constrained` composer share <= 35% sustained
- `legacy_fallback_rate_24h < 2%` before legacy disable

## Required Tests

- master kill switch beats all flags
- auto-shadow-revert threshold behavior
- WebSocket/reconnect `sequenceNumber` resume where enabled
- background `superseded` transition and abort-token behavior
- HMAC-only shadow/cloud identifiers; shadow-route hook must skip recording
  rather than store plain hashes when no HMAC secret is configured
- no raw private strings in cloud packets
- queue fallback uses cloud only with a positive-allowlist packet; denied
  packets background/wait/fail visibly without widening context
- no unvalidated writes
- no write success without verification
- context hash mismatch forces re-read/replan/clarification
- pt-PT, pt-BR, en, and mixed language preservation
- prior regressions:
  - recipe/action-success claim
  - content-published claim
  - finance account-access claim
  - triathlon scheduled-without-verification claim

## Verification Plan

Non-runtime Phase 0/1 changes:

```bash
git diff --check
npx vitest run __tests__/services/chat-core-v2-plan-schema.test.ts
npx vitest run __tests__/services/chat-core-v2-plan-schema.test.ts __tests__/services/chat-core-v2-activation-contracts.test.ts
npx vitest run __tests__/services/chat-core-v2-*.test.ts
npx tsc --noEmit --target ES2022 --module commonjs --moduleResolution node --esModuleInterop --types node --lib ES2022,DOM --skipLibCheck src/services/chat-core-v2/plan-schema.ts src/services/chat-core-v2/plan-validator.ts src/services/chat-core-v2/planner-repair.ts src/services/chat-core-v2/prompt-budget.ts src/services/chat-core-v2/prepass-candidate-selection.ts src/services/chat-core-v2/prepass-miss-log.ts src/services/chat-core-v2/activation-flags.ts src/services/chat-core-v2/answer-composition.ts src/services/chat-core-v2/auto-revert-policy.ts src/services/chat-core-v2/background-lifecycle.ts src/services/chat-core-v2/cloud-allowlist-packet.ts src/services/chat-core-v2/context-staleness-policy.ts src/services/chat-core-v2/domain-adapter.ts src/services/chat-core-v2/failure-observability.ts src/services/chat-core-v2/golden-corpus.ts src/services/chat-core-v2/locale-preservation-policy.ts src/services/chat-core-v2/model-residency-policy.ts src/services/chat-core-v2/prepass-contract.ts src/services/chat-core-v2/turn-state-events.ts src/services/chat-core-v2/write-verification-policy.ts src/services/chat-core-v2/write-risk-policy.ts scripts/llm/chatcore-v2-planner-benchmark.ts __tests__/services/chat-core-v2-plan-schema.test.ts __tests__/services/chat-core-v2-activation-contracts.test.ts
npm run typecheck
npm run verify
```

Implementation phases:

```bash
npx tsc --noEmit
npx vitest run __tests__/services/chat-core-v2-*.test.ts
npm run verify
```

Additional verification:

- focused ChatCoreV2 suites
- route-exit inventory peer validation
- shadow table privacy checks
- production verification only after deployed commit and live smoke evidence

Latest local verification:

```text
npm run verify
Test Files  730 passed (730)
Tests       10802 passed (10802)

npx vitest run __tests__/services/chat-core-v2-activation-contracts.test.ts __tests__/services/chat-core-v2-plan-schema.test.ts
Test Files  2 passed (2)
Tests       42 passed (42)

npx vitest run __tests__/services/chat-core-v2-*.test.ts
Test Files  31 passed (31)
Tests       263 passed (263)

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

Docker sandbox manual action smoke after journal-mode fix:
- POST /api/v1/auth/register issued fresh local auth for user 2.
- POST /api/v1/chat/message "Create task comprar suplementos RESTPATH 230824-4050"
  returned `routeMethod=chat-core-v2-command-confirmation` and a created
  task card.
- GET /api/v1/tasks/filtered?filter=all returned the created Nexus task as
  `notStarted`.
- POST /api/v1/chat/message "Mark comprar suplementos RESTPATH 230824-4050
  task as done" returned `routeMethod=chat-core-v2-command-confirmation` and
  a completed task card.
- GET /api/v1/tasks/filtered?filter=all no longer returned the completed
  task, and container SQLite showed `native_tasks.status='completed'`.
- `sqlite3 ${DATABASE_PATH:-/app/data/local.db} "PRAGMA journal_mode;
  PRAGMA integrity_check;"` returned `delete` / `ok`.

Additional scoped sandbox fixes from 2026-05-27:
- Content script generation in Docker uses `CONTENT_ENGINE_BASE_URL` instead
  of assuming `localhost:${CONTENT_ENGINE_PORT}` from inside the Node
  container.
- Beta/invite-provider subscriptions and configured internal emails
  (`NEXUS_INTERNAL_UNLIMITED_EMAILS`; no compiled-in production default)
  resolve to beta/owner-level AI usage.
- Customer-facing billing/dashboard usage payloads expose percentage/state
  only, not raw USD limits or remaining spend.
- Apple Health sleep agenda parsing accepts legacy/simple `sleepIntervals`
  with `core`, `deep`, and `rem` stages so the Home day dial can render sleep.
- Focused verification: `npx tsc --noEmit` passed; `npx vitest run
  __tests__/api/billing-routes.test.ts __tests__/api/dashboard-routes.test.ts
  __tests__/services/cost-guardrail.test.ts
  __tests__/services/entitlement.test.ts
  __tests__/services/home-orchestration-focus.test.ts
  __tests__/services/python-engine-hardening.test.ts` passed (6 files /
  168 tests).
- Local Docker smoke after restart: `/api/v1/content/script` returned
  script data, `/billing/usage` and `/billing/status` returned safe usage
  keys only, `/dashboard.quota` returned safe usage keys only, and
  `/dashboard.dayDial.totals` included `sleep=410 minutes` after syncing a
  current-day sandbox HealthKit row.

Additional local-LLM sandbox activation from 2026-05-28:
- `CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE=canary` and
  `CHAT_CORE_V2_LOCAL_CHAT_MODEL=qwen2.5:3b-instruct-q4_K_M` are supported for
  Docker/iOS sandbox testing through the Mac SSH tunnel to the VPS Ollama
  daemon.
- Non-write chat now returns `routeMethod=chat-core-v2-local-llm` with
  `metadata.type=chat_core_v2_local_llm`; write intents continue through
  `chat-core-v2-command-*` routes and do not call the local answer composer.
- Verification completed: `npx tsc --noEmit`, focused local-chat/action
  gateway/chat-route suites, `scripts/local-smoke.sh`,
  `scripts/authenticated-api-smoke.sh`, a live sandbox chat request using
  Ollama `qwen2.5:3b-instruct-q4_K_M`, and a live create+complete task write
  that returned verified ChatCoreV2 command results.
```

`scripts/verify-agent-lanes.mjs` is now present in this worktree, and the
active registry row exists at `docs/qa/AGENT_WORK_REGISTRY.md`.

```text
node scripts/verify-agent-lanes.mjs --registry docs/qa/AGENT_WORK_REGISTRY.md
[verify-agent-lanes] OK

node scripts/verify-agent-lanes.mjs --work-order docs/qa/work-orders/WO-chatcore-v2-production-activation.md
[verify-agent-lanes] OK
```

## D1-D16 Tracking

| ID | Deliverable | Phase | Status |
|---|---|---:|---|
| D1 | Layer 1 assembly map | 0/1 | documented in `docs/ai/chatcore-v2-layer1-assembly-map.md`; pure candidate selector and bounds helpers implemented; runtime integration pending |
| D2 | ChatCoreV2 module inventory and gap analysis | 0 | documented in `docs/ai/chatcore-v2-module-inventory.md`; peer review pending |
| D3 | Hardware benchmark baseline | 0 | gate revised by operator 2026-05-28 (p95 <= 5s @ `num_ctx=256`; p50 <= 2s deferred). Bounded full `--suite=all` confirmation run 2026-05-28 (qwen 3B atom raw-prompt; 0 failures / 0 schema failures across 66 calls): sequential PASSES (p50 3378 / p95 3669 ms) but burst/concurrent/sustained FAIL the gate (p95 ~10-15s) — the CPU-only single-instance Ollama serializes under load. Gate confirmed for SERIALIZED foreground planning only (covers the single-user L2 sandbox); multi-user Phase 2 needs a planner concurrency cap/queue, hardware acceleration, or a smaller model. See calibration doc "Full-suite confirmation run". Mitigation implemented 2026-05-28: in-lane local-inference concurrency gate (`local-inference-concurrency-gate.ts`, default 1) serializes the local-LLM path (per-call p95 ~3.7s; throughput bounded — hardware/model for real multi-tenant scale). |
| D4 | `ChatTurnPlanMicro` schema and prompt budget | 1 | contract drafted; initial validator, strict Ollama JSON schema, prompt-budget helper, and bounded repair helper implemented; focused tests pass; full D3 benchmark pending |
| D5 | Evidence taxonomy per domain | 1 | drafted in `docs/ai/chatcore-v2-phase1-contracts.md`; answer-draft evidence binding helper implemented in `src/services/chat-core-v2/answer-composition.ts`; domain-specific taxonomy review pending |
| D6 | Prepass candidate algorithm and corpus | 1 | algorithm and corpus spec drafted; pure selector, prepass bounds, HMAC recall-miss helper, golden-corpus validator, and 263-item safe-paraphrase seed corpus implemented; final Phase 2 corpus still needs peer-reviewed private-evidence promotion |
| D7 | Tenant-scoped `DomainAdapterV1` | 1 | drafted and first interface implemented in `src/services/chat-core-v2/domain-adapter.ts`; domain adapter implementations pending |
| D8 | iOS turn-state event contract | 1 | drafted and helper implemented in `src/services/chat-core-v2/turn-state-events.ts`; iOS work pending |
| D9 | Background lifecycle | 1 | drafted and helper implemented in `src/services/chat-core-v2/background-lifecycle.ts`; runtime queue implementation pending |
| D10 | `AnswerCompositionMode` budget and measurement | 1 | drafted and first constants/validator implemented in `src/services/chat-core-v2/answer-composition.ts`; measurement pending |
| D11 | Single kill switch behavior and CI test | 1/2 | config resolver and auto-revert policy helpers implemented in `src/services/chat-core-v2/activation-flags.ts` and `src/services/chat-core-v2/auto-revert-policy.ts`; `src/services/chat-core-v2/action-gateway.ts` now honors explicit `CHAT_CORE_V2_ORCHESTRATOR_MODE=off`; broader runtime mode mutation still pending |
| D12 | Model residency policy applied to keep-alive config | 1/2 | policy constants plus config resolver/validator implemented in `src/services/chat-core-v2/model-residency-policy.ts`; actual daemon/runtime application pending deployment work |
| D13 | Cloud allowlist composition | 1/7 | first positive-allowlist/HMAC helper implemented in `src/services/chat-core-v2/cloud-allowlist-packet.ts`; runtime cloud fallback integration pending |
| D14 | Write risk gradient | 1 | drafted and helper implemented in `src/services/chat-core-v2/write-risk-policy.ts`; runtime enforcement pending |
| D15 | Failure observability matrix | 1/2 | matrix constants plus allowlisted safe event normalizer implemented in `src/services/chat-core-v2/failure-observability.ts`; dashboard/table wiring pending runtime implementation |
| D16 | Pure-deterministic prepass audit | 1 | initial audit documented; prepass bounds helper and CI-friendly source guard implemented in `src/services/chat-core-v2/prepass-contract.ts`; actual Layer 1 selector source-audit test added; repo-wide CI wiring pending Layer 1 runtime modules |

## Assumptions

- Implementation starts from post-Ollama/post-Option-3 `main`.
- The 3B local planner is the hot path.
- 35B foreground is not required.
- Explicit token-zero surfaces remain.
- Ordinary natural-language chat is ChatCoreV2-owned.
- Existing ChatCoreV2 modules are reused unless Phase 0 inventory proves a gap.
