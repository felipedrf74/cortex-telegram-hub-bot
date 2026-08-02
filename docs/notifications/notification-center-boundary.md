# Notification Center Boundary

Status: canonical
Owner: backend architecture lead (Felipe)
Last verified: 2026-08-02
Update policy: update when a producer moves between user notifications, inbox history, operator alerts, or legacy delivery.

## User Notification Center

The user Notification Center is backed by `notification_intents`, `notification_center_items`, and the orchestrator delivery ledger. Producers that call `createNotificationIntent` use the contract registry in `src/services/notification-contracts.ts` for APNs category, iOS destination, privacy-safe copy policy, default delivery, badge contribution, and supported actions.

Current user-facing producers include Decision Center, finance, cooking, chat
notification skill, Garmin MFA, scraper MFA, content/report bridge
notifications, scheduler reminders or conflicts, and the six scheduled
producers specified below. All of them flow through the orchestrator.

Domain history stores can remain domain-owned. `content_notifications` and report documents are history/read-model stores; their center item is the canonical notification count and badge source. `/api/v1/notifications` may include legacy rows for compatibility/history, but its top-level notification `unreadCount` is owned by `notification_center_items`. Unified Inbox can still add non-notification inbox counts for email, reports, tasks, events, and unbridged history rows because that endpoint is a feed summary rather than the notification-count authority.

## Topic And Delivery Axes

The canonical topic axis is `{sourceSkill, entityType, entityId, recipe}`. Cross-skill coordination items should use a stable recipe such as `cross_skill_impact`; the contract resolver defaults that recipe to in-app, inbox history, and digest delivery rather than one push per impact.

Priority is `passive`, `active`, `time_sensitive`, or `critical`. Critical remains entitlement-gated. Delivery is chosen from `in_app`, `inbox_history`, `push`, `digest`, `local`, `portal_operator`, and `legacy_telegram`.

## Producer Contract Matrix

Every user-visible producer must have a source object, a current next action,
a safe fallback route, expiry, dedupe, and a supersession story. Passive or
inconclusive items should stay in inbox history, digest, or domain history.

| Producer | Source topic | Recipe | User purpose | Primary action | Fallback action | Destination | Delivery / badge | Expiry | Dedupe / supersession |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Decision Center core | `decision_center` or producer skill, entity from source record | `decision_required` | Ask for a concrete user decision | Contract action executable by Decision Center | `open_detail` | `decision_center` or source skill screen | In-app, optional push for active/time-sensitive, badge only when actionable | Decision deadline or source expiry | Stable decision/source key; action completion retires or marks handled |
| Content approvals **(contract only — no production producer; the sole emitter is a QA fixture)** | `content`, `content_item` or `topic`, item id | `content_approval` | Approve, rewrite, reject, or inspect content work | `approve_script`, `request_rewrite`, supported content CTA | `open_detail` | `content_home` item/facet route | Push only for active approval; badge while awaiting user | Content review deadline | Topic/item dedupe; content handled/deleted/superseded source cleanup |
| Secretary daily attention | `secretary`, `task_attention_day`, local date | `daily_task_attention` | Open overdue or due-today task review | `open_detail` to task filter | `dismiss` through center | `nexus://tasks?filter=overdue|dueToday` | In-app only, badge as active decision | End of local day | Per user/tenant/local-day dedupe; daily expiry retires stale cards |
| Secretary reminders and shared tasks | `secretary`, `reminder`/`task`, source id | `reminder` | Bring user to the task/reminder surface | `open_detail` | `snooze`, `dismiss` | `task_list` or concrete task route | Local/APNs where enabled, badge only for unread actionable reminders | Reminder due window | Reminder id dedupe; completed/deleted/expired reminders retire |
| Secretary conflicts | `secretary`, `calendar_conflict`/`agenda_item`, source id | `calendar_conflict` | Resolve or inspect a scheduling conflict | Supported Decision Center reflow/choice action | `open_detail` | `decision_center` or notification detail | In-app and push for time-sensitive conflicts, badge while active | Conflict end/deadline | Agenda/conflict key dedupe; rescheduled/deleted/expired agenda sources retire |
| Finance payments | `finance`, `finance_tax_event`, `YYYY-MM` | `finance_payment` | Mark a tax/payment obligation paid after user confirmation | `mark_paid` | `open_detail` | `finance_home` / finance reminder route | Time-sensitive push allowed, badge while payment decision is open | Payment deadline | Month/user/tenant dedupe; paid or missing tax event supersedes |
| Finance scraper MFA | `finance`, `invoice_scraper_mfa`, provider/source | `scraper_mfa` | Continue an invoice scraper MFA challenge | `open_detail` | `dismiss` | `nexus://finance/invoices/scraper-mfa` | Push allowed while challenge is fresh, badge while open | Short MFA challenge TTL | Provider/source dedupe; challenge expiry or reconnect success retires |
| Cooking | `cooking`, `meal_plan`/`meal_slot`, source id | `meal_plan_adjustment` | Add or inspect meal-plan changes | `add_meal` where payload is executable | `open_detail` or `dismiss` | `cooking_home` / meal-plan route | In-app, optional push for active meal decisions, badge while actionable | Meal planning window | Meal slot/week dedupe; consumed action or expiry retires |
| Content/report bridge | `content` or `reports`, report/topic id | `report_ready`/`content_ready` | Open a generated report or content package | `open_detail` | `dismiss` | `report_detail` or `content_home` | Inbox history/digest by default; badge only for unread active items | Report freshness window | Report/topic dedupe; replacement package supersedes earlier package |
| Content channel relearn | `content`, `channel`, channel id | `channel_relearn` | Inspect relearned channel guidance | `open_detail` | `dismiss` | `content_home` | In-app/inbox history/digest, normally no push | Relearn freshness window | Channel/version dedupe; newer relearn supersedes older |
| Chat notification skill | `chat`, `chat_confirmation`/`chat_choice`, message/action id | `chat_confirmation` | Resolve a user-requested confirmation or choice | Supported chat option action | `open_detail` | Chat or Decision Center recovery route | In-app, push only when user initiated and actionable, badge while pending | Confirmation TTL | Message/action dedupe; answer, cancel, or expiry retires |
| Garmin MFA / security | `security`, `garmin_connection`, `garmin-mfa` | `security_account` | Reconnect Garmin verification | `open_detail` | `dismiss` | `nexus://connections/garmin/reauth` | Time-sensitive push allowed, badge while reconnect is needed | Short verification TTL | Per owner tenant dedupe; reconnect success or expiry retires |
| Training | `training`, `training_session`/`training_plan`, source id | `training_schedule` | Open current plan/session or recovery guidance | Supported schedule/reflow Decision Center action | `open_detail` | `training_home` / session route | In-app and push for active schedule changes, badge while action needed | Session/plan window | Session/plan dedupe; completed/rescheduled/deleted plans retire |
| Shared list/task notifications | `secretary` or `tasks`, `shared_list`/`task`, source id | `shared_task_attention` | Open the shared task/list item needing attention | `open_detail` | `snooze`, `dismiss` | `task_list` or task detail route | In-app/local/push per reminder policy, badge while active | Due date or reminder TTL | List/task id dedupe; completed/deleted/unshared sources retire |

## Implemented Scheduled Producer Contracts

These are the six producers added from the notification plan. The trigger
column states what the code actually evaluates, including where that differs
from the aspirational catalog. Cron expressions use the single configured
application timezone (`config.app.timezone`), not each user's profile zone.

| Producer | Real trigger and user value | Intent and actions | Delivery, badge, and expiry | Dedupe / supersession |
| --- | --- | --- | --- | --- |
| Training session reminder (`training_session_reminder`, every 5 min) | Existing notification profile, Training enabled, positive `workout_reminder_minutes`, and an active Nexus agenda row from Training whose start is in `[now + lead, +5 min)`. Honours the lead time the user explicitly chose. | `training/reminder`, active; Open session and Snooze, with Dismiss supported by the reminder category; `nexus://training/session/<agendaItemId>`. | Central auto ladder: durable in-app item and push when all gates allow; health-private copy; no badge because the producer does not require a decision. Expires exactly at session start. | `training:session_reminder:<agendaItemId>`; one reminder per session, and inactive/cancelled agenda rows do not qualify. |
| Commitment start reminder (`commitment_start_reminder`, every 5 min) | Existing notification profile, Secretary enabled, positive `default_reminder_minutes`, and an active non-Training Nexus agenda row in the same 5-minute lead window; at most 4 rows per user per sweep. Protects the last recoverable moment before lateness. | `secretary/reminder`, time-sensitive; Open and Snooze, with Dismiss supported by the reminder category; Notification Center destination. | Central auto ladder; sensitive title policy; no badge because it is informational. The commitment start is both `decisionDeadline` and expiry, so a late reminder cannot ship. | `secretary:commitment_reminder:<agendaItemId>`; one per Nexus-owned commitment. Training rows are excluded to prevent a double notification. |
| Finance tax deadline (`finance_tax_deadline`, 09:10 daily) | Existing notification profile, Finance enabled, unpaid positive-liability tax event. The code derives the due instant as the 20th at 09:00 UTC: `due_soon` when the due day is within `finance_reminder_days` (default 1), then `due_today`. Protects a statutory deadline without exposing amounts or references. | `finance/decision_required`; active for due-soon, time-sensitive for due-today; Mark paid and Open in app. `mark_paid` is never a lock-screen mutation: `FINANCE_PAYMENT` exposes Open/Dismiss and Decision Center performs the confirmed write. | Push-eligible through the central ladder and badges while the payment decision is open. Due-soon expires at start of the due day; due-today at end of that day. | `finance:tax_deadline:<stage>:<YYYY-MM>`; separate stage keys preserve escalation. Paying the matching tax event retires the notification synchronously. |
| Decision recovery (`decision_recovery_notify`, every 10 min) | Unswept `action_partially_failed`, `rolled_back`, `execution_reconciled`, or `unblocked` lifecycle events from the last 60 minutes, oldest first, maximum 20 per sweep, for users who already have a notification profile. Makes partial, reversed, reconciled, or newly unblocked work visible. | Active system notice with Open to Decision Center. Partial-failure, rollback, and reconciliation events use `decision_required` and require user action; `unblocked` uses informational `schedule_changed`. | All 4 are push-eligible through the central ladder; the first 3 badge, while `unblocked` does not. No producer expiry is supplied, so the normalizer applies the active default of 7 days. | `system:decision_recovery:<eventId>` is both durable cursor and dedupe; separate lifecycle failures on one decision remain separate notices. |
| Travel cross-skill digest (`travel_window_notify`, 08:40 daily) | Existing notification profile, trip starts after today and within 3 days, and at least 1 active Nexus agenda item overlaps the trip. Counts impact by skill without exposing commitment titles. Gives one coordinated view of what travel changes. | `secretary/schedule_changed`, passive, `cross_skill_impact`; Review/Open the coordinated plan. | Contract is digest-only: in-app/inbox history plus a composed digest, never a standalone interrupt; no badge. Expires at 23:59:59.999 UTC on the trip start date so the morning digest is not filtered out. | `secretary:travel_window:<tripId>`; one notice per trip. A trip with no locally known impact stays silent. |
| Google/Outlook reconnect (`connection_health_notify`, 09:25 and 18:25 daily) | User-scoped integration summary reports Google or Outlook as `revoked`, derived only from a durable `auth_rejected` row for a deterministic rejection of that user's current refresh token. Re-auth or a successful refresh clears it; healthy, disconnected, transient `degraded`, and global probe states do not qualify. Tells the user when stale provider data is degrading agenda, conflict, mail, or task surfaces. | `system/sync_failure`, active, requires action; Reconnect plus Open to `nexus://connections`; the explicit connection action selects `DECISION_RECONNECT`. | Central auto ladder; push-eligible and badged while actionable. `sync_failure` has the normalizer's 24-hour default expiry. A missing profile is not treated as opt-out; an existing System-skill opt-out is honoured. | `system:connection_health:<provider>:<3-day-bucket>`; bounds re-notification cadence by provider. Only per-user state is read; the owner-scoped operator health probe is never bridged into the user center. |

## Action Quality Gate

Every producer action must resolve through the notification contract registry.
Unsupported buttons are filtered before persistence and a safe `open_detail`
fallback is added when the contract supports it. Generic notification actions
may only open authenticated detail, dismiss the notification, snooze it, or
`reconnect` (navigate to connection settings).
Domain mutations such as content approval, finance payment completion, cooking
meal updates, chat option resolution, or schedule reflow must
flow through Decision Center action execution with deterministic read-back.
The generic Notification Center action route must not mark those actions
successful.

APNs and local lock-screen categories expose only safe generic behavior:
`open_detail`, `dismiss`, and `snooze` where the category supports them.
One-tap domain mutations such as `approve_script`, `request_rewrite`,
`accept_reflow`, `choose_another_time`, or `mark_paid` must route the
user into Nexus for confirmation and backend execution. Backend Decision Center
action execution rejects `channel=apns` for domain-mutating actions even if a
legacy client sends one.
The APNs category registry is part of the release gate: every static category
action must satisfy the same truth-table predicate as backend APNs execution,
so category drift fails before release.

The intent normalizer also owns the reliability floor: missing or unsupported
deeplinks are downgraded to `nexus://notifications`, legacy `nexushub://` and
external `https://` producer deeplinks are treated as non-app-routable, missing
producer expiry becomes a bounded default expiry, and source-skill privacy
policies cannot be loosened by a producer override. App badge counts are
limited to active unread items that still have `requires_user_action=1`.
Producer intents that request user action without a source object are
downgraded to passive digest behavior before persistence.
Notification Center action state and Decision Center action state share the
same capability predicate, frontend-safety predicate, stale/expiry lifecycle,
and dependency-blocking inputs. If a joined Decision Center row cannot safely
execute from the frontend, both surfaces must serialize the same disabled
state instead of letting the inbox guess.
All inbox projections that map a decision-shaped center row must carry the
same joined intent context: list reads, single-item reads, read/dismiss/snooze
responses, and active dedupe returns. A decision row without joined intent
context fails closed as `disabled_missing_details`; non-decision reminders may
continue using their producer contract without Decision Center context.

Finance payment reminders that expose `mark_paid` are Decision Center
`decision_required` items and use the `FINANCE_PAYMENT` APNs category. Generic
reminders use the `reminder` category with `open_detail`, `snooze`, and
`dismiss` only.

## Operator And Admin Alert Planes

Operator alerts, cost guardrails, registry cross-tenant alerts, Chat v2 readiness alerts, model-routing alerts, and human-review queues are operational/admin alert planes. They should not be counted in the user Notification Center, should not affect app badges, and should not be coerced into `NotificationIntentType`.

If an operational alert must become user-visible, add a deliberate bridge through `createNotificationIntent` with a contract registry entry and tests for destination, privacy copy, and badge behavior.

## Reliability Snapshot

`POST /api/v1/notifications/reliability-events` records low-cardinality client observations for badge reconciliation and visible read-state mutation failures. `GET /api/v1/notifications/reliability-dashboard` returns a tenant-scoped snapshot for dedupe, digest, push outcome, the same canonical unread badge baseline used by `/api/v1/notifications/unread-count`, latest client-reported badge drift, and recent read-state failure observability.

The reliability dashboard also reports suppressed/gated notifications,
unsupported generic action attempts, action failures, active dead deeplinks,
and any generic mutating action successes. Release review treats non-zero
generic mutating action successes as a blocker because it means a notification
claimed domain work without the Decision Center executor path.
Topic breakdowns are exposed by `sourceSkill`, notification `type`, and
`recipe` for notification-owned reliability signals. Badge drift is only an
aggregate dashboard field; per-topic rows must not synthesize wildcard
`sourceSkill/type/recipe` entries because the current iOS badge reconciliation
event reports one app badge count, not a source notification id.

Badge counts are driven from `notification_center_items` rows whose
`requires_user_action` flag is materialized from the producing intent. This
keeps badge reconciliation fast and prevents passive inbox/history items from
contributing to app badges.

Stale-source cleanup is enforced by expiry sweeps and Decision Center
source-state supersession for implemented source families: content items that
have resolved, Secretary agenda/task attention that has expired or changed,
training plans/sessions that are no longer current, and finance tax events
that are paid or missing. Producers without a richer source read model must
use short expiry plus stable dedupe until the domain exposes an authoritative
completion/deletion signal.
The authenticated inbox list mirrors the Decision Center stale-source filter:
requires-user-action rows with stale provider/source evidence are not
user-visible until refreshed or retired.
For Secretary `secretary_agenda_item` decisions, the stale-source predicate is
live, not snapshot-only: inbox filtering re-reads the agenda row's provider
sync state and update timestamp before deciding visibility, matching Decision
Center. If Decision Center guidance is explicitly disabled for the user/skill,
the inbox follows the same guidance-disabled visibility short-circuit after
privacy and safe-to-show checks.

REST writes that resolve source state must run the same retirement contract
used by in-app Decision Center actions. Finance tax-event payment now retires
the matching payment notification synchronously through a targeted
`finance_tax_event` supersession and invalidates inbox caches. It must not run
a cross-skill supersession sweep on the request path.
Known same-class lag risks to keep under this boundary are
`training_plan_changed_elsewhere` and `calendar_conflict_resolved_elsewhere`;
they remain governed by source-state supersession until their domains expose a
more direct write-path retirement hook.

## Release Gates

The implemented release slice is the durability/count/actionability foundation:
idempotent intent creation, unique dedupe index parity, tenant-scoped
inbox/count/daily-brief reads, canonical bridge-aware unread counts,
contract-backed badge contribution, contract-filtered actions, iOS action
effectiveness metadata, iOS read-state failure surfacing, typed iOS
destinations, and badge reconciliation.

`getDecisionReleaseGateStatus` is the release gate for this slice. It must
report `expiredButVisible=0`, `unimplementedActionableCtas=0`,
`unsupportedNotificationActions=0`, `deadDeeplinks=0`, `badgeDrift` as `0` or
`null` when no client badge report exists, and
`genericMutatingActionSuccesses=0`. It also fails when APNs category/contract
actions expose anything the APNs truth table disallows, or when stale-source
requires-user-action decisions remain visible through the inbox path.

Do not enable staged dark fatigue/dedup cohorts, retire compatibility APNs categories, or collapse legacy visual surfaces until focused tests and smoke checks have run green. Those follow-up gates intentionally remain closed when validation execution is prohibited.

## Delivery Invariants

These hold at the delivery ladder, not only on read paths. Each replaced a
case where a setting or control did not do what it said.

- **Snooze re-delivers.** `snoozeNotificationCenterItem` clamps the target to
  `[5 min, 7 days]` and `releaseDueSnoozedNotifications` (carried by the
  existing `notification_release` sweep) returns the item to `unread` and
  re-interrupts at its original priority. Re-delivery re-applies quiet hours,
  the preference gate and the decision quality gate, so snooze cannot be used
  to obtain a push the gate already refused. After `SNOOZE_MAX_COUNT` snoozes
  the item returns to the inbox without interrupting again.
- **Per-type mute stops the push.** `decision_type_suppressions` is consulted
  in the delivery ladder, not only by the read filter, and the badge query
  applies the same predicate so the badge cannot count rows the list hides.
  `security_account` is never suppressible. The suppression read fails
  **closed** here (degrade to in-app) while the read filter fails **open**:
  the durable item exists either way, so only the interrupt is at stake.
- **Queued deliveries re-check preferences.** The release sweep re-evaluates
  the skill gate, `pushEnabled`, delivery policy and per-type mute before
  sending, so turning push off drains the queue instead of flushing it.
- **Queued deliveries re-check the durable interrupt budget.** Digest and
  quiet-hours rows are serialized by user and re-count persisted `sent_push`
  decisions at the last synchronous boundary before APNs. A digest charges
  only its carrier row. A budget-blocked quiet-hours row moves once to the next
  digest; a budget-blocked due digest remains available in-app instead of
  waking every 15 minutes until the cap resets.
- **The legacy Reminders toggle remains a push gate.** For every `reminder`
  intent, `push_preferences(user_id, 'reminders') = disabled` produces an
  in-app item without an interrupt. A genuinely missing legacy table preserves
  its historical default-enabled behavior; any other read fault fails closed,
  and an already-queued row stays queued for a later safe re-read rather than
  being discarded.
- **Queued deliveries keep their interruption level**, so `apns-expiration`
  is not silently `0` (now-or-drop) for a deferred time-sensitive item.
- **`insight` never pushes.** `deliveryPolicyForNotificationContract` returns
  `digest_only` for it, matching the contract's own `defaultDelivery`. Other
  types omit `push` from `defaultDelivery` yet legitimately push under `auto`
  — there, `defaultDelivery` lists guaranteed channels, not the permitted set.
- **`reconnect` replaces `retry`.** `retry` had no executor and rendered
  permanently disabled while `sync_failure` floored it to the top of the
  queue. `reconnect` is navigation, needs no executor, and is safe from the
  lock screen. `enforceNotificationActionContract` rewrites legacy `retry`
  requests, so producers did not need individual edits. The `retry` truth-table
  row is retained only so historical rows still resolve.
- **No producer may call APNs directly.** `createNotificationIntent` is the
  only path; the chat-v2 background command worker was the last bypass.
- **Titles carry no emoji.** Stripped at the normalizer — VoiceOver announces
  them verbatim. What is stripped is emoji PRESENTATION (intrinsic, or forced
  by a VS16 selector), not `Extended_Pictographic`, which would also delete
  © ® ™ ♀ from the user's own prose. An emoji-only title is not rejected at the
  producer: `notificationTitleOrFallback` degrades it to a generic title,
  because silence is worse than a less specific headline.
- **Notification history ages out.** `pruneNotificationRetention` runs in
  `midnight_cleanup`: terminal center items at 90d, delivery attempts and
  reliability events at 30d, engagement events at 180d, priority-shadow rows at
  90d. Unresolved items are kept regardless of age.
  - Retention is **cohort-consistent**, not purely age-based. Engagement events
    and decision logs are retained for as long as the item they describe
    exists, because the item table is status-aware and an unresolved item is
    immortal. Pruning a 200-day-old `surfaced` event while its item lives on
    would leave a later `opened` with no denominator, and any open-rate
    computed from the table would exceed reality — silently corrupting the
    dataset the fatigue model is being collected for.
  - Subject-access export covers `notification_priority_shadow` too. Erasure
    already did, via the `sqlite_master` walk for `user_id` columns.
- **Subject-access exports include the notification store** — profile, center
  items (including bodies), decision logs, type suppressions and engagement
  events. Device tokens alone under-disclosed the most sensitive store here.

New producers must be user-scoped. `connection-health-notifier` is built on
`getIntegrationSummary(userId)` — the per-user connection state — and NOT on
the `integration_health` probe, which runs against the configured owner
credentials with no user scope. Bridging that probe would notify every tenant
about a single-tenant ops event they cannot act on, which is exactly what the
operator-plane boundary exists to prevent.

`notification_engagement_events` is a **write-only** instrumentation table for
now. Nothing scores off it; it exists so a later fatigue/priority model has
history to tune against instead of shipping blind.

## Proven Scope And Deferred Proof

- **Provider-only calendar events remain unavailable to scheduled producers.**
  Training lead-time, commitment lead-time, and travel-impact reads use
  `secretary_agenda_items`, which covers commitments Nexus has materialized.
  Google/Outlook events that exist only at the provider are not cached locally
  and are therefore absent. A tenant-scoped provider-event cache is the
  prerequisite; live provider reads from every 5-minute sweep are not an
  acceptable substitute.
- **Civil-time scheduling is application-scoped today.** The 09:10, 08:40,
  09:25, and 18:25 producer slots run in `config.app.timezone`; finance due-day
  and travel lead-window date arithmetic is UTC. Do not describe these as
  per-user local-time notifications until the scheduler and date calculations
  consume the profile zone.
- **APNs retry and device behavior do not have production/device proof here.**
  Unit coverage classifies 429/5xx/network outcomes as `retriable` and retries
  a token against the alternate APNs environment on a token-environment
  mismatch, but Nexus has no durable resend queue for transient provider
  failures. Production credentials, store-and-forward behavior, 410 cleanup,
  and provisional-to-full authorization delivery require a signed build and a
  physical-device run. That evidence is owner-gated; simulator success is not
  a substitute.
- **Priority scoring is shadow-only.** The scoring model never changes order,
  priority, interruption level, or delivery. When the explicit
  `NOTIFICATION_PRIORITY_SHADOW_SCORING_ENABLED` opt-in is enabled it records
  an incomplete comparison row; when disabled it records nothing. The
  production flag state is not asserted by this document, and promotion from
  shadow requires observed engagement evidence and a separately approved
  rollout.

## Legacy Telegram

Legacy Telegram delivery remains a separate delivery adapter unless explicitly bridged through the notification contract. User-visible legacy Telegram sends must be reviewed before migration; operator-only Telegram sends stay in the operator plane.
