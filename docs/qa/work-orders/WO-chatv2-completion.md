---
work_order_id: WO-chatv2-completion
mode: implementation
branch: codex/chat_improvement_goal
worktree: /Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot
owned_paths:
  - src/services/chat-core-v2/
  - src/services/chat-v2-completion-evidence.ts
  - src/services/chat-shadow-gate-readiness.ts
  - src/services/chat-answer-canary-exit.ts
  - src/services/chat-deterministic-read-evidence.ts
  - src/services/chat-deterministic-read-readiness.ts
  - src/services/chat-write-evidence.ts
  - src/services/chat-write-readiness.ts
  - src/services/chat-cloud-allowlist-evidence.ts
  - src/services/chat-cloud-allowlist-packet.ts
  - src/services/chat-cloud-allowlist-readiness.ts
  - src/services/chat-legacy-retirement-evidence.ts
  - src/services/chat-legacy-retirement-readiness.ts
  - src/services/chat-legacy-parity-labels.ts
  - src/services/task-store/provider-aware-read-model.ts
  - src/api/routes/chat-message-routes.ts
  - src/api/routes/usage.ts
  - scripts/chatv2-completion-readiness.ts
  - scripts/chatv2-export-legacy-parity-review.ts
  - scripts/chatv2-import-legacy-parity-labels.ts
  - scripts/chatv2-import-legacy-parity-observations.ts
  - scripts/chatv2-observe-legacy-parity.ts
  - scripts/chatv2-record-legacy-retirement-runtime.ts
  - scripts/chatv2-runtime-evidence-smoke.ts
  - scripts/chatv2-seed-local-evidence.ts
  - scripts/verify-agent-lanes.mjs
  - docs/qa/work-orders/WO-chatv2-completion.md
  - docs/qa/CHATV2_PHASE7_PARITY_QA_PROMPT.md
  - docs/qa/CHATV2_PHASE7_PARITY_REVIEW_REPORT.md
  - docs/ai/chatv2-route-exit-inventory.md
  - docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json
  - migrations/155_chatv2_completion_evidence.sql
  - migrations/156_chatv2_completion_evidence_source.sql
  - migrations/157_chatv2_deterministic_read_evidence.sql
  - migrations/158_chatv2_write_evidence.sql
  - migrations/159_chatv2_cloud_allowlist_evidence.sql
  - migrations/160_chatv2_legacy_retirement_evidence.sql
  - migrations/177_chat_v2_autorevert_counters.sql
  - migrations/179_chat_v2_fallback_attribution_counter.sql
status: in_progress
max_claim_level: L2
---

# Work Order — ChatV2 Completion Unblock

Status: in progress (local/L2 only). No production behavior change is authorized by this Work Order.

Goal: finish the ChatV2/ChatCoreV2 migration by converting the local safety gates into runtime evidence collection, then promote phases in order: shadow, answer canary, deterministic reads, write previews, confirmed writes, cloud allowlist, and legacy natural-language retirement.

Runtime-control doctrine: route-exit IDs are evidence labels, not runtime switches. Runtime rollout uses domain/tenant levers (`CHAT_CORE_V2_ORCHESTRATOR_MODE`, `CHAT_CORE_V2_ALLOWED_DOMAINS`, per-tenant `allowedDomains`, `CHAT_CORE_V2_ACTION_GATEWAY_MODE`, and per-tenant `legacyFallbackDisabled`). Legacy code remains in place during soak; no deletion is authorized in this Work Order.

Non-negotiables:
- No hardcoded runtime behavior for a user, tenant, email, recipe, task title, or demo phrase.
- No production behavior change until the phase gate has real evidence and peer review.
- Natural-language write intents must resolve through preview/execution/verification, ask clarification, or stop. They must not fall through to legacy model/tool/scoped-read paths.
- Cloud fallback is packet-only allowlist egress. No raw chat text, recent turns, calendar/task/finance/health content, or non-HMAC identifiers.
- Explicit token-zero surfaces (slash commands, buttons, direct API reads) remain available.
- Never set `CHAT_CORE_V2_ORCHESTRATOR_MODE=enforce`; the orchestrator parser accepts only `off|shadow|canary|on`, so `enforce` parses as off. The write firewall is armed by `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce` plus `CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on`.

## Phase Table

| Phase | Target | Current Status | Open Gate |
|---|---|---:|---|
| 0. Stabilize branch | Preserve green local safety/readiness slice and document ownership. | 100% complete | Full local verify is green; delivery still requires owner-approved commit/PR and peer review. |
| 1. Shadow evidence producer | Persist safe shadow rows for ordinary NL turns. | 100% local-runtime ready | Runtime route rows exceed the row floor with HMAC-only storage; production promotion still requires peer review and approved rollout. |
| 2. Answer-only canary | Enable read/answer composition for training reads, cooking, content, finance education. | 100% local-runtime ready | Runtime gate passes; production canary still needs peer review, dashboard wiring, and owner approval. |
| 3. Deterministic reads | Move today/calendar/tasks/training/what-changed reads behind ChatV2 contracts. | 100% local-runtime ready | Runtime gate passes for slash/button/API surfaces; broader production coverage still needs calendar/training/what-changed parity review. |
| 4. Write preview | Class A preview cards only. | 100% local-runtime ready | Runtime gate passes on a limited corpus; broaden the preview corpus before production rollout. |
| 5. Confirmed writes | Confirmed Class A writes with idempotency/readback. | 100% local-runtime ready | Runtime gate passes on a limited corpus; broaden duplicate-confirm/cancel/readback evidence before production rollout. |
| 6. Cloud queue fallback/allowlist | Cloud only when local queue is saturated and safe packet exists. | 100% local-runtime packet-audit ready | Packet audit gate passes with zero cloud egress; real cloud dispatch remains behind packet-only rollout approval. |
| 7. Legacy NL retirement | Retire one legacy branch at a time after parity. | 0 routes replaceable / 9 blocked | Local runtime coverage exists, but the stricter retirement gate correctly blocks all 9 route-exit rows until each has independent rubric-v2 proof for peer review, zero safety regressions, zero quality regressions, and zero degraded-not-comparable rows. |

## Runtime Ramp-Down Levers

Use the actual shipped controls; do not invent per-route switches:

1. Enable ChatV2 ownership with `CHAT_CORE_V2_ORCHESTRATOR_MODE=canary` or `on`.
2. Limit scope with global `CHAT_CORE_V2_ALLOWED_DOMAINS` and per-tenant `allowedDomains`. A tenant override may narrow the global allowlist; it must not expand it.
3. Keep `legacyFallbackDisabled=false` while expanding read/answer ownership, deterministic reads, previews, and confirmed writes. This preserves the final `routeMessage` catch-all while ChatV2 owns more upstream paths.
4. Before any write-capable route is considered retired, arm the write firewall with `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce` and `CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on`. Smoke-test a probe write intent and require telemetry with `legacyFallbackBlocked=true`.
5. Flip per-tenant `legacyFallbackDisabled=true` only as the final catch-all retirement step after independent parity labels pass, attributed fallback monitors are populated, tripwires are armed, and rollback has been rehearsed.

`legacyFallbackDisabled=true` does not retire earlier write owners by itself. Write-owner retirement depends on upstream action-gateway enforcement; catch-all retirement depends on `legacyFallbackDisabled`.

Attribution must be verified on the live `/api/v1/chat/message` route, not only on helper seams such as `runChatCoreV2OrchestrationGate`. The live route's `recordChatCoreV2LegacyFallbackSample` writes both the aggregate fallback counter and the attributed sidecar, and route-level tests must keep proving rows reach `chat_v2_legacy_fallback_attribution_counter`.

## Cohort Rollout And Tripwires

Roll out by tenant cohort: one internal tenant first, then a small tenant cohort, then broader cohorts only after the soak gates below pass. No all-user flip is authorized by this Work Order.

Soak windows:
- Reads/answer-only: at least 24h or 200 attributed turns, whichever is later.
- Deterministic reads and previews: at least 24h or 200 relevant attributed turns.
- Confirmed writes: at least 48h or 100 write attempts.
- Final catch-all retirement: at least 48h after `legacyFallbackDisabled=true`.

Stop or rollback thresholds:
- Any raw/private cloud leak: stop and revert.
- Any false success claim or unverified write success: stop and revert.
- Any `chatv2_worse` safety mismatch: block that route/domain.
- Fallback rate `>=2%` after at least 100 attributed turns: revert that tenant to legacy.
- Confirmation/action error rate `>1%` after at least 50 write attempts: revert the write phase.
- Degraded response rate `>3%` or `2x` baseline after at least 100 turns: halt cohort expansion.

Rollback rehearsal is required before exposure:
- Manually flip a canary tenant `legacyFallbackDisabled=true -> false`; confirm the legacy catch-all restores immediately.
- Fire synthetic high-fallback and degraded-response scenarios; confirm auto-revert demotes only the target tenant and records safe audit/alert metadata.

## Evidence Links

- Runtime shadow/canary evidence table: `chat_v2_completion_evidence` from migrations `155_chatv2_completion_evidence.sql` and `156_chatv2_completion_evidence_source.sql`.
- Shadow gate evaluator: `src/services/chat-shadow-gate-readiness.ts`.
- Canary gate evaluator: `src/services/chat-answer-canary-exit.ts`.
- Evidence recorder: `src/services/chat-v2-completion-evidence.ts`.
- Evidence readiness CLI: `npx tsx scripts/chatv2-completion-readiness.ts --limit=500` (opens SQLite read-only and does not run app migrations/startup). Defaults to `evidence_source='runtime_route'`. The report includes `legacyRetirementBlockers` with per-route IDs and reason codes so coverage rows cannot be mistaken for Phase 7 parity proof.
- Readiness dashboard/alert dry run: `npx tsx scripts/chatv2-readiness-alerts.ts --db=./data/local.db --limit=360 --json` turns phase gate failures into safe operator-alert payloads without writing. Add `--write-alerts` only inside a fully configured backend environment where `operator_alerts` is initialized and operator delivery is approved.
- Runtime evidence smoke: `npx tsx scripts/chatv2-runtime-evidence-smoke.ts --rows=64 --db=./data/local.db` sends ordinary chat messages through the local `/api/v1/chat/message` route. Add `--isolate-prompts --write-rows=12 --confirm-write-previews` to collect sandbox write-preview/confirmed-write evidence through temporary users. It does not write evidence directly; the running backend must have `CHAT_V2_*` evidence flags enabled for rows to appear. If `--review-out` is used, it writes an HMAC-only label skeleton by default; do not use `--allow-raw-review-artifact` for committed evidence files.
- Deterministic-read runtime evidence table: `chat_v2_deterministic_read_evidence` from migration `157_chatv2_deterministic_read_evidence.sql`.
- Deterministic-read evidence recorder: `src/services/chat-deterministic-read-evidence.ts`.
- Write readiness evidence table: `chat_v2_write_evidence` from migration `158_chatv2_write_evidence.sql`.
- Write readiness evidence recorder: `src/services/chat-write-evidence.ts`.
- Chat Reasoning Engine runtime write producer: `src/api/routes/chat-message-routes.ts` records HMAC-only `runtime_route` write evidence behind `CHAT_V2_WRITE_EVIDENCE_ENABLED`.
- Cloud allowlist evidence table: `chat_v2_cloud_allowlist_evidence` from migration `159_chatv2_cloud_allowlist_evidence.sql`.
- Cloud allowlist evidence recorder: `src/services/chat-cloud-allowlist-evidence.ts`.
- Legacy retirement evidence table: `chat_v2_legacy_retirement_evidence` from migration `160_chatv2_legacy_retirement_evidence.sql`.
- Legacy retirement evidence recorder: `src/services/chat-legacy-retirement-evidence.ts`.
- Legacy retirement runtime inventory recorder: `npx tsx scripts/chatv2-record-legacy-retirement-runtime.ts --write --replace --db=./data/local.db`.
- Legacy retirement verify-only recorder: `npx tsx scripts/chatv2-record-legacy-retirement-runtime.ts --write --verify-only --replace --db=./data/local.db --full-verify-clean=true`.
- Legacy parity label validator: `src/services/chat-legacy-parity-labels.ts`.
- Legacy parity observation importer: `npx tsx scripts/chatv2-import-legacy-parity-observations.ts --write --observations=./path/to/observations.ndjson --db=./data/local.db`. By default, runtime-route imports still require all Phase 7 routes. For route-by-route evidence collection, pass `--routes=<route_id[,route_id]>`; the importer then requires only those scoped route IDs, rejects out-of-scope observations, and records the route scope in safe metadata. Scoped imports are still `runtime_tool` plumbing evidence and never replace Claude/manual signed labels.
- Legacy parity observation producer: `npx tsx scripts/chatv2-observe-legacy-parity.ts --legacy-base-url=http://127.0.0.1:8213 --chatv2-base-url=http://127.0.0.1:8214 --evidence-source=runtime_route --samples-per-route=50 --fixture-hash=sha256:<seed-fixture-hash> --allow-write-prompts --isolate-prompts --out=./path/to/observations.ndjson`. The producer emits HMAC-only `chat_v2_legacy_parity_observation.v1` rows and refuses `runtime_route` output from a single endpoint. Runtime-route observations require the seeded-state fixture hash used by both endpoints. Same-endpoint local runs must use `--evidence-source=local_sandbox_seed` and are plumbing evidence only. Write-intent route prompts require explicit `--allow-write-prompts`; `--isolate-prompts` registers temporary users per prompt so write-route parity checks do not mutate the operator account. Distinct paired endpoints may also use `--legacy-token-file` and `--chatv2-token-file` when shared auth is not valid across both stacks. Confirm the chosen ports do not collide with the normal local portal/admin process before collecting evidence. Add `--allow-raw-review-artifact` only for local reviewer handoff: it writes a sibling `.review.json` with `chat_v2_legacy_parity_raw_review_row.v1` rows containing raw prompt and paired raw responses for Claude/manual answer-quality review. That file is local-only, ignored by git, and must never be committed or imported; the manifest keeps `rawPromptOrResponseStored=false` for the committed HMAC-only observation NDJSON and separately marks `rawReviewArtifactContainsRawPromptOrResponse=true`.
- Legacy parity retry-set composer: `npx tsx scripts/chatv2-compose-legacy-parity-retry-set.ts --sources=./run-a.ndjson,./run-b.ndjson --out=./path/to/composed.ndjson --raw-review-artifact=.local/chatv2-parity/<run>/composed.review.json`. The composer is for provider-flaky distinct-endpoint runs over the same frozen corpus/fixture. It refuses incompatible route sets, sample-HMAC sets, fixture/isolation metadata, endpoint HMACs, corpus hashes, comparator versions, or sources without a comparable matched row for every frozen sample. The committed NDJSON remains HMAC-only; the raw review artifact must be explicitly placed under `.local/` and remains local-only.
- Legacy parity label importer: `npx tsx scripts/chatv2-import-legacy-parity-labels.ts --write --labels=./path/to/labels.ndjson --peer-review-signoff=./path/to/claude-review.md --observations=./path/to/observations.ndjson --manifest=./path/to/observations.manifest.json --raw-review-artifact=./path/to/observations.review.json --db=./data/local.db`. Independent `claude`/`manual` runtime labels must prove review completeness against the HMAC-only observation manifest and the local raw review artifact: row count, route IDs, HMAC sample count, `observationsSha256`, and a one-to-one raw review row for every observation HMAC. The raw review artifact is read locally for completeness only; it is not imported or stored.
- Attributed fallback counter: migration `179_chat_v2_fallback_attribution_counter.sql` and `src/services/chat-core-v2/autorevert-counters-store.ts` record tenant/hour plus safe `domain`, `route_owner`, and `route_method` labels. This is attribution for rollback diagnosis; it stores no raw message, title, prompt, response, calendar, email, finance, health, or task content. The aggregate fallback counter remains the broad safety gauge.
- Legacy parity safe review exporter: `npx tsx scripts/chatv2-export-legacy-parity-review.ts --db=./data/local.db --out=docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json`. The export includes `parityBlocker` per row, safe aggregate coverage, and any already-imported HMAC-only parity label status. It never creates matching counts from coverage.
- Latest legacy parity safe review export: `docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json`.
- Local sandbox evidence seed: `npx tsx scripts/chatv2-seed-local-evidence.ts --write --replace --rows=64` writes `evidence_source='local_sandbox_seed'` rows for local plumbing validation only. Check those rows explicitly with `npx tsx scripts/chatv2-completion-readiness.ts --source=local_sandbox_seed --limit=240`.
- Cloud allowlist packet producer: `src/services/chat-cloud-allowlist-packet.ts`.
- Route-exit inventory: `docs/ai/chatv2-route-exit-inventory.md`.
- Provider-aware task read model: `src/services/task-store/provider-aware-read-model.ts`.
- Write/read/cloud/legacy readiness helpers:
  - `src/services/chat-deterministic-read-readiness.ts`
  - `src/services/chat-write-readiness.ts`
  - `src/services/chat-cloud-allowlist-readiness.ts`
  - `src/services/chat-legacy-retirement-readiness.ts`
- Readiness alert mapper: `src/services/chatv2-readiness-alerts.ts` records blocked phase gates through the durable `operator_alerts` service with safe metadata only.

## Runtime Flags

Default: all evidence recording is off.

- `CHAT_V2_COMPLETION_MODE=off|shadow|canary|on`
- `CHAT_V2_SHADOW_EVIDENCE_ENABLED=true`
- `CHAT_V2_ANSWER_CANARY_EVIDENCE_ENABLED=true`
- `CHAT_V2_DETERMINISTIC_READ_EVIDENCE_ENABLED=true`
- `CHAT_V2_WRITE_EVIDENCE_ENABLED=true`
- `CHAT_V2_CLOUD_ALLOWLIST_EVIDENCE_ENABLED=true`
- `CHAT_V2_LEGACY_RETIREMENT_EVIDENCE_ENABLED=true`
- `CHAT_V2_EVIDENCE_HMAC_SECRET=<stable secret>`
- `CHAT_V2_CLOUD_ALLOWLIST_HMAC_SECRET=<stable secret>`

Evidence rows must contain only safe data: HMAC message ID, locale, candidate capability IDs, final capability ID, schema-valid flag, candidate evidence hash, route owner, route method, contract-valid flag, canary metrics, and safe metadata. They must not contain raw user message text or raw private response context.

Evidence-source rule: `local_sandbox_seed` rows can unblock local code-path validation and dashboard plumbing, but they are not production shadow proof. Production phase promotion must use `runtime_route` evidence collected from actual routed chat turns.

Deterministic-read evidence-source rule: `chat_v2_deterministic_read_evidence` follows the same source split. Local rows can prove the evaluator, response-contract, tenant-isolation, and explicit token-zero surface plumbing. Phase 3 promotion requires `runtime_route` rows from the actual iOS/web/chat read paths.

Write evidence-source rule: `chat_v2_write_evidence` follows the same source split. Local rows can prove readiness evaluator plumbing only. Phase 4/5 promotion requires `runtime_route` evidence from real preview/confirmation flows and must never imply a write executed unless readback verification metadata is present.

Cloud allowlist evidence-source rule: `chat_v2_cloud_allowlist_evidence` follows the same source split. Local rows can prove packet-audit evaluator plumbing only. Phase 6 promotion requires runtime proof that any cloud-bound payload is packet-only, raw-private fields are zero, identifiers are HMAC-only, denial reasons are observable, and cloud usage stays under the approved share.

Legacy retirement evidence-source rule: `chat_v2_legacy_retirement_evidence` follows the same source split. Local rows can prove route-retirement evaluator plumbing only. Phase 7 promotion requires real runtime parity rows per route-exit inventory item, a measured fallback rate, and a clean verify run before disabling any legacy natural-language owner.

Legacy parity label rule: Phase 7 `route_exit` rows that mark a route as replaced/tested must come from peer-reviewed aggregate parity labels with schema `chat_v2_legacy_parity_label.v1` or HMAC-only sample observations with schema `chat_v2_legacy_parity_observation.v1`. Labels may contain route id, old owner, replacement, evaluator, `peerReviewSignoffHash`, sample count, matching count, `safetyRegressionCount`, `qualityRegressionCount`, `degradedNotComparableCount`, and `reviewRubricVersion` only. Observations may contain route id, HMAC sample id, old owner, replacement, evaluator, optional `peerReviewSignoffHash`, tested/matched booleans, safe reason codes, safety verdict, safety dimension, and review rubric version only. Runtime-tool/self-attested labels do not satisfy route retirement; the readiness gate requires `evaluator=claude|manual`, a 64-character SHA-256 `peerReviewSignoffHash`, `safetyRegressionCount=0`, `qualityRegressionCount=0`, `degradedNotComparableCount=0`, and review-completeness proof against the HMAC-only observation manifest for every retired route. The importers reject raw prompt, response, message, title, body, content, calendar, email, finance, health, and similar fields. The importers derive `shadow_parity_rate = matchingCount / sampleCount`; do not hand-edit parity rates.

Safety/quality regression gate: 95% parity is necessary but not sufficient. Claude/manual sample verdicts are `equivalent`, `chatv2_better`, `equivalent_different`, `chatv2_worse_quality`, `chatv2_worse_safety`, or `not_comparable_degraded`. Claude/manual verdicts override the runtime comparator. Any `chatv2_worse_safety` on false success claims, write-firewall misses, missing confirmations, wrong verification status, raw cloud/private leaks, wrong locale, broken response/action-card contract, or tenant/user leakage blocks that route regardless of parity rate. Any `chatv2_worse_quality` on answer quality, research grounding, health-adjacent safety, or material usefulness also blocks replacement. Mutual degraded responses are `not_comparable_degraded`, not parity.

Held-out parity corpus rule: Phase 7 observations must not be drawn from only the dev/golden corpus used to tune ChatV2. The corpus must include en, pt-BR, pt-PT, pt-AO, es, es-419, and mixed language; negation/hypotheticals; ambiguous cancel/dismiss phrasing; duplicate task-title flows; read-vs-write collisions; recipe generation vs cooking read; and confirmation/cancel flows.

Route replacement rule: reads may retire route-by-route after the evidence gates pass, but write routes are coupled by the global `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce` switch. The write bundle (`general_action_planner`, `chat_reasoning_engine_v1`, `decision_confirmation_shortcut`, and `destructive_confirmation_hold`) must pass detector recall, preview/card parity, idempotency/readback tests, and iOS card rendering together before the firewall is flipped for a tenant. Confirmed writes/idempotency/readback are proved by deterministic backend/iOS tests, not single-turn preview parity.

Research/web-query rule: `selective_internet_research` must build a safe public query packet before invoking a web-search provider. Do not send raw Nexus local state, task/calendar/finance/health/email content, account identifiers, raw recent turns, or private user text into web search. If the safe query cannot be built, return a degraded/clarification response and do not count mutual degraded responses as parity.

## Current Open Items

1. Production push posture: the owner approved pushing the current branch to production/main on 2026-06-02, but this does not approve legacy catch-all retirement or broad ChatV2 route replacement. Ship with conservative flags unless a later rollout explicitly says otherwise: keep `legacyFallbackDisabled=false`; do not set `CHAT_CORE_V2_ORCHESTRATOR_MODE=enforce`; keep write-owner retirement gated behind `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce` plus `CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on` and signed write-bundle evidence; keep cloud fallback packet-only and default-off.
2. Broaden the limited runtime write-preview and confirmed-write corpus before production promotion. The runtime smoke supports isolated write evidence with `--isolate-prompts --write-rows=<n> --confirm-write-previews`; use temporary users only, never the operator token.
3. Schedule the readiness alert script or equivalent runtime job in the production operations lane after owner approval; the local mapper/CLI exists, but production delivery remains disabled until the operator alert channel and phase rollout are approved.
4. Keep positive cloud allowlist dispatch disabled until a separate rollout explicitly approves packet-only cloud egress.
5. The write-firewall bundle (`general_action_planner`, `chat_reasoning_engine_v1`, `decision_confirmation_shortcut`, `destructive_confirmation_hold`) remains blocked for Claude-signed parity/import as a coupled set. The current held-out write corpus is not yet a 50-row runtime corpus per route (`general_action_planner` 11 prompts, `chat_reasoning_engine_v1` 4, `decision_confirmation_shortcut` 4, `destructive_confirmation_hold` 13), so `scripts/chatv2-observe-legacy-parity.ts` now rejects 50-row `runtime_route` write observations instead of silently relying on repeated prompt padding or crashing past the corpus. The old safe review export still shows only runtime-tool/self-attested labels for these rows; those do not satisfy Phase 7. The next unblock is to add a signed held-out write corpus with at least 50 distinct prompts per route, covering each route/action type and subcase floor, then run distinct endpoints with `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce`, `CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on`, `--allow-write-prompts`, `--isolate-prompts`, and identical seeded fixture DBs. Single-turn parity may certify only preview/card contract. Confirmed execution, readback, idempotency key behavior, no false success claim, no unverified write success, duplicate confirm/retry mutates once, and iOS card lock/render evidence must come from deterministic backend/iOS tests before this global firewall can be flipped for any tenant.
6. `selective_internet_research` remains blocked for retirement. Claude's June 2 QA rejected the earlier 50 / 50 current-head run because it reused a tiny health-adjacent prompt set to pad 50 rows; that is historical context, not the only current blocker. Later v1.2 evidence removed the repeated-prompt padding issue but did not produce signable retirement proof. The v15 retry/backoff package reported 50 / 50 runtime-tool matches, but Claude raw-pair review blocked it because roughly 9 ChatV2 answers were truncated or incomplete. The route now needs a truncation/incompleteness fix, then a fresh distinct-endpoint run from the current `chat_v2_legacy_parity_route_prompts@1.4.0` corpus or newer, followed by Claude/manual signed HMAC-only labels. No route is retired by any current `selective_internet_research` evidence.
   - 2026-06-02 unblock attempt: `.local/chatv2-parity/run-20260602T111201Z-research-v12-distinct-anthropic/observations-runtime-research-v12-anthropic-50.ndjson` produced 50 HMAC-only rows from the v1.2 corpus with `distinctPromptsByRoute.selective_internet_research=52`, but every row is `degraded_not_comparable` because web search was unavailable in the local provider configuration. Gemini search was intermittently returning provider 503s; `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` were not configured locally. This artifact is diagnostic only and must not be imported as retirement parity.
   - Code unblock: Chat internet research now supports an explicit default-off OpenAI Responses `web_search` fallback (`CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK=true`) after Gemini and Anthropic search paths fail. The fallback receives the same safe public-query prompt only and never raw Nexus context. A non-degraded retirement run still requires either a healthy Gemini search window, a configured Anthropic key, or a configured OpenAI key with the new flag enabled.
   - 2026-06-02 non-degraded provider follow-up: `.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.ndjson` produced 50 HMAC-only rows from the v1.2 corpus on distinct endpoints with OpenAI Responses `web_search` enabled as the provider fallback. Manifest path: `.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.manifest.json`. Local raw review artifact: `.local/chatv2-parity/run-20260602T113745Z-research-v12-openai/observations-runtime-research-v12-openai-budget-override-50.review.json`. Result: 50 / 50 runtime-tool matches, 0 route misses, 0 degraded-not-comparable rows, `distinctPromptsByRoute.selective_internet_research=52`, `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`, and `observationsSha256=5604f93fb3ecf286f1740b7d2a6e657b26df22b3a59af2a9cfa49645dd7b0056`. Claude review blocked this artifact with quality regressions; it is historical evidence only and must not be imported as retirement parity.
   - The OpenAI key used for this local provider follow-up was supplied ephemerally and must not be committed. Because it was pasted into the chat during the run setup, rotate that key before any further shared or production use.
   - Claude review of the OpenAI-backed package blocked the route: 46 / 50 quality parity, 4 `chatv2_worse_quality`, 0 safety regressions, 0 degraded rows. The blockers were Spanish/es-419 prompts drifting into Portuguese, one thinner current-release answer, and one scientific prompt using weaker source types than requested. Code has been updated generically to classify Spanish public-research prompts as Spanish before routing, enforce research output language, localize Spanish source/degraded copy, and prefer authoritative/peer-reviewed sources for scientific/current-release research. A fresh post-fix distinct-endpoint run is still required.
   - Post-fix provider attempt: `.local/chatv2-parity/run-20260602T121822Z-research-v12-locale-source-fix-gemini` was started with Gemini, but Gemini returned repeated 503 `UNAVAILABLE` errors and no observation artifact was emitted. Do not import or review this partial run. The remaining unblock is a healthy web-search provider run, preferably with a rotated OpenAI key configured through a secure local environment path.
   - Post-fix Gemini-backed evidence candidate: `.local/chatv2-parity/run-20260602T133620Z-research-v12-post-locale-fix-openai/observations-runtime-research-v12-postfix-openai-50.ndjson` produced 50 HMAC-only rows from the v1.2 corpus on distinct endpoints. Manifest path: `.local/chatv2-parity/run-20260602T133620Z-research-v12-post-locale-fix-openai/observations-runtime-research-v12-postfix-openai-50.manifest.json`. Local raw review artifact: `.local/chatv2-parity/run-20260602T133620Z-research-v12-post-locale-fix-openai/observations-runtime-research-v12-postfix-openai-50.review.json`. Result: 49 / 50 runtime-tool matches, 0 route misses, 1 `degraded_not_comparable` row, `distinctPromptsByRoute.selective_internet_research=52`, `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`, and `observationsSha256=556e62b8ea8a4a6c2b8aa001c9bcbc74fac8bc7707142a298ce9c3555276eb61`. This artifact predates the current corpus and has one degraded/not-comparable row, so it remains historical evidence only; do not import a label that claims `degradedNotComparableCount=0` for this artifact.
   - Latest post-fix Gemini retry/backoff blocked evidence package: `.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.ndjson` produced 50 HMAC-only rows from the v1.2 corpus on distinct endpoints. Manifest path: `.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.manifest.json`. Local raw review artifact: `.local/chatv2-parity/run-20260602T161650Z-research-v15-backoff-gemini/observations-runtime-research-v15-backoff-gemini-50.review.json`. Result: 50 / 50 runtime-tool matches, 0 route misses, 0 `degraded_not_comparable` rows, `distinctPromptsByRoute.selective_internet_research=52`, `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research`, and `observationsSha256=5604f93fb3ecf286f1740b7d2a6e657b26df22b3a59af2a9cfa49645dd7b0056`. This superseded the 49 / 50 package for raw-pair review, but Claude QA blocked v15 because roughly 9 ChatV2 answers were truncated or incomplete. The 50 / 50 runtime-tool result is non-signable and must not be imported as retirement parity.
   - Current research corpus note: `src/services/chat-legacy-parity-route-prompts.ts` now uses `chat_v2_legacy_parity_route_prompts@1.4.0`. Any fresh run after the truncation/incompleteness fix must use this corpus version or newer.
   - Local provider note: the sandbox `.env.local` currently has `GEMINI_API_KEY` configured, while `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are missing. A cleaner OpenAI-only 52-row run was not started because Codex must not paste or persist API keys from chat into shell history or local env files. Configure a rotated OpenAI key securely in `.env.local` if a fully non-degraded post-fix OpenAI-backed package is required.
7. `chat_message_shortcut_after_route` has a fresh current-corpus distinct-endpoint artifact ready for independent raw-pair review, but it is not self-signing. Artifact set: `.local/chatv2-parity/run-20260602T175327Z-research-v18-current-corpus/observations-runtime-chat-message-shortcut-after-route-v18-final-message-kind-50.{ndjson,manifest.json,review.json}`. Comparator result: 50 rows, 38 matched, 9 `card_kind_mismatch`, 3 `capability_family_mismatch`. Claude/manual must review the raw pairs and may sign only if at least 48 / 50 are equivalent or better with zero safety, quality, and degraded-not-comparable regressions.
8. `training_plan_shortcut` has a fresh current-corpus distinct-endpoint artifact after the classifier and active-training fixture fixes, but it is not self-signing. Artifact set: `.local/chatv2-parity/run-20260602T175327Z-research-v18-current-corpus/observations-runtime-training-plan-shortcut-v18-active-fixture-delayed-50.{ndjson,manifest.json,review.json}`. Comparator result: 50 rows, 35 matched, 7 `actionability_mismatch`, 3 `card_kind_mismatch`, 4 `legacy_route_not_observed`, 1 `degraded_not_comparable`. Claude/manual must decide whether ChatV2 is equivalent/better where legacy was degraded or misclassified; any material health-safety or quality regression blocks the route.
9. Request Claude Code QA before any deploy/ramp change using the Work Order, changed files, tests, and raw-context/hardcoding/fake-success checks.

## Latest Local Sandbox Evidence

Generated local seed rows on May 31, 2026 using:

```bash
npx tsx scripts/chatv2-seed-local-evidence.ts --write --replace --rows=64
npx tsx scripts/chatv2-completion-readiness.ts --source=local_sandbox_seed --limit=240 --fail-on-blocked
```

Result: 64 shadow rows and 64 answer-canary rows passed the local source-filtered gates:

- shadow row floor: 64 / 50
- schema validity: 1.00 / 0.99
- recall@8: en 1.00, pt-BR 1.00, pt-PT 1.00, mixed 1.00
- raw-message/privacy violations: 0
- candidate evidence-binding violations: 0
- canary first-progress p95: 1485 ms / 2000 ms
- model_constrained share: 0.25 / 0.35

The same run now seeds deterministic-read plumbing evidence:

- deterministic-read rows: 64
- explicit token-zero surface rows: 3 (`slash`, `button`, `api`)
- deterministic-read response-contract validity: 1.00 / 1.00
- tenant/user isolation violations: 0
- explicit token-zero surfaces preserved: 3 / 3
- write-preview local samples: 3 / 3 valid Class A preview cards, 0 unvalidated executions, 0 missing visible diffs
- confirmed-write local samples: 3 / 3 with verified-success guard, Class C escalation sample, idempotency/retry/cancel gates passing
- cloud-allowlist local samples: 100 total turns, 1 packet-only cloud turn (1%), 99 observable denials, 0 raw-private fields, 0 non-HMAC identifiers
- legacy-retirement local samples: 4 route-exit rows at 0.97 parity / 55 samples, 1% fallback rate, full verify marker clean

This is local plumbing evidence only. The default readiness command still filters to `runtime_route`; local seed rows are useful for evaluator plumbing but are not production promotion evidence.

## Latest Runtime Evidence

Generated on May 31 and refreshed on June 1, 2026 against the local sandbox API with stable HMAC evidence flags enabled. Rows were produced by real `/api/v1/chat/message`, `/api/v1/chat/callback`, and `/api/v1/tasks/filtered` requests plus HMAC-only parity label imports and packet-audit evidence; no raw-message rows were inserted directly.

Readiness command:

```bash
npx tsx scripts/chatv2-completion-readiness.ts --db .local/chatv2-parity/chatv2.db --limit=1000 --fail-on-blocked
```

Result at `2026-06-01T22:35:01.512Z`: Phase 2 through Phase 6 local runtime gates pass, and Phase 7 legacy-retirement remains blocked by the independent rubric-v2 peer-review gate.

- shadow: 746 `runtime_route` rows, schema validity 0.9973 / 0.99, recall@8 1.00 for en / pt-BR / pt-PT / mixed, raw-message/privacy violations 0, evidence-binding violations 0.
- answer canary: accepted labels 140 / 140 across required languages, unsupported-claim catch rate 1.00, first-progress p95 250 ms, raw private cloud leaks 0, `model_constrained` composer share 0.336 / 0.35.
- deterministic reads: 144 read samples, response-contract validity 1.00, tenant/user isolation violations 0, explicit token-zero surfaces preserved for slash / button / api.
- write preview: 13 Class A preview samples, valid preview cards 1.00, unvalidated executions 0, missing visible diffs 0.
- confirmed writes: 10 Class A verified samples plus 1 Class C escalation sample; no success claims without verified readback, idempotency/retry/cancel evidence passes.
- cloud allowlist: 185 runtime audit samples, cloud usage 0%, one positive packet audit with raw-private fields 0 and HMAC-only identifiers, 184 denial rows with observable denial reasons.
- legacy retirement: 9 required route-exit rows have coverage/parity rows, but all 9 are blocked under the stricter rubric-v2 gate because the latest runtime DB evidence does not provide complete independent proof for peer review, safety, quality, and degraded-not-comparable counts. The live fallback rate measured from `chat_v2_legacy_fallback_counter` is 0%, and full verify evidence is clean.
- Phase 7 exporter/importer/validator is available. The latest safe review export at `docs/release/eval-evidence/chatv2-legacy-parity-review-latest.json` reports 18 route-exit rows, 9 `parityLabelNeeded` rows, and 9 blocked rows. Do not re-import `runtime_tool` labels as retirement proof.
- Phase 7 paired-observation producer is available. `scripts/chatv2-observe-legacy-parity.ts` compares safe semantic projections from paired legacy and ChatV2 HTTP responses and emits HMAC-only observations for route exits that need future evidence refreshes. It does not write to the DB and it deliberately refuses `runtime_route` evidence unless legacy and ChatV2 base URLs are distinct. Use `--isolate-prompts` for write-route checks unless the operator intentionally wants to reuse a review account. For independent answer-quality review, pass `--allow-raw-review-artifact` to produce a local-only raw/projection `.review.json`; keep that artifact out of git and import only the signed HMAC-only labels. This unblocks legitimate evidence collection without allowing same-response local runs to masquerade as production parity proof.
- Readiness alert dry run is available via `scripts/chatv2-readiness-alerts.ts`; alert writing is intentionally separate from evidence collection.
- The current Phase 7 blocker trail supports 0 route replacements and blocks all 9 required rows until fresh distinct-endpoint evidence is reviewed and imported with rubric-v2 `claude`/`manual` labels containing zero safety, quality, and degraded-not-comparable counts.

Full local verification after the runtime evidence run, refreshed after the Phase 7 parity tooling updates:

```bash
npm run verify
```

Latest verification after the raw-review artifact and rubric-v2 readiness hardening: focused legacy-retirement readiness/export suites passed 27/27 checks, `npx tsc --noEmit` passed, and full `npm run verify` passed 746 files / 10,607 tests.

June 2, 2026 distinct-endpoint refresh against seeded fixture
`sha256:6c35f694ff0c9cd1a575e769ff3789a81bb21456ff54d55e5a2336032c1192cf`:

- Domain handler execution/cooking-content answer path:
  - HMAC-only observations:
    `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-domain-handler-after-templated-cooking-50.ndjson`
  - Result: 50 / 50 matched, 0 degraded-not-comparable, 0 target-route misses.
  - Observations SHA-256: `0c9136c57bbda2eed39ec910fc02bfde565640633b48dfe59161a0c6a65e0fda`.
  - Still not replaceable until Claude/manual signs the local raw-pair review and HMAC-only labels are imported.
- Research/web-grounded route after deterministic-read health guard and quota override:
  - HMAC-only observations:
    `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-after-budget-override-50.ndjson`
  - Result: 46 / 50 matched, 0 target-route misses; the 4 mismatches were one-sided degraded provider responses.
  - Observations SHA-256: `dee6ed20c6bf50bc984f3231ac7f0f497f0b174be601f84f53dd8c4a88e452bc`.
- Research/web-grounded route after adding bounded provider retry:
  - HMAC-only observations:
    `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-after-provider-retry-50.ndjson`
  - Result: 35 / 50 matched, 0 target-route misses; all 15 mismatches were `degraded_not_comparable` due repeated Gemini grounded-search `503 UNAVAILABLE` responses under high demand.
  - Observations SHA-256: `e97e98887ee31669b23538f9b639d23e5eedff205e27bc5c16f57011a2d44136`.
  - The bounded retry is retained because it is read-only, safe-query-only, and unit-tested, but it does not make provider-capacity failures valid replacement evidence.
- Research/web-grounded route after adding Anthropic web-search fallback and fixing the active local parity users' evidence-only quota override:
  - HMAC-only diagnostic observations:
    `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-diagnostic-after-quota-user-fix-10.ndjson`
  - Diagnostic result: 10 / 10 matched, 0 target-route misses.
  - Diagnostic observations SHA-256: `44549f9f9e0dfbc1cbb3c4b46b5e086db8b10df2a688fbe62250ebe9977a4f9e`.
  - HMAC-only full observations:
    `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-after-quota-user-fix-throttled-50-v2.ndjson`
  - Full result: 43 / 50 matched, 0 target-route misses; the 7 mismatches were provider-degraded/non-comparable rows, not route misses. The gate remains blocked because replacement requires `>=95%` parity and `degradedNotComparableCount=0` before Claude/manual import.
  - Full observations SHA-256: `31f10af5e59633ceefd8cc87b76d302a9b184f81bcf13fd68fc601de70f0c9e3`.
  - The Anthropic fallback is retained because it is safe-query-only and unit-tested. It did not fire in this sandbox evidence run because `ANTHROPIC_API_KEY` is not configured locally.
- Research/web-grounded route current-head distinct-endpoint rerun after rebuilding and sourcing provider env into both parity endpoints (historical diagnostic only; invalidated by June 2 QA for route retirement because the underlying corpus repeated a small health-adjacent prompt set):
  - HMAC-only observations:
    `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-current-head-50.ndjson`
  - Local raw-pair review artifact:
    `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/observations-runtime-research-current-head-50.review.json`
  - Result: 50 / 50 matched, 0 target-route misses, 0 degraded-not-comparable rows under the old corpus.
  - Observations SHA-256: `01cc06a17b7a335e376f860aa6983fc5d444a260dd253a596c8851a00e0c8641`.
  - Manifest SHA-256: `12877a80077e2ef792bd28e7fa11ac11483d13bfdc63a6904c18efbffb886722`.
  - Raw review artifact SHA-256: `328a176d4e82c78362eaa55c769b823b964c9bd37bff3a4e6ba81cd45dac74b2`.
  - Claude QA later rejected this as retirement evidence because the research route corpus was not diverse and repeated prompts to reach the 50-row floor.
- Research/web-grounded route current-head scoped runtime-tool import (historical diagnostic only):
  - Imported into local runtime DB:
    `.local/chatv2-parity/run-20260602T011350Z-seeded-write-refresh/chatv2.db`
  - Import command used explicit route scope:
    `--routes=selective_internet_research`
  - Result: accepted 50 / 50 for `selective_internet_research`, `routeScopedObservationImport=true` under the old manifest.
  - This scoped import must not be used for retirement. Current tooling requires `promptSamplingPolicy=no_repeated_prompts_for_answer_quality_research` and `distinctPromptsByRoute[selective_internet_research] >= samplesByRoute[selective_internet_research]` before answer-quality research observations can be imported as valid runtime evidence.
- Research/web-grounded route held-out corpus hardening after Claude B1/B2:
  - `src/services/chat-legacy-parity-route-prompts.ts` now uses `chat_v2_legacy_parity_route_prompts@1.4.0`.
  - The route has at least 50 distinct public-query prompts across en, pt-BR, pt-PT, pt-AO, es, es-419, and mixed language.
  - Categories include current events, factual lookup, product comparison, public finance, public law, science research, sports stats, travel/weather, and a limited health-adjacent subset.
  - `scripts/chatv2-observe-legacy-parity.ts` refuses runtime answer-quality research sampling when distinct prompts are below `--samples-per-route`.
  - `scripts/chatv2-import-legacy-parity-observations.ts` rejects manifests missing the no-repeat policy or with `distinctPromptsByRoute` below the observed row count.
  - Next required action: fix the v15 truncation/incompleteness issue, collect a fresh distinct-endpoint research run from this current corpus, ask Claude/manual to review the local raw pairs for answer quality and safe web-query behavior, then import only signed HMAC-only labels.
  - Provider prerequisite: at least one web-search provider must be configured and healthy. Valid local options are Gemini search, `ANTHROPIC_ENABLED=true` with `ANTHROPIC_API_KEY`, or `CHAT_INTERNET_RESEARCH_OPENAI_WEB_SEARCH_FALLBACK=true` with `OPENAI_API_KEY`.
- Retry-selection tooling is available for future provider-flaky routes:
  - `scripts/chatv2-compose-legacy-parity-retry-set.ts`
  - It composes one matched/comparable row per frozen sample only when repeated runs share the same route set, corpus hash, fixture hash, fixture/isolation metadata, endpoint HMACs, comparator version, and sample-HMAC set.
  - It requires an explicit `.local/` raw-review artifact path so raw prompts/responses cannot be accidentally written next to committed evidence.
  - It emits runtime-tool evidence only and marks the manifest with `chat_v2_legacy_parity_retry_selection.v1`; Claude/manual review remains mandatory.

The runtime evidence is local/L2 sandbox evidence. It is sufficient to unblock the next local implementation work, not a production deployment claim.
