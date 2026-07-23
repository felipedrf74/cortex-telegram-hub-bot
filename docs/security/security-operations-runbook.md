# Nexus Hub Security Operations Runbook

Status: canonical
Owner: Felipe Dominguez
Last verified: 2026-07-22
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
- The root-owned `nexus-application-dr-backup.timer` creates an online SQLite
  recovery point hourly and encrypts it with an off-host `age` recipient before
  S3-compatible upload. Retain 24 hourly, 7 daily, 4 weekly, and 6 monthly
  database points.
- Escrow every exact-release rollback archive off-host for 90 days; keep the
  existing latest-ten local policy. A missing timer run, failed upload, or
  unverified remote metadata is an alert, not a silent RPO exception.
- Keep the private `age` identity off ServerDominguez. Bucket credentials are
  prefix-scoped, mode-0600 configuration or instance identity; plaintext never
  leaves the private temporary directory.
- Quarterly restore drill:
  1. Use `scripts/application-dr-restore-drill.sh` on an isolated host with the
     newest hourly point and a compatible exact-release escrow object.
  2. Verify encrypted and plaintext digests, SQLite integrity/foreign keys, and
     safe exact-release extraction into a private scratch path.
  3. Boot and authenticate-smoke only through the root-owned isolated harness
     on its dedicated loopback port; never point the harness at live paths.
  4. Require RPO <= 1 hour and download-through-smoke RTO <= 30 minutes.
  5. Destroy restored plaintext and retain only private mode-0600 evidence.

Installation, credentials, bucket lifecycle/object-lock policy, and every real
restore require a separate owner-approved operations window. The complete
layout and drill contract are in `ops/application-dr/OPERATIONS.txt`.

## Advisory SonarQube Host Boundary

- SonarQube Community Build is advisory and is never a merge, signing,
  staging, or promotion dependency while it shares ServerDominguez.
- Install official Docker Engine/Compose only in an approved maintenance
  window after capturing listeners, firewall rules, routing, Tailscale,
  Cloudflare, PM2 identity, health, memory, swap, and recent OOM evidence with
  `scripts/quality-sonar-preflight.sh`.
- Use only the reviewed immutable images in
  `ops/sonarqube/images.lock.env`. Do not use Watchtower, automatic image
  upgrades, or application-account Docker-group membership.
- Keep PostgreSQL container-internal and publish Sonar only on
  `127.0.0.1:9000`; use an SSH tunnel for the UI, scanner, and IDE Connected
  Mode. Abort when available memory is below 16 GiB or host pressure/restarts
  are present.
- Keep persistent state in the explicit bind paths below the root-controlled
  `/srv/sonarqube/data` boundary; Docker must not create the paths and the
  stack wrapper verifies their fixed numeric service ownership and modes.
- Every start requires a passing checksummed preflight from the current boot
  no more than two hours old plus the digest-bound successful 24h staging/24h
  production small-model soak and cleanup result. The root verifier reopens
  the canonical mode-0600 path+SHA-256 health/request files, validates their
  exact windows and retained-model digest, and rejects any health failure,
  OOM, restart delta, pressure, or large/unapproved-model request. Start evidence must contain
  a post-install Docker client/server snapshot, so the pre-Docker firewall
  baseline cannot be reused. The scan, stack lifecycle,
  and release transaction share `/run/lock/nexus-release-sonar.lock`.
  Compose restart policy stays disabled; only the root systemd wrapper may
  start the containers after those checks.
- Give the deploy account only the exact sudoers command that returns
  `nexus.sonarqube-release-state.v1` for `nexus-hub-backend`. Keep the dedicated
  project monitor token root-owned mode 0600 and out of command output. Its
  Sonar identity has only `Browse` on that project; the helper reads only the
  project component queue and does not require project/global administration.
- Before declaring Sonar enabled, bind one successful exact-SHA advisory scan
  between sequential before/after application samples and require no more
  than 5% regression in either p50 or p95. Failure stops Sonar rollout, not a
  production release.
- Back up Sonar PostgreSQL daily as an encrypted off-host custom-format dump,
  retaining 7 daily and 4 weekly copies. Exercise restore/reindex quarterly on
  an isolated Docker host.
- Move SonarQube off the production host before making its quality gate
  required. Operational templates and exact commands live under
  `ops/sonarqube/`.

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
