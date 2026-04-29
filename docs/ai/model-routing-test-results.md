# Model Routing Test Results

Generated: 2026-04-29
Branch: `feature/secretary-scheduling-arbitrator-batch4`
Scope: model-routing observability and safety fixes

## Commands Run

```bash
npx vitest run __tests__/services/model-routing-observability.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/openai-provider.test.ts
npx tsc --noEmit
```

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Focused routing/provider tests | PASS | 4 files passed, 96 tests passed |
| TypeScript typecheck | PASS | `npx tsc --noEmit` exited 0 |

## Tests Added Or Updated

### Added

`__tests__/services/model-routing-observability.test.ts`

Coverage:

- operator override visibility is preserved in routing metadata
- fallback reason and category tags are preserved
- fallback metadata carries user id, tenant id, model tier, domain, and task type
- configured provider pairs are used instead of any hardcoded provider
- user-scoped calls without tenant scope emit a warning before model execution
- runaway provider-call loops are detected per request id
- prompt text is not logged by the new routing metadata/fallback logs

### Updated

`__tests__/services/openai-provider.test.ts`

Coverage added:

- OpenAI `callDomain` honors routing-layer `filteredTools`
- OpenAI `callDomain` omits tools when `filteredTools` is intentionally empty
- OpenAI `continueWithToolResults` preserves `filteredTools`

### Regression Coverage Re-run

`__tests__/services/provider-fallback.test.ts`

Coverage preserved:

- task-type routing
- fallback behavior
- circuit breaker behavior
- provider metrics
- optimization pass-through
- tool-continuation optimization consistency

`__tests__/services/provider-fallback-domain-routing.test.ts`

Coverage preserved:

- domain-specific provider pair usage
- tool continuation uses the same domain-specific pair
- fallback receives the same scoped state context instead of rebuilding prompt context

## Acceptance Criteria Mapping

| Acceptance item | Status | Notes |
| --- | --- | --- |
| provider/model/tier/category metadata | PASS WITH CONDITIONS | Provider, tier, category, task type, domain, and concrete provider are now logged in routing metadata. Concrete model names remain recorded by provider adapters in `api_usage`; unified request trace remains open. |
| fallback reason logging | PASS | Fallback events include `fallbackReason` and safe error summaries. |
| operator override visibility | PASS | Metadata includes `pairSource` and `operatorOverrideApplied`. |
| tenant-safe model call metadata | PASS | Metadata includes user/tenant ids when supplied and scope presence flags; missing tenant scope warns. |
| no raw prompt leakage | PASS | New routing logs record lengths and safe summaries only; tests assert sensitive prompt strings do not appear in new logs. |
| context safety before fallback | PASS | Existing fallback path preserves scoped context; tests cover scoped metadata and fallback path shape. |
| routing tests | PASS | Focused routing/provider tests added and re-run. |
| detection of runaway provider calls | PASS | Per-request threshold warning added and tested. |
| operator override preserved | PASS | Covered by observability test. |
| fallback path safe | PASS WITH CONDITIONS | Prompt rebuild is avoided and metadata is safe. Remaining off-path streaming/internal proxy work remains open. |
| category tag preserved | PASS | Covered for domain and tool-continuation fallback. |
| no hardcoded provider | PASS | Configured provider pair test covers provider-agnostic dispatch. |
| tenant scope before model call | PASS WITH CONDITIONS | Warning added and tested; full tenant proof for legacy context helpers remains open. |
| no sensitive prompt logging | PASS | Covered for new routing logs and fallback logs. |

## Open Test Gaps

- Python `/api/v1/internal/ai-complete` attribution and fallback tests.
- Provider-agnostic streaming tests if/when `streamDomain` is moved into the central interface.
- End-to-end Chat smoke proving new model-routing metadata joins request/message ids in production-like logs.
- Tenant proof for every legacy context block in `buildSimpleStateContext`.
- Domain fallback behavior with `ANTHROPIC_ENABLED=false` once provider selection is made gate-aware.

## Final Verdict

**PASS WITH CONDITIONS**

The implemented routing safety and observability changes pass focused tests and typecheck. Remaining P1 items are tracked in `docs/ai/model-routing-fixes.md` and should stay on the Chat production burndown until closed or explicitly accepted.
