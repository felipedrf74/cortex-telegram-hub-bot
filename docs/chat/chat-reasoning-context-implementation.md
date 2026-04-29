# Chat Reasoning Context Implementation

Date: 2026-04-29
Branch: `feature/chat-p0-tenant-security-audit`

## Summary

This batch improves Chat reasoning, memory, context handling, pending confirmations, ambiguity handling, and response sufficiency metadata without changing model routing or deploying anything.

The implementation preserves the live provider-routing architecture. The backend scopes, selects, annotates, and validates context before any provider path receives it.

## Code Changes

| Area | Files | Change |
| --- | --- | --- |
| Tenant-scoped memory | `src/state/shared-memory.ts` | Added explicit safe-memory validation, scope buckets, tenant/user-scoped correction helper, and visibility-scope filtering. |
| User-private vs tenant-shared separation | `src/state/shared-memory.ts`, `src/services/chat-context-engine.ts` | Context selection now reads memory through scope buckets. `tenant_shared` is distinguished in context metadata but still limited to the current user until tenant membership is complete. |
| Stale/fresh context | `src/services/chat-context-engine.ts` | Existing freshness/confidence metadata retained; low-confidence memory still triggers weak context. |
| User correction handling | `src/state/shared-memory.ts` | Added `applySharedMemoryCorrection()` to update a scoped memory key instead of creating ambiguous duplicate memory. |
| Ambiguous follow-up safety | `src/services/chat-context-engine.ts` | Added `unsafe_ambiguous_action` weak signal when recent scoped history contains multiple plausible targets for an action like “move it.” |
| Pending confirmations | `src/services/chat-pending-confirmations.ts`, `src/api/routes/chat-message-routes.ts` | Destructive action confirmation prompts now register a tenant/user-scoped pending confirmation with expiry and source message ID. |
| Response sufficiency | `src/services/chat-response-sufficiency.ts`, `src/api/routes/chat-message-routes.ts` | Confirmation responses now include `actionStatus`, unresolved blockers, pending confirmation metadata, and response-sufficiency metadata. |
| Tests | `__tests__/services/chat-context-engine.test.ts`, `__tests__/state/shared-memory.test.ts`, `__tests__/services/chat-response-sufficiency.test.ts` | Added coverage for correction, tenant partitioning, ambiguity, stale memory, missing context, and response sufficiency. |

## Behavior Details

### Tenant-Scoped Memory

Memory writes still require valid authenticated user and tenant scope. Memory reads require:

- `tenant_id = active tenant`
- `user_id = authenticated user`
- `scope_status = active`
- `visibility_scope IN ('user_private', 'tenant_shared')`

This means current Chat memory remains safe for single-user active-tenant flows. Cross-user tenant-shared reads are deliberately not enabled because the broader tenant membership/permission model is not complete enough to prove access.

### Unsafe Memory Rejection

`setSharedMemory()` now rejects:

- invalid or unstable memory keys
- empty values
- oversized values
- credential-like values, including API keys, OAuth/access/refresh tokens, passwords, private keys, and card-like numbers

This keeps “remember this” from becoming an accidental secret store.

### User Corrections

`applySharedMemoryCorrection()` updates the existing scoped key in-place. This supports flows like:

- “Remember I prefer workouts before work.”
- “Actually, after work is better.”

The corrected value replaces the old value for that tenant/user/key. It does not create a second ambiguous memory fact.

### Ambiguous Follow-Ups

The context engine already handled missing history for “move it” / “cancel that.” This batch adds a second guardrail: if scoped history exists but contains multiple plausible targets, the engine emits:

`unsafe_ambiguous_action`

Suggested clarification:

`Which exact item should I update?`

### Pending Confirmations

When Chat pauses a destructive action, the route now creates an in-memory pending confirmation record:

- pending confirmation ID
- tenant/user
- action summary
- involved skills
- reason codes
- source user message ID
- expiry

The response metadata now exposes:

- `actionStatus: "needs_confirmation"`
- `unresolvedBlockers`
- `pendingConfirmation`
- `responseSufficiency`

This is intentionally lightweight. Durable pending-action storage remains a follow-up for full message/tool lifecycle hardening.

### Response Sufficiency

`buildChatResponseSufficiencyMetadata()` creates a small structured summary:

- action status
- whether confirmation is required
- whether clarification is required
- unresolved blockers
- source attribution metadata
- weak-context signal codes
- whether the response is sufficient

This gives iOS, diagnostics, and future evaluators something more reliable than free-text parsing.

## What This Does Not Do

- It does not hardcode a provider/model.
- It does not enable cross-user tenant-shared memory.
- It does not add a vector store.
- It does not automatically store arbitrary user facts.
- It does not make pending confirmations durable across process restarts.
- It does not prove real provider wording quality.
- It does not replace local full-product or iOS smoke tests.

## Verification

Focused tests:

```bash
npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/state/shared-memory.test.ts __tests__/services/chat-response-sufficiency.test.ts __tests__/api/chat-routes.test.ts __tests__/services/chat-skill-orchestrator.test.ts
```

Result: PASS - 5 files / 70 tests.

Typecheck:

```bash
npm run typecheck
```

Result: PASS.

Day-to-day harness sanity:

```bash
npm test -- --run __tests__/services/chat-day-to-day-simulation.test.ts __tests__/services/chat-evaluation-harness.test.ts
```

Result: PASS - 2 files / 13 tests.

## Open Follow-Ups

| Item | Severity | Reason |
| --- | --- | --- |
| Durable pending-action storage | P1 | Current pending confirmation store is in-memory. Good for current request flow, not restart-safe. |
| Full tenant membership model | P0/P1 by release scope | Needed before cross-user tenant-shared memory can be exposed. |
| Local-engine day-to-day replay | P1 | Fixture tests pass; live local tool/state replay still needed for product-quality claims. |
| Real provider sample | P2 | Needed before claiming live wording/reasoning quality. |
| iOS rendering of response sufficiency metadata | P2 | Backend now emits richer metadata for confirmation responses, but iOS rendering is a separate gate. |

## Release-Gate Verdict

**PASS WITH CONDITIONS.**

This batch improves safety and sufficiency without opening new provider or tenant risks. The remaining blockers are durability and broader workspace semantics, not the core scoped-context implementation.
