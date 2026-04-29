# Model Routing Open Items

Generated: 2026-04-29 02:05 WEST

## P0 Guardrails

| Item | Status | Why it matters | Next step |
| --- | --- | --- | --- |
| Preserve tenant isolation before all model calls | Open guardrail | Chat may include private messages, calendar data, memories, attachments, tool results, and skill context. Provider routing cannot enforce tenant isolation. | Thread tenant ID through Chat context retrieval, memory, tool execution, provider usage logging, and audit records. |

## P1 Must Fix Before Broad Multi-Tenant Chat Expansion

| Item | Status | Why it matters | Next step |
| --- | --- | --- | --- |
| Add tenant-aware AI usage attribution | Open | Provider/model/cost/fallback auditing is currently user-level or system-level only. | Add `tenant_id` to `api_usage` or companion AI audit table, migrate, and update all provider inserts. |
| Pass `userId` and `tenantId` through provider-agnostic domain calls | Open | Gemini/OpenAI domain calls often log `user_id=0`; future tenant-aware cost caps need scope. | Extend `CallDomainOptions` with scope metadata and update provider adapters/tests. |
| Validate portal model overrides against allowed options | Closed 2026-04-29 | Operator-submitted model names are validated against provider role-tier options. | Covered by `__tests__/portal/portal-provider-routes.test.ts`. |
| Align live fallback env with Anthropic gate expectations | Open | Staging/production request Anthropic fallback for chat/tool-use, but Anthropic appears gated off, so effective fallback depends on registry skip behavior. | Decide whether this is intentional emergency-fallback posture; if not, set fallback env to OpenAI or enable Anthropic explicitly during incidents only. |
| Decide and fix invoice vision provider order | Open | Current code attempts Anthropic first, which conflicts with Gemini-first architecture comments. | Make intended provider order explicit and add a regression test. |
| Formalize streaming provider routing | Open | Current streaming is OpenAI-only and outside central fallback. | Either keep as documented OpenAI-only or create provider-agnostic streaming route with fallback semantics. |
| Inventory direct Anthropic bypasses | Open | Some direct paths depend on the Anthropic gate and bypass task routing. | Migrate where appropriate or document as exceptional paths with tests. |

## P2 Should Fix

| Item | Status | Why it matters | Next step |
| --- | --- | --- | --- |
| Clean stale provider comments and names | Open | Names like `classifyWithClaude` and comments about Gemini 3/Anthropic fallback can mislead future work. | Rename carefully or update comments without changing behavior. |
| Reconcile model defaults and portal options | Open | `gpt-5.4-nano` is a config default but absent from OpenAI chat options. | Align `MODEL_OPTIONS` with real supported defaults after provider verification. |
| Update portal model intelligence copy | Open | Dashboard copy assumes Secretary GPT and a category that may not match routed logs. | Use actual provider/model usage rows grouped by domain/category pattern. |
| Add request-level AI trace | Open | Debugging quality and fallback currently requires joining logs manually. | Emit trace ID with provider, model, category, fallback, latency, cost, user, tenant, tool loop. |
| Add fallback day-to-day simulations | Open | Exact wording tests are not enough to prove Chat quality under fallback. | Build scenario tests for morning planning, corrections, tool calls, stale context, and fallback injection. |

## P3 Deferrable Cleanup

| Item | Status | Why it matters | Next step |
| --- | --- | --- | --- |
| Rename `GEMINI_INCLUDE_SECRETARY` | Deferred | The flag no longer means what it says. | Add a clearer alias first; keep old env for compatibility. |
| Persist circuit breaker state | Deferred | In-memory breakers reset on restart. | Only needed if provider incidents are frequent enough to justify persistence. |
| Remove compatibility names in Python content engine | Deferred | `claude_client.py` name is misleading but stable. | Keep until imports can be safely migrated. |

## Documentation Output From This Audit

- `docs/ai/model-routing-current-state.md`
- `docs/ai/model-routing-skill-matrix.md`
- `docs/ai/model-routing-risk-register.md`
- `docs/ai/model-routing-open-items.md`

## Validation Status

This prompt was documentation-only. No routing behavior was changed and no tests were run for this audit. The previous Chat provider-routing regression suite remains the relevant code validation for the unmerged domain-pair fix:

```bash
npm test -- --run __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/ai-provider-qa-validation.test.ts __tests__/services/domain-provider-router.test.ts
```
