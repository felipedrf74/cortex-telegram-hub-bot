# Chat Day-To-Day Persona Bank

Generated: 2026-04-29 03:45 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

The runnable persona bank is exported as `DAY_TO_DAY_PERSONAS` from `src/services/chat-day-to-day-simulation.ts`.

| Persona | Coverage Purpose |
| --- | --- |
| Busy professional with Secretary-heavy calendar | Morning planning, schedule conflicts, priority handling, calendar privacy. |
| Training-focused user | Training plan questions, recovery signals, fueling coordination. |
| Content creator with publishing deadlines | Content references, tenant-private strategy, scheduled content work. |
| Finance-conscious user | Purchase/budget questions and Finance-to-Secretary scheduling. |
| Cooking and meal-planning user | Grocery, meal prep, and fueling blocks around availability. |
| Multi-skill power user | Cross-skill orchestration across Secretary, Training, Cooking, Finance, and Content. |
| User belonging to multiple tenants | Tenant switching and memory/history partitioning. |
| Tenant admin | Scoped admin behavior and prompt-injection refusal. |
| Low-context new user | Missing preferences and weak-context handling. |
| Frustrated user after failed action | Tool failure recovery and duplicate prevention. |
| Inconsistent user who changes plans often | Corrections, stale summary repair, updated memory usage. |

## Data Safety

All personas use synthetic tenant IDs `501+` and user IDs `7001+`. They do not contain real email addresses, calendar titles from production, provider tokens, or real user data.

## Required Future Extension

When the full local product engine runner is connected, these fixture personas should map to seeded local tenants/users rather than production or staging identities.
