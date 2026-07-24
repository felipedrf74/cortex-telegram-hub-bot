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

- Backups containing SQLite, provider tokens, or logs must not be group/world
  readable.
- Encrypt backups before off-host transfer.
- The root-owned `nexus-application-dr-backup.timer` creates an online SQLite
  recovery point hourly and encrypts it with an off-host `age` recipient before
  S3-compatible upload. Retain 24 hourly, 7 daily, 4 weekly, and 6 monthly
  database points.
- Escrow every exact-release rollback archive off-host for 90 days; keep the
  existing latest-ten local policy. Each promotion additionally requires a
  pre-mutation candidate recovery-runtime object plus database point and a
  newly encrypted phase-distinct post-soak candidate recovery-runtime object
  plus refreshed database point. A missing timer run, failed upload, or
  unverified remote metadata is an alert, not a silent RPO exception.
- Keep the private `age` identity off ServerDominguez. Bucket credentials are
  prefix-scoped IAM Roles Anywhere sessions from two distinct private-CA leaf
  certificates; plaintext never leaves the private temporary directory. The
  managed CloudFormation identity plane must start disabled, bind exact account,
  trust-anchor, issuer CN, subject CN, one-role profile, and session-policy
  limits, and enable only after owner-approved key custody and revocation tests.
  Keep the imported CRL current because IAM Roles Anywhere does not query OCSP
  or CRL distribution points.
- Default object-store controls are enabled S3 versioning plus at least 90-day
  S3 Object Lock for release objects. AWS database recovery points are
  write-once first points protected by tier-specific COMPLIANCE locks and
  lifecycle expiry; observed 24/7/4/6 counts are minimum floors and take time
  to mature. Cloudflare R2 is accepted only through
  the owner-approved `r2-approved-variance`, with current private control-plane
  evidence for an exact releases-prefix bucket lock of at least 90 days. The
  mode-0600 control evidence must be refreshed within 30 days; never claim R2
  versioning.
- Scope AWS backup IAM to `s3:ListBucketVersions` and exact-tier
  Get/Head/conditional Put plus bounded Object Lock actions. Explicitly deny
  `DeleteObject`, `DeleteObjectVersion`, legal-hold changes, and bucket-policy,
  lifecycle, versioning, or Object Lock mutation to the backup principal. AWS
  bucket policy must deny governed writes from every principal except the exact
  backup role, even when another same-account identity policy is overly broad.
  AWS retention must exhaust direct key/version-marker pages with CLI
  auto-pagination disabled and emit read-only consecutive-period floor
  evidence. It must checksum-HEAD every selected exact VersionId and verify its
  metadata, calendar identity, COMPLIANCE mode, and tier deadline. First
  24/7/4/6 maturity creates a monotonic root-owned seal; later regression is a
  failure. S3 Lifecycle is its only cleanup actor. The separate R2 variance
  retains its unversioned DeleteObject pruning and must never be selected for
  AWS.
  `PutObjectRetention` is required to attach each initial lock. A compromised
  writer could repeatedly extend objects to the tier's one-day upper bound and
  cause storage-cost growth, but cannot shorten retention, delete versions,
  alter legal holds, or mutate bucket controls. Alert on unexpected retention
  changes and disable the Roles Anywhere profile and trust anchor during
  credential response.
- Retain release versions under COMPLIANCE lock for at least 90 days, with
  lifecycle expiration after the lock window.
  Bind the two current-runtime keys to the exact transaction and phases:
  `+escrow-<id>+phase-pre-mutation...` and
  `+escrow-<id>+phase-post-soak...`. They preserve the same plaintext runtime
  identity but require distinct keys and freshly encrypted ciphertext. The
  post-soak phase also writes the predecessor rollback bundle under a distinct
  `+rollback-escrow-<id>+phase-post-soak` key, preventing an older timer object
  from shortening the promotion's required 90-day recovery window. The
  one-day lock headroom and exact-version retention extension support a delayed
  checkpoint resume without weakening that floor. Protect each exact pair with
  a conditional write, then re-HEAD and re-download the exact AWS VersionId.
  Confirmation records `escrowId`,
  `escrowPhase`, plaintext/encrypted SHA-256, encrypted byte size,
  `recoveryRuntimeDigest`, release-manifest/staging digests, `confirmedAt`,
  `retainUntil`, and `objectVersionId`, with `retainUntil` at least 90 days
  after `confirmedAt`. The pre/post database points likewise bind fresh
  plaintext/encrypted identity and exact AWS versions, and post-soak candidate
  readiness brackets the network work. R2 must emit null for unavailable
  deadline/version fields and name the approved unversioned variance
  explicitly.
- Quarterly restore drill:
  1. Use `scripts/application-dr-restore-drill.sh` on an isolated host with the
     newest hourly point and a compatible exact-release escrow object. On AWS,
     pin both objects to the exact retained VersionIds; use no version argument
     only for the explicit R2 variance.
  2. Verify encrypted and plaintext digests, SQLite integrity/foreign keys, and
     safe exact-release extraction into a private scratch path.
  3. Install only the exact release's embedded Node/Python dependency payload
     as the dedicated nologin account, with no credentials and no network.
  4. Boot and authenticate-smoke only through the root-owned private-namespace
     harness on its one-use token and dedicated loopback port; prove an invalid
     token is rejected and never point the harness at live paths.
  5. Require conservative storage-timestamp age <= 1 hour. Treat the monotonic
     download-through-smoke measurement <= 30 minutes as a technical restore
     window, not a customer RTO.
  6. After stop, snapshot the scratch SQLite database through the online backup
     API, recheck integrity/foreign keys, and require the exact terminal
     migration lineage so committed WAL state cannot be omitted.
  7. Destroy restored plaintext and retain only private mode-0600 evidence. If
     process cleanup fails, preserve and report the private manual-cleanup
     target instead of deleting a potentially live tree.

Installation, credentials, bucket lifecycle/object-lock policy, and every real
restore require a separate owner-approved operations window. The complete
layout and drill contract are in `ops/application-dr/OPERATIONS.txt`.
Repository harness implementation does not change the current
`MANUAL_REQUIRED` site-readiness status until provisioning and one retained
quarterly drill are complete.

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
  are present. The root stack wrapper rejects both rendered and running
  Docker state unless PostgreSQL is exactly 1 CPU/2 GiB and SonarQube is
  exactly 2 CPUs/6 GiB.
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
- Immediately before Compose, the root wrapper must verify the live sole 3B
  tag at the cleanup-bound digest, no unapproved loaded model, the exact
  loopback/single-model/queue/context/CPU/memory envelope, a usable age
  recipient, and authenticated access to the configured backup bucket.
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
  retaining one complete data/checksum pair for each of 7 distinct UTC days
  and 4 distinct ISO weeks. Retries and manual runs are collapsed within their
  period, and the post-prune inventory is re-listed. Every selected pair must
  then pass exact-VersionId, metadata digest, checksum-object, and S3 SHA-256
  attestation before the receipt records observed period counts or whether
  each target has accrued. The asset
  installer leaves the timer disabled; the owner-only
  `quality-sonar-backup --enable-timer` path must complete one remote backup
  before enabling it. Failed attempts retry every 15 minutes without waiting
  behind a release, and
  `quality-sonar-backup --verify-freshness --max-age-hours 26` must validate
  the root-owned success receipt. Exercise restore/reindex quarterly on an
  isolated Docker host and publish each result as a new file beneath the
  root-owned mode-0700 `/var/lib/nexus-sonarqube/restore-evidence` boundary.
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
