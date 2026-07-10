# Model Routing Fixes

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Backup created: `backup/model-routing-before-observability-20260429-1428` and tag `backup-model-routing-before-observability-20260429-1428`
Scope: live model-routing observability and safety, without forcing a fixed provider

## Summary

This batch improves routing observability and safety while preserving Nexus's live provider-routing architecture. No provider was made global or fixed. Gemini, OpenAI, Anthropic gating, domain routing, task routing, and operator overrides remain configurable.

Release-gate verdict: **PASS WITH CONDITIONS**.

The implemented changes close the highest-risk OpenAI tool-minimization issue from the audit and add tenant-safe routing telemetry. Remaining production concerns are listed below.

## Implementation Notes

### Tenant-Safe Routing Metadata

Updated `src/services/provider-fallback.ts` to attach structured, prompt-safe metadata to provider attempts and fallback events:

- task type: `classify`, `chat`, `tool-use`
- call kind: `classify`, `domain`, `tool-continuation`
- category tag: `classify_message`, `domain_<domain>`, `tool_continuation`
- domain
- provider
- model tier when available
- user id and tenant id when supplied
- tenant/user scope presence flags
- request id and request source from AsyncLocalStorage
- provider pair source: `task_default`, `domain_override`, `domain_cache`
- operator override visibility
- prompt length, state-context length, history count, and tool-continuation turn count

Important privacy behavior: the metadata intentionally records lengths and routing facts, not raw prompts, raw state context, raw tool results, or conversation text.

### Fallback Reason Logging

Fallback events now carry a reason code:

- `rate_limited`
- `provider_server_error`
- `network_timeout`
- `network_unavailable`
- `provider_overloaded`
- `circuit_open`
- `unknown_retryable`

Provider errors are summarized into safe fields:

- error name
- status
- code
- retryability
- reason

The default fallback handler in `src/services/provider-registry.ts` no longer logs raw error messages or stacks into the normal fallback warning/Sentry context.

### Context Safety Before Fallback

The fallback path still sends the exact same already-built context to the fallback provider. This batch adds observability around that behavior:

- fallback events preserve the same domain/category/model-tier metadata as the primary attempt
- tenant/user scope flags are recorded before provider execution
- a warning is emitted when a routed model call has a user id but no tenant id

This does not replace backend authorization. Tenant isolation still belongs in route authorization, context retrieval, memory/retrieval namespaces, tool authorization, and prompt construction.

### Operator Override Visibility

Domain pair resolution now records whether a call used:

- task default routing
- domain override routing
- cached domain override routing

This makes portal/operator routing changes visible in request-level logs without exposing private prompt content.

### Runaway Provider Call Detection

`TaskRoutingProvider` now counts provider attempts per request id and emits a prompt-safe warning when the count exceeds:

- `AI_PROVIDER_RUNAWAY_CALL_THRESHOLD`, if set
- default: `12`

The warning includes request id, provider, task type, category, domain, user/tenant scope markers, attempt count, and threshold. It does not include prompt text.

### OpenAI Tool Filtering

Updated `src/services/openai-provider.ts` so OpenAI domain calls and tool continuations honor the routing layer's `filteredTools`.

Before:

- OpenAI received the full `TOOLS` catalog for Secretary/Triathlon calls.

After:

- OpenAI receives only `opts.filteredTools` when provided.
- If routing intentionally filters to an empty list, no tools are sent.
- The behavior now matches the provider-agnostic intent already used by Gemini and Anthropic.

This preserves live routing while reducing the chance that OpenAI primary/fallback receives tools the routing layer intentionally excluded.

## Files Changed

- `src/services/provider-fallback.ts`
- `src/services/provider-registry.ts`
- `src/services/openai-provider.ts`
- `__tests__/services/model-routing-observability.test.ts`
- `__tests__/services/openai-provider.test.ts`
- `docs/ai/model-routing-fixes.md`
- `docs/ai/model-routing-test-results.md`

## Closed Or Improved Items

| Item | Status | Evidence |
| --- | --- | --- |
| OpenAI tool-use path ignores filtered tools | Fixed | `openai-provider.test.ts` now covers filtered tool calls and empty filtered tool lists. |
| Missing fallback reason logging | Improved | `FallbackEvent` includes `fallbackReason` and safe `errorSummary`. |
| Operator override visibility | Improved | routing metadata includes `pairSource` and `operatorOverrideApplied`. |
| Tenant-safe model call metadata | Improved | metadata includes user/tenant ids when available and scope presence flags. |
| Raw prompt leakage in fallback logs | Improved | provider-fallback and default fallback handler use sanitized error summaries and prompt lengths only. |
| Context safety before fallback | Improved | fallback path preserves scoped context and emits metadata/test coverage around category, tenant, user, and model tier. |
| Runaway provider call detection | Added | per-request attempt counter warns after threshold. |

## Remaining Open Blockers

| Severity | Item | Why it remains open |
| --- | --- | --- |
| P1 | Python `/api/v1/internal/ai-complete` lacks user/tenant attribution | This batch focused on routed provider calls. Python proxy scope needs a small API contract update and content-engine caller changes. |
| Resolved | OpenAI native streaming was off-path | The unused `OpenAIProvider.streamDomain()` extension was removed; model-backed runtime paths remain on provider routing abstractions. |
| P1 | Legacy user-only context blocks still need tenant proof | This batch adds detection and metadata, but does not audit every underlying store/helper. |
| P1 | Domain-specific fallback still needs gate-aware provider selection | This batch improves visibility; the provider-registry/domain-pair selection should still be made Anthropic-gate aware. |
| P1 | Invoice vision provider-order drift remains | This batch did not change invoice parsing behavior. |
| P2 | Concrete model name is still logged by concrete providers, not the routing layer | The routing layer records provider and model tier. Concrete adapters continue to persist actual model names in `api_usage`. A unified AI-call trace would join both. |

## Safety Notes

- No model/provider was hardcoded as the Nexus runtime default.
- No production/staging deployment was performed.
- No provider calls were made by the tests.
- No raw prompt text is added to new routing logs.
- The fallback callback receives a sanitized error object for `TaskRoutingProvider` fallback events.

## Release Recommendation

This batch is suitable to carry forward into the Chat release candidate as a safety/observability improvement.

Before unconditional production Chat release, finish the remaining P1 items above or explicitly scope them out in the release candidate risk register.
