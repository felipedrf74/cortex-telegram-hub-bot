# Nexus Hub — Second-Round Open Blockers (P0/P1)

**Generated:** 2026-04-30
**Audit:** second-round QA gap review at HEAD `414383b` (4.14.106 deployed)

This is the **post-round-2 corrected blocker list**, distinct from the round-1 [`nexus-hub-focused-qa-open-blockers.md`](nexus-hub-focused-qa-open-blockers.md). All entries here are **net-new findings** the prior QA + remediation chain did NOT close, OR weakly-closed claims with insufficient evidence.

> Production stays at 4.14.106 while these are addressed. None are immediate-rollback severity for a single-user deploy.

## 2026-04-30 remediation status

Focused fixes are in progress on `feature/r2-qa-remediation-training-secretary-cascade` and `feature/ios-r2-contract-fixes`.

Code/test status:

- `R2-P0-1`, `R2-P0-2`, and `R2-P0-3` are fixed in the backend remediation branch with focused tests.
- `R2-P1-3`, `R2-P1-4`, `R2-P1-5`, and `R2-P1-9` are fixed in the backend remediation branch with focused tests.
- `R2-P1-14` and `R2-P1-15` are fixed in the iOS remediation branch with focused simulator tests.

Validated so far:

- Backend: `npx tsc --noEmit` plus 6 focused Vitest files / 73 tests.
- Backend full suite: `npm run verify` passed with 424 files / 6,364 tests.
- iOS: focused `xcodebuild test` on `ModelDecodingTests`, `TrainingPresentationTests`, and `ContentIdeaReviewDetailRenderingTests`.

Still open before upgrading this QA-of-QA document to PASS:

- Archive staging smoke, full iOS smoke, and Opus re-audit evidence.
- Run fresh full backend verify and full iOS gate after branch commits.
- Keep `R2-P1-1`, `R2-P1-2`, `R2-P1-6`, and `R2-P1-7` as documented deferrals unless explicitly pulled into this release.

## P0 (3)

### R2-P0-1 (ADV-4) — Training cancellation does not cascade to Secretary agenda items

- **Type:** cross-skill cascade gap / data integrity
- **File evidence:** `src/api/routes/training-plan-cancellation.ts:129-334` deletes calendar events + plan rows + coach state, but `grep -rn cancelSecretaryAgendaItem src/` shows **zero production callers** (`secretary-scheduling-arbitrator.ts:300` only invoked from tests/smokes)
- **User impact:** Secretary agenda items remain in `lifecycle_state='scheduled'` after the source training plan is cancelled. `provider_event_id` points to a deleted external event. Ghost agenda items pollute the active-agenda query indefinitely.
- **Recommended fix:** When training cancellation deletes a session that has a Secretary `source_intent_id`, call `cancelSecretaryAgendaItem(agendaItemId, reason='source_canceled')`. Add a periodic reconciler that detects `secretary_agenda_items.lifecycle_state='scheduled'` rows whose `source_intent_id` no longer maps to an active training session, and flips them to `'canceled'`.
- **Adversarial test:** create plan via training that triggers a secretary agenda item with `source_skill='training'`; cancel the plan; assert the secretary agenda item moved to `lifecycle_state='canceled'`.
- **Owner:** Training + Secretary workstreams (joint)
- **Effort:** ~1 dev-day

### R2-P0-2 (ADV-5) — No cross-skill stale signal on plan cancel

- **Type:** cross-skill consistency
- **File evidence:** `src/api/routes/training-plan-cancellation.ts:215,224` writes `cancellation_reason` strings only. No call to `intelligence-bus.writeSignal` with `signal_type='training_plan_canceled'`. No call to `markSkillMemoriesStaleForVersion`. The latter is only invoked from `content-memory-profile.ts:338`.
- **User impact:** Cooking's `meal_plan_window` cached signals referencing the cancelled plan persist. Secretary keeps stale `agenda_request` references. Chat replays old context with cancelled-plan facts.
- **Recommended fix:** From the cancellation path, (a) emit `agent_signals.write({signal_type: 'training_plan_canceled', source_agent: 'training', user_id, tenant_id, plan_id, plan_version})`; (b) call `markSkillMemoriesStaleForVersion({skillId: 'cooking', skillId: 'secretary', skillId: 'chat'}, planVersion, reason: 'training_plan_canceled')`.
- **Adversarial test:** cancel a plan; assert `agent_signals` row written with the expected `signal_type`, AND assert `skill_memories` rows referencing the plan_version are `freshness_status='stale'`.
- **Owner:** Training + Memory workstreams (joint)
- **Effort:** ~½ dev-day

### R2-P0-3 (FC-1) — Legacy `training-plan-calendar-sync.ts` route bypasses Secretary

- **Type:** architecture / partial closure
- **File evidence:** `src/api/routes/training-plan-calendar-sync.ts:513` calls `createTrainingCalendarEvent` with NO `submitSecretarySchedulingIntent` upstream. Wired into active route `training-plan-routes.ts:15,193` via `syncTrainingPlanCalendar(userId)`. The remediation doc itself acknowledged this in Block 5's "Known follow-ups" but the closure claim for C-OPUS-P0-2 was made anyway.
- **User impact:** A user invoking `/training/plan/sync-calendar` writes provider events with no Secretary arbitration. Multi-skill collisions go undetected. Phase 9's "Secretary as scheduler-of-record" promise is broken on this path.
- **Recommended fix:** Either (a) refactor `syncTrainingPlanCalendar` to submit a Secretary intent per session window, OR (b) add an explicit feature flag `LEGACY_TRAINING_CALENDAR_SYNC_DIRECT` defaulted off in production with a release note.
- **Adversarial test:** call `/training/plan/sync-calendar` for a plan with sessions; assert that for each session, `submitSecretarySchedulingIntent` was called BEFORE `createEvent` (`invocationCallOrder` assertion, same pattern as Block 5 Training plan-generation test).
- **Owner:** Training workstream
- **Effort:** ~½ dev-day

## P1 (15)

### R2-P1-1 (ADV-2) — Mid-tool-loop provider fallback orphan `tool_use_id`

- **Type:** routing / silent corruption
- **File evidence:** `src/services/provider-fallback.ts:760-784 continueWithToolResults` re-runs the loop on the fallback provider with the existing `toolConversation` containing `tool_use_id`s the fallback provider never issued. Anthropic enforces `tool_use_id` integrity → fallback rejects with cryptic error.
- **Recommended fix:** When falling back mid-loop, either (a) detect mid-loop state and abort the request with a typed error rather than continuing on the fallback provider, OR (b) translate orphan `tool_use_id`s into fresh ones by re-issuing the tool calls.

### R2-P1-2 (ADV-3) — Per-object confirmation not enforced; sticky `confirmedDestructiveAction`

- **Type:** chat security / authorization
- **File evidence:** `src/services/chat-tool-authorization.ts:153-161` — `confirmedDestructiveAction: boolean` covers ALL destructive calls in the AsyncLocalStorage scope, not just the confirmed object. A user confirming deletion of event A could be tricked by a follow-up tool call to delete event B in the same turn.
- **Recommended fix:** Change `confirmedDestructiveAction` to `confirmedDestructiveTargets: Set<{tool: string, objectId: string}>`. Each destructive call must match an entry. Reset on turn end.

### R2-P1-3 (ADV-6a) — `claims=[] + refs>0` returns `'partially_grounded'` incorrectly

- **Type:** content quality
- **File evidence:** `src/services/content-reference-provenance.ts:412-442 assessClaimsGrounding`. When `claims.length === 0` and references > 0, returns `'partially_grounded'` with `reviewRequired` propagated from the references.
- **Recommended fix:** Return `'grounded'` (vacuously true) when claims is empty, OR return `'no_claims'` as a distinct status that doesn't trigger downstream review_required incorrectly.

### R2-P1-4 (ADV-6b) — `generateScript` has no pre-check for usable references

- **Type:** content quality / soundness
- **File evidence:** `src/services/content-workflow.ts:404-434` `generateScript` calls `getScript` directly with `voiceMemory`-only context. No call to `buildAuthorizedContentReferenceContext`. No assertion that any usable reference exists for source-required formats.
- **Recommended fix:** Pre-check `retrieveAuthorizedContentReferences(...).filter(usableForGeneration).length`. If zero AND format requires sourcing, refuse with typed error surfaced to UI.

### R2-P1-5 (ADV-6c) — `needsReview=true` references mixed into prompt without partition

- **Type:** content quality
- **File evidence:** `src/services/content-reference-context.ts:246-265 buildAuthorizedContentReferenceContext`. The block annotates each ref with `review_required=yes/no` but mixes them all in `references.slice(0, 40)`. Trust-level instruction is plain English, not enforced data partition.
- **Recommended fix:** Split into two blocks: `[GROUNDED REFERENCES]` (usable, not review_required) and `[INSPIRATION ONLY — DO NOT CITE]` (needsReview=true). Refuse to ground claims on the second block.

### R2-P1-6 (ADV-8) — No silent push for cache invalidation

- **Type:** UX / consistency
- **File evidence:** `apns-sender.ts:351-354` only sends user-visible alerts. No `apns-push-type: 'background'` with `content-available: 1`. iOS app open during plan regeneration shows ghost data until next polling cycle.
- **Recommended fix:** Add a silent push type for cache-invalidation events (plan regenerated, content approved, agenda reflowed). iOS handles by triggering a background fetch.

### R2-P1-7 (ADV-10a) — Secretary `findEventsByAgendaItemId` is OPTIONAL on adapters

- **Type:** calendar idempotency
- **File evidence:** `src/services/secretary-agenda-provider-sync.ts:297-305` — `if (!adapter.findEventsByAgendaItemId) return []`. After a transient network failure post-create, retry calls `createEvent` again, no duplicate scan, duplicate provider event lingers.
- **Recommended fix:** Require `findEventsByAgendaItemId` for all adapters, OR fall back to a tag-based search on agenda_item_id encoded in event metadata.

### R2-P1-8 (FC-2) — Test count drift +123 unexplained per block

- **Type:** auditability
- **File evidence:** Run-1: 6233 → run-2: 6247 → run-3: 6248 → pre-push: 6353 → most-recent: 6356. Per-block attribution missing.
- **Recommended fix:** A diff manifest grouping new test files by which finding they close (FC ID → test path).

### R2-P1-9 (FC-3 / UC-9) — `tenant_id=user_id` fix structural footgun

- **Type:** security / latent ratchet
- **File evidence:** `src/services/skill-memory.ts:355-361 canReadTenantSharedMemory()` is `userId === tenantId`. Anyone in a tenant can WRITE `tenant_shared`, only owner can READ. Multi-tenant rollout breaks every legitimate non-owner read.
- **Recommended fix:** Either reject `tenant_shared` writes until membership table exists, OR feature-gate `tenant_shared` writes off in production until membership lands.

### R2-P1-10 (FC-7 / UC-4) — Staging smoke evidence narrative-only

- **Type:** observability
- **Recommended fix:** Re-run smoke with `tee` to dated log under `docs/release/smoke-evidence/` and reference filename in remediation doc.

### R2-P1-11 (FC-8 / UC-6) — iOS smoke evidence narrative-only

- **Type:** observability
- **Recommended fix:** Archive `.xcresult` bundle and reference filename + test count in doc.

### R2-P1-12 (FC-9 / UC-7) — Opus re-audit full output not preserved

- **Type:** auditability
- **Recommended fix:** Persist full Opus re-audit output as peer file to `nexus-hub-focused-qa-opus-rerun-addendum.md`.

### R2-P1-13 (FC-14) — All 8 blocks squashed into 1 mega-commit

- **Type:** rollback granularity
- **File evidence:** `a59f697` is 31,708 lines / 253 files. Per-block atomicity claimed in remediation doc but abandoned at commit step.
- **Recommended fix:** Either re-split (high effort) OR update doc to acknowledge the squash and that rollback unit = entire remediation.

### R2-P1-14 (iOS-GAP-1) — `WeekSession` doesn't decode `decision_explanation`

- **Type:** iOS contract drift
- **File evidence:** `Nexus Hub/Models/TrainingSession.swift:268-540 CodingKeys 480-490` — has `warnings`, `guidance`, `rationale`, NO `decisionExplanation`/`decision_explanation`.
- **Recommended fix:** iOS-side. Add `decisionExplanation: String?` field with both camelCase + snake_case CodingKey aliases. Surface in WeekSession detail sheet.

### R2-P1-15 (iOS-GAP-2) — Content provenance ledger not consumed by iOS

- **Type:** iOS contract drift
- **File evidence:** `Nexus Hub/Models/ContentIdea.swift:18,95-98,142-144` decodes `provenanceSources`/`referencesUsed`/`sources` but no field for backend's `content_output_provenance` / `grounding_status` / `unsupported_claims`. iOS uses local heuristic for warning flag.
- **Recommended fix:** iOS-side. Add `ContentOutputProvenance` struct mirroring backend. Wire into review detail view.

## Sequencing recommendation

**Block A — Cross-skill cancellation cascade (1.5 days)**
1. R2-P0-1 (training → secretary cancel cascade)
2. R2-P0-2 (cross-skill stale signal)
3. R2-P0-3 (legacy training calendar-sync route)

**Block B — iOS contract repair (½ day)**
4. R2-P1-14 (`decision_explanation`)
5. R2-P1-15 (provenance ledger)

**Block C — Content soundness (½ day)**
6. R2-P1-3 (claims=[]+refs>0)
7. R2-P1-4 (generateScript pre-check)
8. R2-P1-5 (needsReview partition)

**Block D — Smoke + iOS evidence preservation (½ day)**
9. R2-P1-10 (archive staging smoke) — fixed on 2026-04-30 with `docs/release/smoke-evidence/staging-smoke-20260430-r2-remediation.log`; general staging smoke passed 17/17.
10. R2-P1-11 (archive full iOS `.xcresult`) — fixed on 2026-04-30 with `docs/release/smoke-evidence/ios-full-test-20260430-070039.xcresult.zip` and summary JSON, 940 passed / 0 failed.
11. R2-P1-12 (preserve Opus transcript)

**Block E — Latent risks deferred (3+ days, can ship with documented exceptions)**
11. R2-P1-1 (mid-loop fallback)
12. R2-P1-2 (per-object confirmation)
13. R2-P1-6 (silent push)
14. R2-P1-7 (`findEventsByAgendaItemId` required)
15. R2-P1-9 (`tenant_id=user_id` footgun)
16. R2-P1-13 (squash rollback granularity)

**Total mandatory P0 effort:** ~1.5 dev-days. Closes 3 P0s.
**Total P1 effort:** ~1.5 dev-days for Blocks B+C+D, ~3 days for Block E.

After Block A lands, the verdict should upgrade from FAIL to PASS WITH CONDITIONS.
After Blocks A+B+C+D land, the verdict should be PASS WITH CONDITIONS with Block E exceptions documented.
