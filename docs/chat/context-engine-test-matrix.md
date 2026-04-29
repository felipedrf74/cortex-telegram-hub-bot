# Chat Context Engine Test Matrix

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

| Area | Coverage | Status |
| --- | --- | --- |
| Active tenant retrieval | Same user with two tenants only sees active tenant memory, history, daily context, and shared-decision context. | Added in `chat-context-engine.test.ts`. |
| Private user memory | Another user's memory in the same tenant does not appear. | Added in `chat-context-engine.test.ts`. |
| Ambiguous follow-up | "Move that" without scoped history produces a weak-context clarification. | Added in `chat-context-engine.test.ts`. |
| Tenant switch safety | "Other tenant/workspace" produces a weak-context confirmation signal. | Added in `chat-context-engine.test.ts`. |
| Budget protection | Tight budgets preserve current turn and critical recent history. | Added in `chat-context-engine.test.ts`. |
| Stale memory | Near-expiring memory is marked stale/low-confidence. | Added in `chat-context-engine.test.ts`. |
| Quarantine | Quarantined memory/conversation rows are not exposed. | Added in `chat-context-engine.test.ts`. |
| Intent detection | Multi-domain daily-use phrasing is classified without hardcoding a single canned scenario. | Added in `chat-context-engine.test.ts`. |
| Provider fallback | Fallback provider receives the same scoped state context as primary. | Added in `provider-fallback-domain-routing.test.ts`. |
| OpenAI options bag | OpenAI domain calls now normalize `CallDomainOptions` instead of treating it as a token number. | Covered by OpenAI provider tests/typecheck. |
| Gemini/OpenAI tenant usage metadata | Provider usage logging accepts tenant metadata where migration 083 is present. | Covered by provider tests after argument-shape update. |
| Full day-to-day simulation | Morning planning, tenant switching, corrections, frustration, retries. | Added in `chat-day-to-day-simulation.test.ts`; CLI passed 10 scenarios / 28 turns with average score 1.93 / 2.00. |
| Vector retrieval namespace | No active Chat vector store found. | Open when vector store exists. |
