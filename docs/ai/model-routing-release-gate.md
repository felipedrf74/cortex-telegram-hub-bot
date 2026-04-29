# Model Routing Release Gate

Generated: 2026-04-29 14:40 WEST
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Commit at run start: `34add9a`

## Verdict

**PASS WITH CONDITIONS**

The local routing smoke and focused regression suite are green. Nexus still preserves live model routing: no provider was hardcoded as the global Chat runtime default, operator/domain override simulation works, and fallback routing remains configurable.

This is not an unconditional production GO for all Chat AI paths. The remaining conditions below must either be fixed or explicitly accepted in the Chat release candidate risk register before production release.

## Evidence

| Evidence | Status |
| --- | --- |
| Local model-routing fixture smoke | PASS |
| Focused provider/fallback regression suite | PASS |
| TypeScript typecheck | PASS |
| Real provider calls required for this gate | NO |
| Raw sensitive prompt logging in new routing logs | NOT OBSERVED |
| Cross-tenant context in fallback provider call | NOT OBSERVED |
| Operator/domain override visibility | PASS |
| Fallback reason metadata | PASS |
| Provider health metrics after fallback | PASS |

## Validation Commands

```bash
npx vitest run __tests__/services/model-routing-local-smoke.test.ts __tests__/services/model-routing-observability.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/openai-provider.test.ts
npx tsc --noEmit
```

Observed result:

- 5 test files passed
- 100 tests passed
- Typecheck exited 0
- No local services remained running because no services were started

## Release Conditions

| ID | Severity | Condition | Required action before unconditional GO |
| --- | --- | --- | --- |
| MRG-C1 | P1 | OpenAI streaming is off-path from central routing. | Move streaming into provider-agnostic routing or explicitly exclude it from production Chat release. |
| MRG-C2 | P1 | Internal AI proxy lacks tenant/user attribution. | Add scope fields and authorization contract, or enforce/document system-only usage. |
| MRG-C3 | P1 | Legacy prompt context blocks are not fully tenant-proven. | Add tenant-scoped prompt-builder/context tests across chat history, memory, retrieval, tool results, and skill context. |
| MRG-C4 | P1 | Domain fallback selection is not Anthropic-gate aware. | Make domain pair construction respect `ANTHROPIC_ENABLED` before a disabled Anthropic provider enters the pair. |
| MRG-C5 | P1 | Invoice/vision provider order differs from model-routing doctrine. | Document as an explicit exception or align provider order and tests. |
| MRG-C6 | P2 | Durable model-call trace is incomplete. | Join routing metadata, provider/model, request/message id, fallback reason, latency, and cost in tenant-safe telemetry. |

## Production Recommendation

Model-routing smoke status: **suitable to carry forward into the release candidate with conditions**.

Do not claim an unconditional model-routing GO until the P1 conditions are closed or accepted by release owner sign-off. Do not deploy from this gate alone; it proves local routing smoke only.

## Monitoring Checklist For Release Candidate

- provider selected per request
- concrete model selected by adapter
- task tier: classify/chat/toolUse/tool-continuation
- domain/skill
- category tag
- operator override applied or not
- fallback used or not
- fallback reason
- provider failure rate
- provider/model latency
- token/cost estimate where available
- runaway call-loop warnings
- unusually high classification volume
- unusually high tool-continuation volume
- Anthropic emergency fallback activation if enabled
- tenant/user-safe logging only
- no raw prompt/context leakage
- missing-tenant-scope warnings
- prompt-builder tenant isolation failures

## Final Gate

**PASS WITH CONDITIONS**

Fixture smoke passed and no production-facing routing regression was found in the covered paths. Remaining off-path or broader-context risks are tracked and must remain release-gated.
