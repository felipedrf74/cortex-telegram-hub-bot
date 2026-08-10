# Backend API and Contract Standard

Status: canonical
Owner: backend architecture lead
Last verified: 2026-08-09
Update policy: update when REST contract conventions, route shape, or
migration discipline changes. `docs/release/continuous-deployment.md` and
`docs/release/release-evidence-contract.md` are the runtime and evidence
companions.

This standard is the single source of truth for how Nexus Hub's TypeScript
backend (`src/`) exposes routes, validates input, shapes responses,
manages migrations, and writes service-layer code. It is grounded in the
OWASP REST/API guidance, OpenAPI conventions, and the Twelve-Factor App
principles, then translated into Nexus-specific rules.

## 1. Token-zero is law (must)

Operational reads/writes use REST under `/api/v1/*` directly — never via
fake chat commands, never via prompt-driven lookup.

- A "list tasks" call: `GET /api/v1/tasks/lists` ✅
- A "list tasks" call routed through `chat.sendMessage("list my tasks")`: ❌

If you find yourself adding `chatViewModel.sendMessage(...)` for a data
read, stop. The architecture rule is that data reads cost zero LLM tokens
and should always be deterministic.

## 2. Route shape (must)

Every app-facing route in `src/api/routes/` follows this shape:

```typescript
router.<verb>('/path', authMiddleware, async (req, res, next) => {
  try {
    // 1. Pull authenticated context
    const userId = req.userId; // === req.tenantId per JWT-derived policy

    // 2. Validate input (zod / explicit guards)
    const input = parseInput(req.body); // throws typed ValidationError

    // 3. Authorize at object level (not just route level)
    if (!await canAccess(userId, input.resourceId)) {
      return res.status(403).json(forbidden());
    }

    // 4. Delegate to a service
    const result = await service.doIt(userId, input);

    // 5. Shape output
    return res.json(toDto(result));
  } catch (err) {
    return next(err); // central error handler shapes 4xx/5xx
  }
});
```

Rules:

1. **`req.userId === req.tenantId`** in JWT-authenticated paths. Violations
   are tenant-isolation bugs by definition.
2. **No business logic in the route handler.** Routes parse, authorize,
   delegate, shape. A 60-line route is almost always a buried service.
3. **No direct `db.prepare(...)` in route handlers.** Database access goes
   through a service or repository module.
4. **No model/provider calls during simple read paths.** A `GET` should not
   trigger a Gemini/Claude completion unless that's the route's explicit
   purpose. This is enforced by §6.

## 3. Input validation (must)

1. **Every route validates input shape before authorization.** Reject with
   `400 INVALID_INPUT` early; do not allow malformed input to reach the
   service layer.
2. **Use zod or explicit guards.** A free-text `req.body.x` read with no
   shape check is a bug. Path parameters get the same treatment.
3. **Bound payload sizes.** `express.json({ limit: '...' })` is mounted at
   the app level; routes that accept attachments declare an explicit limit
   per route.
4. **Pagination for list responses.** Default page size 50, max 200. Never
   return an unbounded array.
5. **Idempotency keys for risky mutations.** Plan creation, calendar
   create, task create — every mutation that could be retried by the iOS
   client must accept a client-generated `idempotencyKey` and de-dupe on
   the server.

## 4. Output shape (must)

1. **Responses are typed DTOs, not raw rows.** Never `res.json(row)` from a
   prepared statement; always go through a `toDto()` mapper that drops
   internal fields (`created_by`, `tenant_id`, `_seq`, etc.).
2. **Errors use a typed envelope.** The standard envelope is:
   ```json
   { "error": { "code": "ACCOUNT_LINK_REQUIRES_VERIFICATION", "message": "...", "details": {...} } }
   ```
   The `code` is a stable identifier the iOS app can branch on. The
   `message` is operator-readable; the `details` are optional and never
   contain raw user data, raw tokens, or stack traces.
3. **`degraded: true` is the explicit "soft failure" flag.** When a route
   returns a usable but partial response (e.g. calendar fetch failed but
   plan generation succeeded), set `degraded: true` and add a
   `warnings: [...]` array. iOS reads these to render a banner.
4. **Status codes match semantics.** 400 for input validation, 401 for
   missing auth, 403 for authorization failure, 404 for not-found, 409 for
   conflict, 422 for semantically-rejectable input, 429 for rate limits,
   503 for "tried, hit a downstream failure". Never 500 for a known case;
   500 means the developer didn't handle it.
5. **No information leak via status codes.** Login errors collapse to a
   single neutral 401 regardless of "user not found" vs "wrong password";
   register errors collapse to `REGISTRATION_REJECTED 400` regardless of
   "email taken" vs "weak password".

### 4.1 Model-access and quota contract (must)

Every cost-bearing REST or WebSocket path uses the canonical entitlement and
budget wrapper before provider execution. Mixed endpoints evaluate their
deterministic token-zero behavior first, so exhausting or lacking model access
does not disable reads/actions that do not call a model.

The public model-access errors are stable and dollar-free:

| HTTP | Code | Meaning |
| ---: | --- | --- |
| 403 | `AI_PLAN_REQUIRED` | the resolved entitlement cannot use model-backed AI |
| 429 | `AI_DAILY_LIMIT_REACHED` | daily eligible capacity is exhausted |
| 429 | `AI_MONTHLY_LIMIT_REACHED` | monthly eligible capacity is exhausted |
| 429 | `SERVICE_DEGRADED` | global breaker, lock, reservation, or usage-persistence protection is active |

Every 429 response sets `Retry-After`. Error details may include `window`,
reset fields, `unblocksAt`, and retry metadata, but never raw caps, spend, model
responses, or provider credentials. Billing/status and usage reads expose the
additive daily/monthly fraction and reset fields while preserving legacy
aliases. The complete field, entitlement, reset-window, Nexus Points, and
automation contract is canonical in `docs/TOKEN-QUOTA-CONTRACT.md`.

## 5. Service / repository separation (should)

The recommended layer order is:

```
src/api/routes/<route>.ts          // HTTP shape, auth, validation
src/services/<service>.ts          // business logic, cross-cutting
src/services/<repo>.ts (or state/) // SQL access via prepared statements
src/db/migrations/...              // schema evolution
```

Service modules are pure-ish: they accept primitive inputs, return typed
outputs, and call into repository modules for I/O. Tests can mock either
layer cleanly. A service that imports `express` is a sign the layers are
collapsed and should be split.

## 6. No-side-effect read contract (must)

A `GET` route may not:

1. Mutate any row (no `INSERT`/`UPDATE`/`DELETE`).
2. Trigger a network call to an external provider unless the route's
   explicit purpose is "fetch fresh".
3. Trigger a model/provider completion unless the route's explicit purpose
   is "generate".
4. Refresh a stale OAuth token silently. The route may notice
   freshness and emit a structured warning, but the refresh runs in a
   background job, not in the request thread.

Where a `GET` legitimately needs a side effect (e.g. populate a cache on
first read), the side effect is enqueued, not awaited.

This rule is testable: `__tests__/api/<route>.test.ts` should include at
least one assertion that `db.prepare(...).run(...)` was not called for any
mutation statement during a `GET` invocation. The risk-based gate matrix
already routes `app-facing flow surfaces` to Tier-2 local smoke; the
no-side-effect assertion is the explicit unit-level form.

## 7. Idempotency (must, for mutations)

1. **Plan create, plan cancel, calendar create, task create** all accept a
   client-generated `idempotencyKey`. The server stores the key with the
   resulting resource id and returns the same id on retry.
2. **Calendar event upsert keys on `(plan_id, plan_version, session_id,
   provider)`** — the v4.14.99 ownership audit table is the canonical
   pattern for this.
3. **Task complete is idempotent on `(taskId, userId)`** with no `done_at`
   replacement on a second call.

## 8. Error handling (must)

1. **No silent failures.** A caught error must do one of: (a) emit a
   structured warning to the response with a typed code, (b) emit a
   structured pino log entry with the reqId, (c) bubble to the central
   error handler. "Catch and ignore" is forbidden.
2. **No `try { ... } catch {}`** — even an empty catch must add a comment
   explaining why the error is being swallowed and a structured log
   entry. If the comment says "should never happen", the catch is wrong.
3. **Provider fallback errors are first-class.** When the primary model
   (Gemini) fails and the fallback (Anthropic/OpenAI) is invoked, log a
   structured `provider.fallback` event so the cost/latency dashboard
   reflects it.

## 9. Migration discipline (must)

1. **Migrations are append-only and numbered.** `migrations/082_*.sql`,
   `083_*.sql`, etc. Never edit a previously-deployed migration.
2. **Every migration has an inverse.** Either an explicit
   `migrations/down/082_*.sql` or, where down-migration is impossible,
   a documented "irreversible" note alongside the migration file
   (the canonical home is `docs/release/migration-irreversible.md`,
   create when the first irreversible migration ships).
3. **A migration that drops a column requires a feature-flag intermediate
   step.** Step 1: stop reading the column (deploy). Step 2: stop writing
   the column (deploy). Step 3: drop the column (migration). Never collapse
   to one step.
4. **Migrations are tested under `__tests__/migrations/`.** The test
   asserts the schema after-state and (if applicable) the data-shape
   after-state on representative seeded rows.
5. **Migration rehearsal runs against a snapshot of staging DB shape.** The
   nightly CI runs full migration rehearsal on a fresh DB.

## 10. Provider routing safety (must)

Nexus runtime model routing is **configurable**. Do not hardcode "Gemini",
"Claude", "GPT", or any concrete provider as the product default in code.

1. **Use `getActiveProvider(taskType)` or
   `completeOneShotWithFallback(...)`.** Direct
   `anthropic.messages.create` / `gemini.generateContent` / `openai.chat...`
   calls are forbidden in business code. The SDK wrappers handle cost
   logging, retries, and fallback.
2. **Tool call authorization is per-user.** A tool that performs a
   side-effect (read calendar, send email, write DB) must accept a
   `userId` parameter and authorize the call against that user before
   executing. The tool dispatcher in `src/services/tool-executor.ts` is
   the single point of authorization.
3. **Cost guardrails are global, per-user, daily, monthly, and
   automation-aware.** Every provider call is covered by the serialized
   reservation contract in `src/services/cost-guardrail.ts`; `api_usage` is
   quota truth. Do not use `users.tier`, `usage_metering`, prompt instructions,
   or a route-local counter as an access/blocking authority.

### 10A. Secretary arbitration metadata prerequisite (must)

Migration 280 records an additive rank snapshot on each newly persisted
Secretary agenda row. The single runtime authority is
`computeSecretaryIntentArbitrationRank`; batch ordering and persisted metadata
must use that same function and the exact
`secretary-arbitration-rank-policy.v1` policy version.

The v1 score preserves the existing ordering contract: explicit priority,
source-skill weight, an 18-point valid-deadline boost, an 8-point fixed-window
boost, and the existing Training phase adjustment. Equal scores use the
earliest valid normalized deadline and then the source intent ID. The snapshot
stores the score, normalized deadline (nullable), effective flexibility, and
policy version; it stores no title, description, or other new user content.

Rows with a missing, non-finite, incomplete, or unknown-policy snapshot remain
hard busy and cannot be preempted. In particular, migration 280 deliberately
leaves all legacy rows NULL rather than guessing from the irreversible
source-shape hash.

Stage 1 adds one pure capacity planner shared by preview and submit. A preview
may disregard a local loser only when all of these facts agree: same tenant and
user, active cross-skill row, non-fixed current-policy rank strictly below the
incoming full rank, `synced` durable provider mapping, exactly one live event
with the same provider source and event ID, and exact marker evidence. A
non-Training event requires its exact `NEXUS_SECRETARY_AGENDA_ITEM` marker; a
Training event requires its plan/version/session identity to match the
`training:<plan>:<version>:<session>` source intent. Titles, times, legacy
source lines, and provider-looking text are never identity evidence. Duplicate,
unmarked, foreign, unidentified, fixed, legacy-NULL, and equal/higher-ranked
cases remain hard busy.

Preview returns the canonical
`priority_preemption_candidate` reason plus `wouldPreempt: true` and a count,
but never loser/provider IDs. Stage 1 itself performs no loser mutation and no
provider write.

Migration 282 enables the verified Stage 2/3 submit path. A submit may remove
only the same exact lower-ranked candidates used by preview, and its first
transaction writes the complete graph or nothing: a proposed/unmapped winner,
one proposed/unmapped loser replacement at exactly vN+1 for every active loser
vN, immutable exact provider-delete dependencies, and one privacy-bounded
`secretary.arbitration.committed.v1` outbox event. The loser vN remains active,
busy, and mapped during this phase. Replay returns the same winner graph;
changing the winner source shape or mutating a locked winner/loser intent
conflicts.
No provider or source-feedback call occurs in that transaction.

The provider-sync worker drains dependency edges before ordinary agenda work
under the same bounded adapter-call budget. It reads the frozen provider event
ID and requires the exact source plus Secretary/Training marker before delete;
title/time similarity is never authority. Confirmed absence and provider 404
are idempotent success. An unknown delete outcome enters readback-only
reconciliation, so another delete occurs only after a fresh exact read proves
the event still exists. Identity mismatch and terminal refusal fail closed.
Leases are token-fenced and compared as normalized datetimes; provider target,
create-attempt, claim, newest-version, and mapping guards are also enforced in
SQLite for mixed-runtime defense in depth.

Confirmed deletion, loser vN supersession/mapping clear, loser vN+1 transition
to `unscheduled/deleted`, dependency settlement, and its durable source-feedback
request commit in one transaction. The winner remains `proposed` until every
edge is satisfied. The final edge supersedes an active prior winner without
transferring its provider mapping and activates the new winner, but does not
queue winner feedback yet. Only then may ordinary provider sync create/adopt
its event; exact mapping success completes the operation and atomically queues
winner feedback. Safe cancellation, explicit pre-provider expiry, and terminal
provider/dependency failure likewise persist truthful terminal decision
metadata and their one durable feedback request in the same transaction.
Cooking, Finance, and Content use
`secretary.source_feedback.requested.v1`; Training keeps its specialized event.
Both consumers re-read the exact scoped agenda ID/version and advance one
logical-intent projection only when `agenda_version` increases.

Cancellation is a request while cleanup is outstanding. Exact cleanup still
finishes and no loser is automatically restored; only then does the operation
become canceled and the winner remain provider-ineligible. Scoped synchronous
callers may drain only dependencies belonging to their requested winner;
background batches may drain the scoped backlog. Neither path can spend more
than its declared provider-call budget.

### 10.1 Content-pipeline compatibility exit (must)

Migration 246 makes the canonical content workspace the only supported write
root for items previously tracked in `content_pipeline` and for Content Agency
package handoffs.

1. **`content_pipeline` is a read-only compatibility archive.** Supported
   runtime code must never insert or update it. The legacy route shape may
   remain temporarily, but writes and read-back use workspace items, artifacts,
   immutable revisions, mutation receipts, and workflow events.
2. **Agency handoffs are one scoped canonical transaction.** A successful
   handoff pins the package ID and content hash to one tenant/user item, one
   script artifact, and one revision through
   `content_workspace_ingress_bindings`. Replay returns that same chain; a hash
   conflict fails closed. Approval and publication are never inferred.
3. **Legacy stages cannot manufacture workspace truth.** `scripted` is a
   compatibility projection derived from a saved script revision. Filming,
   editing, approval, and publication require canonical modeled evidence; an
   unsupported transition makes no change.
4. **Startup and rollback are state-coupled.** Startup must fail when either
   legacy writer guard is absent, an active private row is unbound, or a binding
   has a broken tenant-scoped item/artifact/revision chain. After migration 246,
   rollback requires the exact predecessor runtime and exact pre-246 database
   snapshot; code-only downgrade is unsafe.
5. **Metadata-only means parity is incomplete.** Legacy script paths, linked
   scripts, sources, stage history, performance, and publication evidence stay
   available for compatibility reads until each has verified canonical lineage.
   Migration never upgrades those signals into approval or publication claims.
6. **Removal is evidence-gated.** Drop the archive only after every active
   private row is bound, artifact/lineage parity is complete, supported clients,
   exports, dashboards, and agents use workspace IDs, compatibility telemetry
   is zero for the observation window, and release policy no longer requires
   exact-snapshot rollback.

### 10.2 Content-topic compatibility exit (must)

Migration 247 makes the canonical content workspace the only supported write
root for content ideas that were previously stored in `content_topics`.

1. **Legacy topic endpoints are compatibility projections.** Their public
   route shape may remain during client migration, but creates, updates, and
   deletes must write `content_domain_objects`, `content_artifacts`, immutable
   revisions, mutation receipts, and the scoped compatibility link. Supported
   runtime code must never mutate `content_topics`.
2. **The legacy table is database-enforced read-only.** Startup must fail
   closed when the migration's insert, update, or delete guard is absent, or
   when an eligible legacy row lacks a valid canonical link. The sole delete
   exception is the existing short-lived, subject-scoped legal/account-erasure
   authorization used by the transactional account-deletion flow; it is not a
   product mutation path.
3. **A content deadline is not a publishing or Secretary-sync assertion.** A
   migrated `scheduled_date`/`scheduled_at` is a workspace deadline only. Task
   or calendar creation requires its own preview, explicit user confirmation,
   idempotency contract, and canonical schedule binding. `published` requires
   separately recorded publication confirmation.
4. **Compatibility edits preserve canonical work.** The legacy projection may
   revise its linked idea artifact, but it must refuse to replace a different
   current artifact such as an outline or script. Deletes are recoverable
   workspace soft deletes.
5. **Rollback is state-coupled.** After migration 247 is used, a code-only
   rollback to an old writer is unsafe. Recovery requires the exact predecessor
   runtime and its exact pre-247 database snapshot. The down migration is only
   a rehearsal guard for an untouched migration.
6. **Removal is evidence-gated.** Remove compatibility routes and the legacy
   table only after supported clients no longer call them, all eligible rows
   are linked, no supported runtime imports the legacy mutators, rollback and
   recovery drills pass, and the deprecation window has elapsed. Temporary
   coexistence is not permission to maintain a second content engine.

### 10.3 Canonical Content workspace and rollout authority (must)

The Content workspace is the single supported domain for user-owned ideas,
projects, briefs, outlines, scripts, variants, revisions, sources, claims,
specialist proposals, and private work scheduling.

The governed schema sequence runs from migration 239 (immutable Content Agency
package identity) through migration 253 (lossless legacy Content-idea note
parity). It
adds the canonical domain, library, specialist jobs, artifact relationships,
Secretary schedule bindings, privacy-safe aggregates, rollout evidence, and
the evidence-gated exits described below; it does not authorize deployment by
itself.

1. **One persistence root.** New Content work starts in tenant-scoped
   `content_domain_objects`, then uses `content_artifacts` and immutable
   `content_revisions`. Compatibility routes may project this truth but may not
   create another mutable lifecycle or silently mirror a write into a legacy
   table.
2. **Every mutation is replay- and conflict-safe.** Creates and actions require
   an idempotency key. Edits, transitions, restores, tag changes, and revision
   saves also require the current workflow or revision version. A stale client
   receives a typed conflict with authoritative read-back; the server never
   overwrites user edits to make a retry succeed. An immutable soft-delete
   receipt is returned separately from current deletion truth: if another
   client restored the item before a retry, the replay identifies the receipt
   as superseded and returns the authoritative active item.
3. **Sources, claims, and agent work are revision-scoped.** Source/claim
   lineage and specialist proposals identify the immutable revision they were
   derived from. Agent output is a proposal until an explicit accept action
   creates a new revision. Reject, retry, cancel, compare, and restore preserve
   the prior revision and provenance. A specialist job may start or resume only
   when its private Agency package is `artifact_pinned` to the exact target
   artifact through `content_workspace_ingress_bindings`; the package ID/hash
   and the pinned revision's generator-contract provenance must all match.
4. **Scheduling means private work time.** Content schedule routes preview and
   confirm Secretary-owned writing, recording, or editing time. A deadline,
   schedule binding, approval, or agent completion never means the content was
   externally published. Publication execution is not supported by this
   contract.
5. **Server capability truth is authoritative.** Authenticated clients read
   `GET /api/v1/content/workspace/capabilities` before exposing mutations.
   Production defaults to read-only unless a valid server mode and explicit
   cohort enrollment enable the relevant write slice. HTTP middleware and the
   domain service both enforce the gate, so chat, jobs, old URLs, and future
   transports cannot bypass it. Unknown modes and client decode failures fail
   closed for writes while reads and recovery guidance remain available.
6. **Rollout is temporary and measurable.** The gate may be removed only after
   migration parity, supported-client adoption, two supported release windows
   with zero compatibility traffic, and a full observation window without a
   kill-switch event. Rollback after state-bearing migrations requires the
   exact compatible runtime and database snapshot; a code-only downgrade is
   unsafe.
7. **Normal UI receives presentation contracts, not internals.** DTOs expose
   stable user-facing state, next action, warnings, and recovery options. Raw
   prompts, traces, hashes, provider responses, tenant IDs, and machine-only
   status values remain in scoped support/debug surfaces and never become
   normal Content UI copy.
8. **Bounded reads remain complete and stable.** Library and Trash cursors bind
   the normalized filter/sort contract to a scoped snapshot and use keyset
   continuation. Items inserted or edited after that snapshot are deferred to
   refresh, while unchanged snapshot-eligible rows are not duplicated or
   skipped. Immutable revision history uses its own artifact-bound keyset.
   Dashboard totals come from complete aggregate reads such as
   `GET /api/v1/content/workspace/today-summary`, never from the first bounded
   library page.
9. **Generated ingress preserves both the mutation receipt and live truth.** A
   generated script may create a new item or target an existing item only with
   that item's current workflow version. Its response returns the immutable
   revision created by the request separately from the authoritative current
   item, artifact, and revision; replay never rewinds later user work. Changing
   accepted source or claim lineage while reusing an idempotency key conflicts.
10. **Progressive development stays inside one content item.** A brief,
    outline, script, or platform variant may name a source artifact only from
    the same scoped item. The service records an explicit artifact relationship
    in the creation transaction; it never infers lineage from titles or raw
    body similarity.
11. **Chat capture is explicit and minimal.** Chat or Telegram may save a
    user-authored thought as a canonical private idea only after an explicit
    request. The capture is deterministic, tenant-scoped, and records chat as
    provenance rather than AI authorship. It must not silently import private
    cross-skill context or treat imported text as trusted instructions.
12. **Specialist execution is bounded and truthful.** Strategy and research
    may run in parallel before writing; structural, factuality, and platform
    reviews may run in parallel after it; final quality review depends on those
    outputs. All calls use the configurable provider router inside one governed
    interactive budget reservation and require bounded structured output.
    Package and dependency data are untrusted quoted context; downstream
    proposal excerpts are bounded and any truncation is surfaced. Provider
    retries and timeouts must remain inside the durable job lease. Each step
    exposes whether it was independently provider-reviewed or package-derived,
    plus a closed fallback reason; package-derived fallback must never appear
    as an independent fact-check. No specialist mutates content until the user
    accepts a still-current proposal.

### 10.4 Legacy editorial authority exit (must)

Migration 249 removes the pre-workspace editorial lifecycle as a supported
writer without upgrading historical assertions into current Content truth.

1. **Only valid private roots can be normalized.** Active noncanonical rows
   require positive tenant/owner identity and `user_private` visibility. A
   shared, public, internal, or invalid row aborts the migration before any
   persistent cutover write and requires owner-reviewed reconciliation.
2. **Historical state is evidence, not authority.** Reviewed, approved,
   scheduled, and published legacy rows become review-required canonical items.
   The binding preserves the old values, but the migration creates no artifact,
   revision, source lineage, schedule binding, approval, or publication proof.
3. **Compatibility actions use canonical CAS.** Legacy editorial and Decision
   projections may capture, revise, submit, approve, reject, or archive only
   when those actions map safely to the canonical lifecycle. Legacy scheduling,
   publication, source-review, and repurpose execution fail with a typed
   replacement requirement rather than mutating another authority.
4. **Historical ledgers are read-only.** `content_approval_records` and
   `content_source_review_records` remain available for scoped export and audit.
   Database guards block normal inserts, updates, and deletes; only an active
   subject-scoped account/legal-erasure authorization permits deletion.
5. **Rollback and removal are evidence-gated.** Once any row is normalized,
   rollback requires the exact pre-249 database snapshot and matching runtime.
   Remove the compatibility façade and historical tables only after two
   supported release windows with zero traffic, canonical Decision targets,
   and verified export and erasure coverage.

### 10.5 Content performance revision lineage (must)

Migration 250 binds each new measured Content outcome to the immutable revision
whose packaging or script the user says produced it.

1. **Canonical identifiers are required.** New writes identify one scoped
   content item, artifact, and revision and carry an idempotency key. The
   outcome, immutable link, and mutation receipt commit in one immediate
   transaction or none of them commit.
2. **The pipeline alias is frozen.** Canonical rows keep `pipeline_id` NULL.
   Insert/update guards reject new legacy aliases, and no supported alternate
   performance writer may create unlinked rows.
3. **Backfill never guesses.** A historical pipeline outcome is linked only
   when migration 246 already recorded an `artifact_pinned` ingress binding.
   Metadata-only rows stay explicitly unlinked for later reconciliation.
4. **Evidence labels stay honest.** The API reports performance as
   user-reported and publication execution as not performed. A URL or metric
   payload is not provider verification and cannot manufacture publication
   state.
5. **Reads, export, and erasure preserve scope.** Canonical read models join
   through the tenant/owner link. Export includes the link; account deletion
   removes it through scoped foreign-key/erasure behavior without logging raw
   content or metrics.
6. **Rollback is snapshot-only.** Once migration 250 applies, a code-only
   downgrade could restore the split writer or lose lineage. Recovery requires
   the exact predecessor runtime and exact pre-250 database snapshot.

### 10.6 Content revision, selection, and approval integrity (must)

Migration 251 and the canonical mutation service make the bytes reviewed by a
user inseparable from the workflow version they approve.

1. **Revision ancestry is scoped and sequential.** Revision 1 has no parent;
   every later revision names the immediately preceding revision of the same
   tenant, owner, and artifact. Restore provenance may name only a strictly
   older revision from that same chain.
2. **Current pointers are coherent.** An item's selected artifact belongs to
   that item and scope. An artifact's current revision belongs to that artifact,
   is its latest numbered revision, and agrees with `revision_count`. Selected
   artifacts/revisions must be unselected before direct deletion.
3. **Every content-byte mutation advances review truth.** Artifact creation,
   revision save, restore, and accepted agent proposals advance the parent item
   workflow version. Editing previously approved, scheduled, or published
   content returns it to review, clears prior approval identity/time, and records
   a closed reason code. Saving an older or secondary artifact never selects it
   implicitly.
4. **Clients receive authoritative parent state.** Artifact and revision
   mutation responses include the current parent item. A client updates both
   its library and open detail model from that response and uses a follow-up GET
   only during the predecessor compatibility window.
5. **Agent result pointers are immutable evidence.** Accepted artifact/revision
   pointers are assigned together only on the original proposed-to-accepted
   transition, stay in the source item's scope, and cannot be rewritten or
   cleared during normal operation.
6. **Erasure is explicit and bounded.** Foreign-key nulling of revision lineage
   or accepted proposal results is permitted only while a live subject-scoped
   `ACCOUNT_DELETION` or `LEGAL_ERASURE` authorization exists. This exception
   enables graph deletion; it is not a content-editing API.
7. **Rollback is snapshot-only.** Removing these guards in place would reopen
   cross-scope or silent-lineage rewrites. Recovery requires the exact
   predecessor runtime and exact pre-251 database snapshot.

### 10.7 Legacy script artifact parity and writer exit (must)

Migration 252 completes the lossless canonical cutover for eligible private
rows retained in `content_scripts`.

1. **Every eligible body is pinned byte-for-byte.** Each positive-user,
   tenant-scoped private script receives an immutable hash binding to one
   canonical item, script artifact, and revision. A valid same-scope pipeline
   binding reuses its canonical item; otherwise the migration creates a
   standalone item. A pipeline identifier from another scope can never select
   the destination.
2. **History remains recoverable without manufacturing trust.** Multiple
   legacy scripts attached to one item remain separate artifacts for compare,
   export, and recovery, while the newest becomes current. The import creates
   no new approval, work schedule, or publication evidence; selecting imported
   bytes on an item previously marked approved, scheduled, or published returns
   the item to review and clears inherited approval identity.
3. **The legacy writer is frozen.** Database guards reject positive-user
   inserts and updates to `content_scripts`; supported generation, learning,
   chat, and compatibility paths write the canonical workspace. Ownerless
   system fixtures remain isolated, and the remaining delete capability is
   reserved for the scoped account/legal-erasure path rather than product use.
4. **Readiness proves the whole chain.** Startup verifies the binding and
   writer guards, exact body/hash parity, scoped item/artifact/revision links,
   current revision integrity, and the upgraded pipeline binding. Any eligible
   unbound or mismatched script fails readiness closed.
5. **Compatibility reads have an exit gate.** Legacy rows remain only for
   bounded compatibility reads until supported clients, learning consumers,
   exports, and recovery use canonical IDs and observed legacy read traffic is
   zero for the declared window.
6. **Rollback is snapshot-coupled.** Once a parity binding exists, inverse SQL
   is unsafe. Restore the matching predecessor runtime and exact pre-252
   database snapshot.

### 10.8 Legacy idea-root parity and writer exit (must)

Migration 253 retires both `notes.domain = content_idea` and `saved_ideas` as
parallel idea stores without assigning ownerless rows to a user, collapsing
tenant membership into owner identity, or discarding historical bytes.

1. **Every eligible source is exact and private.** A case-insensitive,
   whitespace-normalized `content_idea` note with a positive `user_id` and a
   nonblank body receives a tenant-equals-user private content item, idea-note
   artifact, immutable revision, and scoped ingress binding. Revision text and
   source hash are computed from the original body bytes, never trimmed display
   text. Every active private `saved_ideas` row with positive independently
   resolved tenant and owner scope receives its own canonical chain; the
   migration does not require tenant ID to equal owner ID.
2. **Exclusions are explicit, not guessed.** Ownerless, nonprivate, inactive,
   and Unicode-blank sources stay in their legacy tables and receive closed,
   hash-backed quarantine reasons. The migration never promotes an empty
   artifact or copies raw excluded content into release evidence.
3. **Legacy metadata remains attributable.** Note domain/tag bytes remain in
   item, artifact, and revision provenance, with suitable tags normalized into
   the canonical library. Each eligible saved idea also pins one ordered JSON
   snapshot and hash covering its exact title, date, status, source, score,
   workflow eligibility, angle, niche, hook, why-now, scope, ontology, strategy,
   source IDs, audit metadata, and timestamps.
4. **Readiness proves both roots.** Separate migration-owned readiness views
   report eligible, bound, unbound, exact byte/snapshot/hash mismatch,
   quarantine, and writer/binding-guard counts. The cutover transaction fails
   unless every eligible source is pinned exactly, every ineligible source is
   classified, and both retired roots are database-enforced read-only. Runtime
   startup also pins the reviewed SQL identity of the binding/quarantine tables,
   readiness views, and writer/immutability guards, then re-evaluates exact
   parity and scoped foreign-key integrity; a missing or same-name replacement
   object fails closed before the API serves traffic.
5. **Old ingress is frozen without blocking erasure.** Database guards reject
   note conversions plus every insert/update to `saved_ideas`. Legacy rows are
   never deleted by the migration; delete and foreign-key cascade remain
   available to the existing scoped account/legal-erasure transaction, while
   immutable bindings retain source identity and hash provenance.
6. **Rollback is snapshot-coupled.** Once any ingress binding exists, inverse
   SQL refuses to remove the ledger or writer guards. Recovery requires the
   matching predecessor runtime and exact pre-253 database snapshot.

## 11. OpenAPI/contract documentation (should)

Every app-facing route should be documented in
`ios-specs/02-API-SPECIFICATION.md` with:

- HTTP method + path
- Request shape (TS interface or zod schema)
- Response shape (TS interface)
- Error codes the route can produce
- Auth requirement (auth middleware vs portal token vs anonymous)

A future improvement is to generate the spec from the code. Until then, the
markdown spec is the contract; iOS reads it and writes decoders against it.

## 12. Local fixture mode (should)

For every domain (training, content, cooking, finance, secretary), the
backend exposes a fixture mode that lets iOS run end-to-end without
provider credentials. The fixture mode:

- Is gated by an explicit env flag (e.g. `NEXUS_FIXTURE_MODE=1`) AND a
  closed-beta build flag.
- Returns deterministic, recognizable data (so a UI test can pin to a
  known value).
- Never writes to production tables.
- Is covered by a smoke test that asserts the fixture mode does NOT
  activate in the production env.

## 13. Smoke evidence (must, for production deploys)

Per `docs/release/continuous-deployment.md`, staging runs the exact signed
candidate's migrator, services, health, and authenticated smoke before any
production mutation. The VPS records that result in root-host release state and
the immutable terminal receipt under `/var/lib/nexus-release/receipts/`, bound
to the source, image pair, Compose, migration verdict, signed evidence, and
release-payload digest.

Ignored `.local` smoke output and CI artifacts may aid diagnosis but are not
runtime truth or deployment authorization. A deploy claim without a validated
immutable host receipt is **rejected** by the release evidence contract.

## 14. Forbidden patterns

- ❌ Modifying `.env`, `data/`, `content-engine/.venv/` from code.
- ❌ Reading user data through `IN (0, ?)` or any platform-seed-merging
   predicate. Strict per-user reads only.
- ❌ Hardcoding the founder's name, email, voice, niche, audience, or
   pillar list in runtime code, prompts, or fixtures. The
   closed-beta-identity-scan blocks this; do not work around the scanner.
- ❌ `console.log` in non-test code. Use `logger.info/warn/error` with
   structured payload.
- ❌ Logging raw tokens, raw OAuth payloads, raw email contents, raw
   calendar contents, raw finance values. The `BackgroundSyncManager`
   redaction tests are the reference for what "redacted" looks like.
- ❌ Editing data on production directly via SQLite shell. Production data
   modifications go through migrations or operator-approved scripts only.
- ❌ Catching an error and returning a `200 OK` body with a "best effort"
   shape. Use the `degraded: true` envelope or fail with the right status
   code.

## 15. PR checklist (per backend change)

- [ ] Route handler stays under 60 lines (or there's an explanatory note).
- [ ] Input validated before authorization.
- [ ] `req.userId === req.tenantId` enforced where JWT-authenticated.
- [ ] Output shaped through a `toDto()` mapper.
- [ ] No mutation in `GET` routes (verified by tests where applicable).
- [ ] Idempotency key accepted for new mutation routes.
- [ ] Migration is append-only and numbered.
- [ ] Migration test asserts post-state.
- [ ] No direct provider SDK call (route through registry).
- [ ] No PII in logs.
- [ ] OpenAPI spec updated under `ios-specs/02-API-SPECIFICATION.md` when
      contract changed.
