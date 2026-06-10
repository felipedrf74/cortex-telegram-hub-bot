# Notification Center Boundary

Status: canonical
Owner: backend architecture lead (Felipe)
Last verified: 2026-06-09
Update policy: update when a producer moves between user notifications, inbox history, operator alerts, or legacy delivery.

## User Notification Center

The user Notification Center is backed by `notification_intents`, `notification_center_items`, and the orchestrator delivery ledger. Producers that call `createNotificationIntent` use the contract registry in `src/services/notification-contracts.ts` for APNs category, iOS destination, privacy-safe copy policy, default delivery, badge contribution, and supported actions.

Current user-facing producers include Decision Center, finance, cooking, chat notification skill, Garmin MFA, scraper MFA, content/report bridge notifications, and scheduler reminders or conflicts that already flow through the orchestrator.

Domain history stores can remain domain-owned. `content_notifications` and report documents are history/read-model stores; their center item is the canonical notification count and badge source. `/api/v1/notifications` may include legacy rows for compatibility/history, but its top-level notification `unreadCount` is owned by `notification_center_items`. Unified Inbox can still add non-notification inbox counts for email, reports, tasks, events, and unbridged history rows because that endpoint is a feed summary rather than the notification-count authority.

## Topic And Delivery Axes

The canonical topic axis is `{sourceSkill, entityType, entityId, recipe}`. Cross-skill coordination items should use a stable recipe such as `cross_skill_impact`; the contract resolver defaults that recipe to in-app, inbox history, and digest delivery rather than one push per impact.

Priority is `passive`, `active`, `time_sensitive`, or `critical`. Critical remains entitlement-gated. Delivery is chosen from `in_app`, `inbox_history`, `push`, `digest`, `local`, `portal_operator`, and `legacy_telegram`.

## Operator And Admin Alert Planes

Operator alerts, cost guardrails, registry cross-tenant alerts, Chat v2 readiness alerts, model-routing alerts, and human-review queues are operational/admin alert planes. They should not be counted in the user Notification Center, should not affect app badges, and should not be coerced into `NotificationIntentType`.

If an operational alert must become user-visible, add a deliberate bridge through `createNotificationIntent` with a contract registry entry and tests for destination, privacy copy, and badge behavior.

## Reliability Snapshot

`POST /api/v1/notifications/reliability-events` records low-cardinality client observations for badge reconciliation and visible read-state mutation failures. `GET /api/v1/notifications/reliability-dashboard` returns a tenant-scoped snapshot for dedupe, digest, push outcome, the same canonical unread badge baseline used by `/api/v1/notifications/unread-count`, latest client-reported badge drift, and recent read-state failure observability.

## Release Gates

The implemented release slice is the durability/count foundation: idempotent intent creation, unique dedupe index parity, tenant-scoped inbox/count/daily-brief reads, canonical bridge-aware unread counts, contract-backed badge contribution, iOS read-state failure surfacing, typed iOS destinations, and badge reconciliation.

Do not enable staged dark fatigue/dedup cohorts, retire compatibility APNs categories, or collapse legacy visual surfaces until focused tests and smoke checks have run green. Those follow-up gates intentionally remain closed when validation execution is prohibited.

## Legacy Telegram

Legacy Telegram delivery remains a separate delivery adapter unless explicitly bridged through the notification contract. User-visible legacy Telegram sends must be reviewed before migration; operator-only Telegram sends stay in the operator plane.
