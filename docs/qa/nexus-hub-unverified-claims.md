# Nexus Hub — Unverified Claims (Round 2)

**Generated:** 2026-04-30
**Audit:** second-round QA gap review at HEAD `414383b`

Claims from the prior QA + remediation chain that **still lack sufficient evidence** after round 2. Each is graded by the gap between what was claimed and what exists.

## P0 unverified claims

### UC-1 — "Block 5 Cross-Skill Scheduling: Training plan persistence routes through Secretary"

- **Source:** `docs/release/qa-remediation-progress.md:184-187`
- **Claim:** "Training plan persistence now submits a Secretary-owned scheduling intent before creating a provider calendar event."
- **Evidence found:** `__tests__/api/training-plan-persistence.test.ts:189-191` asserts `mockSubmitSecretarySchedulingIntent` called BEFORE `mockCreateEvent` for the **plan-generation** path.
- **Evidence missing:** The doc itself says "Training calendar-sync backfill still contains direct sync/update paths." `src/api/routes/training-plan-calendar-sync.ts:513` calls `createTrainingCalendarEvent` with NO `submitSecretarySchedulingIntent` upstream. Active route `/training/plan/sync-calendar` is reachable; not feature-gated.
- **Why this matters:** The remediation closure is partial. A user invoking `/training/plan/sync-calendar` writes provider events with no Secretary arbitration — exactly the invariant the audit said was closed.
- **Recommended validation:** Either route the legacy backfill through Secretary OR explicitly mark this route as deferred in `nexus-hub-second-round-open-blockers.md`.

### UC-2 — "Block 5 closes C-OPUS-P0-1: lifecycle never advances"

- **Source:** `docs/release/qa-remediation-progress.md:159-162`
- **Claim:** "Provider sync success now maps agenda lifecycle to `synced`. Provider failures map to `failed_sync`. `markCompletedSecretaryAgendaItems()` flips ended items to `completed`."
- **Evidence found:** `__tests__/services/secretary-agenda-provider-sync.test.ts` has dedicated tests for each (`synced` 178-208, `failed_sync` 358-384, `completed` 386-407).
- **Evidence missing:** No test for **the full state graph reachability** from the orchestration code — i.e., starting from a real `submitSecretarySchedulingIntent` flow, does the system actually transition through `proposed → scheduled → synced → completed` or `synced → reflowed → synced → completed` without dropping a state? Each state has a unit test but no integration test stitches them.
- **Why this matters:** Unit tests prove each transition writes the correct value; integration test would prove no orchestration path skips one.
- **Recommended validation:** End-to-end test: create intent → schedule → sync → reflow → sync → complete; assert `lifecycle_state` history matches expected sequence.

### UC-3 — "Cross-skill stale signal on plan cancel" (covered implicitly)

- **Source:** Multiple round-1 findings (F-P1-1, ADV-5)
- **Claim implied by remediation closure of Block 8:** "Block 8 — P1 Backlog Items Landed / Verified" — implies F-P1-1 is in scope.
- **Evidence found:** None. `grep -rn "training_plan_canceled\|plan_canceled\|markRelatedSignalsStaleOnPlanCancel" src/` returns zero hits except cancellation-reason strings.
- **Evidence missing:** Any code path that emits a signal or invalidation hook on plan cancellation. `markSkillMemoriesStaleForVersion` is only called from `content-memory-profile.ts:338`.
- **Why this matters:** Cooking, Secretary, Chat continue to reference the cancelled plan. Stale recommendations produced.
- **Recommended validation:** Test: cancel a plan; assert (a) `agent_signals` row written with `signal_type='training_plan_canceled'` and (b) Cooking's `meal_plan_window` memory is `freshness_status='stale'`.

## P1 unverified claims

### UC-4 — "PASS: general staging smoke `./scripts/staging-smoke.sh` 17/17 tests passed"

- **Source:** `docs/release/qa-remediation-progress.md:368`
- **Evidence found:** Narrative claim only.
- **Evidence missing:** No `staging-smoke-{date}.log` in repo. No `.xml` test report. No `tools/staging-smoke-results.json`.
- **Why this matters:** Cannot replay if regression appears post-promote.
- **Recommended validation:** Re-run smoke with `tee` to dated log under `docs/release/smoke-evidence/`.

### UC-5 — "PASS WITH CONDITIONS: focused staging Chat tenant smoke 14 pass / 2 partial / 0 fail"

- **Source:** `docs/release/qa-remediation-progress.md:370-374`
- **Evidence found:** Narrative claim. `.local/chat-tenant-security-smoke/logs/backend.log` is process boot output, NOT smoke results.
- **Evidence missing:** Same as UC-4 — no archived stdout from `chat-tenant-security-smoke.js`.

### UC-6 — "PASS: iOS simulator build" + "PASS: iOS simulator test"

- **Source:** `docs/release/qa-remediation-progress.md:358-361`
- **Evidence found:** Narrative claim. (Round 2 Agent E independently re-ran and confirmed PASS for build + test, but did NOT archive results either.)
- **Evidence missing:** No `.xcresult` bundle. No test count breakdown by suite.
- **Why this matters:** Without test count, cannot tell if a future iOS regression silently dropped tests.

### UC-7 — "Verdict: PASS WITH CONDITIONS" Opus re-audit

- **Source:** `docs/release/qa-remediation-progress.md:376-388`
- **Evidence found:** One paragraph summary listing 2 remaining findings (A-OPUS-P0-2, H-OPUS-P1-3).
- **Evidence missing:** Full Opus re-audit transcript. Any P2/P3 findings the re-audit may have surfaced that were summarized away.
- **Why this matters:** Cannot replay Opus re-audit's full surface; potentially additional findings silently dropped.

### UC-8 — "Production health was checked: content-engine /health: ok ; PM2 online"

- **Source:** User's verification request 2026-04-30
- **Evidence found:** Narrative claim.
- **Evidence missing:** No curl output, no PM2 dump file.
- **Why this matters:** Low risk; matters for post-incident timeline reconstruction.

### UC-9 — "Block 7 closes H-P0-1: tenant_shared cross-tenant denied"

- **Source:** `docs/release/qa-remediation-progress.md:243`
- **Evidence found:** `__tests__/services/skill-memory.test.ts:72-87` ("keeps tenant-shared memory inside its tenant") + 89-103 ("fails closed for tenant-shared memory when user membership cannot be proven").
- **Evidence missing:** The fix (`canReadTenantSharedMemory()` returns `userId === tenantId`) is **structurally a single-tenant assertion, not membership validation**. The test passes today because `tenant_id=user_id`; the day a real `tenant_members` table is added, every legitimate non-owner read breaks.
- **Why this matters:** Latent ratchet. Fix appears to close H-P0-1 but creates a write/read asymmetry: anyone in a tenant can WRITE `tenant_shared` memory; only the user with `userId === tenantId` can READ it. That's worse than no scope at all under multi-tenant.
- **Recommended validation:** Either (a) reject `tenant_shared` writes under the current single-tenant model, OR (b) skip the H-P0-1 closure claim until a real membership table lands.

### UC-10 — "Memory quota enforcement" (Block 8)

- **Source:** `docs/release/qa-remediation-progress.md:288`
- **Claim:** "Added memory quota enforcement for active user-private and tenant-shared skill memories."
- **Evidence found:** Implementation in `src/services/skill-memory.ts`.
- **Evidence missing:** Test that asserts a 201st memory write fails when quota is 200 (or whatever the limit is).
- **Why this matters:** Quota threshold could be silently misconfigured.
- **Recommended validation:** Test with explicit quota injection.

## P2 unverified claims

### UC-11 — "Sentry-visible warning when Anthropic configured but disabled" (Block 8)

- **Source:** `docs/release/qa-remediation-progress.md:284`
- **Evidence missing:** Sentry integration test. Could verify the warning fires in `provider-registry.ts buildPair` when `primaryName='anthropic'` and `getUsableProvider('anthropic')` returns null.

### UC-12 — "Privacy scrubbing before `completeOneShotWithSearch`" (Block 8)

- **Source:** `docs/release/qa-remediation-progress.md:286`
- **Evidence missing:** Per-pattern scrub coverage test (similar to `UNSAFE_MEMORY_PATTERNS`).

### UC-13 — "Per-domain pin precedence verified for OpenAI + Gemini" (Block 8)

- **Source:** `docs/release/qa-remediation-progress.md:282`
- **Evidence found:** Tests added.
- **Evidence missing:** `setActiveModel` race / live config mutation behavior remains undocumented (B-OPUS-P1-2 from round 1 remains open per Block 8 follow-ups).

### UC-14 — "Concurrent cancel race serialized" (Block 8)

- **Source:** `docs/release/qa-remediation-progress.md:280`
- **Evidence found:** `__tests__/api/training-plan-cancellation.test.ts:600-640`.
- **Evidence missing:** A unit test cannot create a real race condition. The test asserts idempotency (one delete fires for two `Promise.all` cancels) but not serialization under concurrent HTTP requests from multiple processes.

## Summary

**14 unverified claims.** Categorized:
- **3 P0** — claims that affect cross-skill correctness (cascade on cancel, lifecycle reachability, training calendar-sync bypass)
- **8 P1** — evidence preservation gaps (smoke logs, iOS xcresult, Opus transcript) + structural footguns (`tenant_id=user_id`, memory quota assertion)
- **3 P2** — observability + race-condition tests
