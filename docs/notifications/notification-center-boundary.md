# Notification Center Boundary

Status: canonical
Owner: backend architecture lead (Felipe)
Last verified: 2026-06-24
Update policy: update when a producer moves between user notifications, inbox history, operator alerts, or legacy delivery.

## User Notification Center

The user Notification Center is backed by `notification_intents`, `notification_center_items`, and the orchestrator delivery ledger. Producers that call `createNotificationIntent` use the contract registry in `src/services/notification-contracts.ts` for APNs category, iOS destination, privacy-safe copy policy, default delivery, badge contribution, and supported actions.

Current user-facing producers include Decision Center, finance, cooking, chat notification skill, Garmin MFA, scraper MFA, content/report bridge notifications, and scheduler reminders or conflicts that already flow through the orchestrator.

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
| Content approvals | `content`, `content_item` or `topic`, item id | `content_approval` | Approve, rewrite, reject, or inspect content work | `approve_script`, `request_rewrite`, supported content CTA | `open_detail` | `content_home` item/facet route | Push only for active approval; badge while awaiting user | Content review deadline | Topic/item dedupe; content handled/deleted/superseded source cleanup |
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

## Action Quality Gate

Every producer action must resolve through the notification contract registry.
Unsupported buttons are filtered before persistence and a safe `open_detail`
fallback is added when the contract supports it. Generic notification actions
may only open authenticated detail, dismiss the notification, or snooze it.
Domain mutations such as content approval, finance payment completion, cooking
meal updates, chat option resolution, schedule reflow, or provider retry must
flow through Decision Center action execution with deterministic read-back.
The generic Notification Center action route must not mark those actions
successful.

APNs and local lock-screen categories expose only safe generic behavior:
`open_detail`, `dismiss`, and `snooze` where the category supports them.
One-tap domain mutations such as `approve_script`, `request_rewrite`,
`accept_reflow`, `choose_another_time`, `retry`, or `mark_paid` must route the
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

## Legacy Telegram

Legacy Telegram delivery remains a separate delivery adapter unless explicitly bridged through the notification contract. User-visible legacy Telegram sends must be reviewed before migration; operator-only Telegram sends stay in the operator plane.
