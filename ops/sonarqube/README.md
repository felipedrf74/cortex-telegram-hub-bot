# Advisory SonarQube on ServerDominguez

SonarQube is a private, advisory development tool. It does not gate pull
requests, staging, or production promotion and it never runs tests. The
application release and manual Sonar scans share
`/home/dominguez/.local/state/nexus-release/.release.lock`. The root-owned
`/run/lock/nexus-release-sonar.lock` is the cross-user mutex for release
transactions, backup, restore, and manual scans. A release also checks Sonar's
Compute Engine queue while holding that mutex, so a scanner that has already
detached cannot overlap a cutover.

## Runtime boundary

- Use only the immutable image references in `images.lock.env`.
- PostgreSQL has no published host port.
- Sonar binds only to `127.0.0.1:9000`.
- PostgreSQL is capped at 1 CPU/2 GiB and Sonar at 2 CPUs/6 GiB.
- Do not add the application or release accounts to the Docker group.
- Do not use Watchtower or automatic image updates.

Open the dashboard from the Mac through:

```sh
ssh -N -L 9000:127.0.0.1:9000 ServerDominguez
```

Then visit `http://127.0.0.1:9000`.

The authoritative Compose project remains the existing
`/home/dominguez/sonarqube/docker-compose.yml` with its existing named volumes.
Update it in place; do not create a second stack or migrate data to `/srv`.
`scripts/quality-sonar-local-install.sh` verifies the candidate preserves the
exact Compose project, `db`/`sonarqube` services, resolved volume definitions,
service mounts, and the volume identities attached to the running containers.
It stores one predecessor Compose file, installs the local backup helpers, and
leaves both stack restart and timer activation explicit.

## Local PostgreSQL backups

Install `backup.env.example` as `/etc/nexus-sonarqube-backup.env`, root-owned
mode 0600. It points at the existing Compose file and `.env`. Create
`/srv/nexus-backups/sonarqube` as root-owned mode 0700, then validate the
configuration and create one dump:

```sh
sudo /usr/local/sbin/quality-sonar-backup --verify-config
sudo /usr/local/sbin/quality-sonar-backup
sudo /usr/local/sbin/quality-sonar-backup --verify-freshness --max-age-hours 26
```

The job uses PostgreSQL custom format, validates the dump with
`pg_restore --list`, stores a SHA-256 pair locally, and retains the latest
seven copies. Enable the existing daily timer only after the first successful
dump:

```sh
sudo systemctl enable --now nexus-sonarqube-backup.timer
```

Prove a real database restore into a disposable PostgreSQL volume:

```sh
sudo /usr/local/sbin/quality-sonar-restore-drill \
  --backup /srv/nexus-backups/sonarqube/REPLACE.dump \
  --output /srv/nexus-backups/sonarqube/restore-evidence/restore-REPLACE.json
```

The drill verifies the checksum, restores the custom dump into a fresh
container volume, checks that public tables exist, emits a new root-only
receipt, and removes the volume.

These same-host copies protect against Sonar corruption and operator mistakes,
not loss of ServerDominguez or its NVMe device.

## Advisory scans

`npm run quality:sonar` operates from a clean protected-main checkout, imports
existing exact-SHA coverage when available, and never invokes Vitest or
Pytest. A scan refuses while a release transaction owns the shared lock. The
quality-gate result is feedback only.

The protected-main selected-test job writes
`sonar-coverage-evidence.json` beside its existing `lcov.info` and uploads
both in the same `selected-coverage-*` artifact. After downloading that
artifact without changing its relative paths, pass the evidence file to the
manual scan:

```sh
npm run quality:sonar -- \
  --token-file /private/mode-0600-sonar-token \
  --scanner-bin /private/pinned-sonar-scanner/bin/sonar-scanner \
  --coverage-manifest /private/selected-coverage/sonar-coverage-evidence.json
```
