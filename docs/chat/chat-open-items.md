# Chat Open Items

Generated: 2026-04-29 03:16 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## P0 Production Blockers

1. WebSocket streaming must remain disabled or be fixed.
   - `IOS_WS_ENABLED=false` by default, which is the current mitigation.
   - If enabled, `/ws` must use auth-equivalent user/device checks, tenant scope, and tests.

2. No true multi-tenant Chat claim without active tenant membership.
   - Current auth explicitly maps `tenantId = userId`.
   - Required before workspace switching: active tenant selection, membership check, tenant-aware caches/tools/context.

## Closed In This Implementation Pass

1. Thread tenant scope through domain handlers and tool execution.
2. Pass tenant scope into shared memory tools.
3. Add tenant dimension to daily context cache, shared decision context cache, and Secretary state context cache.
4. Add tenant columns to `api_usage` and `audit_trail` migration and tenant-aware new audit writes.
5. Remove raw user text from high-risk Chat route/tool logs touched in this pass.
   - Final cleanup also removed raw normalized text from content-script/content-refinement shortcut failure logs.
6. Update user data export for active tenant-scoped Chat conversations and shared memory.
7. Add focused tenant-isolation tests for history, cache, context, tools, and legacy quarantine.
8. Add `chat-context-engine` for scoped context selection, relevance/freshness/confidence metadata, weak-context guardrails, and budgeted prompt rendering.
9. Preserve scoped prompt context across provider fallback paths.
10. Fix OpenAI provider options handling so `CallDomainOptions` is normalized instead of treated as a numeric token cap.
11. Thread optional tenant/user metadata through domain provider options and provider usage logging where migration `084` is available.
12. Add `chat-skill-orchestrator` for deterministic skill ownership analysis, multi-skill routing, context refresh signals, and provider-agnostic prompt routing metadata.
13. Add Chat route-level destructive action confirmation before domain/model execution.
14. Add Chat tool authorization context so destructive/external-send tools are blocked unless the current turn is explicitly confirmed and tenant/user scope matches.
15. Thread tenant metadata through the classifier call path (`routeMessage` → `classifyWithClaude` → `classifyMessage`) without changing the live provider-routing architecture.
16. Add message lifecycle columns for sent/completed/failed/canceled/retried/deleted state.
17. Claim idempotent REST chat messages before skill/model execution.
18. Replay completed assistant responses on duplicate client retry.
19. Return in-flight idempotency response instead of double-executing skills while a request is still processing.
20. Reject client message ID reuse with different text via `CHAT_IDEMPOTENCY_CONFLICT`.
21. Add tenant-scoped stuck message repair helpers for streaming/sent assistant rows and unanswered user rows.
22. Detect prompt-injection attempts and represent them as weak-context/security signals.
23. Escape retrieved/memory/history context item bodies and label them `instruction_authority="data_only"`.
24. Refuse shared-decision peer mesh prompt context for non-canonical tenant IDs until mesh readers are tenant-aware.
25. Reject prompt-injected explicit tool `user_id` mismatches instead of silently rewriting them.
26. Add deterministic day-to-day Chat simulation harness with persona bank, A-J multi-turn scenario bank, response sufficiency rubric, failure taxonomy, iOS-envelope checks, tool-call evidence, and fixture provider traces.
27. Prove `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql` on a disposable staging clone with online backup, apply, backfill/schema/index checks, scoped fixture, migrated proof DB, and restore proof.

## P1 Must Fix Before Multi-Tenant Chat Expansion

1. Finish provider-call tenant propagation for remaining streaming and off-domain one-shot paths. Domain calls now carry tenant/user metadata through `CallDomainOptions`.
2. Add explicit scoped audit for any durable attachment/file/tool-call objects.
3. Add true active-tenant membership before workspace switching.
4. Add durable tool invocation lifecycle records; route-level idempotency does not yet prove tool-boundary idempotency.
5. Add bounded repair worker/runbook for `repairStuckChatMessages`.

## P2 Should Fix

1. iOS Chat readiness audit and simulator smoke against local full-product backend.
2. Portal/web Chat audit if the surface is active.
3. Routing comment/name cleanup.
4. ~~Portal model override value validation.~~ Closed 2026-04-29: `/api/model-config` now rejects model values outside the provider role-tier `MODEL_OPTIONS` list and rejects wrong-tier pins.
5. Chat request trace tying request, tenant, provider, model, fallback, tools, cost, and latency.
6. Persist pending confirmation state for ergonomic follow-up confirmations such as “yes, do it” without allowing ambiguous destructive actions.
7. Attachment idempotency content hash; current guard keys on client message ID and text.
8. Connect the day-to-day simulation harness to seeded local full-product runtime and bounded real-provider samples after deterministic fixture mode remains stable.

## P3 Deferrable

1. Rename historical `classifyWithClaude` and `claude_client.py` compatibility names.
2. Persist provider circuit breaker state if provider incidents become frequent.
3. Chat UX source/explanation polish after backend safety is stable.

## Validation From This Implementation Pass

- Focused tenant/context/tool/cache suite: 8 files, 152 tests passed.
- Route/export/audit suite: 6 files, 85 tests passed.
- Post-log-redaction route suite: 2 files, 43 tests passed.
- Context/provider routing suite: 7 files, 170 tests passed.
- Combined Chat/context/provider regression suite: 21 files, 407 tests passed.
- Skill orchestration/tool authorization focused suite: 4 files, 361 tests passed.
- Chat route/orchestration regression suite: 2 files, 46 tests passed.
- Combined Chat routing/context/provider/security regression suite: 23 files, 684 tests passed.
- TypeScript typecheck: passed.
- Message lifecycle focused suite: 3 files, 59 tests passed.
- Message lifecycle/security route suite: 5 files, 82 tests passed.
- Message lifecycle/cache route suite: 4 files, 65 tests passed.
- Message lifecycle/security/cache route suite: 6 files, 88 tests passed.
- Tool/degraded execution suite after lifecycle pass: 3 files, 87 tests passed.
- Prompt-injection/shared-decision/tool security suite: 3 files, 111 tests passed.
- Wider Chat security/provider/route suite: 7 files, 181 tests passed.
- TypeScript typecheck after lifecycle pass: passed.
- Day-to-day Chat simulation harness: 1 file, 7 tests passed.
- Focused day-to-day/context/routing/tenant regression suite: 7 files, 92 tests passed.
- TypeScript typecheck after day-to-day harness pass: passed.
- Build after day-to-day harness pass: passed.
- Day-to-day simulation CLI: passed, 10 scenarios / 28 turns, average score 1.93 / 2.00.
- Diff whitespace check: passed.

Commands:

```bash
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/api/chat-message-execution.test.ts __tests__/services/tool-executor.test.ts __tests__/services/context-engine.test.ts __tests__/services/shared-decision-context.test.ts
npm test -- --run __tests__/api/chat-history-routes.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-message-degraded-response.test.ts __tests__/services/user-data-export.test.ts __tests__/services/audit-trail.test.ts
npm test -- --run __tests__/api/chat-routes.test.ts __tests__/api/chat-message-degraded-response.test.ts
npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/openai-provider.test.ts __tests__/services/gemini-provider.test.ts __tests__/services/provider-fallback.test.ts __tests__/domains/domain-handler.test.ts __tests__/domains/secretary.test.ts
npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/openai-provider.test.ts __tests__/services/gemini-provider.test.ts __tests__/services/provider-fallback.test.ts __tests__/domains/domain-handler.test.ts __tests__/domains/secretary.test.ts __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/api/chat-message-execution.test.ts __tests__/services/tool-executor.test.ts __tests__/services/context-engine.test.ts __tests__/services/shared-decision-context.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-message-degraded-response.test.ts __tests__/services/user-data-export.test.ts __tests__/services/audit-trail.test.ts
npm test -- --run __tests__/services/chat-skill-orchestrator.test.ts __tests__/services/tool-executor.test.ts __tests__/services/chat-context-engine.test.ts __tests__/router/classifier.test.ts
npm test -- --run __tests__/api/chat-routes.test.ts __tests__/services/chat-skill-orchestrator.test.ts
npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/chat-skill-orchestrator.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/openai-provider.test.ts __tests__/services/gemini-provider.test.ts __tests__/services/provider-fallback.test.ts __tests__/router/classifier.test.ts __tests__/domains/domain-handler.test.ts __tests__/domains/secretary.test.ts __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/api/chat-message-execution.test.ts __tests__/services/tool-executor.test.ts __tests__/services/context-engine.test.ts __tests__/services/shared-decision-context.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-message-degraded-response.test.ts __tests__/services/user-data-export.test.ts __tests__/services/audit-trail.test.ts
npm run typecheck
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-persistence.test.ts
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-routes.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-local-responses.test.ts
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-routes.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-message-local-responses.test.ts
npm test -- --run __tests__/services/tool-executor.test.ts __tests__/api/chat-message-execution.test.ts __tests__/api/chat-message-degraded-response.test.ts
npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/shared-decision-context.test.ts __tests__/services/tool-executor.test.ts
npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/shared-decision-context.test.ts __tests__/services/tool-executor.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-history-routes.test.ts __tests__/state/user-isolation.test.ts
npm run typecheck
npm test -- --run __tests__/services/chat-day-to-day-simulation.test.ts
npm test -- --run __tests__/services/chat-day-to-day-simulation.test.ts __tests__/services/chat-context-engine.test.ts __tests__/services/chat-skill-orchestrator.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-history-routes.test.ts __tests__/state/user-isolation.test.ts
npm run typecheck
npm run build
node dist/tools/chat-day-to-day-simulation.js
git diff --check
```

## Validation From Previous Working-Tree Pass

Previously recorded validation, not rerun in this prompt:

- Focused Chat/privacy/regression suite: 11 files, 157 tests passed.
- Provider routing suite: 4 files, 95 tests passed.
- TypeScript typecheck: passed.

## Validation Still Needed For This Branch

```bash
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-degraded-response.test.ts
npm test -- --run __tests__/api/chat-message-execution.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/services/tool-executor.test.ts __tests__/services/context-engine.test.ts __tests__/services/shared-decision-context.test.ts
npm test -- --run __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/ai-provider-qa-validation.test.ts __tests__/services/domain-provider-router.test.ts
npm run typecheck
```
