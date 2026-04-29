# Chat Memory And Summary Model

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Memory Sources

Chat memory currently comes from:

- `shared_memory`
- `conversations`
- `daily_context_cache`
- shared decision context caches

These are now consumed through tenant-aware read paths and rendered through `chat-context-engine`.

## Memory Classes

The model distinguishes:

- Stable user preferences, for example workout timing or content workflow.
- Temporary conversation context, especially recent ambiguous references like "that one".
- Tenant-specific facts, scoped by `tenant_id`.
- Skill-specific state, attributed by source domain.
- Action history, from recent scoped conversation rows.
- Uncertain or stale facts, marked by freshness/confidence metadata.

## Retention And Safety

Memory should not be automatically aggressive. The current implementation only reads existing scoped memory; it does not introduce broad automatic memory writes. Future writes must:

- Require authenticated user and active tenant scope.
- Store source domain.
- Prefer expiration for temporary facts.
- Avoid storing sensitive details unless they are needed for future behavior.
- Support user correction or deletion.

## Correction Behavior

The context engine detects correction language such as "actually", "I changed my mind", or "I meant". Corrections become current-turn intent metadata and should bias the model toward updating/overriding stale assumptions rather than defending prior context.

## Weak Memory

Near-expiring shared memory is treated as low-confidence/stale. The prompt includes weak-context guidance so the model should verify before acting.

## Open Work

- Add explicit memory-write policy for what Chat may retain automatically.
- Add user-visible memory inspection/deletion if Chat memory becomes more proactive.
- Add active tenant membership before tenant-shared memory can be exposed across users.
