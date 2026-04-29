# Model Routing Skill Matrix

Generated: 2026-04-29 02:05 WEST

## Summary Matrix

Live env note: staging and production currently set `AI_CHAT_FALLBACK=anthropic` and `AI_TOOL_USE_FALLBACK=anthropic`, while `ANTHROPIC_ENABLED` was not present in the non-secret env grep. The provider registry skips Anthropic when gated off, so effective fallback should resolve to the next usable provider, typically OpenAI. Classifier-specific env vars were not present, so classifier uses code defaults.

| Area | Primary path | Default provider behavior | Model selection | Notes |
| --- | --- | --- | --- | --- |
| Chat classifier | `router/classifier.ts -> classifyMessage` | Gemini -> OpenAI -> Anthropic gated | Gemini classifier by explicit option; fallback provider defaults | Historical function names still say Claude. |
| General Chat domain handling | `domains/domain-handler.ts` | Active `TaskRoutingProvider` | `getModelRouting` plus model-config overrides | Persists conversation after final domain response. |
| Secretary | `domains/secretary.ts` | OpenAI -> Gemini through domain-specific pair | Chat tier by default | Direct Anthropic fallback only if routing provider unavailable and Anthropic gate enabled. |
| Training/Triathlon | `domains/domain-handler.ts`, legacy `services/plan-generator.ts` | Gemini -> OpenAI in default task state | Classifier tier unless overridden; Anthropic direct path in legacy generator | Training context is injected into Anthropic direct call path and provider-backed domain calls through shared context. |
| Content Creation | Chat domain, shortcuts, content engine | Gemini -> OpenAI for Chat; Gemini Search -> Anthropic gated for discovery; TS proxy for Python engine | Classifier tier for domain calls unless overridden | Content shortcuts can bypass domain routing for deterministic REST responses. |
| Finance | Chat domain, image/invoice tools | Gemini -> OpenAI for domain; vision paths vary | Classifier tier unless overridden | Invoice analysis currently tries Anthropic first before fallback helper. |
| Cooking | Chat domain | Gemini -> OpenAI in default task state | Classifier tier unless overridden | No cooking-specific provider override found beyond domain provider router. |
| Tool continuations | `TaskRoutingProvider.continueWithToolResults` | Same resolved pair as initial domain call | Same optimization decision recomputed | Critical for stable tools/history across providers. |
| Vision/image classification | `classifyAndExtractImage` | Gemini vision -> OpenAI vision -> Anthropic gated; GIF direct Anthropic | Vision helper options | Provider fallback does not use task router. |
| Python content engine | `/api/v1/internal/ai-complete` | Gemini -> OpenAI -> Anthropic gated | One-shot helper options | `claude_client.py` name is compatibility-only. |
| Streaming | `OpenAIProvider.streamDomain` | OpenAI-only | OpenAI model | Not part of central fallback/circuit breaker layer. |

## Task Type Matrix

| Task type | Resolving function | Default primary | Default fallback | Anthropic path |
| --- | --- | --- | --- | --- |
| classify | `config.providerRouting.classify`; main Chat uses one-shot wrapper | Gemini | OpenAI | Only if thunk supplied and `ANTHROPIC_ENABLED=true`. |
| chat | `resolveTaskType(domain)` for non-tool domains | Gemini | OpenAI | Only if env/operator routing points to Anthropic and gate is enabled, or via guarded direct fallback. |
| tool-use | `resolveTaskType(secretary|triathlon)` | Gemini | OpenAI | Same as chat; Secretary domain overrides to OpenAI -> Gemini. |
| tool continuation | Same as initial domain call | Same resolved pair as initial route | Same resolved pair fallback | Same constraints as initial call. |
| vision/image | Vision helper, not task router | Gemini for common images | OpenAI | Anthropic gated fallback; GIF may go direct Anthropic. |

## Domain Matrix

| Domain | Task type | Domain provider router default | Effective default cascade | Model tier default | Important caveat |
| --- | --- | --- | --- | --- | --- |
| Secretary | tool-use | OpenAI primary, Gemini fallback | OpenAI -> Gemini | Chat tier | `GEMINI_INCLUDE_SECRETARY=true` means keep Secretary on OpenAI, despite the flag name. |
| Triathlon/Training | tool-use | Gemini primary, Anthropic fallback map | Gemini -> OpenAI | Classifier tier | Domain fallback map is not used when domain primary equals task primary. |
| Content | chat | Gemini primary, Anthropic fallback map | Gemini -> OpenAI | Classifier tier | Content discovery and content-engine have separate one-shot/proxy paths. |
| Finance | chat | Gemini primary, Anthropic fallback map | Gemini -> OpenAI | Classifier tier | Invoice vision path does not follow this domain matrix. |
| Cooking | chat | Gemini primary, Anthropic fallback map | Gemini -> OpenAI | Classifier tier | Domain-level model override still available. |

## Skill Call Site Notes

### Secretary

- Primary rich Chat path: `src/domains/secretary.ts`.
- Uses `getActiveProvider() || ensureActiveProvider()`.
- Stores conversation history after response.
- Uses direct Anthropic fallback only as an initialization failure safety path.
- Provider/tool comments are stale in a few places and still describe Gemini/Anthropic behavior that does not exactly match current defaults.

### Training/Triathlon

- Domain Chat path is provider-routed.
- `resolveTaskType('triathlon')` maps to `tool-use`.
- Default provider cascade is Gemini -> OpenAI unless task routing env changes.
- Legacy `services/plan-generator.ts` imports direct `callDomain` from `anthropic.ts`; that path is still guarded by the Anthropic runtime gate and bypasses `TaskRoutingProvider`.
- Training-specific deterministic coach engine work is separate from Chat provider routing.

### Content Creation

- Domain Chat path is provider-routed.
- Content script shortcut may call deterministic content services rather than Chat.
- Content refinement shortcut uses `completeOneShotWithFallback`.
- Python content engine calls the TypeScript internal proxy and inherits Gemini/OpenAI/Anthropic-gated behavior.
- Content discovery uses Gemini Search grounding, with Anthropic web-search fallback.

### Finance

- Domain Chat path is provider-routed.
- Image invoice classification has its own vision path.
- Current invoice analyzer attempts Anthropic first and then calls the vision fallback helper if that fails; this is inconsistent with the Gemini-first comments.

### Cooking

- Domain Chat path is provider-routed.
- Default provider cascade is Gemini -> OpenAI.
- No separate cooking one-shot provider path was found in this audit.

### Chat/classifier

- Active context is included in classifier input.
- Low-confidence classifier results preserve active conversation domain.
- The classifier path does not use `TaskRoutingProvider.classify`, but it still uses the Gemini/OpenAI/Anthropic-gated fallback helper.

## Operator Override Matrix

| Override | Affects provider? | Affects model? | Applies live? | Cache behavior |
| --- | --- | --- | --- | --- |
| `AI_*_PRIMARY/FALLBACK` | Yes | No | Startup only | Recreate provider after env change/restart. |
| `GEMINI_ROUTING_ENABLED` | Yes | No | Startup unless portal override persists | Domain router initialized at startup. |
| `GEMINI_DOMAINS` | Yes | No | Startup unless portal override persists | Domain router initialized at startup. |
| `GEMINI_INCLUDE_SECRETARY` | Yes | No | Startup unless portal override persists | Semantics are misleading. |
| `/api/domain-routing/toggle` | Yes | No | Yes | Clears active provider domain-pair cache. |
| `OPENAI_MODEL`, `GEMINI_MODEL`, etc. | No | Yes | Startup | Provider config defaults. |
| `/api/model-config` | No | Yes | Yes | Patches config for tier roles; domain roles read by `getModelRouting`. |
| `ANTHROPIC_ENABLED` | Yes | Indirect | Runtime env gate | Required for Anthropic execution. |

## Routing-Quality Implications For Chat

1. Multi-turn Chat should stay on domain handling rather than one-shot helpers when conversation memory matters.
2. Future tool-call streaming must not assume OpenAI-only streaming unless explicitly scoped to that provider.
3. Provider fallback must keep the same scoped history, state context, tool set, and tenant/user scope.
4. Day-to-day simulation tests should assert useful behavior independent of exact provider wording.
5. Tests should validate provider choice/fallback metadata separately from response prose.
