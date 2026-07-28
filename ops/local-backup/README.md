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

## Install and activate

1. Run `local-backup-systemd-install.sh` from the reviewed root-owned release
   source.
2. Generate a dedicated `age` identity. Store it at
   `/etc/nexus-local-backup/age-identity.txt`, root-owned mode 0600, and put
   its public recipient in `backup.env`.
3. Install `backup.env.example` as
   `/etc/nexus-local-backup/backup.env`, root-owned mode 0600, with the live
   SQLite path confirmed.
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

Promotion takes its own point before changing the PM2 release:

```sh
sudo -n /usr/bin/systemctl start nexus-local-backup-pre-promotion.service
```

The installed sudoers rule grants `dominguez` only that exact systemd start
command. The call waits for the root-owned encrypted backup to complete; a
nonzero status must abort promotion before PM2 or the `current` symlink changes.

Restore never overwrites an existing destination. Decrypt a selected recovery
point into a new private path with:

```sh
sudo /usr/local/libexec/nexus-local-backup/local-backup.py restore-verify \
  --backup /srv/nexus-backups/application/hourly/REPLACE.sqlite.age \
  --destination /srv/nexus-backups/application/manual-restore.sqlite
```
