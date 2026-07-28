# Nexus Hub Security Operations Runbook

Status: canonical
Owner: Felipe Dominguez
Last verified: 2026-07-23
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

### Durable cloudflared connector

ServerDominguez must run the production connector as
`nexus-cloudflared.service`, not as a user cron child. The reviewed unit uses a
dynamic service identity, root-owned mode-0600 configuration and credential
inputs delivered with systemd `LoadCredential`, a fixed loopback metrics
listener on `127.0.0.1:20243`, and no automatic updater.

Use `scripts/cloudflared-systemd-migrate.sh` only in an owner-approved
Cloudflare operations window. It accepts a locally managed tunnel config,
credential JSON, and cloudflared binary only as exact SHA-256-bound files; it
has no token argument and refuses token-bearing environments. The safe
migration is deliberately two phase:

1. `--install-replica` deliberately restarts the reviewed systemd connector
   while the legacy connector remains live. This also makes an interrupted
   prior attempt reload the exact binary, configuration, and systemd
   credentials. The installer rejects unit drop-ins, binds the exact unit
   digest, attests the live process-image digest, requires active Cloudflare HA
   connections from that process, verifies
   `https://api.nexushub.me/health` returns 200, then enables the unit for boot.
2. The owner removes the secret-bearing legacy cloudflared entry with
   `crontab -e`; do not print or copy that line into evidence.
3. `--retire-legacy` fails closed when any Ubuntu cron command source cannot be
   inspected or still names cloudflared. It holds a Linux pidfd for the exact
   PID/start-time/user/executable-digest-bound legacy process, freezes that
   held process, proves the public route three times through the new replica,
   then gracefully retires the old process through the same pidfd. A failed
   proof, lost command pipe, HUP, INT, or TERM resumes the old connector and
   exits the migration instead of continuing the retirement.

The canonical route template is `ops/cloudflared/config.yml.example`. Replace
only its tunnel UUID in a root-owned mode-0600 staging copy and provide the
matching Cloudflare-generated credential JSON through the same protected
staging boundary. Never commit either live file or include their contents in
logs, command output, chat, or release evidence.

## Backup Protection And Restore Drill

- Keep all backup directories and receipts root-owned mode 0700/0600. Never
  include database bytes, provider tokens, or decrypted content in release
  evidence or logs.
- `nexus-local-backup.timer` uses SQLite's online backup API hourly, checks
  integrity and foreign keys, encrypts with `age`, and keeps 24 hourly,
  30 daily, and 4 weekly recovery points under
  `/srv/nexus-backups/application`.
- Promotion must run exactly
  `sudo -n /usr/bin/systemctl start
  nexus-local-backup-pre-promotion.service` before changing PM2 or the
  production `current` symlink. The narrow sudoers rule permits no other
  root command. A failed backup aborts promotion.
- Keep the latest ten pre-promotion recovery points. The weekly restore
  verifier decrypts the newest hourly point into a private temporary path,
  verifies SQLite integrity and foreign keys, writes a root-only receipt, and
  removes plaintext.
- The `age` private identity is stored on ServerDominguez root-owned mode 0600
  because this is intentionally same-host recovery. That protects at-rest
  database bytes from non-root accounts, but does not protect against complete
  server or NVMe loss.
- A real restore must always target a new path. Validate the restored database,
  stop production, preserve the failed database, atomically install the
  verified replacement, and restart only during an owner-approved incident
  window.
- Exact release directories remain the rollback source and keep the newest
  five production and three staging releases. These backups are not a second
  artifact store.
- Operational commands and the accepted single-host limitation are documented
  in `ops/local-backup/README.md`.

## Advisory SonarQube Host Boundary

- SonarQube Community Build is advisory and is never a merge, signing,
  staging, or promotion dependency while it shares ServerDominguez.
- Docker and the authoritative Compose project already exist under
  `/home/dominguez/sonarqube`. Update that project in place; do not create a
  second stack, migrate volumes, or change Docker daemon ownership.
- Use only the reviewed immutable images in `ops/sonarqube/compose.yaml`. Do
  not use Watchtower, automatic image upgrades, or application-account
  Docker-group membership.
- Keep PostgreSQL container-internal and publish Sonar only on
  `127.0.0.1:9000`; use an SSH tunnel for the UI, scanner, and IDE Connected
  Mode. PostgreSQL remains 1 CPU/2 GiB and Sonar remains 2 CPUs/6 GiB. Preserve
  the existing named volumes and `unless-stopped` policy.
- The scan, backup, restore drill, and release transaction share
  `/run/lock/nexus-release-sonar.lock`; a Sonar operation exits instead of
  waiting behind a production release.
- Give the deploy account only the exact sudoers command that returns
  `nexus.sonarqube-release-state.v1` for `nexus-hub-backend`. Keep the dedicated
  project monitor token root-owned mode 0600 and out of command output. Its
  Sonar identity has only `Browse` on that project; the helper reads only the
  project component queue and does not require project/global administration.
- Before declaring Sonar enabled, bind one successful exact-SHA advisory scan
  between sequential before/after application samples and require no more
  than 5% regression in either p50 or p95. Failure stops Sonar rollout, not a
  production release.
- Back up Sonar PostgreSQL daily as a root-only custom-format dump under
  `/srv/nexus-backups/sonarqube`, retaining the latest seven dumps and their
  SHA-256 pairs. Installation leaves the timer disabled; create and verify
  the first dump before explicitly enabling it. Failed attempts retry every
  15 minutes without waiting behind a release, and
  `quality-sonar-backup --verify-freshness --max-age-hours 26` must validate
  the root-owned success receipt. Exercise a database restore into a disposable
  PostgreSQL container and publish each result as a new root-only file.
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
