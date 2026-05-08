# ADR-0002: Active task working set and completed archive

Status: accepted
Decision date: 2026-05-08
Decided by: workspace lead (Felipe) + Codex
Last verified: 2026-05-08

## Context

Nexus Hub task usage includes active daily work and large historical completed
recurring task history. Loading those as one undifferentiated task surface makes
accounts with deep history feel slower even when the user only needs today's
active work. Recent performance work introduced a working-set endpoint, but the
architecture still needs a durable product decision: active work and completed
history are different contracts.

## Decision

Tasks are split into an active working-set contract and a completed history
archive contract. Active work is optimized for first paint and daily use;
completed recurring history is lazy, paginated, and provider-aware.

## Alternatives considered

- **Keep a single all-tasks route**: Rejected because completed recurring
  history can dominate active UX and repeatedly penalize the daily task surface.
- **Hardcode a fixed completed-history window in iOS**: Rejected because
  provider capability, account size, resource budgets, and degraded behavior
  belong in backend policy, not duplicated in views.
- **Delete or rewrite completed history**: Rejected because historical task
  truth must be preserved. The architecture should avoid loading history
  unnecessarily, not erase it.

## Consequences

- **Positive**: Large historical accounts stop penalizing active task
  navigation and Home/Tasks first paint.
- **Negative**: Completed archive UX must handle provider limitations honestly,
  including providers with weak cursor or completed-range support.
- **Operational**: Working-set and archive routes need separate tests for
  scoping, pagination/degraded states, and large-account behavior.

## Links

- Related code paths: `engine/src/api/routes/tasks.ts`,
  `engine/src/services/task-working-set-policy.ts`,
  `ios/Nexus Hub/Core/Repositories/TaskRepository.swift`
- Closeout dossier: `docs/archive/2026-05/architecture-roadmap/nexus-hub-engine-ios-architecture-roadmap.md`

