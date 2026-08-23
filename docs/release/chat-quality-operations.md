# Chat Quality Operations

Status: current
Owner: Felipe
Last verified: 2026-08-09

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

- Local chat evaluation is a deliberate diagnostic, not a checkpoint manifest
  or production-promotion gate. Run it from a clean, committed checkout of the
  exact SHA being evaluated with `./scripts/local-up.sh`, followed by
  `./scripts/chat-eval-local.sh`. The eval overlay enforces Ollama-only routing,
  blanks cloud credentials, and records a `local_engine` run for that exact SHA.
  Protected-main selected CI and the signed container evidence contract remain
  the production publication gate. If Ollama is not on the default host endpoint, set
  `NEXUS_CHAT_EVAL_OLLAMA_BASE_URL`; this does not permit a cloud provider.
  If the exact-checkout Docker build fails, evaluation startup fails closed and
  records no run; it never falls back to last-known local images.
  During local evidence seeding the script pauses only `nexus-hub`, writes the
  bind-mounted SQLite database offline, restarts the service, and re-attests
  health plus the zero-cloud profile. It then prewarms the configured Ollama
  model with one synthetic output token at the compact 1024-token context used
  by the first measured provider turn before minting the synthetic session, so
  runner/model loading is explicit setup time rather than a measured-turn
  latency failure. The warmup contains no user data, makes no cloud call, and
  does not count as evaluation usage.
  Routine Ollama-backed Content answers use a one-property JSON object with
  locale-bound key `answer_en_us`, `answer_pt_br`, or `answer_pt_pt`. The
  model authors the complete visible value; the server does not prepend,
  select, or rewrite semantic answer text. Ordinary Content keeps the
  90-word prompt target, 192-token cap, 4096-token context, and 24–480
  character answer range. Authorized history and scoped state remain
  available. An explicit long-form caller can override the routine cap.

  The first narrower mode applies only when the turn contract has already accepted
  a low-risk saved-data opt-out and the current message is a positively parsed
  short comparison: each side has at most eight words and the request has no
  long-form marker. That mode sends only the current turn, uses a 1024-token
  context and 24-token output cap, prompts for a complete answer within 64
  characters, and requires a one-property `a` object containing a 24–66
  character model-authored answer. The parser verifies
  exact schema shape, completeness,
  meaningful overlap with both comparison sides, shared subject coverage when
  present, and language that does not contradict the requested primary
  language. It also requires separate comparison clauses with distinct,
  non-generic conditions for both approaches; either an explicit contrast
  conjunction or semicolon may separate the clauses, but repeating that each
  is merely "better" is not evidence. A saved or authorized-context comparison
  never enters this mode, and normal Content requests retain the ordinary
  capacity above.

  A second narrow mode applies to a short Content-ideas request only when it
  explicitly asks to use authorized context, the retained history/state has at
  least one salient grounding term, and the estimated source input is at most
  560 tokens. The parser derives salient normalized terms from the authorized
  history/state, excludes numeric, hash-like, and over-20-character
  identifiers, selects the lexically first remaining 5–20-character
  alphabetic term, embeds it in a locale-specific output prefix, and places
  that validated prefix in the higher-priority system instruction instead of
  copying raw saved messages into the narrow generation prompt. The user
  message is exactly the current request so its constraints are not discarded
  and an untrusted fake prefix cannot replace the trusted anchor. The redundant
  standalone grounding-term label is omitted. The
  canonical release-eval compact message envelope is regression-tested at no
  more than 340 characters. The mode uses a
  1024-token context, 32-token output cap, and a one-property `a` object
  containing a 24–64 character answer, with a 62-character answer target. The
  prompt instructs the model to begin the answer with the prefix, including the
  request terms and selected authorized term, verbatim, and then author exactly
  two distinct one-to-three-word media-format names joined by comma-space with
  nothing else. The
  locale-aware verifier
  requires the exact localized heading, connector, recognized idea/content
  request stems, and selected term in the complete grounding prefix. It then
  requires exactly two non-empty alphabetic format phrases of one to three
  words. Each phrase must contain a spoken head exhaustively mapped from the
  canonical Content format ontology or its bounded English/Portuguese media
  aliases (for example, video, carousel, post, podcast, article, text, or
  audio). Every other word must be a bounded format modifier or an internal
  connector; a phrase cannot begin or end with a stop word. Each phrase must
  resolve to exactly one canonical format family. The two phrases must have
  distinct non-generic stems in both directions after local singular/plural,
  English/Portuguese alias, and modifier normalization. The canonical
  representation uses one comma;
  the prior slash
  representation remains accepted for backward compatibility under the same
  checks. Extra grounding words, a selected term appearing only as a format, a
  translated substitute, a third item, a newline or other line/control
  separator, mixed separators, prose-only items, or extra prose are rejected. The
  server returns the model's answer value unchanged. A JSON-complete,
  provider-complete response in either certified two-format representation is
  accepted as a complete compact list even when the model omits only terminal
  punctuation; hanging conjunctions, missing formats, repeated formats, and
  semantic fragments remain rejected. Larger contexts and requests without
  independently checkable grounding stay on the ordinary 4096/192 path; they
  are never silently truncated into the narrow window.

  Structured JSON never reaches the user. A provider cap, malformed JSON,
  schema mismatch, confidently contradictory primary language, empty answer,
  incomplete answer, ungrounded authorized-context answer, or comparison
  without distinct conditions for both sides stays under the truncation refusal and emits the normal
  retryable degraded response. Region-specific Portuguese is prompted but the
  deterministic verifier claims only primary-language contradiction checks;
  it does not claim full dialect or arbitrary code-switch classification.
  A direct English/Portuguese “today’s workout” read uses the legacy
  `training-today-read-shortcut` before quota or provider acquisition. It
  accepts only a single-domain, read-only Training question, reads the
  authenticated tenant’s active plan in the user timezone, and returns only
  today’s allowlisted session summary. Writes, health advice, external
  research, multi-domain requests, stale plans, and cross-tenant session rows
  do not enter this shortcut. Chat Core V2 and manifest rollout flags remain
  unchanged and OFF.
  Local release evidence additionally requires a post-validation Ollama usage
  row for `chat_content_model_authored_short` in the target scenario; rejected
  output is recorded under a distinct rejected category and cannot attest the
  run. The live c1 scorer also requires at least one independently seeded
  authorized-context term, while c2 requires `narrative`, `broad`, and
  `tailored` plus distinct conditions for both approaches. This prevents
  server-authored text, a rejected provider call, or an incidental scenario
  call from satisfying the provider-semantic gate.
- The first live baseline runs only on staging against a dedicated synthetic
  user/tenant. Set the staging server's `CHAT_EVAL_DEDICATED_TENANT_ID` to that
  account's shared user/tenant id; its principal email must end in `.invalid`.
  Keep this account exclusive to governed chat evaluation. `users.tier` is not
  an entitlement, and `staging_fixture`, `beta`, `manual`, or `beta_sandbox`
  subscriptions do not qualify for paid evaluation. Use the existing
  admin-authenticated `POST /api/founders` grant with `plan=max` for this
  synthetic staging principal; never invent Apple/Stripe billing data. The
  authenticated preflight and every reset/turn/evidence request fail closed
  unless the canonical entitlement still allows paid AI plus every scenario
  capability and action surface. Generic fixture reseeding can replace that
  subscription, so re-check the grant after any reseed and before spend.
  Put its bearer token in the operator shell as `CHAT_EVAL_AUTH_TOKEN`, never
  in argv or evidence. Run from a clean checkout with exactly:

  ```text
  npm run chat:eval-live -- \
    --mode real_provider \
    --base-url <staging-url> \
    --budget-usd 0.50 \
    --out-dir docs/release/eval-evidence
  ```

  The hard split is $0.45 for target-provider attempts and $0.05 for
  flash-lite judging.
  The CLI creates one private ignored judge ledger at
  `.local/chat-eval/<run-id>/judge-usage.sqlite` (directory mode `0700`, file
  mode `0600`). Its import-free entry bootstrap disables dotenv before any
  project/config module loads. Supply the approved Gemini credential through
  the operator's secret-injection wrapper; never place it in argv, evidence,
  or the ledger. A valid run requires exactly seven total, matched,
  resolved-price Gemini `gemini-2.5-flash-lite` usage rows and exactly seven
  total durable pre-network attempt reservations in that fresh ledger. Rows
  missing the run attribution or attributed to another run invalidate the
  evidence. Its cost attestation records actual judge spend separately from
  the retained attempt ceilings and refuses either the judge split or total
  budget if the conservative commitment would exceed it. Keep the private
  ledger until the archived pair is committed and the staging baseline is
  frozen; retain it only in an access-controlled release artifact if longer
  audit retention is required.
  Set `CHAT_EVAL_PORTAL_URL` and `CHAT_EVAL_PORTAL_TOKEN` to post through the
  admin-authenticated staging portal; the portal token has no argv flag and
  must never enter evidence.
  Confirm the run appears on `/chat-quality`. The redacted JSON and Markdown
  reports must be the exact pair
  `docs/release/eval-evidence/<run-id>.{json,md}`. Never blindly rerun paid
  work. Before its first portal POST, the CLI atomically saves the exact
  request body as the private `0600` file
  `.local/chat-eval/<run-id>/portal-retry-payload.json`. If the provider run
  completed but the portal POST failed, leave `CHAT_EVAL_PORTAL_TOKEN` in the
  approved secret-injected environment and retry only that exact POST:

  ```text
  npx tsx scripts/replay-chat-eval-portal.ts \
    --payload .local/chat-eval/<run-id>/portal-retry-payload.json \
    --portal-url <staging-url>
  ```

  The replay command performs no evaluator or provider work, verifies the
  payload is a private regular file, and reports its SHA-256 identity.
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
    "evidenceMarkdownPath": "docs/release/eval-evidence/<run-id>.md",
    "evidenceJsonSha256": "<sha256 of that json file>",
    "evidenceMarkdownSha256": "<sha256 of that md file>"
  }
  ```

  The two digests are mandatory and recorded immutably, so the baseline is
  pinned to exact bytes any reviewer can re-verify from Git. `docs/` is not part
  of the release artifact, so the server cannot read the files itself; what it
  does verify on its own is stronger than a path string. It recomputes
  `scenario_count`, `pass_count`, `partial_count`, `fail_count`,
  `blocked_count`, and `average_score` from the persisted per-scenario rows and
  refuses any run whose declared aggregates disagree with the evidence they
  summarise, and it refuses archive paths that differ from the report paths the
  run itself recorded when it posted. Produce the digests with
  `shasum -a 256 docs/release/eval-evidence/<run-id>.{json,md}`.

  Acceptance also records a `provenanceClass`. A run whose authenticated
  preflight carried a verified deployed staging identity freezes as
  `deployed_artifact_attested`. A run without one — only the pre-binding first
  baseline can be in that state, since paid evaluation now fails closed without
  a server-attested identity — is refused unless the request explicitly adds
  `"acknowledgeOperatorCheckoutProvenance": true`. That acknowledgement is
  stored immutably and surfaced on `/chat-quality`, so a reduced-provenance
  baseline can never later be cited as artifact-bound evidence.

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
  dedicated scope. Seed profile `single-tenant-live-v3` also materializes one
  canonical, current-day Training plan/week/session for
  `training_adjustment`. Its plan identity is held in
  `chat_live_eval_training_artifacts`; reset verifies the exact server-owned
  marker and authenticated user/tenant before deleting it, reseeds it for
  Training turns, and removes it on every later scenario. The reset refuses
  any unrelated active Training plan in the supposedly dedicated scope rather
  than selecting, deleting, or mixing private state. Cleanup also fails closed
  before deletion when an owned fixture has a foreign-tenant or cross-plan
  session/completion edge, direct or denormalized calendar linkage, revision
  projection, operation lock, adaptation, or legacy/active-plan reference. The
  preparation transaction rolls the fixture back intact if any later evidence
  write fails. The preparation hash binds the dated fixture manifest as well
  as the prompt facts. A run is invalid if the authenticated preflight,
  preparation evidence, exact provider budget, zero-production-data
  assertion, or final clean-SHA attestation fails.

## Weekly ritual

1. Read the digest alert (or open `/chat-quality`).
2. Label pending sampler captures at `/routing-corpus` (owner-gated). The page
   defaults to the exact tenant-0 checked-in synthetic identities. Raw private
   utterances require `/routing-corpus?tenantId=<owner-tenant>`, a signed portal
   session or verified actor signature, and matching operator scope; every
   page/API response is `no-store`.
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

## PM2 first-cutover fallback: Phase 7 capability-flag rollout checklist

This operator and every installed-release, `.env`, PM2 restart, or flag
mutation procedure in this section are retained only for the owner-authorized
first-cutover fallback during the initial 14 stable days. The default container
control plane has no supported post-bootstrap capability-flag transaction.
That path remains blocked until the owner approves an executor that binds exact
authorization, the shared maintenance mutex, writer drain, database and runtime
identity, and recovery evidence. Do not run these helpers against a container,
edit a mounted production `.env`, or restart a container to bypass the block.

Run this checklist in order through the governed operator. After the operator
is merged, built into the exact artifact, and deployed, its only supported
entry point is:

```text
npm run release:chat-flags -- \
  <inspect|apply|inspect-secrets|apply-secrets|inspect-shadow-hook|
   apply-shadow-hook|inspect-observation|apply-observation> ...
```

The command targets `"$DEPLOY_SERVER"` (required env, no default host) and
must never be pointed at AWS or another host. Run it from a clean checkout of
the exact deployed runtime SHA. It executes the remote helper from the exact
installed release directory, verifies the completion marker and artifact
manifest, and holds the same user-release and shared root maintenance locks
as release (the lock path retains a historical `-sonar` filename; SonarQube
itself was decommissioned on 2026-08-07)
operations. Local plans and receipts remain under ignored
`.local/release/chat-capability-flags/`; private durable state remains under
`~/.local/state/nexus-release/chat-capability-flags/`.

`inspect` collects its evidence natively on the release host from the exact
staging release and database. It accepts no operator-supplied evidence JSON
and performs no provider calls. `apply` accepts only the exact redacted
`sha256:<plan-digest>` produced by that inspect, requires
`NEXUS_RELEASE_OWNER_AUTHORIZED=1`, consumes the plan once, and runs as a
detached user systemd transaction. A partial or failed attempt never licenses
a digest replay; inspect again and review the next sequence.

Roll out exactly one flag at a time. A passing gate authorizes only its named
flag, role, configured-prefix state, and exact runtime/artifact candidate; it
is not evidence for a later candidate or another surface. Begin every
candidate with all seven capability flags OFF:

```text
AI_ROUTING_MANIFEST_CLASSIFIER=false
AI_ROUTING_MANIFEST_ORCHESTRATOR=false
AI_ROUTING_MANIFEST_SHADOW=false
AI_ROUTING_MANIFEST_REGISTRY=false
AI_ROUTING_CLARIFY=false
AI_CLASSIFY_MANIFEST_PROMPT=false
AI_CROSS_SKILL_EXECUTION=false
```

After a flag completes its authorized rollout it may remain ON for the next
step. Only one new flag may change at a time, and every not-yet-authorized flag
stays OFF. Record the complete effective flag set with each gate and smoke so
the cumulative configuration is reproducible. Every staging and production
release transaction refuses to begin unless all seven governed capability
flags are omitted (runtime-default OFF) or appear once in canonical
`FLAG=false` form. It also rejects any enabled, malformed, or duplicate
global, USER, or TENANT `CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED` or
`CHAT_CORE_V2_SHADOW_PLANNER_ENABLED` assignment. Before staging or promoting
a later runtime/artifact candidate, return all seven flags and the dedicated
recorder to OFF through owner-authorized rollback transactions. Evidence and
ON receipts do not transfer across release identities.

`AI_ROUTING_MANIFEST_KILL` defaults OFF but must remain available as the master
rollback. Setting it to `true` force-disables all seven capabilities even if a
per-capability flag remains configured ON. Never use the kill switch as a way
to manufacture flag-off gate evidence.

For each candidate, create an ignored operator directory such as
`.local/release/chat-quality/phase7/<runtime-sha>-<artifact-prefix>/<NN>-<flag>/`
and retain the completed staging transaction, exact 40-hex runtime SHA, exact
64-hex artifact digest, gate JSON, flag-state receipt, smoke result, and
before/after monitoring snapshots there. Do not commit raw staging databases,
tokens, HMAC secrets, prompts containing user data, or provider responses.
Before collecting shadow evidence, verify through the deployment secret
boundary that `CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET` is present for replay
bundle identities and `CLASSIFY_SHADOW_HASH_SECRET` is present for classifier
shadow/corpus identities. Record presence only, never either value. Missing
HMAC configuration means no eligible evidence.

Provision the two evidence HMACs before collecting any Phase 7 evidence. The
plan and receipt expose only each governed name and `preserve`/`generate`
action; they never expose a value, value-derived hash, fingerprint, or length:

```text
npm run release:chat-flags -- inspect-secrets \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256>

NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
npm run release:chat-flags -- apply-secrets \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --ack-plan <sha256:exact-secret-plan-digest>
```

Repeat for production before its first capability flip. Existing values are
always preserved. Staging may generate either missing HMAC. Production must
already contain `CLASSIFY_SHADOW_HASH_SECRET`, preserving corpus continuity,
but may generate a missing `CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET`. Generation
occurs only inside the server transaction; secret values are never CLI
arguments. A changed `.env`, PM2 identity, release identity, or one-hour plan
window invalidates apply.

During an `.env` mutation the remote transaction writes a short-lived
`nexus.chat-capability-runtime-permit.v1` bound to the exact plan digest,
transaction, release identity, complete configured state, environment bytes,
controller process, phase, and expiry. Runtime flag readers fail closed while
the durable transaction marker exists unless that permit is live and exact.
The permit is removed only after the committed receipt and clear-state health
check. A failed apply atomically restores the private `.env` preimage,
restarts only the backend, verifies restored identity and health, and records
`rolled_back` or `rollback_failed`; unresolved backups or unpublished receipts
block a later release transaction.

### One-time 4.14.232 shadow-hook claim recovery

The staging shadow-hook transaction
`20260802T143331Z-8ce452d0143b` on runtime
`0c4af848349c2cf3c2c89fd4d66f039b481f62ae` and artifact
`f8d20b5f90c1477ff3fe6178490548828e63ecf872e868b8933bcd104e5e4cd7`
predates the explicit effective-state claim field. Its restored `.env`, failed
receipt, expired permit, and exact backup marker form a release deadlock: the
marker correctly blocks a new artifact, while the installed operator cannot
complete rollback health verification without that field. This is the only
supported legacy exception.

From a clean checkout of protected main, inspect the exact repair:

```text
scripts/chat-shadow-hook-legacy-claim-repair-operator.sh inspect \
  --runtime-sha 0c4af848349c2cf3c2c89fd4d66f039b481f62ae \
  --artifact-digest f8d20b5f90c1477ff3fe6178490548828e63ecf872e868b8933bcd104e5e4cd7 \
  --transaction-id 20260802T143331Z-8ce452d0143b
```

After the owner approves the exact `repairPlanDigest`, apply only that plan:

```text
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
scripts/chat-shadow-hook-legacy-claim-repair-operator.sh apply \
  --runtime-sha 0c4af848349c2cf3c2c89fd4d66f039b481f62ae \
  --artifact-digest f8d20b5f90c1477ff3fe6178490548828e63ecf872e868b8933bcd104e5e4cd7 \
  --transaction-id 20260802T143331Z-8ce452d0143b \
  --ack-plan sha256:<exact-repair-plan-digest>
```

The hash-bound repair runs under both release locks and adds only the
deterministic `effectiveFlags` master-kill projection to the exact legacy v1
private claim. It does not change `.env`, restart a process, remove a marker,
or publish a replacement capability result. Its receipt status is
`claim_repaired`, deliberately not `passed` or `release_unblocked`.

Next, from a clean detached checkout of the exact installed runtime, run the
exact old operator to trigger its startup recovery:

```text
npm run release:chat-flags -- inspect-shadow-hook \
  --role staging \
  --runtime-sha 0c4af848349c2cf3c2c89fd4d66f039b481f62ae \
  --artifact-digest f8d20b5f90c1477ff3fe6178490548828e63ecf872e868b8933bcd104e5e4cd7 \
  --value false \
  --transition-reason operator_rollback
```

Startup recovery in that installed operator must verify the restored
environment, restart and health-check the backend, publish `rolled_back`, and
remove the exact backup and permit. The command is expected to exit nonzero
after successful startup recovery if the subsequent inspect refuses the
already-OFF requested state; that exit is not the recovery verdict. Verify
instead that
`~/.local/state/nexus-release/chat-capability-flags/staging.json`
is `rolled_back` for the exact transaction and release, that
`~/telegram-hub-bot-staging/.env.before-chat-capability-20260802T143331Z-8ce452d0143b`
and
`~/.local/state/nexus-release/chat-capability-flags/staging.runtime-permit.json`
are absent, and that authenticated `/health/detailed` reports the exact PM2
release identity, a clear runtime guard, and every capability, dedicated
route-hook, and planner assignment OFF. Only then may a new artifact enter
normal staging preparation and smoke. Never delete the marker or permit
manually.

### One-time 4.14.232 failed observation publication recovery

The staging classifier observation `20260805T163302Z-2522779e6416` on runtime
`39965e357d19a1a44ecb167d213c6ffcf361a21b` and artifact
`e368f1e15c3b2a84cfb798ad12621932a61fd766db6161259a7bd364cbac1535`
completed the canonical smoke but failed the then-installed quality monitor
before it could publish an observation receipt. The exact plan and smoke are
durable, the successful observation receipt and sidecar are absent, and the
classifier was subsequently returned to OFF through a passed exact-release
transaction. That incomplete publication correctly blocks another release.

From a clean checkout of protected main, inspect the exact recovery:

```text
scripts/chat-observation-legacy-failure-recovery-operator.sh inspect \
  --runtime-sha 39965e357d19a1a44ecb167d213c6ffcf361a21b \
  --artifact-digest e368f1e15c3b2a84cfb798ad12621932a61fd766db6161259a7bd364cbac1535 \
  --transaction-id 20260805T163302Z-2522779e6416
```

After the owner approves the exact `recoveryPlanDigest`, apply only that plan:

```text
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
scripts/chat-observation-legacy-failure-recovery-operator.sh apply \
  --runtime-sha 39965e357d19a1a44ecb167d213c6ffcf361a21b \
  --artifact-digest e368f1e15c3b2a84cfb798ad12621932a61fd766db6161259a7bd364cbac1535 \
  --transaction-id 20260805T163302Z-2522779e6416 \
  --ack-plan sha256:<exact-recovery-plan-digest>
```

The hash-bound transaction runs under both release locks. It revalidates the
installed source, expired observation plan, sequence, preserved smoke bytes,
later exact classifier-OFF receipt, environment bytes, and every global
capability/route-hook/planner assignment OFF. It publishes an immutable
`failure_acknowledged` recovery receipt and byte-identical smoke sidecar; it
does not create a passing observation, enable a flag, alter `.env`, restart a
process, or delete the failed plan or smoke. Production flag selection never
accepts this receipt as observation evidence. The release guard accepts it
only as terminal publication of the failed attempt. Never synthesize a passed
observation receipt or remove the stranded files manually.

This incident also left the dedicated USER/TENANT route recorder ON after
protected main advanced beyond the installed staging release. After the
failure receipt is published, use the narrow protected-main wrapper around the
exact installed operator to inspect its OFF rollback:

```text
scripts/chat-shadow-hook-installed-predecessor-off-operator.sh inspect
```

After owner review of that exact `planDigest`, apply it once:

```text
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
scripts/chat-shadow-hook-installed-predecessor-off-operator.sh apply \
  --ack-plan sha256:<exact-recorder-OFF-plan-digest>
```

The wrapper is hard-bound to the same `39965e357d19...` staging artifact,
verifies its installed source from the artifact manifest, and permits only
the installed operator's `false` / `operator_rollback` transition. It does not
provide a predecessor ON path or a general protected-main bypass. Confirm the
receipt is `passed`/`disable` and the staging environment has zero enabled
route-hook or planner assignments before retrying release preparation.

Before collecting the first manifest-routing window for an exact candidate,
activate only the staging route recorder for the database-attested dedicated
evaluation identity:

```text
npm run release:chat-flags -- inspect-shadow-hook \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --value true \
  --transition-reason dedicated_eval_evidence_collection

NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
npm run release:chat-flags -- apply-shadow-hook \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --ack-plan <sha256:exact-shadow-hook-plan-digest>
```

The inspect is staging-only and requires both evidence HMACs, all seven
capabilities and the master kill OFF, every global/USER/TENANT shadow-planner
scope OFF, and a dedicated `.invalid` principal in the isolated staging
database. Apply consumes the one-hour plan once, changes only the exact
dedicated USER and TENANT route-hook assignments, restarts only the backend,
and publishes a strict `nexus.chat-shadow-route-hook-transaction.v1` receipt.
The global route hook stays OFF. Authenticated `/health/detailed`
release-attestation v2 reports only presence and effective booleans for this
scope; it never exposes its identity.

Routing-window evidence uses the provider-free synthetic QA contract in
**Phase 7.1** below. Eligible `routing_divergence_shadow@5.0.0` bundles bind
the exact dedicated user and tenant, route hook effective, shadow planner not
effective, target capability OFF, exact release identity, selected surface,
and strict synthetic-QA provenance. The gate also hashes and binds fresh
authenticated health bytes, the exact recorder receipt, the precommitted
manifest, and its zero-provider campaign receipt. Missing or mixed recorder
metadata, a stale or different receipt, any planner-effective bundle, or a
live-scope mismatch fails the entire window instead of merely excluding rows.

After all four manifest-routing collection windows are complete, disable the
recorder with `inspect-shadow-hook --value false --transition-reason
operator_rollback` and owner-authorized `apply-shadow-hook` against its exact
digest. Use `quality_regression` or `health_regression` only when that observed
condition is the reason. A normal release, staging transaction, or production
promotion is blocked until all route-hook and planner scopes are OFF.

After one staging flag is ON, do not ask production inspect to run a smoke.
Wait until its exact successful staging enable receipt is at least five
minutes old, then inspect one staging-only observation plan:

```text
npm run release:chat-flags -- inspect-observation \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --flag <the-one-enabled-flag>
```

The read-only inspect binds the exact runtime/artifact, flag, latest staging ON
receipt and hash, enable and observation sequences, complete contiguous
configured/effective prefix, master kill OFF, expected next production plan
sequence, installed smoke script SHA-256, canonical smoke profile, and a
one-hour apply window. Every global/user/tenant
`CHAT_CORE_V2_SHADOW_PLANNER_ENABLED` scope used by the two smoke fixtures must
be effectively false so an authenticated identity turn cannot launch an
asynchronous planner/provider path.

Review the plan, then authorize the separate one-shot evidence transaction:

```text
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
npm run release:chat-flags -- apply-observation \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --flag <the-one-enabled-flag> \
  --ack-plan <sha256:exact-observation-plan-digest>
```

Apply consumes that exact digest once, holds both release/Sonar mutexes,
revalidates the plan and live flag prefix, and runs the installed canonical
staging smoke exactly once. It publishes the immutable raw smoke and a strict
`nexus.chat-capability-observation-receipt.v1` receipt. The canonical
`nexus.staging-smoke.canonical.token-zero-locale.v2` profile uses the
authenticated-identity fast path for English and Portuguese plus one legacy
`es-*` request that must respond in English without rewriting the persisted
Spanish preference. This is deterministic token-zero identity/locale
evidence. It deliberately no longer claims task-write planner or
model-authored locale coverage; use the governed live-eval evidence for model
behavior claims. Its training and locale fixture users are fixed at `1000014`
and `1000016`. Before any dependent fixture write, each principal must be
absent or match its exact synthetic ID, Telegram ID, email, username, and
auth-provider marker. A mismatch or marker collision fails closed without
changing the unknown row. An absent fixture uses a plain insert; an exact
fixture uses a marker-guarded update inside the immediate seed transaction.
The canonical smoke never uses `INSERT OR REPLACE` for either user principal.

The observation also binds health and `/chat-quality`, one clean scheduled and
one direct quality-monitor result, and zero durable `operator_alerts` activity
since the enable completion time for both `chat_quality_regression_monitor`
and `chat_v2_retirement_monitor`. The alert query includes every status and
qualifies either `created_at` or `last_seen_at`, so resolving or acknowledging
an alert cannot erase a regression from the window. Before and after the whole
smoke it snapshots every staging-database `api_usage` row/cost and
hard-ceiling-reservation row/reserved cost, while also binding the two expected
fixture IDs; all global deltas must be zero. The hard-ceiling reservation table
is a governed pre-network budget ledger, not a universal ledger for every
possible provider-attempt mechanism. Never broaden the receipt into a claim it
does not prove.

Production `inspect` is selector-only, read-only, and provider-free. It
selects the exact strict observation receipt and its bound raw smoke; it does
not execute staging traffic. Production `apply` re-fetches and revalidates
those exact bytes, the staging ON receipt and sequence, complete live prefix,
master-kill state, release identity, health, dashboard, monitor, alert window,
and zero-ledger deltas immediately before changing production. A rollback and
later re-enable require a fresh observation sequence; a prior smoke cannot be
reused.

For a normal rollback, inspect the one enabled flag with `--value false` and
`--transition-reason operator_rollback`, review its exact plan digest, and
apply it with owner authorization. Use `quality_regression` or
`health_regression` only when that observed condition is the reason. For an
emergency all-capability stop, inspect
`AI_ROUTING_MANIFEST_KILL=true --transition-reason emergency_kill`, then apply
its exact digest. The kill makes every capability effectively OFF without
rewriting their configured values. Turn the individual flags OFF before
clearing the kill; clear it with an owner-authorized rollback transaction only
after all seven are configured OFF.

### 7.1 Manifest-routing surfaces

Use this fixed readiness order and exact flag-to-telemetry mapping:

| Order | Flag | Selected divergence surface |
| --- | --- | --- |
| 1 | `AI_ROUTING_MANIFEST_CLASSIFIER` | `classifierKeyword` |
| 2 | `AI_ROUTING_MANIFEST_ORCHESTRATOR` | `orchestratorPrimary` |
| 3 | `AI_ROUTING_MANIFEST_SHADOW` | `shadowRoute` |
| 4 | `AI_ROUTING_MANIFEST_REGISTRY` | `registrySubset` |

The minimum is fixed at 200 comparisons for every surface; it is not an
operator input and cannot be lowered after seeing results. Each surface uses a
fresh, precommitted 200-turn manifest. No synthetic routing QA window is organic traffic.
Its exact traffic class is
`owner_authorized_synthetic_staging_qa`; describe it as governed synthetic
staging evidence, never as a natural-traffic or human-traffic baseline.

Each manifest contains 200 standalone natural-language turns organized into
83 editorial scenario groups. A group is only an authoring-diversity aid; it
is not a conversation, is not sent to the API, and does not authorize a claim
about multi-turn behavior. Every turn carries `standalone: true` and must be
independently understandable by the per-message router. Use English, Brazilian
Portuguese, and European Portuguese only.

The locale, stratum, and editorial-group quotas are identical for all four
surfaces:

| Dimension | Exact quota |
| --- | --- |
| Locale | `en-US=100`, `pt-BR=60`, `pt-PT=40` |
| Stratum | `deterministic_state_read=80`, `missing_field_clarification=45`, `safe_write_preview_decline=35`, `restricted_side_effect_boundary=20`, `cross_skill_preview=10`, `domain_anchored_noop=10` |
| Editorial groups | 83 total: 49 groups of two standalone turns and 34 groups of three |
| `en-US` groups | 20 groups of two and 20 groups of three |
| `pt-BR` groups | 15 groups of two and 10 groups of three |
| `pt-PT` groups | 14 groups of two and 4 groups of three |

The classifier and orchestrator surfaces measure only their actual five-domain
runtime intersection. Their exact domain-by-locale matrix is:

| Expected domain | `en-US` | `pt-BR` | `pt-PT` | Total |
| --- | ---: | ---: | ---: | ---: |
| `secretary` | 34 | 20 | 14 | 68 |
| `triathlon` | 20 | 12 | 7 | 39 |
| `content` | 16 | 10 | 6 | 32 |
| `cooking` | 16 | 10 | 6 | 32 |
| `finance` | 14 | 8 | 7 | 29 |
| **Total** | **100** | **60** | **40** | **200** |

The shadow-route and registry-subset surfaces cover all eight routable
manifest domains. Their exact domain-by-locale matrix is:

| Expected domain | `en-US` | `pt-BR` | `pt-PT` | Total |
| --- | ---: | ---: | ---: | ---: |
| `secretary` | 27 | 16 | 10 | 53 |
| `triathlon` | 15 | 9 | 6 | 30 |
| `content` | 13 | 7 | 5 | 25 |
| `cooking` | 12 | 8 | 5 | 25 |
| `finance` | 11 | 7 | 5 | 23 |
| `connections` | 8 | 5 | 4 | 17 |
| `notifications` | 7 | 4 | 3 | 14 |
| `decision_center` | 7 | 4 | 2 | 13 |
| **Total** | **100** | **60** | **40** | **200** |

Expected labels use the resolver's coarse skill space, not granular action
skills: `secretary -> secretary`, `triathlon -> training`, and each of
`content`, `cooking`, `finance`, `connections`, `notifications`, and
`decision_center` maps to the same-named resolver skill. Calendar, task,
reminder, and mail coverage can remain an editorial worksheet dimension, but
none is a valid `expectedResolverSkill` for the shared Secretary capability.

Use a blind two-role authoring procedure before any prompt is exposed to a
router or resolver. The author receives only the product/action ownership
rubric and assigned quota cells, never routing regexes, manifest examples,
corpus or chat-eval text, predecessor text, or runtime output. A separate
labeler receives the prompts in shuffled order plus the same product ownership
rubric and independently assigns `expectedDomain` and
`expectedResolverSkill`. Adjudicate or replace every disagreement, ambiguous
row, or context-dependent row before router exposure. The authoring, labeling,
adjudication, and builder steps must not invoke a router; the live staging run
is the first router consumer. Once built, never edit or replace a frozen
manifest after seeing results; a failure is a routing gap, not a prompt-tuning
invitation. This process creates agent-authored, independently labeled
synthetic QA; it is not human traffic or a human baseline.

Before execution, build the immutable manifest and check it against the
routing corpus, chat-eval fixtures, and the strict chain of every earlier
surface manifest:

```text
node scripts/build-routing-synthetic-qa-manifest.mjs \
  --input <ignored-private-draft.json> \
  --output <ignored-private-canonical-manifest.json> \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --surface classifierKeyword \
  --dedicated-id <CHAT_EVAL_DEDICATED_TENANT_ID> \
  --reference routing_corpus=<owner-only-routing-corpus-export> \
  --reference chat_eval_fixtures=<owner-only-chat-eval-fixture-export>
```

That first-surface command intentionally has no `--predecessor-manifest`.
For each later surface, change `--surface` and append the real
`--predecessor-manifest <path>` option once per earlier surface in the table's
exact readiness order: one for `orchestratorPrimary`, two for `shadowRoute`,
and three for `registrySubset`. The optional third typed reference is
`--reference qa_history=<owner-only-QA-history-export>`. Do not pass an
untyped `--reference` or use it for predecessor manifests; the builder rejects
both. Every input and reference must be an owner-only mode-`0600` ordinary
file.

The builder invokes no router and no provider. It fails closed unless the
matrix contains exactly 200 unique ordered standalone turns, the selected
surface's exact locale/domain/resolver-skill/stratum and 83-editorial-group
quotas, both mandatory typed reference lineages, the exact predecessor digest
chain, and no exact, contiguous eight-token, or high four-gram overlap with the
supplied references. It writes new canonical mode-`0600` bytes without
overwriting an existing output and prints only their SHA-256, lineage, and
aggregate counts. Record that digest before traffic.

Copy the canonical manifest to an owner-only non-release staging path, then run
the installed candidate from its selected `current` release. Supply identity
fields in the process environment and secrets only through the protected
staging env file; never put a token, `HEALTH_TOKEN`, or HMAC secret in argv.
The protected staging env must provide `HEALTH_TOKEN`; this is the existing
credential for authenticated `/health/detailed`, not the short-lived iOS JWT
the runner creates for chat requests:

```text
cd "$HOME/telegram-hub-bot-staging/current"
env -i \
  HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" \
  PATH=/usr/local/bin:/usr/bin:/bin \
  NEXUS_RELEASE_ROLE=staging \
  NEXUS_RELEASE_SHA=<deployed-full-40-hex-sha> \
  NEXUS_RELEASE_ARTIFACT_SHA256=<deployed-full-64-hex-sha256> \
  DATABASE_PATH="$HOME/telegram-hub-bot-staging/data/bot.db" \
  /usr/bin/node \
    --env-file="$HOME/telegram-hub-bot-staging/.env" \
    scripts/run-routing-synthetic-qa.mjs \
    --manifest <owner-only-canonical-manifest.json> \
    --manifest-sha256 <sha256:exact-manifest-digest>
```

The runner verifies the selected installed release marker/current symlink,
dedicated `.invalid` identity, canonical manifest bytes, owner-only file state,
and the shared release lock file. For every later surface it also reloads each
prior manifest from the release-bound protected state tree, revalidates the
current manifest against those predecessor prompts, and requires an exact
canonical `passed` receipt for every predecessor on the same release and
dedicated identity. The command self-enforces the release mutex:
its entrypoint re-executes itself under non-blocking `/usr/bin/flock` on the
shared release lock and fails closed if it cannot acquire or prove that exact
parent/lock state. Do not wrap it in a second lock command.

Before the first turn, the runner uses the protected `HEALTH_TOKEN` to require
an authenticated healthy/connected serving-process attestation for the exact
staging SHA and artifact, a clear runtime guard, the selected flag OFF, master
kill OFF, the dedicated recorder effective, and the dedicated planner not
effective. It separately mints a short-lived staging-fixture iOS JWT in memory
for chat authentication and rejects a missing health credential or one equal
to that JWT. Neither credential is printed or persisted.

The runner then sends exactly 200 authenticated
`POST /api/v1/chat/message` requests. Each body contains only the standalone
text and canonical `clientMessageId`; attachments are absent. The API binds
the raw `x-language` value to the manifest's exact `en-US`, `pt-BR`, or `pt-PT`
locale, rejects any raw or normalized attachment, and persists the raw locale
in synthetic provenance. The replay evidence separately binds its normalized
route locale, zero attachment count, message length, message HMAC, and client-
message HMAC. The staging-only terminal runs immediately after turn context,
records the real four-surface shadow routing bundle, and returns before model
budget, providers, connectors, tools, or domain actions. It also skips the
ordinary idempotency claim/lifecycle-row creation and language-preference
write; canonical turn identity is proven by the provenance, HMACs, and
campaign receipt instead. A separate dedicated rate-limit bucket permits only
this exact six-synthetic-header contract for the configured identity; ordinary
or partial-header traffic keeps the normal limit.

Every response must carry the exact recorded provenance, and before/after
dedicated-identity provider-usage and attempt-reservation ledgers must have
zero row and cost delta. Any non-200, malformed response, recorder failure,
provider ledger change, duplicate evidence path, or release/identity mismatch
fails without a passed receipt. The successful private manifest and receipt
are stored under
`~/.local/state/nexus-release/routing-synthetic-qa/` with mode
`0600`. Use the receipt's exact `startedAt` and `completedAt` as the immutable
gate window.

With the selected flag still OFF (and only previously authorized flags, if
any, ON), inspect that one immutable window:

```text
npm run release:chat-flags -- inspect \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --flag <flag-from-table> \
  --value true \
  --transition-reason gate_pass \
  --since <YYYY-MM-DDTHH:mm:ss.sssZ> \
  --until <YYYY-MM-DDTHH:mm:ss.sssZ> \
  --synthetic-qa-manifest-sha256 <sha256:exact-manifest-digest>
```

The server derives the selected surface and installed telemetry versions, runs
the provider-free divergence collector against the isolated staging database
with `--minimum-comparisons=200`, securely loads the route HMAC from the
protected staging env, and binds the exact manifest/receipt hashes and
`since`/`until` window into the plan. It requires exactly 200 in-window bundles,
one per ordinal: no extras, omissions, duplicates, or relabeling. Each bundle's
raw locale, normalized route locale, attachment-free state, message length,
message HMAC, and client-message HMAC must match the precommitted turn. The
resolved domain and resolver skill must match the independent expected labels,
and the selected surface comparison must be non-null. PASS requires agreement
of at least 0.99 on that one surface. Invalid, missing-identity, version-
mismatched, out-of-window, flag-on, other-candidate, expected-label-mismatched,
locale/attachment-mismatched, HMAC-mismatched, or recorder-state-mismatched
bundles fail the governed gate. Zero eligible comparisons is a failure, not an
empty pass. Never use an unbounded or all-surface aggregate to authorize a
per-surface flip, and never reuse one surface's manifest or receipt for
another.

Apply only the exact inspected staging plan:

```text
NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
npm run release:chat-flags -- apply \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --ack-plan <sha256:exact-plan-digest>
```

After PASS, enable only the matching flag on staging. Wait five uninterrupted
minutes, then run the exact `inspect-observation` / owner-authorized
`apply-observation` sequence above. Only that strict observation receipt can
authorize production inspect for the same candidate and flag. Production
inspect selects the receipt without running traffic; production apply
re-fetches and revalidates it, the full configured/effective prefix,
master-kill state, exact staging release, and live staging health before it
mutates production. Apply the owner-authorized production plan by the same
command with `--role production` and no routing window arguments, then repeat
health and `/chat-quality` monitoring for at least five uninterrupted minutes
before the next table row. Record the staging flag, observation, and production
receipts. On any routing, safety, health, or quality regression, set that flag
OFF through a governed rollback transaction and stop the sequence; use
`AI_ROUTING_MANIFEST_KILL=true` only when all manifest capabilities must be
disabled immediately.

### 7.2 Routing clarification

Do not start until the Phase 4 corpus calibration is committed and deployed.
Use `release:chat-flags inspect` for `AI_ROUTING_CLARIFY=true` on staging. The
server reads the exact installed calibration, authenticated
`/api/portal/chat-quality`, live staging health, and full flag prefix itself;
the operator cannot substitute a local dashboard export. Apply the exact plan,
then run real staging test traffic. After at least five uninterrupted minutes,
the observation transaction's after snapshot must show
`routingClarifyBudget.evaluatedTurns > 0`, a non-null rate no greater than
`0.10`, and `withinBudget === true`. Zero evaluated turns, a null rate, or
missing durable counters is no evidence and blocks the flip. Also review the
actual clarification outcomes for safety and usefulness; the numeric budget
alone is not a quality pass. Store the before/after redacted JSON and staging
smoke receipt in the flag evidence directory.

Resolver score-bucket calibration must be monotonic: a higher raw-score bucket
cannot carry lower calibrated precision than a lower-score bucket. Corpus-mode
generation enforces this with weighted adjacent pooling after sparse buckets
retain their reviewed prior, and runtime parsing rejects unordered, duplicate,
or non-monotonic buckets. Do not weaken that invariant to make a calibration
artifact load; regenerate from the governed routing-only export instead.

Run `inspect-observation` and owner-authorized `apply-observation`; production
inspect then selects that exact strict receipt without generating traffic.
Production apply revalidates its staging dashboard, health, alert-window, and
flag evidence again. Apply only with owner authorization, then monitor
production health and `/chat-quality` for at least five uninterrupted minutes.
If the rate exceeds 10%, the counters become
unavailable, or clarification behavior regresses, use the governed operator
to set `AI_ROUTING_CLARIFY=false`, verify health, and stop before the next
flag. The master kill is the emergency all-capability rollback.

### 7.3 Manifest classifier prompt

`AI_CLASSIFY_MANIFEST_PROMPT` stays OFF until the pinned newly-reachable
executor/runtime-guard tests pass, the boot guard reports ready, and the
separate 300-row action-skill gate passes. Domain-routing accuracy is not a
substitute for this gate. First complete the separately owner-authorized cache
refresh described under **Owner-gated steps** and retain its inspect plan and
apply receipt. That is the only provider phase; the flag operator never fills
the cache or calls a provider.

After all 300 exact-bound cache rows exist, inspect the staging enable through
the governed operator:

```text
npm run release:chat-flags -- inspect \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --flag AI_CLASSIFY_MANIFEST_PROMPT \
  --value true \
  --transition-reason gate_pass
```

The server runs the compiled installed
`dist/tools/routing-action-skill-accuracy.js` against the isolated staging
database with a freshly recorded timestamp. PASS requires exactly 300 labeled
rows, 300 exact-bound cache rows, at least 0.95 overall action-skill agreement,
the exact runtime/artifact/corpus/prompt/request/provider-model and usage
attribution identities, and zero provider calls. A `clarify` or `none` row is
correct only when its predicted domain is that exact special label and its
predicted skill is null. Source TypeScript, a developer database, a manually
supplied gate JSON, or the domain-routing snapshot is not eligible.

Apply the exact staging plan and verify that the boot guard does not
force-disable the configured flag. After five uninterrupted minutes, run the
staging observation inspect/apply sequence. Production inspect selects that
observation receipt; production apply revalidates it and live staging health
before mutation.
Monitor production for at least five uninterrupted minutes before proceeding.
On boot-guard failure, skill-routing regression, provider-budget anomaly, or
quality regression, use the governed operator to set the flag OFF and stop;
the master kill remains the emergency rollback.

An interrupted, partial, or failed cache-fill apply consumes that cache plan
claim; never replay its digest. Re-run its `--inspect` to produce the next
sequence over the remaining rows and obtain fresh exact owner approval under
the same immutable release run id and original shared hard budget. An
interrupted flag apply likewise consumes its flag plan. A changed runtime,
artifact, prompt/provenance identity, or budget is a new operation, not a
resume.

### 7.4 Cross-skill execution

The `training_plan_create` registry row deliberately keeps ordinary
`outputRefs` absent: its UI handoff is `verified_pending`, not a verified
producer for dependent steps. Verify that invariant against the exact staging
candidate with the dedicated synthetic staging tenant and rich cross-skill
fixture. Inspect the staging enable through the governed operator:

```text
npm run release:chat-flags -- inspect \
  --role staging \
  --runtime-sha <deployed-full-40-hex-sha> \
  --artifact-digest <deployed-full-64-hex-sha256> \
  --flag AI_CROSS_SKILL_EXECUTION \
  --value true \
  --transition-reason gate_pass
```

Staging inspect runs the compiled, installed, provider-free
`dist/tools/chat-capability-cross-skill-preflight.js` and binds its strict JSON
receipt, live health, complete flag prefix, registry row, and dispatch-table
readiness. Apply that exact staging plan, then wait at least five uninterrupted
minutes and run `inspect-observation` / owner-authorized `apply-observation`
for this flag.

For `AI_CROSS_SKILL_EXECUTION`, `apply-observation` runs both the full canonical
v2 staging smoke and the installed
`scripts/training-cross-skill-staging-smoke.sh --json` against the exact
staging artifact and database. It binds the dedicated smoke's strict identity
and freshness in the observation receipt; a local or operator-supplied report
is not accepted. Before the dedicated smoke it proves that the staging `.env`
and SQLite database are ordinary files isolated from production, that
`TRAINING_CROSS_SKILL_STAGING_USER_ID` equals
`CHAT_EVAL_DEDICATED_TENANT_ID`, and that this one user exists in the staging
database with a principal email ending in `.invalid`. This is the dedicated
synthetic tenant/database attestation; never point it at Felipe's or another
production identity.

The runtime reader opens that ordinary staging SQLite file directly with
`readonly: true` and `fileMustExist: true`, verifies its file identity, and
sets `PRAGMA query_only=ON`. Every intelligence-bus, mesh, and shared-decision
read is bound to that same handle through the standalone global-database
scope. It never calls the application database initializer, runs migrations
or boot backfills, seeds an owner, rewrites credentials, or writes data. The
standalone scope restores the global database binding; the smoke then
invalidates its provider and closes the owned handle, including on failure.

The smoke wrapper verifies every declared byte in the installed release against its
`artifact-manifest.json` and `.complete.json`, derives the full runtime SHA and
artifact digest from that verification, and exports those verified values to
the smoke process. It rejects a mismatched `NEXUS_RELEASE_DIR` or any supplied
identity that differs from the verified bytes. It never trusts stale `dist/`:
an installed release uses its verified immutable build, while local `--dry-run`
mode rebuilds before deriving a non-evidentiary source-manifest identity.
Both the Markdown report and JSON receipt are written under
`<staging-release-base-dir>/.local/release/smoke-evidence/`, outside the
immutable release tree.

The command fails closed unless the release identity verifies, staging is
explicit, the isolated user/database guards pass, the flag is effectively ON,
and the master kill is OFF. Its exit codes are distinct so a hard refusal can
never be read as an intentional skip: `0` pass, `1` smoke failure, `2` the
staging runtime section intentionally blocked by design in local `--dry-run`,
and `3` a guard or release-identity refusal. Treat `3` as a hard failure.
Non-installed callers (`scripts/closed-beta-smoke.sh` leg 5 and
`npm run smoke:training-cross-skill:staging`) run `--dry-run` and are
fixture-only; their receipts carry a non-evidentiary marker and are never
staging proof. A valid result has no `blocked` or `fail` row and
records `phase7_cross_skill_flag_contract=pass`. Its evidence must include the
real manifest ownership rewrite, the Training + Secretary grouped preview, the
flag-on-only planner-decline boundary, the executor's zero-action confirmation
hold with zero executor/dependency access, the dedicated staging identity used
for both user and tenant scope, and `training_plan_create.outputRefs=absent`.
The wrapper also writes a
full-runtime-SHA + full-artifact-digest JSON receipt under `.local/release/smoke-evidence/`;
the receipt also records the staging role. Retain it with the full-identity
Markdown report and staging transaction. Fixture-only or `--dry-run` output
is never staging proof.

Production inspect is read-only: it selects the pre-existing observation and
bound cross-skill smoke evidence and never executes the smoke. Review
the JSON smoke, grouped previews, decline behavior, tenant/user scope, and
`/chat-quality` before the owner-authorized production apply. Production apply
revalidates those exact observation bytes, the staging ON receipt, and live
staging health. Monitor production health and `/chat-quality` for at least five
uninterrupted minutes.
If a dependent step consumes an unverified Training handoff, a scope check
fails, or chat quality/health regresses, use the governed operator to set
`AI_CROSS_SKILL_EXECUTION=false`, verify health, and stop. Do not add
`training_plan_create.outputRefs` during rollout; that requires a separately
tested verified-success executor contract.

## Owner-gated steps (human decisions never automated)

The human labeling and approval decisions below remain owner-gated. Any command
that reads or mutates the installed PM2 release, production database, `.env`, or
process identity is nevertheless a first-cutover fallback procedure only. No
equivalent post-bootstrap container maintenance transaction is implemented; it
remains blocked under the authorization, mutex, drain, identity, and recovery
requirements above.

- Corpus label decisions are owner-gated. Private sampler/history utterances
  must be reviewed one at a time at `/routing-corpus`; they are never included
  in an agent-proposed batch. The portal records an optional manifest
  `chatActionSkill`, validates that it belongs to the selected domain, permits
  an explicit domain-only choice, and audit-logs the mutation without raw
  utterance text.
- The checked-in, tenant-0 synthetic product-profile set has one narrowly
  scoped assisted-review path. Deploy
  `routing-corpus-builder@1.2.0`, run
  `npx tsx scripts/build-routing-corpus.ts`, and confirm the tenant-0
  synthetic set is exactly 300 unique English/Portuguese rows: 224 bilingual
  routing projections plus 76 product-profile controls. Ten projections add
  self-contained product context where the original chat eval turn relies on
  prior conversation state; the shared conversational fixtures stay
  unchanged. Private pending rows may coexist but remain outside this exact
  HMAC-bound set and the batch. Then create the read-only,
  owner-only review artifact and database-bound plan:

  ```text
  npx tsx scripts/apply-routing-corpus-label-plan.ts \
    --inspect \
    --db=<production-db-path> \
    --review-out=<ignored-owner-only-review-json> \
    --runtime-sha=<deployed-full-sha> \
    --artifact-digest=<deployed-artifact-sha256>
  ```

  Felipe must read every utterance/domain/skill row in that exact review file
  and explicitly approve the printed `planDigest`. An agent proposal is not
  human ground truth before that review. Approval authorizes only mechanical
  transport of those exact reviewed decisions:

  ```text
  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npx tsx scripts/apply-routing-corpus-label-plan.ts \
    --apply \
    --db=<production-db-path> \
    --backup-dir=<protected-backup-directory> \
    --runtime-sha=<deployed-full-sha> \
    --artifact-digest=<deployed-artifact-sha256> \
    --ack-plan=<sha256:plan-digest>
  ```

  Both modes require `CLASSIFY_SHADOW_HASH_SECRET`. The plan binds the exact
  300 row IDs, HMACs and their schemes, text digests, tenant/user scope,
  source, pending state, domain/skill decisions, corpus contract, runtime SHA,
  and artifact digest. All 300 checked-in controls use a domain-separated
  synthetic HMAC so an identical private/history utterance can neither
  displace nor enter the owner-reviewed batch. If builder 1.2 created the new
  rows over a database that still has the pre-1.2 raw-HMAC aliases, inspect
  also binds exactly all 224 legacy bilingual rows (or zero). Alias discovery
  uses the exact checked-in text and provenance rather than the current HMAC
  secret, so secret rotation cannot hide stale aliases.
  Apply refuses authorization or digest mismatch before creating the backup
  directory, re-inspects after the verified `0600` SQLite backup, then
  rebinds the complete row/alias state inside the immediate transaction. It
  labels all 300 rows, deletes the exact 224 legacy aliases when present, and
  writes one redacted `agent_proposed_owner_approved` audit receipt
  atomically. It refuses private rows, stale/partial labels or aliases, an
  accepted accuracy snapshot, missing domain/special-label coverage, or fewer
  than 20 examples for any of the 11 action skills. This owner approval does
  not authorize `--refresh-llm` or snapshot acceptance.
  The 300 rows provide synthetic, locale-specific, skill-balanced product
  coverage: they represent about 153 independent intent shapes, are not
  production-traffic-weighted, and the eight `clarify` plus eight `none` rows
  each cover four bilingual concepts. Do not present this distribution as a
  natural-traffic baseline.
- The one-time production removal of the eight exact retired Spanish
  synthetic corpus fixtures. First deploy
  `routing-corpus-builder@1.1.0` or later. Using the exact runtime SHA and artifact
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
  Re-run `npx tsx scripts/build-routing-corpus.ts` afterward. Builder 1.1
  retains 224 unique bilingual fixtures (109 English, 115 Portuguese);
  builder 1.2 adds the 76 owner-reviewable product-profile controls for the exact
  300-row assisted-review set.
- `npx tsx scripts/run-routing-accuracy.ts --refresh-llm` (the only networked
  domain-routing-accuracy path).
- `npx tsx scripts/run-routing-accuracy.ts --gate --accept-snapshot`
  (ratchet acceptance), with `NEXUS_RELEASE_OWNER_AUTHORIZED=1` set only after
  Felipe approves that acceptance. Standalone `--accept-snapshot` is refused.
  Acceptance runs in one immediate transaction, recomputes and binds the
  complete labeled-corpus identity (including skill labels), report,
  readiness, and current ratchet. Readiness counts only replayable labeled rows
  with retained utterance text and independently refuses fewer than 300 rows,
  fewer than 20 labels for any manifest domain or action skill, or fewer than
  eight `clarify` and eight `none` controls.
  Accepted report parsing is fail-closed: it requires exactly one internally
  consistent report for every routing surface, complete confusion totals, and
  valid calibration buckets. A later acceptance may not reduce an accepted
  surface's absolute/relative replay coverage or any accepted domain's
  absolute support.
  `routing-accuracy@1.1.0` scores domain routing only. Its action-skill counts
  prove label coverage, not skill-routing accuracy. Do not cite the Phase 4
  snapshot as evidence that action-skill routing passed. Before
  `AI_CLASSIFY_MANIFEST_PROMPT` can flip in Phase 7, populate and pass the
  separate manifest-prompt action-skill evaluator for the now-labeled corpus.
  Its cache is deliberately independent of `routing_llm_classify_cache` and
  accepted domain snapshots.

  First produce a provider-free plan on the exact deployed database and
  release identity:

  ```text
  npx tsx scripts/refresh-routing-action-skill-cache.ts --inspect \
    --db=<deployed-db> \
    --prompt=prompts/classifier-manifest.md \
    --runtime-sha=<deployed-full-sha> \
    --artifact-digest=<deployed-artifact-sha256> \
    --limit=300 \
    --budget-usd=<hard-cap-at-or-above-the-reported-attempt-ceiling>
  ```

  The redacted plan binds the corpus identity, prompt bytes, every request
  digest, Gemini 2.5 Flash-Lite, the 256-token output cap, release identity,
  selected rows, hard budget, and aggregate provider-attempt cost ceiling.
  It refuses a non-finite ceiling, a ceiling above the supplied cap, a cap
  above USD 0.50, or any model other than the configured Flash-Lite model.
  Provider work is a separate owner-authorized mutation. After Felipe approves
  the exact plan digest and cap, apply that unchanged plan from an owner-only
  backup directory:

  ```text
  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npx tsx scripts/refresh-routing-action-skill-cache.ts --apply \
    --db=<deployed-db> \
    --prompt=prompts/classifier-manifest.md \
    --runtime-sha=<deployed-full-sha> \
    --artifact-digest=<deployed-artifact-sha256> \
    --limit=300 \
    --budget-usd=<approved-hard-cap> \
    --backup-dir=<protected-backup-directory> \
    --ack-plan=<sha256:approved-plan-digest>
  ```

  Apply refuses before backup or provider access unless authorization and the
  plan acknowledgement are exact. It creates and verifies a `0700` directory
  and `0600` SQLite backup, re-inspects state, refuses the master kill or a
  failed manifest runtime guard, proves the active provider prompt is
  byte-identical to the inspected artifact, and calls Gemini directly with one
  provider attempt per selected row and no fallback. A prediction is retained
  only when exactly one successful `api_usage` row matches provider, model,
  category, run, and the `system` / `routing_action_skill_cache_refresh`
  attribution. An interrupted, partial, or failed apply consumes its exact
  plan claim; never replay that digest. Inspect the remaining rows to obtain
  the next `planSequence` and new digest, get fresh exact owner approval, and
  apply under the same immutable release run id and original shared hard
  budget. Raw prompts and provider responses are not emitted or stored. Each
  item gets one short canonical budget reservation, so a full-corpus pass does
  not hold the shared system-AI lock while hundreds of sequential calls run.

  Cache population alone does not authorize the flag. Continue at **Phase
  7.3**: `release:chat-flags inspect` runs the compiled installed cache-only
  evaluator against the exact staging database and binds its output into the
  enable plan. That gate requires the exact 300 labeled rows, 300 exact-bound
  cache rows, and overall action-skill agreement of at least 0.95. `clarify`
  and `none` controls pass only when the predicted domain exactly matches that
  special label and the predicted skill is null; a generic skill abstention is
  not correct. Per-skill precision and recall are diagnostics, not additional
  invented rollout thresholds. The compiled gate is read-only, makes zero
  provider calls, and has no snapshot-acceptance mutation.
- Every manifest-routing surface flip. Follow **Phase 7.1** with the exact
  selected surface, candidate identity, canonical window, telemetry versions,
  and fixed 200-comparison minimum. Authorization never transfers to another
  surface or candidate.
- Phase 7 keeps `training_plan_create.outputRefs` absent when
  `AI_CROSS_SKILL_EXECUTION` flips. The real training builder is a UI handoff
  with `verified_pending`, while dependent plan steps require
  `verified_success`; advertising `plan.title` would create a dependency that
  cannot execute. Other verified-success producers remain eligible. Revisit
  the training row only after its executor returns a verified plan and a real
  producer-to-dependent regression passes.
- Generate the first corpus calibration only from an evidence-bound,
  routing-only export. Never copy the full production database to a developer
  machine. The governed export operator must first land and be released in a
  separate exact artifact; otherwise asking an unreleased operator to produce
  the input for its own release creates a provenance cycle. From a clean
  protected-main checkout of that already-running production artifact, inspect
  the exact production state:

  ```text
  npm run release:routing-calibration-export -- inspect \
    --runtime-sha <production-runtime-sha> \
    --artifact-digest <production-artifact-digest>
  ```

  Review the redacted plan and obtain Felipe's authorization for its exact
  `sha256:` digest. Apply that same plan before its one-hour expiry:

  ```text
  NEXUS_RELEASE_OWNER_AUTHORIZED=1 \
  npm run release:routing-calibration-export -- apply \
    --runtime-sha <production-runtime-sha> \
    --artifact-digest <production-artifact-digest> \
    --ack-plan sha256:<reviewed-plan-digest>
  ```

  Apply dispatches one detached transaction. If the local process, SSH, or
  polling is interrupted, observe that same transaction without applying it
  again:

  ```text
  npm run release:routing-calibration-export -- collect \
    --runtime-sha <production-runtime-sha> \
    --artifact-digest <production-artifact-digest> \
    --ack-plan sha256:<reviewed-plan-digest>
  ```

  `collect` derives the transaction id from the locally retained plan and can
  publish either a complete, revalidated evidence set or a terminal partial
  receipt whose status is exactly `failed`. A stranded `started` or
  `exported_pending_post_health` receipt is nonterminal evidence: collection
  refuses it and the transaction requires manual recovery under the shared
  locks. Never re-run `apply` for that plan or lower/reset its sequence.
  Collection also deliberately requires that the retained runtime is still
  protected `origin/main` and still selected in production. If either identity
  advances before collection finishes, stop: recover the retained transaction
  manually under both shared locks and validate its immutable server-side
  artifacts. Do not relabel nonterminal state as failed and do not treat an
  uncollected receipt as release evidence.

  Inspect and apply both hold the shared user release lock and root/Sonar lock.
  They verify the exact installed release, PM2 identity, health, database
  integrity, accepted-snapshot JSON digest, complete corpus identity, and exact
  LLM-cache row digest. Apply builds a fresh `0600` SQLite file containing only
  the 300 approved synthetic corpus rows, their matching cache rows, and an
  intentionally empty accepted-snapshot table. It preserves `labeled_at` and
  normalizes only creation times, suggested routes, and provider model
  metadata. The final receipt is emitted only after source identity, locks,
  release selector, PM2, and production health pass again. A claimed plan that
  does not finish retains an explicitly partial receipt name/schema and cannot
  be replayed. The operator makes zero provider calls.

  Partial LLM-cache coverage is valid for export. A successful 25/300 export
  therefore has a final passed receipt with `cacheComplete: false`; this is
  distinct from an operational partial receipt. Only `status: failed` is a
  collectible terminal failure; `started` and `exported_pending_post_health`
  require manual recovery. Because the sanitized accepted-snapshot table is empty,
  a downstream `run-routing-accuracy --gate` result of
  `skip=no_accepted_snapshot` is never authoritative evidence.

  Before generation, copy the reviewed currently deployed
  `config/routing-calibration.json` into the protected ignored evidence
  directory as a separate mode-`0600` baseline and record its SHA-256. The
  baseline must not be the output path: sparse-bucket priors are weighted into
  monotonic pooling, so using a prior output as the next baseline would make a
  retry drift. Run the zero-provider replay with that immutable baseline and
  one recorded canonical timestamp:

  ```text
  npx tsx scripts/calibrate-routing-confidence.ts \
    --db=<sanitized-routing-only-db> \
    --baseline=<reviewed-calibration-baseline-json> \
    --out=config/routing-calibration.json \
    --generated-at=<YYYY-MM-DDTHH:mm:ss.sssZ> \
    --export-plan=<retained-private-export-plan-json> \
    --export-evidence=<retained-private-export-evidence-json> \
    --export-receipt=<retained-private-final-receipt-json> \
    --ack-plan=sha256:<owner-approved-plan-digest>
  ```

  Corpus mode requires both `--baseline` and `--generated-at`; reuse those
  exact baseline bytes and timestamp for retries so the reviewed artifact
  stays byte-reproducible. The sanitized database, reviewed baseline, export
  plan, export evidence, and final receipt must each be a current-owner,
  ordinary single-link file with exact mode `0600`, no symbolic-link path
  component, and a current-owner private parent. The command anchors each
  parent and file with `O_NOFOLLOW`, validates the canonical plan and final
  receipt digests plus their release, postflight, normalization, and
  zero-provider bindings, and requires `--ack-plan` to equal the validated
  plan digest. It copies the captured database bytes into a private replay
  file, independently verifies that copy against the exact export evidence,
  opens it read-only with `query_only`, and verifies the exact routing-only
  schema, `delete` journal mode, absence of `-wal`, `-shm`, and `-journal`
  sidecars, empty snapshot table, integrity, and foreign keys. It then derives
  the exact input hash, 300-row corpus identity, cache count/digest, production
  runtime/artifact/transaction, and provider-call count from those validated
  artifacts before importing the routing graph. The baseline must use exactly
  `routing-calibration@1.0.0` with resolver boundaries `[5, 2, 1, 0]`; only
  predecessor precision monotonicity is relaxed because the generator repairs
  it. Empirical correct counts remain exact through weighted
  Pool-Adjacent-Violators and round only once in the final table.

  Replay is scoped to that explicit baseline instead of the ambient output.
  Publication takes a calibration-specific cooperative lock and snapshots the
  output before replay, rejects aliases and another calibration writer, writes
  a same-parent `0644` temporary file, fsyncs it, revalidates the unchanged
  destination immediately before an atomic rename, fsyncs the parent, and
  verifies the published bytes. The lock cannot coordinate an unrelated
  editor, so serialize other writes to the tracked output while this command
  runs; do not describe the check-then-rename boundary as a filesystem CAS.
  Use the equals forms shown above so bootstrap binding is established before
  imports. Record the CLI-emitted labeled count, cache coverage, baseline
  provenance and hash, input/output hashes, and zero provider calls in ignored
  evidence, then land the generated config through a normal PR.
  `classifier.lowConfidenceFloor` is an active runtime guard even while the
  manifest-prompt flag is off. It may be recalibrated only at exact full
  LLM-cache coverage (`covered === corpusSize`); partial or skewed coverage
  must prove `classifierFloorCalibrated=false` and retain the reviewed baseline
  floor of `0.6`. Domain-representative sampling alone is not sufficient
  because the current observations do not carry auditable stratification or
  weighting metadata.
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
