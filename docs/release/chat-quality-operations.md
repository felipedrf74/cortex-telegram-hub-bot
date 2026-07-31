# Chat Quality Operations

Status: current
Owner: Felipe
Last verified: 2026-07-30

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
  alphabetic term, and sends only that term plus a locale-specific output
  prefix instead of copying raw saved messages into the narrow generation
  prompt. The current request remains verbatim so its constraints are not
  discarded. The canonical release-eval compact message envelope is
  regression-tested at no more than 500 characters. The mode uses a
  1024-token context, 32-token output cap, and a one-property `a` object
  containing a 24–64 character answer, with a 62-character answer target. The
  prompt instructs the model to copy the prefix, including the request terms
  and selected authorized term, verbatim. The deterministic verifier requires
  the request stems, requires the selected term to occupy the entire grounding
  slot, and requires two distinct short one-word format nouns. Extra grounding
  words, a selected term appearing only as a format, or a translated substitute
  for the selected term are rejected. The server returns the model's answer
  value unchanged. A
  JSON-complete, provider-complete `grounding in format/format` response is
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

## Owner-gated steps (human decisions never automated)

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
  routing-accuracy path).
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
  `AI_CLASSIFY_MANIFEST_PROMPT` can flip in Phase 7, add and pass the separate
  action-skill prediction/agreement evaluator for the now-labeled corpus.
- Generate the first corpus calibration only from an evidence-bound,
  routing-only export. Never copy the full production database to a developer
  machine. While holding both the release and Sonar locks, verify the exact
  completed production release, health, database integrity, accepted snapshot
  JSON digest, complete corpus identity, and exact LLM-cache row digest. Build
  a fresh `0600` SQLite file containing only the 300 approved synthetic corpus
  rows, their matching cache rows, and an empty accepted-snapshot table.
  Omit or normalize source timestamps, suggested routes, and provider metadata
  that calibration does not consume. The final export receipt is valid only
  after post-export production health passes; incomplete work must retain an
  explicitly partial receipt name/schema.

  From a protected ignored evidence directory, run the zero-provider replay
  with one recorded canonical timestamp:

  ```text
  npx tsx scripts/calibrate-routing-confidence.ts \
    --db=<sanitized-routing-only-db> \
    --out=config/routing-calibration.json \
    --generated-at=<YYYY-MM-DDTHH:mm:ss.sssZ>
  ```

  Corpus mode requires `--generated-at`; reuse that exact value for retries so
  the reviewed artifact stays byte-reproducible. The command binds the explicit
  database before importing the routing graph and refuses to replace an
  initialized application database. Record labeled count, cache coverage,
  baseline provenance, input/config hashes, and zero provider calls in ignored
  evidence, then land the generated config through a normal PR.
  `classifier.lowConfidenceFloor` is an active runtime guard even while the
  manifest-prompt flag is off. It may be recalibrated only at exact full
  LLM-cache coverage (`covered === corpusSize`); partial or skewed coverage
  retains the reviewed baseline floor. Domain-representative sampling alone is
  not sufficient because the current observations do not carry auditable
  stratification or weighting metadata.
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
