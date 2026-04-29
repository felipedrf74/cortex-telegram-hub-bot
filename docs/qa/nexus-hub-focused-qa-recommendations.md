# Nexus Hub — Focused QA Recommendations

**Generated:** 2026-04-29 18:48 WEST
**Source audit:** `docs/qa/nexus-hub-focused-qa-findings.md`
**Risk register:** `docs/qa/nexus-hub-focused-qa-release-risk-register.md`

These recommendations are ordered by **leverage** (number of findings closed × inverse cost), not raw severity. The ordering optimizes for fastest reduction in P0/P1 backlog.

---

## R-1 — One-PR sweep of unscoped content queries (HIGHEST LEVERAGE)

**Closes:** E-P0-1, E-P0-2, E-P0-3, E-P1-1, E-P1-2, E-P1-3 — **6 findings**.

**Effort:** 3-4 hours.

**Action:**
1. Audit `src/services/content-learning-store.ts` and `src/services/content-workflow.ts` for every `SELECT|UPDATE|DELETE` against `content_*` tables. Replace with a call through `contentScopePredicate()` + `contentScopeParams(userId, tenantId)`.
2. Make `userId` and `tenantId` required parameters on every read function (no more `userId?: number`). Where admin context legitimately needs cross-tenant access, add an explicit `adminContext: { actor, tenantId }` parameter and assert the actor's role.
3. Add inline scope assertions in `content-editorial-workflow.ts:366-382` (`getContentWorkflowObject`).
4. Add an adversarial test under `__tests__/scope/content-tenant-isolation.test.ts`: insert a row as user A in tenant 1, attempt to read as user B in tenant 2, assert null/error.

**Acceptance:** All P0/P1 in area E closed; new test green; existing 14-test focused subset still green.

---

## R-2 — Schema migration + saga test coverage (Training operational hardening)

**Closes:** I-P0-1, I-P0-2, I-P1-1, D-P1-1, C-P0-1 — **5 findings**.

**Effort:** 6-8 hours.

**Action:**
1. **New migration:** add `tenant_id TEXT NOT NULL DEFAULT ''` to `training_agenda_event_ownership`; backfill from `fitness_training_plans.tenant_id` (or whichever Training table holds tenant). Update unique index to include `tenant_id`.
2. **New migration:** add `decision_explanation TEXT` to `secretary_agenda_items`. Update `persistDecision` in `secretary-scheduling-arbitrator.ts:505` to write it alongside reason codes.
3. **Replace** `recordCalendarOwnership` pre-check + INSERT with `INSERT OR IGNORE` + always-refetch. Never return null `ownershipId` on the success path.
4. **Fix `local_delete_failed` branch** in `runPrePersistCancellationSaga`: wrap hard-delete in try/catch; on failure, transition `training_agenda_event_ownership` rows to `status='orphaned'`, `reason='local_delete_failed'`.
5. **Write 5 integration tests** in `__tests__/api/training-plan-cancellation.test.ts` covering each saga branch (`success`, `no_active_plan`, `external_partial`, `forbidden`, `local_delete_failed`). Use a real DB fixture, not mocks.

**Acceptance:** Migrations apply cleanly. All 5 saga branches have integration tests. `tenant_id` is enforced on every `training_agenda_event_ownership` insert/query.

---

## R-3 — Defensive guards on coach-kernel inputs (3 P0 crashes closed at once)

**Closes:** D-P0-1, D-P0-2, D-P0-3, A-P0-2 — **4 findings**.

**Effort:** 2-3 hours.

**Action:**
1. `src/services/coach-kernel/adaptation-engine.ts:165` — add early-return: `if (!readiness) return { verdict: 'no_change', explanation: 'no readiness data' };` before the switch.
2. `src/services/coach-kernel/biomechanics-and-ordering.ts:83-89` — assert `athlete.readiness` is defined; early-return if not.
3. `src/services/coach-kernel/session-coherence.ts:298-302` — change `if (claimedMinutes <= 0) return { ok: true, ... }` to `return { ok: false, reason: 'underfilled', ... }`.
4. `src/services/chat-tool-authorization.ts:92-94` — flip `{ allowed: true, ... }` to `{ allowed: false, code: 'AUTH_REQUIRED', ... }`.
5. Add a test for each of the 4 paths.

**Acceptance:** First-launch user with no wearable data does not crash. Tool call without context is denied. All four tests green.

---

## R-4 — Tool allowlist + skill-version + memory authorization gates

**Closes:** A-P0-1, G-P0-1, H-P0-1, H-P0-2 — **4 findings**.

**Effort:** 4-6 hours.

**Action:**
1. **`tool-executor.ts`** — define `const ALLOWED_TOOLS: ReadonlySet<string>` enumerating every dispatchable tool. Reject anything not in the set BEFORE the switch. Add a startup check that `ALLOWED_TOOLS` matches every case in the dispatch switch (or generate one from the other).
2. **`skill-version-registry.ts:328-367`** — add `requirePortalAdminToken()` middleware before `setSkillVersionStatus` and `activateSkillVersion`. Assert `actor.role === 'admin'` in addition to token validity.
3. **`skill-memory.ts:489-505 getSkillMemories`** — when `scope === 'tenant_shared'`, validate the requesting `userId` belongs to `tenantId` via a tenant-membership table or join. Reject if not.
4. **`skill-version-registry.ts:423-466 getActiveSkillVersion`** — cross-check user's existing `skill_memories.schema_version`. If incompatible with the version's `memorySchemaVersion`, reject the activation OR run an automated migration.
5. Adversarial tests for each: unknown-tool denial, non-admin mutation denial, cross-tenant `tenant_shared` denial, schema-incompatible version activation denial.

**Acceptance:** Four adversarial tests green; existing tests still green.

---

## R-5 — Anthropic kill-switch enforcement + routing parity

**Closes:** B-P0-1, B-P1-1, B-P1-2, B-P1-3 — **4 findings**.

**Effort:** 1 dev-day.

**Action:**
1. **Single Anthropic factory.** Create `src/services/anthropic-client-factory.ts` exporting a `getAnthropicClient()` function that consults `isAnthropicRuntimeEnabled()` first and throws on disabled. Replace every `new Anthropic({ ... })` in services/agents with `getAnthropicClient()`. Run `git grep -n "new Anthropic"` after the change to verify zero hits outside the factory.
2. **OpenAI/Gemini per-domain pin support.** Centralize through a `resolveDomainModel(provider, domain)` helper in `model-config.ts`. Update OpenAI/Gemini call sites to call it.
3. **Internal AI proxy.** `src/api/routes/internal.ts:188-205` — replace hardcoded `'claude-haiku-4-5-20251001'` with `getEffectiveDomainModel('anthropic', domain || 'content')` (with the hardcoded value as a final default).
4. **PII scrubber.** Add `redactPiiForClassifier(text)` regex helper covering email, phone, card-like patterns, ID-like patterns. Apply in `classifyMessage` (`src/services/anthropic.ts:910-950`) before the dispatch.
5. Tests: kill-switch test (set `ANTHROPIC_ENABLED=false`, assert all 7 services produce zero Anthropic calls in a soak); per-domain pin test for OpenAI and Gemini; PII redaction test.

**Acceptance:** `git grep -n "new Anthropic"` returns 0 hits outside the factory. Soak test confirms zero Anthropic spend when disabled. Operator pin on a Gemini domain takes effect immediately. Classifier inputs are scrubbed.

---

## R-6 — Provider fallback context safety + observability

**Closes:** A-P1-2, B-P2-1, B-P2-2, B-P2-3, B-P3-1, B-P3-2 — **6 findings (mostly P2/P3)**.

**Effort:** 1 dev-day.

**Action:**
1. **`RoutedPrompt` envelope.** Have `completeOneShotWithFallback` build a single `RoutedPrompt { system, user, hash }` and pass to all fallback paths. Log a warning if a fallback's hash differs.
2. **Circuit breaker integration.** Wire `config.aiSafety.circuitBreaker` into `gemini-provider.ts withRetry`; abort early when domain is in cooldown.
3. **Provider field on `api_usage`.** Add `provider='anthropic'` to the Anthropic INSERT in `anthropic-hook.ts`. Backfill historical NULL rows once.
4. **Portal UI for OpenAI/Gemini pins.** Extend `provider-routes.ts` to expose all three providers, not Anthropic-only.
5. **Kill-switch state observability.** Log `{ event: 'anthropic_kill_switch', enabled }` at startup; add `/api/v1/portal/anthropic-status` GET.
6. **Vision fallback observability.** Add `fallbackAttempts: number` to vision return struct.

**Acceptance:** Circuit breaker prevents retry storms in a forced-failure soak. `api_usage.provider` is populated for all rows. Portal shows all three providers' pins. Kill-switch state is visible.

---

## R-7 — Secretary as scheduler-of-record (architecture, may be deferred)

**Closes:** C-P1-1, C-P1-3, C-P2-1, C-P2-2, F-P1-1, F-P1-4, I-P1-2 — **7 findings**.

**Effort:** 3-5 dev-days. **This is architecture work.**

**Action:**
1. **Implement `submitSchedulingIntent`** as the single entry point for any skill that wants to schedule. Returns an agenda item ID synchronously.
2. **Migrate Training calendar writes** through this entry point. Training never writes `calendar_event_id` directly; Secretary returns the ID after creating the agenda item + provider event.
3. **Secretary lifecycle state coverage.** Map decision states to all 11 lifecycle states. Add tests for each transition.
4. **Cancellation propagation.** Publish `agenda_item_canceled` event on Secretary cancel. Source skills (Training, Cooking, Content) listen and cancel dependent items.
5. **Cross-skill memory invalidation hook** — `markRelatedSignalsStaleOnPlanCancel(userId, planId, planVersion)` called from the cancellation saga.
6. **Unscheduled items: clear times.** When `lifecycle_state` → `unscheduled`, set `startAt = NULL, endAt = NULL`.
7. **External calendar deletion repair.** Periodic `readbackSecretaryProviderEvents()` cron; on 404, transition to `provider_sync_state='readback_failed'`, `lifecycle_state='deferred'`.

**Acceptance:** All Training calendar mutations route through Secretary; all 11 lifecycle states are reachable from orchestration code; cancellation saga test asserts cross-skill memory is marked stale.

**Note:** This work can be split into sub-PRs. R-7.1 = `submitSchedulingIntent` API + Training migration; R-7.2 = lifecycle state coverage; R-7.3 = read-back + invalidation hook.

---

## R-8 — Test coverage backfill (parallel to all fixes)

**Closes:** All test-gap findings (D-P3-2, G-Test-Gap-1, H-P2-1, plus the gaps listed in `qa-test-results.md`).

**Effort:** 1-2 dev-days, can be parallelized with R-1 through R-7.

**Action:**
1. Create `__tests__/scope/` test directory. Add tenant-isolation adversarial tests for every content/memory/agenda read.
2. Create `__tests__/services/coach-kernel/coach-kernel-metrics-history.test.ts` for slice 4.E.
3. Expand `skill-memory.test.ts` to cover every entry in `UNSAFE_MEMORY_PATTERNS` (currently only 1).
4. Add canary-rollout-scope test in `skill-version-registry.test.ts`.
5. Add adversarial tests against P0 paths as part of each fix PR.

**Acceptance:** Every P0 finding has a corresponding adversarial test that fails before the fix and passes after.

---

## R-9 — Defer to follow-up release (with documented exceptions)

The following findings are real but lower-leverage; defer to a post-release work pass with explicit acceptance:

- C-P3-1 (Secretary test coverage gaps): nice-to-have.
- D-P3-1 (parseRepsForTimeEstimate logging): observability nit.
- E-P2-1 (claims grounding LLM extraction): substantial design work; document as a known limitation.
- E-P2-2 (reference health checks): requires background job infrastructure.
- E-P2-3 (workflow rejection observability): observability nit.
- E-P3-1 (internal AI route docs): documentation only.
- F-P1-2, F-P1-3 (signal origin enforcement, warning dedup): real but lower priority than R-1 through R-5.
- G-P2-1 (rollback orchestration helper): operational ergonomics.
- H-P2-2 (correction lineage API): observability ergonomics.
- H-P3-1 (freshness naming): consistency nit.
- I-P3-1 (`owner_user_id` validation): defensive coding nit.

For each, write a follow-up issue with the finding ID and link it in the next release's `docs/release/` notes.

---

## Suggested workstream allocation

| Workstream | Recommended R-blocks | Estimated effort |
|---|---|---|
| Content | R-1 | 3-4 hours |
| Training | R-2, R-3 (D-P0-* parts) | 1-1.5 dev-days |
| Chat | R-3 (A-P0-2), R-4 (A-P0-1) | ~6 hours |
| Platform | R-4 (G-P0-1, H-P0-*), R-5, R-6 | 2 dev-days |
| Secretary + cross-skill | R-7 | 3-5 dev-days (deferable) |
| QA | R-8 (parallel to all) | 1-2 dev-days |

**Total mandatory pre-release effort (R-1 through R-5): 3-4 dev-days**, parallelizable across 4 workstreams to ~1 calendar day with 4 engineers, or ~3 calendar days with 1.

---

## Final recommendation

Land R-1 through R-5 as the explicit release-condition list (closes 19 findings including all 15 P0s and 4 of 20 P1s). Defer R-6 + R-7 + R-9 to follow-up releases with explicit acceptance documentation in `docs/release/` and tracking issues. R-8 should run in parallel — every fix PR ships with its adversarial test.

After R-1 through R-5 land:
- Re-run `npm run verify` (full 5,875 test suite) — must be green.
- Re-run staging smoke (with new saga and external-deletion steps from R-2) — must be green.
- Re-audit the open-blockers list — should drop from 35 to 16 P0/P1 findings.
- The verdict should upgrade from FAIL to **PASS WITH CONDITIONS** (R-7 deferred with documented acceptance).
