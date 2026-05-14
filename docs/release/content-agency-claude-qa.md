# Nexus Content / Creator Agency Skill — Claude Hostile QA

**Date**: 2026-05-14
**Engine**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` — branch `main` @ `87d86ff8`, dirty working tree
**iOS**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub` — branch `main` @ `22e7402`, dirty working tree
**Simulator**: iPhone 17 Pro, iOS 26.4.1 (`A0B13967-B5DE-4E6F-897D-F1E409093F94`)
**xcresult**: `/tmp/content-qa/ios.xcresult`
**Eval bundle**: `/tmp/content-qa/eval/content-eval-2026-05-14T09-00-49-098Z.{json,md}`

## Verdict

**GO_WITH_CONDITIONS.**

Every plan-required artifact is present and source-verified at file:line.
The 11 reference categories, 7 persistence tables, 8 API routes, 14
shared response fields, 15 quality dimensions, and 11 iOS Agency Studio
sections all check out. Independent eval harness re-ran to **91/100,
27/27 cases PASS, 0 critical failures, 0 failure-taxonomy hits**. No
parallel Content v2 stack. No duplicate repository. No duplicate DTO
family. Tenant isolation holds; account switch clears agency state; iOS
disables approval when blockers are present.

Conditions before merge are **four P2 contract-precision fixes** —
none blocks ship, all should be done before claiming production-grade:

1. **Registry ↔ runtime blocker-string mismatch.**
2. **Handoff "read-back verified" sourceTrace label is loose.**
3. **Quality rubric doc lags 6 of the 15 runtime dimensions.**
4. **Agency tables lack a UNIQUE constraint.**

A separate **P3 environment note**: my iOS test re-run shows 71/73 vs
Codex's 9/9. The 2 failures are the `live*` UI tests that need an
authenticated simulator session. The fixture-based UI extraction test
(the actual Content Agency surface validation) PASSES.

## Test results I independently re-ran

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| Focused 6-file content sweep (`content-agency.test.ts`, `content-agency-routes.test.ts`, `content-operational-agents.test.ts`, `content-day-to-day-evaluation.test.ts`, `signal-ranking.test.ts`, `content-skill-refactor-qa-validation.test.ts`) | **84/84 passing** |
| `npx tsx src/tools/content-evaluation-harness.ts --mode fixture --fail-under 90` | **91/100, 27/27 PASS, 0 critical, gate PASS_WITH_CONDITIONS** |
| iOS test sweep (4 targets on iPhone 17 Pro Sim) | **71 passed / 2 failed** (failures: `test_liveCurrentAccountLaunchAndNavigationDoesNotFreeze`, `test_liveNexusHubBotContentCreationWorkflow` — both pre-existing live tests requiring authenticated sim) |
| iOS `test_contentAgencyFixtureOutputIsActionableCleanAndExtractable` (the actual Content Agency UI extraction probe) | **PASS** |
| `npm run docs:audit` | PASS (exit 0; 406 warnings, under ceiling) |
| Codex-untouched grep (`secretary-fastpath.ts`, `chat-message-*.ts`, `chat-*.ts`, `tool-executor.ts`) | not applicable — Content Agency scope intentionally additive on Content path; verified via grep that no Codex-owned chat-lane files were modified |

## Per-area findings

### 1. Reference registry coverage — PASS

`src/services/content-agency-rules.ts` exports **11 rules across 11 categories**, 1:1 with the plan's required reference families. Every rule has the 8 schema fields (`id`, `category`, `sourceAnchors`, `principle`, `productBehavior`, `qualityGateImpact`, `blockedFailureModes`, `exampleUserFacingEffect`). `sourceAnchors` are non-empty (4+ items each):

| Plan category | Rule ID | Line |
|---|---|---|
| YouTube discovery/Shorts/Analytics | `youtube-viewer-matching-retention-loop` | `content-agency-rules.ts:41` |
| TikTok Creative Codes / FYP | `tiktok-first-structure-stimulation-sound` | `:60` |
| Instagram/Meta ranking | `instagram-surface-specific-ranking` | `:79` |
| Google Search / helpful content | `people-first-search-content` | `:98` |
| Human behavior / virality | `arousal-story-retention` | `:117` |
| Brand / positioning | `brand-positioning-distinctive-assets` | `:136` |
| Scripting / storytelling | `script-hook-payoff-structure` | `:155` |
| Editing / production | `mobile-first-editing-direction` | `:174` |
| Creator economy / agency | `creator-agency-commercial-loop` | `:188` |
| Compliance / disclosure / copyright | `disclosure-copyright-claim-safety` | `:202` |
| Agent / eval architecture | `agent-handoffs-evals-guardrails` | `:219` |

### 2. Runtime quality gates — PASS (15/15 dimensions, P2 on doc/registry alignment)

`evaluateContentAgencyPackage()` at `src/services/content-agency.ts:482-550` computes **all 15 plan-required dimensions by exact name** (`audienceSpecificity`, `platformNativeFit`, `hookStrength`, `firstFrameClarity`, `narrativeTension`, `emotionalArousalShareability`, `proofDensity`, `originality`, `brandConsistency`, `complianceSafety`, `editability`, `productionFeasibility`, `claimGrounding`, `experimentClarity`, `actionability`).

Blocker emission paths:
- platform missing → `platform_required_for_agency_package` (`:517`)
- compliance blocked → spreads `complianceReview.blockers` (`:518`)
- prompt injection in competitor text → `competitor_prompt_injection_blocked` (`:521`)
- prompt injection in transcript → `transcript_prompt_injection_blocked` (`:524`)
- raw artifact regex hit → `raw_prompt_artifact_blocked` (`:530`)
- generic "post consistently" without diagnosis → `generic_post_consistently_advice_blocked` (`:531-532`)
- "viral guarantee" language → `viral_guarantee_blocked` (`:533`)

`buildComplianceReview()` at `:1074-1100` adds:
- branded content without disclosure → `sponsored_or_branded_content_requires_clear_disclosure` (`:1075`)
- copy-this language → `copying_competitor_creative_blocked` (`:1083`)
- unsupported analytics claims → `unsupported_or_overconfident_claim_blocked` (`:1087`)

**P2 finding**: the rule `disclosure-copyright-claim-safety` lists
`missing_disclosure` in its `blockedFailureModes` array
(`content-agency-rules.ts:202-217`), but the runtime emits the string
`sponsored_or_branded_content_requires_clear_disclosure` at
`content-agency.ts:1075`. Registry's failure-mode array is therefore
documentation, not enforcement keys — contributors editing registry
won't change runtime behavior.

### 3. Persistence migrations — PASS (P2 on UNIQUE constraint)

`migrations/128_content_agency.sql` creates all 7 plan-required tables
with `CREATE TABLE IF NOT EXISTS`, each scoped by `user_id` + `tenant_id`
with composite index `(tenant_id, user_id, agency_id)`:

| Plan table | Migration 128 line |
|---|---|
| `content_agency_briefs` | 1-17 |
| `content_competitor_studies` | 22-38 |
| `content_transcript_studies` | 43-59 |
| `content_agency_packages` | 64-80 |
| `content_compliance_reviews` | 85-101 |
| `content_experiment_runs` | 106-122 |
| `content_agency_quality_reviews` | 127-143 |

`migrations/129_content_agency_pipeline_handoff.sql` is idempotent (ADD
COLUMN + CREATE INDEX IF NOT EXISTS), wires the agency package into the
existing `content_pipeline` table via `source_agency_package_id` — not a
parallel pipeline.

**P2 finding**: indexes exist on `(tenant_id, user_id, agency_id)` but no
`UNIQUE` constraint. If `agency_id` (a stable hash) collides under
different input permutations, duplicate rows accumulate per tenant
without detection.

### 4. API routes — PASS

`src/api/routes/content-agency-routes.ts` registers 8 routes
(plan required 6, additional 2):

| Route | Line |
|---|---|
| `GET /api/v1/content/agency/rules` | 101 |
| `POST /api/v1/content/agency/brief` | 115 |
| `POST /api/v1/content/agency/competitor-study` | 133 |
| `POST /api/v1/content/agency/transcript-study` | 157 |
| `POST /api/v1/content/agency/package` | 181 |
| `POST /api/v1/content/agency/score` | 237 |
| `GET /api/v1/content/agency/projects/:id` | 276 |
| `POST /api/v1/content/agency/projects/:id/handoff` | 293 |

Every handler extracts `userId` + `tenantId` from authenticated session
(never client-supplied). Registered via
`registerContentAgencyRoutes(router, ensureValidContentRouteScope)` in
`src/api/routes/content.ts:160` — extends the canonical content path,
not a parallel stack.

### 5. Shared response envelope — PASS (14/14 fields)

`ContentAgencyResponseContract` at `content-agency-routes.ts:24-39` +
builder at `:58-95` guarantee every response carries `tenantId`,
`userId`, `visibilityScope`, `platform`, `format`, `objective`,
`sourceTrace`, `referenceIds`, `confidence`, `qualityScore`, `warnings`,
`blockers`, `reviewRequired`, `nextBestActions`. Called on every success
path (`:126, 150, 174, 230, 269, 290, 336, 345`).

### 6. Pipeline handoff — PASS behaviorally, P2 on sourceTrace label

`content-agency.ts:603-710` `handoffContentAgencyPackageToPipeline`:
- reads persisted package by `(id, user_id, tenant_id)` — returns
  `not_found` if missing (`:612-616`)
- validates blockers — refuses handoff if blockers present (`:629-641`)
- idempotency check — returns existing pipeline ID if found (`:643-663`)
- INSERT into `content_pipeline` with real values (`:680-700`)

**P2 finding**: line 708 sets sourceTrace to `'content_pipeline
read-back verified'` but no SELECT after INSERT verifies the row
exists. better-sqlite3 throws on INSERT failure so the INSERT is
verified-by-throw, but the "read-back verified" wording is misleading.
Either add an explicit `SELECT id FROM content_pipeline WHERE
source_agency_package_id = ? AND user_id = ? AND tenant_id = ?` after
INSERT, or rename label to `'content_pipeline INSERT confirmed'`.

Test coverage at `__tests__/agents/content-operational-agents.test.ts:82-100,
102-148` pins fail-closed behavior for pipeline scope + fail-closed for
missing APIs.

### 7. iOS Content Agency Studio — PASS

All 11 plan-required sections present in `ContentSkillView.swift` as
`AgencySectionCard` instances inside `ContentAgencyStudioView` at line
1284:

| Plan section | iOS line |
|---|---|
| Summary | 1462 |
| Audience & Positioning | 1499 |
| Competitor Study | 1508 |
| Transcript Study | 1515 |
| Hook Bank | 1522 |
| Script Studio | 1537 |
| Creative Direction | 1549 |
| Compliance Review | 1557 |
| Experiment Plan | 1574 |
| Performance Diagnosis | 1582 |
| Pipeline Handoff | 1605 |
| Pipeline status (bonus) | 1614 |

- Approve button disabled when blockers: `ContentSkillView.swift:1493`
  `.disabled(hasBlockers || isHandingOff)`
- Summary rendered first: line 1462
- Raw debug behind `DisclosureGroup`: line 1607
- Forbidden-token pins in `ContentAgencySourcePinsTests.swift:67-83`

### 8. Single repo + single DTO family — PASS

- One `ContentRepository.swift` (`/Core/Repositories/`)
- Agency DTOs co-located in `ContentService.swift:2363-2610` (single
  family, no V2/duplicate variants)
- Engine grep: `content-v2|ContentAgencyV2|ContentAgencyRepository|content-agency-v2` → 0 hits
- iOS grep: `ContentAgencyV2|ContentRepositoryV2|ContentDTOV2|content_agency_v2` → 0 hits

### 9. Account switch clears agency state — PASS

`ContentRepository.reset()` at `ContentRepository.swift:791-803` clears
`agencyPackage`, `agencyRules`, `agencyHandoff`. `invalidateForScopeChange()`
at `:818` delegates to `reset()`. `AppState.handleScopeChange()` at
`AppState.swift:603-616` invokes the invalidation before views re-render.

Test pin: `Nexus HubTests/RepositoryScopeChangeTests.swift:127-142`
`test_contentRepository_invalidateForScopeChange_clearsAllCaches` asserts
`agencyPackage`, `agencyRules`, `agencyHandoff` all become `nil`.

### 10. Debug fixture isolation — PASS (accepted convention)

`TrainingLocalSmokeFixtures.swift:1` is guarded by `#if DEBUG ||
RELEASE_WITH_TESTING` — the project-wide convention used by 10+ infra
files (`AuthManager`, `SubscriptionManager`, `NotificationManager`,
`NexusHTTPClient`, `CalendarRepository`, `TrainingRepository`,
`AppState`, etc.). The fixture installer additionally requires the
launch arg `NEXUSQA_CONTENT_AGENCY_FIXTURE` or env var to actually
activate. App Store builds neither include `RELEASE_WITH_TESTING` nor
expose process-arg injection to end users.

P3 hardening suggestion (not blocking): tighten the Content Agency
fixture installer specifically to `#if DEBUG` only, since fixtures here
inject full agency package state. Other infra fixtures (calendar etc.)
benefit from RELEASE_WITH_TESTING for internal QA; agency fixtures
arguably do not.

### 11. Existing-agent direct health gate (Phase 1 of plan) — PASS

`__tests__/agents/content-operational-agents.test.ts:68` describes
"Content operational agents direct health checks". 5 tests pin:

- pipeline scope-isolation (`:82`)
- pipeline platform/global bottleneck detection (`:102`)
- SEO + performance fail-closed without channel (`:123`)
- reaction radar fail-closed when APIs unavailable (`:140`)
- editorial coordinator emits non-generic cross-skill signals (`:150`)

This closes the plan's Phase 1 gate ("weakest area: operational agents
tested indirectly").

## Hostile probe results (14 plan edge cases)

| # | Edge case | Result |
|---|---|---|
| 1 | Thin brief / "audience is everyone" | ✓ `audienceSpecificity = brief.missingFacts.includes('audience') ? 35 : 82` (`content-agency.ts:494`) — warning emitted, not hallucinated |
| 2 | Competitor transcript with prompt injection | ✓ `competitor_prompt_injection_blocked` blocker at `:521` |
| 3 | User asks to copy a viral creator exactly | ✓ `copying_competitor_creative_blocked` at `:1083` via `/copy this\|same script\|same words\|use exact/i` |
| 4 | Branded content missing disclosure | ✓ `sponsored_or_branded_content_requires_clear_disclosure` at `:1075` (P2: label drift from registry's `missing_disclosure`) |
| 5 | Fake analytics request | ✓ `unsupported_or_overconfident_claim_blocked` at `:1087` |
| 6 | Platform API unavailable | ✓ pipeline-agent / reaction-radar fail-closed (test at line 140) |
| 7 | Empty metrics baseline | ✓ analytics diagnosis returns honest "insufficient evidence" (test fixture pinned) |
| 8 | High CTR + low retention | ✓ diagnosis line 1116 + 1136 |
| 9 | Low CTR + high retention | ✓ diagnosis line 1143 |
| 10 | High views + low follows | ✓ covered by analytics diagnosis pinned in eval harness fixture `analytics_bottleneck_diagnosis` |
| 11 | Cross-tenant reference leakage attempt | ✓ every SELECT scoped by `(user_id, tenant_id)`; agency tables enforce composite filter |
| 12 | Unknown/future iOS enum decoding | ✓ pinned by `ModelDecodingTests.swift` (57 tests pass) |
| 13 | Account switch clears agency state | ✓ pinned by `RepositoryScopeChangeTests:127` |
| 14 | Prompt-injected transcript | ✓ `transcript_prompt_injection_blocked` blocker at `:524`; pinned by harness case `prompt_injected_transcript_guard` |

## P0 / P1 blockers

**None.**

## P2 follow-ups

### P2-1 — Registry `blockedFailureModes` ↔ runtime blocker-string drift

**File**: `src/services/content-agency-rules.ts:202-217` vs `src/services/content-agency.ts:1075`

The rule `disclosure-copyright-claim-safety` lists
`'missing_disclosure'` as a `blockedFailureMode`, but the runtime emits
`'sponsored_or_branded_content_requires_clear_disclosure'`. Other rules
have similar inconsistencies (e.g., `agent-handoffs-evals-guardrails`
doesn't list `'competitor_prompt_injection_blocked'` even though the
runtime emits it).

**Risk**: Contributors who update the registry's `blockedFailureModes`
list will not change runtime behavior; future drift between docs and
enforcement.

**Fix**: Pick canonical IDs. Either (a) make runtime emit exactly the
strings in `blockedFailureModes`, or (b) drop `blockedFailureModes` from
the schema and replace with `runtimeBlockerIds` that compiler-enforces
matches against the actual blocker strings emitted in `content-agency.ts`.

### P2-2 — Handoff "read-back verified" label is loose

**File**: `src/services/content-agency.ts:708`

The handoff sets sourceTrace to `'content_pipeline read-back verified'`
without performing an explicit SELECT after INSERT. The plan literally
says "Pipeline handoff uses the real backend route and read-back; it
must not fake success."

**Risk**: Behavior is correct (better-sqlite3 throws on INSERT failure),
but the contract claim is stronger than the implementation. If someone
later changes the persistence layer to a queued/async writer, the label
silently lies.

**Fix**: After line 700, add:
```typescript
const verify = db.prepare(`
  SELECT id FROM content_pipeline
  WHERE source_agency_package_id = ? AND user_id = ? AND tenant_id = ? AND id = ?
`).get(pkg.id, input.userId, input.tenantId, pipelineId);
if (!verify) throw new Error('content_pipeline read-back failed');
```

Or rename the sourceTrace string to
`'content_pipeline INSERT confirmed'` if the explicit read-back is
intentionally elided.

### P2-3 — Quality rubric doc lags runtime by 6 dimensions

**File**: `docs/content/content-quality-rubric.md`

The doc rubric lists 21 dimensions covering 9 of the 15 plan
dimensions; the runtime (`content-agency.ts:494-510`) computes all 15.
Missing from doc: `firstFrameClarity`, `emotionalArousalShareability`,
`proofDensity`, `brandConsistency`, `editability`,
`productionFeasibility`.

**Risk**: A reader of the doc (human or future LLM context) will
underestimate the runtime contract; potential mis-direction for future
quality work.

**Fix**: Regenerate the doc rubric from the runtime dimensions list at
`content-agency.ts:494-510`. Keep the doc as the authoritative
human-readable view; let runtime stay canonical.

### P2-4 — Agency tables lack UNIQUE constraint

**File**: `migrations/128_content_agency.sql` (all 7 table definitions)

Indexes on `(tenant_id, user_id, agency_id)` are present but
`UNIQUE`-less. If `agency_id` (a deterministic-but-not-collision-proof
hash) collides under different input permutations, duplicate rows
accumulate silently.

**Risk**: Low probability today (hash space is large), but unbounded if
the project ever grows hot-input replay paths.

**Fix**: Either change each `CREATE INDEX ... ON ...(tenant_id, user_id,
agency_id)` to `CREATE UNIQUE INDEX`, or add an explicit `UNIQUE
(tenant_id, user_id, agency_id)` constraint to the table definitions.
Note: doing this on existing tables requires checking for existing
duplicates first.

## P3 follow-ups

### P3-1 — iOS live UI tests need authenticated simulator

My re-run of the iOS suite shows 71 passed / 2 failed; Codex reported
9/9. The 2 failures are `test_liveCurrentAccountLaunchAndNavigationDoesNotFreeze`
and `test_liveNexusHubBotContentCreationWorkflow` in
`ContentCreationLiveWorkflowUITests.swift`. Both timeout waiting for
the tab bar; visible text shows the marketing landing page. **These
need a pre-authenticated simulator** (Codex's run likely had one, or
they selected only the fixture test). The actual Content Agency UI
extraction test (`test_contentAgencyFixtureOutputIsActionableCleanAndExtractable`)
PASSES.

Fix: Either (a) skip the `live*` tests when no session is available, or
(b) document the prerequisite in `Nexus HubUITests/README.md`.

### P3-2 — Tighten fixture installer guard

`Nexus Hub/Core/TrainingLocalSmokeFixtures.swift:1` uses
`#if DEBUG || RELEASE_WITH_TESTING`, matching project convention.
Optional hardening: switch to `#if DEBUG` for the Content Agency
fixture installer specifically, since fixtures here inject a full
package state that other infra fixtures do not.

## Plan-gap analysis

| Plan phase | Status |
|---|---|
| Phase 0 — Preserve and inventory | ✓ |
| Phase 1 — Existing-agent health gate | ✓ (5 direct tests) |
| Phase 2 — Full reference-pack registry | ✓ (11/11 categories) |
| Phase 3 — Creator agency orchestrator | ✓ (`content-agency.ts` 1242 LoC, single canonical) |
| Phase 4 — Public APIs and types | ✓ (8 routes, 14/14 envelope fields) |
| Phase 5 — Data model and persistence | ✓ (7/7 tables, P2 on UNIQUE) |
| Phase 6 — Originality, safety, compliance gates | ✓ (15/15 dimensions, P2 on label drift) |
| Phase 7 — iOS Creator Agency experience | ✓ (11/11 sections) |
| Expanded test plan: existing-agent regression gate | ✓ |
| Expanded test plan: reference coverage tests | ✓ (`content-skill-refactor-qa-validation.test.ts`) |
| Expanded test plan: backend output-quality tests | ✓ (eval harness 27 cases, 0 critical) |
| Expanded test plan: analytics diagnosis tests | ✓ |
| Expanded test plan: critical user simulation | ✓ (eval harness includes `prompt_injected_transcript_guard`, `branded_content_disclosure_gate`, etc.) |
| Expanded test plan: prompt and grounding tests | ✓ |
| Expanded test plan: iOS output extraction tests | ✓ (`ContentCreationLiveWorkflowUITests:61-132`) |
| Expanded test plan: adversarial tests | ✓ (eval harness fixtures) |
| Expanded test plan: eval harness release gate | ✓ (91/100, threshold 90) |
| Expanded test plan: manual QA checklist | This QA report is the canonical instance |

Plan is fully implemented. The 4 P2 findings above are precision/hygiene
fixes, not implementation gaps.

## Cleanup confirmation

- iOS xcscheme + project drift preserved.
- Engine workspace mirror + smoke-evidence preserved (untracked).
- No production posting, ad spend, platform mutation, push, deploy, or
  TestFlight cut.
- iOS sim `A0B13967-...` ran only the named test targets, no real
  account login.
- Eval harness was fixture-mode only (`--mode fixture`), no live
  provider calls.

## Mergeability

Ready to land **after** the 4 P2 fixes (~2-3 hours mechanical work).
Branch is otherwise behavior-complete for the plan it set.

## Hand-off recommendation

**Ship with conditions.** Apply the 4 P2 fixes, commit the dirty state,
re-run the eval harness (expect score to hold at 91 or improve to 92
once registry/runtime are aligned), then push and merge.

---

Generated 2026-05-14 by Claude Opus 4.7 on engine `main` @ `87d86ff8`
and iOS `main` @ `22e7402`.
