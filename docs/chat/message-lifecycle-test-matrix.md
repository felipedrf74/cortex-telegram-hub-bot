# Message Lifecycle Test Matrix

Generated: 2026-04-29 03:16 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Automated Tests Added/Updated

| Area | Test File | Coverage | Status |
| --- | --- | --- | --- |
| Lifecycle persistence | `__tests__/services/chat-history-store.test.ts` | Stores lifecycle metadata and finds completed assistant exchange by `clientMessageId`. | Pass |
| Idempotent claim | `__tests__/services/chat-history-store.test.ts` | Claims a client message once, returns duplicate on same text, returns conflict on text mismatch. | Pass |
| Retry after repair | `__tests__/services/chat-history-store.test.ts` | Reclaims a canceled user message as `retried` without creating a second row. | Pass |
| Message UUID duplicate prevention | `__tests__/services/chat-history-store.test.ts` | Duplicate `message_uuid` does not create another row. | Pass |
| Tenant-scoped lifecycle mutation | `__tests__/services/chat-history-store.test.ts` | Wrong tenant cannot mark message failed; correct tenant can. | Pass |
| Stuck message repair | `__tests__/services/chat-history-store.test.ts` | Old assistant streaming message becomes failed; unanswered user message becomes canceled. | Pass |
| REST replay | `__tests__/api/chat-routes.test.ts` | Same `clientMessageId` after completion returns existing assistant response and does not invoke skill/router twice. | Pass |
| In-flight retry | `__tests__/api/chat-routes.test.ts` | Existing in-flight user claim returns `202 idempotency-in-progress` and does not invoke skill/router. | Pass |
| Idempotency conflict | `__tests__/api/chat-routes.test.ts` | Reused client ID with different text returns `409 CHAT_IDEMPOTENCY_CONFLICT`. | Pass |
| Persistence contract | `__tests__/api/chat-persistence.test.ts` | Persists sent user and completed assistant lifecycle metadata. | Pass |
| Tenant route isolation | `__tests__/api/chat-history-routes.test.ts` and `__tests__/state/user-isolation.test.ts` | History reads remain tenant/user scoped. | Pass |

## Commands Run

```bash
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-persistence.test.ts
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-routes.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-local-responses.test.ts
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-routes.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-message-local-responses.test.ts
npm test -- --run __tests__/services/tool-executor.test.ts __tests__/api/chat-message-execution.test.ts __tests__/api/chat-message-degraded-response.test.ts
npm run typecheck
```

Results:

- 3-file lifecycle suite: 59 tests passed.
- 5-file lifecycle/security route suite: 82 tests passed.
- 4-file lifecycle/cache route suite: 65 tests passed.
- 6-file lifecycle/security/cache route suite: 88 tests passed.
- 3-file tool/degraded execution suite: 87 tests passed.
- TypeScript typecheck: passed.

## Still Needed

| Gap | Priority | Reason |
| --- | --- | --- |
| Migration `085` disposable clone rehearsal | Closed for staging-clone proof | Schema was proven on a disposable staging clone; production still needs a fresh predeploy DB snapshot. |
| WebSocket stream auth/tenant/reconnect tests | P0 if streaming is enabled | Streaming transport remains unsafe if enabled. |
| Durable tool invocation lifecycle tests | P1 | Route-level idempotency is not the same as tool-boundary idempotency. |
| Provider fallback during streaming | P1 | Future streaming fallback must not duplicate assistant messages or tool calls. |
| Attachment idempotency with content hash | P2 | Current guard keys on client message ID and text only. |
| Pending confirmation survives reconnect | P2 | Destructive action confirmation is current-turn only. |
