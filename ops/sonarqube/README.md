Advisory SonarQube on ServerDominguez
=====================================

This directory contains the reviewed installation layout and a transactional
asset installer. The installer copies only the exact allowlisted assets from a
root-owned, SHA-bound protected-main bootstrap; it never installs Docker,
invokes a Docker mutation, writes secrets, starts runtime services, or writes Sonar
application/database contents. It reads the live Docker authority and creates
only the predeclared empty mapped bind directories. It durably enables only
the install-recovery oneshot, which is conditioned on the external
asset-install, directory-install, and recovery-anchor transaction state.

Safety contract
---------------

- SonarQube is advisory. It is not a release, signing, application-health, or
  promotion dependency.
- The web port is published only as 127.0.0.1:9000; PostgreSQL has no host port.
  Use an SSH tunnel from the Mac for the UI, Connected Mode, and scans.
- Do not add `dominguez` or `nexus-release` to the Docker group or grant either
  account Docker-socket ownership, group, or named-ACL access. Preflight,
  installation, and every stack start enforce that boundary. ServerDominguez
  already has legitimate host identities 999 and 1000, so those numbers must
  never own Sonar host paths. Fresh Docker must use daemon-wide
  `userns-remap: default`: container IDs 999/1000 are translated to reviewed
  high subordinate `dockremap` IDs before they own any bind directory.
  Missing, overlapping, ambiguous, or colliding subordinate ranges fail closed.
- Do not use Watchtower or another known automatic image updater. Preflight,
  installation, and start enumerate Docker containers plus installed and
  loaded systemd service/timer units and reject known updaters. Resolve, review,
  and commit each image digest explicitly.
- Run the exact archive-validating asset installer with
  `--pre-docker-preflight-only` before installing Docker. It executes the
  reviewed preflight read-only and stores private network/health evidence
  below its new output path without installing any asset.
- The live database and Sonar state use explicit host bind mounts below
  `/srv/sonarqube/data`; there are no opaque Docker named volumes. Root owns
  the stack and data boundaries. The writable children are owned by the
  derived high host IDs `subuid-base + 999/1000` and
  `subgid-base + 999/1000`; the internal container IDs never become host
  identities.
- Stack lifecycle, backup/restore operations, an advisory scan, and a release transaction share
  `/run/lock/nexus-release-sonar.lock`. A scan or stack operation never waits
  behind a release: it exits and can be retried after the release completes.
  The promotion control plane owns
  `/etc/tmpfiles.d/nexus-release-sonar-lock.conf` as a global predecessor.
  Sonar installation requires its exact protected-main bytes, root ownership,
  and mode 0644 and never removes it. The rule materializes the volatile lock
  as `root:dominguez` mode 0660 after every boot; no caller may create the lock
  opportunistically with its own umask.

Explicit preparation
--------------------

1. Run scripts/quality-sonar-resolve-images.sh --check. Use --write only when
   intentionally refreshing a reviewed digest.
2. Complete the sequential staging and production 24-hour small-model
   observations and the owner-authorized exact-digest cleanup in
   `ops/ollama/LARGE_MODEL_CLEANUP.md`. Preserve both root-owned mode-0700
   collector run directories and the successful cleanup result. Stack start
   reopens the canonical production `result.json`, validates the installed
   collector digest, the bounded mode-0600 raw-sample hash chain, the prior
   staging result, and exact-window SQLite `api_usage` provider/model counts.
   It requires zero health failures, OOM/restart/pressure drift, and
   large/unapproved-model requests before validating the cleanup-result chain
   and sole retained `qwen2.5:3b-instruct-q4_K_M` digest. A copied or
   hand-authored aggregate cannot authorize installation.
3. Prepare the same exact root-owned bootstrap already verified by the release
   owner. Retain this full asset-install command, but do not invoke it until
   Step 4 has captured the pre-Docker baseline, installed Docker, and proved
   its user-namespace map:

   ```sh
   sudo /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source/scripts/quality-sonar-systemd-install.sh \
     /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source \
     REPLACE_WITH_40_HEX_SHA \
     /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source.tar.gz \
     REPLACE_WITH_64_HEX_ARCHIVE_SHA256
   ```

   The installer revalidates the archive SHA-256 and Git-archive commit
   identity, binds every source byte to a regular archive member, embeds the
   exact allowed layout rows and destinations, takes the non-waiting shared
   release/Sonar lock, and prevalidates the assets. Before its first
   directory/target mutation it performs a one-second live check of the
   protected host/Docker identities, mapped bind-identity isolation, automatic
   updater absence, 16-GiB memory floor, load, swap, recent OOM state, and all
   four PM2 processes. It then uses same-filesystem atomic replacement with
   rollback. Before any managed directory is created, it bootstraps the
   root-owned mode-0700 control boundary
   `/var/lib/nexus-release-promotion/sonarqube-install-control` from a durable
   intent in its already provisioned release-state parent. It then provisions
   `/usr/local/sbin/lib`,
   `/etc/sonarqube`, its private install state, and the bind directories in
   `data-layout.tsv` through one exact ordered directory journal. The journal
   records each path's absence or exact UID, GID, mode, device, and inode
   before the first managed `mkdir`; each new path transitions durably through
   `creating` and `created`. Recovery walks child-first and removes only an
   empty path that the journal proves was created from absence. Existing
   persistent directories must already have their exact owner/mode and are
   never rewritten. The Docker user-namespace mapping JSON and digest are
   reopened immediately before this transaction and again immediately before
   Compose startup. The Sonar service and backup
   timer must be inactive and disabled before installation and remain so
   afterward: installation alone intentionally leaves the timer disabled. A
   durable external journal prevents startup after an interrupted installation
   even when `/var/lib/nexus-sonarqube` does not yet exist.

   The owner-authorized installer invocation first commits recovery-anchor
   enrollment as a separate prerequisite phase: the retained mode-0600
   recovery program and its root-owned recovery unit. The promotion-owned
   tmpfiles rule that recreates the shared lock after reboot is a mandatory,
   exact preexisting global predecessor, not a Sonar-owned anchor. Enrollment
   never replaces unknown predecessor bytes. Every preexisting anchor must
   already match the reviewed source digest, owner, and mode exactly, and a
   preexisting recovery unit must already be enabled; otherwise the installer
   stops before changing it.
   Before creating an absent anchor it durably writes
   `/var/lib/nexus-release-promotion/sonarqube-install-control/recovery-anchor-enrollment-in-progress.v2.json`
   with the same predecessor/creation/digest inventory. A host loss during
   this separately authorized enrollment changes no application runtime asset;
   the retained program resumes the exact source/archive binding and refuses
   to guess. After verified enrollment the intent is replaced by the durable
   `/var/lib/nexus-release-promotion/sonarqube-install-control/recovery-anchor-enrollment.v2.json`
   receipt. It
   records the exact anchor digests, which anchors were created from absence,
   the recovery service enabled/active predecessor, and the exact predecessor
   wants-link identity. Re-running the same enrollment validates and preserves
   that original receipt instead of reclassifying created anchors as
   predecessors.

   Recovery-anchor enrollment is independently reversible during an
   owner-observed maintenance window. First obtain the exact, non-mutating
   plan while the shared release/Sonar lock is available:

   ```sh
   sudo /var/lib/nexus-release-promotion/sonarqube-install-control/install-recovery-program.v2.py \
     anchor-plan \
     --receipt /var/lib/nexus-release-promotion/sonarqube-install-control/recovery-anchor-enrollment.v2.json \
     --lock /run/lock/nexus-release-sonar.lock
   ```

   Review and copy both returned `ackPlan` and `ackReceipt` values exactly.
   Apply only with current explicit owner authorization:

   ```sh
   sudo env NEXUS_SONAR_OWNER_AUTHORIZED=1 \
     /var/lib/nexus-release-promotion/sonarqube-install-control/install-recovery-program.v2.py \
     anchor-unenroll \
     --receipt /var/lib/nexus-release-promotion/sonarqube-install-control/recovery-anchor-enrollment.v2.json \
     --journal /var/lib/nexus-release-promotion/sonarqube-install-control/recovery-anchor-unenrollment-in-progress.v1.json \
     --result /var/lib/nexus-release-promotion/sonarqube-install-control/recovery-anchor-unenrollment-result.v1.json \
     --lock /run/lock/nexus-release-sonar.lock \
     --ack-plan REPLACE_WITH_ACK_PLAN \
     --ack-receipt REPLACE_WITH_ACK_RECEIPT \
     --owner-authorized
   ```

   Planning and application use the same non-waiting shared lock and fail if
   an install receipt or install/recovery journal exists or a runtime unit is
   active/enabled. The durable journal resumes without asking for new
   authorization after a host loss. It removes only exact current Sonar-owned
   anchors recorded as `createdFromAbsence`, preserves preexisting-identical anchors
   by exact inode and digest, including the shared tmpfiles rule, restores the
   recovery service and wants-link predecessor, and removes the retained
   program last. Before disabling or removing the original boot unit, it
   installs and durably enables the
   transaction-scoped
   `nexus-sonarqube-anchor-unenroll-recovery.service`. The active invoker is
   never stopped. Before journal removal commits the reversal, the transaction
   writes a digest-bound `cleanup_pending` result. The temporary unit boots
   when either the journal or that result exists and checkpoints receipt,
   unit, systemd-reload, and retained-program cleanup independently. If power
   is lost after the unit retires itself, the next protected-source installer
   runs `resume-anchor-cleanup` before any mapping or directory mutation and
   finishes the exact pending state. A complete result is a no-op, so a future
   reinstall can enroll fresh anchors normally. Never delete an anchor or
   transaction file manually.

   After enrollment, the asset-install journal binds
   every staged asset and receipt to its target, exact digest, owner, mode,
   predecessor hard link, predecessor digest, and a fresh 256-bit install
   transaction identity shared with the directory journal and commit marker.
   A successful marker from an earlier same-SHA installation is therefore
   stale and cannot classify a newer interrupted installation as committed.
   The enabled
   `nexus-sonarqube-install-recovery.service` runs before every Sonar runtime
   entry point, restores the complete asset-phase predecessor set in reverse
   order, reloads systemd, proves the runtime units remain inactive and
   disabled, writes
   `/var/lib/nexus-release-promotion/sonarqube-install-control/asset-install-recovery-receipt.v1.json`,
   and only then
   removes the journal. Recovery is idempotent: another power loss during
   rollback leaves the same journal and the next boot safely continues. An
   invalid journal, missing predecessor, digest mismatch, ambiguous systemd
   state, or unavailable shared lock retains the journal and therefore keeps
   SonarQube and its backup timer fail-closed. After any automatic rollback,
   inspect the recovery receipt and rerun the exact protected-main installer;
   do not remove or edit the journal by hand.

   For the pinned images, the data contract records internal PostgreSQL
   `999:999` and SonarQube `1000:1000`, but the installer translates them to
   the current verified `dockremap` host IDs before creating or validating a
   path. Root owns the mode-0750 boundaries, PostgreSQL's mapped child is mode
   0700, and SonarQube's mapped children are mode 0750. The Compose file sets
   `create_host_path: false`, and the stack wrapper re-derives and checks the
   same mapping rather than letting Docker create or silently chown a path.
4. Before Docker installation, capture the maintenance baseline through the
   exact archive-validating installer in its preflight-only mode. The output
   parent must already be canonical, root-owned, and not group/world writable;
   `/var/lib/nexus-release-promotion` is the reviewed existing parent:

   ```sh
   sudo /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source/scripts/quality-sonar-systemd-install.sh \
     /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source \
     REPLACE_WITH_40_HEX_SHA \
     /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source.tar.gz \
     REPLACE_WITH_64_HEX_ARCHIVE_SHA256 \
     --pre-docker-preflight-only \
     /var/lib/nexus-release-promotion/sonar-pre-docker-baseline-REPLACE_WITH_UTC_TIMESTAMP
   ```

   This mode revalidates the exact Git-archive identity and every allowlisted
   source byte, requires the already provisioned release/Sonar mutex, and holds
   it for the complete network/capacity sample. It requires Docker to be absent
   both before collection and in a second fresh probe after `result.json` and
   all snapshot validation. Absence requires no Docker CLI or socket path, no
   `/etc/docker/daemon.json`, no record for the bounded Docker/containerd
   package allowlist, no loaded or enabled `docker.service`, `docker.socket`,
   or `containerd.service`, and no `dockerd` or `containerd` process in a
   bounded `/proc` scan. ServerDominguez admits no standalone containerd during
   this phase: a `containerd` package, unit, or process is treated as container
   runtime presence because it makes a fresh official-Docker baseline
   ambiguous. If another approved workload ever requires standalone
   containerd, stop and revise this host-placement policy rather than adding an
   exception during rollout. The mode installs no asset, creates no Sonar
   control/data directory, materializes no lock, resumes no prior Sonar
   transaction, and changes no Docker or host configuration. The private
   evidence directory is its only output; `result.json` is the success commit
   marker and is written last with exclusive-create semantics. A failed
   directory remains honest incomplete evidence without that marker and must
   not be reused.

   Preflight first invokes the installed root-owned release authority's
   `assert-root-pm2-ready` contract and accepts only the complete PM2 6.0.14
   closure under the pinned `/usr/bin/node` v22.23.1 identity.
   Missing
   firewall tools are recorded as `not_installed`; at least one authoritative
   UFW, nftables, or iptables snapshot is mandatory. Install official Docker
   Engine and Compose only after owner review of listeners, routes, firewall,
   Tailscale, Cloudflare, PM2, health, memory, load, swap, and OOM evidence.
   This must be a fresh Docker installation with no application containers.
   Before pulling any image, install the reviewed
   `ops/sonarqube/docker-daemon.userns.json` as
   `/etc/docker/daemon.json` (root-owned and not group/world writable), restart
   Docker, and verify:

   ```sh
   sudo /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source/scripts/quality-sonar-preflight.sh \
     --print-userns-map
   ```

   The verifier requires the exact `userns-remap: default` setting, the
   `dockremap` account with one non-overlapping 65536-ID range in each of
   `/etc/subuid` and `/etc/subgid`, an active Docker `userns` security option,
   and the corresponding high-ID namespaced storage root below
   `/var/lib/docker`. It also requires
   `features.containerd-snapshotter=false`, because Docker Engine 29 and later
   default the fresh-install containerd image store and that store is
   incompatible with user-namespace remapping. Alternate daemon listeners,
   mapped-ID collisions, protected-account range overlap, or an unproven map
   block installation. After this check passes, invoke the Step 3 asset
   installer; it creates the bind children with the derived high host owners.
5. Install `/etc/sonarqube/sonarqube.env`, `/etc/sonarqube/backup.env`, and
   `/etc/sonarqube/aws-config` from their examples with root ownership and
   mode 0600. The backup profile must use the dedicated IAM Roles Anywhere
   writer role through the exact root-owned `aws_signing_helper` path and
   reviewed SHA-256 declared in `backup.env`. Keep
   `AWS_SHARED_CREDENTIALS_FILE=/dev/null`; long-lived access-key,
   web-identity, container-credential, and alternate shared-credential
   environment paths are rejected. The backup uses
   `nexus-sonarqube-backup`; the isolated restore drill selects the separate
   `SONAR_RESTORE_AWS_PROFILE=nexus-sonarqube-restore` read-only role and
   revalidates the same boundary before downloading. Bind both exact role ARNs
   in `SONAR_BACKUP_AWS_ROLE_ARN` and `SONAR_RESTORE_AWS_ROLE_ARN`; equal or
   substituted roles fail closed. Approve and test the certificate
   issuance/rotation/revocation and private-key/PIN custody before enabling
   unattended backups. Every helper, config, certificate, and private-key
   path and parent must be canonical, root-owned, and not group/world
   writable; the private key must be mode 0400 or 0600. HSM, PKCS#11, TPM,
   and device-backed paths remain unsupported until their owner-approved
   custody design and validator change are reviewed together. Put the project
   scanner token in a separate Mac-side mode-0600 file; never put it in either
   Compose file.

   Provision the separate owner-approved Sonar storage boundary from
   `ops/sonarqube/aws-s3-stack.yaml`. It creates a retained bucket, a dedicated
   writer role/profile, a distinct read-only restore role/profile, and its own
   disabled-first IAM Roles Anywhere trust anchor and CRL. It never reuses the
   application DR bucket, prefixes, roles, trust anchor, CRL, CA, leaf
   certificates, or private keys.

   Validate the exact protected-main template locally before contacting AWS:

   ```sh
   node scripts/quality-sonar-cloudformation-yaml-check.mjs \
     /absolute/protected-main/ops/sonarqube/aws-s3-stack.yaml
   cfn-lint --format json --regions eu-west-1 \
     --template ops/sonarqube/aws-s3-stack.yaml
   cfn-guard validate \
     --rules ops/sonarqube/aws-s3-stack.guard \
     --data ops/sonarqube/aws-s3-stack.yaml \
     --type CFNTemplate --output-format json
   ```

   `CertificateRevocationListData` is the exact canonical PEM CRL required by
   IAM Roles Anywhere. The owner activation receipt continues to bind the same
   CRL as canonical base64 DER; wrap those decoded DER bytes at 64 characters
   per line between the `BEGIN X509 CRL` and `END X509 CRL` markers, with a
   final newline, for the CloudFormation parameter.
   `CertificateRevocationListSha256` remains the SHA-256 of the decoded DER
   bytes, never the digest of the PEM presentation.

   The first reviewed CloudFormation change set must keep both
   `RolesAnywhereActivation=DISABLED` and `LifecycleActivation=DISABLED`.
   Pass the exact byte digest of the protected-main template as
   `ProtectedMainTemplateSha256`, the reviewed owner key identifier as
   `OwnerReceiptKeyId`, and the SHA-256 of that Ed25519 public key's DER SPKI
   as `OwnerReceiptPublicKeySha256`. The matching private key stays off
   ServerDominguez, outside AWS, and outside the repository.
   `RolesAnywhereActivationReceiptSha256` and
   `LifecycleBootstrapReceiptSha256` both remain empty in this first change
   set. Enable CloudFormation termination protection before any activation
   change set is created, and keep normal stack rollback enabled. The initial
   stack also precreates the static activation rollback alarm. With no lease
   metric present, wait for all four 30-second missing-data periods and verify
   that this alarm has reached `ALARM`; an `OK` or `INSUFFICIENT_DATA` alarm
   cannot authorize activation.
   Create the change set without executing it, inspect its complete resource
   and IAM-policy diff plus CloudFormation validation events, and execute only
   after explicit owner approval. Copy only the named stack outputs into
   `aws-config` and `backup.env`; do not infer generated role, profile, or
   bucket names.

   Receipt JSON is strict, canonical, and owner-signed. Use
   `scripts/quality-sonar-stack-receipt.mjs`; do not hand-author an envelope or
   hash an unsigned payload. The activation payload schema is
   `nexus.sonarqube-roles-anywhere-activation.v2`. It binds a maximum-24-hour
   authorization window, explicit owner authorization, signing key identifier
   and public-key digest, exact
   stack/account/region/template/bucket/prefix/trust-anchor
   identity, distinct writer/restore role/profile/subject identities, issuer
   CN, exact public CA/CRL material, and independent certificate-issuance,
   key-custody, credential-boundary, and revocation-material preparation
   digests. This receipt attests preparation only: it never claims that a
   disabled AWS trust anchor accepted a valid leaf or rejected a revoked leaf.
   The preparation controls authorize only
   `RolesAnywhereActivation=ENABLED` with lifecycle still disabled.
   A separate transition-authorization receipt uses schema
   `nexus.sonarqube-stack-transition-authorization.v1`. It binds the canonical
   preauthorization receipt digest, exact full CloudFormation change-set ARN,
   SHA-256 identities of the one AWS executor ARN and UserId, and an exact
   prior-stack snapshot captured no more than two hours before issuance. The
   snapshot includes the stack ID/status and every governed activation,
   receipt, owner-key, and protected-template parameter.

   Sign and re-verify the reviewed private activation payload from an
   owner-controlled mode-0700 directory. The signer requires a mode-0600
   private key at runtime but never copies or prints it:

   ```sh
   node scripts/quality-sonar-stack-receipt.mjs sign-activation \
     --input /absolute/private/activation-payload.json \
     --private-key /absolute/off-host/owner-ed25519-private.pem \
     --key-id REPLACE_WITH_OWNER_KEY_ID \
     --output /absolute/private/activation-receipt.json
   node scripts/quality-sonar-stack-receipt.mjs verify-activation \
     --input /absolute/private/activation-receipt.json \
     --public-key /absolute/reviewed/owner-ed25519-public.pem \
     --key-id REPLACE_WITH_OWNER_KEY_ID
   ```

   Immediately before creating the change set, capture the exact prior stack
   state and executor hashes. Then use the activation verifier's canonical
   `receiptSha256` to create, but not execute, the second reviewed update
   change set with `RolesAnywhereActivation=ENABLED` while lifecycle remains
   disabled. Never substitute the file's presentation-byte digest. After
   CloudFormation returns the full change-set ARN, add that ARN to a transition
   payload that retains the already-captured prior state and whose
   `receiptSha256` is the activation receipt digest. Sign and verify the
   transition receipt:

   ```sh
   node scripts/quality-sonar-stack-receipt.mjs sign-transition \
     --kind activation \
     --input /absolute/private/activation-transition-payload.json \
     --receipt /absolute/private/activation-receipt.json \
     --private-key /absolute/off-host/owner-ed25519-private.pem \
     --key-id REPLACE_WITH_OWNER_KEY_ID \
     --output /absolute/private/activation-transition-receipt.json
   node scripts/quality-sonar-stack-receipt.mjs verify-transition \
     --kind activation \
     --input /absolute/private/activation-transition-receipt.json \
     --receipt /absolute/private/activation-receipt.json \
     --public-key /absolute/reviewed/owner-ed25519-public.pem \
     --key-id REPLACE_WITH_OWNER_KEY_ID
   ```

   The activation UPDATE must name the precreated
   `RolesAnywhereActivationRollbackAlarmArn` as its sole CloudFormation
   rollback trigger with a 15-minute monitoring window. The alarm uses a
   high-resolution 30-second metric, four evaluation periods, and
   `TreatMissingData=breaching`, so controller loss is detected within 120
   seconds. The lifecycle UPDATE must explicitly replace rollback triggers
   with an empty list and monitoring time zero.

   Execute only through
   `/usr/local/sbin/quality-sonar-cloudformation-activate`. Run `--operation
   inspect` first and owner-review its new mode-0600 receipt. Then run
   `--operation execute --execute-reviewed-change-set` with that exact receipt
   digest, a new journal, and a new result path. The controller re-verifies the
   signed transition, exact parameters, exact resource-change allowlist,
   template bytes, termination protection, execution role, notifications,
   tags, and rollback configuration before priming the static alarm. Pass the
   canonical trusted OpenSSL executable with `--openssl-bin`; the controller
   binds each probe profile to the exact stack trust anchor/profile/role and
   proves the revoked probe certificate serial is present in the exact live
   CRL. It durably records `executionAttempted` only after rechecking the signed
   authorization, with one idempotent execution-token digest. After that
   durable write, it rechecks the exact signed authorization again immediately
   before mutation. It renews the lease only between bounded sequential AWS
   calls. If
   the process or owner session disappears, lease renewal stops and
   CloudFormation rolls back. Resume an already-started journal only with
   `--operation recover-or-finalize`; recovery reconciles a write-ahead attempt
   only when the exact change set or stack proves CloudFormation accepted it,
   and never starts an unaccepted change set.

   Before the first lease heartbeat, the controller reopens and verifies the
   exact signed transition receipt and requires enough remaining authorization
   lifetime for the 90-second alarm-prime bound, two bounded AWS commands, a
   five-second allowance, and the final pre-mutation verification. During
   alarm priming, every heartbeat is preceded sequentially by another
   non-expired verification of that unchanged receipt and another authorization
   lifetime-margin check. There is no background heartbeat. Receipt drift,
   expiry, or insufficient remaining lifetime stops renewal before the next
   heartbeat and leaves the alarm fail-safe intact.

   A recovery may close a journal as `not-executed` only when the journal has
   the exact unattempted schema and identities, CloudFormation still reports
   the exact change set as `AVAILABLE`, execution reconciliation is exactly
   unaccepted, and the stack remains at one of the reviewed complete
   predecessor states. That closeout records that services remain blocked and
   the change set remains unexecuted. It never preserves permission to execute:
   any later attempt requires a new owner authorization and a new non-expired
   signed transition receipt.

   Immediately after the update, run the installed read-only verifier in
   `activation-transition` mode with the same owner AWS profile. It requires
   one matching successful `ExecuteChangeSet` CloudTrail event, the exact
   completed change set and parameters, the same stack ID, an execution time
   inside the signed window, and the full live infrastructure state. CloudTrail
   delivery can be eventually consistent; retry with a new evidence output
   path while the receipt remains valid rather than weakening validation. Its
   evidence parent must be a caller-supplied canonical
   root-owned mode-0700 directory and the output must not already exist.
   Copy each signed receipt and backup-success receipt into that boundary as
   root-owned mode 0600 before verification; never copy the private signing
   key:

   ```sh
   sudo /usr/local/sbin/quality-sonar-aws-stack-state verify \
     --mode activation-transition \
     --region eu-west-1 \
     --stack-name REPLACE_WITH_STACK_NAME \
     --aws-config /absolute/root-private/owner-and-probe-aws-config \
     --aws-profile REPLACE_WITH_OWNER_PROFILE \
     --backup-probe-profile nexus-sonarqube-backup \
     --revoked-probe-profile nexus-sonarqube-revoked-probe \
     --openssl-bin /usr/bin/openssl \
     --activation-receipt /absolute/root-private/activation-receipt.json \
     --activation-transition-receipt /absolute/root-private/activation-transition-receipt.json \
     --public-key /absolute/root-private/owner-ed25519-public.pem \
     --key-id REPLACE_WITH_OWNER_KEY_ID \
     --template /absolute/protected-main/ops/sonarqube/aws-s3-stack.yaml \
     --evidence-out /absolute/root-private/activation-transition.v3.json
   ```

   Preserve that root-owned mode-0600 output as the durable activation
   transition record. A later steady-state verification may use an expired
   activation receipt only when that exact record is supplied:

   ```sh
   sudo /usr/local/sbin/quality-sonar-aws-stack-state verify \
     --mode steady \
     --region eu-west-1 \
     --stack-name REPLACE_WITH_STACK_NAME \
     --aws-profile REPLACE_WITH_OWNER_PROFILE \
     --activation-receipt /absolute/root-private/activation-receipt.json \
     --activation-transition-receipt /absolute/root-private/activation-transition-receipt.json \
     --activation-transition-record /absolute/root-private/activation-transition.v3.json \
     --aws-config /absolute/root-private/owner-and-probe-aws-config \
     --backup-probe-profile nexus-sonarqube-backup \
     --revoked-probe-profile nexus-sonarqube-revoked-probe \
     --openssl-bin /usr/bin/openssl \
     --public-key /absolute/root-private/owner-ed25519-public.pem \
     --key-id REPLACE_WITH_OWNER_KEY_ID \
     --template /absolute/protected-main/ops/sonarqube/aws-s3-stack.yaml \
     --evidence-out /absolute/root-private/new-steady-live-state.json
   ```

   Expired preauthorization and transition receipts alone never authorize or
   prove a transition. Do not
   pass `--allow-expired` to authorize execution; only the live verifier's
   steady mode may request historical signature verification, and only after
   it validates the exact durable successful-transition record.

   This verifier uses only read APIs, manually exhausts every paginated
   resource, IAM policy, attachment, and tag inventory, and requires the exact
   original template bytes, parameters, outputs, nine CloudFormation resources,
   trust-anchor certificate, CRL bytes, static rollback alarm, bucket
   controls/policy/lifecycle/tags, IAM trust and inline policies, one-role
   900-second Roles Anywhere profiles, a valid credential and exact-prefix
   listing, and an explicit revoked-certificate denial. Any attached policy,
   unversioned restore read, mutable-current read, extra restore namespace, or
   incomplete page fails verification.

   Preserve the successful v3 activation-transition evidence. Put its exact
   path in `SONAR_AWS_ACTIVATION_EVIDENCE`; stack start, direct backup, and
   timer enablement all remain blocked until this record proves the exact trust
   anchor, CRL, profiles, positive prefix access, revoked-certificate denial,
   and successful owner-authorized transition. Lifecycle remains disabled
   until after the stack is installed, started with its timer disabled, and
   the first direct PostgreSQL dump is remotely verified below.

   The stack enforces TLS 1.2 or newer, AES-256 default encryption, complete
   public-access blocking, bucket-owner-enforced ownership, exact-prefix
   access, and immutable S3 VersionIds. The writer can create visible delete
   markers for the client-owned 7-daily/4-weekly policy but cannot delete
   versions or mutate bucket controls. Disabled-first lifecycle later removes
   noncurrent daily versions after 35 days and weekly versions after 120 days
   without weakening the visible recovery tiers. Every successful backup
   receipt binds the exact encrypted object and checksum object VersionIds; a
   restore drill must pass both VersionIds and never download the mutable
   current key. The restore role, its profile session policy, and the bucket
   policy grant only `s3:GetObjectVersion` on the exact daily and weekly
   namespaces. They grant no listing and no `s3:GetObject`.
6. After Docker is installed, while Sonar remains stopped, run another
   installed `quality-sonar-preflight` into a new root-owned private directory.
   A passing
   result is valid for two hours and only for the current Linux boot. Write
   the exact absolute paths, one line each, into these root-owned mode-0600
   pointer files:

   - `/etc/sonarqube/preflight-evidence.path` — the fresh preflight directory;
   - `/etc/sonarqube/ollama-soak-evidence.path` — the canonical production
     collector `result.json`, recursively bound to the staging window;
   - `/etc/sonarqube/ollama-cleanup-result.path` — the successful cleanup.

   Stack start fails unless the checksummed snapshots still match, including
   the exact protected-account/Docker-socket/ACL, daemon user-namespace,
   subordinate-range, mapped bind-owner, and automatic-updater boundary.
   Memory must be
   at least 16 GiB, load-15 is below 6, swap deltas and 24-hour OOM count are
   zero, PM2 and health stayed stable, Docker client/server versions were
   captured, and the Ollama evidence chain is exact. The pre-Docker baseline
   can never authorize stack start.
   Generate a new preflight after every boot; do not configure unattended
   startup that can bypass this post-boot check. Both Compose services use
   `restart: "no"`, so a Docker daemon or host restart cannot start them
   around the root wrapper.
7. Pull the two exact digest-qualified image references from
   `/srv/sonarqube/images.lock.env` sequentially and verify both local image
   identities. The root wrapper refuses an absent image and starts Compose
   with `--pull never`, so startup cannot fetch from a registry. Then verify
   backup encryption, credentials, endpoint, and bucket access and start only
   through the installed root wrappers:

   ```sh
   sudo /usr/local/sbin/quality-sonar-backup \
     --config /etc/sonarqube/backup.env --verify-config
   sudo /usr/local/sbin/quality-sonar-stack start
   ```

   Start repeats backup readiness and proves that `ollama.service` still has
   the fixed effective envelope and that the live sole retained tag/digest
   matches cleanup evidence. Its final read immediately before Compose repeats
   the protected-account/Docker/auto-updater boundary and a one-second live
   memory, load, swap, 24-hour OOM, and four-process PM2 stability sample.
   Historical evidence cannot authorize a reintroduced tag, expanded envelope,
   authority drift, or newly pressured production host.
8. Change the default Sonar administrator password, force authentication, and
   issue a project-scoped analysis token before the first scan.
9. Create a separate monitoring identity with only `Browse` permission on
   `nexus-hub-backend`; do not grant project/global administration, Execute
   Analysis, or access to another project. The helper uses only the
   project-scoped `/api/ce/component` response. The release monitor validates
   unique task identities and counts both pending queue entries and a current
   `IN_PROGRESS` task; a completed current task is the last executed task and
   is not active. Malformed, duplicate, cross-project, or unknown task state
   fails closed. Store its token only in root-owned mode-0600
   `/etc/sonarqube/release-monitor.token`, install
   `nexus-sonar-release-monitor.sudoers`, and validate it with `visudo -cf`.
   The deploy account can then execute only the exact command
   `sudo /usr/local/sbin/quality-sonar-release-state --project nexus-hub-backend --json`.
   It receives the schema/status/project/active-count aggregate, never the
   token or unrelated project activity.
10. After the first healthy start and credential hardening, keep the timer
    disabled and run one direct backup. This invokes `pg_dump` in the pinned
    PostgreSQL container, encrypts before upload, verifies immutable S3
    VersionIds/checksums, and writes the root-owned
    `SonarBackupSuccessV2` receipt:

    ```sh
    sudo /usr/local/sbin/quality-sonar-backup \
      --config /etc/sonarqube/backup.env
    ```

    Sign and verify `nexus.sonarqube-lifecycle-bootstrap.v1` against that exact
    immutable backup receipt. Create a lifecycle UPDATE with
    `LifecycleActivation=ENABLED`, the canonical lifecycle receipt digest,
    `RollbackTriggers=[]`, and `MonitoringTimeInMinutes=0`. Sign its exact
    transition receipt, then use the same sequential controller in
    `--transition lifecycle` inspect/execute mode. Run the read-only verifier
    in `lifecycle-transition` mode with the activation record, both lifecycle
    receipts, and the backup receipt. Only after that durable lifecycle record
    passes may the owner enable the timer:

    ```sh
    sudo /usr/local/sbin/quality-sonar-backup \
      --config /etc/sonarqube/backup.env --enable-timer
    sudo /usr/local/sbin/quality-sonar-backup --verify-freshness \
      --max-age-hours 26
    sudo systemctl is-enabled --quiet nexus-sonarqube-backup.timer
    sudo systemctl is-active --quiet nexus-sonarqube-backup.timer
    ```

    Never use `UsePreviousValue` for a receipt, signing-key, template-digest,
    activation, CA, or CRL parameter. A failed backup retries every 15 minutes,
    including a non-blocking
    release/Sonar mutex collision. It never waits behind or runs alongside a
    release. Alert on a failed freshness check; a successful systemd unit
    invocation is not a substitute for the root-owned remote-backup receipt.
    Retention is reconciled and re-listed by distinct UTC day and ISO week:
    repeated manual runs or retries cannot consume multiple 7-daily/4-weekly
    slots. Every selected historical data/checksum pair is then bound to its
    exact S3 VersionIds, metadata digest, and S3 SHA-256 checksums before the
    receipt can call it complete. The receipt records both the configured
    targets and the observed distinct-period counts, and reports
    `targetReached: false` while a new installation is still accruing its
    initial retention history.
    Before a later asset reinstall, stop and disable the timer as required by
    the transactional installer, then repeat this owner action after review.

Install the reviewed scanner bundle on the Mac before the first scan. The lock
file pins SonarScanner CLI 8.1.0.6389 for macOS arm64, the official HTTPS
archive URL, the archive SHA-256, and the launcher SHA-256. Download that exact
URL from `scanner.lock.env`, verify the archive SHA-256 before extraction, and
write only the expected digest into a scanner-user-owned mode-0600
`.nexus-archive-sha256` file at the extracted bundle root. Then verify it:

```sh
scripts/quality-sonar-verify-scanner.sh \
  --scanner-bin /absolute/path/to/sonar-scanner-8.1.0.6389-macosx-aarch64/bin/sonar-scanner
```

The scan refuses a symlink, writable launcher, missing/mismatched bundle
receipt, launcher digest drift, or runtime version/platform drift.

Run scripts/quality-sonar-scan.sh on the Mac. It creates a temporary clean
worktree at the exact fetched origin/main, refuses active local or remote
release locks, optionally imports an exact-SHA coverage manifest, submits the
analysis, and waits for Compute Engine completion. It never runs tests.
coverage-manifest.example.json documents the sidecar contract expected from a
downloaded exact-SHA coverage artifact; absent that sidecar, the scan omits
coverage instead of generating it again.

For IDE Connected Mode, keep an SSH tunnel to `127.0.0.1:9000`, configure the
IDE connection as `http://127.0.0.1:9000`, and bind only the
`nexus-hub-backend` project. Keep that developer token in the IDE credential
store; do not reuse the scanner or root monitor token and do not expose port
9000 to make IDE setup easier.

Release-impact rollout check
----------------------------

Sonar stays advisory, but initial enablement must prove that one successful
exact-SHA scan does not regress application p50 or p95 latency by more than
5%. The comparison is a rollout check, not CI or release evidence, and all
requests are sequential. Capture a mode-0600 baseline for the deployed
protected-main SHA, run the normal advisory scan with an explicit output, then
capture the same endpoint immediately afterward. Run both captures on
ServerDominguez so the loopback probe excludes Internet/tunnel noise; run the
scan from the clean Mac checkout, then transfer only its mode-0600 JSON result
to the same private server evidence directory before comparison:

```sh
# ServerDominguez
sudo /usr/local/sbin/quality-sonar-latency-gate.mjs capture \
  --phase before --url http://127.0.0.1:8200/health \
  --runtime-sha REPLACE_WITH_DEPLOYED_40_HEX_SHA --service nexus-hub \
  --output /private/evidence/sonar-latency-before.json
# Mac (then copy only sonar-scan.json to the server evidence directory)
npm run quality:sonar -- \
  --token-file /private/secrets/sonar-token \
  --output /private/evidence/sonar-scan.json
# ServerDominguez
sudo /usr/local/sbin/quality-sonar-latency-gate.mjs capture \
  --phase after --url http://127.0.0.1:8200/health \
  --runtime-sha REPLACE_WITH_THE_SAME_40_HEX_SHA --service nexus-hub \
  --output /private/evidence/sonar-latency-after.json
sudo /usr/local/sbin/quality-sonar-latency-gate.mjs compare \
  --before /private/evidence/sonar-latency-before.json \
  --after /private/evidence/sonar-latency-after.json \
  --sonar-scan-evidence /private/evidence/sonar-scan.json \
  --output /private/evidence/sonar-latency-comparison.json
```

The gate requires at least 30 samples per phase, the same runtime/service/URL,
a successful advisory scan between the two captures, a four-hour maximum
comparison window, and at most 5% regression for both percentiles. A failure
blocks Sonar rollout and calls for stopping/tuning the advisory stack; it does
not weaken or block the production release path.

Backups are PostgreSQL custom-format dumps encrypted with an off-host age
recipient before upload to S3-compatible storage. The hook retains seven daily
and four weekly distinct periods and atomically records the last remotely
verified success for the 26-hour freshness check. Run the restore/reindex drill
quarterly on a separate Docker host, or stop the advisory live stack first;
the drill refuses to share the host with a running live Sonar container. Write
each drill result to a new direct child of the installer-created, root-owned
mode-0700 `/var/lib/nexus-sonarqube/restore-evidence` directory, using a name
such as `sonar-restore-2026Q3.json`; the drill refuses existing files,
symlinks, subdirectories, and paths outside that boundary.
