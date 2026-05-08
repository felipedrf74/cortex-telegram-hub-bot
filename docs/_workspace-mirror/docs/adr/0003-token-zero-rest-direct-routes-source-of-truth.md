# ADR-0003: Token-zero REST/direct routes stay source of truth

Status: accepted
Decision date: 2026-05-08
Decided by: workspace lead (Felipe) + Codex
Last verified: 2026-05-08

## Context

Nexus Hub is an AI-powered personal operating system, not an AI chat wrapper.
Chat reasoning now interprets structured user intent, but operational app
surfaces such as dashboard, tasks, calendar, training, notifications, settings,
and provider state must remain predictable, cacheable, scoped, and testable.
The product needs a durable rule preventing operational reads and ordinary
writes from drifting back into model/tool execution.

## Decision

Nexus operational reads and ordinary writes continue to use REST/direct routes
and deterministic services as source of truth, even as Chat Reasoning improves.
Chat may interpret, label, plan, clarify, and explain, but Nexus validates and
executes through typed deterministic contracts.

## Alternatives considered

- **Route operational app flows through chat/tools**: Rejected because it
  weakens debuggability, cost control, tenant isolation, provider budgets,
  caching, and latency.
- **Use chat reasoning only for free-form text and avoid operational repair
  flows**: Rejected because users need natural-language correction, structured
  action repair, and safe planning without sacrificing deterministic execution.

## Consequences

- **Positive**: App surfaces remain predictable, cacheable, testable, and
  provider-budgeted.
- **Negative**: Chat reasoning and direct routes must share typed contracts
  instead of one replacing the other.
- **Operational**: No-model-on-operational-read tests and action-frame
  validation remain permanent release gates.

## Links

- Related code paths: `engine/src/services/chat-reasoning-engine.ts`,
  `engine/src/api/routes/chat-message-routes.ts`,
  `engine/src/api/routes/tasks.ts`,
  `ios/Nexus Hub/Core/NexusHTTPClient.swift`
- Closeout dossier: `docs/archive/2026-05/architecture-roadmap/nexus-hub-engine-ios-architecture-roadmap.md`

