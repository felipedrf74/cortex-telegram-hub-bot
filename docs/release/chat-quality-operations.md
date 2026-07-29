# Chat Quality Operations

Status: current
Owner: Felipe
Last verified: 2026-07-29

One page for operating the production chat-quality loop (M22).

## Supported response locales

- Nexus chat supports English (`en-US`) and Portuguese (`pt-BR`, `pt-PT`).
  Spanish is retired as a product response locale. Legacy `es-*` request
  headers, Telegram locale values, and persisted `users.language='es-ES'`
  preferences resolve to English without rewriting the stored row.
- Spanish-authored user content and historical telemetry/evidence remain
  readable and byte-preserved. Input-side Spanish safety recognizers remain
  defense in depth; they do not make Spanish a selectable response locale.
- Input-side routing aliases may continue recognizing Spanish-authored text
  so legacy clients degrade safely to an English response. Registry examples,
  release gates, and newly built golden corpus rows cover only supported
  English and Portuguese output locales. Frozen historical release/eval
  evidence is never rewritten. ChatV2 readiness reports expose historical
  Spanish rows in a separate audit section; those rows never count toward
  current English or Portuguese gates.

## Surfaces

- Dashboard page: `http://127.0.0.1:8200/chat-quality` (portal admin token;
  JSON at `GET /api/portal/chat-quality`). Aggregate-only payload: eval score
  trend + monthly estimated-actual spend and separately labeled budget
  ceilings, immutable first-live-baseline identity and compatible future
  deltas, day-to-day failure-type breakdown, locale leakage rate, finalizer
  quality-gate outcome counters (process-local since boot),
  durable aggregate routing-clarify budget counters (30-day window, approved
  ceiling 10%, with no-evidence distinct from PASS),
  per-domain routing accuracy from the latest ACCEPTED snapshot, corpus
  labeling progress, ChatV2 readiness rows, the per-route retirement campaign
  (signed paired-behavior parity, exact disable-stage mapping, and trailing
  24h fallback attribution), and online-eval sampler capture counts by
  status/reason (never raw text).
- Weekly digest: scheduler job `chat_quality_weekly_digest` (Mon 07:30 UTC)
  records ONE info-severity operator alert per week
  (`chat-quality-digest:<date>`) delivered through the existing
  `operator_alert_delivery` webhook path. Kill switch:
  `CHAT_QUALITY_WEEKLY_DIGEST_DISABLED=1`.
- Near-real-time quality regressions: the independent scheduler job
  `chat_quality_regression_monitor` runs every five minutes even when ChatV2
  is OFF, auto-revert evaluation is disabled, or there are no active ChatV2
  tenants. It records deduped warning/critical alerts for current readiness
  parity failures, signed paired-behavior regressions, and attributable route
  fallback above 2%. Missing, invalid, future-dated, or older-than-eight-day
  readiness evidence records one distinct deduped WARNING health alert and
  suppresses stale readiness claims while behavior/fallback checks continue.
  Emergency kill: `CHAT_QUALITY_REGRESSION_MONITOR_DISABLED=1`; this disables
  only the five-minute monitor and changes no rollout/capability flag.
- Readiness input: the dashboard, digest, and five-minute monitor read the artifact at
  `CHAT_V2_READINESS_REPORT_PATH` (default
  `reports/chatv2-readiness/latest.json`); missing/invalid files degrade to
  "readiness unavailable" on the read surfaces and fire the monitor-health
  warning above rather than silently disabling regression coverage.

## Evaluation evidence

- Local release evidence must run from a clean, committed checkout of the
  exact SHA being promoted when the checkpoint manifest's cumulative
  `releaseImpact.groups` includes `chat-secretary`. Run `./scripts/local-up.sh`,
  followed by `./scripts/chat-eval-local.sh`. The eval overlay enforces
  Ollama-only routing, blanks cloud credentials, and records a `local_engine`
  run for that exact-SHA promotion gate. Non-chat releases skip this gate
  automatically; there is no operator bypass. If Ollama is not on the default host endpoint, set
  `NEXUS_CHAT_EVAL_OLLAMA_BASE_URL`; this does not permit a cloud provider.
- The first live baseline runs only on staging against a dedicated synthetic
  user/tenant. Set the staging server's `CHAT_EVAL_DEDICATED_TENANT_ID` to that
  account's shared user/tenant id; its principal email must end in `.invalid`.
  Put its bearer token in the operator shell as `CHAT_EVAL_AUTH_TOKEN`, never
  in argv or evidence. Run from a clean checkout with exactly
  `--mode real_provider --base-url <staging-url> --budget-usd 0.50`. The hard
  split is $0.45 for target-provider attempts and $0.05 for flash-lite judging.
  Set `CHAT_EVAL_PORTAL_URL` and `CHAT_EVAL_PORTAL_TOKEN` to post through the
  admin-authenticated staging portal; never put either token in evidence.
  Confirm the run appears on `/chat-quality`. Copy its redacted JSON and
  Markdown reports to the exact pair
  `docs/release/eval-evidence/<run-id>.{json,md}`.
- Felipe then explicitly freezes that first baseline by sending the portal
  admin-authenticated request below to the staging portal. Acceptance is
  staging-only, requires the exact synthetic/preflight/cost/SHA/scenario
  attestations, and accepts only those exact canonical archive paths. The
  first accepted identity, its run, and its scenario evidence are immutable;
  an exact retry is idempotent and every different replacement is refused.

  ```text
  POST /api/portal/eval-history/frozen-baseline
  Authorization: Bearer <CHAT_EVAL_PORTAL_TOKEN>
  Content-Type: application/json

  {
    "runId": "<run-id>",
    "evidenceJsonPath": "docs/release/eval-evidence/<run-id>.json",
    "evidenceMarkdownPath": "docs/release/eval-evidence/<run-id>.md"
  }
  ```

  Until acceptance, dashboard/digest state is `not_recorded` and quality
  deltas are unavailable. Later real-provider runs get numeric deltas only
  when live-eval contract version, seed-profile version, and scenario-set
  hash match the frozen identity; incompatible evidence is labeled and emits
  no delta. Never use production or Felipe's real account.
- Each live scenario is reset and seeded server-side before its turns. The
  `single_tenant_day_to_day_v3` profile runs 7 scenarios/18 turns, including
  one server-seeded local-only task deletion that requires exact-target
  confirmation and passes only after token-zero `/tasks/snapshot` read-back;
  reset removes only the eval-owned task id and dependent rows within the
  dedicated scope. A run is invalid if the authenticated preflight, preparation
  evidence, exact provider budget, zero-production-data assertion, or final
  clean-SHA attestation fails.

## Weekly ritual

1. Read the digest alert (or open `/chat-quality`).
2. Label pending sampler captures at `/routing-corpus` (owner-gated; raw
   utterances are visible only behind the portal admin token).
3. Triage any new day-to-day failure types and sampler reason spikes; file
   fixes against the owning milestone/service.
4. Check the routing-clarify rate; stop the clarify rollout if it exceeds 10%
   or if durable evidence is absent.
5. Review every retirement row. Routing agreement and online-eval health are
   diagnostic only; a candidate must show PASS from signed paired behavior
   evidence (at least 50 samples, at least 0.95 parity, independent signoff,
   zero safety/quality/degraded regressions), an explicit retirable stage,
   and a trailing-24h fallback rate at or below 2%. Qualifying retirement
   observations use only the immutable English/Portuguese projection of the
   pre-implementation `chat_v2_legacy_parity_route_prompts@1.4.0` corpus.
   Spanish, mixed, and pt-AO rows are excluded from that projection. The active
   `1.5.0` supported-locale corpus is diagnostic/coverage-only because it was
   authored during this implementation; it cannot qualify retirement evidence.
6. If readiness, signed-behavior, or route-fallback regressions fired, stop the affected soak
   and follow the alert runbook link before any further ChatV2 promotion.

## Owner-gated steps (never automated)

- Corpus labeling passes (`/routing-corpus`).
- The one-time production removal of the eight exact retired Spanish
  synthetic corpus fixtures. First deploy
  `routing-corpus-builder@1.1.0`. Using the exact runtime SHA and artifact
  digest attested by the passing production transaction and production health,
  inspect the read-only plan:

  ```text
  npx tsx scripts/prune-spanish-routing-corpus.ts \
    --inspect \
    --db=<production-db-path> \
    --runtime-sha=<deployed-full-sha> \
    --artifact-digest=<deployed-artifact-sha256>
  ```

  Review the exact eight HMAC/text-digest row identities, cache identities,
  accepted-snapshot count, canonical database path, release identity, and
  `planDigest` in that output. Obtain Felipe's explicit approval for that exact
  plan digest. Only then apply it:

  ```text
  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npx tsx scripts/prune-spanish-routing-corpus.ts \
    --apply \
    --db=<production-db-path> \
    --backup-dir=<protected-backup-directory> \
    --runtime-sha=<deployed-full-sha> \
    --artifact-digest=<deployed-artifact-sha256> \
    --ack-plan=<sha256:plan-digest>
  ```

  Both modes require `CLASSIFY_SHADOW_HASH_SECRET`. Apply refuses before
  creating the backup directory unless the owner authorization and exact plan
  acknowledgement are both present. It re-inspects after backup and refuses
  mutation if the state or release binding changed. The operation accepts only
  all eight exact pending synthetic rows or zero, refuses
  partial/labeled/snapshot-bound state, deletes matching cache hashes only, and
  runs `PRAGMA integrity_check`. Its backup directory must be owned by the
  operator with mode `0700`; the command creates and verifies the SQLite backup
  with mode `0600` and checks that backup's integrity before opening the prune
  transaction.
  Re-run `npx tsx scripts/build-routing-corpus.ts` afterward. The supported
  fixture queue is 224 unique items (109 English, 115 Portuguese).
- `npx tsx scripts/run-routing-accuracy.ts --refresh-llm` (the only networked
  routing-accuracy path).
- `npx tsx scripts/run-routing-accuracy.ts --gate --accept-snapshot`
  (ratchet acceptance).
- Staging/real-provider eval runs (budgeted; persisted via
  `POST /api/portal/eval-history`) and the one-time immutable baseline
  acceptance (`POST /api/portal/eval-history/frozen-baseline`).
- Per-route retirement sync and every `CHAT_PIPELINE_DISABLED_STAGES` change.
  Run `npx tsx scripts/chatv2-retirement-campaign.ts --sync`, then authorize
  only a row whose verdict is PASS. `blocked`, `insufficient_evidence`, and
  `fail` are never candidates; guard-listed and shared stages intentionally
  have no disable value.
- Refreshing the readiness artifact:
  `npx tsx scripts/chatv2-completion-readiness.ts > reports/chatv2-readiness/latest.json`
  — this is the ONLY producer of the `chat_v2_completion_readiness_report.v1`
  schema the dashboard/digest loader accepts. Do NOT redirect
  `scripts/chatv2-readiness-alerts.ts --json` into the artifact path: its
  output is an alerts report (`chat_v2_readiness_alerts_report.v1`) and the
  loader rejects it, which silently dead-wires the regression alerts.
- Recording the full readiness alert set immediately (separate from the
  artifact refresh): `npx tsx scripts/chatv2-readiness-alerts.ts --write-alerts`.
