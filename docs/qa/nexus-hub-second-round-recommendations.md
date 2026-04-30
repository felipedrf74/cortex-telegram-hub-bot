# Nexus Hub — Second-Round Recommendations

**Generated:** 2026-04-30
**Audit:** second-round QA gap review at HEAD `414383b` (4.14.106 deployed)

Recommendations ordered by **leverage** (number of risks closed × inverse cost), not raw severity. Production stays at 4.14.106 throughout.

---

## R2-REC-1 — Cross-skill cancellation cascade (HIGHEST LEVERAGE)

**Closes:** R2-P0-1, R2-P0-2, partially R2-P0-3 — **3 P0 findings**.

**Effort:** ~1.5 dev-days.

**Action:**
1. Add a private helper `cancelDependentSecretaryAgendaItems(planId, planVersion, userId, tenantId)` in `src/services/training-plan-cancellation-cascade.ts`.
2. From `cancelTrainingPlanForUser` in `src/api/routes/training-plan-cancellation.ts`, after the calendar-event delete loop and BEFORE the hard-delete, call:
   - `cancelDependentSecretaryAgendaItems(plan.id, plan.plan_version, plan.user_id, plan.tenant_id)` which iterates `secretary_agenda_items` rows where `source_skill='training' AND source_intent_id IN (training_session_ids)` and calls `cancelSecretaryAgendaItem(...)` for each
   - `intelligenceBus.writeSignal({signal_type: 'training_plan_canceled', source_agent: 'training', user_id, tenant_id, payload: {plan_id, plan_version, reason}})`
   - `markSkillMemoriesStaleForVersion({tenantId, userId, relatedSkillVersion: 'training-plan-v' + planVersion, reason: 'training_plan_canceled'})` for `skillId in ['cooking', 'secretary', 'chat']`
3. Tests in `__tests__/integration/training-cancel-cascade.test.ts`:
   - assert `cancelSecretaryAgendaItem` was called for every secretary agenda item with matching source
   - assert `agent_signals` row written with `signal_type='training_plan_canceled'`
   - assert `skill_memories` rows with `related_skill_version='training-plan-v' + planVersion` are `freshness_status='stale'`

**Acceptance:** All 3 P0 tests pass. `npm run verify` clean.

---

## R2-REC-2 — Legacy training-plan-calendar-sync route through Secretary

**Closes:** R2-P0-3 — **1 P0 finding** (the part R2-REC-1 doesn't cover).

**Effort:** ~½ dev-day.

**Action:**
1. In `src/api/routes/training-plan-calendar-sync.ts`, refactor `syncTrainingPlanCalendar` (or its caller) to submit a Secretary intent per session window before invoking `createTrainingCalendarEvent`.
2. OR introduce env flag `LEGACY_TRAINING_CALENDAR_SYNC_DIRECT` defaulted off; document in release notes.
3. Test in `__tests__/api/training-plan-calendar-sync.test.ts`:
   - `mockSubmitSecretarySchedulingIntent` invocationCallOrder < `mockCreateTrainingCalendarEvent` invocationCallOrder
   - When `LEGACY_TRAINING_CALENDAR_SYNC_DIRECT=true`, the Secretary call is skipped (gate works as documented)

**Acceptance:** Adversarial test passes. Closes FC-1.

---

## R2-REC-3 — iOS contract repair for `decision_explanation` + provenance ledger

**Closes:** R2-P1-14, R2-P1-15 — **2 P1 findings**.

**Effort:** ~½ dev-day (iOS-only).

**Action:**
1. iOS `Nexus Hub/Models/TrainingSession.swift`:
   - Add `decisionExplanation: String?` field
   - Add CodingKey aliases: `decisionExplanation`, `decision_explanation`
   - Decode via existing `decodeOptionalStringLike` helper
   - Update `WeekDetailSheet.swift` to render the field next to existing `rationale` (mirror `EventDetailSheet.swift:153-158` pattern)

2. iOS `Nexus Hub/Models/ContentIdea.swift`:
   - Add `ContentOutputProvenance` struct with `groundingStatus: String`, `unsupportedClaims: [String]`, `references: [Reference]`
   - Decode from backend's `content_output_provenance` payload
   - Wire into `ContentIdeaReviewDetailView.swift:133` so the warning shows server-asserted unsupported-claim text instead of heuristic chip

3. Contract tests in `Nexus HubTests/`:
   - `WeekSessionContractDecodingTests.swift` — fixture with `decision_explanation` decodes, surfaces non-nil
   - `ContentProvenanceContractDecodingTests.swift` — fixture with full provenance ledger decodes

**Acceptance:** iOS `xcodebuild test` passes; new contract fixtures green.

---

## R2-REC-4 — Content soundness: provenance gate + reference partition

**Closes:** R2-P1-3, R2-P1-4, R2-P1-5 — **3 P1 findings**.

**Effort:** ~½ dev-day.

**Action:**
1. `src/services/content-reference-provenance.ts:412-442 assessClaimsGrounding`:
   - When `claims.length === 0` and `references.length > 0`, return `'no_claims'` status (new) instead of `'partially_grounded'`
   - Don't propagate `reviewRequired` from references when claims is empty

2. `src/services/content-workflow.ts:404-434 generateScript`:
   - Pre-check: if format is source-required AND `retrieveAuthorizedContentReferences(...).filter(r => r.usableForGeneration).length === 0`, refuse with typed error `CONTENT_GENERATION_REFUSED_NO_REFERENCES`
   - Surface to UI with actionable message ("Add references for this content type before generating")

3. `src/services/content-reference-context.ts:246-265 buildAuthorizedContentReferenceContext`:
   - Split into `[GROUNDED REFERENCES]` (usable, not review_required) and `[INSPIRATION ONLY — DO NOT CITE]` (needsReview=true) blocks
   - Add prompt instruction: "Citations and source claims must reference only entries in [GROUNDED REFERENCES]. The [INSPIRATION ONLY] block is for tone/style only and must NEVER be cited."

4. Tests:
   - `assessClaimsGrounding({claims: [], references: [...]})` returns `'no_claims'` not `'partially_grounded'`
   - `generateScript(...)` for tenant with zero usable refs throws `CONTENT_GENERATION_REFUSED_NO_REFERENCES`
   - Prompt block contains both section headers when both reference types present

**Acceptance:** 3 new tests pass.

---

## R2-REC-5 — Smoke + iOS evidence preservation

**Closes:** R2-P1-10, R2-P1-11, R2-P1-12 — **3 P1 findings** (observability).

**Effort:** ~½ dev-day.

**Action:**
1. Create `docs/release/smoke-evidence/` directory.
2. Re-run `scripts/staging-smoke.sh` with `tee docs/release/smoke-evidence/staging-smoke-$(date +%Y%m%d-%H%M).log`. Reference filename in `qa-remediation-progress.md`.
3. Re-run `scripts/chat-tenant-security-smoke.js` with output capture similarly.
4. Re-run `xcodebuild test ... -resultBundlePath docs/release/smoke-evidence/ios-$(date +%Y%m%d-%H%M).xcresult`. Use `xcresulttool get --path ... --format json` to get a stable summary file.
5. Re-run the Opus re-audit (Claude Code with `--model opus --effort max`, read-only) and save full transcript to `docs/qa/opus-reaudit-2026-04-30.md`.
6. Save the production `/health` curl output to `docs/release/smoke-evidence/prod-health-2026-04-30.txt`.

**Acceptance:** All 6 artifacts present in repo. `qa-remediation-progress.md` references filenames.

---

## R2-REC-6 — Tenant_shared write/read asymmetry guard

**Closes:** R2-P1-9 — **1 P1 finding** (latent ratchet).

**Effort:** ~½ day.

**Action:**

1. In `src/services/skill-memory.ts setSkillMemory`:
   - When `scope === 'tenant_shared'` AND no real membership table is present, REJECT writes (not just reads). Throw `TENANT_SHARED_NOT_AVAILABLE`.
2. Add env flag `ENABLE_TENANT_SHARED_MEMORY` defaulted false; flip on only after membership table lands.
3. Document in `docs/memory/skill-memory-model.md` and the multi-tenant migration plan.

**Acceptance:** Test asserts tenant_shared write rejected when flag off.

---

## R2-REC-7 — Mid-tool-loop fallback safety + per-object confirmation (deferable)

**Closes:** R2-P1-1, R2-P1-2 — **2 P1 findings**.

**Effort:** ~1 dev-day.

**Action:**
1. In `provider-fallback.ts continueWithToolResults`, detect mid-loop fallback state and abort with typed error rather than silently retrying.
2. In `chat-tool-authorization.ts`, change `confirmedDestructiveAction: boolean` to `confirmedDestructiveTargets: Set<{tool, objectId}>`. Each destructive call must match an entry. Reset on turn end.

**Acceptance:** 2 new adversarial tests pass.

---

## R2-REC-8 — Silent push for cache invalidation (deferable)

**Closes:** R2-P1-6 — **1 P1 finding**.

**Effort:** ~1 dev-day (backend + iOS).

**Action:**
1. Backend: extend `apns-sender.ts` with `sendBackgroundNotification(...)` using `apns-push-type: 'background'` + `content-available: 1`.
2. Define payload types: `plan_regenerated`, `content_approved`, `agenda_reflowed`.
3. Wire from training plan generation, content approval, secretary reflow paths.
4. iOS: register background-fetch handler in `AppDelegate.swift`. On receipt, trigger appropriate ViewModel reload.

**Acceptance:** End-to-end test (or dev-flow walkthrough): plan regenerates server-side → iOS app foregrounded → silent push triggers reload → user sees fresh data.

---

## R2-REC-9 — `findEventsByAgendaItemId` required (deferable)

**Closes:** R2-P1-7 — **1 P1 finding**.

**Effort:** ~½ dev-day.

**Action:**
1. In `src/services/secretary-agenda-provider-sync.ts:297-305`, when adapter lacks `findEventsByAgendaItemId`, fall back to a tag-based search: encode `agenda_item_id` in event metadata at create time, search by metadata key on retry.
2. OR require `findEventsByAgendaItemId` on the adapter interface and throw at startup if missing.

---

## R2-REC-10 — Lower-priority deferable items

**Closes:** R2-P1-8, R2-P1-13, plus various P2/P3 from round 1 still open.

These can ship with documented exceptions in `docs/release/`. Not release-blocking even on second-round standards.

- R2-P1-8: per-block diff manifest (auditability)
- R2-P1-13: rollback granularity (squash acknowledgment)
- ADV-1: central tenant-switch hook
- ADV-7: auto-stale on activation
- ADV-9: portal admin rate limit
- iOS-GAP-3 through iOS-GAP-7

---

## Final sequencing

| Block | Closes | Effort | Verdict impact |
|---|---|---|---|
| **R2-REC-1** (cancellation cascade) | 3 P0 | 1.5 days | FAIL → **near-PASS WITH CONDITIONS** |
| **R2-REC-2** (legacy training-calendar-sync) | 1 P0 | ½ day | reinforces R2-REC-1 |
| **R2-REC-3** (iOS contract repair) | 2 P1 | ½ day | toward PASS |
| **R2-REC-4** (content provenance) | 3 P1 | ½ day | toward PASS |
| **R2-REC-5** (evidence preservation) | 3 P1 | ½ day | observability cleanup |
| **R2-REC-6** (tenant_shared guard) | 1 P1 | ½ day | latent risk closed |
| **R2-REC-7+8+9** (mid-loop fallback, silent push, adapter requirement) | 4 P1 | 2.5 days | deferable |
| **R2-REC-10** | various P2/P3 | 1+ days | deferable |

**Mandatory pre-next-release:** R2-REC-1 + R2-REC-2 (~2 dev-days). Closes 4 P0 findings. Verdict upgrades to PASS WITH CONDITIONS.

**Recommended pre-next-release:** add R2-REC-3 + R2-REC-4 + R2-REC-5 (~1.5 dev-days). Closes 8 P1 findings + observability gap.

**Total recommended cleanup:** ~3.5 dev-days for the must-fix block. Defer the rest with documented exceptions.

---

## After cleanup

Re-run the QA-of-QA pass to verify:
- R2-REC-1 closure produces a passing call-graph test for `cancelSecretaryAgendaItem` invocation from training cancel
- R2-REC-2 closure produces a passing ordering test for the legacy route
- Smoke artifacts exist in `docs/release/smoke-evidence/`
- iOS contract tests show new fields decoded
- Verdict upgrades to **PASS WITH CONDITIONS**
