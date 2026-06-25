# Content Creation Engine Hardening Handoff

Date: 2026-06-24 / 2026-06-25 Lisbon
Scope: Content creation backend engine, Python content-engine provenance contract, Content Studio local E2E harness, and paired iOS Content Studio validation.

## Verdict

IMPLEMENTED AND LOCALLY VALIDATED THROUGH PRE-PROD READINESS.

The Content Creation Engine hardening plan and the independent QA fixes are implemented across the backend, Python content-engine, E2E harness, and paired iOS Content Studio surfaces. The latest full local E2E harness started fresh backend/content-engine containers from the current checkout, captured runtime identity, verified `/health` and content-engine `/ready`, ran the Content Studio UI chunks on the iOS simulator, and launched the authenticated simulator session for Felipe's manual script-quality review.

A residual P3 re-verification on 2026-06-25 rebuilt the latest local backend/content-engine containers from commit `d3935c427c5c1079e18b4c7d8f22f6f01122dbd9`, confirmed `/health` and content-engine `/ready`, reran the full backend risk gate, and left the iOS simulator authenticated in Content Studio against `http://127.0.0.1:8200` with live script generation enabled for Felipe's manual quality review.

The release remains intentionally gated before production: `eval:content` reports `PASS_WITH_CONDITIONS` because the fixture/local lane is green but real-provider/manual script-quality evidence is still required. Do not promote production until Felipe manually accepts script quality.

No production deploy, commit, push, TestFlight upload, iOS release promotion, or cleanup/reset was performed.

## Claim

L4. This handoff claims local runtime/integration validation with independent QA-driven fixes and simulator evidence. It does not claim L5 production deployment, production health, TestFlight readiness, or human approval of subjective script creativity.

## Limits

- No production deploy, release promotion, TestFlight upload, commit, push, branch switch, broad cleanup, or reset was authorized or performed.
- Human script-quality judgment remains Felipe's manual review responsibility; automation validates contracts, provenance, scope, metadata, and UI workflow readiness.
- The latest `npm run smoke:content:local` run reached the local runtime and content smoke sections successfully, then exited non-zero because `eval:content` intentionally returns non-zero on `PASS_WITH_CONDITIONS` without real-provider/manual evidence.
- Adjacent iOS dirty work outside the content/auth files listed below remains out of scope and must be preserved.

## Implemented

- Added the shared `ContentResearchPackage` contract and propagated source mode, freshness, confidence, source counts, claim ledger, warnings, publishability, and quality blockers through discovery, Radar, agency, script refresh, and script responses.
- Hardened research provenance so URL-less, non-HTTP, mock, degraded, untrusted, and prompt-injection-tainted sources cannot silently become publishable research.
- Rebuilt client-provided agency research packages from sanitized source input instead of trusting forged `sourceMode`, `publishable`, or source-count metadata.
- Added per-claim source-ledger alignment, source reference validation, and explicit unverified handling for unsupported claims.
- Added `CreatorVoiceBrandCardV2` derived from creator profile, pillars, memory, examples, learned patterns, and approved feedback.
- Replaced presence-based voice scoring with semantic checks for tone, cadence, vocabulary, banned phrases, audience fit, pillar fit, POV, CTA style, language, proof style, and missing voice DNA.
- Expanded script/platform handling to the backend ontology and surfaced honest script metadata: `agentSignalsUsed`, `sourceMode`, `voiceCardVersion`, source counts, blockers, warnings, freshness, and research-refresh state.
- Fixed tenant/user-scope gaps in saved ideas and topic context so idea promotion, feedback, and generated scripts stay within the current user boundary.
- Closed the independent QA topic-context tenant-scope backlog: pipeline, topic feedback, and saved-idea topic context now resolve through shared `contentScopePredicate`/`contentScopeParams`, with defensive read-back authorization for pipeline rows.
- Upgraded Creator Agency behavior so transcript-only or source-poor inputs stay non-publishable while source-backed briefs can still carry structural specialist warnings without being falsely blocked.
- Hardened Python content-engine source-mode classification, mock URL detection, degraded/mock warning accumulation, original-title preservation, and URL-less `none` mode handling.
- Added Content Studio local E2E harness support for building latest backend/content-engine images, recording commit/image digests/build identity, checking runtime readiness, launching iOS UI suites, and writing Felipe's manual script-quality scenarios/checklist.
- Added iOS local-auth import ordering and inline auth payload forwarding so fixture installs preserve the imported authenticated local user.
- Added Content Studio profile/brief list accessibility identifiers and safer UI helpers for profile, pillars, references, Radar, briefs, and script flow automation.
- Hardened Content References decoding so snake/camel payloads with numeric or string score fields are accepted.
- Added iOS source-pin/unit coverage for auth import order, fixture auth preservation, inline auth forwarding, content reference decoding, and live workflow selector/scrolling guards.
- Applied independent re-QA P2/P3 provenance fixes: source origins now distinguish server-fetched sources from client-asserted URLs; `/agency/score` suppresses client-forged provenance; claim-ledger support stays aligned to each normalized source; TypeScript mock URL detection matches the Python contract for exact example hosts, `/mock/` path segments, and `?mock=1`; generate/edit script quality blockers now use the same publishability mapping.
- Applied re-QA robustness/visibility fixes: topic-context feedback/idea lookups degrade safely on partial local schemas, mock-note detection no longer downgrades generic "mock exam" phrasing, edit/expand warnings use public warning text, and iOS decodes/renders script provenance, source counts, blockers, quality reports, and a distinct red "Not publishable" state.
- Fixed Content Studio pipeline UI test state setup so the stage-strip test explicitly returns to the Today zone before tapping `content-stage-script`, avoiding persisted-zone order dependence.
- Closed residual P3 provenance issues: external URLs now fail closed as `client_asserted` unless the server call site explicitly marks `sourceOrigin: "server_fetched"`; duplicate `mock` query params are detected if any value is `1`; non-HTTP(S) reserved-host URLs stay non-publishable; and claim-ledger rows only inherit source-backed text from the paired normalized source.
- Closed residual iOS visibility issues: nested `research.publishable=false` is decoded, generate-only blocker codes are humanized, and rewrite/expand source-collapse states show a warning-level "Re-verify sources" treatment instead of a hard generation failure.
- Fixed local pre-prod smoke auth helpers so sandbox iOS registration, ChatV2 tenant security smoke, ChatV2 parity observation, and ChatV2 runtime evidence smoke all send current `acceptedLegal` payloads.
- Closed final residual P3 findings: Python content-engine mock-note classification now matches the TypeScript anchored/word-boundary contract without false-positive `mock exam` downgrades; iOS has negative regression coverage for mock/fixture research staying hard non-publishable; local smoke legal acceptance derives versions from `CURRENT_LEGAL_DOCUMENTS` instead of hard-coded strings; and the Content Creation E2E harness forwards `NEXUS_LIVE_GENERATE_SCRIPT` into UI and manual simulator launch paths.

## Backend Files Changed

- `src/services/content-research-package.ts`
- `src/services/content-voice-brand-card.ts`
- `src/services/content-agency.ts`
- `src/services/content-day-to-day-evaluation.ts`
- `src/services/content-discovery.ts`
- `src/services/content-engine.ts`
- `src/services/content-generation-quality.ts`
- `src/services/content-radar-engine.ts`
- `src/services/content-script-quality.ts`
- `src/services/content-workflow.ts`
- `src/state/saved-ideas.ts`
- `src/api/routes/content.ts`
- `src/api/routes/content-agency-routes.ts`
- `src/api/routes/content-script-routes.ts`
- `src/api/routes/content-script-route-utils.ts`
- `src/api/routes/content-script-utils.ts`
- `src/api/routes/content-topic-context.ts`
- `content-engine/models/requests.py`
- `content-engine/services/orchestrator.py`
- `scripts/content-creation-e2e-validation.sh`
- `scripts/full-nexus-local-engine.sh`
- `scripts/chat-tenant-security-smoke.js`
- `scripts/chatv2-observe-legacy-parity.ts`
- `scripts/chatv2-runtime-evidence-smoke.ts`
- Content-focused Vitest/Python regression files under `__tests__/...` and `content-engine/tests/test_research_provenance_contract.py`
- Content docs: `docs/content/content-agency-model.md`, `docs/content/content-generation-pipeline.md`

## Paired iOS Files Changed Or Exercised For This Work

- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/AuthManager.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/DebugAuthTokenImporter.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/TrainingLocalSmokeFixtures.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Core/Services/ContentService.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Content/ContentBriefEditorView.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Content/ContentCreatorProfileView.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Content/ContentEditableStringListRows.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Content/ContentReferencesView.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Content/ScriptGenerationCard.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubTests/ContentReferenceLocalStoreTests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubTests/ContentScriptProvenanceDecodingTests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubTests/DebugAuthTokenImporterPolicyTests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubTests/NavigationPerformanceSourcePinsTests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/ContentCreationLiveWorkflowUITests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/ContentStudioPipelineUITests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/ContentStudioTodayStatesUITests.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubUITests/LocalEngineUITestHelpers.swift`

The iOS checkout also has unrelated pre-existing training/auth dirty files and generated local artifacts. Preserve them unless Felipe explicitly asks for cleanup.

## Verification Evidence

Executed in `/Users/felipedominguez/.codex/worktrees/28a9/cortex-telegram-hub-bot` unless noted.

| Check | Result |
| --- | --- |
| `git status --short --branch` | Detached `HEAD (no branch)`, dirty expected implementation files |
| `scripts/risk-gate.sh --dry-run` | PASS; selected typecheck, focused content Vitest, changed Vitest, content-engine pytest |
| `bash -n scripts/content-creation-e2e-validation.sh` | PASS |
| `bash -n scripts/full-nexus-local-engine.sh` | PASS |
| `node --check scripts/chat-tenant-security-smoke.js` | PASS |
| `python3 -m py_compile content-engine/services/orchestrator.py` | PASS |
| `npx vitest run __tests__/api/content-topic-context.test.ts` | PASS: 1 file / 6 tests |
| `npx vitest run __tests__/scripts/full-nexus-local-engine.test.ts` | PASS: 1 file / 4 tests |
| `npm run typecheck` | PASS |
| `npx vitest run __tests__/services/content-day-to-day-evaluation.test.ts` | PASS |
| `npx vitest run __tests__/services/content-research-package.test.ts __tests__/api/content-agency-routes.test.ts __tests__/services/content-agency.test.ts __tests__/api/content-script-route-utils.test.ts __tests__/api/content-topic-context.test.ts __tests__/api/content-script-duration.test.ts` | PASS: 6 files / 70 tests |
| `npx vitest run __tests__/scripts/full-nexus-local-engine.test.ts __tests__/services/content-research-package.test.ts` | PASS: 2 files / 16 tests |
| `npx vitest run content saved-ideas-scope cost-guardrail-global-rest __tests__/scripts/full-nexus-local-engine.test.ts` | PASS: 74 files / 654 tests |
| `content-engine/.venv/bin/python -m pytest content-engine/tests/test_research_provenance_contract.py` | PASS: 6 tests |
| `cd content-engine && .venv/bin/python -m pytest tests` | PASS: 187 passed, 1 warning |
| `scripts/changed-area-classifier.sh --json` | PASS: generatedAt `2026-06-25T09:48:02Z`, 54 changed files, tiers T0/T1/T2/T4/T5-on-promote/T6-postdeploy |
| `scripts/risk-gate.sh` | PASS: focused content matrix 59 files / 493 tests, changed-file Vitest 80 files / 1428 tests, full content-engine pytest 187 passed / 1 warning |
| `npm run eval:content` | EXIT 1 by design on conditions; score 95/100, 27/27 cases passed, 0 critical failures, release gate `PASS_WITH_CONDITIONS`; report `reports/content-eval/content-eval-2026-06-25T08-46-55-289Z.json` |
| `PORTAL_PORT=8291 npm run smoke:content:local` | EXIT 1 at final eval condition; local backend started, sandbox iOS auth registered with legal acceptance, authenticated API smoke 13/13 passed, cross-skill fixture checks passed, chat tenant smoke 15 pass / 1 partial, content smoke 14 files / 142 tests passed, eval 95/100 `PASS_WITH_CONDITIONS`; evidence `docs/release/smoke-evidence/content-full-nexus-local-d3935c42-20260625T085058Z.json` |
| XcodeBuildMCP `build_sim` for `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj`, scheme `Nexus Hub`, simulator `iPhone 17 Pro` | PASS: build succeeded, no MCP-reported errors |
| XcodeBuildMCP `test_sim -only-testing:Nexus HubTests/ContentScriptProvenanceDecodingTests` | PASS: 9 tests |
| XcodeBuildMCP Content Studio UI classes (`ContentStudioShellUITests`, `ContentStudioPipelineUITests`, `ContentStudioComposerUITests`, `ContentStudioTodayStatesUITests`, `ContentStudioQuickCaptureUITests`) | PASS in xcresult summary after MCP timeout: 20 passed / 0 failed |
| iOS `ContentStudioShellUITests` via `scripts/ios-single-simulator-test.sh` | PASS: 4 tests |
| iOS `ContentStudioPipelineUITests` via `scripts/ios-single-simulator-test.sh` | PASS: 3 tests after explicit Today-zone setup fix |
| iOS `ContentStudioComposerUITests` via `scripts/ios-single-simulator-test.sh` | PASS: 4 tests |
| iOS `ContentStudioTodayStatesUITests` via `scripts/ios-single-simulator-test.sh` | PASS: 6 tests |
| iOS `ContentStudioQuickCaptureUITests` via `scripts/ios-single-simulator-test.sh` | PASS: 3 tests |
| iOS focused script fixture UI test | PASS: `.local/content-creation-e2e/focused-script-fixture-20260624T222004Z` |
| iOS focused live workflow UI test | PASS: `.local/content-creation-e2e/focused-live-workflow-20260624T230439Z` |
| iOS content reference decoder focused test | PASS: `.local/content-creation-e2e/ios-channel-decoder-20260624T225422Z` |
| iOS auth/source-pin/unit slice | PASS: 21 tests, `.local/content-creation-e2e/ios-auth-source-pins-20260624T230924Z` |
| `bash scripts/content-creation-e2e-validation.sh` | PASS: full latest-container + iOS simulator validation |
| `NEXUS_LIVE_GENERATE_SCRIPT=1 IOS_SIM_UDID=02ED1724-41B4-4711-891B-0D753375B9C5 bash scripts/content-creation-e2e-validation.sh` | PARTIAL after successful runtime/backend/Python/Xcode work: latest containers rebuilt and healthy, harness backend content tests passed, Python provenance tests passed, `ContentCreationLiveWorkflowUITests` Xcode run passed, then the existing iOS wrapper emitted a post-success shell error and the wrapper was stopped. Manual simulator launch was completed directly against the rebuilt local stack. |

Current residual P3 runtime evidence directory:

- `.local/content-creation-e2e/20260625T093546Z`
- Runtime identity: `.local/content-creation-e2e/20260625T093546Z/runtime-identity.json`
- Manual review launch: `.local/content-creation-e2e/20260625T093546Z/ios-manual-launch.txt`
- Content Studio screenshot: `.local/content-creation-e2e/20260625T093546Z/content-studio-simulator.jpg`
- Felipe script-quality scenarios: `.local/content-creation-e2e/20260625T093546Z/felipe-script-quality-scenarios.json`
- Felipe script-quality checklist: `.local/content-creation-e2e/20260625T093546Z/felipe-script-quality-checklist.md`

Current residual P3 runtime identity:

- Commit: `d3935c427c5c1079e18b4c7d8f22f6f01122dbd9`
- Backend URL: `http://127.0.0.1:8200`
- Content-engine URL: `http://127.0.0.1:8100`
- Node image digest: `sha256:2f94df85d3a38ba8ae9ca035a5fc67fc027803ed5e6a716ccb19bb45887b2bca`
- Content-engine image digest: `sha256:5e080e68b2d8f65b9d32722eb6fa218e1cad1ed7f175dbecfebfa11b393bcda1`
- Backend `/health`: healthy, database connected
- Content-engine `/ready`: ready, internal auth configured

Passing full E2E evidence directory:

- `.local/content-creation-e2e/20260624T234902Z`
- Runtime identity: `.local/content-creation-e2e/20260624T234902Z/runtime-identity.json`
- Backend health: `.local/content-creation-e2e/20260624T234902Z/backend-health.json`
- Content-engine ready: `.local/content-creation-e2e/20260624T234902Z/content-engine-ready.json`
- iOS UI logs: `.local/content-creation-e2e/20260624T234902Z/ios-ui-logs/`
- Manual review launch: `.local/content-creation-e2e/20260624T234902Z/ios-manual-launch.txt`
- Felipe script-quality scenarios: `.local/content-creation-e2e/20260624T234902Z/felipe-script-quality-scenarios.json`
- Felipe script-quality checklist: `.local/content-creation-e2e/20260624T234902Z/felipe-script-quality-checklist.md`

Runtime identity from the passing full E2E run:

- Commit: `d3935c427c5c1079e18b4c7d8f22f6f01122dbd9`
- Backend URL: `http://127.0.0.1:8200`
- Content-engine URL: `http://127.0.0.1:8100`
- Node image digest: `sha256:2a31f0115f9969a00cb3eef75a4064d6fb330cf4d94b17090b3c967ed5de9ec8`
- Content-engine image digest: `sha256:b03446bf039645021f2d8e0006baa6b446e3b4443a0ab8605850010b52f13036`
- Backend `/health`: healthy, database connected
- Content-engine `/ready`: ready, internal auth configured

Full E2E iOS chunks passed:

- `ContentCreationLiveWorkflowUITests`
- `ContentStudioShellUITests`
- `ContentStudioTodayStatesUITests`
- `ContentStudioPipelineUITests`
- `ContentStudioComposerUITests`
- `ContentStudioQuickCaptureUITests`

## Manual Script Quality Review

Felipe remains the final judge of script creativity and usability. The harness generated the seeded manual scenarios and checklist and launched the authenticated simulator session against the latest local engine. Automated checks validated contracts, source provenance, tenant scope, UI flow, runtime identity, and quality-gate metadata. Live script generation inside the simulator remains gated behind `NEXUS_LIVE_GENERATE_SCRIPT=1`; the default E2E run validates plumbing and fixture-safe script behavior without spending provider calls.

The current manual simulator session is running on `iPhone 17 Pro` (`02ED1724-41B4-4711-891B-0D753375B9C5`) with bundle `me.nexushub.app`, local auth imported from `.local/full-nexus/local-ios-auth.json`, backend `http://127.0.0.1:8200`, and `SIMCTL_CHILD_NEXUS_LIVE_GENERATE_SCRIPT=1`. The simulator is on the Content Studio screen (`Estúdio de conteúdo`) and ready for Felipe's review.

Relaunch command for the same manual session:

```bash
SIMCTL_CHILD_NEXUS_LOCAL_AUTH_IMPORT_PATH=/Users/felipedominguez/.codex/worktrees/28a9/cortex-telegram-hub-bot/.local/full-nexus/local-ios-auth.json SIMCTL_CHILD_NEXUS_LIVE_GENERATE_SCRIPT=1 xcrun simctl launch --terminate-running-process 02ED1724-41B4-4711-891B-0D753375B9C5 me.nexushub.app -NexusUITestMode YES -nexus_allow_local_backend YES -nexus_base_url http://127.0.0.1:8200 -nexus_debug_local_auth_import YES
```

Manual acceptance criteria for Felipe:

- Script feels on-brand and follows configured tone, language, banned phrases, CTA style, and proof style.
- Script is specific to the selected pillar, audience, and platform.
- Script uses source-backed claims honestly and visibly distinguishes degraded/no-source research.
- Script is creative enough, non-generic, platform-native, filmable, and usable without a major rewrite.
- Weak profile, conflicting voice rules, no-source/degraded research, competitor reference, high-risk claim, and multi-format scenarios behave honestly.

## Known Risks And Assumptions

- Backend worktree is detached (`HEAD (no branch)`); no commit was made.
- No production deploy, release promotion, or TestFlight action was authorized or performed.
- Adjacent iOS checkout contains unrelated dirty training/auth files and generated artifacts; do not revert them as part of this content work.
- Existing hoisted `vi.mock` warnings in `__tests__/services/script-pipeline.test.ts` remain warnings, not failures.
- Existing Xcode/iOS warnings from unrelated tests remain warnings, not failures; the touched Content Script provenance unit test and Content Studio UI classes passed.
- `scripts/ios-single-simulator-test.sh` in the iOS checkout was already dirty during this verification window and was not reverted; preserve unrelated iOS work unless Felipe authorizes cleanup.
- The residual P3 E2E harness hit an existing iOS wrapper post-success shell error after `ContentCreationLiveWorkflowUITests` reported `TEST SUCCEEDED`; the local stack and manual simulator were launched directly afterward and remain running for Felipe.
- The UI test chunk printed its fixture-safe live-generation skip notice even with the harness env patch, so Felipe's subjective script-quality review should use the direct manual app session, which was launched with `SIMCTL_CHILD_NEXUS_LIVE_GENERATE_SCRIPT=1`.
- `fixture` remains in the Python content-engine source-mode Literal intentionally as deterministic local eval/E2E provenance. It is documented as non-publishable in `docs/content/content-generation-pipeline.md`.
- Human script-quality review is intentionally manual; automated gates prove correctness, provenance, regression safety, and UI workflow readiness.

## Verifiable Reward Summary

- Verdict: MANUAL_REQUIRED in raw run `.local/reward-runs/2026-06-25T09-51-47-998Z-7a992439-e6e2-496e-8953-709ef6b10bfa.json`.
- Score: 88.
- Area: release.
- Changed-area classifier: PASS; content/research + Python engine + docs/test change set classified successfully.
- Hard failures: none.
- Mandatory checks: PASS 4, SKIPPED 1.
- Skipped checks and reasons: `release-verification-evidence` requires Felipe's manual script-quality acceptance before production release evidence can exist.
- Evidence commands: `git status --short --branch`; `scripts/changed-area-classifier.sh --json`; `scripts/risk-gate.sh --dry-run`; `bash -n scripts/content-creation-e2e-validation.sh`; `bash -n scripts/full-nexus-local-engine.sh`; `node --check scripts/chat-tenant-security-smoke.js`; `python3 -m py_compile content-engine/services/orchestrator.py`; `npm run typecheck`; focused `npx vitest run ...`; `cd content-engine && .venv/bin/python -m pytest tests`; `scripts/risk-gate.sh`; `npm run docs:audit`; focused iOS `xcodebuild` slices through XcodeBuildMCP and `scripts/ios-single-simulator-test.sh`; `bash scripts/content-creation-e2e-validation.sh`; `node scripts/reward-check.mjs --area auto --handoff docs/agents/handoffs/2026-06-24-content-creation-engine-hardening.md --advisory`.
- Evidence artifacts: `.local/content-creation-e2e/20260624T234902Z`; `.local/content-creation-e2e/20260625T093546Z`; `.local/content-creation-e2e/20260625T093546Z/runtime-identity.json`; `.local/content-creation-e2e/20260625T093546Z/content-studio-simulator.jpg`; `.local/content-creation-e2e/20260625T093546Z/felipe-script-quality-scenarios.json`; `.local/content-creation-e2e/20260625T093546Z/felipe-script-quality-checklist.md`; raw reward JSON under `.local/reward-runs/`.
- Export eligibility: ineligible; manual human review is required before export.
- Prompt/process improvement: keep timestamp-only generated release artifacts out of content hardening diffs, because they can trigger false release-area reward requirements.
