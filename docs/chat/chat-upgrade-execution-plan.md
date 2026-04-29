# Chat Upgrade Execution Plan

Generated: 2026-04-29 02:10 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Goal

Make Nexus Chat safe, context-aware, useful, and provider-agnostic as the primary interaction layer while preserving Token-Zero REST/service paths for ordinary operational data.

## Architecture Direction

Chat should be organized around explicit contracts:

- authenticated user scope
- active tenant/workspace scope
- conversation ID and lifecycle
- message ID and lifecycle
- source skill/domain
- retrieval context with source/freshness/confidence
- tool-call request/response/audit
- model-routing metadata
- provider fallback metadata
- memory writes with provenance and expiry
- safe degraded responses

The model should reason over scoped, ranked, relevant context. It should not receive broad raw dumps or be trusted to enforce tenant boundaries.

## Recommended Implementation Sequence

### Phase 0 - Audit And Guardrails

Status: this prompt.

- Create rollback backup branch/tag.
- Create dedicated branch.
- Audit current Chat data, routes, provider routing, tenant scope, iOS contracts, and local smoke readiness.
- Produce current-state, gap, risk, open-item, and interaction-risk docs.

### Phase 1 - Close P0 Tenant Release Gaps

Status: implemented for current REST scope and staging-clone proven; production still requires a fresh predeploy DB snapshot.

- Keep migration `084_chat_tenant_scope.sql`.
- Verify `messages`, `conversations`, and `shared_memory` backfill/indexes on a disposable clone.
- Rerun focused Chat tenant tests.
- Block WebSocket if `IOS_WS_ENABLED=false`; otherwise fix WebSocket auth parity and tenant scope first.
- Ensure production release copy does not claim true workspace switching.

### Phase 2 - Thread Tenant Through Domain And Tool Context

Status: closed for current REST Chat paths.

- Extend `ChatDomainHandler` to accept `{ userId, tenantId }`.
- Thread scope through `handleSimpleDomain`, Secretary, thin domain wrappers, and direct fallback paths.
- Add tenant to `executeToolCall` scope.
- Pass tenant into shared memory tools, conversation helpers, shared decision context, daily context, and Secretary state context.
- Add tests for same user across two tenants for domain history, memory, cache, and tool calls.

### Phase 3 - Tenant-Aware Context Retrieval And Memory

Status: closed for current scoped Chat context and memory paths; live vector retrieval remains future work.

- Add tenant dimension to daily context cache or make it explicitly single-tenant.
- Add tenant dimension to shared decision context cache.
- Add tenant dimension to Secretary state-context cache.
- Add source/freshness/confidence metadata to retrieved context before injecting into prompts.
- Add model-context minimization tests.

### Phase 4 - Durable Chat Object Model

Status: partial. Message/conversation lifecycle is implemented; durable attachment, tool-call, skill-invocation, vector, streaming, and background-job tables remain future work before those surfaces are enabled.

Add or verify tenant/user scope for:

- attachments/files
- tool call records
- skill invocation records
- conversation summaries
- vector/embedding memory
- feedback records
- streaming events
- background jobs spawned by Chat

### Phase 5 - Model Routing And Observability

Status: partially implemented and documented in `docs/ai`.

- Preserve task/domain/provider/model routing.
- Do not hardcode provider/model choices.
- Add provider/model/fallback/latency/cost trace to Chat request ID.
- Add tenant-aware AI usage attribution.
- Validate portal model override values.

### Phase 6 - Day-To-Day Simulation Harness

Status: closed in deterministic fixture mode.

- Create a realistic local full-product Chat scenario harness.
- Cover morning planning, schedule changes, Training/Cooking/Finance/Content questions, corrections, vague follow-ups, tenant switching, memory recall, stale context, cancellations, retries, frustration, ambiguous instructions, and cross-tenant attacks.
- Score usefulness, correctness, tenant safety, routing quality, memory use, context relevance, and hallucination avoidance.

### Phase 7 - iOS And Portal Chat Readiness

Status: partial. Portal metadata-only diagnostics are audited, and iOS readiness/local smoke evidence is tracked in RC docs with limitations.

- Audit iOS DTOs and rendering for rich responses, callbacks, attachments, degraded states, streaming, empty/loading/error states.
- Run iOS simulator against full local Nexus product engine.
- Audit portal/web Chat only if it is an active supported surface.

## Priority Matrix

| Priority | Work | Why |
| --- | --- | --- |
| P0 | Migration `084` proof and release validation | Current production may still be user-only for Chat persistence. |
| P0 | WebSocket disabled or fixed | If enabled, it bypasses REST auth parity and tenant scope. |
| P0 | Active tenant membership before workspace switching | Tenant ID cannot remain inferred from user ID if true multi-tenant Chat exists. |
| P1 | Domain/tool tenant propagation | Model context and tool writes must not silently default to user tenant. |
| P1 | Tenant-aware context caches | Stale or cross-tenant prompt context is high-impact. |
| P1 | Sensitive logging cleanup | Chat text can include private calendars, finance, health-adjacent, and work context. |
| P1 | AI usage tenant attribution | Required for tenant audit, cost controls, and incident response. |
| P2 | Day-to-day simulation harness | Needed for product quality beyond exact unit tests. |
| P2 | iOS Chat readiness audit | Prevent frontend flattening/hiding of richer Chat behavior. |
| P3 | Naming/comment cleanup | Reduces future provider-routing mistakes. |

## Do-Not-Break List

- Token-Zero: direct operational data lookups stay direct.
- Provider routing remains configurable.
- Anthropic gate remains respected.
- Existing iOS Chat response envelope remains backward-compatible.
- Degraded responses must not leak internal/provider errors.
- Cost cap and cost lock must stay before AI spend.
- Cross-skill tools must remain user-authorized and eventually tenant-authorized.
- Chat history clear must not delete outside the active tenant/user scope.

## Validation Plan

Focused backend:

```bash
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-degraded-response.test.ts
npm test -- --run __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/ai-provider-qa-validation.test.ts __tests__/services/domain-provider-router.test.ts
npm run typecheck
```

Release/staging:

- Keep the passed staging-clone proof for migrations `084` and `085` linked in release docs.
- Take a fresh production DB snapshot immediately before deployment.
- Verify tenant columns, backfill, indexes, and unique constraints during staging/deploy smoke.
- Run Chat focused tests against migrated DB where feasible.
- Keep WebSocket disabled until fixed.
- Run local full-product Chat smoke.
- Run iOS simulator Chat smoke against local backend.
