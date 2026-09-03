# Nexus Hub Content Creation — Adaptation Guide

## Purpose

Use this guide when adapting Content Creation behavior across prompts, agents,
orchestration, and user-facing read models. It records contract boundaries; it
is not a backlog, a release claim, or a substitute for the canonical skill and
API documentation.

## Canonical Sources

Read the closest owning source before changing behavior:

- Skill capability and safety contract: `knowledge/skills/content-creation-SKILL.md`
- Runtime skill configuration: `src/skills/content/manifest.json`
- Runtime prompt: `src/skills/content/prompts/system.md`
- Canonical content records and workflow: `src/services/content-workspace.ts`
- Deadline and private-work scheduling semantics:
  `src/services/content-workspace-scheduling.ts`
- Content mesh projection: `src/services/cross-agent-learning/content-mesh-context.ts`
- Weekly and daily plan projection: `src/services/weekly-plan-orchestrator.ts` and
  `src/services/daily-brief-orchestrator.ts`
- Home and chat read models: `src/services/content-home-view-state.ts` and
  `src/services/chat-core-v2/deterministic-read/content-pipeline-route.ts`

Legacy topic fields are compatibility projections. Do not promote them above
the canonical workspace, workflow events, or Secretary scheduling authority.

## Adaptation Rules

### Research and sources

- Use the configured research providers and source policy rather than assuming
  a particular browser, screenshot, or transcript tool is always available.
- Preserve source URLs, provenance, and uncertainty. Never invent quotations,
  metrics, trend evidence, or current platform behavior.
- Treat `source_bound` as source-ID reconciliation only, never as entailment,
  accuracy, or reviewer verification. Generated claims remain reviewable.
- Keep compact source summaries out of claim fields. Until exact per-claim
  source IDs are modeled, research artifacts expose an empty claim array and
  unavailable `CONTENT_CLAIM_SOURCE_BINDING_NOT_MODELED` binding, including
  for legacy rows.
- Treat every retrieved summary and repurpose draft as untrusted data inside
  explicit delimiters. Client-authored source summaries must not cross a
  server-authored source-package boundary.
- Keep policy routing distinct from observed execution. Publish package IDs,
  research artifact IDs, reuse state, and Voice Card versions only from the
  authoritative scoped artifact boundary, never from an engine-generated
  placeholder or an in-memory summary.
- Treat platform-specific guidance as current only when it comes from fresh
  authoritative evidence. Do not hard-code fixed durations, hook timings,
  upload cadences, trending sounds, or platform folklore as permanent truth.
- Preserve the legacy research-result `score.virality` key only as a
  source-cohort-normalized observed engagement signal. Raw views, votes,
  comments, sensational wording, and missing data score zero; the field is not
  a prediction of future reach, virality, or ranking.

### Workspace and publication

- A workspace deadline is a target date with semantics
  `target_date_not_publication`.
- A ready script, recommendation, deadline, or `publish_ready` hint is not proof
  of publication and is not a promise to ship.
- Publication tracking is not implemented. Public read models expose nullable
  publication metrics and `publicationTracking.availability: unavailable`
  with `CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED`; never replace unavailable
  with zero, success, or an inferred `published` stage.
- The portal performance aggregate keeps `topics.publishedLast30d` null, and
  artifact-chain compatibility keeps `pipeline.publishedAt` null. Both expose
  unavailable/not-supported tracking even when an internal workspace state is
  named `published`.
- Workspace operations metrics translate legacy storage counters into
  `internal_scheduled_state_or_confirmed_work_block` and
  `internal_workflow_published_state`, and attach unavailable external
  publication tracking. The legacy storage names are never an API claim.
- Proposal and scheduling paths report `publicationExecution: not_performed`;
  tracking capability reports `publicationExecution: not_supported`.
- Content Engine reports expose `outcomes_logged` for scoped user-reported
  evidence. `videos_published` remains null and `publication_tracking` remains
  unavailable/not-supported; a report must not relabel outcome rows as posts.

### Scheduling authority

- Secretary owns calendar placement, reflow, cancellation, and provider-sync
  truth.
- Treat every canonical schedule-preview window, optional scheduling deadline,
  selected slot, calendar bound, and internal scheduling clock override as an
  absolute instant: require seconds plus `Z` or an explicit numeric timezone
  offset, normalize accepted values to UTC, and reject offset-less input or
  malformed Secretary preview windows.
- Canonical cancellation commits an idempotent
  `content.schedule_signal_reconciliation.requested.v1` event before returning
  and immediately attempts strict dismissal of scoped `shoot_day_locked`
  logically active signals. If enqueue fails, return
  `CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_QUEUE_UNAVAILABLE` and roll back the
  local binding update while reporting that Secretary cancellation may already
  have committed; invalidate planning caches before returning it. If the
  derived-signal read or dismissal is unavailable,
  invalidate planning caches before returning
  `503 CONTENT_SCHEDULE_SIGNAL_RECONCILIATION_UNAVAILABLE` with
  `canonicalCancellationCommitted:true` and `recovery:retry_cancellation`.
  The durable cancellation/outbox event remain authoritative, and replaying
  the same key safely retries reconciliation and cache invalidation.
- Topic-generation helpers reject non-integer, negative, or over-limit requested
  batch counts before provider or persistence work; they never clamp caller
  intent into a different successful batch.
- Persist derived mesh signals only for the authoritative current week.
  Historical and future recomputes use in-memory drafts and never reconcile
  current-week rows.
- Only a current Secretary-confirmed Content work block in `scheduled`,
  `provider_synced`, or `sync_failed` state is protected. `sync_failed` means
  the local Secretary block remains confirmed while provider sync separately
  needs attention. Its semantics are
  `private_work_session`, not publication.
- Filming recommendations, focus-window matches, and next-execution hints are
  proposals until Secretary confirms a private work block.
- Propagate both authority status (`current`, `partially_unavailable`, or
  `unavailable`) and plan status (`confirmed`, `proposed`, `unplanned`,
  `partial`, or `unavailable`). Current authority with zero confirmed blocks is
  `unplanned`, not `confirmed`. Cancellation/provider attention without an
  actionable recommendation remains `unplanned`; it is not a proposal.
- Never derive an implicit filming window from a deadline or reserve time by
  subtracting a fixed number of days from a target date.

### Cross-skill orchestration

- Share only the minimum typed facts needed by the receiving skill.
- Confirmed private work blocks may appear as non-negotiable schedule facts.
  Preserve every current confirmed block for the date in `confirmedBlocks`; the
  legacy `blockStart`/`blockEnd` pair is only the earliest-block summary. Carry
  item status, planned work-kind outcome, estimated effort, dependency,
  approval state, and next action from the canonical calendar. When the
  calendar has no prerequisite field, dependency is null; never duplicate the
  next action into outcome or dependency. If its bounded read reports `hasMore`,
  mark the projection partial with `confirmedBlocksComplete: false` instead of
  implying the returned list is complete.
  Deadlines belong in advisory notes or preferred targets; recommendations
  remain proposals.
- Emit `shoot_day_locked` only for a current Secretary-confirmed block whose
  canonical work kind is `record` (filming). The coordination payload may label
  that work kind `filming`; other confirmed Content work remains protected
  through the canonical work-schedule projection without being relabelled as a
  shoot day.
- Sponsor and external-deliverable notices are factual constraints. Without
  explicit publication authority they do not authorize publishing, create a
  shipping action, or reserve calendar time.
- Emit a sponsor-due signal only when the notice contains explicit due/deadline
  language or a parseable due-date field. A generic brand, partnership, or
  deliverable mention is not deadline evidence. Place the resulting attention
  on a plan day only when the trusted editorial signal carries a finite
  `dueAt`; preserve an explicit source zone when deriving that date, and leave
  undated notices unplaced.
- Training, Cooking, and Finance may influence workload or execution guidance,
  but they do not gain authority to schedule, cancel, publish, or change Content
  state.
- When a confirmed block conflicts with another obligation, ask Secretary to
  reconcile it. Do not silently move the block or invent a replacement slot.

### Agents and model routing

- Agents may rank, explain, and propose. They must not convert confidence into
  calendar authority or publication evidence.
- Use the repository's provider-routing and entitlement abstractions. Do not
  encode a transient model name as permanent skill truth.
- Keep prompts outcome-first and pass structured, allowlisted context rather
  than raw private calendar, inbox, health, or finance records.
- Performance Intel, Reaction Radar, and SEO Tracking are paused. Historical
  unsafe bodies are removed or reduced to compatibility shells; reactivation
  requires a tenant-user rebuild of inputs, storage, signals, identity,
  cancellation, quota attribution, and bounded scheduling, not a manifest edit.
- While Reaction Radar is paused, feedback and workspace-action POSTs reject
  with `CONTENT_AGENT_PAUSED`. Read/delete access to legacy feedback remains
  available only for audit and revocation.
- Specialist cancellation commits terminal private job state before aborting
  the matching lease-bound active controller. An observed cancellation cannot
  be followed by a package fallback, proposal checkpoint, or completion.
  Completed/failed jobs return `409 CONTENT_AGENT_JOB_TERMINAL`; exact replay
  is safe. API-usage persistence failure is never a specialist fallback: it
  returns stable `429 SERVICE_DEGRADED` with `Retry-After`.
- A rejected local-primary grouped specialist run contributes no applied
  sibling outputs. Its single semantic repair regenerates the complete bounded
  group; an incomplete repair is rejected as a whole before package fallback.

### Creative and script generation

- The five `/api/v1/content/creative/*` operations and their explicit slash
  commands produce proposals only. They do not save, accept, schedule, or
  publish. `sourceSummary` is server-authored and rejected in those public
  requests.
- Treat creative length and count limits as bounded operation contracts, never
  ranking advice. Hook `trigger_type` is a compatibility label for distinct
  opening mechanisms, not a virality prediction, and there is no universal
  hook word count or three-second window. YouTube/Instagram title maxima of
  100/80 characters are hard response bounds rather than ideal ranges;
  thumbnail overlay length follows the supplied layout within its bounded
  string schema rather than a universal word count.
- Captions require non-empty text but may use any clear line structure, an
  optional CTA, and zero to 20 unique evidence/profile-grounded hashtags.
  Repurpose returns one to ten distinct proposals from the canonical
  format/platform pairs without a quota. Because its request has no cadence
  authority, the current prompt returns `posting_delay: "unspecified"`;
  bounded relative values remain compatibility metadata only and never create
  a work schedule or publication action.
- Preserve `structuredOutput.firstThreeSeconds` as a legacy field name for the
  opening beat or first line. Render ordinal short-form beats unless explicit
  request timing exists; the field name itself is not a timing requirement.
- Resolve time-sensitive proposals through a current, exact tenant-user source
  package. Reject foreign or topic-mismatched packages; never reuse expired or
  empty context, and obtain a fresh exact-scope package or fail visibly before
  creative-provider work. A fresh-research result with `degraded: true` returns
  `503 CONTENT_RESEARCH_UNAVAILABLE` before any evidence is marked or persisted
  as fresh and before creative generation. Unsupported and high-risk contexts
  fail closed.
- High-risk generation remains unavailable until reviewer-attested package
  authority exists. A client acknowledgement, deep mode, or source attachment
  does not satisfy that authority.
- Synchronous scripts classify topic, niche, hook, why-now, and angle. Research
  refresh classifies topic plus the existing script. Rewrite/expand classify
  topic, script, instruction, and validated/whitespace-normalized source
  summary. Async jobs classify topic and niche before durable admission.
- Edit source summaries reject non-arrays, non-string entries, more than five
  entries, normalized entries over 220 characters, and unsupported controls;
  whitespace-only entries normalize away, but no non-empty entry is silently
  shortened or truncated.
- Edit and refresh bounded text fields reject explicit non-string values rather
  than treating them as absent. An empty cloud-provider edit or a refresh with
  no usable source summary preserves the original, emits a locale-specific
  warning, and sets `degraded: true`. Governed local-primary empty edit output
  instead returns typed `502 INFERENCE_EMPTY_OUTPUT` without mutation; all
  other local edit failures use the closed, sanitized public error map.
- Async jobs accept only one of `sources` or `sourceContext`, with at most 20
  well-formed entries and 500/2,000/120/1,500-character limits for
  title/URL/source type/relevance. A source lacking a non-empty title, HTTP(S)
  URL, or relevance note, alias conflicts, credential-bearing/invalid URLs,
  controls, oversize, and overfill fail before the pinned snapshot is hashed;
  entries are never silently skipped or truncated.
- Require JSON-object script bodies. Explicit null, empty, wrong-case,
  wrong-type, and unsupported selectors, durations, booleans, and idempotency
  fields fail rather than selecting defaults. YouTube permits only 8/10/15
  minutes or 480/600/900 seconds; Reel permits only one minute or 15/30/45/60
  seconds. Both duration fields must be valid when supplied, and seconds take
  precedence. The internal workflow helper accepts the same format-bound
  seconds control; its compatibility defaults are draft budgets rather than
  claims about ideal platform length. Only synchronous generation accepts the documented `style`
  alias; asynchronous jobs accept `scriptStyle` and reject `style`.
- Script metadata hashtags are optional. Preserve valid evidence/profile-
  grounded tags or an empty list; degraded and metadata-recovery paths never
  invent generic or allegedly trending fallback tags.
- Async creation/retry reserves credits in the same caller transaction as the
  queued job state. Completion captures the newest open job reservation in the same
  transaction as terminal success. Cancellation and failure release it in the
  same transaction as terminal state; release failure returns
  `CONTENT_SCRIPT_CREDIT_SETTLEMENT_FAILED` and leaves the job non-terminal.
- Reject unsupported C0/C1 controls in script semantic input, idempotency keys,
  and pinned source text before those values reach prompts, logs, or providers;
  bounded existing scripts may retain ordinary formatting whitespace.
- Keep edit responses proposed and unapplied. Preserve the original script on
  research or locale failure. Malformed creative JSON is withheld; never emit
  raw or partial provider output as a valid artifact.
- Reject unsupported C0/C1 controls at creative REST and slash-command
  boundaries. REST and `/repurpose` chat `sourceContent` may retain normal
  formatting tabs/newlines; the other four creative slash commands are
  single-line and may not. A recognized malformed creative slash command
  terminates with `CONTENT_CREATIVE_SHORTCUT_VALIDATION_FAILED`; it never
  falls through to generic chat routing or provider work.
- REST creative locale comes from `x-language` when present, otherwise the
  authenticated user's saved preference. A recognized trailing slash-command
  qualifier explicitly selects `pt-PT`, `pt-BR`, or `en-US` and is removed
  from the semantic subject. Never infer a dialect from content or identity.
- Validate hook text/reasons/SFX/edit cues, title text/reasons, caption text/hashtags,
  thumbnail main text/reasons/additional elements, and repurpose content/notes
  against the selected locale. Apply the same guard to generated deep/reaction
  briefs, trending/news angles, competitor/gap/SEO and feedback analysis,
  reports, and provider warning prose. Keep `pt-PT` and `pt-BR` distinct; the
  REST creative mismatch message follows that selection. Do not treat closed
  enums or structural selectors as localized prose; thumbnail background and
  overlay colors are strict `#RRGGBB`, font style and position use bounded
  allowlists, and facial expression is a closed contract enum.
- Synchronous script `language` overrides header/profile choice, while
  edit/refresh use the
  header-or-profile locale and async jobs bind either the normalized explicit
  locale or a `profile_default` intent marker into their request identity.
- Localize edit action labels by dialect: `pt-BR` uses `roteiro`/`pesquisa`,
  while `pt-PT` uses `guião`/`investigação`.
- Propagate request cancellation through the TypeScript and Python boundaries.
  Cloud edits carry explicit private-data authorization and zero provider
  retries. Content edits, specialist generations, and topic-generation routes
  allow configuration fallback only before a provider attempt; once a call is
  attempted, an ambiguous failure is terminal. Do not automatically repeat
  ambiguous cost-bearing transport failures without a durable replay contract.
  Research refresh sets provider
  retries to zero and allows cross-provider selection only after deterministic
  pre-call headroom denial, never after an attempted provider call with an
  ambiguous outcome.

### Identity and private references

- Empty or archived creator profiles stay neutral. PUT reactivates the scoped
  singleton; PUT and DELETE invalidate Content-derived caches and summaries.
  PUT is a strict non-empty partial update over the documented writable fields;
  unknown properties, nulls, wrong types, empty list entries, oversized values,
  and overfilled arrays return `CONTENT_CREATOR_PROFILE_INVALID`. Malformed
  active stored rows or unavailable pre-read/write/readback/archive boundaries
  return `CONTENT_CREATOR_PROFILE_UNAVAILABLE`; they never become an empty
  profile or a reported successful mutation.
- Public API Books, Channels, Voice DNA/reference data, and topic feedback are
  active `user_private` data with an exact authenticated tenant-owner match.
  Platform, shared, foreign, quarantined, and inactive rows are not fallbacks.
- Strict Voice DNA/knowledge reads validate persisted scalar and source-array
  shapes. Public Voice DNA returns `CONTENT_KNOWLEDGE_UNAVAILABLE` instead of
  confirmed empty when storage or row shape is unavailable; Home marks the
  section partial and Intelligence returns its typed unavailable response.
- Decision-visible signal reads require active status and `expires_at` later
  than the read time. A logically expired row is excluded immediately; periodic
  cleanup is not a prerequisite for hiding it from Content decisions.
- Missing book/channel seed configuration means no seeds. Migration 303 retires
  the exact historical global defaults and their derived global signals or
  knowledge while preserving tenant-user rows and rollback metadata. For
  legacy channel-DNA signals, matching channel IDs are authoritative when both
  sides provide them; display-name fallback is allowed only when either ID is
  unavailable. Book extraction fails before persistence/signal emission when
  no usable sources remain, provider output is invalid, or policy authority is
  absent. Partial research-query failure with usable evidence may persist only with
  `degraded: true` and the bounded `research_source_unavailable` warning;
  channel inference never retries or switches provider after an attempted
  ambiguous failure.
- Topic generation uses only saved pillar/niche labels. Match case-
  insensitively, return the saved canonical casing, use only `uncategorized`
  during cold start, and keep `pillar_emoji` empty until an explicit mapping
  exists.
- Live discovery accepts bounded per-run controls for one to ten main ideas,
  zero to five optional quick-fire ideas, and a one-to-168-hour freshness
  window (compatibility defaults: 8, 3, and 48). They are batch/search bounds,
  not publishing cadence or platform-performance rules; stop early instead of
  padding unsupported ideas.

### Content Agency evidence and replay

- The current immutable package contract is `content-agency-package.v3`.
  Creation persists the package and bundle artifacts only as authenticated
  `user_private` data. It returns `201` with `mutation.created:true`; an exact
  package replay verifies and returns stored truth with `200`, `created:false`,
  and `replayed:true`. Score and handoff reject integrity-valid legacy package
  versions until regeneration; GET remains the compatibility read boundary.
- Package `sourceTrace` is a deduplicated provenance-candidate ledger capped at
  64 entries, not proof. User-supplied brief/metric/reference markers,
  competitor/transcript markers, and `candidate_rule:*` entries identify
  considered material. A URL/title-only competitor carries
  `unverified_competitor_*` markers and `competitor_reference_unverified`; it
  remains unverified. Supplied transcripts or metrics are separate user-supplied
  evidence, not independent verification. Candidate rules are working
  hypotheses requiring freshness checks, and trace count never grants source
  verification, factual entailment, or independent review. Quality may recognize
  supplied metrics or concrete competitor/transcript/reference material;
  critical-user-review evidence requires metrics or competitor/transcript
  material rather than candidate-rule count.

### Operator dashboard scope

- The legacy portal Content dashboard is a mixed aggregate. Pipeline and active
  signals use owner-bootstrap workspace scope; commands, Books, agent/runtime,
  Voice DNA, reaction, knowledge, and references are platform projections.
  Every YouTube channel, transcript, study, and total is platform-scope only.
  Private tenant-user YouTube rows must not enter the operator aggregate.
- Read top-level `availability` and `unavailableSections` before interpreting an
  empty section. A named unavailable voice, knowledge, signal, or YouTube
  section is not confirmed absence.

### Idempotency

- Schedule preview/confirm/cancel and specialist job/proposal mutations require
  an 8-200 character body or `x-idempotency-key` value; both must match when
  present. Exact replay is allowed and changed input conflicts.
- Async script admission requires a 1-200 character tenant-user key that binds
  the normalized request and pinned source snapshot. Replay returns the same
  job; changed input conflicts.
- Synchronous `saveToIdeas` requires its own 8-200 character durable key.
  Legacy high-risk acknowledgement fields do not enter its semantic request
  fingerprint. Creative proposal and unapplied edit routes do not claim replay
  safety.

## Read-Model Acceptance Checklist

Before considering an adaptation complete, verify that every affected surface:

1. Labels deadlines as advisory targets, not publication or reservations.
2. Labels recommendations and next moves as proposals.
3. Protects only current Secretary-confirmed private work blocks.
4. Shows authority and plan status, including zero-block `unplanned`, partial,
   and unavailable states.
5. Avoids invented publishing, shipping, delivery, or calendar commitments and
   points mutations back to the owning workflow.

Also verify that generation classifies every semantic input before cost or
provider work, keeps source scope exact, rejects invalid controls and
unsupported/high-risk requests, withholds malformed or wrong-locale free prose,
and documents whether retry is durable, ambiguous, or unsupported.

Keep tests, OpenAPI, project-map entries, and user-facing copy aligned with any
contract change. A local implementation is not a release or production proof.
