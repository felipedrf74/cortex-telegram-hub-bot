# Chat Core v2 Foundation

Chat Core v2 is a reliability-oriented orchestration layer for Nexus Hub chat. It keeps domain services authoritative and treats model output as a typed proposal, not as product truth.

## Architecture Rule

The intelligence layer chooses what to propose.
The policy and command layer decides what is allowed.
The domain service decides what is true.
The response layer decides how to explain it.

This first foundation PR is intentionally behavior-neutral. It adds executable contracts and metadata that later PRs can wire into routing, context building, command previews, confirmations, evals, and iOS cards.

Subsequent stacked slices have begun wiring the contracts behind default-off rollout flags. The first live slices are `tasks.today_summary`, `secretary.agenda_summary`, `decision_center.summary`, `notifications.summary`, and `connections.status`: deterministic, no-model summaries that only run when both `CHAT_CORE_V2_ENABLED` and `CHAT_CORE_V2_READS_ENABLED` are explicitly enabled for the environment, tenant, or user. They do not execute writes, and they return `null` for write-like or multi-domain requests so the existing chat path stays authoritative. The Secretary agenda read uses the tenant-scoped Secretary agenda ledger, not live calendar provider calls. The notifications read uses the tenant-scoped notification center as its source of truth; legacy content notification rows stay out of this Chat Core v2 path until they have equivalent tenant-scoped read-model coverage. The connections read uses the canonical integration summary and is treated as credential-adjacent: chat may show provider state, capabilities, and attention needs, but never OAuth scopes, token material, or raw provider error details.

## MVP Rollout Shape

- All product domains get deterministic read support first.
- Confirmed write execution is narrow in the first MVP: Tasks, Notifications, and Decision Center only.
- Secretary, Training, Cooking, and Content write-like actions start as preview-only.
- Finance restricted actions are blocked or manual-review only until a dedicated finance policy pass.

## First-Class Contracts

- Capability registry: executable metadata for route methods, support level, risk, owner service, permissions, flags, schemas, cards, undo, verification, and sensitivity.
- Reasoning policies: explicit tiers from no-model deterministic reads through background planning, each with runtime budgets.
- Command envelopes: versioned schemas, authorization snapshot, idempotency key, audit context hash, and typed execution preconditions.
- Provider capabilities: strict structured output, tool calling, prompt caching, streaming, token accounting, reasoning effort, and provider-state opt-out are explicit flags.
- Audit and replay: model-run metadata, redacted/encrypted payload classes, retention classes, and replay bundle shape.
- Workflow states: async, human-review, verification, retry, stale, timeout, undo, and policy rejection states are modeled before any broad side effects are enabled.

## Non-Goals In This PR

- No broad live route changes outside the explicitly flag-gated deterministic read slice.
- No command execution changes.
- No old chat fallback changes.
- No provider calls.
- No database migration.

Future PRs should consume these contracts incrementally instead of bypassing them with domain-local one-offs.
