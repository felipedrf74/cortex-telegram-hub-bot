# Model Routing Local Smoke Results

Generated: 2026-04-29 14:40 WEST
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Commit at run start: `34add9a`
Mode: local fixture mode, no production/staging deployment

## Summary

Local model-routing smoke passed in fixture mode.

The smoke validates that Nexus routing remains provider-agnostic and configurable across classify, chat, tool-use, tool-continuation, fallback, and operator/domain override paths. It also verifies tenant-safe metadata, no raw prompt leakage in the new routing logs, fallback metadata, and provider health metrics.

Final smoke verdict: **PASS WITH CONDITIONS**.

The conditions are not failures in the fixture smoke itself. They are the remaining production-release caveats already tracked in the model-routing blocker docs: off-path OpenAI streaming, internal AI proxy attribution, legacy context tenant proof, gate-aware Anthropic fallback selection, invoice vision routing drift, and unified durable AI-call tracing.

## Commands Run

```bash
npx vitest run __tests__/services/model-routing-local-smoke.test.ts __tests__/services/model-routing-observability.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/openai-provider.test.ts
npx tsc --noEmit
```

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Local model-routing smoke | PASS | `__tests__/services/model-routing-local-smoke.test.ts`: 4 tests passed |
| Focused routing/provider regression suite | PASS | 5 files passed, 100 tests passed |
| TypeScript typecheck | PASS | `npx tsc --noEmit` exited 0 |
| Real provider calls | NOT USED | Fixture mode was sufficient and safer for routing/security validation; no model cost incurred |
| Local services cleanup | PASS | No backend server, workers, containers, tunnels, or provider-call loops were started |

## Smoke Matrix

| Scenario | Mode | Result | Notes |
| --- | --- | --- | --- |
| classify | Fixture provider | PASS | `classify` routes through the configured classify pair and emits `classify_message` metadata. |
| chat | Fixture provider | PASS | Content domain uses the configured chat provider pair; no global model/provider is forced. |
| toolUse | Fixture provider | PASS | Secretary domain routes through the configured `tool-use` pair. |
| tool-continuation | Fixture provider | PASS | Secretary continuation preserves `tool_continuation`, domain, tier, tenant, and user metadata. |
| fallback simulation | Fixture provider | PASS | Simulated 429 from primary routes to fallback with `fallbackReason=rate_limited`. |
| operator override simulation | Fixture provider | PASS | Seeded cached domain pair routes content to OpenAI and records `pairSource=domain_cache`, `operatorOverrideApplied=true`. |
| cost/latency/fallback metadata | Fixture + adapter tests | PASS WITH CONDITIONS | Fixture smoke validates fallback/provider health metadata. Mocked OpenAI adapter tests validate `api_usage` cost and duration persistence. No live usage row was generated. |
| no raw sensitive prompt logs | Fixture provider | PASS | Sensitive prompt text and forbidden tenant-B context are absent from new routing logs. |
| no tenant leakage before provider call | Fixture provider | PASS | Fallback provider receives only tenant-A scoped context; test asserts tenant-B marker is not present. |
| runaway call detection | Fixture provider | PASS | Per-request threshold warning fires without logging message text. |

## Fixture Behavior

The smoke uses local fixture providers named `gemini`, `openai`, and `anthropic`. These are not real provider clients and do not call external APIs.

This was intentional:

- The user asked for local model-routing smoke, not model quality validation.
- The smoke target is dispatch, fallback, metadata, tenant scope, and prompt-log privacy.
- Real provider calls would add cost and secret exposure risk without improving proof for routing-layer safety.
- Provider adapter cost/duration plumbing is already covered by mocked adapter tests included in the same command.

## Tests Added

`__tests__/services/model-routing-local-smoke.test.ts`

Coverage:

- classify, chat, tool-use, and tool-continuation fixture paths
- fallback simulation with safe metadata
- provider health metrics after fallback
- operator/domain override simulation
- prompt-log privacy
- tenant-context isolation before fallback provider execution
- runaway provider-call detection

## Provider Usage Controls

| Control | Status |
| --- | --- |
| Fixture mode default | PASS |
| Real provider call count | 0 |
| Production provider settings used | NO |
| Operator override simulation | PASS, local in-memory cache only |
| Background model loops started | NO |
| Runaway-call detection | PASS, threshold test-covered |

## Open Conditions

The following are not failures of this smoke run, but they prevent an unconditional model-routing production GO:

1. `OpenAIProvider.streamDomain()` remains off the central provider-routing interface and still needs explicit production exclusion or routing/attribution hardening.
2. `/api/v1/internal/ai-complete` still needs tenant/user attribution or a documented system-only contract.
3. Legacy user-only context blocks still need full tenant proof before prompt construction.
4. Domain-specific fallback selection still needs Anthropic-gate awareness when `ANTHROPIC_ENABLED=false`.
5. Invoice/vision provider order remains an explicit routing-policy decision.
6. Cost/latency/fallback observability is still split between routing logs and concrete adapter `api_usage`; a unified request/message AI-call trace remains open.

## Final Verdict

**PASS WITH CONDITIONS**

Local fixture smoke passed, focused routing/provider tests passed, and typecheck passed. No raw prompt leakage or tenant-B context leakage was observed in the new routing logs or fallback path. The remaining conditions should stay on the Chat/model-routing production burndown until fixed or explicitly accepted.
