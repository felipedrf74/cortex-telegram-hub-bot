Advisory SonarQube on ServerDominguez
=====================================

This directory is an installation template, not an installer. It never installs
Docker or changes a live host. Copy only the entries in install-layout.tsv
during an approved operations window, preserving the declared owner and mode.

Safety contract
---------------

- SonarQube is advisory. It is not a release, signing, application-health, or
  promotion dependency.
- The web port is published only as 127.0.0.1:9000; PostgreSQL has no host port.
  Use an SSH tunnel from the Mac for the UI, Connected Mode, and scans.
- Do not add the application or deploy account to the docker group. The
  root-owned systemd unit is the operator boundary.
- Do not use Watchtower or another automatic image updater. Resolve, review,
  and commit each image digest explicitly.
- Run scripts/quality-sonar-preflight.sh before installing Docker. It is
  read-only and stores private network/health evidence below its output path.
- The live database and Sonar state use explicit host bind mounts below
  `/srv/sonarqube/data`; there are no opaque Docker named volumes. Root owns
  the stack and data boundaries, while only the pinned container UIDs own
  their specific writable children.
- Stack lifecycle, backup/restore operations, an advisory scan, and a release transaction share
  `/run/lock/nexus-release-sonar.lock`. A scan or stack operation never waits
  behind a release: it exits and can be retried after the release completes.
  The lock must be precreated by `nexus-release-sonar-lock.conf` as
  `root:dominguez` mode 0660; no caller may create it opportunistically with
  its own umask.

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
3. Before Docker installation, capture the maintenance baseline with
   `scripts/quality-sonar-preflight.sh --output REPLACE_WITH_NEW_PRIVATE_DIRECTORY`. Missing
   firewall tools are recorded as `not_installed`; at least one authoritative
   UFW, nftables, or iptables snapshot is mandatory. Install official Docker
   Engine and Compose only after owner review of listeners, routes, firewall,
   Tailscale, Cloudflare, PM2, health, memory, load, swap, and OOM evidence.
4. Install /etc/sonarqube/sonarqube.env and /etc/sonarqube/backup.env from the
   examples with root ownership and mode 0600. Put the project scanner token in
   a separate Mac-side mode-0600 file; never put it in either Compose file.
5. Install the file layout from `install-layout.tsv`. Provision the host bind
   directories exactly as declared in `data-layout.tsv`; for the pinned images
   that means root-owned mode-0750 boundaries, PostgreSQL `999:999` mode 0700,
   and SonarQube `1000:1000` mode 0750. The Compose file sets
   `create_host_path: false`, and the stack wrapper rejects missing, symlinked,
   mis-owned, or mis-moded paths rather than letting Docker create them.
   Run `systemd-tmpfiles --create /etc/tmpfiles.d/nexus-release-sonar-lock.conf`
   and verify the shared lock's declared owner/mode before any scan, backup,
   stack operation, or release transaction.
6. After Docker is installed, while Sonar remains stopped, run another
   `quality-sonar-preflight` into a new root-owned private directory. A passing
   result is valid for two hours and only for the current Linux boot. Write
   the exact absolute paths, one line each, into these root-owned mode-0600
   pointer files:

   - `/etc/sonarqube/preflight-evidence.path` — the fresh preflight directory;
   - `/etc/sonarqube/ollama-soak-evidence.path` — the canonical production
     collector `result.json`, recursively bound to the staging window;
   - `/etc/sonarqube/ollama-cleanup-result.path` — the successful cleanup.

   Stack start fails unless the checksummed snapshots still match, memory is
   at least 16 GiB, load-15 is below 6, swap deltas and 24-hour OOM count are
   zero, PM2 and health stayed stable, Docker client/server versions were
   captured, and the Ollama evidence chain is exact. The pre-Docker baseline
   can never authorize stack start.
   Generate a new preflight after every boot; do not configure unattended
   startup that can bypass this post-boot check. Both Compose services use
   `restart: "no"`, so a Docker daemon or host restart cannot start them
   around the root wrapper.
7. Change the default Sonar administrator password, force authentication, and
   issue a project-scoped analysis token before the first scan.
8. Create a separate monitoring identity with only `Browse` permission on
   `nexus-hub-backend`; do not grant project/global administration, Execute
   Analysis, or access to another project. The helper uses only the
   project-scoped `/api/ce/component` queue. Store its token only in root-owned mode-0600
   `/etc/sonarqube/release-monitor.token`, install
   `nexus-sonar-release-monitor.sudoers`, and validate it with `visudo -cf`.
   The deploy account can then execute only the exact command
   `sudo /usr/local/sbin/quality-sonar-release-state --project nexus-hub-backend --json`.
   It receives the schema/status/project/active-count aggregate, never the
   token or unrelated project activity.

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
node scripts/quality-sonar-latency-gate.mjs capture \
  --phase before --url http://127.0.0.1:8200/health \
  --runtime-sha REPLACE_WITH_DEPLOYED_40_HEX_SHA --service nexus-hub \
  --output /private/evidence/sonar-latency-before.json
# Mac (then copy only sonar-scan.json to the server evidence directory)
npm run quality:sonar -- \
  --token-file /private/secrets/sonar-token \
  --output /private/evidence/sonar-scan.json
# ServerDominguez
node scripts/quality-sonar-latency-gate.mjs capture \
  --phase after --url http://127.0.0.1:8200/health \
  --runtime-sha REPLACE_WITH_THE_SAME_40_HEX_SHA --service nexus-hub \
  --output /private/evidence/sonar-latency-after.json
node scripts/quality-sonar-latency-gate.mjs compare \
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
and four weekly objects. Run the restore/reindex drill quarterly on a separate
Docker host, or stop the advisory live stack first; the drill refuses to share
the host with a running live Sonar container.
