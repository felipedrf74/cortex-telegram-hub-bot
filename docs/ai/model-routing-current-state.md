# Model Routing Current State

Generated: 2026-05-19
Updated: 2026-07-10 (paid-AI cost-control attribution/search addendum)
Original audited branch: `codex/chat-reliability`; current addendum:
`codex/paid-ai-cost-controls`

> **2026-05-26 ADDENDUM — read this first.** The body below describes the
> routing architecture as of 2026-05-19 and is still accurate at the
> framework level. Two material changes have since landed in production
> and are documented at the end of this file under "Phase K (2026-05-26)"
> and "Option 3 (2026-05-26 late)":
> - Phase K: Ollama (35B-A3B) became the cloud-replacement target for
>   pure-text domains (cooking, content, finance). Currently ROLLED BACK
>   on production — see Phase K M-fixes.
> - Option 3: a dedicated small classifier model (qwen2.5:3b) shadow-
>   evaluates against the live Gemini classify path. `AI_CLASSIFY_PRIMARY`
>   stays `gemini` while shadow data accumulates.
>
> The "current effective routing" today is:
> - `classify` → **gemini → openai** (live), plus fire-and-forget Ollama shadow
> - `chat` → gemini → openai
> - `tool-use` → gemini → openai
> - `scriptGeneration` → ollama → none
> - `localReasoning` → ollama → approved_cloud_reasoning
> - `domain` overlays (Phase K rollback): secretary→openai, triathlon/content/finance/cooking→gemini

## Executive Summary

Nexus does not have a fixed production Chat model. The runtime has a configurable provider-routing stack with task-type defaults, domain-level provider routing, provider/model overrides, environment flags, portal/operator controls, circuit breakers, and fallback gates.

Current code defaults are mixed by task fit: classifier and tool-use are Gemini-first, while generic direct chat is OpenAI-first (`gpt-5.4-nano`) with Gemini fallback. Anthropic is reachable only when explicitly configured and enabled. Domain routing then overlays domain-specific provider choices, most notably Secretary on OpenAI by default and non-Secretary skill domains on Gemini by default.

This audit documents the current architecture so future Chat work preserves provider agnosticism instead of hardcoding GPT, Gemini, Claude, or any single provider.

## Live Environment Snapshot

Read-only non-secret grep of staging and production env files on 2026-04-29:

| Environment | Routing keys observed |
| --- | --- |
| Staging | `GEMINI_ROUTING_ENABLED=true`, `GEMINI_DOMAINS=triathlon,content,finance,cooking`, `GEMINI_INCLUDE_SECRETARY=true`, `AI_CHAT_PRIMARY=gemini`, `AI_CHAT_FALLBACK=anthropic`, `AI_TOOL_USE_PRIMARY=gemini`, `AI_TOOL_USE_FALLBACK=anthropic`, `AI_CALL_TIMEOUT_MS=180000` |
| Production | Same values as staging |

Important interpretation:

- `AI_CLASSIFY_PRIMARY` / `AI_CLASSIFY_FALLBACK` were not present, so classifier uses code defaults: Gemini -> OpenAI.
- `ANTHROPIC_ENABLED` was not present in the non-secret grep output. With the current gate, Anthropic is skipped unless explicitly set to `true`.
- Therefore, even though live chat/tool-use env asks for `anthropic` fallback, the effective fallback is expected to resolve to the next usable provider, typically OpenAI, when Anthropic is gated off.
- This env shape reinforces the main rule: do not infer live runtime from code defaults alone; provider availability and gates affect the effective pair.

## Primary Routing Layers

1. `src/config.ts`
   - Defines task-type routing defaults for `classify`, `chat`, and `toolUse`.
   - Defaults:
     - classify: `gemini -> openai`
    - chat: `openai -> gemini`
     - toolUse: `gemini -> openai`
   - Environment overrides:
     - `AI_CLASSIFY_PRIMARY`, `AI_CLASSIFY_FALLBACK`
     - `AI_CHAT_PRIMARY`, `AI_CHAT_FALLBACK`
     - `AI_TOOL_USE_PRIMARY`, `AI_TOOL_USE_FALLBACK`
     - `AI_CB_FAILURE_THRESHOLD`, `AI_CB_COOLDOWN_MS`

2. `src/services/provider-registry.ts`
   - Lazily instantiates providers.
   - Skips Gemini/OpenAI if API keys are missing.
   - Skips Anthropic unless `ANTHROPIC_ENABLED=true`.
   - Builds the active `TaskRoutingProvider`.
   - Falls back to the first usable provider from the configured primary/fallback and the built-in candidate order.

3. `src/services/provider-fallback.ts`
   - Routes by task type.
   - Applies circuit breakers per provider.
   - Falls back only for retryable failures such as 429, 5xx, network timeouts, and overload errors.
   - Does not fall back for non-retryable 4xx errors except 429.
   - Resolves domain-specific provider pairs for `callDomain` and tool continuations.

4. `src/services/domain-provider-router.ts`
   - Defines skill-domain provider routing.
   - Defaults:
     - Secretary: OpenAI primary, Gemini fallback
     - Triathlon/Training: Gemini primary, OpenAI fallback
     - Content: Gemini primary, OpenAI fallback
     - Finance: Gemini primary, OpenAI fallback
     - Cooking: Gemini primary, OpenAI fallback
   - Feature flags and persisted operator settings can disable Gemini routing or narrow allowed Gemini domains.

5. `src/services/model-config.ts`
   - Provides runtime model overrides by provider tier and by domain.
   - Override resolution:
     - domain override
     - provider-tier override
     - `config.ts` default
   - Persists overrides in `kv_store` as `model_override:${provider}:${role}`.

6. `src/services/model-pricing.ts`
   - Central source of truth for provider/model input, output, cache-read, cache-write, and Batch discount prices.
   - Provider usage logging, the internal Python usage report endpoint, Chat action planner estimates, bake-off reports, and cost scenarios read from this registry.
   - Unknown production model names are not silently priced as another model. They are recorded as unresolved rows, charged at the Sonnet-4.6 sentinel ceiling rate, and alert ops until pricing is added.

7. `src/services/ai-provider.ts`
   - Defines the provider-agnostic interface.
   - Resolves model tier for domain calls.
   - Secretary uses chat-tier models by default.
   - Other domain calls default to classifier-tier models unless explicitly overridden.

## Current Default Provider Cascade

The effective default cascade depends on route type and whether the domain provider differs from the task-type primary.

| Route | Default cascade | Notes |
| --- | --- | --- |
| Task `classify` | Gemini -> OpenAI | Main Chat classifier uses a one-shot Gemini/OpenAI/Anthropic-gated wrapper rather than `TaskRoutingProvider.classify`. |
| Task `chat` | Code default: OpenAI -> Gemini. Live env may still request Gemini -> Anthropic, but Anthropic is skipped unless enabled, so effective fallback should resolve to another usable provider when configured. | Used for non-tool domain calls unless a domain-specific primary differs. |
| Task `toolUse` | Code default: Gemini -> OpenAI. Live env may still request Gemini -> Anthropic, with the same Anthropic-gate caveat. | Used for Secretary and Triathlon/Training task type unless domain routing overrides it. |
| Secretary domain | OpenAI -> Gemini | Domain primary differs from task primary, so the domain-specific pair is used. |
| Triathlon/Training domain | Gemini -> OpenAI | Domain routing keeps Training Gemini-first while preserving OpenAI fallback. |
| Content/Finance/Cooking domains | Gemini -> OpenAI | Domain routing keeps these baseline domains Gemini-first despite generic chat defaulting to OpenAI. |
| One-shot helpers | Gemini -> OpenAI -> Anthropic gated | Uses `completeOneShotWithFallback`; Anthropic thunk executes only if enabled. |
| Vision helper | Gemini -> OpenAI -> Anthropic gated | Uses `completeVisionOneShotWithFallback` for most image paths. |
| Interactive web-grounded Content/research | Enforced: OpenAI one-call low-context -> Gemini -> Anthropic gated. Observe-only: Gemini -> OpenAI -> Anthropic gated. | Builds a public-query-only packet first. Budget/metering failures are terminal for that request and never advance to another paid provider; only provider availability/quality failures advance the chain. |
| Scheduled Content trend context | Fresh Discovery/Radar signals -> validated evergreen generation | Enforcement never uses provider-hosted search in automation because retrieved context has no contractual token ceiling. |
| Python content engine | TS proxy Gemini -> OpenAI -> Anthropic gated | Python no longer calls provider APIs directly for ordinary completions. |

## Routing By Task Type

### classify

Config defaults live in `config.providerRouting.classify`. The main Chat classifier path is `src/router/classifier.ts -> src/services/anthropic.ts:classifyMessage`, despite the historical `classifyWithClaude` name.

Actual classifier behavior:

- Gemini one-shot first using `config.gemini.classifierModel`.
- OpenAI fallback via `completeOneShotWithFallback`.
- Anthropic fallback only through the supplied thunk and only if `ANTHROPIC_ENABLED=true`.
- Category tag: `classify_message`.
- Active conversation context is included in the classifier input for multi-turn continuity.

### chat

Generic non-tool domain calls use the active `TaskRoutingProvider` and `resolveTaskType(domain)`. Domains other than Secretary and Triathlon/Training resolve to `chat`.

Default task cascade: OpenAI -> Gemini. Domain-specific routing keeps Content/Finance/Cooking on Gemini-first baselines unless an operator or experiment override changes them. Unrouted or dynamic Chat domains now fall back to the task-level `providerRouting.chat` pair instead of inheriting a hardcoded domain route.

### toolUse

Secretary and Triathlon/Training resolve to `tool-use`.

Default task cascade: Gemini -> OpenAI, but Secretary has a domain-specific OpenAI -> Gemini pair. Triathlon keeps the Gemini -> OpenAI default unless an operator override changes it. `TaskRoutingProvider` computes Secretary optimization once, before provider selection, and passes filtered tools/model tier/history slicing to whichever provider executes.

### tool continuation

Tool continuations go through the same `TaskRoutingProvider` path as the initial call. The same optimization shape is recomputed from the same current message so the provider sees a stable tool list, model tier, and sliced history.

Current branch note: this audited branch contains an unmerged provider-fallback fix that passes the resolved domain provider pair into `executeWithFallback`. Without that fix, a domain-specific pair could be resolved and then discarded during `callDomain` or `continueWithToolResults`.

### vision/image

Image classification uses `classifyAndExtractImage`:

- JPEG/PNG/WebP: Gemini vision -> OpenAI vision -> Anthropic gated fallback.
- GIF: Anthropic direct fallback path because Gemini does not support GIF in this code path.

Invoice analysis in `src/services/invoice-filer.ts` is an exception: it currently attempts Anthropic first, then falls back to the Gemini/OpenAI/Anthropic-gated vision helper on failure. That behavior conflicts with nearby comments that describe Gemini-first vision.

## Operator Override Layers

| Layer | Surface | Persistence | Effect |
| --- | --- | --- | --- |
| Environment task routing | `AI_*_PRIMARY`, `AI_*_FALLBACK` | process env | Changes task provider pairs at startup. |
| Environment domain routing | `GEMINI_ROUTING_ENABLED`, `GEMINI_INCLUDE_SECRETARY`, `GEMINI_DOMAINS` | process env | Changes domain provider routing at startup. |
| Anthropic gate | `ANTHROPIC_ENABLED=true` | process env | Required before any Anthropic runtime call can execute. |
| Model names | `OPENAI_MODEL`, `OPENAI_CLASSIFIER_MODEL`, `GEMINI_MODEL`, `GEMINI_CLASSIFIER_MODEL`, `ANTHROPIC_MODEL`, `ANTHROPIC_CLASSIFIER_MODEL` | process env | Sets provider model defaults. |
| Portal domain routing | `/api/domain-routing/toggle` | `kv_store` | Runtime domain routing changes; clears active provider domain-pair cache. |
| Portal model config | `/api/model-config` | `kv_store` | Runtime provider-tier/domain model override. |

## Anthropic Gating Behavior

Anthropic is not simply another always-available fallback. It has a hard runtime gate:

- `isAnthropicRuntimeEnabled()` returns true only when `ANTHROPIC_ENABLED === 'true'`.
- `provider-registry` skips Anthropic when the gate is false.
- `anthropic-hook.trackedCreate` hard-throws when the gate is false.
- Direct Anthropic fallback in domain handling is only allowed when `canUseAnthropicRuntimeFallback()` is true, which requires both `ANTHROPIC_ENABLED=true` and an API key.

This protects cost and prevents hidden Claude fallback usage; shared lazy-client call sites now fail closed before constructing an SDK client when the runtime is disabled or no key is configured.

## Category Tags

Category tags are mostly for cost tracking, usage metering, dashboards, timeout selection, and telemetry. They do not generally choose providers.

Examples:

- `classify_message`
- `gemini_domain_secretary`
- `openai_domain_content`
- `domain_secretary`
- `tool_continuation`
- `gemini_tool_continuation`
- `content_chat_refine`
- `coach_analysis`
- `content_engine_script`
- `invoice_filing`

Known exceptions:

- `/api/v1/internal/ai-complete` uses the category to choose a longer timeout for some `content_engine*` requests.
- OpenAI fallback wrappers may suffix categories with `_openai_fallback` for metering.

## Chat Reasoning And Memory Impact

The routing architecture preserves conversation continuity by passing:

- active conversation context into classification
- domain conversation history into domain calls
- current state context into the current user message
- tool conversation state into continuation calls

Quality risks remain:

- Provider fallback can switch model families mid-request or mid-tool-loop. The same context is passed, but providers differ in tool-call behavior and schema tolerance.
- Some direct one-shot helpers do not carry full Chat history. That is acceptable for focused tasks but should not be used as a substitute for multi-turn Chat domain handling.
- `AIProvider.callDomain` and `continueWithToolResults` do not currently accept tenant ID, and provider usage logging is inconsistent about user ID. This does not by itself leak prompt context, but it weakens auditability and future tenant-aware cost controls.

Current chat-reliability branch coverage:

- iOS REST Chat (`src/api/routes/chat-message-routes.ts`) infers a chat turn contract before domain execution and uses it for route hints, destructive/high-risk guardrails, selective internet research, and local-and-web context assembly.
- WebSocket Chat (`src/api/websocket.ts`) now runs the same contract/orchestration layer before streaming a domain response. Selective internet research streams a deterministic answer and destructive turns are refused before handler execution.
- Telegram inbound Chat has been retired. `src/bot.ts` remains a legacy outbound-only factory for safe-send compatibility and does not register commands, message handlers, callback queries, polling, or webhooks.
- Domain handler context inclusion still uses the contract only to decide whether scoped state is required. The full response contract is assembled at the API/chat surface.

## Internal AI Completion And Python Content Engine

The Python content engine module `content-engine/services/claude_client.py` is now a compatibility wrapper. It calls the TypeScript backend endpoint:

- `POST /api/v1/internal/ai-complete`

The TypeScript proxy then uses `completeOneShotWithFallback`, so provider routing is Gemini -> OpenAI -> Anthropic gated. Python no longer needs provider API keys for ordinary completions.

The proxy is protected by `INTERNAL_API_SECRET` and rate limiting. Usage is recorded as system-level `user_id=0`, with no tenant ID.

## Call Sites That Bypass The Central Task Router

These paths still have provider-aware fallback behavior, but they do not use `TaskRoutingProvider`:

- Chat classifier: `classifyMessage` uses `completeOneShotWithFallback`.
- Content refinement shortcut: `content_chat_refine` uses `completeOneShotWithFallback`.
- Garmin coach briefing: `coach_analysis` uses `completeOneShotWithFallback`.
- Channel learner/video study/content workflow/autoresearch/voice evolution one-shots use `completeOneShotWithFallback`.
- Image classification uses `completeVisionOneShotWithFallback`.
- Python content engine uses `/internal/ai-complete`, then `completeOneShotWithFallback`.
- Interactive Content discovery/research-refresh and ChatV2 internet research use one-call, low-context OpenAI web search first while paid-AI enforcement is active. They compare Gemini and the gated Anthropic fallback only after non-budget provider failures. Observe-only keeps Gemini first for quality comparison.
- Scheduled Content never uses provider-hosted search under enforcement; it reuses fresh tenant-scoped Discovery/Radar signals or produces explicitly evergreen output. Raw Nexus calendar/task/finance/health/email context is denied before any interactive web provider selection.
- Legacy direct Anthropic domain calls remain available as a guarded safety path when the active routing provider cannot initialize.
- The unused OpenAI-only streaming extension was removed; model-backed runtime paths stay on provider routing abstractions.

## Vestigial Or Misleading Names And Constants

- `classifyWithClaude` is a historical name; it now routes through Gemini/OpenAI/Anthropic-gated fallback.
- `content-engine/services/claude_client.py` is a compatibility filename; it calls the TS provider proxy.
- Historical Domain-router comments used to mention `Gemini 3 Flash`; current executable defaults are `gemini-2.5-flash`, `gemini-2.5-flash-lite`, and `gpt-5.4-nano`.
- `GEMINI_INCLUDE_SECRETARY` is semantically misleading. In current code, true keeps Secretary on OpenAI; false sends Secretary toward Anthropic as an emergency path.
- `MODEL_OPTIONS.openai.chat` and classifier options now expose `gpt-5.4-nano`; keep this list in sync with `src/config.ts`.
- Portal `/api/model-intelligence` hardcodes copy saying Secretary is currently on GPT-5.4 nano and queries `category = 'secretary'`, but actual category names include provider/domain variants such as `openai_domain_secretary` and `domain_secretary`.

## Observability

What exists:

- Provider fallback warnings with task type and provider pair.
- Sentry-visible warning capture on fallback.
- Circuit breaker state and in-memory provider metrics.
- Portal `/api/provider-stats` and `/api/model-intelligence` surfaces.
- `api_usage` rows with category, provider, model, token/cache counts, complete
  token-plus-hosted-tool cost, duration, user/tenant ID, request source, job,
  base workload category, and run ID.
- Telemetry events for provider calls.
- Chat responses can persist `chatTurnContract`, `contextCompiler`, route kind, grounding, risk, and research metadata.
- `cacheablePrefixHash` is emitted by the context compiler for prompt-cache observability and future cache-key validation.

Gaps:

- Provider helpers still require every caller to pass the authenticated
  user/tenant scope; the provider boundary fails closed under enforcement when
  no live matching reservation exists, but source review remains necessary for
  newly added call sites.
- Streaming is OpenAI-only and not represented in the central task-routing fallback layer.
- There is no single request trace joining Chat request ID, provider choice, model, fallback path, tool calls, cost, latency, tenant, and final response.
- `cacheablePrefixHash` is not consumed by Gemini/OpenAI SDK calls yet, so prompt-caching savings remain theoretical until provider-specific cache primitives are wired and measured.
- Bilingual fixture token ceilings are enforced by eval/bake-off tests, not by live prompt compilation.

## Security And Tenant Notes

The routing layer does not enforce tenant isolation; tenant isolation must be enforced before prompt construction, tool execution, memory retrieval, and persistence.

Current rules for future Chat work:

- Provider calls must carry the authenticated user/tenant scope and execute
  inside the matching canonical reservation.
- Internal AI proxy calls that originate from an authenticated Content route
  use a short-lived signed attribution token. Invalid, expired, or
  category-mismatched re-entry fails closed instead of falling back to system
  billing; intentional unsigned internal jobs remain system-scoped.
- Provider fallback must receive exactly the same already-scoped context as the primary provider. It must never rebuild broader context during fallback.

## Required Rule For Future Chat Work

Future Chat changes must preserve these properties:

- Do not hardcode a provider or model globally.
- Route ordinary Chat/domain calls through the active routing provider unless there is a documented reason not to.
- Preserve portal/operator overrides.
- Preserve Anthropic gating.
- Keep category tags accurate, but do not treat category tags as routing controls.
- Pass tenant/user scope into context retrieval and persistence before any model call.
- Add observability for provider/model/fallback without logging sensitive prompt content.


---

# Phase K (2026-05-26) — Ollama as response source for pure-text domains

After Codex angry-QA rounds 5–9, Phase K shipped to production with `AI_DOMAIN_PROVIDER_OVERRIDES=cooking=ollama,content=ollama,finance=ollama` flipping the three pure-text domain handlers to run on the local 35B-A3B model.

**Status (2026-05-26):** ROLLED BACK. Codex M-fix series found that the 35B model on this CPU could not consistently produce non-truncated responses for cooking/content within the `CHAT_DOMAIN_HANDLER_TIMEOUT_MS=40000` window, causing fallback churn. Production reverted to `cooking/content/finance → gemini` via env removal of the AI_DOMAIN_PROVIDER_OVERRIDES line. The hard-blocks (Phase K Step 2 + 2b in `domain-provider-router.normalizeDomainProviderOverrides` and `provider-fallback.shouldBypassOllamaForToolOrWrite`) remain in place — they prevent secretary/triathlon from ever routing to Ollama even if env override re-enabled.

Phase K-related quality-gate enhancements (`CREATIVE_TEXT_OWNERS = cooking + content`, side-effect-verb blocklist) remain in `chat-response-quality-gate.ts` and ARE still active — they catch creative narratives like "Criei uma receita de kibe..." for the answer-only domains without false-positive flagging.

# Option 3 (2026-05-26 late) — dedicated small classifier on Ollama

The Phase K rollback exposed a separate problem: classify-via-Ollama-on-35B took 50–60s wall-clock per call when `AI_CLASSIFY_PRIMARY=ollama` was set (the prompt is ~1032 tokens; 35B on this CPU at that prompt size is slow). Codex flagged as F-new-5. Option 3 fixes the architecture: a dedicated small classifier model (`qwen2.5:3b-instruct-q4_K_M`, 1.9 GB) replaces the 35B for classify. The 35B stays loaded for script-generation and local-reasoning paths (not user-blocking).

**Status (2026-05-26 23:04 UTC):** Shadow-eval enabled on production. Live classify stays on Gemini. Every Gemini classify call also fires (fire-and-forget) an Ollama classify call; the comparison goes to a new `classify_shadow_runs` table. Cutover from Gemini → Ollama is gated on:
1. ≥50 real shadow rows accumulated
2. Operator manual review of every disagreement (Gemini is baseline NOT ground truth per O3-A24)
3. Effective agree ≥90%, tool-domain (secretary/triathlon) recall ≥95%, p95 latency ≤3000ms

Architectural details in `docs/runbooks/ollama-local-llm.md#option-3---dedicated-small-classifier-2026-05-26-late-evening` and `docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md#option-3---dedicated-small-ollama-classifier-model-2026-05-26-late`.

The compact <400-token classifier prompt is in `services/anthropic.getOllamaClassifierSystemPromptCompact()`, versioned by `OLLAMA_CLASSIFIER_PROMPT_VERSION=v1`. Future iterations bump the version without changing source.

Privacy: message bodies are NEVER stored. `classify_shadow_runs.message_hash` is HMAC-SHA256 keyed by `CLASSIFY_SHADOW_HASH_SECRET` (generate-once at deploy time per O3-A20; rotation is a deliberate operator action documented in the runbook).
