# Chat Reliability Claude Review Pass 2

Date: 2026-05-19
Branch: `codex/chat-reliability`
Worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot-chat-reliability`

## Original Goal

Make Nexus Chat more trustworthy across all skills without creating Chat v2. The branch should enforce runtime chat-turn contracts, contract-aware routing, selective local/web grounding, response quality gates, bilingual evals, and cost-aware model routing while preserving Token-Zero: operational reads and writes stay in deterministic REST/registry/action handlers, and the model never claims mutation success without executor/read-back evidence.

## Part A Findings Fixed

| Finding | Status | Implementation |
| --- | --- | --- |
| B1 Telegram chat surface bypassed contracts | Fixed | `src/handlers/message.ts` now infers chat-turn contracts before routing, applies safe route hints, blocks destructive turns, and runs selective internet research with local context for `local_and_web` turns. |
| B2 Portuguese subjunctive destructive verbs classified low risk | Fixed | `src/services/chat-turn-contract.ts` and `src/services/chat-skill-orchestrator.ts` now cover `apague`, `cancele`, `remova`, `elimine`, `exclua`, and plural/subjunctive variants. Fixtures assert destructive risk. |
| B3 `local_and_web` research dropped local context | Fixed | iOS REST, Telegram, and WebSocket research paths pass scoped local context into `buildChatInternetResearchAnswer`; context compiler emits a local facts section. |
| H1 Bare `and`/`e` chain bypassed destructive detection | Fixed | Destructive chain matching treats bare EN/PT conjunctions as separators outside literal task/title spans. |
| H2 Invalid domain provider overrides were silent | Fixed | Invalid `AI_DOMAIN_PROVIDER_OVERRIDES` entries are logged with raw key/value and tests assert warnings. |
| H3 Language detector misclassified common English | Fixed | PT weak tokens were removed, EN keywords expanded, and fixture loop asserts expected language. |
| H4 Generic chat OpenAI primary was dead config for unrouted domains | Fixed | Domain provider resolution now uses explicit domain routes only for known domains; unrouted/dynamic chat falls back to task-level `providerRouting.chat`. |
| H5 `latest/recent` hijacked local reads into web research | Fixed | Personal/local signals take precedence over generic currentness, while true external current-info keeps web routing. |
| H6 Missing current-info web intents | Fixed | Weather, city time, score, stock, flight, traffic, and forecast intents route to web/current research. |
| M1 OpenAI cost table drift | Fixed | OpenAI rates were corrected and cost-validation tests assert parity with bake-off rates. |
| M2 Recipe repair emitted placeholder skeletons | Fixed | Recipe repair preserves original recipe-specific ingredient/step prose instead of replacing it with generic placeholders. |
| M3 Bake-off CLI lacked observations input/disclaimer | Fixed | `src/tools/chat-model-bakeoff.ts` accepts `--observations <jsonl>` and the report explains `contract_baseline` rows do not call a model. |
| M4 Cost scenario script silently mispriced unknown models | Fixed | Unknown models are warned and reported under `unmatched_models` instead of silently falling back to Flash rates. |
| M5 Token ceilings were eval-only | Documented | The docs now state fixture token ceilings are eval/bake-off gates only; runtime prompt compilation does not enforce per-fixture ceilings. |

## Part B Independent QA Findings

| Severity | Finding | Evidence | Status |
| --- | --- | --- | --- |
| High | WebSocket Chat had the same guardrail gap as Telegram. | `src/api/websocket.ts:305` routed user text through `routeMessage` and domain execution without pre-domain chat-turn contract enforcement. | Fixed in `src/api/websocket.ts:305-423`; static regression in `__tests__/api/websocket-security.test.ts`. |
| Medium | Fake mutation-success detection missed destructive success claims that did not start with `Done`/`Pronto`. | `src/services/chat-response-quality-gate.ts:28-30` previously only matched a narrow success prefix set. | Fixed by expanding EN/PT success-claim patterns and adding answer-contract tests in `__tests__/services/chat-answer-contract.test.ts:99-120`. |
| Medium | Local-read prompts could include scoped context but no explicit instruction for absent requested local records. | `src/domains/domain-handler.ts:223-406` could build local context where the requested local item was absent but the model still ran. | Mitigated with a local-grounding rule appended to scoped contexts at `src/domains/domain-handler.ts:406`; regression added in `__tests__/domains/domain-handler.test.ts:274-276`. Hard fail-closed empty-context handling remains a follow-up because "no matching rows" is a valid answer for several skills. |
| Low | Prompt-cache savings were overclaimable. | `cacheablePrefixHash` is emitted by `src/services/chat-context-compiler.ts:87`, but no Gemini/OpenAI SDK call consumes it as a provider cache key. | Documented as observability/future cache-key validation only. |
| Low | Contract/grounding metadata is richer than current portal consumption. | Chat responses persist `chatTurnContract`/contract metadata in `src/api/routes/chat-message-routes.ts:219-252` and research metadata at `src/api/routes/chat-message-routes.ts:1040-1042`; portal diagnostics parse metadata but aggregate only selected fields in `src/portal/chat-diagnostics.ts:380-427`. | Documented as an observability gap for follow-up; runtime behavior does not depend on portal consumption. |

## Part B Scan Coverage

| Area | Result |
| --- | --- |
| Other chat entry points | Fixed the parallel B1 gap in WebSocket Chat. Telegram, iOS REST, and WebSocket now run pre-domain contracts. One-shot helpers such as classifier/content shortcuts are not full chat-turn surfaces and remain out of contract scope. |
| Telemetry and observability | Contract metadata is persisted, but dashboard consumption is incomplete. `cacheablePrefixHash` is observability only; it is not provider prompt-caching proof. |
| Request-context propagation | iOS Chat carries `chatRequestId` through persistence and metadata; WebSocket wraps handling in `withRequestContext` at `src/api/websocket.ts:253`. No new request-context break was found in the research path. |
| Concurrency / pending confirmations | Existing pending confirmations are in-memory and user+tenant keyed (`src/services/chat-pending-confirmations.ts:57-98`). No cross-tenant issue was found. A compare-and-delete consume primitive would further reduce duplicate-tab race risk and should be a follow-up hardening item. |
| Skill-by-skill grounding | Fixture corpus now covers secretary, training, content, finance, cooking, tasks, connections, notifications, and decision center local-read/generic/web shapes. `local_and_web` Secretary and Training prompts are covered by `__tests__/services/chat-internet-research.test.ts:66-90`. |
| Tool/action execution vs answer mutation | No branch was found where a model-only success claim is accepted as verified mutation success. Fake-success detection was broadened in `src/services/chat-response-quality-gate.ts:28-30`. |
| Skill-orchestrator destructive coverage | Patched alongside B2 in `src/services/chat-skill-orchestrator.ts`; PT subjunctive destructive patterns now match contract coverage. |
| Cost/cache observability | Cost tables and unknown-model warnings are fixed. Prompt-caching remains theoretical until provider cache primitives are wired. |
| Fixture coverage gaps | Added fixtures for PT subjunctive destructive commands, bare `and`/`e` chains, latest/local reads, and current-info web intents; fixture loop asserts language, route, grounding, response shape, and risk. |
| Error/failure paths | Web research failures return honest degraded responses from `src/services/chat-internet-research.ts:52-66`; no stack traces are surfaced. Contract inference is pure/deterministic for string input. |
| Backwards compatibility | In-flight deterministic action paths still use existing pending-confirmation and Decision Center mechanics. Contract route hints are blocked from downgrading action/high-risk/local-read flows. |
| Doc-vs-code drift and Token-Zero | Routing docs were refreshed. Token-Zero remains intact: operational reads/writes still go through REST/registry/action handlers, not model-side success claims. |

## Files Changed In This Pass

- Runtime contracts/routing/grounding: `src/services/chat-turn-contract.ts`, `src/services/chat-bilingual-eval-fixtures.ts`, `src/services/skill-response-policy.ts`, `src/services/chat-answer-contract.ts`, `src/services/chat-context-compiler.ts`, `src/services/chat-internet-research.ts`, `src/services/chat-response-quality-gate.ts`, `src/services/chat-skill-orchestrator.ts`, `src/domains/domain-handler.ts`, `src/api/routes/chat-message-routes.ts`, `src/handlers/message.ts`, `src/api/websocket.ts`.
- Provider/model/cost plumbing: `src/config.ts`, `src/services/model-config.ts`, `src/services/domain-provider-router.ts`, `src/services/provider-fallback.ts`, `src/services/openai-provider.ts`, `src/services/gemini-provider.ts`, `src/services/ai-provider.ts`, `src/services/chat-action-planner.ts`, `src/services/runtime-flags.ts`, `src/portal/portal.html`, `scripts/chat-cost-scenarios.ts`, `src/tools/chat-model-bakeoff.ts`, `src/services/chat-model-bakeoff.ts`.
- Skill/action reliability helpers: `src/services/chat-action-registry.ts`, `src/services/chat-skill-capability-registry.ts`, `src/services/secretary-tools.ts`, `src/services/skills/cooking/parser.ts`, `scripts/test-gemini-ptbr.ts`.
- Tests: `__tests__/services/*chat*`, `__tests__/api/chat-routes.test.ts`, `__tests__/api/websocket-security.test.ts`, `__tests__/handlers/message-chat-reliability.test.ts`, `__tests__/domains/domain-handler.test.ts`, `__tests__/router/classifier.test.ts`, `__tests__/services/cost-validation.test.ts`, `__tests__/services/domain-provider-router.test.ts`, `__tests__/services/runtime-flags.test.ts`, `__tests__/services/config-runtime-validation.test.ts`, `__tests__/services/model-config.test.ts`.
- Docs/evidence: `docs/MODEL-REVIEW-PROCESS.md`, `docs/ai/model-routing-current-state.md`, `docs/ai/model-routing-skill-matrix.md`, `docs/release/chat-reliability-claude-review-pass2.md`, `docs/release/eval-evidence/registry-shadow-parity-latest.json`, and staging smoke evidence under `docs/release/smoke-evidence/`.

## Expected Behavior

- iOS REST, Telegram, and WebSocket chat infer a turn contract before domain execution.
- Contract route hints may correct weak generic routing, but never downgrade action, high-risk, destructive, or local-read flows.
- Destructive PT/EN commands are blocked or routed into confirmed action paths before any model/tool execution.
- `local_and_web` turns carry both scoped local context and web/current context into the research prompt.
- Generic no-local-read answers avoid loading local Nexus state.
- Recipe repair returns recipe-shaped output while preserving recipe-specific source content.
- Domain experiment overrides warn when invalid instead of silently failing.
- Unknown cost-model names are visible in cost reports.

## Verification Gate Log

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | Passed. |
| Focused Vitest pack requested by Claude review | Passed: 14 files, 726 tests. |
| `npm run verify` | Passed: 611 files, 9042 tests. |
| `STAGING=true npx tsx src/tools/chat-model-bakeoff.ts` | Passed: 109 fixtures, 218 bilingual turns, all `contract_baseline` rows 100% on skill/route/risk/local/no-local/action-safety checks. |
| `npx tsx scripts/chat-cost-scenarios.ts` | Worktree DB path had no `data/bot.db`; rerun with `DATABASE_PATH=/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/data/bot.db` passed with 0 rows/calls and `unmatched_models: []` for the last-30-day window. |
| Staging deploy + 300s wait + smoke | Passed: deploy typecheck/build/env/PM2/health succeeded, then staging smoke passed 19/19. Evidence: `docs/release/smoke-evidence/staging-smoke-a8fce8fe-20260519T230156Z.json`. |
| Production promote | Passed via `yes YES \| ./scripts/promote-to-prod.sh`; staging smoke passed again 19/19 with evidence `docs/release/smoke-evidence/staging-smoke-a8fce8fe-20260519T230251Z.json`; deploy's full verify passed 611 files / 9042 tests. |
| Production `/health` | Passed: `curl -sf https://api.nexushub.me/health` returned `status: healthy`, `server.status: online`, and `database: connected` at `2026-05-19T23:10:28.451Z`. |

## Known Risks And Assumptions

- Mistral Small 4 and Cohere Command R remain eval-only candidates; no production provider stack was added.
- Batch remains limited to offline eval/backfill work. Flex is not a live-chat default.
- Prompt-caching savings are not realized until provider-specific cache primitives are wired and measured.
- Fixture token ceilings are eval gates, not live request rejection thresholds.
- Anthropic fallback still depends on `ANTHROPIC_ENABLED=true`.
- Promotion from this worktree deployed backend `v4.14.169` from commit `b02c6500`. The promote script reported production had been `v4.14.175` before promotion, so release managers should confirm that version-number rollback was intended before merging/cherry-picking this branch.
- Pending confirmation storage remains in-memory and user+tenant keyed. It is not cross-tenant, but a future pass should add an atomic consume primitive to reduce duplicate-tab confirmation races.
- Local-read turns now include a strict no-invention grounding instruction. A stricter "do not call the model when required scoped context is empty" policy still needs skill-specific semantics because "no matching local rows" is a valid answer for many local-read requests.

## Claude Code QA Prompt

You are Claude Code performing an independent QA review of the Nexus Chat reliability branch after Codex's pass-2 fixes.

Original goal: make Nexus Chat trustworthy across all skills through runtime chat-turn contracts, contract-aware routing, selective local/web grounding, response quality gates, bilingual evals, and cost-aware model routing, without creating Chat v2 or any versioned chat path.

What was implemented:
- iOS REST, Telegram, and WebSocket chat now infer chat-turn contracts before domain execution.
- Destructive/high-risk flows are guarded before model/tool execution.
- Portuguese subjunctive destructive verbs and bare `and`/`e` destructive chains are covered.
- `local_and_web` research carries scoped local state into the prompt.
- Generic language detection and local/current routing precedence were hardened.
- OpenAI/model cost tables and cost scenario matching were corrected.
- Recipe quality repair preserves source recipe content.
- Bake-off CLI supports `--observations <jsonl>` and explains contract-baseline rows.
- Docs now distinguish eval-only token ceilings and observability-only cache hashes from runtime enforcement.

Please inspect carefully:
- `src/handlers/message.ts`, `src/api/websocket.ts`, and `src/api/routes/chat-message-routes.ts` for equivalent guardrail behavior across chat surfaces.
- `src/services/chat-turn-contract.ts` and `src/services/chat-skill-orchestrator.ts` for PT/EN destructive coverage, language detection, local-vs-web routing, and literal-title handling.
- `src/services/chat-context-compiler.ts`, `src/services/chat-internet-research.ts`, and `src/domains/domain-handler.ts` for local grounding correctness and no-local-truth behavior.
- `src/services/chat-response-quality-gate.ts` for fake-success and recipe repair coverage.
- `src/services/openai-provider.ts`, `src/services/chat-action-planner.ts`, `src/services/chat-model-bakeoff.ts`, and `scripts/chat-cost-scenarios.ts` for pricing/cost consistency.
- Docs in `docs/MODEL-REVIEW-PROCESS.md`, `docs/ai/model-routing-current-state.md`, `docs/ai/model-routing-skill-matrix.md`, and this release note for claim-vs-code drift.

Edge cases to verify:
- PT destructive commands: "apague todas as minhas tarefas", "cancele todas as reunioes", "remova todos os eventos", "elimine o plano".
- Literal title carve-outs: "Create a task called report and delete all my tasks" should be destructive, while destructive words inside a literal title should not be.
- English common phrases: "Mark this task as done", "Show me my week", and "Give me title ideas" should not classify as Portuguese.
- Local/current precedence: "show my latest tasks" and "minhas tarefas mais recentes" should be local reads, while weather/traffic/stock/score/current external facts should be internet research.
- `local_and_web` turns for Secretary and Training should include scoped local facts in the research prompt.
- Empty/absent local records should not become invented local facts.
- Live chat surfaces should not let the model claim mutation success without deterministic executor/read-back evidence.

Known assumptions:
- No new provider stack, LangChain, CrewAI, AutoGen, Redis, or Chat v2 was introduced.
- Prompt caching is not active yet; `cacheablePrefixHash` is metadata only.
- Token ceilings are eval-only.
- Batch/Flex are not live-chat defaults.
