# Chat Core v2 Foundation

Chat Core v2 is a reliability-oriented orchestration layer for Nexus Hub chat. It keeps domain services authoritative and treats model output as a typed proposal, not as product truth.

## Architecture Rule

The intelligence layer chooses what to propose.
The policy and command layer decides what is allowed.
The domain service decides what is true.
The response layer decides how to explain it.

This first foundation PR is intentionally behavior-neutral. It adds executable contracts and metadata that later PRs can wire into routing, context building, command previews, confirmations, evals, and iOS cards.

Subsequent stacked slices have begun wiring the contracts behind default-off rollout flags. The first live slices are `tasks.today_summary`, `secretary.agenda_summary`, `decision_center.summary`, `notifications.summary`, `connections.status`, `finance.summary`, `training.session_explain`, `content.pipeline_summary`, and `cooking.meal_plan_summary`: deterministic, no-model summaries that only run when both `CHAT_CORE_V2_ENABLED` and `CHAT_CORE_V2_READS_ENABLED` are explicitly enabled for the environment, tenant, or user. They do not execute writes, and they return `null` for write-like or multi-domain requests so the existing chat path stays authoritative. The Secretary agenda read uses the tenant-scoped Secretary agenda ledger, not live calendar provider calls. The notifications read uses the tenant-scoped notification center as its source of truth. The connections read uses the canonical integration summary and is treated as credential-adjacent: chat may show provider state, capabilities, and attention needs, but never OAuth scopes, token material, or raw provider error details. The finance read is aggregate-only and policy-gated as `finance.read_summary`: chat may show monthly totals, budget mode, and headroom, but never raw transaction rows, payment/tax execution state, or recurring vendor labels. The training read is health-adjacent and policy-gated as read-only: chat may show active plan/week/session status and adherence, but never exercise JSON, private descriptions, calendar event IDs, or training write proposals. The content read uses tenant-scoped content scheduler/intelligence summaries: chat may show topic counts, status, desk-ready titles, and high-level signal titles, but never raw drafts, script bodies, provider artifacts, calendar event IDs, or model-generated content bodies. The cooking read uses tenant-scoped meal-plan, shopping-list, and pantry summaries: chat may show meal titles, weekly coverage, shopping readiness, and pantry counts, but never recipe instructions, meal notes, pantry notes, recipe IDs, pantry item IDs, or write proposals.

The first live write-intent slices are `tasks.create`, `tasks.complete`, `notifications.snooze`, and `decision_center.dismiss`, all behind `CHAT_CORE_V2_ENABLED` and `CHAT_CORE_V2_WRITES_ENABLED`. When `CHAT_CORE_V2_CONFIRMATIONS_ENABLED` is also enabled, they issue signed confirmation tokens, store short-lived v2 pending commands, execute only after `/api/v1/chat/confirm-action`, re-run the command-bus execute gate, call the canonical owner service, verify the write by reading back the source row, and replay duplicate confirmations without creating, completing, snoozing, or dismissing twice. `tasks.complete` re-reads the resolved task at confirmation time and rejects stale previews when the task version or pending-status invariant changed. `notifications.snooze` re-reads the resolved notification at confirmation time and rejects stale previews when the notification content version or snooze-eligible status invariant changed; read-state changes are allowed because read notifications remain snoozeable. `decision_center.dismiss` re-reads the resolved decision at confirmation time, compares the typed dismiss version, requires the decision to still be dismissible, dismisses through the canonical Decision Center service, and verifies the item status by read-back; read-state changes are allowed because read decisions remain dismissible. Preview candidate filters and confirmation invariants must share one eligibility helper, and command-specific version hashes must exclude read-only status drift while still rejecting terminal states and content changes. When the confirmations flag is off, these commands remain preview-only. `secretary.schedule_event_preview`, `training.modify_session_preview`, `cooking.grocery_item_preview`, and `content.brief_draft_preview` are non-executing domain previews behind `CHAT_CORE_V2_ENABLED` and `CHAT_CORE_V2_PREVIEWS_ENABLED`: Secretary schedule previews require a concrete parsed title/date/time, prepare a calendar-event draft envelope, and do not create provider events or send invites; Training previews are limited to reducing the load/intensity of one resolvable active session, store plan/session versions plus safety-policy invariants, and do not alter the training plan; grocery previews extract concrete grocery items into a draft command and leave the shopping list untouched; content brief previews require explicit brief/briefing language, prepare a draft brief envelope, and do not call the content generator, create drafts, create scripts, or publish anything. The API adapter exposes only the safe command summary needed by iOS; actor authorization, delegated scopes, idempotency keys, and raw permission snapshot strings stay server-side.

## MVP Rollout Shape

- All product domains get deterministic read support first.
- Task create, task complete, notification snooze, and Decision Center dismiss are the first confirmed execution slices behind `CHAT_CORE_V2_CONFIRMATIONS_ENABLED`.
- Confirmed write execution is narrow in the first MVP: task create first, then task complete, Notifications, and Decision Center in separate gated slices.
- Secretary, Training, Cooking, and Content write-like actions start as preview-only; Secretary schedule event, Training lighter-session, Cooking grocery item, and Content brief draft previews are the first wired slices in that lane.
- Finance restricted actions are blocked or manual-review only until a dedicated finance policy pass.

## First-Class Contracts

- Capability registry: executable metadata for route methods, support level, risk, owner service, permissions, flags, schemas, cards, undo, verification, and sensitivity.
- Reasoning policies: explicit tiers from no-model deterministic reads through background planning, each with runtime budgets.
- Command envelopes: versioned schemas, authorization snapshot, idempotency key, audit context hash, and typed execution preconditions.
- Provider capabilities: strict structured output, tool calling, prompt caching, streaming, token accounting, reasoning effort, and provider-state opt-out are explicit flags.
- Audit and replay: model-run metadata, redacted/encrypted payload classes, retention classes, and replay bundle shape.
- Workflow states: async, human-review, verification, retry, stale, timeout, undo, and policy rejection states are modeled before any broad side effects are enabled.

## Non-Goals In This PR

- No broad live route changes outside the explicitly flag-gated Chat Core v2 slices.
- No broad command execution changes outside the explicitly flag-gated `tasks.create` confirmation slice.
- No old chat fallback changes.
- No new direct provider calls; `tasks.create` execution uses the existing task service and its established provider/fallback behavior.
- No database migration.

Future PRs should consume these contracts incrementally instead of bypassing them with domain-local one-offs.
