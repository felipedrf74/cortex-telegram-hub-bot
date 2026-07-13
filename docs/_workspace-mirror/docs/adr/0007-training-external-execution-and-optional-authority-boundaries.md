# ADR-0007: Training external execution and optional-authority boundaries

Status: proposed
Decision date: pending; proposed 2026-07-13
Decided by: pending separate approval by workspace lead (Felipe) + product, iOS, backend, privacy/security and relevant domain owners
Last verified: 2026-07-13

## Context

The Training production plan deliberately leaves WorkoutKit synchronization,
live workout execution, broader HealthKit signals, imported plans,
coach-authored plans, user-authored plans, adaptive notifications and
animation/video media outside the first production slices. These capabilities
cross platform permission, device/watch lifecycle, authorship, tenant,
external-side-effect and content-governance boundaries. Treating them as one
implicit follow-up would let an external representation or author silently
become plan authority and would make a platform failure capable of rewriting an
approved Nexus plan.

The current iOS app already has the HealthKit entitlement and a read-only
`HealthKitService` for an explicit allowlist of health and observed-workout
signals. Its `writeTypes` set is empty, and the repository contains no
WorkoutKit adapter, WorkoutKit import or live workout lifecycle. Existing
simulator and unit evidence cannot prove HealthKit permission behavior,
Apple Watch synchronization, WorkoutKit read-back, live execution restoration
or TestFlight entitlements.

This ADR is an executable planning boundary, not integration approval. No flag,
schema, entitlement, permission, external write or user-facing capability is
authorized by its proposed status.

## Decision

If this ADR is accepted, the immutable, user-approved Nexus Training revision
remains the source of truth for planned intent. Optional systems are narrow,
independently flag-gated adapters:

1. External scheduling is an asynchronous projection of a specific approved
   revision. Provider success, failure or edits never mutate that revision.
2. An executed workout is observed history linked to planned intent, not a
   retroactive rewrite of the plan. It may support a separately reviewed future
   adaptation proposal.
3. HealthKit data is optional evidence. It never grants approval, proves a
   diagnosis, or blocks basic Training when absent, partial, denied or revoked.
4. Imported, coach-authored and user-authored material enters as an untrusted,
   provenance-bearing candidate. It cannot activate until normalization,
   quality validation, authority checks, current-context revalidation and the
   user's immutable approval receipt succeed.
5. Adaptive notifications may invite review or report sync state. They cannot
   silently adapt a session, week, phase or plan.
6. Animation/video is a derivative of an approved exercise-media version.
   Complete text remains independent and authoritative when media is disabled,
   unavailable, removed or inappropriate for accessibility settings.

Every family below requires its own accepted implementation plan, owner release
approval and default-off flag. Accepting this boundary would not accept any
family's product scope or rollout.

## Authority matrix

| Capability | Authoritative Nexus record | External/input role | Forbidden authority |
| --- | --- | --- | --- |
| WorkoutKit schedule sync | Approved immutable plan revision and active-reference CAS | Derived provider projection with ownership/read-back state | Provider object cannot approve, activate or rewrite the revision. |
| Live workout execution | Append-only execution session linked to planned workout/revision | Observed start/pause/resume/end state and metrics | Execution state cannot overwrite planned prescriptions or regenerate future work silently. |
| Broader HealthKit signals | Versioned consent/purpose record plus normalized, fresh observation | Optional evidence for explanation or a reviewed proposal | Missing/denied data is not negative evidence; a signal cannot diagnose or approve. |
| Imported plan | Immutable source artifact and normalized candidate revision | Untrusted source content with checksum, format and provenance | File metadata, embedded instructions or external IDs cannot grant identity, tenant scope or activation. |
| Coach-authored plan | Tenant-scoped author assignment plus user acceptance receipt | Authored candidate from a verified role/relationship | Coach identity cannot cross tenants, self-elevate roles or approve on the user's behalf unless a later legal/product decision explicitly defines that authority. |
| User-authored plan | User-scoped draft/candidate and approval receipt | Direct user input subject to the same catalog and quality rules | A local draft cannot bypass server validation or become shared/published implicitly. |
| Adaptive notification | User notification policy plus Decision/proposal reference | Contextual invitation, reminder or honest partial-failure state | Delivery, open, dismiss or silence cannot count as approval or fatigue evidence. |
| Animation/video | Approved media version and derivative metadata | Optional presentation derivative | Derivative cannot replace text, outlive takedown/license status or make an exercise prescribable. |

## Independent default-off controls

The exact configuration contract must be reviewed before code lands. The
proposed names and strict initial values are:

| Capability | Proposed control | Initial/dependency rule |
| --- | --- | --- |
| WorkoutKit plan projection | `TRAINING_WORKOUTKIT_SYNC_V1_MODE=off` | Cannot become active unless revision activation, external outbox/reconciliation and signed-device gates pass. |
| Live workout execution | `TRAINING_LIVE_EXECUTION_V1_MODE=off` | Independent of WorkoutKit scheduling; requires a reviewed lifecycle and device/watch evidence. |
| Broader HealthKit evidence | `TRAINING_HEALTH_SIGNALS_V2_MODE=off` | Existing read behavior is unchanged; every added data type/purpose is allowlisted and consented. |
| Imported plans | `TRAINING_IMPORTED_PLANS_V1_MODE=off` | Candidate creation only after parser, provenance and untrusted-input gates pass. |
| Coach-authored plans | `TRAINING_COACH_AUTHORED_PLANS_V1_MODE=off` | Requires tenant roles, relationship/assignment scope and user-acceptance policy. |
| User-authored plans | `TRAINING_USER_AUTHORED_PLANS_V1_MODE=off` | Private draft/candidate only; sharing and publishing are separate capabilities. |
| Adaptive notifications | `TRAINING_ADAPTIVE_NOTIFICATIONS_V1_MODE=off` | Requires notification permission, explicit opt-in, quiet-hours/rate policy and Decision linkage. |
| Animation/video derivatives | `TRAINING_ADVANCED_MEDIA_V1_MODE=off` | Requires the governed media catalog, derivative rights, localized accessibility and takedown propagation. |

Each control is parsed strictly and scoped by tenant/user/cohort where
applicable. Unknown values fail closed. A global Training kill switch and the
owning foundation flag remain prerequisites; enabling one optional flag cannot
enable another. Shadow mode, if a family proposes it, performs no platform,
notification or provider writes and stores no sensitive payload beyond its
separately approved evidence contract.

## Additive persistence boundary

Final table names and columns belong to the separately approved family plan.
Any proposal must use additive migrations and preserve the following logical
records:

- **External projection**: tenant/user scope, approved revision/workout ID,
  capability/provider, external identifier, ownership-token hash, payload hash,
  idempotency key, expected version, projection state, last read-back and
  tombstone/compensation state.
- **Projection attempt/audit**: append-only claim, outcome, retry/dead-letter,
  safe error code and reconciliation relation. No private provider payload is
  copied into general logs.
- **Execution session**: tenant/user scope, planned-workout link when known,
  independent lifecycle/version, device source, observed timestamps and an
  immutable completion/discard record. Completed history remains immutable.
- **Health consent and observation envelope**: capability/data-type purpose,
  consent/policy version, device-source reference, observation time, expiry and
  revocation/deletion state. Raw health values remain in the approved encrypted
  health store, not revision explanations or generic audit rows.
- **Plan source artifact**: source kind, immutable checksum, parser/version,
  provenance/author reference, encrypted original or governed object reference,
  normalized-candidate link and rejection/takedown state.
- **Author assignment and acceptance**: tenant-scoped role/relationship,
  permitted audience, assignment version, expiry/revocation and the distinct
  user's immutable acceptance receipt.
- **Notification policy/delivery ledger**: explicit opt-in, channel, locale,
  quiet hours, rate/cooldown version, proposal/Decision reference, delivery
  status and user action without interpreting silence as consent.
- **Media derivative**: parent approved media version, derivative kind,
  content checksum, license/provenance, captions/transcript/AX bundle,
  locale, Reduce Motion behavior and removal/replacement relation.

All records use authenticated tenant/user scope and same-scope foreign keys.
Cross-tenant identifiers return a generic not-found result. Mutations require
idempotency and expected-version/CAS protection. Approvals, source provenance
and execution completion are append-only. GDPR export/deletion, retention,
encryption, backup and audit-access behavior must be accepted before a
migration can leave staging.

No migration may reinterpret, reschedule or externally publish an existing
plan. Existing plans require no backfill other than an explicit legacy/no-
projection state if a read model needs it. A disabled flag leaves new schema
dormant; incident rollback is forward-compatible and does not down-migrate a
live database.

## Privacy, entitlement and evidence gate

All families must pass repository-selected local gates, staging and the Nexus
Verifiable Reward Loop. Platform claims additionally require recorded signed
device/TestFlight evidence; simulator success is insufficient.

The evidence package must record build/version, exact source commit, signed
entitlements, iPhone and Apple Watch models, iOS/watchOS versions, test-account
scope, permission state before/after, steps, read-back result, rollback result
and redacted logs. It must not contain raw health values, provider tokens,
private calendar content or other users' data.

| Evidence | Minimum proof before family activation |
| --- | --- |
| Privacy/product | Purpose and data-minimization review; retention/export/deletion policy; App Store privacy disclosure; user copy in EN, PT-PT and PT-BR; explicit owner acceptance. |
| Entitlement/signing | Release archive entitlement inspection and successful TestFlight installation. WorkoutKit/watch capabilities must be proven from the signed product, not a Debug simulator build. |
| Permission lifecycle | Contextual pre-permission explanation; grant, partial, deny, revoke in Settings, unavailable-device and later re-enable flows. Basic Training remains usable throughout. |
| Device lifecycle | Foreground/background, phone/watch unavailable, app termination, restart, account switch/sign-out, network loss/recovery, duplicate delivery and clock/time-zone change. |
| Tenant/account isolation | Two controlled accounts prove no cross-user projection, source artifact, author assignment, health envelope, notification or cache reuse. |
| Operational | Staging flag-off parity, scoped internal cohort, read-back/reconciliation dashboard, kill-switch drill, compensation/takedown drill and production-health plan. |

Production data is not used to manufacture this proof. HealthKit observations
are minimized and evidence records only bounded outcomes. Notification lock-
screen content must be privacy-safe and configurable. Analytics/telemetry is
not added until the privacy event dictionary is approved; then it contains
codes, counts, duration and safe identifiers only.

## Separately approved acceptance criteria

The following are entry criteria for later implementation plans, not current
claims.

### WorkoutKit plan projection

- Define a lossless or explicitly lossy mapping for every enabled canonical
  session/block/prescription and honest unsupported fallback.
- Prove schedule, update, delete/compensation and provider read-back on signed
  iPhone/Watch builds; include duplicates, external edits, stale revisions,
  offline recovery, time-zone change and account switch.
- Bind every external object to Nexus ownership and the exact approved revision
  hash. Replays are idempotent; another revision cannot claim the object.
- Provider failure leaves the approved Nexus plan active and shows a truthful
  recoverable partial state.

### Live execution

- Accept a documented lifecycle for prepare/start/pause/resume/end/discard,
  crash restoration, phone/watch handoff, background expiry and duplicate-start
  prevention.
- Keep the observed execution record separate from immutable planned intent;
  future changes are explicit adaptation proposals with `SESSION`, `WEEK`,
  `PHASE` or `FULL_PLAN` scope.
- Pass signed-device/watch interaction, battery/performance, accessibility and
  offline recovery evidence. No live tracking UI ships before this gate.

### Broader HealthKit evidence

- Approve each new data type, purpose, freshness window, minimum sufficiency,
  storage/retention and deletion behavior. Keep sharing/write types empty unless
  a later proposal explicitly justifies a write.
- Prove partial authorization and Apple's read-authorization ambiguity are
  represented honestly. Absence never becomes a diagnosis or a negative score.
- Prove grant/revoke/delete/account-switch behavior on a physical device and
  confirm sensitive values are absent from general logs, notifications,
  Decision explanations and model prompts.

### Imported plans

- Approve formats, size/complexity limits, parser sandboxing, checksum and
  provenance rules; treat all text and embedded metadata as untrusted data.
- Preserve the immutable original, normalized diff, unknown exercise/session
  fallback and every repair/rejection reason.
- Require catalog/quality/conflict validation, current-context revalidation and
  explicit user approval before activation. Import never writes calendars or
  external providers by itself.

### Coach-authored plans

- Define coach identity, tenant role, relationship/assignment scope, expiry,
  revocation, audit/support access and who may edit which revision.
- Prove two-tenant isolation and generic not-found behavior. A coach-authored
  candidate cannot reveal another athlete or become active without the accepted
  user-authority policy.
- Record the coach source separately from the user's acceptance revision so
  later coach edits cannot mutate accepted work.

### User-authored plans

- Use the same typed blocks, prescriptions, catalog identities, quality gates,
  immutable revisions and approval semantics as generated plans.
- Prove offline draft recovery without local approval truth, concurrent edits,
  rejection/repair and unknown-type handling.
- Keep sharing, templates, marketplace or public publishing unsupported until
  separately designed for licensing, moderation and tenant authority.

### Adaptive notifications

- Require explicit opt-in, permission truth, quiet hours, per-purpose rate and
  cooldown, dedupe/idempotency and a one-step disable path.
- Link material suggestions to the existing proposal/Decision lifecycle.
  Notification open/dismiss/silence does not approve or apply a change.
- Pass APNs/TestFlight, revoked permission, stale proposal, multiple-device,
  duplicate/out-of-order delivery, locale, VoiceOver and privacy-safe lock-
  screen evidence.

### Animation and video

- Bind every derivative to an approved current exercise-media version and
  independently approved license/provenance/checksum.
- Provide localized captions/transcript and accessibility descriptions; obey
  Reduce Motion, avoid required autoplay and keep complete text available.
- Prove low-data/offline cache limits, cancellation, memory/scroll performance,
  replacement/takedown propagation and no delivery after license expiry.

## Rollout and rollback

Each family follows: accepted plan/ADR → contract and threat review → additive
migration proposal/rehearsal when needed → default-off code → local contract
tests → staging flag-off parity → signed internal device/TestFlight proof →
explicit owner activation for a named cohort → monitored expansion. No family
inherits another family's approval.

Rollback first sets only the affected flag to `off`, stops new claims/external
effects and preserves the approved Nexus plan. The system then reconciles
in-flight attempts and uses provider read-back plus ownership records for
verified delete/compensation where supported. Health consent revocation stops
new reads and invokes approved deletion/retention rules. Media takedown removes
the derivative while text remains. Imported/authored candidates remain
inactive or readable according to retention policy; accepted revisions are not
silently rewritten. Live incident response does not down-migrate additive
schema unless forward disablement cannot protect safety or privacy.

## Alternatives considered

- **Treat Apple/provider state as the plan source of truth.** Rejected because
  external edits, partial sync and permission revocation would bypass immutable
  approval and make rollback ambiguous.
- **One Milestone 6 master flag and release.** Rejected because the families
  have independent privacy, authority, device, content and rollback risk. A
  broad flag makes evidence non-attributable and widens incidents.
- **Use current HealthKit authorization and simulator coverage as approval for
  all platform work.** Rejected because current code is read-only, no
  WorkoutKit/live lifecycle exists, and the signed device/watch behaviors are
  not simulator-verifiable.
- **Allow imported/coach/user plans to activate directly after parsing.**
  Rejected because parsing does not establish tenant authority, exercise
  identity, quality, current-context validity or user consent.
- **Make advanced media required for workout comprehension.** Rejected because
  license/takedown, network, accessibility and device constraints require a
  complete text-first experience.

## Consequences

- **Positive**: one durable authority model; small independently reversible
  releases; honest partial failure; explicit privacy and signed-device gates;
  no optional capability can silently broaden another.
- **Negative**: more flags, adapters, reconciliation states and separate review
  packages; external capability delivery is slower than a single broad launch.
- **Operational**: owners must maintain per-family rollout dashboards,
  runbooks, evidence and flag state. Support tooling exposes safe IDs/statuses,
  never raw health/provider content.
- **Current-state consequence**: no source or runtime behavior changes now.
  WorkoutKit/live execution, HealthKit expansion, deferred plan forms, adaptive
  notifications and advanced media remain unsupported/default-off pending
  separate approval and proof.

## Open decisions before acceptance

- Which optional family, if any, is first, and which user cohort justifies it?
- What exact HealthKit data types and retention purposes are necessary beyond
  the current read-only allowlist?
- What user/coach legal authority and tenant relationship model is acceptable?
- Which import formats and maximum complexity can be supported safely?
- Does WorkoutKit projection require a companion watch target or can the first
  accepted scope remain phone-managed?
- What notification purposes and lock-screen detail are privacy-approved?
- What media derivative rights, captioning and performance budgets are owned?

## Links

- Production plan: `/Users/felipedominguez/Developer/Nexus Hub IOS/worktrees/training-prototype-20260710/Nexus Hub/TrainingPrototypeReviewPackage/TrainingProductionImplementationPlan.md`, Milestone 6
- Existing iOS HealthKit reader: `Nexus Hub/Core/Services/HealthKitService.swift`
- Existing iOS health background sync: `Nexus Hub/Core/BackgroundSyncManager.swift`
- iOS entitlements: `Nexus Hub/Nexus Hub.entitlements`, `Nexus Hub/Nexus Hub.Release.entitlements`
- iOS platform validation standard: `ios/docs/engineering/ios-frontend-validation-checklist.md`
- Related authority boundary: ADR-0003 (token-zero REST/direct routes)
