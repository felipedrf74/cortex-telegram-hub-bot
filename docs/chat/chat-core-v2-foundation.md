# Chat Core v2 Foundation

Chat Core v2 is a reliability-oriented orchestration layer for Nexus Hub chat. It keeps domain services authoritative and treats model output as a typed proposal, not as product truth.

## Architecture Rule

The intelligence layer chooses what to propose.
The policy and command layer decides what is allowed.
The domain service decides what is true.
The response layer decides how to explain it.

This first foundation PR is intentionally behavior-neutral. It adds executable contracts and metadata that later PRs can wire into routing, context building, command previews, confirmations, evals, and iOS cards.

Subsequent stacked slices have begun wiring the contracts behind default-off rollout flags. The first live slices are `tasks.today_summary`, `secretary.agenda_summary`, `decision_center.summary`, `notifications.summary`, `connections.status`, `finance.summary`, `training.session_explain`, `content.pipeline_summary`, and `cooking.meal_plan_summary`: deterministic, no-model summaries that only run when both `CHAT_CORE_V2_ENABLED` and `CHAT_CORE_V2_READS_ENABLED` are explicitly enabled for the environment, tenant, or user. They do not execute writes, and they return `null` for write-like or multi-domain requests so the existing chat path stays authoritative. The Secretary agenda read uses the tenant-scoped Secretary agenda ledger, not live calendar provider calls. The notifications read uses the tenant-scoped notification center as its source of truth. The connections read uses the canonical integration summary and is treated as credential-adjacent: chat may show provider state, capabilities, and attention needs, but never OAuth scopes, token material, or raw provider error details. The finance read is aggregate-only and policy-gated as `finance.read_summary`: chat may show monthly totals, budget mode, and headroom, but never raw transaction rows, payment/tax execution state, or recurring vendor labels. The training read is health-adjacent and policy-gated as read-only: chat may show active plan/week/session status and adherence, but never exercise JSON, private descriptions, calendar event IDs, or training write proposals. The content read uses tenant-scoped content scheduler/intelligence summaries: chat may show topic counts, status, desk-ready titles, and high-level signal titles, but never raw drafts, script bodies, provider artifacts, calendar event IDs, or model-generated content bodies. The cooking read uses tenant-scoped meal-plan, shopping-list, and pantry summaries: chat may show meal titles, weekly coverage, shopping readiness, and pantry counts, but never recipe instructions, meal notes, pantry notes, recipe IDs, pantry item IDs, or write proposals.

The first live write-intent slices are `tasks.create`, `tasks.complete`, `notifications.snooze`, and `decision_center.dismiss`, all preview-only behind `CHAT_CORE_V2_ENABLED` and `CHAT_CORE_V2_WRITES_ENABLED`. They build typed command envelopes, command-bus preview verdicts, and preview cards, but intentionally do not issue confirmation tokens or mutate data until the v2 confirmation/execution route ships. `tasks.complete`, `notifications.snooze`, and `decision_center.dismiss` also exercise the entity-resolution contract: they only preview when a pending source object is resolved without ambiguity, store source entity versions as execution preconditions, and record status invariants that a future confirmation route must revalidate. Notification snooze stores the proposed snooze window in the command payload while leaving the notification center item unread during preview. Decision dismiss stores the decision version as a typed precondition and leaves the Decision Center item active during preview. `cooking.grocery_item_preview` and `content.brief_draft_preview` are non-executing domain previews behind `CHAT_CORE_V2_ENABLED` and `CHAT_CORE_V2_PREVIEWS_ENABLED`: grocery previews extract concrete grocery items into a draft command and leave the shopping list untouched; content brief previews require explicit brief/briefing language, prepare a draft brief envelope, and do not call the content generator, create drafts, create scripts, or publish anything. The API adapter exposes only the safe command summary needed by iOS; actor authorization, delegated scopes, idempotency keys, and raw permission snapshot strings stay server-side.

## MVP Rollout Shape

- All product domains get deterministic read support first.
- Task create, task complete, notification snooze, and Decision Center dismiss are the first write-intent routes, but they are preview-only until the v2 confirmation endpoint exists.
- Confirmed write execution is narrow in the first MVP: Tasks, Notifications, and Decision Center only.
- Secretary, Training, Cooking, and Content write-like actions start as preview-only; Cooking grocery item and Content brief draft previews are the first wired slices in that lane.
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
