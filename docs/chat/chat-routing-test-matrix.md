# Chat Routing Test Matrix

Status: current focused coverage

| Area | Test Coverage | Status |
|---|---|---|
| Secretary routing | Existing router tests plus orchestration override tests | PASS |
| Training routing | Existing classifier/router tests | PASS |
| Cooking routing | Existing classifier/router tests | PASS |
| Finance routing | Existing classifier/router tests | PASS |
| Content routing | Existing classifier/router tests and content shortcut route tests | PASS |
| Multi-skill scheduling | `chat-skill-orchestrator.test.ts` routes workouts + content deadlines to Secretary | PASS |
| Content guidance with schedule language | Chat API filming guidance remains content-owned | PASS |
| Destructive confirmation | Chat route pauses destructive action before router/domain handler | PASS |
| Tool authorization | `tool-executor.test.ts` blocks destructive tools without confirmation | PASS |
| Tenant mismatch in tool execution | `tool-executor.test.ts` blocks tenant context switch under Chat request | PASS |
| Provider fallback context safety | `provider-fallback-domain-routing.test.ts` ensures fallback receives same scoped context | PASS |
| Prompt ownership rules | `chat-context-engine.test.ts` and orchestration prompt tests cover provider-agnostic routing block | PASS |

## Commands Run

```bash
npm test -- --run __tests__/services/chat-skill-orchestrator.test.ts __tests__/services/tool-executor.test.ts __tests__/services/chat-context-engine.test.ts __tests__/router/classifier.test.ts
npm test -- --run __tests__/api/chat-routes.test.ts __tests__/services/chat-skill-orchestrator.test.ts
npm run typecheck
```

## Coverage Gaps

- Full day-to-day simulation harness is implemented and passing in fixture mode.
- Local full-product/iOS smoke evidence exists with documented limitations; add persistent simulator/XCUITest coverage later.
- WebSocket Chat path still requires equivalent tenant/auth/confirmation gates before enabling.
- True multi-tenant workspace membership remains simplified around `tenantId=userId`.
