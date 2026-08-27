# Nexus Hub Security Operations Runbook

Status: canonical
Owner: Felipe Dominguez
Last verified: 2026-08-26
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

## Invoice Artifact Ownership Reconciliation

Migration 297 installs durable ownership manifests and deletion-proof columns;
migration 298 adds queue-intent payload identity plus the device/inode deletion
journal. Neither migration can infer pre-existing filesystem state inside
SQLite. Before a release containing these migrations can support account
erasure, run the installed
`fiscal:storage:backfill` tool in a separately authorized maintenance window.
This procedure is a gate, not authorization to mount, delete, or change live
data.

Migrations 297–299 are the predecessor-compatible phase-A schema: columns added
to existing tables are nullable (or use only a simple literal default), and
indexes on existing tables are plain and non-unique. The application is the
phase-A enforcement boundary. Invoice admission serializes the live
owner/queue/source-intent lookup and insert under one immediate transaction,
refuses ambiguous legacy intent rows, and persists deletion proof only through
the token/device/inode-bound transition. Content job admission/completion writes
only complete validated release triples, while acceptance rejects missing or
partial identity. Do not claim database-enforced uniqueness or immutability from
this phase; those constraints require a later contract migration after the
predecessor runtime is retired.

1. Take and admit the governed pre-maintenance database backup. Mount the
   historical invoice root read/write at an owner-controlled real directory.
   The root, every traversed parent, every invoice artifact, and the identity
   marker must be owner-only mode-private; symlinked roots or parents are
   forbidden. First retire/prove absent every legacy SCP writer, then create a
   mode-private `.nexus-invoice-root-id`
   identity marker on that exact quiesced original root and pin its SHA-256 in
   the owner-controlled operation record.
2. Run private dry inventories with `--reconcile-manifests`, the exact database
   path, `--limit`, and each `--manifest-kind` in order: `filings`, `objects`,
   then `queue`. Re-run one phase with its reported `--manifest-after` cursor
   until the cursor is complete before starting the next phase. The queue phase
   deliberately scans database ownership rows first and then filesystem entries;
   preserve the reported opaque `rows:`/`files:` cursor across those bounded
   subphases. Filesystem cursors may identify a directory or refused entry:
   directory, file, and unsafe-entry work all consumes the same `--limit`
   budget. That limit is also the hard admitted fanout for each traversed
   directory (maximum 5,000); the tool reads at most one look-ahead entry and
   refuses with `BACKFILL_DIRECTORY_FANOUT_EXCEEDED` instead of materializing
   or sorting a larger directory. Total enumeration is capped at four times
   the page limit and traversal depth at 128; the safe refusal codes are
   `BACKFILL_PAGE_ENUMERATION_BUDGET_EXCEEDED` and
   `BACKFILL_DIRECTORY_DEPTH_EXCEEDED`. Queue rows
   retain their exact locator spelling (including a runtime-valid relative
   locator) while descriptor validation resolves it to the canonical spool
   parent. Exit 2, any
   unsafe/ownerless artifact, or any filing/manifest ownership mismatch blocks
   the window. Do not paste path-bearing JSON or cursors into chat or release
   evidence.
3. After owner review, rerun the same bounded phase sequence with `--apply`.
   Run legacy backfill/deletion with `--delete-legacy`, the mounted legacy root,
   and the pinned `--legacy-root-marker-sha256`. Canonical object-key files and
   exact queue rows receive manifests. A distinct legacy copy is deleted only
   after the backfilled object is checksum-verified through no-follow
   descriptors pinned to the originally verified mount identity; its parent is
   fsynced and the exact filing identity is checked. A filing without an
   adopted object can store only descriptor-bound already-missing proof; an
   existing legacy artifact cannot match the deliberately empty checksum and
   is never deleted by that branch
   before `legacy_remote_deleted_at` is stored.
4. Rerun every apply phase idempotently from an empty cursor and require zero
   unresolved legacy copies, zero unsafe/ownerless files, no remaining cursor,
   zero filing/manifest mismatches, and no duplicate live stored-object manifest
   grouped by tenant, user, write-intent kind/id, and source checksum. An orphan
   queue file has no inferable tenant/user owner and must remain blocked until a
   separately approved investigation either establishes ownership or securely
   removes it.
   A manifest left `deleting` with a missing, replaced, or identity-less target
   is also unresolved: do not clear it from canonical-name absence alone. An
   older `deleted` manifest with no device/inode journal does not prove deletion
   for a surviving queue or filing row. An
   owner-authorized investigation must prove disposition of the journaled inode
   before recording deletion or retiring the manifest.
5. Preserve only the bounded counts, exit status, backup receipt, mounted-root
   authorization, and reviewed release SHA. Never retain invoice paths,
   filenames, subjects, senders, amounts, artifact locators, or row identifiers
   in the release record.

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
- Register each generic provider subscription with one explicit positive
  `owner_user_id` and one explicit, provider-unique secret; there is no global
  fallback secret. Google Calendar additionally binds the channel ID and exact
  channel token. Microsoft Graph binds each notification's `subscriptionId`
  and body `clientState`, then removes `clientState` before persistence. Gmail
  Pub/Sub remains disabled until its OIDC signature, audience, and trusted
  service-account identity can be verified. Strava remains disabled until its
  native GET challenge and owner-bound POST identity contract is implemented;
  do not substitute a fictional HMAC header. The event ledger copies only a
  narrow allowlist of non-secret Google/GitHub delivery metadata; arbitrary,
  authorization, cookie, channel-token, and signature headers are omitted.
- Subscription `event_types` is a bounded non-empty allowlist (`['*']` means
  all); a correctly authenticated but out-of-scope event is rejected before
  persistence or dispatch. Microsoft Graph batches are capped at 1,000
  notifications before subscription matching to bound fanout.
- Public callbacks are mounted before the global JSON parser and portal auth so
  provider verification sees the exact bytes; each carries its own IP limiter
  and native verifier. Stats, subscription mutation, event listing, and replay
  remain after portal authentication and require the admin token.
- `WEBHOOKS_ENABLED=false` is the generic-ingress incident kill switch. Generic
  callback POSTs remain IP-limited but return `503 Webhook ingestion is disabled`;
  management stays available behind portal/admin authentication. Re-enable only
  after the abusive source or verifier failure is contained. The protected PM2
  release environment forwards and exact-boolean-validates this flag.
- Deploy migration 300 and Release A first with
  `WEBHOOK_OWNER_ENCRYPTION_WRITES_ENABLED=false`. Migration 300 adds only
  ordinary lookup indexes; runtime `BEGIN IMMEDIATE` transactions enforce the
  subscription owner/provider match, retry admission/replay serialization, and
  the `(user_id, provider, subscription_id, idempotency_key)` retry boundary. Do
  not add phase-A triggers, unique indexes, or partial indexes to the existing
  webhook tables: they would break predecessor writes after rollback.
- Verify Release A with writes still OFF and establish it as the compatible
  rollback floor. Only a later protected release may set the flag to `true`,
  and it must have the pinned OAuth-domain `OAUTH_ENCRYPTION_KEY`; new
  subscription secrets/metadata, payloads, and retained headers then use the
  `nexus-webhook-json-v1` authenticated-encryption envelope. Reads remain
  plaintext/ciphertext compatible throughout the transition.
- The governed offline data-encryption rotation includes webhook subscription
  secrets/metadata and event payloads/headers under the OAuth domain. It adopts
  positive-owner legacy plaintext into the same envelope, rejects non-positive
  owners, accepts every syntactically valid historical JSON shape (including
  arrays, scalars, and null), rejects malformed JSON, and requires the protected
  backup to match those exact columns.
- Before activation after migration 300, inventory `webhook_subscriptions` and
  `webhook_events` where `user_id <= 0`. Any row is an ownership-reconciliation
  block; do not infer its owner from payload contents, provider identifiers, or
  delivery timing. Confirm that every owned event's subscription, provider,
  and owner agree. Plaintext is expected while the phase-A flag remains OFF.
- Inventory duplicate non-failed `webhook_events` grouped by
  `(user_id, provider, subscription_id, idempotency_key)` for reconciliation,
  but do not delete or merge provider deliveries automatically. Duplicates do
  not block the additive phase-A migration; new-runtime admission serializes
  the lookup and insert instead.
- Portal webhook stats, subscriptions, events, replay, creation, and removal
  stay behind the portal admin token. When `PORTAL_OPERATOR_USER_SCOPES` is
  configured, every list/stats request requires an authorized positive
  `owner_user_id`; create, remove, and replay authorize the body or stored-row
  owner and repeat the owner predicate in the registry mutation. Subject-access
  export omits signing secrets and headers, and subscription list responses
  expose only a boolean secret-configured marker. Portal event lists omit stored
  headers; Article 17 erasure removes exact owner rows.
- Portal event-list limits accept only exact decimal integers and are clamped at
  1..200 (default 50); the registry repeats the same bound. Mixed Microsoft
  Graph batches persist each uniquely authenticated notification independently,
  omit `clientState`, and return a bounded rejected-count summary for invalid or
  ambiguous siblings.

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
