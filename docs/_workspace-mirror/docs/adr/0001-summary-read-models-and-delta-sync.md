# ADR-0001: Summary read models and delta sync for high-traffic surfaces

Status: accepted
Decision date: 2026-05-08
Decided by: workspace lead (Felipe) + Codex
Last verified: 2026-05-08

## Context

Nexus Hub has high-traffic app surfaces such as Home, Tasks, Week, and
Notifications that users expect to open immediately. Those surfaces should not
depend on provider-scale reads, model calls, calendar sync, or broad task
history fetches before first paint. The event outbox, background job queue,
summary read models, and delta sync foundation now exist, so the remaining
decision is whether those projections become the first-paint contract for the
app or remain only an optional warmer.

## Decision

High-traffic app surfaces use app-safe summary read models and delta sync as
their first-paint path. Direct detail routes remain the source of truth for full
data, and read models remain rebuildable projections rather than authoritative
business state.

## Alternatives considered

- **Keep every surface reading full detail routes first**: Rejected because
  large accounts make first paint depend on provider-scale data and can turn
  active daily use into an archive-sized load.
- **Make WebSockets, push, or silent notifications the source of truth**:
  Rejected because Nexus keeps REST/direct routes and durable database state as
  source of truth. Events notify and project state; they do not replace
  deterministic reads and writes.
- **Apply read models to every surface immediately**: Rejected because
  low-traffic surfaces do not yet justify extra projection complexity. Start
  with high-traffic product surfaces and expand when friction proves the need.

## Consequences

- **Positive**: Home, Tasks, Week, and Notifications can render bounded,
  scoped state quickly and refresh details in the background.
- **Negative**: Projection freshness, stale markers, rebuild tooling, and
  projection observability become real operational responsibilities.
- **Operational**: Summary reads must expose freshness/degraded metadata and
  must not call external providers, model routes, or heavy calendar/task
  builders in the user-facing read path.

## Links

- Related code paths: `engine/src/services/app-summary-read-models.ts`,
  `engine/src/api/routes/summaries.ts`,
  `engine/src/services/event-backbone-worker.ts`,
  `ios/Nexus Hub/Core/Repositories/DeltaSyncRepository.swift`
- Closeout dossier: `docs/archive/2026-05/architecture-roadmap/nexus-hub-engine-ios-architecture-roadmap.md`

