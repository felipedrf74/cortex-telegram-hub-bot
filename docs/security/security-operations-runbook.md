# Nexus Hub Security Operations Runbook

Status: canonical
Owner: Felipe Dominguez
Last verified: 2026-08-09
Update policy: update after any security incident, deploy path change, provider
credential change, or infrastructure hardening change.

## Do Not Mutate Production Outside An Authorized Path

Firewall, Cloudflare, provider, APNs, payment, DNS, destructive maintenance, and
manual production changes require a separate approved operations window. The
ordinary signed container deployment from protected main is already governed by
selected CI, hosted artifact publication, and the root poller; it does not need a
second per-release approval. This runbook defines sequences and evidence but is
not authorization for any other live mutation.

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
- Before the production migrator or image switch, the root poller starts
  `nexus-local-backup-pre-promotion.service` and admits only a fresh, exact
  receipt for `/var/lib/nexus-hub/production/data/bot.db`. A failed, stale,
  mismatched, or unverifiable backup aborts the release before production is
  mutated. The direct narrow-sudo invocation is retained only for the PM2
  first-cutover fallback.
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
- Signed OCI payloads and the backend/Content Engine image pair are the runtime
  rollback source. During an attempt, retention protects the candidate, active
  release, and immediate predecessor; after settlement it protects active and
  predecessor. Immutable receipts are not count-pruned. Database backups are
  recovery evidence, not a second runtime artifact store and never an automatic
  rollback input.
- Operational commands and the accepted single-host limitation are documented
  in `ops/local-backup/README.md`.

## Retired: advisory SonarQube host boundary

SonarQube is decommissioned from the repository and release path as of
2026-08-07. The checked-in PostgreSQL + SonarQube container definitions, backup
and restore-drill units, scanner pin, coverage manifest, and release coexistence
gate are removed; `ops/sonarqube/` and `scripts/quality-sonar-*` no longer exist.
No release code consults a JVM quality service, so an advisory scan cannot block
a production deployment. This repository state does not prove that old units or
containers have already been uninstalled from the real host; that verification
remains owner-gated below.

Static analysis controls now in force:

- CodeQL (`.github/workflows/security.yml`), which already provided the taint
  analysis Sonar Community Build excludes.
- `npm audit --audit-level=high --omit=dev` and `pip-audit`, plus OpenSSF
  Scorecard, in the same workflow.
- `tsc --strict`, the changed-area classifier, the risk gate, the changed-file
  coverage gate, and the docs audit in `.github/workflows/ci.yml`.

**Retained control.** The shared root maintenance mutex at
`/run/lock/nexus-release-sonar.lock` survives under a historical filename. It is
not a Sonar control: it serializes root maintenance transactions during the PM2
first-cutover fallback — including chat capability flags, data-key rotation, and
Ollama install/finalize — against release activity. Those helpers are not a
supported post-bootstrap container maintenance executor; that path remains
owner-design-gated. Its tmpfiles definition is
`ops/nexus-release/nexus-release-maintenance-lock.conf`, still `0660 root:dominguez`.

`scripts/ollama-lean-finalize.mjs` no longer queries the removed
`/usr/local/sbin/quality-sonar-release-state` helper. Its only retained Sonar-named
boundary is the shared maintenance mutex above; the name is historical and does
not restore a quality-service dependency.

Host backup cleanup remains owner-gated: `/srv/nexus-backups/sonarqube` may be
pruned only after the owner verifies that SonarQube is uninstalled on the real
host. Do not remove it while the service is still installed, because the
retention receipt is the only evidence that its last restore drill passed.

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
