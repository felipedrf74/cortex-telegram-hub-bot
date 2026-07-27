# ServerDominguez Ollama Observation, Cleanup, and Zero-Swap Runbook

These operations are manual, owner-reviewed, and separate from the release
path. They do not run during release, startup, installation, or SonarQube
setup. Each observation is one explicitly launched systemd one-shot. The
service owns one foreground collector until it finishes; it is not a daemon,
scheduler, recurring timer, background release worker, or second release lane.
Closing the Mac or SSH session does not terminate it.

## Evidence authority

Do not copy or hand-author an aggregate evidence JSON file. Cleanup, SonarQube
enablement, and the later zero-swap transition accept only a canonical
`result.json` produced by the installed repository collector:

`/usr/local/sbin/nexus-ollama-observation-collector.mjs`

Launch and inspect that collector only through:

`/usr/local/sbin/nexus-ollama-observation-control.mjs`

The root-owned request and journal under
`/var/lib/nexus-release/ollama-observation-control/` bind the phase, exact PM2
runtime SHA, prior evidence path and SHA-256, current boot, and final collector
result digest. The systemd unit holds the existing release/Sonar mutex for the
whole window. A release, Sonar operation, second observation, pending
maintenance reboot, queued governed-service transition, PM2 SHA mismatch, or
active Sonar Compute Engine task refuses or invalidates the run.
The control passes the request UUID, SHA-256 of the immutable request file,
and expected PM2 runtime SHA into the collector. Those three values recur in
the result, SQLite request aggregate, and every raw sample, and both sampled
PM2 rows must equal the requested SHA. Production records the exact staging
control request. Cleanup binds both staging and production control requests,
and zero-swap records the cleanup's production request binding.

The collector executes sequential checks every five minutes for 24 continuous
hours on one boot. Each mode-0600 raw sample records:

- exact Ollama inventory and retained-model digest from `/api/tags`;
- loaded-model residency from `/api/ps`;
- Nexus Hub and content-engine health;
- the exact PM2 release SHA, status, and restart count;
- Ollama systemd active state, restart count, and fixed resource envelope; and
- load, available memory, swap counters, memory-pressure counter, and kernel
  OOM events.

Samples form a bounded hash chain under a root-owned mode-0700 run directory.
The final request record is derived read-only from the phase's SQLite
`api_usage` table for the exact first/last sample timestamps. It requires the
governed `provider`, `model`, `pricing_status`, and `local_request_units`
columns, a successful SQLite quick check, one local unit per Ollama request,
and zero large- or unknown-model requests. A missing or invalid persistence
field fails the run. The collector writes `result.json` only after reopening
and validating the complete chain.

The model set before cleanup is exactly:

- retain `qwen2.5:3b-instruct-q4_K_M`;
- remove `gemma2:2b-instruct-q4_K_M`;
- remove `qwen3.6:27b-q4_K_M`; and
- remove `qwen3.6:35b-a3b-q4_K_M`.

The repository deliberately contains no runtime model digests or reusable
authorization template. Digests come only from the protected live collection.

## Apply the fixed envelope and install the root tools

First deploy the reviewed exact release to staging with every local selector
set to the retained tag, fast chat off, Gemini primary, and the approved cloud
fail-closed policy. Remove persisted model overrides. Then run the installer
from the exact owner-verified, root-owned bootstrap source during the approved
maintenance window. Never run it from `/home/dominguez` or another
application-writable checkout:

```sh
sudo bash \
  /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source/scripts/install-ollama.sh \
  /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source \
  REPLACE_WITH_40_HEX_SHA \
  /var/lib/nexus-release-bootstrap/REPLACE_WITH_40_HEX_SHA/source.tar.gz \
  REPLACE_WITH_OWNER_VERIFIED_64_HEX_ARCHIVE_SHA256
sudo /usr/local/sbin/nexus-ollama-service-envelope-check.mjs \
  --expected-swap-bytes 536870912
```

This applies the fixed 4 GiB/6 GiB/512 MiB, 200%, context-4096, queue-four,
single-parallel, single-loaded-model service envelope before any observation.
It refuses to install or update the Ollama binary, recursively change model
ownership, or pull a mutable model tag. The preinstalled
`/usr/local/bin/ollama` must remain root-owned mode 0755 at version `0.24.0`
and SHA-256
`b2e45ade9cb754a079f74645e1183d613f582d98f7354b05f4f9a5bd81f8e0c9`.
The root-owned mode-0644 `/etc/systemd/system/ollama.service` fragment must
remain at SHA-256
`72b23db27bcd69aa9c05226285a928ae8520dac108736072a33cea35bbcccdda`.
The retained tag must already resolve to digest
`357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b`;
the binary, fragment, and tag identities are verified before and after the
smoke. Commit then independently queries the bounded loopback `/api/tags`
endpoint with Node built-ins, requires exactly one matching retained tag, and
binds the observed response SHA-256 and model digest into the receipt.

The installer accepts only the exact SHA-named root bootstrap source/archive,
checks the owner-approved archive SHA-256 and Git PAX commit, and compares
every privileged source member byte-for-byte with that archive.
The drop-in replacement is same-filesystem atomic and protected by a root-only
durable journal. The installer preserves the prior drop-in bytes, mode,
ownership, enablement, active state, and all operational asset predecessors.
The reviewed bootstrap first installs a permanent install-state guard and its
root-only checker; the installer verifies both and reloads systemd before the
first journal write. A reboot in the journal-to-candidate replacement window
therefore sees the journal and refuses startup.
Any later asset replacement, reload, restart, envelope, daemon, loopback, or
smoke failure restores and verifies that exact predecessor. An ambiguous power
loss retains the journal so a later service start fails closed until the exact
reviewed installer recovers it. A mode-0600 success receipt binds source SHA,
archive SHA-256, runtime/model identity, asset digests, and service state and
is written only after every check passes.
Commit and rollback first seal a durable terminal journal that names and
hashes the exact receipt or rollback result, then garbage-collect predecessor
backups. A crash at backup unlink/fsync therefore leaves either no journal or
a validated terminal journal, never a rollback-required journal whose backup
was already removed. Restoring an active/enabled predecessor with no prior
`override.conf` uses a one-use guard authorization bound to the transaction,
original candidate SHA-256, current boot, and live recovery-helper PID. The
guard consumes it atomically; replay or reboot cannot start Ollama.

The bootstrap and installer also install the collector, durable observation
control/unit, evidence validator, cleanup gate, envelope checker, transaction
helper, and zero-swap transition as root-owned reviewed assets. Never run a
privileged collector, cleanup, transition, or install helper from the
user-writable checkout.

From the exact staging release directory, run its authenticated smoke in the
explicit pre-cleanup phase before starting the first 24-hour window:

```sh
OLLAMA_INVENTORY_PHASE=pre_cleanup \
NEXUS_HUB_BASE_URL=http://127.0.0.1:8201 \
PM2_APP_NAME=nexus-hub-staging \
PM2_BIN=/home/dominguez/.npm-global/bin/pm2 \
bash scripts/staging-smoke-ollama.sh
```

Never grant the application account write access to the observation/control
directories or installed tools. Do not launch the collector directly. A
release that starts during a window, a reboot or pending reboot, a release-SHA
change, a restart, unsafe capacity, pressure, or failed health check
invalidates that window and no successful result is written.

The collector invokes PM2 as `dominguez` through the canonical
`/home/dominguez/.npm-global/bin/pm2` executable. Verify that exact path is
executable before starting either 24-hour window; do not create a second PM2
installation merely to satisfy the collector.

## Collect staging, then production

First confirm staging is explicitly routed to the retained 3B model. Start the
staging observation with its exact deployed SHA:

```sh
sudo /usr/local/sbin/nexus-ollama-observation-control.mjs launch \
  --phase staging \
  --runtime-sha REPLACE_WITH_EXACT_40_HEX_STAGING_SHA
```

The command returns a request ID after systemd accepts the durable one-shot.
The Mac may disconnect. Query only the root journal:

```sh
sudo /usr/local/sbin/nexus-ollama-observation-control.mjs status \
  REPLACE_WITH_REQUEST_UUID
```

Only `status=completed` contains the canonical staging `result.json` path and
digest. Review the protected run without changing any file. Then route and
observe production, supplying both that exact staging path and its
`sha256:...` digest from the completed journal:

```sh
sudo /usr/local/sbin/nexus-ollama-observation-control.mjs launch \
  --phase production \
  --runtime-sha REPLACE_WITH_EXACT_40_HEX_PRODUCTION_SHA \
  --previous-evidence \
  /var/lib/nexus-release/ollama-observations/staging-YYYYMMDDTHHMMSSZ-RANDOM/result.json \
  --previous-evidence-sha256 sha256:REPLACE_WITH_64_HEX_DIGEST
```

The production result recursively revalidates the staging chain and proves
that production started only after staging completed with identical model
identities. Preserve both run directories. Do not move, rename, edit, or
rehash their contents.

## Owner-reviewed large-model cleanup

Use the production collector result directly. Run the read-only plan first:

```sh
sudo /usr/local/sbin/nexus-ollama-large-model-cleanup.mjs \
  --evidence \
  /var/lib/nexus-release/ollama-observations/production-YYYYMMDDTHHMMSSZ-RANDOM/result.json \
  --dry-run
```

Review the exact inventory, full digests, protected evidence digest, and
`ackPlan`. Apply requires explicit owner authorization and a new result path:

```sh
sudo /usr/local/sbin/nexus-ollama-large-model-cleanup.mjs \
  --evidence \
  /var/lib/nexus-release/ollama-observations/production-YYYYMMDDTHHMMSSZ-RANDOM/result.json \
  --apply \
  --owner-authorized \
  --ack-plan 'sha256:REPLACE_WITH_FRESH_DRY_RUN_TOKEN' \
  --result /var/lib/nexus-release/ollama-cleanup-YYYYMMDDTHHMMSSZ.json
```

Immediately before the single three-tag removal, the gate reopens every raw
sample and request record, verifies collector executable provenance, and
rereads `/api/tags` and `/api/ps`. Any state drift invalidates the plan token.
Success requires the retained tag to be the sole inventory item at the same
full digest. The gate never pulls a model, changes routing, or retries a failed
deletion.

## Separate zero-swap transition

Keep the installer-owned `MemorySwapMax=512M` baseline after cleanup. After an
additional healthy 24 hours, use the same collector schema with the cleanup
result as its exact subject. Supply the cleanup file's SHA-256 and the current
production runtime SHA:

```sh
sudo /usr/local/sbin/nexus-ollama-observation-control.mjs launch \
  --phase zero_swap \
  --runtime-sha REPLACE_WITH_EXACT_40_HEX_PRODUCTION_SHA \
  --previous-evidence \
  /var/lib/nexus-release/ollama-cleanup-YYYYMMDDTHHMMSSZ.json \
  --previous-evidence-sha256 sha256:REPLACE_WITH_64_HEX_DIGEST
```

Pass that canonical `zero_swap` result directly to the transition dry-run:

```sh
sudo /usr/local/sbin/nexus-ollama-zero-swap-transition.mjs \
  --cleanup-result \
  /var/lib/nexus-release/ollama-cleanup-YYYYMMDDTHHMMSSZ.json \
  --evidence \
  /var/lib/nexus-release/ollama-observations/zero_swap-YYYYMMDDTHHMMSSZ-RANDOM/result.json \
  --dry-run
```

After owner review, apply with the fresh `ackPlan`, `--owner-authorized`, and a
new mode-0600 result path. Apply creates only
`/etc/systemd/system/ollama.service.d/zz-nexus-zero-swap.conf`, restarts
Ollama, and verifies the full envelope with swap exactly zero. Failure removes
only that drop-in and verifies restoration of the 512 MiB baseline.

## Failure handling

A failed collector run retains its protected raw samples and writes only
`failure.json`; it never writes a successful `result.json`. The systemd
journal also becomes `failed`; the service has `Restart=no`, so it never
silently starts a shorter replacement window. Diagnose the recorded failure
and explicitly launch a new full window. Never edit, truncate, copy into a new
aggregate, or relabel a failed window. No live 24-hour observation or
production mutation is performed by repository tests.
