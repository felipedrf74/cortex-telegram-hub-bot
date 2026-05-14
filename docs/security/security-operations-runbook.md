# Nexus Hub Security Operations Runbook

Status: canonical
Owner: Felipe Dominguez
Last verified: 2026-05-14
Update policy: update after any security incident, deploy path change, provider
credential change, or infrastructure hardening change.

## Do Not Mutate Production Without Approval

Firewall, Cloudflare, provider, APNs, payment, DNS, and production deploy changes
require a separate approved operations window. This runbook defines the sequence
and evidence to collect; it is not approval to mutate live infrastructure.

## Origin And VPS Hardening Checklist

- Confirm backend/staging API ports bind to loopback or are blocked from the
  public internet except through Cloudflare Tunnel.
- Review currently listening ports and justify each one: SSH, SMB/NetBIOS, RDP,
  API, staging API, content engine, and cloudflared metrics.
- Enable UFW default-deny inbound with explicit allowlist for SSH and required
  Cloudflare/tunnel traffic.
- Add fail2ban for SSH and any exposed auth surface.
- Enforce SSH key-only login and disable password/root login.
- Run a CIS/Lynis audit and store the summary under release evidence.
- Put staging/admin/operator routes behind Cloudflare Access before broad beta.

## Backup Protection And Restore Drill

- Backups containing SQLite, provider tokens, or logs must not be group/world
  readable.
- Encrypt backups before off-host transfer.
- Maintain at least one off-host copy and a documented retention window.
- Quarterly restore drill:
  1. Copy latest backup to isolated test location.
  2. Restore SQLite into a non-production DB path.
  3. Verify app boots against restored DB in fixture/staging mode.
  4. Verify audit trail and user rows are present.
  5. Destroy restored copy and record evidence.

## Incident Playbooks

### Account takeover
- Revoke all sessions/devices for affected user.
- Rotate provider tokens where possible.
- Review audit trail, auth failures, refresh reuse, and device rows.
- Notify affected user when evidence supports compromise.

### Provider token leak
- Rotate/revoke provider token.
- Search logs/Sentry/backups for exposure.
- Disable affected integration until reauthorization is complete.
- Add regression test for the leak vector.

### Cross-tenant data exposure
- Freeze affected route/feature if still exploitable.
- Preserve request logs, audit rows, DB snapshots, and trace IDs.
- Identify affected users/tables/prompts/provider calls.
- Patch with source-level tenant tests before re-enable.
- Assess GDPR/ICO notification obligations.

### Webhook abuse
- Verify signatures/JWS validation and idempotency state.
- Rate-limit or block abusive source while preserving vendor retries.
- Replay from stored event payload only in staging/test mode unless approved.

### Lost JWT/signing key
- Activate backup key per `docs/engineering/jwt-rotation-runbook.md`.
- Set compromised key `verifyUntil` to the shortest safe window.
- Revoke refresh tokens if access-token replay is plausible.

### Compromised VPS
- Isolate host from internet.
- Snapshot disk for evidence.
- Rotate all secrets that ever existed on host.
- Rebuild from trusted image and restore from verified backup.
- Do not trust local logs as complete after compromise.

### Production secret leak
- Rotate secret at source provider.
- Redeploy with new secret.
- Search code, Git history, GitHub Actions logs, Sentry, PM2 logs, backups, and
  smoke evidence for the leaked value.
- Add secret-scanning pattern if the provider is not already covered.

## Breach Evidence Checklist

- Incident start/end time and first detection source.
- Affected tenant/user IDs and data categories.
- Request IDs, trace IDs, audit rows, operator alerts, logs, Sentry event IDs.
- Keys/tokens rotated and provider revocation status.
- User notification decision and GDPR/ICO assessment.
- Tests added to prevent recurrence.
