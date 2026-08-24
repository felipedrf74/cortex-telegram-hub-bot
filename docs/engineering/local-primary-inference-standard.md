# Local-Primary Inference Standard

Status: canonical
Owner: backend architecture and inference operations leads
Last verified: 2026-08-22
Update policy: update when the local model manifest, specialist profiles,
runtime admission, fallback, job persistence, host envelope, or pricing proof
changes.

## 1. Release state and authority

The local-primary implementation is additive and default OFF. A protected-main
merge enters the existing signed OCI continuous-release pipeline; application
engineers do not manually prepare or promote releases. Production admission is
controlled by `local_inference_runtime_control`, and production `canary` or
`active` requires a digest-pinned winner in
`config/local-model-manifest.json`. A production-selected manifest must also
bind the sanitized bakeoff report digest and completion time, corpus reference,
winning candidate ID, attended benchmark rollback-receipt digest,
license-review evidence, and owner-approval evidence. The winning candidate ID
must equal `activeModelId`. A `control_only`
manifest must carry `selectionEvidence: null`, so candidate metadata cannot be
mistaken for an approved production decision.

A missing, malformed, or policy-invalid local-model manifest must not crash the
backend import path. Nexus remains cloud-capable, but every local feature is
compiled OFF and the runtime-control read view reports OFF with a manifest
error code. Restoring a valid signed manifest and restarting the process is
required before local admission can resume; runtime environment values never
substitute for missing signed identity.
An authorized public request may still use the governed cloud boundary during
that outage and receives a normal inference run/attempt ledger. A private or
local-only request receives a persisted failed run before its typed unavailable
response, allowing an outer privacy-reduced fallback to prove eligibility
without reusing the private prompt.
Selector violations preserve the released error name/code and expose bounded
`policy`, `source`, `receivedModel`, and `expectedModel` fields for operator
diagnostics.

Host Ollama changes are not application releases. They require an attended
`plan -> inspect -> owner apply -> verify -> receipt` transaction under the
shared maintenance lock. The production Compose gateway must not be added
until that transaction has created and verified the separate staging and
production socket directories.

The exact host sequence is:

Before step 1, create a Git archive from the exact settled protected-main SHA
with the `source/` prefix, record its SHA-256 as the owner acknowledgement, and
stage both the root-owned archive and extracted tree only at
`/var/lib/nexus-release-bootstrap/<source-sha>/source.tar.gz` and `source/`.
Every path component must be root-owned and non-writable by group/other. The
installer rejects any other source path, archive digest, or Git archive commit
binding; operational assets must never be copied around that contract.

1. Run the archive/digest-authorized `scripts/install-ollama.sh` transaction
   from the root-owned protected-main source. It verifies the active manifest
   tag/digest and applies the 18GB/20GB, 8-CPU, zero-swap service envelope with
   its existing predecessor rollback and receipt. On an upgrade, the permanent
   install guard/checker may differ from the new source only when their exact
   bytes are attested by the preceding complete install receipt and its retained
   root-owned source archive; the transaction backs them up before replacement.
2. With both gateway sockets absent, use
   `/usr/local/sbin/nexus-local-model-benchmark-envelope-transaction.mjs
   plan --candidate-id <signed-manifest-id>`. The candidate must already be
   installed through the attended host CLI; the transaction resolves its exact
   `/api/tags` digest and binds that identity into the plan and receipt. The
   plan reports the current host-pressure observation, while its acknowledgement
   binds the release, manifest, signed host-admission thresholds, and exact
   drop-in bytes. Volatile `MemAvailable` bytes are deliberately not hashed;
   apply re-reads and enforces live headroom and swap immediately before the
   write, then records that admission observation in the receipt. Inspect that
   plan and apply the same candidate ID with only its exact acknowledgement.
   This temporarily raises systemd to 22GB/24GB while
   retaining 8 CPUs, zero swap, Nice 10, one loaded model, and one generation.
   Its apply output returns a `receiptSha256` value used as the exact rollback
   acknowledgement.
   Install and exercise one candidate at a time through the attended host CLI,
   never through the gateway. A changed candidate digest invalidates the plan.
   Always run receipt-bound `rollback` after the
   benchmark; it removes only the unchanged benchmark drop-in, restarts
   Ollama, and proves the 18GB/20GB production envelope was restored. The
   rollback output's `rollbackReceiptSha256` is used directly as the selected
   winner's `selectionEvidence.benchmarkHostRollbackReceiptDigest`; the later
   socket transaction requires that receipt's candidate ID, tag, and digest to
   match the signed production winner.
3. After the winner and selection evidence are signed in a settled
   protected-main release, rerun the archive/digest-authorized installer from
   that exact release. This updates the root-owned installed manifest and
   retained model identity while re-proving the production envelope; it does
   not download an unreviewed model.
4. Run
   `/usr/local/sbin/nexus-local-inference-socket-transaction.mjs plan`,
   which resolves the selected digest to exactly one root-owned benchmark
   rollback receipt and verifies its source receipt, model identity, and
   restored 18GB/20GB envelope. Inspect the release/model/host/directory
   preimage, then run
   `apply --ack-plan <printed-digest>`. The command holds the shared maintenance lock,
   activates the reviewed tmpfiles policy, creates only the two UID-10001
   mode-0700 directories, verifies the result, and writes a root-owned receipt.
   Its receipt-bound `rollback` removes the activated policy when it was not
   present before apply, and removes only directories that transaction created
   and only while empty, so a reboot cannot recreate a rolled-back boundary.
5. Add the gateway service and corresponding socket bind to signed Compose in
   a later protected-main change using `/run/nexus-inference/staging/ollama.sock`
   or `/run/nexus-inference/production/ollama.sock`. Never share the two leaf
   directories or add the bridge before the host receipt exists.

## 2. Runtime topology

- One manifest-selected model is resident. Secretary, Content, Training,
  Triathlon, Cooking, and Finance are versioned logical profiles over that
  model; they are not separate model processes. Every profile declares its
  context class, server-compiled tenant/request memory boundary, schema set,
  empty tool allowlist, maximum risk and execution classes, output ceiling,
  mandatory non-empty/schema validators, and explicit local-repair/cloud-
  escalation policy. `SkillInferenceService` fails closed when that output-only
  contract is incomplete.
- `SkillInferenceService` owns entitlement, operation fair use, plan context,
  schema policy, routing mode, attempt telemetry, bounded local repair, and
  lazy cloud-budget admission.
- `localInferenceScheduler` is the only local-primary product queue: one active
  generation, four waiting requests, interactive before background, and
  weighted Max/Pro priority with normal-tier starvation protection. During
  shadow, canary, and active modes, legacy Ollama Chat calls use this same
  scheduler so evaluation and visible work cannot overlap. The pre-existing
  configurable legacy gate remains only while local-primary mode is OFF. A
  legacy visible or repair call admitted to the shared scheduler has a fixed
  45-second queue deadline; mode OFF retains the predecessor gate's unbounded
  wait contract.
  Durable Content jobs use the same Max:Pro 2:1 weighting when shared inference
  becomes idle. Their burst history is derived from persisted job starts, so a
  backend restart cannot reset priority into Pro starvation.
  Detached shadow work always uses background class and weight 1. The
  orchestrator hands an eligible comparison closure to the final visible
  terminal only after model work completes. The V2 and legacy terminals release
  it only after final composition, quality, fallback, and language checks,
  persistence, and successful response publication, so a request cannot queue
  behind its own shadow and an unpublished answer cannot become a baseline.
  Only a successful, non-degraded model-owned visible result that still passes
  the final Chat composition, quality, fallback, and response-language gates is
  a valid comparison baseline; provider failures, policy refusals, repaired or
  blocked answers, and deterministic templates/fallbacks do not schedule
  shadow evidence. Detached comparisons do not inherit the delivered HTTP
  request's abort signal. Their nested async
  usage attribution outranks any still-open visible-request attribution, and a
  write-time normalizer makes the shadow job/category identity atomic.
  Ollama's queue remains a final daemon defense, not a second product scheduler.
- The signed gateway exposes a Unix socket only. It permits bounded read-only
  runtime paths and chat, rejects model mutation and arbitrary proxying, runs
  without application secrets, and reaches host Ollama only through host
  loopback. Every chat call performs a bounded `/api/ps` residency check that
  matches both the active tag and normalized signed digest. The gateway
  independently serializes chat work to one
  active request with at most four waiting requests and re-reads the signed
  concurrency envelope when queued work reaches the head. This is a defensive
  boundary behind the product scheduler, not a second entitlement or priority
  policy. If Ollama restarted or evicted the model, one single-flight,
  gateway-owned warm chat loads only that fixed manifest model before the
  original request proceeds; client fields never influence the warm call.
  Warming is permitted only after an authoritative empty `/api/ps` inventory;
  a present model with a missing or mismatched digest, or a failed probe,
  returns 503 without dispatching any `/api/chat` request.
  Probes, warm calls, and user requests have idle and wall-clock deadlines.
  A client disconnect aborts the in-flight residency probe and never enters
  the warm path with an already-aborted request; request error handlers are
  installed before any destroy path so cancellation cannot terminate or stall
  the standalone gateway process.
  A disconnect during the warm aborts only that request, emits a content-free
  cancellation event, and does not activate the shared failure cooldown. A
  genuine failed warm starts a 30-second cooldown, and start/completion events
  record only model identity, success, duration, and cooldown—not prompts or
  output.
  Request and response byte caps return deterministic 413 and 502 errors.
  Gateway 503 bodies distinguish non-resident model, unavailable upstream, and
  explicit daemon queue pressure; a missing/corrupt signed manifest returns
  typed `model_manifest_unavailable` health and model-bound request failures
  without terminating the gateway process. A failed authoritative fresh read
  clears the process cache, so health, reporting, and request-time readers
  cannot continue from a stale manifest. Provider health returns a sanitized
  degraded snapshot and does not probe Ollama until a valid manifest snapshot
  is available. The provider maps only explicit
  daemon pressure to capacity and treats a missing/inaccessible Unix socket as
  typed local transport unavailability.
  The gateway validates structured `format` schemas and rejects socket paths
  with symlinked ancestors.
- Because the gateway reuses the backend image, its future Compose service must
  override the image's inherited TCP backend healthcheck. The gateway probe is
  `curl --unix-socket "$OLLAMA_GATEWAY_SOCKET_PATH" -fsS
  http://localhost/health`; it proves the socket listener and a valid fresh
  signed manifest without requiring host Ollama to be reachable. Compose must
  also override the image command with
  `node dist/tools/ollama-unix-gateway.js` and must not publish a port.
- The provider checks the active production model digest before generation.
  A successful authoritative `/api/tags` read invalidates any cached identity
  when the target is missing, duplicated, or malformed. A missing or
  mismatched digest fails local routing closed.

## 3. Default-OFF controls

| Control | Purpose |
| --- | --- |
| `LOCAL_PRIMARY_CONTENT_PROXY_ENABLED` | Governs attributed Content proxy routing. |
| `LOCAL_PRIMARY_CHAT_ENABLED` | Moves eligible ChatCoreV2 read-only generation to `SkillInferenceService`. |
| `LOCAL_PRIMARY_CONTENT_SPECIALISTS_ENABLED` | Batches seven logical Content roles into four dependency groups and up to five base local calls. |
| `LOCAL_PRIMARY_SCRIPT_JOBS_ENABLED` | Enables resumable long-form script jobs. |
| `LOCAL_PRIMARY_AUTO_ROLLBACK_ENABLED` | Enables the five-minute application threshold monitor. |
| `LOCAL_PRIMARY_LLM_HARD_KILL` | Attended emergency environment kill. |
| `LOCAL_PRIMARY_STAFF_USER_IDS` | Optional authenticated owner/staff IDs for verification-only shadow diagnostics; never a percentage-cohort launch gate. |
| `OLLAMA_GATEWAY_SOCKET_PATH` | Selects the environment-specific gateway socket. |
| `CONTENT_SCRIPT_JOB_ENCRYPTION_KEY` | Current script-job encryption key, minimum 32 bytes. |
| `CONTENT_SCRIPT_JOB_PREVIOUS_ENCRYPTION_KEYS` | Comma-separated decrypt-only key ring for rotation. |

Every feature flag is subordinate to the audited database mode. Staging local
inference remains OFF except during explicit evaluation. A signed-manifest
version, active-model digest, or specialist-profile version change makes any
existing shadow/canary/active row effectively OFF until an owner explicitly
sets OFF and starts again. Runtime-control rows and mutation events bind all
three identities, preventing a changed inference contract from inheriting the
previous contract's acceptance evidence.

Before background workers start, the application reconciles any effective
protective OFF decision into the durable control row. This covers manifest or
configuration drift—including a disabled Ollama provider, missing gateway
socket path, or disabled Content proxy—invalid persisted stage relationships,
and an emergency latch. Reconciliation writes a `system_monitor` audit event, so a previous
shadow/canary/active row cannot silently reopen after restart; owner-controlled
activation must begin again from OFF.

Enabling the script-job worker without the Content proxy and a valid current
encryption key is a startup error. Recovery never opens or mutates queued
user-scoped jobs under a partially configured deployment.

Production advancement is code-governed as `off -> active/100%`, with
verification-only `shadow/0%` available as an optional intermediate state.
In shadow, resumable Content script jobs admit only the authenticated user IDs
listed in `LOCAL_PRIMARY_STAFF_USER_IDS`; this is the release-bound lane for
the nine pre-activation acceptance scripts and never admits normal users.
The owner may move directly from OFF to active/100% only with the signed
ten-script acceptance/economics evidence reference, healthy pre-activation
latency/error baselines, a production-selected manifest, the verified gateway,
and automatic rollback enabled. Production percentage canaries are rejected;
staging may retain arbitrary explicit canary percentages for isolated
evaluation. Reductions and mode OFF remain immediate.

## 4. Admission and fallback

Admission order is entitlement, local user-visible-operation fair use,
host/application capacity, local inference, cloud privacy and dollar budget
only when a cloud attempt is made, and separately billed search/tool policy.
Internal sections, repairs, and continuations share the operation ID and do not
consume additional fair-use operations. Detached shadow-local comparisons do
not consume user fair use; their attempt telemetry remains available for
bakeoff and rollout evidence. Shadow work is detached and local-only: the
existing cloud owner still produces the user-visible answer, while Chat and
signed Content callers schedule a private-safe comparison under
`evaluation_mode='shadow'` only after that owner returns a successful,
non-degraded result. Shadow API usage is explicitly tagged and excluded
from production quality, fallback, provider-baseline, and pricing denominators.
Both local-primary and classifier shadow categories are also excluded from the
legacy Ollama hourly/daily limiter, script allowance, cost-guardrail
`callsToday`, provider workload baselines, active-provider-user counts, and
actual plan/cloud-spend aggregates. Nested shadow attribution overrides any
still-open visible request, and the write boundary normalizes job and category
as one atomic shadow identity.

Shadow runs finish with `final_route='none'`; production outcomes use only
`local`, `cloud`, or `none`, and no synthetic shadow-cloud route exists.

Operations rejected because local capacity is busy, the bounded queue is full,
or its admission deadline expires do not consume hourly or daily operation
fair use. Neither do pre-delivery model, manifest, transport, provider-health,
timeout, routing, or circuit outages that produce no usable result. They remain visible
in attempt telemetry. Validation failures and user cancellation after admission
do count as the user's operation; cancellation is not treated as capacity churn
and it never authorizes cloud fallback.
The provider error-kind union is mapped exhaustively to charge/exempt behavior,
including `unsupported_capability`; non-provider admission, circuit, empty-output,
lease, heartbeat, and shutdown reasons use the same centralized taxonomy.
The Skill Inference boundary normalizes scheduler-capacity and raw
`LocalLLMError` failures into one typed policy error before returning to an
application worker. Durable Content jobs therefore classify provider outages
from the shared failure reason instead of relying on one concrete error class.
Infrastructure-driven aborts are recorded as failed attempts/runs with their
exact infrastructure reason and remain fair-use exempt. Only a user-owned abort
is recorded as cancellation and charged after admission.
Provider cancellation is normalized across DOM/Undici aborts and installed SDK
abort classes such as OpenAI `APIUserAbortError`; it is terminal for provider
retry and retry waits, circuit-breaker accounting, every later one-shot fallback
hop, and approved structured cloud generation. OpenAI, Gemini, and Anthropic
receive the caller signal at their native SDK boundary and re-check it after
required usage settlement before an answer can be delivered.

Inference run IDs are always minted by the backend independently of operation,
request, idempotency, or client message IDs. Client-derived identifiers may
attribute stages to one visible operation, but they cannot select a ledger
primary key or overwrite an earlier attempt.

Ordinary Chat and non-Content generation has a hard 4,096-token output ceiling
for Pro, Max, and owner. Content sections use the plan ceiling: 5,120 for Pro
and 6,144 for Max/owner. Context values are ceilings selected by the compiler,
not padding targets; output is additionally bounded by remaining model context.

Signed Content Engine inference attribution includes a random token id, a
bounded per-operation category allowlist, and an encrypted proof-key envelope.
The primary script category is always present; deep mode may additionally
delegate only the named deep-search category. The proof key is transported to
Python separately from the token and MACs the exact normalized category, run
UUID, prompt/system hashes, options, skill, task, risk, execution class, and
schema. Numeric temperature is encoded as the exact normalized IEEE-754 value,
so Python and TypeScript cannot disagree on decimal tie-breaking. The backend
verifies that the callback category is in the signed
allowlist and then verifies that request proof before atomically consuming the
token/run pair in a bounded, expiry-aware SQLite nonce ledger shared by backend
instances. An intercepted token alone is therefore not sufficient to authorize
a different callback, and an exact callback cannot be replayed. Multiple stages
remain possible by using distinct backend-minted run UUIDs under one short-lived
signed operation. Invalid or expired attribution returns 403
`INTERNAL_INFERENCE_ATTRIBUTION_INVALID`; a valid grant used outside its
allowlist returns 403 `INTERNAL_INFERENCE_ATTRIBUTION_MISMATCH`. Neither is
reported as rate limiting, and both codes cross the Python Content boundary
without being rewritten as generic 500 responses. A legacy usage-attribution
token failure remains distinct as 403 `INTERNAL_ATTRIBUTION_INVALID`. The
inference token never represents cloud budget approval.
If the backend cannot mint or persist attribution, the request fails with typed
503 `LOCAL_INFERENCE_ATTRIBUTION_UNAVAILABLE` before crossing into Python; it
cannot fall through to the unsigned legacy cloud proxy.
The in-memory scheduler, emergency latch, and bounded request-evidence rings
still require one backend process for local routing. The attribution nonce
decision itself is durable and has no single-process coupling. Horizontal or
clustered local execution remains fail-closed until the remaining process-local
controls have shared implementations.

Completion telemetry is application-outcome evidence, not merely provider
transport evidence. A local stage that is discarded before delivery is marked
rejected; a successful bounded repair becomes the successful stage. If final
script validation, locale validation, recipe completeness, safety policy, or a
deterministic anti-claim rewrite withholds or materially replaces model output,
the affected stage or operation is excluded from local-success economics.
The final response locale guard is authoritative over predecessor byte-for-byte
compatibility: output in the wrong language is repaired, replaced, or withheld,
never shipped merely to preserve legacy model wording.

Cloud fallback is allowed only before a side effect, committed write,
user-visible partial answer, cancellation, refusal, or final publication.
Chat fallback uses the existing bounded cloud-allowlist packet and acquires the
existing cloud reservation at that exact boundary. Once a private request is
admitted to local-primary, it remains local-only unless a durable authenticated
redaction, destination, and escalation claim explicitly authorizes export.
Content rewrite/expand, Chat Content refinement, and Content specialist groups
remain private and local-only: invalid output or local failure is withheld and
reported instead of silently sending those payloads to a cloud provider.
Resumable script-job stages, including short Reel jobs, are the narrow
owner-approved exception. The 2026-08-21 data-classification decision declares
their generation packet
(topic, niche, creator-voice snapshot, supplied sources, outline, and prior
section ending) non-sensitive and permits raw transfer to the approved OpenAI
destination. The authenticated job sets `containsPrivateData=false` and
`allowCloudEscalation=true`; local remains primary, and every cloud attempt
must still pass the exact delivery-class provider/model/service-tier gate and
the serialized user/plan/run budget reservation. When routing is OFF or the
user is not enrolled, the existing independently authorized cloud path remains
unchanged.
Queue pressure alone never authorizes cloud spend. A queue-selected cloud path
must still carry an accepted allowlist packet and execute inside the owning
request's cloud-budget boundary; a missing or denied boundary returns the typed
degraded response and performs no provider call.
The provider abstraction also rejects any local-primary admission whose
configured primary is not Ollama; only the explicit force-cloud transition may
enter the approved cloud sentinel, so routing drift cannot bypass these gates.
An outer Chat fallback is eligible only after its authenticated scope resolves
to a persisted failed inference run. The recorder rechecks that failed state
inside an immediate transaction before appending cloud success, failure, or
cancellation to the same attempt ledger; cancellation marks the run
`cancelled` and is excluded from failed-fallback counts. Infrastructure-exempt
disconnect and account-deletion failures also remain permanently
fallback-ineligible after their transient fence or connection state clears. A
completed local or cloud run cannot be re-opened by an outer provider call.
Attempting to attach
cloud work after delivery or across tenant scope is blocked, persists a
critical incident, and turns local routing OFF.

Every local-to-cloud attempt is also bounded by the active plan's hard
per-run/per-day ceilings before provider dispatch: Pro `$0.15`/`$0.40`, Max
`$0.25`/`$0.60`, and owner `$2.00`/`$10.00`. The reservation ledger records
each concrete provider/model maximum under the inference run before the call,
so sequential retries and concurrent callbacks cannot race stale headroom.
These ceilings supplement rather than replace the existing daily/monthly cloud
allowance and privacy gate.

Critical tenant, secret, prompt-injection, confirmation, unsafe-output, and
post-delivery incidents are content-free. Incident persistence and
the audited routing transition to OFF commit in one immediate database
transaction; if either write fails, neither is accepted as durable evidence.
Equivalent incidents are deduplicated into five-minute buckets. The in-memory
waiting queue drains only after that transaction commits. If incident/OFF
persistence itself fails, a process-local emergency latch still makes all
subsequent runtime-control reads OFF and drains waiting work; an attended
restart is required after storage recovery, while the caller retains its
original typed policy error. While the latch is set, only a durable OFF
mutation is accepted, so a dormant reopening cannot activate after restart.

For Chat, an unfinished HTTP response or WebSocket message owns an abort signal
tied to the client connection. WebSocket deterministic action planning is also
account-admitted, while model-assisted planning and internet research receive
the combined client/account signal. Cancellation is checked before budget
acquisition, after provider selection, and immediately before and after the paid
provider call; the same signal is forwarded through the Unix transport, whose
gateway destroys the matching host-Ollama request when the backend disconnects,
and to every cloud SDK, including both approved-cloud Script Generation passes;
bounded structured retries recheck cancellation before dispatch. Cancellation
also covers WebSocket token-zero Secretary reads, locale-guarded legacy domain
handlers, router classification, tool-loop checkpoints, and response
persistence. The Python Content Engine's legacy cloud proxy owns one disconnect
signal for its full Gemini/OpenAI/Anthropic cascade and signed account
admission; provider retries, shadow scheduling, and delivery stop on that exact
reason. Errors are terminal rather than fallback-eligible. This
guarantees that Nexus does not initiate a new cloud attempt after observing
cancellation. The governed local Chat owner rethrows that same cancellation
without logging a policy failure, emitting a degraded answer, or invoking its
fallback callback. Classifier shadow comparisons use the provider-owned timeout
contract rather than an external timer that could masquerade as caller
cancellation. Nexus cannot revoke work already accepted by a provider: the
pinned Gemini SDK explicitly states that client abort does not cancel the
server operation and applicable usage may still be charged, so the budget
ledger must conservatively treat an already-dispatched request as a possible
bounded charge.

The REST turn lifecycle retains account-deletion admission through final
application validation and persistence; the synchronous Content script route
holds the same admission across Python generation, locale/safety validation,
artifact/workspace persistence, and public delivery. Direct script expand and
rewrite proposals likewise retain admission and client cancellation through
local or cloud generation, output validation, and response delivery. The
separately metered research-refresh tool holds the same boundary across its
bounded OpenAI/Gemini search cascade. A client disconnect aborts the Python,
edit-provider, or search request and no success response is emitted. The WebSocket lifecycle
retains client/account admission through the final frame. Its chunk writer
observes the same abort before the first chunk, between chunks, and after the
final pacing wait;
once a chunk is published, cancellation ends the stream without appending a
contradictory error frame. Content script shortcuts also propagate
disconnect cancellation across both service hops: FastAPI monitors the outer
client connection and cancels its HTTPX task, while the signed internal
`runId` request binds the backend inference signal to the Python connection.
Closing either hop therefore aborts queued or active local work and cannot
leave the sole generation slot occupied by an undeliverable request.
The shared account-admission boundary rejects an already-aborted caller before
invoking any local, legacy, or cloud callback; its post-callback check closes a
cancellation that arrives during final provider or application bookkeeping.
If cancellation wins after a provider result is durably recorded but before
the account-admission boundary returns it, the run is atomically reclassified
as failed for an infrastructure abort or cancelled for caller cancellation,
with `final_route = none`; its provider attempt remains only as diagnostic
evidence and the undelivered operation cannot count as a successful
user-visible local or cloud completion.

The shared Script Generation finalizer observes cancellation during local and
approved-cloud model passes, sandbox materialization, allowlisted validators,
and durable audit persistence. Validator child processes receive the same
signal. Cancellation removes only files and empty directories created by that
invocation; cleanup never recursively removes a pre-existing sandbox and never
converts cancellation into a validation result.

Explicit Chat script/refinement commands are recognized before the generic
local Chat answerer. The owning pipeline stage rejects high/destructive turns
before those shortcuts can relabel the request as low-risk Content. When local
Content is admitted, eligible turns retain the existing structured Content
response owner without a cloud-budget preflight; otherwise they continue to
the cloud-budgeted legacy owner instead of being downgraded to a short generic
answer.

Content specialist group calls are also local-only. The seven logical roles
remain four dependency groups, but the base local execution uses up to five
calls: Strategy+Research, Writer, Structural Editor+Factuality, Platform
Adapter, and Quality Reviewer. Splitting group 3 keeps every request within the
Pro 5,120-token output ceiling instead of silently clamping its three-role
contract. Split batches execute sequentially so one workflow cannot consume
multiple scheduler slots or queue behind itself. Each role keeps a separate
step, validation, proposal, and provenance record; invalid roles receive one
subset repair. Only inference runs whose output is rejected are invalidated in
the evidence ledger—accepted local roles remain truthful local outcomes when a
different role becomes package-derived. Unresolved roles receive explicit
package-derived output. The legacy seven-call cloud path remains
behind the default-OFF feature switch, so an owner may disable batching without
changing public workflow contracts.
Generated specialist runs become successful application evidence only after
the lease-fenced group transaction commits every role step and proposal. Lease
loss, cancellation, or a completion conflict rejects every local run whose
generated result that transaction discarded; earlier split batches are treated
the same if a later batch aborts before the group can checkpoint.
Operation-level rollout and pricing reports count a specialist job as locally
completed only when the durable job completed with exactly seven completed
steps and every step records `basis=provider_routed` and `provider=ollama`.
Package-derived roles therefore remain visible without overstating local share.

Every structured profile request must pair an allowed non-text `schemaId` with
the server-owned output schema used for validation. Plain-text requests must
use `schemaId=text` without an output schema. A mismatched pair fails before
admission or provider dispatch, so an internal caller cannot silently turn a
structured specialist contract into unvalidated text.

## 5. Durable long-form Content

`POST /api/v1/content/script-jobs` captures an encrypted immutable request,
including the creator-voice and supplied-source snapshots. Generation is
outline, sequential validated sections, deterministic assembly, and final
language/word-count/safety validation. Each section is encrypted and
checkpointed with `local` or `cloud` provenance; retry resumes after the last
valid checkpoint and cancellation never falls back. The completed job reports
`local`, `cloud`, or `mixed`, and exposes a model digest only for an all-local
result. An inference run is successful evidence only after its
lease-fenced encrypted checkpoint commits. If cancellation or lease loss wins
after generation but before that commit, every run contributing to the
discarded outline or section is marked as an application rejection and is
excluded from local-success and throughput acceptance metrics.

The additive public contract is:

| Route | Success contract |
| --- | --- |
| `POST /api/v1/content/script-jobs` | `202` for a new job, `200` for an idempotent replay. |
| `GET /api/v1/content/script-jobs/:jobId` | `200` for the authenticated tenant-owned job. |
| `POST /api/v1/content/script-jobs/:jobId/cancel` | `200`; queued/waiting work cancels and active local work is aborted without fallback. |
| `POST /api/v1/content/script-jobs/:jobId/retry` | `202`; resumes from validated checkpoints and remains idempotent. |

Views expose `queued | running | waiting_capacity | completed | failed |
cancelled`, stage, progress, warnings, status URL, route, model digest, and a
typed error code when present. `result` appears only after completed validation.
All reads and mutations are tenant/user scoped. Body and
`X-Idempotency-Key` values must match when both are supplied. Existing
synchronous Content routes remain compatible; their existing provider field
may now be `ollama` for enrolled local-primary work and must be treated as an
opaque additive provider value.

Final validation receives one automatic regenerative repair pass. A section
defect invalidates only that section's checkpoint and inference runs. A global
word-count or validation defect invalidates all dependent sections, while an
outline-owned title/hook defect also regenerates the outline. Language, URL,
and safety validation consume one explicit projection of model-authored fields:
script, hook, title options, caption, CTA, and hashtags. Authenticated source
titles, URLs, and relevance notes are immutable request echoes and are not
misclassified as generated defects; model-authored outline text is still
validated before it can direct section generation. URL matching checks each
trailing-punctuation boundary so a pinned URL that legitimately ends in `)` or
`,` remains valid. Language or safety failures regenerate the outline and all
dependent sections before the one bounded final retry. Repair prompts carry the
stored warning codes. Repeated URL, safety, language, or structural defects
fail the job. If the sole remaining defect after one full repair is the
15-minute word-count range, the complete artifact is published as reviewable with
`fifteen_minute_word_count_out_of_range` instead of being stranded.
The one-pass final-repair allowance is a durable job field, not a worker-local
counter. It survives capacity, transport, lease, and restart requeues, and is
reset only by an explicit user retry. Both the assembled artifact and the
public response projection run inside that same bounded repair contract.

The legacy synchronous API remains compatible. Updated clients should use jobs
for scripts longer than three minutes and standard/deep generation. A
15-minute script targets 1,900-2,400 spoken words and is never returned from an
unbounded single completion. The synchronous route remains fenced as one
account lifecycle so account deletion cannot race Python completion and recreate
source-package, workspace, or usage rows after erasure.

Privacy exports decrypt script requests, results, and checkpoints and remove
lease secrets. Inference exports contain scoped metadata only; prompts and
generated private content are never stored in inference telemetry. New script
artifacts use the content-specific v3 HKDF/AES-GCM envelope and authenticate
the schema plus derived key version as additional data. Predecessor v1/v2
envelopes and configured decrypt-only keys remain readable during rotation;
current and previous key material is trimmed and deduplicated before deriving
identity. If a retired historical key is unavailable, or no usable export key
is configured, the export preserves every readable record, replaces only the
unavailable encrypted fields with `null`, and returns a field-level
`CONTENT_SCRIPT_JOB_KEY_VERSION_UNAVAILABLE` or
`CONTENT_SCRIPT_JOB_ENCRYPTION_KEY_UNAVAILABLE` warning. Metadata mutations
that can be authenticated with a configured key, corrupt current-key
ciphertext, malformed envelopes, and inference-ledger query failures remain
hard export failures. Account
deletion first acquires a 15-minute durable, user-scoped inference fence,
aborts that user's active local and cloud provider controllers (including
pre-inference queue fallback, classifier, Secretary and other legacy domain
paths, detached classifier shadow, synchronous Content scripts and edit
proposals, metered research refresh, legacy Content specialist calls,
interactive and scheduled Training coach generation, every user-scoped
manifest-governed agent job, and every live WebSocket turn), rejects new model
or script-job admission, and waits for those boundaries to finish their usage
bookkeeping before erasure. The governed runner holds admission across private
input preparation, provider work, validation, persistence, usage settlement,
and notification; this includes scheduled Content inventory, channel learning,
Voice Evolution, and the Chat action fixer. A checkpointed legacy Chat timeout
keeps a nested admission until its detached provider/tool loop and late-result
or late-failure write settle. Training keeps successful coach cache/state
publication and scheduled conversation/report writes inside the same data-owner
and metering-actor admissions. The final transaction also inventories, removes,
and verifies every current user-keyed `api_cache` family without matching an
adjacent numeric user id. After the final
transaction removes both the user and fence rows, central model-work admission
still requires an active user row; stale JWTs and already-authenticated
WebSockets therefore cannot restart work, and the WebSocket is closed with an
account-unavailable code. A 30-second drain timeout fails deletion
safely with retryable 503 `ACCOUNT_DELETION_INFERENCE_DRAIN_TIMEOUT` while any
of these registered boundaries can still recreate usage rows. This guarantee
is intentionally limited to admission-registered inference surfaces; every new
user-attributed provider path must join the same registry before claiming
erasure-drain coverage. It marks unfinished script jobs
cancelled both before remote credential revocation and immediately before local
erasure, then cascades attempts/checkpoints through their owned parent rows.
The pre-delete counts for `skill_inference_attempts` and
`content_script_job_checkpoints` are included in the erasure receipt, and the
transaction verifies those captured child identities are absent after cascade.
The release topology has one backend process per environment; the durable row also
protects a restarted process. A new runtime takes over a prior runtime's fence
immediately because the predecessor can no longer own an in-memory controller;
same-runtime concurrent deletion receives 409
`ACCOUNT_DELETION_IN_PROGRESS`. Exact-token failure cleanup cannot clear
another deletion, and expiry remains the final malformed-row recovery bound.
Deleting the owner rows and fence in the same final transaction prevents late
publication or telemetry rehydration. Content-free critical safety incidents are retained
only after tenant, user, and run identifiers are irreversibly pseudonymized;
the deletion inventory declares that retained evidence. Environment-wide
runtime-control events are likewise retained operational security evidence;
they contain no prompt or generated content and are shown explicitly in the
account-deletion inventory.

Heartbeat or storage loss returns an active job to `waiting_capacity` without
fabricating user cancellation. A running lease whose heartbeat is stale for
three minutes is recovered before the 15-minute hard expiry; both recovery and
shutdown writes match the exact lease token. In-memory controllers and recovery
causes are also lease-generation keyed, so an old process cannot clear or forget
a replacement worker during release overlap. Capacity churn does not increment
the job's attempt count. Graceful process shutdown clears the recovery loop,
settles this process's active leases through the same bounded infrastructure
requeue counter and backoff ladder, and aborts provider calls. Startup/stale
lease recovery also aborts a matching in-process superseded worker with a typed
infrastructure reason. Shutdown waits a bounded five seconds for all aborted
workers to observe fencing. SQLite closes only if all workers settle; otherwise
the handle remains open until process termination and shutdown exits non-zero,
preventing a late worker from touching a deliberately closed database.
Recovery dispatches only one admitted durable job while the shared scheduler
is idle. It scans oldest-first past users outside the current canary cohort, so
an ineligible first page cannot starve an eligible job and rejected rows do not
need timestamp churn to maintain fairness. Create and retry only coalesce an
on-demand recovery kick; they never start their requested job directly or
bypass the durable restart-safe Max/Pro selector.

A waiting job is not rewritten on every recovery pass while routing remains
unavailable. A final completion update that loses its lease is also requeued as
`CONTENT_SCRIPT_JOB_LEASE_LOST` unless an explicit cancellation already won;
it never synthesizes a cancellation timestamp. A resumed claim starts at
`resume_checkpoint` with checkpoint-derived progress rather than briefly
reporting a fresh outline stage. Progress writes are monotonic, section
progress advances only after its encrypted checkpoint commits, and a capacity
wait preserves the highest durable progress without timestamp churn on
unchanged parked rows. Body and `X-Idempotency-Key` values may both be supplied
only when they match; ambiguity fails with `IDEMPOTENCY_CONFLICT` before work
is admitted. An omitted language hashes as a stable profile-default intent, so
an idempotent replay still returns the originally pinned request after a later
profile-language change. Explicit language remains part of the semantic hash.
Retries move the operation's fair-use admission timestamp into the current
rolling day, remain subject to active-job and daily allowances, and are capped
at two claimed generation attempts for one durable job. Recoverable capacity,
lease, heartbeat, and shutdown requeues restore the attempt because they did not
produce a usable generation attempt. Infrastructure requeues are separately
bounded to three consecutive failures: the first two wait 15 and 60 seconds,
and the third terminates with
`CONTENT_SCRIPT_INFRASTRUCTURE_RETRY_EXHAUSTED`. A validated checkpoint resets
that consecutive-infrastructure counter; explicit user retry also resets it.
Final-validation warning codes remain
visible on failed jobs. API cancellation settles the generating checkpoint and
clears the exact matching lease in one immediate transaction; the exiting
worker performs no unfenced post-cancel checkpoint write.
Checkpoint lifecycle rows record planned, generating, validated, invalid, and
cancelled states; only validated encrypted output is resumable.

Automatic historical pruning is intentionally not active in this changeset.
Deleting completed encrypted scripts or operational evidence is irreversible
and requires an owner-approved product retention schedule, including customer
history expectations and legal/security evidence periods. Public activation
must record that decision and then add a separately reviewed lifecycle
transaction; account deletion remains immediate and complete regardless.

## 6. Observability and rollback

Owner/admin `GET /api/v1/admin/local-inference/summary` reports bounded-window
provider/workload baseline completions, fallback-tagged calls, active-user
counts, Content script validation, specialist-job outcomes, local share,
eligible fallback, script share, rejection/fallback reasons, queue and latency
percentiles, throughput, actual cloud/tool spend, counterfactual estimated
spend, plan counts, current process capacity, and a live gateway/model health
probe with expected and observed signed-model identity. The baseline is
aggregate only and contains no user ids, prompts, or generated content.
Counterfactual values are always labelled estimates.
All reported percentiles use the nearest-rank convention: sort the samples and
select rank `ceil(sample_count * fraction)`, clamped to the observed range.
The model probe fails independently: an unavailable or misconfigured provider
is reported as degraded without hiding the aggregate summary needed to diagnose
the outage. A missing/corrupt manifest also leaves aggregate reporting
available while forcing model-digest stability and pricing proof to fail.
Detached shadow comparisons are excluded from every production completion,
fallback, and pricing-proof denominator.
Cancelled cloud attempts remain visible in total fallback-attempt/rate telemetry
but are excluded from the fallback-reliability sample and its 99% rollback gate.
Text timestamps are compared through SQLite date normalization, so ISO `T/Z`
writers and predecessor SQLite-space timestamps share the same reporting
window. Numeric epoch fields retain their numeric comparison contract.

The application monitor turns mode OFF when a meaningful window breaches the
95% local-success, 15% eligible-fallback, 99% fallback-success, 99% structured
schema-validity, 12-second first-token, 45-second ordinary-Chat total, 4
token/second script, 12-minute script-job p95, 5% non-AI latency-regression,
0.5-percentage-point public 5xx-regression, 6GB host-headroom, or zero-swap
threshold. Explicit cross-tenant, secret-exposure, prompt/confirmation bypass,
post-delivery fallback, or escaped unsafe-output evidence
is persisted as a typed, content-free incident and turns routing OFF
immediately. Post-delivery fallback and cross-scope attempt attachment have
concrete producers in the inference boundary. Local action proposals remain
ineligible, so no side-effect-fallback incident code is declared until a
corresponding action guard and producer ship together. A safety validator
successfully withholding an answer is a quality rejection, not an escaped
safety incident. Every owner and
monitor mutation writes `local_inference_control_events` with actor, reason,
and evidence reference. A transient owner-bootstrap lookup failure cannot
block automatic rollback: the monitor reuses the durable last-authorized actor
when available. If both identities are unavailable, a system-monitor event
with a null user actor remains valid so the safety action still reaches OFF.
Manifest unavailability or runtime-contract drift (manifest version, selected
digest, or profile version) turns routing OFF immediately, including during
shadow, rather than appearing as passing host health or preserving an obsolete
stability clock. Observed specialist-profile or successful-local model-digest
drift remains a separate automatic rollback signal; aggregate availability
cannot mask either class of evidence.

The backend reads `/proc/meminfo` for an immediate host-view headroom and swap
guard and keeps bounded process-local request evidence for non-AI latency and
public 5xx regression. Production captures at least 20 baseline samples for
each metric at the OFF-to-shadow boundary, before shadow inference can affect
the host. The boundary rejects an outage-poisoned baseline above 2 seconds
non-AI p95 or 2% public 5xx. Those baselines are immutable through
canary/active and clear only
on rollback to OFF. Rollback waits for at least 20 current samples. A backend
restart starts a fresh current sample window; it does not invent missing
evidence. The attended host/cgroup receipt and host
observability remain authoritative for the sustained 20GB/zero-swap envelope,
model residency, and production acceptance.

Ordinary-Chat first-token, Chat total-duration, script-throughput, and
script-job-duration thresholds each require at least 20 actual measurements,
not merely 20 eligible operations. SQLite timestamps without an explicit zone
are interpreted as UTC. Production `/proc/meminfo` unavailability fails the
host guard closed rather than silently removing memory/swap evidence.

Changing mode to OFF rejects waiting in-memory interactive requests, prevents
new local admission, and lets the one already-active generation reach its
normal response boundary. Durable script work is checkpointed and returned to
`waiting_capacity` at the next governed stage. This avoids corrupting an
active Ollama response while still draining the local queue deterministically.

## 7. Model and pricing gates

`npm run local:model-first-pass -- --candidate-id <signed-manifest-id>
--output <private-artifact.json>` is the bounded screening runner from the
approved production plan. It runs exactly 24 synthetic cases: four for each of
the six internal specialist profiles (supporting five user-facing skills,
because Training owns the Triathlon profile) and eight for each of English,
PT-BR, and PT-PT. The
corpus includes compact structured extraction, safety refusal, and
cross-tenant refusal cases. Run it only through the attended candidate
benchmark envelope and keep its raw-response artifact in an owner-only ignored
operator directory. The runner resolves the installed model's exact Ollama
digest, streams the local API to measure user-visible first-token latency,
samples Ollama cgroup memory plus host headroom/swap, and emits deterministic
screening scores. Every manifest entry must pin the exact installed SHA-256
digest before a run; conditional/null digest binding is invalid. Per-candidate
reasoning mode is required signed-manifest data: the validator and runtime
parser accept exactly `false` or `"low"`, preserve it on the parsed candidate,
and copy it into the artifact. The screening runner must build its system
prompt from the same governed skill-profile policy artifact used by production
inference and must record that artifact's SHA-256 digest. A benchmark-only
refusal prompt or evaluator relaxation cannot qualify a model. Strict JSON
rejects duplicate keys at every object depth. Structured action mismatch is
reported separately from semantic safety/tenant refusal failures, and refusal
cases use positive refusal-language checks plus explicit prohibited-leakage
phrases across both answer prose and structured data. An
incomplete or duplicate corpus has a null score, never a partial numeric score;
empty runtime samples report headroom and swap as unavailable rather than zero.
The temporary 24GB benchmark ceiling prevents an attended
evaluation from failing before memory can be measured; it never relaxes the
20GB production-eligibility ceiling. A screening result is not final qualification, winner
selection, license approval, or production activation; it only selects the
challengers that may proceed to the full blind-paired corpus below.

When only deterministic evaluator logic or corpus acceptance terms change,
preserve the immutable raw artifact and run
`npm run local:model-first-pass -- --rescore-artifact <raw-artifact.json>
--output <new-private-artifact.json>`. The derived artifact revalidates every
prompt/response digest, requires the raw artifact's governed profile version
and policy SHA-256 to match the current runner, pins the source artifact and
source runner digest, recomputes every evaluation with the current
runner/corpus/manifest, and never claims that generation was repeated. A
profile or prompt-policy change always requires a fresh attended run and cannot
use the rescore path. Raw v3 artifacts attest the generation-time policy and
reasoning mode; legacy v1/v2 artifacts remain historical evidence but cannot be
rescored by the current runner. A rescore cannot qualify a model whose raw run
was incomplete or whose digest is not pinned by the current manifest.

`npm run local:model-bakeoff -- --observations <sanitized.json>` applies the
locked 35/30/15/10/10 score and all disqualification gates to the finalists
that survived the bounded screening pass. The sanitized-v1 evidence contract
and v4 report bind every case to the exact normalized model digest and
specialist-profile version, reject mixed identity inside a candidate run, and report empty
percentile sets as unavailable rather than zero. The focused final pass uses
medium skill tasks, Content outlines/sections, tool plans, and at least 100
compact structured-schema cases. It does not generate a separate complete
15-minute script for each local candidate. Complete-script evidence belongs to
the single ten-script product acceptance inventory below and is shared by
quality, delivery, and economics checks. The tool does not select or pull a
model. Selection requires the production VPS observations, license review,
signed digest, applicable blind-paired evidence, and an owner-reviewed manifest
change. A challenger that fails a critical screening gate cannot enter the
final pass. When every challenger is screening-disqualified, the reviewed
retention report may keep the digest-pinned Qwen control for only the
quality-approved lightweight workloads defined by the canonical plan. The
production-selected manifest structurally requires the winning
candidate ID, a digest of the bakeoff report, and host rollback-receipt digest, corpus,
legal-review, and owner-approval references;
host-side install/socket transactions independently reject a selected winner
that omits those bindings. Runtime/evaluation model environment values may
only repeat the active
manifest tag; stale overrides are rejected instead of superseding the signed
manifest.

The executable final-pass producer is:

```bash
npm run local:model-final-pass -- \
  --candidate-id <signed-manifest-id> \
  --output <owner-only-raw-artifact.json>

npm run local:model-final-pass -- --sanitize-pair \
  --challenger-artifact <owner-only-challenger.json> \
  --control-artifact <owner-only-qwen-control.json> \
  --output <owner-only-sanitized.json>

npm run local:model-bakeoff -- \
  --observations <owner-only-sanitized.json> \
  --challenger-artifact <owner-only-challenger.json> \
  --control-artifact <owner-only-qwen-control.json>
```

It expands the reviewed corpus reference into exactly six ordinary cases, six
Content outline/section samples, and 100 compact structured cases. Both raw
runs must bind the same manifest, corpus, governed profile policy, runner, and
112 unique case IDs. Sanitization re-hashes every prompt and response and
recomputes the rubric; raw model text is never copied into the sanitized artifact
or report. The scorer requires both raw files, invokes the current producer to
re-sanitize them in an owner-only temporary directory, and rejects any byte-level
claim difference after canonical JSON normalization. A hand-edited sanitized file
therefore cannot qualify a model. The scorer accepts this strict digest-locked
evidence chain, not free-form observation JSONL.
The identity-blind focused comparison covers the 12 ordinary/Content pairs;
compact structured cases separately own the schema gate. A challenger must
score at least 75, win at least 60% of those focused pairs, and either beat
Qwen by eight points or remain within 5% of independently approved cloud
evidence. It must also preserve every critical skill within 5% of Qwen. Missing
Qwen pairs or missing cloud evidence cannot satisfy the corresponding branch.
The cloud branch additionally requires `--approved-cloud-evidence`, its exact
independently reviewed `--approved-cloud-evidence-digest`, and a separate
`--approved-cloud-approval-evidence-digest`. The strict cloud artifact is joined
against all 112 canonical case IDs and binds provider, model, corpus, profile,
approval reference, approval status, the exact challenger ID/model/raw artifact,
the exact local sanitized artifact, and per-case quality deltas. Partial,
duplicate, alternate-corpus, digest-only, or unapproved cloud claims fail closed.

Target Pro `$9.99` and Max `$14.99` prices use the canonical pre-release gate:
actual provider-account rates, the ten measured complete scripts, existing
usage data, conservative simulations, at least 80% blended contribution margin,
and at least 80% web-subscription contribution margin. Apple is reported
separately under the canonical 70-75% initial floor. The former 30-day,
500-completion, 100-script, tester-day, and percentage-cohort launch gates are
retired and must not block activation.

The ten complete scripts are a global acceptance budget, not a per-model or
per-provider allowance: four Standard, three Scheduled, and three Priority,
split five PT-BR and five English. Nine may be generated in the release-bound
pre-activation verification state and one after signed deployment as the
production smoke. Every script must be complete, source-consistent, carry no
critical warning, and contain 1,900-2,400 words. The same immutable inventory
supplies p95 tokens, quality, continuation, notification, final-artifact, and
economics evidence. Compact structured tests own the 99% schema gate without
spending the long-form budget. Reporting never decrypts customer requests merely
to classify acceptance evidence.

Production activation is one audited owner transition from OFF (or optional
zero-user shadow) to active/100% after the signed release, model/gateway checks,
ten-script/economics evidence, and safety baselines pass. Percentage canaries
and timed stability windows are not launch prerequisites. Independent kill
switches and automatic rollback remain mandatory. The owner plan API continues
to bound every local-operation, context, script, active-job, queue-weight, and
local-to-cloud cost-cap field; partial owner updates are merged with the durable
plan before validation.

### Apple OS-provided device-model appendix

Apple Foundation Models is a separately governed device lane, not a manifest
candidate and not evidence that the VPS local-primary route qualified. Apple
does not expose a stable model digest. Its immutable run identity is therefore
the tuple recorded by the client and server: device hardware identifier, OS
version/build, Foundation Models framework availability, locale, and the
server policy version. No prompt or model output crosses this evidence
boundary.

The server remains the sole routing authority through authenticated
`/api/v1/device-inference` policy, admission, settlement, and evidence
contracts. Policy `apple-foundation-models.v1` defaults OFF, is narrowed by the
dedicated environment and durable kill switches, and declares a closed list of
eligible operations. Credit-bearing standard responses reserve on the server
before device execution and capture only after successful settlement. Local
parse/summarize of already-local content is zero-credit. Deep reasoning,
scripts, commerce, tool execution, and every write remain ineligible; any
unavailable or failed device run falls through to the existing server route.

The attended acceptance is
`FoundationModelsPhysicalBakeoffTests/testFoundationModelsAgainstCanonical24CaseCorpus`
in the iOS repository. It is opt-in through
`NEXUS_FOUNDATION_MODELS_PHYSICAL_BAKEOFF=1`, refuses the simulator, attaches a
private JSON result to the `.xcresult`, and runs exactly the byte-identical
24-case corpus whose SHA-256 is
`da1156ee2a61c3c9511518973312ff390c7eda992b6c36fe867c30969f8e926c`.
Activation requires 24 unique observations on eligible physical hardware,
zero structured-schema/action/safety/tenant failures, and all eight PT-BR
cases passing their language and required-term checks. A skipped test or an
unavailable-model result is not acceptance evidence.

Device telemetry is immutable to ordinary updates but remains deletable by
the bounded retention and Article 17 account-erasure paths. Subject access
exports the scoped admission/runtime metadata, including the one-way request
digest, but never a prompt or response. Activation additionally requires the
ordinary signed backend/iOS releases and runtime flags; this appendix cannot
authorize a flag change by itself.

## 8. External completion evidence

Repository completeness does not prove production readiness. The checked-in
manifest remains `control_only`, so production canary/active admission is
intentionally impossible until the owner supplies the VPS bakeoff and pinned
winner plus license approval. The production gateway service/socket mount is
also intentionally absent until the attended host transaction creates and
verifies the environment-specific socket directories and the
20GB/8-CPU/zero-swap service envelope; only then may a normal protected-main
change add the signed Compose topology.

Public activation additionally requires iOS async-job adoption, live billing
verification, the global ten-script acceptance inventory, and the canonical
pre-release economics simulation. Public Chat routes and `legacy-tail` responsibilities remain
supported because their independent retirement evidence does not yet exist.
An owner-approved historical-retention schedule and its reviewed pruning
transaction are also required before public activation; this repository does
not infer authorization to irreversibly delete completed customer artifacts.

Raw private Content cloud fallback remains intentionally unavailable. Content
refinement and specialist groups cannot add it until Nexus has an
authenticated, payload-specific contract that proves the outbound text was
redacted, names the approved destination, and records the user's escalation
authority before any provider call. Resumable script-job generation, including
short Reel jobs, is not
classified as private under the owner-approved 2026-08-21 policy and may use
only its delivery-bound, budgeted OpenAI fallback described in §4; routing OFF
still preserves the independently authorized legacy cloud path.

The actual candidate download, VPS bakeoff, benchmark/socket receipts,
production Compose gateway addition, iOS release, rollout observations, and
billing transactions require owner-controlled systems outside this worktree.
None of that evidence can be truthfully fabricated by repository code.
