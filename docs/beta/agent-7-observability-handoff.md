# Agent 7 Observability Handoff

## Alert Lifecycle Summary

Gap 7 extends the existing durable `operator_alerts` table instead of adding a parallel alerting system. Alerts now have two independent lifecycles:

- Human workflow: `open` -> `acknowledged` -> `resolved`.
- Delivery workflow: `pending` -> `delivered`, or `pending`/`failed` -> `dead_letter`, or `not_configured` when the on-call webhook has not been provisioned.

Delivery attempts are retried by the `operator_alert_delivery` scheduled job with bounded exponential backoff. Failed alerts carry attempt count, last attempt time, next attempt time, last sanitized delivery error, and dead-letter timestamp. The operator portal can list alerts, acknowledge, resolve, and manually retry failed/dead-letter/not-configured delivery.

## Changed Files

- `.env.example`
- `migrations/077_operator_alert_delivery.sql`
- `src/services/operator-alerts.ts`
- `src/services/scheduler.ts`
- `src/services/error-monitor.ts`
- `src/services/integration-health.ts`
- `src/services/tenant-scope-observability.ts`
- `src/services/cost-guardrail.ts`
- `src/services/garmin.ts`
- `src/api/auth-middleware.ts`
- `src/api/response-helpers.ts`
- `src/api/routes/auth.ts`
- `src/api/routes/onboarding.ts`
- `src/portal/operations-routes.ts`
- `src/portal/portal.html`
- `docs/OBSERVABILITY-ONCALL.md`
- `docs/DOCUMENTATION-MAP.md`
- `docs/beta/agent-7-observability-handoff.md`
- `__tests__/services/operator-alerts.test.ts`
- `__tests__/services/integration-health-observability.test.ts`
- `__tests__/portal/portal-operations-routes.test.ts`
- `__tests__/api/authenticated-support-routes-scope.test.ts`
- `__tests__/api/connections-routes.test.ts`

## Tests Added

- Alert creation now asserts actionable fields and pending delivery state.
- Delivery success path verifies sender payload and `delivered` state.
- Delivery failure path verifies retry scheduling and dead-lettering.
- Missing webhook path verifies `not_configured`.
- Portal operations route tests cover delivery summary and manual retry.
- Integration health tests cover durable alert creation and portal event emission.
- Tenant scope route test verifies invalid-scope denials produce sanitized operator alert metadata.

## Tests Run

- `npm run typecheck`
- `npx vitest run __tests__/services/operator-alerts.test.ts __tests__/services/integration-health-observability.test.ts __tests__/portal/portal-operations-routes.test.ts __tests__/services/error-monitor.test.ts`
- `npx vitest run __tests__/api/response-helpers.test.ts __tests__/api/auth-routes.test.ts __tests__/api/app-facing-auth-smoke.test.ts __tests__/api/onboarding-degraded-routes.test.ts __tests__/api/onboarding-start.test.ts __tests__/services/cost-guardrail.test.ts __tests__/services/scheduler-user-scope.test.ts __tests__/services/garmin-passive-auth.test.ts`
- `npx vitest run __tests__/api/connections-routes.test.ts __tests__/api/authenticated-support-routes-scope.test.ts __tests__/services/tenant-scope-observability.test.ts __tests__/services/operator-alerts.test.ts`
- `npm test` passed: 331 test files, 5,324 tests.

## Tests Not Run

No external webhook delivery was sent from local validation. The webhook contract is covered by injected sender unit tests; live Slack/PagerDuty/incident-router proof still requires provisioning `OPERATOR_ALERT_WEBHOOK_URL` in the deployment environment.

## Required Env Vars

- `OPERATOR_ALERT_WEBHOOK_URL`: HTTPS endpoint for on-call alert delivery.
- `OPERATOR_ALERT_WEBHOOK_TOKEN`: optional bearer token for the webhook.
- `OPERATOR_ALERT_WEBHOOK_TIMEOUT_MS`: optional timeout, default `5000`.
- `OPERATOR_ALERT_MAX_DELIVERY_ATTEMPTS`: optional retry cap, default `3`.
- `OPERATOR_ALERT_RETRY_BASE_MS`: optional base retry delay, default `60000`.
- `OPERATOR_ALERT_DEFAULT_RUNBOOK_URL`: optional fallback runbook link, default `docs/OBSERVABILITY-ONCALL.md`.

## Remaining Risks

- If the webhook URL is absent, alerts remain visible in the operator portal as `not_configured` and can be retried after env setup, but they will not leave the backend automatically.
- Delivery is HTTP webhook based; channel-specific formatting for Slack/PagerDuty/Opsgenie should live at the receiving integration or a thin relay.
- Deduped open alerts are not re-delivered after an already delivered alert recurs unless delivery had dead-lettered. This avoids on-call spam, but Agent 8 may want an escalation rule later.

## Notes For Agent 5

The operator portal now exposes alert lifecycle actions. Admin/session auditability should verify that `/api/operator-alerts/:id/ack`, `/resolve`, and `/retry-delivery` are captured with the portal actor/session context at the admin audit layer if that layer owns route-level write auditing.

## Notes For Agent 8

`docs/OBSERVABILITY-ONCALL.md` is the operational runbook entry point. Release/runbook work should add the live webhook provider choice, alert receiver URL ownership, token storage location, and a production smoke test: create a synthetic warning alert, confirm webhook delivery, acknowledge it, resolve it, and confirm no secrets appear in the delivered payload.
