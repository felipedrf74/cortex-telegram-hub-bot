# Observability On-Call Handoff

Date: 2026-04-25

Branch: `beta/single-agent-rc`

Worktree: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/beta-codex-single-agent`

## Inputs Reviewed

- `docs/OBSERVABILITY-ONCALL.md`
- `docs/beta/security-foundation-handoff.md`
- `docs/beta/agent-7-observability-handoff.md`
- Existing alert, scheduler, integration-health, tenant-scope, auth, onboarding, portal operations, and response-helper code

`docs/beta/single-agent-status.md` was not present in this backend worktree at the start of this phase, so this phase recreated the backend-local tracker.

## Reuse Decision

The previous `beta/gap-7-observability` branch contains useful work, but it is not safe to merge because it predates later security/auth/integration changes and would remove current Gap 2, Gap 3, Gap 5, and Gap 6 files. The current `beta/single-agent-rc` branch already contained most of the Gap 7 implementation, so this phase reused it in place and added only narrow hardening changes.

## 2026-04-25 External Staging Drill

The external on-call path has now been exercised in staging:

- a synthetic operator alert was created;
- webhook delivery reached the external receiver;
- the alert was acknowledged;
- the alert was resolved;
- portal/admin audit rows were verified;
- no secrets, OAuth tokens, email contents, health data, fiscal/vendor values,
  or raw user payloads were printed or required for the drill.

If the final production receiver differs from the staging receiver, run one
more production-safe receiver drill after the production env is pointed at the
final destination.

## Alert Lifecycle

Durable alerts use the existing `operator_alerts` table. The current lifecycle is:

- `open`
- `acknowledged`
- `resolved`

Delivery state is tracked independently:

- `pending`
- `delivered`
- `failed`
- `dead_letter`
- `not_configured`

The `operator_alert_delivery` scheduled job runs every minute, delivers due alerts through the configured webhook, retries failures with bounded exponential backoff, and dead-letters exhausted delivery attempts.

## On-Call Delivery Path

Configure delivery with:

```bash
OPERATOR_ALERT_WEBHOOK_URL=https://example.invalid/nexus-alerts
OPERATOR_ALERT_WEBHOOK_TOKEN=
OPERATOR_ALERT_WEBHOOK_TIMEOUT_MS=5000
OPERATOR_ALERT_MAX_DELIVERY_ATTEMPTS=3
OPERATOR_ALERT_RETRY_BASE_MS=60000
OPERATOR_ALERT_DEFAULT_RUNBOOK_URL=docs/OBSERVABILITY-ONCALL.md
```

`OPERATOR_ALERT_WEBHOOK_TOKEN` is optional. When present, it is sent as a bearer token and is not logged or included in alert payloads.

If the URL is missing, alerts become `not_configured`; the portal still shows them, and operators can retry delivery after provisioning the env vars.

## Operator Workflow

The portal operations routes expose:

- list alerts with delivery summary
- acknowledge alert
- resolve alert
- retry failed/dead-letter/not-configured delivery

Alert mutations require admin scope and write portal admin audit entries with the acting portal context.

## Beta-Critical Telemetry

Current coverage:

- Auth: JWT verification, refresh success, invalid/revoked sessions, inactive users, and account switching emit structured logs.
- Onboarding: start/resume/answer/status paths emit structured success, degraded, and failure logs.
- Integration sync: repeated Google/Outlook/Garmin probe failures create durable `integration_health` alerts.
- Tenant isolation denial: scope anomalies fail closed and create critical `tenant_scope` alerts.
- Backend degraded responses: explicit 5xx or `SERVICE_UNAVAILABLE` envelopes now create durable `api_degraded_response` warning alerts with only code, status, and request id metadata.
- Account switching: logout/logout-all now emit `event=account_switching` logs with revoked-device counts.

## Changes Made In This Phase

- Added durable operator alert creation for explicit degraded API responses in `src/api/response-helpers.ts`.
- Added structured `account_switching` fields to iOS logout/logout-all logs in `src/api/routes/auth.ts`.
- Added lifecycle coverage for alert acknowledgement and resolution in `__tests__/services/operator-alerts.test.ts`.
- Added degraded-response alert coverage in `__tests__/api/response-helpers.test.ts`.
- Expanded `docs/OBSERVABILITY-ONCALL.md` with degraded-response and account-switching telemetry guidance.

## Validation Run

Focused observability/auth/API suite:

```bash
npx vitest run __tests__/services/operator-alerts.test.ts __tests__/api/response-helpers.test.ts __tests__/api/auth-session-revocation.test.ts __tests__/portal/portal-operations-routes.test.ts __tests__/services/integration-health-observability.test.ts __tests__/services/tenant-scope-observability.test.ts
```

Result: 6 files, 49 tests passed.

## External Verification Command Reference

The staging external webhook drill passed on 2026-04-25. Keep this command
shape as the reference for future release rehearsals:

```bash
OPERATOR_ALERT_WEBHOOK_URL='<https alert receiver>'
OPERATOR_ALERT_WEBHOOK_TOKEN='<optional bearer token>'
OPERATOR_ALERT_WEBHOOK_TIMEOUT_MS=5000
OPERATOR_ALERT_MAX_DELIVERY_ATTEMPTS=3
OPERATOR_ALERT_RETRY_BASE_MS=60000
OPERATOR_ALERT_DEFAULT_RUNBOOK_URL=docs/OBSERVABILITY-ONCALL.md
```

Then run:

```bash
npm run typecheck
npx vitest run __tests__/services/operator-alerts.test.ts __tests__/portal/portal-operations-routes.test.ts
npm start
```

Expected staging smoke:

- create a synthetic warning alert;
- confirm webhook delivery reaches the chosen receiver;
- confirm alert appears in `/api/operator-alerts`;
- acknowledge it from the portal;
- resolve it from the portal;
- create a synthetic delivery failure and confirm retry/dead-letter behavior;
- confirm no secrets, OAuth tokens, email contents, health data, fiscal/vendor values, or raw user payloads appear in logs or delivered alert JSON.

## Status

Gap 7 is complete for code, local executable proof, and staging external
webhook/on-call verification. A final production receiver drill is optional if
the production receiver differs from the staging receiver.
