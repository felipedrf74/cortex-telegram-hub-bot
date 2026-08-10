# Nexus local backups

This is the deliberately small, same-host recovery system for the current
single-server deployment. It protects against a bad release, accidental
database mutation, and local corruption. It does not protect against loss of
ServerDominguez or its NVMe device.

The hourly timer uses SQLite's online backup API, checks database integrity and
foreign keys, encrypts the result with `age`, and keeps 24 hourly, 30 daily,
and 4 weekly points. `pre-promotion` creates an additional point and keeps the
latest 10. The weekly verification decrypts the newest hourly point into a
private temporary directory, verifies it, records a receipt, and removes the
plaintext.

The hourly and pre-promotion producers open the source read-only without
asserting SQLite immutable mode and copy it in one backup step, so a read-only
WAL source cannot restart between chunks. Both snapshot units have a 12-minute
start timeout, which fails before the release caller's 15-minute backup budget.

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
   during the owner-authorized first-cutover fallback.
4. Validate and prove one round trip:

   ```sh
   sudo /usr/local/libexec/nexus-local-backup/local-backup.py verify-config
   sudo /usr/local/libexec/nexus-local-backup/local-backup.py backup
   sudo /usr/local/libexec/nexus-local-backup/local-backup.py restore-verify
   ```

5. Enable the two timers only after the proof succeeds:

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
