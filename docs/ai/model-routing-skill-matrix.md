# Model Routing Skill Matrix

Generated: 2026-05-19

## Summary Matrix

Live env note: the older staging/production env grep set `AI_CHAT_FALLBACK=anthropic` and `AI_TOOL_USE_FALLBACK=anthropic`, while `ANTHROPIC_ENABLED` was not present. The provider registry skips Anthropic when gated off. Current code defaults generic chat to OpenAI -> Gemini and keeps classifier/tool-use Gemini -> OpenAI unless env overrides are present.

| Area | Primary path | Default provider behavior | Model selection | Notes |
| --- | --- | --- | --- | --- |
| Chat classifier | `router/classifier.ts -> classifyMessage` | Gemini -> OpenAI -> Anthropic gated | Gemini classifier by explicit option; fallback provider defaults | Historical function names still say Claude. |
| General Chat domain handling | `domains/domain-handler.ts` | Active `TaskRoutingProvider` | `getModelRouting` plus model-config overrides | Persists conversation after final domain response. |
| Secretary | `domains/secretary.ts` | OpenAI -> Gemini through domain-specific pair | Chat tier by default | Direct Anthropic fallback only if routing provider unavailable and Anthropic gate enabled. |
| Training/Triathlon | `domains/domain-handler.ts`, legacy `services/plan-generator.ts` | Gemini -> OpenAI in default task state | Classifier tier unless overridden; Anthropic direct path in legacy generator | Training context is injected into Anthropic direct call path and provider-backed domain calls through shared context. |
| Content Creation | Chat domain, shortcuts, content engine | Gemini -> OpenAI for Chat domains; Gemini Search -> Anthropic gated for discovery; TS proxy for Python engine | Classifier tier for domain calls unless overridden | Content shortcuts can bypass domain routing for deterministic REST responses. |
| Finance | Chat domain, image/invoice tools | Gemini -> OpenAI for domain; vision paths vary | Classifier tier unless overridden | Invoice analysis currently tries Anthropic first before fallback helper. |
| Cooking | Chat domain | Gemini -> OpenAI through domain provider router | Classifier tier unless overridden | Cooking recipes are nano candidates behind quality gates and domain experiment overrides. |
| Tool continuations | `TaskRoutingProvider.continueWithToolResults` | Same resolved pair as initial domain call | Same optimization decision recomputed | Critical for stable tools/history across providers. |
| Vision/image classification | `classifyAndExtractImage` | Gemini vision -> OpenAI vision -> Anthropic gated; GIF direct Anthropic | Vision helper options | Provider fallback does not use task router. |
| Python content engine | `/api/v1/internal/ai-complete` | Gemini -> OpenAI -> Anthropic gated | One-shot helper options | `claude_client.py` name is compatibility-only. |
| Streaming | `OpenAIProvider.streamDomain` | OpenAI-only | OpenAI model | Not part of central fallback/circuit breaker layer. |

Live chat surfaces that enter this matrix:

- iOS REST Chat: `src/api/routes/chat-message-routes.ts`
- WebSocket Chat: `src/api/websocket.ts`

Both live inbound surfaces now infer a chat turn contract before domain execution. Telegram inbound Chat has been retired; `src/bot.ts` is outbound-only legacy delivery. The contract may correct weak generic routing, but it must not downgrade action, destructive, high-risk, or local-read flows. Selective web research is allowed only when the contract requires web/current information; `local_and_web` turns must carry scoped local state into the research prompt.

## Task Type Matrix

| Task type | Resolving function | Default primary | Default fallback | Anthropic path |
| --- | --- | --- | --- | --- |
| classify | `config.providerRouting.classify`; main Chat uses one-shot wrapper | Gemini | OpenAI | Only if thunk supplied and `ANTHROPIC_ENABLED=true`. |
| chat | `resolveTaskType(domain)` for non-tool domains | OpenAI | Gemini | Domain provider routing keeps Content/Finance/Cooking on Gemini-first baselines unless overridden. |
| tool-use | `resolveTaskType(secretary|triathlon)` | Gemini | OpenAI | Same as chat; Secretary domain overrides to OpenAI -> Gemini. |
| tool continuation | Same as initial domain call | Same resolved pair as initial route | Same resolved pair fallback | Same constraints as initial call. |
| vision/image | Vision helper, not task router | Gemini for common images | OpenAI | Anthropic gated fallback; GIF may go direct Anthropic. |

## Domain Matrix

| Domain | Task type | Domain provider router default | Effective default cascade | Model tier default | Important caveat |
| --- | --- | --- | --- | --- | --- |
| Secretary | tool-use | OpenAI primary, Gemini fallback | OpenAI -> Gemini | Chat tier | `GEMINI_INCLUDE_SECRETARY=true` means keep Secretary on OpenAI, despite the flag name. |
| Triathlon/Training | tool-use | Gemini primary, OpenAI fallback | Gemini -> OpenAI | Classifier tier | Keep Gemini baseline until safe-coaching eval proves a nano/mini split. |
| Content | chat | Gemini primary, OpenAI fallback | Gemini -> OpenAI | Classifier tier | Content discovery and content-engine have separate one-shot/proxy paths. |
| Finance | chat | Gemini primary, OpenAI fallback | Gemini -> OpenAI | Classifier tier | Invoice vision path does not follow this domain matrix. |
| Cooking | chat | Gemini primary, OpenAI fallback | Gemini -> OpenAI | Classifier tier | Domain-level experiment override can canary recipes to OpenAI nano. |

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
- Default provider cascade is Gemini -> OpenAI for Training/Triathlon because domain provider routing overrides the generic OpenAI-first chat task default.
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
- Default provider cascade is Gemini -> OpenAI for Cooking because domain provider routing overrides the generic OpenAI-first chat task default.
- No separate cooking one-shot provider path was found in this audit.

### Chat/classifier

- Active context is included in classifier input.
- Low-confidence classifier results preserve active conversation domain.
- The classifier path does not use `TaskRoutingProvider.classify`, but it still uses the Gemini/OpenAI/Anthropic-gated fallback helper.
- Unrouted/dynamic Chat domains use the task-level `providerRouting.chat` pair. Known in-app domains use the domain provider router matrix above.
- Contract and context metadata are exposed for audit/eval, but portal dashboards should not treat `cacheablePrefixHash` as proof of provider prompt-cache savings.

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
