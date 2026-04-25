# Observability / On-Call Loop

This document covers the backend alert loop for Nexus Hub operators. It is not
a release checklist; it describes how durable operator alerts are created,
delivered, acknowledged, resolved, and recovered.

## Last Verified Drill

2026-04-25 staging drill passed:

- synthetic alert created;
- external webhook delivery succeeded;
- alert acknowledged;
- alert resolved;
- portal/admin audit rows verified.

Production backend is live at `4.14.74`. If the final production alert receiver
differs from the staging receiver, run one additional production-safe delivery
drill after changing the receiver env.

## Alert Lifecycle

Operator alerts are stored in `operator_alerts`.

- `status = open`: alert has been created and still needs operator attention.
- `delivery_status = pending`: alert is waiting for delivery to the on-call sink.
- `delivery_status = delivered`: the configured webhook returned a 2xx response.
- `delivery_status = failed`: delivery failed and `next_delivery_attempt_at` is set.
- `delivery_status = dead_letter`: delivery exhausted retry attempts.
- `delivery_status = not_configured`: no external webhook is configured.
- `status = acknowledged`: an operator has accepted ownership.
- `status = resolved`: the incident is closed.

The portal exposes this queue under `/admin#alerts`. Operators can acknowledge,
resolve, and requeue failed delivery from that surface.

## On-Call Delivery

Configure a webhook integration with:

```bash
OPERATOR_ALERT_WEBHOOK_URL=https://example.invalid/nexus-alerts
OPERATOR_ALERT_WEBHOOK_TOKEN=
OPERATOR_ALERT_WEBHOOK_TIMEOUT_MS=5000
OPERATOR_ALERT_MAX_DELIVERY_ATTEMPTS=3
OPERATOR_ALERT_RETRY_BASE_MS=60000
OPERATOR_ALERT_DEFAULT_RUNBOOK_URL=docs/OBSERVABILITY-ONCALL.md
```

`OPERATOR_ALERT_WEBHOOK_TOKEN` is optional. When present, Nexus sends it as a
Bearer token and never logs it.

The webhook receives sanitized JSON only: alert id, severity, source, title,
detail, owner, suspected area, user impact, runbook URL, occurrence count, and
sanitized metadata. Secrets, tokens, raw email/message payloads, health data,
fiscal/vendor values, and other raw user data are redacted by the alert service.

## Alert Sources

Current durable alert producers:

- `error_monitor:*`: unhandled backend/API/job/process errors.
- `scheduler`: scheduled job failures.
- `integration_health`: repeated Google/Outlook/Garmin probe failures.
- `tenant_scope`: tenant isolation denials and invalid scoped reads/writes.
- `cost_guardrail`: global AI spend crosses configured alert tiers.
- `api_degraded_response`: explicit backend 5xx or service-unavailable response
  envelopes returned to app-facing clients.

## Scheduled Job Failures

When a cron job throws, the telemetry wrapper records the job failure and the
scheduler failure notifier creates a critical operator alert. Check:

- `/admin#alerts` for acknowledgement and delivery state.
- `/admin#jobs` for last run status and job history.
- PM2 logs only for deeper stack detail after the alert has identified the job.

## Integration Health Alerts

Integration probes run every five minutes. A provider alert fires when the
provider reaches the repeated-failure threshold. The alert dedupes by provider
while it remains open.

Typical actions:

- Check whether the provider token expired or refresh failed.
- Validate whether the issue affects one user or a global/owner bridge.
- Resolve after a successful probe or after credentials are repaired.

## Tenant Isolation Alerts

Tenant scope anomalies are critical because they represent a path that would
have been unsafe to run. The runtime should fail closed and alert.

Typical actions:

- Check the route/service named in `suspected_area` and metadata.
- Confirm the caller has a valid authenticated `userId`.
- Coordinate with Agent 5 if admin/session auditability needs additional
  actor/session proof.

## Error Monitor Alerts

Unhandled API/job/process errors are persisted to `error_log`, forwarded to
Sentry when configured, and mirrored into `operator_alerts`.

Typical actions:

- Start with `/admin#alerts` for status and runbook context.
- Use the `reqId` from logs/Sentry when available.
- Acknowledge once investigating; resolve only after the failing path is fixed
  or known to have recovered.

## Backend Degraded Responses

Routes that intentionally return a client-safe 5xx or `SERVICE_UNAVAILABLE`
envelope now create a deduped warning alert even when the route handled the
exception locally. The alert metadata is limited to code, HTTP status, and
request id; raw route details are not copied into the alert payload.

Typical actions:

- Use the request id to find the structured log line for the failing route.
- Confirm whether the iOS app is showing a retryable degraded state.
- Resolve after the backend dependency or route has recovered.

## Account Switching Telemetry

iOS `POST /api/v1/auth/logout` and `POST /api/v1/auth/logout-all` emit
structured `event=account_switching` logs with the number of revoked devices.
This is intentionally logged, not alerted, because account switching is a
normal user action unless accompanied by auth failures or tenant-scope denials.

## Cost Guardrail Alerts

Cost guardrail alerts fire at configured tiers for the current UTC day. These
alerts are actionable when AI-backed flows may be throttled or degraded.

Typical actions:

- Check `/admin#ai` and cost by domain.
- Confirm whether fallback providers are unexpectedly active.
- Adjust routing or caps only after identifying the spend source.
