# Model Routing Safety Audit

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Commit audited: `34add9a`
Scope: Batch 8, live model-routing safety and observability
Change type: documentation-only audit; no runtime routing changes, no deployment

## Executive Summary

Nexus does not use GPT, Claude, Gemini, or any single model as a fixed runtime default. The backend has a configurable live routing stack with task-type routing, domain routing, model overrides, environment flags, portal/operator controls, provider availability checks, circuit breakers, and Anthropic gating.

The core routed Chat/domain path is directionally sound: Chat resolves tenant scope before domain execution, the domain handler builds context once, `TaskRoutingProvider` passes the same scoped prompt/context/tool state into primary and fallback providers, and concrete provider adapters record provider/model/category/cost/latency in `api_usage` where the call path supplies user and tenant metadata.

The audit did not find an immediate P0 model-routing exploit requiring an emergency code change in this batch. It did find several P1/P2 issues that should block an unconditional Chat production release until fixed or explicitly accepted:

- OpenAI domain/tool fallback ignores Secretary optimization's filtered tool list and sends the full tool catalog.
- OpenAI streaming is an off-path, OpenAI-only extension with no central fallback/circuit breaker and usage rows without tenant attribution.
- The Python content-engine AI proxy routes through TS fallback but does not carry user/tenant attribution.
- Domain fallback construction can instantiate disabled Anthropic providers in domain-specific pairs, leaving operator intent less clear than the task-router path.
- Some context blocks assembled before provider calls still use user-only state, so tenant scoping is not uniformly proven across legacy skill context.
- Vision and invoice paths have provider-order drift versus the stated Gemini-first architecture.
- Fallback events and provider telemetry lack a single tenant/user-safe request trace tying together request id, domain, task type, provider, model, fallback reason, latency, cost, and final response state.

Release-gate verdict for this batch: **PASS WITH CONDITIONS**. No P0 routing exploit was confirmed, but the P1 items below should be treated as production-release blockers for Chat unless the release scope explicitly excludes those paths.

## Architecture Confirmed

### Task-Type Routing

Source: `src/config.ts`, `src/services/provider-registry.ts`, `src/services/provider-fallback.ts`

The default task-type cascade is provider-agnostic and environment configurable:

| Task type | Code default primary | Code default fallback | Env override keys |
| --- | --- | --- | --- |
| classify | `gemini` | `openai` | `AI_CLASSIFY_PRIMARY`, `AI_CLASSIFY_FALLBACK` |
| chat | `gemini` | `openai` | `AI_CHAT_PRIMARY`, `AI_CHAT_FALLBACK` |
| toolUse | `gemini` | `openai` | `AI_TOOL_USE_PRIMARY`, `AI_TOOL_USE_FALLBACK` |

`TaskRoutingProvider.resolveTaskType()` maps Secretary and Triathlon/Training to `tool-use`; other skill domains default to `chat`.

### Domain Routing

Source: `src/services/domain-provider-router.ts`

Domain routing overlays task routing:

| Domain | Default primary | Default fallback | Notes |
| --- | --- | --- | --- |
| secretary | `openai` | `gemini` | Domain-specific pair differs from task primary, so Secretary uses the domain pair. |
| triathlon/training | `gemini` | `anthropic` in the domain map | In the common path where domain primary equals task primary, task fallback usually decides the effective fallback. |
| content | `gemini` | `anthropic` in the domain map | Same domain-map/task-pair nuance. |
| finance | `gemini` | `anthropic` in the domain map | Same domain-map/task-pair nuance. |
| cooking | `gemini` | `anthropic` in the domain map | Same domain-map/task-pair nuance. |

Operator controls exist through environment flags and persisted portal settings:

- `GEMINI_ROUTING_ENABLED`
- `GEMINI_DOMAINS`
- `GEMINI_INCLUDE_SECRETARY`
- `SECRETARY_HAIKU_ROUTING_ENABLED`
- portal `/api/domain-routing/toggle`

The name `GEMINI_INCLUDE_SECRETARY` is misleading in current code: `true` keeps Secretary on OpenAI; `false` pushes Secretary toward Anthropic emergency routing.

### Model Overrides

Source: `src/services/model-config.ts`, `src/portal/provider-routes.ts`

Model selection is layered:

1. Domain override in `kv_store`, key `model_override:${provider}:${domain}`.
2. Provider role/tier override in `kv_store`, key `model_override:${provider}:${role}`.
3. Provider default in `src/config.ts`.

The portal model-config route validates provider, role, and model against `MODEL_OPTIONS` before saving an override. That preserves operator control while preventing arbitrary model strings from being pinned through the portal route.

## Routing Path Audit

### Classify Path

Primary Chat classification flow:

1. `src/router/index.ts:routeMessage`
2. pattern and keyword routing first
3. `classifyWithClaude` for ambiguous cases
4. `src/services/anthropic.ts:classifyMessage`
5. `completeOneShotWithFallback`

Despite the historical function name, classification is not Claude-only. The current cascade is:

1. Gemini one-shot using `config.gemini.classifierModel`
2. OpenAI one-shot fallback
3. Anthropic fallback only through the supplied thunk and only when `ANTHROPIC_ENABLED=true`

Safety notes:

- REST Chat passes `userId` and `tenantId` into classification.
- Active conversation context may be included, but the REST path resolves active context by `(tenantId, userId)`.
- The provider-interface `classify()` methods in `GeminiProvider` and `OpenAIProvider` still lack user/tenant parameters and log usage without scope when called directly. The main Chat classifier does not use those adapter methods today.

### Chat Path

Primary REST Chat flow:

1. `src/api/routes/chat-message-routes.ts`
2. `ensureValidChatRouteScope`
3. `routeMessage(..., userId, tenantId)`
4. `runWithChatToolAuthorization({ userId, tenantId, ... })`
5. domain handler with `(message, userId, tenantId)`
6. `buildSimpleStateContext(domain, userId, message, tenantId)`
7. `TaskRoutingProvider.callDomain`
8. concrete provider adapter

Safety notes:

- Tenant scope is resolved before prompt construction in the REST Chat route.
- The fallback provider receives the same `history`, `message`, `stateContext`, filtered tools, model tier, `userId`, and `tenantId` that were prepared for the primary call.
- This is the right security shape: fallback does not rebuild broader context.

Remaining risk:

- `buildSimpleStateContext` still reads some legacy state by `userId` only, including task to-dos, coach state, active training plan summary, training profile/progression blocks, and content knowledge prompt blocks. Some of those stores may be intentionally per-user, but this audit did not prove tenant partitioning for all of them.

### ToolUse Path

Tool-use domains route through `TaskRoutingProvider`:

- Secretary
- Triathlon/Training

The routing layer computes Secretary optimization once and passes:

- `filteredTools`
- `modelTier`
- sliced history
- `userId`
- `tenantId`

Gemini and Anthropic adapters honor the filtered tool list. OpenAI currently does not:

- `OpenAIProvider.callDomain()` uses `toOpenAITools()` from the full `TOOLS` catalog.
- `OpenAIProvider.continueWithToolResults()` also uses the full tool catalog.

This does not by itself prove an unauthorized tool execution because tool calls still pass through `executeScopedToolCall` and Chat tool authorization. It does weaken model-side tool minimization and can produce broader or lower-quality tool calls during OpenAI primary or fallback execution.

### Tool-Continuation Path

Tool continuation goes through the same `TaskRoutingProvider` pair as the initial tool-use call.

Good behavior:

- The same `history`, `message`, `stateContext`, tool conversation, `userId`, and `tenantId` are passed into the continuation call.
- Gemini explicitly preserves the same filtered tool list and model tier across continuation.

Remaining risk:

- OpenAI continuation uses the full tool catalog and does not preserve the filtered tool set.
- Fallback events are not persisted in a way that can be joined to the final response, tool call ids, or Chat request id.

### Vision/Image Path

Primary Chat attachment path:

1. `src/api/routes/chat-message-attachments.ts`
2. `classifyAndExtractImage`
3. provider fallback in `src/services/anthropic.ts` and `src/services/gemini-provider.ts`

Most image classification uses:

1. Gemini vision
2. OpenAI vision
3. Anthropic gated fallback

Receipt/invoice parsing is different:

- `src/services/invoice-filer.ts:analyzeInvoiceImage` tries Anthropic first, then falls back to the Gemini/OpenAI/Anthropic-gated helper.
- Comments in `finance.ts` still describe Anthropic as primary for invoices, while broader model-routing docs and some helper comments describe Gemini-first vision.

Safety notes:

- Chat attachment classification receives `userId` and `tenantId`.
- Finance receipt parsing currently passes user scope for cost guardrails, but provider usage attribution through `analyzeInvoiceImage` needs explicit tenant review.

### WebSocket/Streaming Path

Source: `src/api/websocket.ts`, `src/services/openai-provider.ts`

There are two streaming-adjacent surfaces:

1. iOS WebSocket route streams simulated chunks after the full domain handler returns. It does not use provider-native streaming.
2. `OpenAIProvider.streamDomain()` is a WhatsApp-specific extension, not part of `AIProvider`.

Risks:

- `OpenAIProvider.streamDomain()` is OpenAI-only.
- It does not use `TaskRoutingProvider`, central fallback, or circuit breaker logic.
- It writes `api_usage` with `user_id = 0` and no `tenant_id`.
- It has no tool-call support in the streaming path.

WebSocket tenant note:

- The WebSocket auth payload currently sets `tenantId = payload.userId`. That may be acceptable for a legacy single-user stream path, but it is not sufficient for multi-tenant Chat unless the client can select an active tenant and the backend verifies membership.

### Python Content-Engine Proxy

Source: `content-engine/services/claude_client.py`, `src/api/routes/internal.ts`

Python no longer calls provider APIs directly for ordinary completions. It posts to:

- `POST /api/v1/internal/ai-complete`

The TS backend then uses:

- `completeOneShotWithFallback`

Safety notes:

- The route is protected by `INTERNAL_API_SECRET`.
- Python logs provider/category/character count, not raw prompts.

Observability risk:

- `/internal/ai-complete` accepts no `tenantId` or `userId`.
- Usage rows are system-scoped (`user_id = 0`, no tenant attribution unless the underlying helper defaults tenant to 0).
- Tenant-specific content prompts cannot currently be traced to tenant/user for cost, fallback, or incident review.

## Override And Gate Audit

### Environment Overrides

Supported and active:

- task provider pairs through `AI_*_PRIMARY` and `AI_*_FALLBACK`
- provider model defaults through `OPENAI_MODEL`, `OPENAI_CLASSIFIER_MODEL`, `GEMINI_MODEL`, `GEMINI_CLASSIFIER_MODEL`, `ANTHROPIC_MODEL`, `ANTHROPIC_CLASSIFIER_MODEL`
- provider availability through API key presence
- circuit breaker thresholds through `AI_CB_FAILURE_THRESHOLD`, `AI_CB_COOLDOWN_MS`
- Anthropic runtime through `ANTHROPIC_ENABLED=true`

### Portal/Operator Overrides

Supported and active:

- `/api/domain-routing`
- `/api/domain-routing/toggle`
- `/api/model-config`

`/api/domain-routing/toggle` clears the active provider domain-pair cache after a successful update.

### Anthropic Gate

Anthropic has a hard runtime gate:

- `isAnthropicRuntimeEnabled()` returns true only when `ANTHROPIC_ENABLED === 'true'`.
- `provider-registry` skips Anthropic in normal task-pair construction when disabled.
- `trackedCreate` throws when disabled.
- direct Anthropic domain fallback is allowed only when runtime fallback is enabled.

Risk:

- Domain-specific pair construction uses `getProvider(...)`, which can instantiate an Anthropic provider object without applying the same `getUsableProvider(...)` gate. Calls still fail at `trackedCreate` when disabled, but the pair shape can mislead operators and create avoidable fallback failures.

## Category Tags And Observability

Category tags are primarily for tracking, metering, timeout selection, and dashboards. They are not generally a routing control.

Examples observed:

- `classify_message`
- `gemini_domain_${domain}`
- `openai_domain_${domain}`
- `domain_${domain}`
- `gemini_tool_continuation`
- `openai_tool_continuation`
- `tool_continuation`
- `invoice_filing`
- `content_engine_*`
- `coach_analysis`

Known exception:

- `/api/v1/internal/ai-complete` uses category to choose a longer timeout for some content-engine requests.

What exists:

- `api_usage` rows with `provider`, `model`, `category`, token counts, cost, and duration for many non-streaming calls.
- Provider fallback warnings and Sentry capture.
- In-memory provider/circuit-breaker metrics.
- Portal model/provider dashboards.
- `pushEvent` telemetry for provider calls.

Main observability gaps:

- No single request trace joins Chat request id, tenant, user, domain, task type, category, provider, model, fallback, fallback reason, tool calls, latency, cost, and final message id.
- Fallback events are logged but not persisted as structured rows with tenant-safe correlation.
- Some one-shot, streaming, and Python-proxy calls still lack tenant/user attribution.
- Category naming is inconsistent enough that dashboards can miss usage (`domain_secretary`, `openai_domain_secretary`, `gemini_domain_secretary`, etc.).
- In-memory circuit metrics reset on process restart.

## Prompt And Context Logging Risk

Positive findings:

- Chat route logs message length and routing metadata, not full prompts.
- Python proxy logs provider/category/character count, not prompt text.
- Anthropic hook logs category/model/user id, not prompt text.
- Provider usage rows store counts and metadata, not prompt bodies.

Risks to keep closed:

- Several `logger.warn({ err })` and `logger.error({ err })` statements pass provider SDK error objects. If a provider SDK ever includes request bodies in error metadata, logs could expose prompt/context snippets. This should be redacted defensively.
- Tool results are stringified into model continuation context. The executor truncates to 2000 chars, but privacy still depends on tool authorization and scoped tool results before serialization.

## P0/P1/P2 Findings

| ID | Severity | Finding | Evidence | Release impact |
| --- | --- | --- | --- | --- |
| MRSA-P0-01 | P0 guardrail | Tenant isolation must happen before every provider call. No confirmed immediate routing exploit was found, but several legacy context blocks are user-only and need tenant proof. | `buildSimpleStateContext`, `buildKnowledgePromptBlock(userId)`, training context/profile helpers | Keep as P0 guardrail; do not mark multi-tenant Chat GO until scoped-context tests cover these blocks. |
| MRSA-P1-01 | P1 | OpenAI tool-use path ignores filtered tool lists and exposes full tool catalog to the model. | `src/services/openai-provider.ts:toOpenAITools()`, `callDomain`, `continueWithToolResults` | Must fix before relying on OpenAI as Secretary/tool fallback. |
| MRSA-P1-02 | P1 | OpenAI streaming path bypasses central routing, fallback, circuit breaker, and tenant/user usage attribution. | `OpenAIProvider.streamDomain()` | Must either migrate or explicitly exclude from production Chat release. |
| MRSA-P1-03 | P1 | Python internal AI proxy lacks user/tenant attribution for tenant-specific completions. | `/api/v1/internal/ai-complete`, `content-engine/services/claude_client.py` | Must add attribution or restrict/document as system-only. |
| MRSA-P1-04 | P1 | Domain-specific fallback can instantiate disabled Anthropic providers instead of using the same gate-aware provider selection as task routing. | `provider-fallback` domain pair creation, `provider-registry` gate behavior | Fix to reduce fallback surprises and operator confusion. |
| MRSA-P1-05 | P1 | Legacy user-only context blocks before provider calls are not uniformly tenant-proven. | task todos, coach state, active plan, profile/progression, content knowledge prompt | Needs scoped tests and, where needed, tenant-aware APIs. |
| MRSA-P1-06 | P1 | Invoice vision provider order is inconsistent with the broader Gemini-first architecture. | `analyzeInvoiceImage()` attempts Anthropic first | Decide intended provider order and document or align. |
| MRSA-P2-01 | P2 | OpenAI one-shot helper defaults to `gpt-4o-mini`, bypassing the model-config/operator override stack unless options explicitly pass a model. | `completeOneShot`, `completeVisionOneShot` | Reconcile helpers with model-config or document as fixed utility fallback. |
| MRSA-P2-02 | P2 | Model option drift: `config.openai.model` default and `MODEL_OPTIONS` are not perfectly aligned. | `src/config.ts`, `src/services/model-config.ts` | Portal cannot pin every configured default. |
| MRSA-P2-03 | P2 | Historical names/comments imply Claude or Gemini 3 behavior that is no longer accurate. | `classifyWithClaude`, `claude_client.py`, Gemini comments | Documentation and operator UX drift. |
| MRSA-P2-04 | P2 | Fallback and provider metrics are not durable and not request-correlated. | provider fallback logs, in-memory metrics | Weak incident reconstruction. |
| MRSA-P2-05 | P2 | Provider SDK error logging lacks an explicit prompt/context redaction layer. | provider catch blocks logging `{ err }` | Low current evidence, but sensitive if SDK error shape changes. |

## Recommended Fix Order

1. Make OpenAI `callDomain` and `continueWithToolResults` honor `opts.filteredTools` and `opts.modelTier`.
2. Add a tenant/user-safe AI call trace record that captures request id, tenant id, user id, domain, task type, category, provider, model, fallback, fallback reason, latency, cost estimate, and final message id.
3. Gate domain-specific providers with `getUsableProvider` semantics so disabled Anthropic cannot be selected into a domain pair.
4. Add user/tenant attribution to `/internal/ai-complete`, and make Python callers pass it when prompts are user- or tenant-derived.
5. Audit and harden user-only context blocks in `buildSimpleStateContext`; add tenant-scoped tests for each block that can influence Chat prompts.
6. Decide and align invoice/vision provider order. If Anthropic remains primary for invoice extraction, document it as a deliberate exception.
7. Either migrate `OpenAIProvider.streamDomain` into the provider-agnostic interface or mark it unsupported for production Chat.
8. Add redaction/sanitization around provider SDK error logging.

## Test Recommendations

No tests were run for this documentation-only batch.

Tests to add with the fixes:

- OpenAI tool-use receives only Secretary-filtered tools.
- OpenAI continuation receives the same filtered tool list as the initial call.
- Domain fallback does not attempt Anthropic when `ANTHROPIC_ENABLED` is not true.
- Provider fallback receives the exact same scoped prompt/context as primary.
- `/internal/ai-complete` can record user/tenant attribution and rejects tenant attribution without internal authorization.
- Chat tenant A prompt builder never includes tenant B tasks, memory, content knowledge, training state, or tool results.
- WebSocket tenant selection cannot default to user id when the active tenant is explicit and different.
- Provider SDK errors are logged without prompt/context bodies.
- Vision provider order is deterministic and documented for image classification and invoice parsing.

## Release-Gate Verdict

**PASS WITH CONDITIONS**

Batch 8 can close as an audit deliverable. It should not be interpreted as unconditional production readiness for Chat. Before production Chat release, close or explicitly accept the P1 items in `docs/ai/model-routing-open-blockers.md`, especially OpenAI tool filtering, tenant attribution for internal proxy/streaming, tenant proof for legacy context blocks, and request-correlated provider observability.
