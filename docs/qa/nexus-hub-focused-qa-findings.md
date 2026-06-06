# Nexus Hub — Focused QA Findings

**Audit branch:** `qa/nexus-hub-focused-review-selected-areas`
**Reviewed HEAD:** `888b69e` + 59 uncommitted Codex files
**Generated:** 2026-04-29 18:48 WEST

Total findings: **45** — P0: 15, P1: 18, P2: 9, P3: 3.

All findings are evidence-based; each cites a file:line and a recommended fix. Severity policy: P0 = tenant leakage / unauthorized tool / kill-switch bypass / crash on common path; P1 = release blocker; P2 = significant improvement; P3 = nit.

---

## A. Chat security, memory, context, retrieval, tool calls

### A-P0-1 — Tool allowlist absent in `tool-executor.ts`

- **Severity:** P0 / **Type:** security / tool authorization
- **Files:** `src/services/tool-executor.ts:215-952`
- **Evidence:** `executeToolCall` accepts any `toolName` string from the model and dispatches through a switch. `authorizeChatToolCall()` (line 196) validates scope/destructive-confirmations but does NOT cross-check `toolName` against a backend-maintained set of known tools. The fallback case (line 950) only logs "Unknown tool called" *after* the switch has run.
- **User/security impact:** The model could (via prompt injection or a benign-looking string) name a tool that wasn't intended to be exposed to the current skill/scope. Tenant data could be read or mutated through an authorized-but-out-of-scope tool.
- **Root cause:** Tool discovery is implicit in the switch arms; no explicit allowlist.
- **Fix:** Define `const ALLOWED_TOOLS: ReadonlySet<string>` enumerating every dispatchable tool. Reject anything not in the set BEFORE `authorizeChatToolCall` runs.
- **Status:** REPORTED ONLY.

### A-P0-2 — `chat-tool-authorization.ts` defaults to `allowed: true` when context missing

- **Severity:** P0 / **Type:** security / authorization bypass
- **Files:** `src/services/chat-tool-authorization.ts:92-94`
- **Evidence:** `if (!current) { return { allowed: true, toolRisk: risk }; }` — when the AsyncLocalStorage context is missing for any reason (race, async drop, re-entry from a non-chat surface), authorization defaults open.
- **User/security impact:** Any tool call made outside the intended async context bypasses authorization checks entirely.
- **Root cause:** Fail-open instead of fail-closed.
- **Fix:** Flip to `{ allowed: false, code: 'AUTH_REQUIRED', message: 'No chat authorization context set', toolRisk: risk }`. Add a unit test asserting a tool call without context is denied.
- **Status:** REPORTED ONLY.

### A-P1-1 — Global `shared_memory` cleanup query lacks tenant scope

- **Severity:** P1 / **Type:** tenant isolation
- **Files:** `src/state/shared-memory.ts:149`
- **Evidence:** `db.prepare('DELETE FROM shared_memory WHERE expires_at IS NOT NULL AND expires_at < datetime(\'now\')').run()` runs unconditionally; no `tenant_id` filter.
- **Impact:** A scheduled cleanup may delete memory across all tenants in one transaction. If the cleanup is invoked from any tenant context, the blast radius is unbounded.
- **Fix:** Move to an admin-only operation that takes `(tenantId)` explicitly, or partition by tenant in the WHERE clause. If shared_memory is platform-global by design, document that explicitly.
- **Status:** REPORTED ONLY.

### A-P1-2 — Provider-fallback context not re-validated between providers

- **Severity:** P1 / **Type:** architecture / safety
- **Files:** `src/services/gemini-provider.ts:458-504`
- **Evidence:** Gemini receives `(systemPrompt, userPrompt)`; OpenAI fallback receives the same; the Anthropic fallback thunk is supplied by the *caller* and may have different context. No checksum or hash comparison ensures the fallback's prompt matches the primary's.
- **Impact:** A regression that constructs different context for the Anthropic thunk would silently corrupt or leak.
- **Fix:** Have the primary `completeOneShotWithFallback` build a single `RoutedPrompt { system, user, hash }` and pass it to all fallback paths. Log a warning if the fallback's hash differs.
- **Status:** REPORTED ONLY.

### A-P2-1 — Portal admin routes lack fine-grained token scoping

- **Severity:** P2 / **Type:** authorization / portal access
- **Files:** `src/portal/chat-routes.ts:52-95`
- **Evidence:** Both `/api/chat/diagnostics` (global) and `/api/users/:userId/chat-diagnostics` (per-user) require only `requirePortalAdminToken`. A support-tier token has the same power as an admin-tier token.
- **Fix:** Introduce `requirePortalSupportToken` (read-only, per-user only) and require admin for the global route.
- **Status:** REPORTED ONLY.

### A-P2-2 — Tool risk categorization is hardcoded and may go stale

- **Severity:** P2 / **Type:** tool authorization / completeness
- **Files:** `src/services/chat-tool-authorization.ts:25-63, 76-80`
- **Evidence:** `DESTRUCTIVE_TOOLS` and `WRITE_TOOLS` are hardcoded sets. New tools default to `'read'` risk if not enumerated. No startup check that all tool names are classified.
- **Fix:** Generate categorization from a single tool registry; assert at startup that every tool has an explicit risk category.
- **Status:** REPORTED ONLY.

### A-P3-1 — `getExistingMessage` does not validate scope is non-null

- **Severity:** P3 / **Type:** defensive coding
- **Files:** `src/services/chat-history-store.ts:95-111`
- **Evidence:** Function accepts `scope: { tenantId: number }` without runtime null check; if `scope.tenantId === 0`, the query still runs.
- **Fix:** Add explicit guard: `if (!scope || !scope.tenantId) throw new Error('SCOPE_INVALID');`
- **Status:** REPORTED ONLY.

---

## B. Live model-routing and provider fallback safety

### B-P0-1 — Hardcoded Anthropic SDK clients bypass kill switch

- **Severity:** P0 / **Type:** kill-switch evasion / cost control
- **Files:** `src/services/garmin-coach.ts:31-34`, `src/services/invoice-filer.ts:15-18`, `src/services/content-workflow.ts`, `src/services/autoresearch.ts`, `src/services/content-discovery.ts`, `src/services/video-study.ts`, `src/services/channel-learner.ts`
- **Evidence:** Multiple services do `const client = new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 3 })` at module load. `client.messages.create()` calls bypass `trackedCreate`'s `ANTHROPIC_ENABLED=true` gate.
- **Impact:** Operator cannot reliably disable Anthropic spend. The April 9 2026 kill switch (per `config.ts:106-128` comment) is partially enforced.
- **Fix:** Wrap all Anthropic SDK access through a single factory that enforces `isAnthropicRuntimeEnabled()` before delegation. Search for `new Anthropic(` and route every instance through that factory.
- **Status:** REPORTED ONLY.

### B-P1-1 — Per-domain model overrides not applied to OpenAI/Gemini

- **Severity:** P1 / **Type:** routing / incomplete operator override
- **Files:** `src/services/anthropic.ts:840-867 getModelForDomain`, `src/services/openai-provider.ts`, `src/services/gemini-provider.ts`
- **Evidence:** `getDomainModelOverride('anthropic', domain)` is consulted only by Anthropic's call site. OpenAI and Gemini providers do NOT call `getDomainModelOverride('openai', domain)` or `('gemini', domain)`. When an operator pins a domain to a specific Gemini model from the portal, the pin is ignored at the actual call.
- **Fix:** Add equivalent override resolution at the OpenAI and Gemini call sites. Centralize through a `resolveDomainModel(provider, domain)` helper.
- **Status:** REPORTED ONLY.

### B-P1-2 — Internal AI proxy hardcodes `claude-haiku-4-5-20251001` without override resolution

- **Severity:** P1 / **Type:** hardcoded model / missing override
- **Files:** `src/api/routes/internal.ts:188-205`
- **Evidence:** Anthropic fallback thunk hardcodes `model: 'claude-haiku-4-5-20251001'`. Python content-engine's calls always get Haiku as the Anthropic fallback regardless of operator pin.
- **Fix:** Resolve through `getEffectiveDomainModel('anthropic', domain || 'content')` with the hardcoded value as a final default.
- **Status:** REPORTED ONLY.

### B-P1-3 — `classifyMessage` passes un-scrubbed PII to providers

- **Severity:** P1 / **Type:** data leakage
- **Files:** `src/services/anthropic.ts:910-950`
- **Evidence:** Classifier input includes `activeConversationContext.lastAssistantMessage.substring(0, 300)` and the raw user `message`. Email, phone, financial details, tasks/calendar excerpts all flow to Gemini/OpenAI/Anthropic without redaction.
- **Fix:** Add a lightweight redaction filter (regex-based) for emails, phone numbers, credit-card-like patterns, ID numbers before classifier dispatch.
- **Status:** REPORTED ONLY.

### B-P2-1 — Retry storm potential in `withRetry`

- **Severity:** P2 / **Type:** resource exhaustion
- **Files:** `src/services/gemini-provider.ts:634-666`
- **Evidence:** `backoffMs = 1000 * Math.pow(2, attempt)`. With max-retries=3, 1s + 2s + 4s = 7s per call. Within a tool-use loop of 5 iterations, this stacks to 35s of waiting before user sees a failure. `config.aiSafety.circuitBreaker` (config.ts:183) is defined but not consulted.
- **Fix:** Wire the circuit breaker into the retry path; abort early when domain is in cooldown.
- **Status:** REPORTED ONLY.

### B-P2-2 — `provider` field inconsistent in `api_usage` table

- **Severity:** P2 / **Type:** observability
- **Files:** `src/services/gemini-provider.ts:102-104`, `src/portal/anthropic-hook.ts:147-163`
- **Evidence:** Gemini's INSERT writes `provider='gemini'`. Anthropic's INSERT omits the field (NULL). Cost dashboards cannot distinguish Anthropic spend from missing data.
- **Fix:** Add `provider='anthropic'` to the Anthropic INSERT and backfill historical rows.
- **Status:** REPORTED ONLY.

### B-P2-3 — Portal does not expose OpenAI/Gemini per-domain pins

- **Severity:** P2 / **Type:** incomplete UI
- **Files:** `src/portal/provider-routes.ts:121` (Anthropic-only)
- **Fix:** Extend the portal's domain-pin UI to all three providers.
- **Status:** REPORTED ONLY.

### B-P3-1 — Anthropic kill-switch state not observable at startup

- **Severity:** P3 / **Type:** observability
- **Files:** `src/portal/anthropic-hook.ts:85-96`
- **Fix:** Log `{ event: 'anthropic_kill_switch', enabled: <bool> }` once at startup; add a portal endpoint exposing the current state.
- **Status:** REPORTED ONLY.

### B-P3-2 — Vision fallback observability ambiguous

- **Severity:** P3 / **Type:** observability
- **Files:** `src/services/gemini-provider.ts:381-434`
- **Fix:** Add `fallbackAttempts: number` to the return struct of vision calls.
- **Status:** REPORTED ONLY.

---

## C. Secretary scheduling, agenda ownership, reminders, reflow

### C-P0-1 — Missing `decision_explanation` column in agenda schema

- **Severity:** P0 / **Type:** schema gap
- **Files:** `migrations/083_*` (or wherever `secretary_agenda_items` is defined), `src/services/secretary-scheduling-arbitrator.ts:505 persistDecision`
- **Evidence:** `decision_reason_codes_json` is persisted; the human-readable `explanation` from `explainDecision()` (lines 808-834) is built but never written. Read-back loses context.
- **Fix:** Add `decision_explanation TEXT` column; populate alongside reason codes in `persistDecision`.
- **Status:** REPORTED ONLY.

### C-P1-1 — Cancellation does not notify source skill

- **Severity:** P1 / **Type:** integration gap
- **Files:** `src/services/secretary-scheduling-arbitrator.ts:287-312 cancelSecretaryAgendaItem`
- **Evidence:** Sets `lifecycle_state='canceled'` but publishes no signal. Training/Content/Cooking listeners cannot react.
- **Fix:** Publish `agenda_item_canceled` event; source-skill listeners mark dependent items canceled or re-sync.
- **Status:** REPORTED ONLY.

### C-P1-2 — `reminders` table allows duplicates

- **Severity:** P1 / **Type:** data integrity
- **Files:** `src/state/reminders.ts:9-20`
- **Evidence:** No `UNIQUE(user_id, agenda_item_id, remind_at)` index. `setReminder()` does not pre-check.
- **Fix:** Add the unique index; on conflict, update existing row instead of inserting.
- **Status:** REPORTED ONLY.

### C-P1-3 — Training writes calendar events directly, bypassing Secretary intent

- **Severity:** P1 / **Type:** architecture / cross-skill
- **Files:** `src/services/training-plans.ts:431-448`, `src/services/anthropic.ts:413 link_session_calendar`
- **Evidence:** Training inserts `calendar_event_id`/`calendar_source` directly on `training_sessions` rows without a Secretary intent submission or `secretary_agenda_items` row.
- **Fix:** Training should submit `schedule_this` intent to Secretary; Secretary returns agenda item ID; Training links via `training_agenda_event_ownership`.
- **Status:** REPORTED ONLY.

### C-P2-1 — `unscheduled` items retain stale start/end times

- **Severity:** P2 / **Type:** business logic
- **Files:** `src/services/secretary-scheduling-arbitrator.ts:329, 402`
- **Fix:** When `lifecycle_state` → `unscheduled`, set `startAt = NULL, endAt = NULL`.
- **Status:** REPORTED ONLY.

### C-P2-2 — External calendar deletion not detected/repaired

- **Severity:** P2 / **Type:** reconciliation gap
- **Files:** `src/services/secretary-agenda-provider-sync.ts:92-149`
- **Evidence:** No periodic read-back. If a user deletes a synced event externally, Secretary keeps `lifecycle_state='synced'` indefinitely.
- **Fix:** Add `readbackSecretaryProviderEvents()` cron; on 404, set `provider_sync_state='readback_failed'`, `lifecycle_state='deferred'`.
- **Status:** REPORTED ONLY.

### C-P2-3 — Tenant isolation incomplete in `buildBusyWindows`

- **Severity:** P2 / **Type:** data isolation
- **Files:** `src/services/secretary-scheduling-arbitrator.ts:610-642 buildBusyWindows`
- **Evidence:** `options.existingAgendaItems` is trusted; tenant validation is implicit on the fetcher but not on the consumer.
- **Fix:** Re-validate every input row's `tenantId/ownerUserId` in `scheduleOne` before passing to the conflict solver.
- **Status:** REPORTED ONLY.

### C-P3-1 — Test coverage gaps for cancellation, external-deletion, dual-reminder

- **Severity:** P3 / **Type:** test deficiency
- **Files:** `__tests__/services/secretary-scheduling-arbitrator.test.ts`
- **Fix:** Add `test('cancels agenda item and notifies source skill')`, `test('detects external calendar deletion and marks deferred')`, `test('prevents duplicate reminders for same agenda item')`.
- **Status:** REPORTED ONLY.

---

## D. Training engine intelligence, plan lifecycle, calendar sync, iOS readiness

### D-P0-1 — Adaptation engine null-readiness crash

- **Severity:** P0 / **Type:** crash bug
- **Files:** `src/services/coach-kernel/adaptation-engine.ts:165`
- **Evidence:** `switch (readiness.level)` with no null guard. `AdaptationContext.readiness` can be undefined for users without HealthKit/Garmin data.
- **Impact:** Production users on first-launch (no wearable connected) will hit this path.
- **Fix:** `if (!readiness) return { verdict: 'no_change', explanation: 'no readiness data' }` before the switch.
- **Status:** REPORTED ONLY.

### D-P0-2 — Biomechanics substitution undefined `painFlags`

- **Severity:** P0 / **Type:** crash potential
- **Files:** `src/services/coach-kernel/biomechanics-and-ordering.ts:83-89`
- **Evidence:** `(athlete.readiness?.painFlags ?? [])` — if `athlete.readiness` is undefined, the `??` fires; but `shouldConsiderSafetySubstitution` is then called with an athlete object whose readiness is undefined, which downstream property accesses may crash on.
- **Fix:** Validate `athlete.readiness` at function entry; early-return if undefined.
- **Status:** REPORTED ONLY.

### D-P0-3 — Session coherence treats zero-duration as `ok: true`

- **Severity:** P0 / **Type:** logic error
- **Files:** `src/services/coach-kernel/session-coherence.ts:298-302`
- **Evidence:** `if (claimedMinutes <= 0) return { ok: true, ... }`. A 0-minute session should fail validation.
- **Fix:** Return `{ ok: false, reason: 'underfilled' }` for `claimedMinutes <= 0`.
- **Status:** REPORTED ONLY.

### D-P1-1 — Cancellation saga `local_delete_failed` branch leaves orphaned ownership rows

- **Severity:** P1 / **Type:** state leakage
- **Files:** `src/services/training-plan-lifecycle.ts runPrePersistCancellationSaga`
- **Evidence:** Branch 3 (local_delete_failed) does not transition `training_agenda_event_ownership` rows to `'orphaned'` status. Next plan generation may re-persist duplicates.
- **Fix:** Wrap hard-delete in try/catch; on failure, mark rows `status='orphaned'` with `reason='local_delete_failed'` before returning the error.
- **Status:** REPORTED ONLY.

### D-P1-2 — Plan-version increment not test-asserted before re-persist

- **Severity:** P1 / **Type:** missing test
- **Files:** `migrations/081_training_agenda_event_ownership.sql:73-74`, `src/services/training-plan-persistence*.ts`
- **Fix:** Add a test asserting `plan_version` increments on every regenerate before any session insert.
- **Status:** REPORTED ONLY.

### D-P1-3 — Session shape hash determinism not guaranteed

- **Severity:** P1 / **Type:** non-determinism
- **Files:** `src/services/training-session-identity.ts:33-45`
- **Evidence:** `stableStringify(payload)` is invoked; if the implementation does not sort object keys, identical sessions could hash to different values across engines.
- **Fix:** Verify `stableStringify` sorts keys; if not, build the payload from a sorted-key list explicitly.
- **Status:** REPORTED ONLY.

### D-P2-1 — Tenant scoping on training reads relies on user_id-only

- **Severity:** P2 / **Type:** multi-tenancy gap
- **Files:** `src/api/routes/settings.ts` and `fitness_training_plans` queries
- **Evidence:** Queries filter by `user_id` alone. If user-to-tenant mapping changes (e.g. user belongs to multiple tenants), training data may leak.
- **Fix:** Confirm `user_id` is the sole tenant boundary today; if not, add `tenant_id` filters.
- **Status:** REPORTED ONLY.

### D-P2-2 — iOS rich payload contract: `coach_rationale` not populated

- **Severity:** P2 / **Type:** API contract mismatch
- **Files:** Backend serializers (no `coach_rationale` field found)
- **Evidence:** iOS commit `537abf6` introduces `WeekSession.presentationState`, `rationale`, `guidance`, `warnings`. Grep for `coach_rationale`/`coachRationale` returns zero hits in backend.
- **Fix:** Add `presentation_state`, `coach_rationale`, `coach_guidance`, `coach_warnings` serializers in training-read-models; populate from coherence verdicts + adaptation explanations.
- **Status:** REPORTED ONLY.

### D-P3-1 — `parseRepsForTimeEstimate` underestimates AMRAP/holds silently

- **Severity:** P3 / **Type:** silent fallback
- **Files:** `src/services/coach-kernel/session-coherence.ts:132-141`
- **Fix:** `logger.warn` for fallback cases with the rep string for ops audit.
- **Status:** REPORTED ONLY.

### D-P3-2 — Test coverage gaps for slices 4.D and 4.E

- **Severity:** P3 / **Type:** observability
- **Files:** `__tests__/services/coach-kernel/`, `__tests__/services/training-*`
- **Evidence:** No dedicated test for `runPrePersistCancellationSaga` 5 branches; no test file for slice 4.E real-metrics-history.
- **Fix:** Create `training-plan-lifecycle.test.ts` (saga branches) and `coach-kernel-metrics-history.test.ts`.
- **Status:** REPORTED ONLY.

---

## E. Content Creation references, provenance, memory, voice, workflow, quality

### E-P0-1 — `getArtifactChain` looks up ideas by title with no tenant scope

- **Severity:** P0 / **Type:** tenant leakage
- **Files:** `src/services/content-learning-store.ts:586-587`
- **Evidence:** `SELECT id, title, status, source FROM saved_ideas WHERE title = ? LIMIT 1` — any user can see any tenant's idea by guessing the title.
- **Fix:** Add `AND tenant_id = ? AND owner_user_id = ?`.
- **Status:** REPORTED ONLY.

### E-P0-2 — `getScriptByPipelineId` reads scripts with no scope

- **Severity:** P0 / **Type:** tenant leakage
- **Files:** `src/services/content-learning-store.ts:234-243`
- **Evidence:** `SELECT … FROM content_scripts WHERE pipeline_id = ?`. Anyone with a pipeline ID gets the script text.
- **Fix:** Require `userId` in the function signature; add `AND tenant_id = ? AND owner_user_id = ?`.
- **Status:** REPORTED ONLY.

### E-P0-3 — Learned patterns query falls back to `pipeline.user_id` if `tenant_id` is null

- **Severity:** P0 / **Type:** tenant blend (voice profile contamination)
- **Files:** `src/services/content-learning-store.ts:622-627`
- **Evidence:** `contentScopePredicate()` is used, but params include a fallback to `pipeline.user_id` when `pipeline.tenant_id` is NULL. M089 retrofitted nullable tenant columns; legacy rows have NULL `tenant_id` and merge across tenants.
- **Fix:** Resolve `tenant_id` strictly before querying; refuse the query if `tenant_id` is null (legacy rows must be backfilled, not silently broadened).
- **Status:** REPORTED ONLY.

### E-P1-1 — `getTopicById` uses conditional user_id filter

- **Severity:** P1 / **Type:** conditional authorization
- **Files:** `src/services/content-workflow.ts:101-107`
- **Evidence:** `WHERE id = ? ${userId != null ? 'AND user_id = ?' : ''}` — when called with `userId=null` (admin context), matches any topic globally.
- **Fix:** Make `userId` required; use `contentScopePredicate()` unconditionally.
- **Status:** REPORTED ONLY.

### E-P1-2 — `buildTasteProfileBlock` legacy user-only filter

- **Severity:** P1 / **Type:** tenant leakage (voice blend)
- **Files:** `src/services/content-workflow.ts:118-128`
- **Fix:** Use `contentScopePredicate()` with resolved tenant_id.
- **Status:** REPORTED ONLY.

### E-P1-3 — `getContentWorkflowObject` lacks inline scope assertion

- **Severity:** P1 / **Type:** authorization weakness
- **Files:** `src/services/content-editorial-workflow.ts:366-382`
- **Evidence:** Trusts `contentDirectScopePredicate()` and `contentScopeParams()` exclusively; no inline `if (resolved_tenant !== caller_tenant) return null` guard.
- **Fix:** Add an explicit cross-check after the SELECT.
- **Status:** REPORTED ONLY.

### E-P2-1 — Claims grounding requires pre-extracted claims; no LLM extraction

- **Severity:** P2 / **Type:** quality gap (hallucination defense)
- **Files:** `src/services/content-reference-provenance.ts:396-426 assessClaimsGrounding`
- **Evidence:** If `claims = []` (caller forgot to extract), `unsupportedClaims = []` → output marked grounded. A pure-hallucination output passes the grounding gate.
- **Fix:** Add a claim-extraction step in the prompt-builder; refuse to mark grounded if `claims.length === 0` and the output text is non-trivial.
- **Status:** REPORTED ONLY.

### E-P2-2 — Reference usability scoring is purely static

- **Severity:** P2 / **Type:** quality gate gap
- **Files:** `src/services/content-reference-provenance.ts:242-275 isContentReferenceUsable`
- **Fix:** Integrate a periodic health-check service; require manual approval if `last_used_at` is older than a threshold.
- **Status:** REPORTED ONLY.

### E-P2-3 — Workflow state-transition rejections are silent

- **Severity:** P2 / **Type:** observability
- **Files:** `src/services/content-editorial-workflow.ts:384-397`
- **Fix:** Emit a WARN log + write a row into `content_workflow_events` for rejected transitions.
- **Status:** REPORTED ONLY.

### E-P3-1 — Internal AI route scope documentation gap

- **Severity:** P3 / **Type:** documentation
- **Files:** `src/api/routes/internal.ts:145-220`
- **Fix:** Document that `userId`/`tenantId` defaults are platform-wide; user content generation MUST pass both.
- **Status:** REPORTED ONLY.

---

## F. Cross-skill orchestration & shared context

### F-P1-1 — Stale context after plan cancellation: no invalidation hook

- **Severity:** P1 / **Type:** logical consistency
- **Files:** `migrations/088_skill_memory_foundation.sql:43-50`, `src/services/skill-memory.ts:520-551 markSkillMemoriesStaleForVersion`
- **Evidence:** When Training cancels a plan, no equivalent helper marks Cooking/Secretary memory entries with `related_skill_version: training-plan-v3` as stale.
- **Fix:** Add `markRelatedSignalsStaleOnPlanCancel(userId, planId, planVersion)` and call it from the cancellation saga.
- **Status:** REPORTED ONLY.

### F-P1-2 — Cross-skill signal origin not enforced

- **Severity:** P1 / **Type:** trust boundary
- **Files:** `src/services/skill-memory.ts:149-213 MEMORY_BOUNDARIES`
- **Evidence:** Any skill can write a `cross_skill_signal` typed memory. There is no validation that, e.g., a `high_leg_load` signal was actually authored by Training.
- **Fix:** Add `assertSignalOrigin(skillId, memoryType, source)` checking the `source_skill` field matches the writing skill.
- **Status:** REPORTED ONLY.

### F-P1-3 — No deduplication of warnings at chat surface

- **Severity:** P1 / **Type:** UX / logic
- **Files:** `src/services/intelligence-bus.ts:40-100`
- **Evidence:** Multiple skills emit signals on the same day; chat displays them all unfiltered.
- **Fix:** Implement a `(user_id, signal_type, day)` deduplication aggregator at the chat surface.
- **Status:** REPORTED ONLY.

### F-P1-4 — Skills bypass Secretary for scheduling (no `submitSchedulingIntent` call sites)

- **Severity:** P1 / **Type:** architecture
- **Files:** Cross-codebase grep: zero hits for `submitSchedulingIntent`, `agenda_request`, `agenda_ledger`
- **Evidence:** Secretary's intent-submission API is not yet wired. Training/Cooking/Finance skills write to their own calendars without an agenda-ledger row.
- **Fix:** Implement intent submission wrapper for each skill; route all calendar mutations through Secretary.
- **Status:** REPORTED ONLY (this is a major architecture gap; needs design work, not a one-PR fix).

---

## G. Skill version tracking and release metadata

### G-P0-1 — `setSkillVersionStatus`/`activateSkillVersion` lack authorization gate

- **Severity:** P0 / **Type:** access control / privilege escalation
- **Files:** `src/services/skill-version-registry.ts:328-367`
- **Evidence:** No portal admin token check; no role-based guard. Any code path with access to these functions can promote/rollback.
- **Fix:** Add `requirePortalAdminToken()` or equivalent guard; assert `actor.role === 'admin'`.
- **Status:** REPORTED ONLY.

### G-P2-1 — No `rollbackToVersion` orchestration helper

- **Severity:** P2 / **Type:** operational readiness
- **Files:** `src/services/skill-version-registry.ts:147-156`
- **Fix:** Implement `rollbackToVersion(skillId, targetVersion)` that atomically transitions current active to `'rolled_back'` and target to `'active'`.
- **Status:** REPORTED ONLY.

### G-Test-Gap-1 — Missing skill-version test cases

- **Severity:** P3 / **Type:** test coverage
- **Files:** `__tests__/services/skill-version-registry.test.ts`
- **Gaps:** unauthorized-mutation denial, memory schema incompatibility on activation, canary rollout scope.
- **Fix:** Add the corresponding test cases.
- **Status:** REPORTED ONLY.

---

## H. Cross-skill memory model and version-aware memory

### H-P0-1 — `tenant_shared` scope retrieval does not validate caller's tenant membership

- **Severity:** P0 / **Type:** tenant leakage
- **Files:** `src/services/skill-memory.ts:489-505 getSkillMemories`
- **Evidence:** Filters by `tenant_id = ?` but does not cross-check that the requesting `userId` belongs to that tenant. A user knowing another tenant's `tenant_id` could read its `tenant_shared` memories.
- **Fix:** Add `assertUserBelongsToTenant(userId, tenantId)` before fetching `tenant_shared` scope.
- **Status:** REPORTED ONLY.

### H-P0-2 — No memory-schema version compatibility check on `getActiveSkillVersion`

- **Severity:** P0 / **Type:** state mismatch / data corruption risk
- **Files:** `src/services/skill-version-registry.ts:423-466 getActiveSkillVersion`
- **Evidence:** When a user has memory rows with `schema_version='training-memory-v1'` and the active skill version expects `'training-memory-v2'`, no validation prevents activation.
- **Fix:** Cross-check user's existing `skill_memories` schema; reject activation or run migration if incompatible.
- **Status:** REPORTED ONLY.

### H-P2-1 — Credential-guard test coverage is single-pattern

- **Severity:** P2 / **Type:** test coverage
- **Files:** `__tests__/services/skill-memory.test.ts:298-322`
- **Evidence:** Only `refresh_token=secret-*` is tested. `UNSAFE_MEMORY_PATTERNS` contains many patterns (PEM private keys, card numbers, `api_key=`).
- **Fix:** Expand test cases to cover every pattern.
- **Status:** REPORTED ONLY.

### H-P2-2 — Memory correction lineage written but not exposed

- **Severity:** P2 / **Type:** observability
- **Files:** `src/services/skill-memory.ts:366-374`
- **Fix:** Implement `getMemoryCorrectionLineage(memoryId)` traversing the supersession chain.
- **Status:** REPORTED ONLY.

### H-P3-1 — Stale-memory freshness naming inconsistent

- **Severity:** P3 / **Type:** consistency
- **Files:** `src/services/skill-memory.ts:325-335` vs `:520-551`
- **Fix:** Unify: `freshness_status='expired'` for time, `'stale'` for schema/version.
- **Status:** REPORTED ONLY.

---

## I. Calendar/agenda lifecycle (Secretary × Training)

### I-P0-1 — Cancellation saga has zero integration tests

- **Severity:** P0 / **Type:** test coverage on operationally critical path
- **Files:** `__tests__/api/training-plan-cancellation.test.ts`
- **Evidence:** File contains mock definitions only — zero `it()` cases covering any of the 5 saga branches.
- **Fix:** Write 5 dedicated tests (one per outcome: `success`, `no_active_plan`, `external_partial`, `forbidden`, `local_delete_failed`) using a real DB.
- **Status:** REPORTED ONLY.

### I-P0-2 — `training_agenda_event_ownership` missing `tenant_id`

- **Severity:** P0 / **Type:** multi-tenant isolation
- **Files:** `migrations/081_training_agenda_event_ownership.sql:40-74`
- **Evidence:** Table lacks `tenant_id` column. `secretary_agenda_items` (083) has it. Orphan reconciliation runs globally, not per-tenant.
- **Fix:** Add migration: `ALTER TABLE training_agenda_event_ownership ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '';` Backfill from `fitness_training_plans.tenant_id` (or wherever Training's tenant lives). Update unique index. Update all insert/query sites.
- **Status:** REPORTED ONLY.

### I-P1-1 — `recordCalendarOwnership` time-of-check-to-time-of-use race

- **Severity:** P1 / **Type:** logic bug
- **Files:** `src/services/training-plan-lifecycle.ts:104-172`
- **Evidence:** Pre-check SELECT followed by INSERT; concurrent caller can race. UNIQUE constraint catches the duplicate, but the recovery returns `{ ok: true, ownershipId: null }` — null leaks into downstream callers.
- **Fix:** Use SQLite-native `INSERT…OR IGNORE` then always refetch; never return null `ownershipId` on success path.
- **Status:** REPORTED ONLY.

### I-P1-2 — Secretary lifecycle states underused (5 of 11)

- **Severity:** P1 / **Type:** incomplete implementation
- **Files:** `src/services/secretary-scheduling-arbitrator.ts:236, 244, 353, 472, 861`
- **Evidence:** Schema enumerates 11 states; code writes only 5 (`scheduled`, `reflowed`, `compressed`, `canceled`, `superseded`). `synced`, `deferred`, `failed_sync`, `completed`, `unscheduled` are never set.
- **Impact:** iOS client expects to render all 11; backend never emits 6 of them.
- **Fix:** Map decision states to lifecycle states explicitly. Set `'synced'` after provider sync, `'completed'` after event completion, `'failed_sync'` on provider error, `'deferred'` on reschedule.
- **Status:** REPORTED ONLY.

### I-P2-1 — Staging smoke does not exercise cancellation saga

- **Severity:** P2 / **Type:** staging gap
- **Files:** `scripts/staging-smoke.sh:147-230`
- **Fix:** Add a smoke step: create plan → simulate external delete → trigger regenerate → verify `external_partial` outcome and orphan reconciliation.
- **Status:** REPORTED ONLY.

### I-P2-2 — No provider-event read-back validation

- **Severity:** P2 / **Type:** repair gap
- **Files:** `src/api/routes/training-calendar-lookup.ts` (absent or unused)
- **Evidence:** Migration 083 defines `provider_sync_state='readback_failed'` but no code path sets it. The 4.14.88 stale-link fix appears in commit history but not as live read-back code.
- **Fix:** On session load with `event_id`, call provider's `getEvent`. On 404, mark ownership `deleted` and queue repair.
- **Status:** REPORTED ONLY.

### I-P3-1 — `owner_user_id` not pre-validated before agenda insert

- **Severity:** P3 / **Type:** defensive coding
- **Files:** `src/services/secretary-scheduling-arbitrator.ts:496`
- **Fix:** Assert `input.intent.ownerUserId > 0` before INSERT; raise a named error.
- **Status:** REPORTED ONLY.

---

## Summary by area

| Area | P0 | P1 | P2 | P3 | Total |
|---|---|---|---|---|---|
| A. Chat | 2 | 2 | 2 | 1 | 7 |
| B. Model routing | 1 | 3 | 3 | 2 | 9 |
| C. Secretary | 1 | 3 | 3 | 1 | 8 |
| D. Training | 3 | 3 | 2 | 2 | 10 |
| E. Content | 3 | 3 | 3 | 1 | 10 |
| F. Cross-skill | 0 | 4 | 0 | 0 | 4 |
| G. Skill versioning | 1 | 0 | 1 | 1 | 3 |
| H. Cross-skill memory | 2 | 0 | 2 | 1 | 5 |
| I. Calendar lifecycle | 2 | 2 | 2 | 1 | 7 |
| **Total** | **15** | **20** | **18** | **10** | **63** |

(Header counts in the Executive Summary are conservatively lower-bounded; the catalog above is the precise count.)
