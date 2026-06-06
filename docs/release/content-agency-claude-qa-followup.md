# Content Agency — Claude Hostile QA Follow-up (Fix Verification)

**Date**: 2026-05-14
**Engine**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` — branch `main`, dirty working tree
**iOS**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub` — branch `main`, dirty working tree
**Simulator**: iPhone 17 Pro, iOS 26.4.1 (`A0B13967-B5DE-4E6F-897D-F1E409093F94`)
**xcresult**: `/tmp/content-followup/ios.xcresult`
**Eval bundle**: `/tmp/content-followup/eval/`

## Verdict

**GO** ✅

All 4 P2 + both P3 follow-ups from the prior QA are **closed at source AND pinned by hostile-quality tests**. Several fixes are stronger than my recommendations. No new findings. No conditions remain. Branch is mergeable.

## Test scorecard (independently re-run)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| Focused 6-file content sweep | **86/86 passing** (up from 84, +2 from new fix-pinning tests) |
| `npx tsx src/tools/content-evaluation-harness.ts --mode fixture --fail-under 90` | **91/100, 27/27 cases PASS, 0 critical, gate PASS_WITH_CONDITIONS** (unchanged — conditions are external/operational) |
| iOS test sweep (4 targets on iPhone 17 Pro Sim) | **71 passed / 0 failed / 2 skipped** (vs prior 71/2 failed — the 2 live tests now `XCTSkip` honestly) |
| `npm run docs:audit` | PASS (exit 0) |

## Per-fix verification

### Fix 1 — Disclosure blocker ID unified (P2-1) ✅ STRONGER THAN RECOMMENDED

| Layer | Evidence |
|---|---|
| Registry | `src/services/content-agency-rules.ts:215-218` — rule `disclosure-copyright-claim-safety`'s `blockedFailureModes` now lists `'sponsored_or_branded_content_requires_clear_disclosure'` (matches the runtime emitter exactly) |
| Runtime emitter | `src/services/content-agency.ts:1126` — `if (input.brandedContent) blockers.push('sponsored_or_branded_content_requires_clear_disclosure');` |
| Lock-step enforcement (NEW, beyond my ask) | `src/services/content-agency.ts:860-862` — startup validator: `if (!rules.some((rule) => rule.category === 'compliance_policy' && rule.blockedFailureModes.includes('sponsored_or_branded_content_requires_clear_disclosure'))) errors.push('compliance_rules_do_not_block_missing_disclosure');` |
| Test pin | `__tests__/services/content-agency.test.ts:214` — `it('requires disclosure for branded content before approval', …)` |

**Going-beyond detail**: I asked Codex to either standardize IDs or replace `blockedFailureModes` with `runtimeBlockerIds`. They did better — they kept `blockedFailureModes` (research-friendly naming) AND added a runtime validator that fails startup if the registry's compliance rule doesn't include the canonical blocker ID. Registry and runtime can't drift again.

### Fix 2 — Pipeline handoff explicit SELECT read-back (P2-2) ✅ STRONGER THAN RECOMMENDED

| Layer | Evidence |
|---|---|
| INSERT | `src/services/content-agency.ts:680-710` |
| Explicit read-back SELECT | `:712-731` — `SELECT … FROM content_pipeline WHERE id = ? AND user_id = ? AND tenant_id = ? AND owner_user_id = ? AND source_agency_package_id = ? AND scope_status = 'active' AND approval_state = 'approved' LIMIT 1` |
| Error on miss | `:732-734` — `if (!readBack) throw new Error('Content agency pipeline handoff read-back failed');` |
| Response uses read-back data | `:738` — `pipelineId: Number(readBack.id)` (not `lastInsertRowid`, proving response came through verified read path) |
| sourceTrace label | `:742` — `'content_pipeline read-back verified'` (now actually true) |
| Hostile test pin | `__tests__/services/content-agency.test.ts:292-343` — creates a SQL `TRIGGER ... DELETE FROM content_pipeline WHERE id = NEW.id;` so every insert is immediately deleted, then asserts `handoffContentAgencyPackageToPipeline(...).toThrow(/read-back failed/i)` |

**Going-beyond detail**: I asked for "any SELECT after INSERT." Codex added a SELECT that verifies the **entire scope tuple** (user_id, tenant_id, owner_user_id, source_agency_package_id) AND lifecycle state (`scope_status='active'`, `approval_state='approved'`). If anything corrupts between INSERT and SELECT — concurrent write, transaction issue, tenant cross-pollution — the read-back fails honestly. And the hostile test actively defeats the SELECT path to prove it works under attack.

### Fix 3 — UNIQUE constraint + upsert (P2-4) ✅ STRONGER THAN RECOMMENDED

| Layer | Evidence |
|---|---|
| Schema | `migrations/128_content_agency.sql:21-22, 44-45, 67-68, 90-91, 113-114, 136-137, 159-160` — `CREATE UNIQUE INDEX IF NOT EXISTS uniq_…_scope ON …(tenant_id, user_id, agency_id)` for all 7 tables |
| Runtime upsert | `src/services/content-agency.ts:564-575` — `INSERT INTO ${table} (...) VALUES (...) ON CONFLICT(tenant_id, user_id, agency_id) DO UPDATE SET …, updated_at = datetime('now')` |
| Test pin | `__tests__/services/content-agency.test.ts:262-290` — persists the same artifact twice with mutated warnings, asserts `rows.toHaveLength(1)` (no duplicate), payload reflects the SECOND call's data, and **queries `PRAGMA index_list(content_agency_packages)` to assert `uniq_content_agency_packages_scope` is `unique: 1`** |

**Going-beyond detail**: I asked for UNIQUE constraint OR upsert. Codex implemented BOTH — UNIQUE prevents accidental duplicates from inserts; upsert allows intentional re-runs to silently overwrite. Test verifies the constraint exists by querying PRAGMA metadata, not just trusting the migration ran.

**Minor caveat (P3, accepted)**: `CREATE UNIQUE INDEX IF NOT EXISTS` would fail on a deployed DB with pre-existing duplicates. Hash-collision space is large enough that production duplicates are unlikely, but a migration runbook entry would help.

### Fix 4 — Quality rubric doc has all 15 runtime dimensions (P2-3) ✅

| Section | Evidence |
|---|---|
| New rubric section | `docs/content/content-quality-rubric.md:29-52` — "## Creator Agency Runtime Dimensions" lists exactly 15 dimensions matching `evaluateContentAgencyPackage` at `content-agency.ts:494-510` |
| Per-dimension table | `:38` `audienceSpecificity` · `:39` `platformNativeFit` · `:40` `hookStrength` · `:41` `firstFrameClarity` · `:42` `narrativeTension` · `:43` `emotionalArousalShareability` · `:44` `proofDensity` · `:45` `originality` · `:46` `brandConsistency` · `:47` `editability` · `:48` `productionFeasibility` · `:49` `claimGrounding` · `:50` `complianceSafety` · `:51` `experimentClarity` · `:52` `actionability` |
| Quality gates | `:79-88` — explicit "Creator Agency outputs must include source trace, uncertainty, next best actions" + per-failure release-blocker classification |

Each dimension uses the exact runtime field name (`emotionalArousalShareability` etc.), so a doc reader gets unambiguous mapping back to source.

### Fix 5 — iOS live tests skip honestly (P3-1) ✅

| Site | Evidence |
|---|---|
| Test result | iOS xcresult: **71 passed / 0 failed / 2 skipped** (vs prior 71/2 failed) |
| Pre-auth skip | `Nexus HubUITests/ContentCreationLiveWorkflowUITests.swift:316` — `throw XCTSkip("App is on authentication/onboarding, not an existing signed-in session.")` |
| Tab-bar timeout skip | `:318` — `throw XCTSkip("Live Content workflow requires a pre-authenticated simulator session; no tab bar was available. Visible text: \(visibleTextSnapshot(app))")` (includes a snapshot of what WAS rendered, so skips can't hide a regression on the auth surface) |
| Wrong-account refusal | `:144,147` — `throw XCTSkip("The visible signed-in session is not nexushubbot; refusing to mutate Content data for \(context).")` — refuses to run mutation if the visible account isn't the test account |
| Fixture-based test still PASSES | `test_contentAgencyFixtureOutputIsActionableCleanAndExtractable` ran and passed (the actual Content Agency UI extraction probe) |

**Anti-hiding-failure design**: The skip message at `:318` includes `visibleTextSnapshot(app)` — so if a future regression causes the auth surface itself to break, the skip message reports the unexpected screen content rather than silently passing. This addresses the hostile worry "skips hide real failures" directly.

### Fix 6 — Fixture installer requires UI-test mode (P3-2) ✅ STRONGER THAN RECOMMENDED

| Layer | Evidence |
|---|---|
| Compile gate (kept) | `Nexus Hub/Core/TrainingLocalSmokeFixtures.swift:1` — `#if DEBUG || RELEASE_WITH_TESTING` (project convention, unchanged) |
| Runtime gate (NEW) | `:1591-1596` `ContentAgencyLocalSmokeFixtureInstaller.requestedFixtureName` — `guard TestRuntime.isUITestMode else { return nil }` |
| Specific arg gate | `:1592-1593` — requires `-NEXUSQAContentAgencyFixture` launch arg OR `NEXUSQA_CONTENT_AGENCY_FIXTURE` env var |
| `TestRuntime.isUITestMode` impl | `Nexus Hub/Core/PreviewRuntime.swift:24-28` — requires `-NexusUITestMode` launch arg OR `NEXUS_UI_TEST_MODE=1` env |

**Triple-gated now**:
1. Compile-time `DEBUG || RELEASE_WITH_TESTING` (App Store excluded by default)
2. Runtime `TestRuntime.isUITestMode` (requires UI-test launch arg)
3. Specific `NEXUSQAContentAgencyFixture` arg (requires fixture-specific opt-in)

I suggested "tighten to `#if DEBUG` only." Codex chose better — they kept the compile-time flexibility so QA can run on TestFlight-internal builds, but added a runtime UI-test gate so even those builds reject fixture injection from anything other than the UI test runner.

### Fix 7 — No v2 stack regression ✅

| Layer | Evidence |
|---|---|
| Engine grep | `grep -rnE "content-v2\|ContentAgencyV2\|ContentAgencyRepository\|content-agency-v2" src/ __tests__/` → 0 hits |
| iOS grep | `grep -rnE "ContentAgencyV2\|ContentRepositoryV2\|ContentDTOV2\|content_agency_v2" "Nexus Hub/" "Nexus HubTests/" "Nexus HubUITests/"` → only 2 negative-assertion hits: |
| Anti-regression test | `Nexus HubTests/ContentAgencySourcePinsTests.swift:95-96` — `XCTAssertFalse(serviceSource.contains("ContentAgencyV2"))` AND `XCTAssertFalse(repositorySource.contains("ContentAgencyV2"))` |
| Single content route registration | `src/api/routes/content.ts:24` — `import { registerContentAgencyRoutes } from './content-agency-routes';` (additive, not parallel) |

**Anti-regression armor**: If a future contributor introduces a v2 stack, `ContentAgencySourcePinsTests` fails. Real source-pinning, not just absence-by-grep.

## Special-attention checks

### Does sourceTrace overclaim success?
**No.** `sourceTrace.push('content_pipeline read-back verified')` at `:742` is now backed by an explicit SELECT at `:712-731` that throws if the row is not findable with the exact scope+state tuple. The hostile test at `__tests__/.../content-agency.test.ts:331-342` actively breaks this path via a TRIGGER and confirms the failure surfaces.

### Can duplicate agency rows still accumulate?
**No.** `migrations/128_content_agency.sql:21-22` plus `content-agency.ts:564` give belt-and-suspenders protection. The test at `content-agency.test.ts:262-290` proves both layers work — and queries PRAGMA to confirm the UNIQUE index actually exists at runtime.

### Are registry blocker IDs merely documented or actually tested?
**Actually tested + actually enforced.** Three layers:
1. Test `:214` — calls `buildComplianceReview` with `brandedContent: true` and asserts the blockers array includes the canonical ID.
2. Runtime validator at `content-agency.ts:860-862` — fails startup if the registry rule's `blockedFailureModes` is missing the canonical ID.
3. The grep used by the previous QA pass shows registry + runtime now share the exact same string `sponsored_or_branded_content_requires_clear_disclosure`.

### Do iOS skips hide real Content Agency fixture failures?
**No.** The fixture-based UI extraction test `test_contentAgencyFixtureOutputIsActionableCleanAndExtractable` is in the same file as the skipped live tests, and it still runs and passes. The skips at `:316,318` apply only to the `live*` tests that require a pre-authenticated simulator. Skip messages include `visibleTextSnapshot(app)` so regressions on the auth surface itself would be reported in the skip message rather than silently passing.

### Can raw prompt/provider/debug artifacts still appear in user-facing Content Agency output?
**No new vectors.** The original sanitizer at `content-agency.ts:243-252` `RAW_ARTIFACT_PATTERNS` (`COACH_RECS_*`, `PROMPT`, `SYSTEM:`, `INTERNAL_ID`, code-fenced JSON, JSON key fragments) remains in place. The `viral guarantee` + `post consistently` blockers (`:531, :533`) still fire. None of the new fixes weakened these checks, and the hostile read-back test doesn't introduce a new artifact emission path.

## What this follow-up QA confirmed beyond expectations

Three fixes are **stronger than my recommendations**:

1. **P2-1**: Codex added a runtime startup validator (`:860-862`) so the registry/runtime drift physically cannot happen, instead of just renaming a string.
2. **P2-2**: The read-back SELECT verifies the entire scope tuple + lifecycle state, AND the test attacks the path with a TRIGGER instead of trusting code inspection.
3. **P3-2**: Triple-gate (compile + runtime UI-test + fixture-specific arg) instead of `#if DEBUG` lockdown — preserves internal QA flexibility while hardening against misconfiguration.

## P0 / P1 / P2 follow-ups

**None.** All prior findings closed.

## P3 minor notes (informational, not blocking)

- `CREATE UNIQUE INDEX IF NOT EXISTS` on existing deployed DBs would fail if pre-existing duplicates are present. Hash-collision space is large enough that this is unlikely, but a migration runbook entry ("if migration 128 fails on UNIQUE creation, dedupe by `(tenant_id, user_id, agency_id)` first") would be defensive. Strictly informational.

## Cleanup confirmation

- iOS xcscheme + project drift preserved (not modified by this QA).
- Engine workspace mirror + smoke-evidence preserved (untracked).
- No production posting, ad spend, platform mutation, push, deploy, or TestFlight cut.
- Eval harness ran fixture-mode only (no live providers).
- iOS sim `A0B13967-...` ran only the named test targets, no real account login.

## Mergeability

**Ready to merge.** All P2/P3 findings from the prior QA pass are closed at source AND backed by hostile-quality regression tests. Three fixes exceed the recommended bar by adding runtime validators, scope-tuple read-back, and triple-gated fixture isolation.

---

Generated 2026-05-14 by Claude Opus 4.7 on engine `main` and iOS `main`.
