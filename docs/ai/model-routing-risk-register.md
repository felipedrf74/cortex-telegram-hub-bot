# Model Routing Risk Register

Generated: 2026-04-29 02:05 WEST

## Risk Summary

| ID | Severity | Area | Risk | Status | Recommended action |
| --- | --- | --- | --- | --- | --- |
| MR-P0-01 | P0 | Tenant security | Future Chat model calls could retrieve or send cross-tenant context if tenant ID is not threaded through context retrieval before provider calls. | Open guardrail | Treat tenant scoping as mandatory for Chat/memory/tool changes. Do not rely on provider/model behavior for isolation. |
| MR-P1-01 | P1 | Observability | `api_usage` lacked `tenant_id`, so provider/model/cost/fallback audit could not be tenant-scoped. | Closed for migration shape | Migration `084` adds `tenant_id` and staging-clone proof passed; live deployment still requires production snapshot. |
| MR-P1-02 | P1 | Usage attribution | Gemini/OpenAI domain calls and tool continuations often logged `user_id=0` because `AIProvider.callDomain` had no user/tenant options. | Partially closed | Domain provider calls now accept optional user/tenant metadata; streaming/off-domain one-shot attribution still needs wider audit. |
| MR-P1-03 | P1 | Streaming | `OpenAIProvider.streamDomain` is OpenAI-only and not covered by central task routing, circuit breaker, or provider fallback. | Open | Either route streaming through a provider-agnostic interface or document it as OpenAI-only experimental/off-path. |
| MR-P1-04 | P1 | Model overrides | Portal `/api/model-config` could accept a provider/role pair with a model value outside `MODEL_OPTIONS`. | Closed 2026-04-29 | Route now validates submitted model against the provider role-tier option list; `__tests__/portal/portal-provider-routes.test.ts` covers invalid model rejection and wrong-tier rejection. |
| MR-P1-05 | P1 | Vision routing | `invoice-filer.ts` attempts Anthropic first, despite comments and broader architecture saying Gemini-first vision. | Open | Decide intended primary; if Gemini-first, reorder the path and test provider fallback. |
| MR-P1-06 | P1 | Direct bypass | Legacy direct Anthropic `callDomain` paths and some web-search/content paths bypass `TaskRoutingProvider`. | Open | Inventory each bypass and either migrate or explicitly mark as exceptional with tests. |
| MR-P1-07 | P1 | Internal proxy attribution | `/api/v1/internal/ai-complete` records usage as `user_id=0` and no tenant ID. | Open | Add optional user/tenant attribution for user-specific internal completions. Keep system-only content jobs explicit. |
| MR-P1-08 | P1 | Env/operator clarity | Live chat/tool-use env asks for Anthropic fallback while Anthropic appears gated off, so effective fallback depends on provider-registry skip behavior rather than obvious env intent. | Open | Either align env fallback to OpenAI while Anthropic is disabled or document the intentional gated fallback pattern in ops runbooks. |
| MR-P2-01 | P2 | Documentation/code drift | Comments and historical names still say Claude/Gemini 3/Anthropic fallback in places where runtime behavior is different. | Open | Clean comments after routing behavior is locked. |
| MR-P2-02 | P2 | Model registry drift | `config.ts` OpenAI defaults include `gpt-5.4-nano`, but `MODEL_OPTIONS.openai.chat` omits it. | Open | Reconcile defaults with portal options. |
| MR-P2-03 | P2 | Domain fallback nuance | Domain fallback map says non-Secretary domains fall back to Anthropic, but default task pair makes them Gemini -> OpenAI when domain primary equals task primary. | Open | Make documentation and/or code explicit so operators do not assume Anthropic fallback. |
| MR-P2-04 | P2 | Cost dashboard copy | Portal model intelligence hardcodes Secretary GPT-5.4 nano copy and queries `category='secretary'`, which may not match actual routed category names. | Open | Update dashboard queries/copy to use provider/domain category patterns. |
| MR-P2-05 | P2 | Circuit breaker durability | Circuit state and provider metrics are in-memory and reset on restart. | Accepted for now | Production monitoring should account for restart resets. |
| MR-P2-06 | P2 | Fallback context quality | Provider fallback can switch providers mid-request; context is preserved, but provider-specific tool semantics may differ. | Open | Add day-to-day simulations that force fallback during tool calls. |

## P0 Notes

No immediate routing-code P0 was found that required changing code in this prompt. The tenant risk remains P0 as a design guardrail for future Chat work: provider routing must never compensate for weak tenant scoping. Tenant and user boundaries belong in backend data access, retrieval namespaces, tool authorization, and persistence.

## Key Evidence

- `src/config.ts` defines Gemini-first task defaults with OpenAI fallback.
- `src/services/runtime-flags.ts` gates Anthropic with `ANTHROPIC_ENABLED`.
- `src/services/provider-registry.ts` skips Anthropic unless enabled and skips Gemini/OpenAI if unconfigured.
- `src/services/provider-fallback.ts` contains task routing, circuit breakers, retryability checks, domain-pair resolution, and provider-agnostic Secretary optimization.
- `src/services/domain-provider-router.ts` defines domain provider choices and persisted routing flags.
- `src/services/model-config.ts` defines provider-tier and domain model overrides.
- `src/portal/provider-routes.ts` exposes domain/model override controls and clears domain-pair cache on domain-routing changes.
- `src/services/gemini-provider.ts` and `src/services/openai-provider.ts` implement provider adapters and usage logging.
- `src/api/routes/internal.ts` routes Python content-engine AI calls through TypeScript provider fallback.

## Release Copy Guardrails

Do not claim:

- Nexus Chat is GPT-only.
- Nexus Chat is Claude-only.
- Nexus Chat is Gemini-only.
- category tags control routing.
- Anthropic fallback is always available.
- Secretary is always on GPT unless runtime config and portal state prove it.

Supported claim:

> Nexus Chat uses a configurable provider-routing architecture with task-type routing, domain routing, operator model overrides, circuit breakers, and gated provider fallback.

## Testing Gaps To Close In Future Chat Work

- Provider fallback during long multi-turn Chat.
- Provider fallback during tool continuation.
- Streaming route provider safety.
- Tenant-aware provider usage logging for remaining streaming/off-domain one-shot paths.
- Portal invalid model rejection. Closed 2026-04-29 by route validation and focused portal-route tests.
- Domain routing toggle smoke with live cache invalidation.
- One-shot helper attribution with user/tenant IDs.
- Invoice vision routing primary-provider expectation.
