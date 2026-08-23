# Nexus local backups

This is the deliberately small, same-host recovery system for the current
single-server deployment. It protects against a bad release, accidental
database mutation, and local corruption. It does not protect against loss of
the release host or its NVMe device.

The hourly timer uses SQLite's online backup API, checks database integrity and
foreign keys, encrypts the result with `age`, and keeps 24 hourly, 30 daily,
and 4 weekly points. `pre-promotion` creates an additional point and keeps the
latest 10. The weekly verification decrypts the newest hourly point into a
private temporary directory, verifies it, records a receipt, and removes the
plaintext.

The Monday 09:30 release heartbeat also validates this recovery surface. It requires
the latest backup receipt and encrypted artifact to be no more than two hours
old, and the immutable restore-verification receipt to be no more than eight
days old. The release control plane also runs a failure-only service every
minute at second 20. It drains due notification retries every minute, while a
durable gate limits the full encrypted-artifact proof to the next wall-clock
minute 20 and then at most once per hour. The proof holds the producer lock in
shared nonblocking mode. An active producer marker defers only the full proof;
due notification retries have already drained and the minute timer retries the
proof without advancing its hourly gate. Producers publish distinct runtime
intent markers before Python. Scheduled backup/restore contention persists a
root-only retry record and returns exit 75 to a fixed privileged launcher,
which waits one minute and retries inside the same oneshot activation;
pre-promotion retains the bounded 330-second exclusive-lock wait. Retry state
is capped at 45 attempts and 45 minutes and is cleared on acquisition or
exhaustion. The weekly
heartbeat waits up to 90 minutes for every producer marker,
then acquires the same descriptor-bound shared lock and has a separate
five-minute proof bound; its service has a 100-minute aggregate timeout. Thus a
producer already active prevents a new failure-only reader, while a reader
already active makes a scheduled producer retry without paging and makes
pre-promotion wait rather than fail. The weekly heartbeat
remains the only success notification.

The verifier accepts only the closed producer receipts and the exact
root-owned mode-0600 checksum companion for every present `.age` artifact. A
checksum is one canonical line containing the lowercase SHA-256 digest, two
spaces, the exact artifact basename, and a newline. An hourly retention pass
may legitimately prune both the artifact and checksum named by a still-fresh
weekly restore receipt; a half-pair is invalid. If both remain, they are
descriptor-bound and re-hashed. The verifier also descriptor-binds
`/etc/nexus-local-backup/backup.env`, the configured age identity, and
`/usr/bin/age-keygen`, then derives the public recipient under a scrubbed
environment and requires it to match the closed config without retaining or
logging identity bytes. Missing, unsafe, mismatched, future-dated, stale, or
noncanonical evidence pages as a release failure and makes the checker exit
nonzero.

Backup, restore-verification, and liveness failures share the root-owned
`/var/lib/nexus-release/operational-alerts` outbox. A failure is persisted
before delivery attempt 1; attempts 2 and 3 become due after 60 and 120 seconds
respectively, on separate timer invocations. A third transport failure becomes
durable `dead_letter` state, keeps the service nonzero, and is never silently
treated as delivered. A later proved success records recovery without sending
a recovery message and rearms the same failure code. An undelivered open event
continues retrying even if its source recovers between attempts. Do not edit
the outbox JSON: repair the source or notification channel and run its exact
systemd unit successfully. A proved source recovery closes delivered and
dead-letter history so a later incident pages again.

The hourly and pre-promotion producers open the source read-only without
asserting SQLite immutable mode and copy it in one backup step, so a read-only
WAL source cannot restart between chunks. Each hourly producer attempt and the
pre-promotion snapshot have an 18-minute work bound; each restore-verification
attempt has a 36-minute work bound. The scheduled hourly and restore units have
67- and 85-minute aggregate bounds, respectively, covering the 45-minute
contention window plus one final work attempt, process-group termination, and
scheduling margin. The release caller has a 22-minute backup budget, which
applies only to the
non-retrying pre-promotion snapshot and outlives its bounded service settlement
with margin.
The weekly restore timer is fixed at Sunday 04:15 UTC with one-minute
accuracy and no randomized delay. If its full service and stop budgets overlap
the earliest 05:00 hourly backup, the hourly unit's governed launcher retries
exit 75 instead of failing or paging; the same contract covers
Persistent timer catch-up after a reboot.

Publication is power-loss ordered: each encrypted artifact and checksum is
fsynced before and after its atomic rename and the containing directory is
fsynced before `last-success.json` is published with the same durable ordering.
The receipt never authorizes bytes that exist only in the kernel page cache.
It also records canonical `startedAt` before the producer attempts its lock or
opens SQLite. Release admission requires `startedAt` to be no earlier than that
release's start request and `completedAt` to be no earlier than `startedAt`, so
an older already-activating oneshot is never mistaken for a fresh backup.

## Install and activate

1. Run `local-backup-systemd-install.sh` from the reviewed root-owned release
   source.
2. Generate a dedicated `age` identity. Store it at
   `/etc/nexus-local-backup/age-identity.txt`, root-owned mode 0600, and put
   its public recipient in `backup.env`.
3. Install `backup.env.example` as
   `/etc/nexus-local-backup/backup.env`, root-owned mode 0600, with the live
   SQLite path confirmed. After container cutover the production source must be
   `/var/lib/nexus-hub/production/data/bot.db`; the old PM2 path is valid only
   during the owner-authorized first-cutover fallback. The shipped unit files
   allow the legacy PM2 data directory only through a neutral optional
   `ReadWritePaths` entry (`-/var/lib/nexus-hub/legacy/telegram-hub-bot/data`);
   deployments using the legacy home layout must override that path with a
   systemd drop-in.
4. Provision the dedicated release Telegram bot/chat in
   `/etc/nexus-release/poller.env`. The hourly and restore-verification units
   use that channel only for immediate failure alerts. They start the Python
   producer through a clean `env -i`, so neither credential reaches
   `local-backup.py`, its arguments, or its output. `ExecStopPost` inherits the
   two notification values only as environment, binds the nonsecret unit
   identity in an exact reviewed CLI argument, reads systemd's native
   `SERVICE_RESULT`, and invokes an immutable privileged launcher. Before Node
   starts, that launcher erases every inherited exported name and reconstructs
   an allowlist containing only a fixed `PATH`/`HOME`, the native service
   result, and the two notification values. It then invokes the immutable alert
   helper with the exact nonsecret unit argument bound by the service. A stale
   environment-file unit identity cannot override that argument. Credentials
   never appear in a command argument; arbitrary stale poller variables, the
   audit-mirror host, and language-runtime injection controls do not reach
   Node. Raw journals and provider response bodies are never notification
   inputs.
5. Validate and prove one round trip:

   ```sh
   sudo /usr/local/libexec/nexus-local-backup/local-backup.py verify-config
   sudo /usr/local/libexec/nexus-local-backup/local-backup.py backup
   sudo /usr/local/libexec/nexus-local-backup/local-backup.py restore-verify
   ```

6. Enable the two timers only after the proof succeeds:

   ```sh
   sudo systemctl enable --now \
     nexus-local-backup.timer \
     nexus-local-backup-restore-verify.timer
   ```

The root release poller starts the pre-promotion unit before the production
migrator and image switch, then verifies the fresh receipt and exact encrypted
artifact. A nonzero unit status or mismatched receipt aborts the release before
production mutation.

Only the PM2 first-cutover fallback invokes the same producer directly through
the retained narrow sudo rule:

```sh
sudo -n /usr/bin/systemctl start nexus-local-backup-pre-promotion.service
```

The installed sudoers rule grants `dominguez` only that exact systemd start
command. The call waits for the root-owned encrypted backup to complete; a
nonzero status must abort the fallback before PM2 or its `current` symlink
changes.

Restore never overwrites an existing destination. Decrypt a selected recovery
point into a new private path with:

```sh
sudo /usr/local/libexec/nexus-local-backup/local-backup.py restore-verify \
  --backup /srv/nexus-backups/application/hourly/REPLACE.sqlite.age \
  --destination /srv/nexus-backups/application/manual-restore.sqlite
```

An owner-invoked restore with `--destination` intentionally writes a manual
receipt variant that is not accepted as scheduled restore-liveness authority.
Run the scheduled `nexus-local-backup-restore-verify.service` afterward to
publish the closed no-destination receipt before relying on a healthy release
heartbeat.
