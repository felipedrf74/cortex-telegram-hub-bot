# ServerDominguez Ollama Observation, Cleanup, and Zero-Swap Runbook

These operations are manual, owner-reviewed, and separate from the release
path. They do not run during release, startup, installation, or SonarQube
setup. The observation command is a foreground, root-owned one-shot process;
it is not a daemon, scheduler, or background release worker.

## Evidence authority

Do not copy or hand-author an aggregate evidence JSON file. Cleanup, SonarQube
enablement, and the later zero-swap transition accept only a canonical
`result.json` produced by the installed repository collector:

`/usr/local/sbin/nexus-ollama-observation-collector.mjs`

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
fail-closed policy. Remove persisted model overrides. Then, from that reviewed
repository revision on ServerDominguez, run the installer during the approved
maintenance window:

```sh
sudo bash scripts/install-ollama.sh
sudo /usr/local/sbin/nexus-ollama-service-envelope-check.mjs \
  --expected-swap-bytes 536870912
```

This applies the fixed 4 GiB/6 GiB/512 MiB, 200%, context-4096, queue-four,
single-parallel, single-loaded-model service envelope before any observation.
It also installs the collector, evidence validator, cleanup gate, envelope
checker, and zero-swap transition as root-owned mode-0700 tools below
`/usr/local/sbin`. Never run a privileged cleanup or transition module from
the user-writable checkout.

From the exact staging release directory, run its authenticated smoke in the
explicit pre-cleanup phase before starting the first 24-hour window:

```sh
OLLAMA_INVENTORY_PHASE=pre_cleanup \
NEXUS_HUB_BASE_URL=http://127.0.0.1:8201 \
PM2_APP_NAME=nexus-hub-staging \
PM2_BIN=/home/dominguez/.npm-global/bin/pm2 \
bash scripts/staging-smoke-ollama.sh
```

Never grant the application account write access to the observation directory
or installed tools. Do not run the collector while a staging or production
release lock is active. A release that starts during a window, a reboot, a
release-SHA change, a restart, unsafe capacity, pressure, or failed health
check invalidates that window and no successful result is written.

The collector invokes PM2 as `dominguez` through the canonical
`/home/dominguez/.npm-global/bin/pm2` executable. Verify that exact path is
executable before starting either 24-hour window; do not create a second PM2
installation merely to satisfy the collector.

## Collect staging, then production

First confirm staging is explicitly routed to the retained 3B model. Start the
staging observation in a durable root shell (for example a supervised SSH
session whose disconnect policy is understood):

```sh
sudo /usr/local/sbin/nexus-ollama-observation-collector.mjs \
  --phase staging \
  --output-directory /var/lib/nexus-release/ollama-observations
```

The command prints the canonical staging `result.json` path and digest only on
success. Review the protected run without changing any file. Then route and
observe production, supplying that exact staging result:

```sh
sudo /usr/local/sbin/nexus-ollama-observation-collector.mjs \
  --phase production \
  --output-directory /var/lib/nexus-release/ollama-observations \
  --previous-observation \
  /var/lib/nexus-release/ollama-observations/staging-YYYYMMDDTHHMMSSZ-RANDOM/result.json
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
result as its exact subject:

```sh
sudo /usr/local/sbin/nexus-ollama-observation-collector.mjs \
  --phase zero_swap \
  --output-directory /var/lib/nexus-release/ollama-observations \
  --cleanup-result \
  /var/lib/nexus-release/ollama-cleanup-YYYYMMDDTHHMMSSZ.json
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
`failure.json`; it never writes a successful `result.json`. Diagnose the
recorded failure and start a new full window. Never edit, truncate, copy into a
new aggregate, or relabel a failed window. No live 24-hour observation or
production mutation is performed by repository tests.
