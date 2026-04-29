# Chat Day-To-Day Interaction Risk Map

Generated: 2026-04-29 02:10 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Purpose

Unit tests can prove scoped queries and route contracts. They do not prove a real user will feel Chat is useful, context-aware, safe, and sufficient. This risk map identifies daily interaction risks that the future simulation harness must cover.

## Interaction Risk Matrix

| Scenario | Current capability | Risk | Severity | Required validation |
| --- | --- | --- | --- | --- |
| Morning planning | Secretary route, daily context, fast path `/day` | Context may be stale or user-only; model may overclaim. | P1 | Seed tasks/calendar/training/content and verify sourced, scoped, actionable plan. |
| Schedule change | Secretary tools and active context | Vague “move it” may target wrong item if active context stale. | P1 | Multi-turn schedule mutation tests with confirmation and scoped object IDs. |
| Training question | Triathlon route and training context | Training context is user-scoped; tenant-specific plan context not modeled. | P1 | Tenant-switched Training scenario and stale-plan refusal. |
| Cooking/fueling question | Cooking route and shared decision context | Cooking/Training dependency may be inferred from stale shared context. | P2 | Cross-skill fixture with missing fueling coverage and no duplicate warning. |
| Finance question | Finance route and finance shortcuts | Sensitive finance data may enter prompts/logs; tenant audit incomplete. | P1 | Finance privacy scenario with prompt minimization and no raw error leakage. |
| Content creation | Content route and shortcuts | Tenant-private content strategy could leak through user-only context if workspaces arrive. | P1 | Two-tenant content strategy attack scenario. |
| User correction | Active context and conversation memory | Corrections may be stored as generic memory without provenance/tenant. | P1 | Memory write tests with source, tenant, expiry, and correction semantics. |
| Vague follow-up | Active-domain context with TTL | Better now for REST path; WebSocket path lacks tenant active context. | P1 | “Do the same tomorrow”, “cancel that one”, “move it” tests across tenants. |
| Tenant switching | No true active tenant model yet | Highest risk of stale memory/context carryover if product adds switching. | P0 | Do not claim support until active tenant auth, cache keys, and smoke pass. |
| Memory recall | Shared memory store tenant-aware in branch | Tool writes still default to user tenant; no confidence/freshness model. | P1 | Tenant-specific memory recall and deletion tests. |
| Stale context | Daily context cache and shared decision TTLs | User-only cache can survive tenant switch; stale source freshness not explicit enough. | P1 | Stale calendar/task/training fixtures with freshness labels. |
| Multi-skill request | Router can choose one domain; Secretary should orchestrate | Multi-skill asks may be handled by one skill without arbitration. | P2 | “Plan my week around workouts, grocery, taxes, and filming” scenario. |
| Action confirmation | Some callbacks exist | Destructive actions may vary by tool; confirmation model is not unified. | P1 | Delete/cancel/send external action confirmation tests. |
| Cancellations | Callback/Secretary tools | Ambiguous cancellation can target wrong recent object. | P1 | Confirmation with object ID/source and tenant ownership. |
| Interruptions/retries | Degraded responses and cost lock exist | Retry can duplicate writes if tool idempotency is missing. | P1 | Provider timeout during tool loop and retry idempotency tests. |
| User frustration | No explicit harness | Model may over-apologize or invent details. | P3 | Conversation-quality simulation. |
| Ambiguous instruction | Classifier and active context | May guess instead of targeted clarification. | P2 | Low-confidence classifier + missing context prompt tests. |
| Sensitive context | Prompt context builders exist | Raw private calendar/finance/training context can be injected without minimization metadata. | P1 | Prompt-context minimization tests. |
| Cross-tenant attack | REST route guard and scoped stores partly protect | Domain tools/context caches still need tenant threading. | P0/P1 | “Show me tenant B’s messages/tasks” tests across every object class. |
| Streaming interruption | Experimental WebSocket | No persistence/retry/tenant model for streamed chunks. | P1 if enabled | Keep disabled or add stream lifecycle tests. |

## Simulation Harness Requirements

The harness should run against the full local Nexus product runtime, not a Chat-only mock.

Required personas:

- busy professional with meetings
- multi-skill user with Training, Cooking, Finance, and Content
- tenant/work-context user
- weak-context new user
- user with stale calendar/training state
- frustrated user after failed action
- attacker-style user attempting cross-tenant access

Required scoring dimensions:

- correctness
- tenant safety
- context relevance
- memory use
- source attribution
- skill routing quality
- actionability
- clarification quality
- stale-context avoidance
- hallucination avoidance
- privacy minimization
- recovery after failure

## Local Smoke Requirements

Before release, run or create:

- product health smoke
- REST Chat smoke
- Chat + Secretary smoke
- Chat + Training smoke
- Chat + Cooking smoke
- Chat + Finance smoke
- Chat + Content smoke
- attachment/image preview smoke
- degraded provider response smoke
- cross-tenant attack smoke
- iOS simulator Chat smoke against local backend
- resource cleanup confirmation
