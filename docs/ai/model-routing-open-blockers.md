# Model Routing Open Blockers

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Commit audited: `34add9a`
Related audit: `docs/ai/model-routing-safety-audit.md`

## Release-Gate Verdict

**PASS WITH CONDITIONS**

The live routing architecture remains configurable and provider-agnostic. No emergency P0 model-routing exploit was confirmed in this audit. The items below are still open before an unconditional Chat production release. If the release excludes a path, record the exclusion in the release candidate risk register.

## P0 Blockers

| ID | Status | Blocker | Why it matters | Required closure |
| --- | --- | --- | --- | --- |
| MRB-P0-01 | Guardrail open | No confirmed P0 exploit, but tenant isolation before prompt construction remains mandatory. | Model providers must never receive unauthorized tenant/user context. Routing cannot be a security boundary. | Tenant-scoped prompt/context tests must cover Chat history, memory, retrieval, attachments, tool results, and legacy skill context blocks before Chat GO. |

## P1 Blockers

| ID | Status | Blocker | Evidence | Required closure |
| --- | --- | --- | --- | --- |
| MRB-P1-01 | Closed 2026-04-29 | OpenAI tool-use and tool-continuation paths ignored filtered tool lists. | `OpenAIProvider.callDomain()` and `continueWithToolResults()` now pass routing-layer `filteredTools`; empty filtered lists omit tools. | Covered by `__tests__/services/openai-provider.test.ts`. |
| MRB-P1-02 | Open | OpenAI streaming bypasses central routing and has weak attribution. | `OpenAIProvider.streamDomain()` is OpenAI-only, outside `AIProvider`, and writes usage as `user_id=0` with no `tenant_id`. | Migrate streaming to provider-agnostic routing or explicitly disable/exclude it from production Chat; add tenant/user attribution if kept. |
| MRB-P1-03 | Open | Python content-engine AI proxy lacks tenant/user attribution. | `/api/v1/internal/ai-complete` accepts prompt/system/category but no scope; Python wrapper cannot pass scope. | Add optional, authorized tenant/user fields for user/tenant-derived prompts or document/enforce system-only use. |
| MRB-P1-04 | Open | Domain fallback can include disabled Anthropic. | Domain pair construction uses provider lookup that can instantiate Anthropic; the runtime gate only fails later at `trackedCreate`. | Use gate-aware provider selection for domain-specific pairs and test `ANTHROPIC_ENABLED=false` fallback behavior. |
| MRB-P1-05 | Open | Legacy user-only context blocks before provider calls are not fully tenant-proven. | `buildSimpleStateContext` calls user-only helpers for tasks, coach state, active training plans, training profile/progression, and content knowledge. | Audit each helper, add tenant filters where needed, and add prompt-builder tests proving tenant A cannot inject tenant B context. |
| MRB-P1-06 | Open | Invoice/vision provider order conflicts with routing doctrine. | `analyzeInvoiceImage()` tries Anthropic first, while broader docs/helpers say Gemini -> OpenAI -> Anthropic gated. | Decide if invoice extraction is an explicit Anthropic-primary exception; otherwise reorder and test Gemini/OpenAI/Anthropic fallback. |
| MRB-P1-07 | Open | Provider/fallback observability is not request-correlated. | Fallback logs and `api_usage` rows do not share a durable request/message trace. | Add tenant-safe AI call trace or extend usage rows/events to include request id, message id, domain, task type, fallback flag, fallback reason, and operator override status. |

## P2 Should-Fix Items

| ID | Status | Item | Evidence | Recommended closure |
| --- | --- | --- | --- | --- |
| MRB-P2-01 | Open | OpenAI one-shot helpers default to `gpt-4o-mini` outside model-config overrides. | `completeOneShot()` and `completeVisionOneShot()` hardcode the default unless an option is passed. | Resolve via model-config/tier helper or document as a fixed utility fallback. |
| MRB-P2-02 | Open | Model registry/default drift. | `config.openai.model` and `MODEL_OPTIONS.openai.chat` are not perfectly aligned. | Reconcile config defaults and portal-selectable options. |
| MRB-P2-03 | Open | Stale names/comments can mislead operators. | `classifyWithClaude`, `claude_client.py`, domain-router comments, Gemini model comments. | Update wording after routing behavior is locked. |
| MRB-P2-04 | Open | Circuit breaker and provider metrics are in-memory only. | `TaskRoutingProvider` metrics reset on restart. | Accept explicitly or persist minimal provider health state for operations. |
| MRB-P2-05 | Open | Provider SDK error logging lacks explicit prompt redaction. | Several provider catch blocks log `{ err }`. | Add a sanitizing error serializer for provider errors. |
| MRB-P2-06 | Open | Category tags are inconsistent for dashboards and release monitoring. | Examples include `domain_secretary`, `openai_domain_secretary`, `gemini_domain_secretary`, `tool_continuation`. | Normalize reporting queries around provider/domain/task fields instead of exact category strings. |

## Not A Blocker

| Item | Reason |
| --- | --- |
| "Nexus Chat is not GPT-only" | Confirmed. Runtime routing is configurable and currently provider-agnostic. |
| Anthropic disabled by default | Intentional cost/safety gate. Blocker only when operator config expects Anthropic to be an active fallback. |
| Category tags not controlling routing | Expected. Tags are mostly tracking/timeout metadata. |

## Closure Checklist

- [x] OpenAI provider honors filtered tools in initial tool-use and continuation calls.
- [ ] Domain fallback selection applies Anthropic gate before a disabled provider enters the fallback pair.
- [ ] Internal AI proxy supports scoped attribution or rejects tenant/private prompts by contract.
- [ ] Streaming path is routed, attributed, or excluded from production Chat.
- [ ] Prompt-builder tests prove tenant isolation across legacy user-only context blocks.
- [ ] Provider/fallback trace metadata is durable and tenant/user safe.
- [ ] Vision provider order is documented and tested.
- [ ] Release docs state provider routing honestly: configurable, operator-controlled, not fixed to GPT/Claude/Gemini.

## Validation Status

Tests run for this batch: none. This was a read-only code audit plus documentation pass.

Recommended validation command set after fixes:

```bash
npm run typecheck
npm test -- --runInBand --testPathPattern='chat|provider|model-routing|tenant|tool'
npm run verify
```
