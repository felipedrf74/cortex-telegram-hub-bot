---
name: release-operator
description: Inspect or recover the unattended signed-container release path. Protected-main CD is unattended; live infrastructure mutations and manual recovery require explicit owner authorization.
---

# Nexus Release Operator

## Default: unattended signed-container CD

Green CI on protected `main` publishes the signed immutable OCI release
payload. The root-owned VPS timer pulls, verifies, stages, promotes, observes,
rolls back when necessary, and writes immutable evidence without an operator
release step.

Read these canonical authorities before operating the path:

- `docs/release/continuous-deployment.md`
- `docs/release/release-evidence-contract.md`
- `ops/nexus-release/README.md`, especially **§7 Verify**

Authoritative state is
`/var/lib/nexus-release/state/release-state.json`; immutable receipts are under
`/var/lib/nexus-release/receipts/`. The checked-in
`docs/release/release-state.json` is generated and non-authoritative.

## Inspect

From a backend checkout, the default read is the argument-free root-owned VPS
observer; it is the only passwordless remote release command:

```bash
/usr/bin/ssh ServerDominguez \
  sudo -n /usr/local/sbin/nexus-release-state-view
```

If the bounded view shows a block, use an attended PTY for the exact root-only
inspection on the installed VPS; enter the sudo password locally and never in a
prompt, transcript, or environment:

```bash
/usr/bin/ssh -t ServerDominguez \
  'sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
    /usr/bin/npm --prefix /opt/nexus-release/checkout \
    run release:cd:ack -- --show'
/usr/bin/ssh -t ServerDominguez \
  'sudo /usr/bin/systemctl status nexus-release-poller.service --no-pager'
/usr/bin/ssh -t ServerDominguez \
  "sudo /usr/bin/journalctl -u nexus-release-poller.service --since '2 hours ago' --no-pager"
```

The first command is the exact blocked-state inspection. The generated state
view is for operators only; receipts and runtime proof outrank it.

## Block and recovery

Do not clear, rewrite, or narratively override a block. For
`unprovable_active_release`, do **not** acknowledge: run the same locked poller
that performs automatic recovery, then inspect its journal.

```bash
sudo /usr/bin/systemctl start nexus-release-poller.service
sudo /usr/bin/journalctl -u nexus-release-poller.service --since '2 hours ago' --no-pager
```

The direct equivalent is:

```bash
sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
  DOCKER_CONFIG=/etc/nexus-release/docker \
  NEXUS_RELEASE_NODE_BIN=/usr/bin/node \
  NEXUS_RELEASE_GIT_BIN=/usr/bin/git \
  NEXUS_RELEASE_FLOCK_BIN=/usr/bin/flock \
  NEXUS_RELEASE_SYSTEMCTL_BIN=/usr/bin/systemctl \
  NEXUS_RELEASE_DOCKER_BIN=/usr/bin/docker \
  NEXUS_RELEASE_SQLITE_BIN=/usr/bin/sqlite3 \
  NEXUS_RELEASE_LSOF_BIN=/usr/bin/lsof \
  NEXUS_RELEASE_SCP_BIN=/usr/bin/scp \
  NEXUS_RELEASE_SSH_BIN=/usr/bin/ssh \
  /opt/nexus-release/checkout/scripts/release-poll.sh
```

Exit 75 means a governed lock is already held; inspect the active service
instead of starting a competing path. Recovery must end in an immutable
`rolled_back` or `rollback_failed` receipt. It never restores database bytes
automatically.

The signed `:main` payload is discovery, not freshness authority. The poller
uses pinned `/usr/bin/git` to compare the candidate source with current public
protected-main head at admission, after staging, and after backup, ledger, and
exact backup revalidation immediately before production write-ahead. An outage
defers without mutation; a mismatch retires the exact staging candidate, while
teardown failure hard-blocks and retains it. The quiet exact completed-payload
no-op stays offline-safe.

Candidate runtime plans are v2. Normal/crash predecessor recovery materializes
a v3 verification-only plan binding the predecessor's exact identity/inventory
and the successor identity plus exact ordered digest-bound compatible suffix
already applied. Unknown or non-prefix ledger rows are not a rollback bypass.

Only after the receipt and `--show` prove a settled acknowledgeable block may
the exact release id be acknowledged:

```bash
sudo /usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home \
  /usr/bin/npm --prefix /opt/nexus-release/checkout \
  run release:cd:ack -- --confirm <release-id>
```

Missing payload, backup, predecessor, integrity, Compose, running-image, or
receipt proof is `MANUAL_REQUIRED`. Do not deploy, mutate production, restore a
database, change trust/configuration, or improvise a second release path without
explicit owner authorization.

## First-cutover-only PM2 fallback

The legacy PM2 procedure is not the default release workflow. It exists only for
the one-time first container cutover and its 14-day rollback window. Follow the
audited procedure in
`ops/nexus-release/README.md#1b-quiesced-transition-of-the-existing-production-and-staging-databases`;
do not copy old PM2 commands into routine release prompts or handoffs.

Before a normal handoff, use the repository-selected verification and
`verifiable-reward-check`. If authorization or live evidence is absent, report
`MANUAL_REQUIRED`; never turn narrative text into release evidence.
