# QA Backend Report - Chat Tenant-Safe Context Audit

Generated: 2026-04-29 03:30 WEST  
Branch: `feature/chat-tenant-safe-context-orchestration`

## 2026-05-04 Closed-Beta Hardening Codex Validation Addendum

Branch: `feature/closed-beta-readiness-hardening-20260503`

Status: second-pass Codex validation completed locally. No push, no deploy, no production data, and no production calendars were used.

Findings and fixes:

- Claude's closed-beta hardening was directionally correct, but the runtime hardcoded-identity sweep was still too narrow. Codex found and neutralized additional founder-shaped defaults in Content agent/runtime paths: `seo-agent.ts` seed keywords, `reaction-radar-agent.ts` fallback pillars and audience/scoring assumptions, `performance-agent.ts` pillar detection, Python `gap_finder.py` seed topics/default language prompt, and Reddit searcher subreddits.
- The strict identity scanner now covers the missed vocabulary class (`Brazilian men 18-35`, free-market/libertarian phrasing, carnivore seed topics, `brasilivre`, and related founder-persona strings) so the regression is caught by CI instead of human memory.
- The changed-area classifier now treats Content agent changes as a cannot-skip security area and routes them to `content-agent-neutrality` plus cross-agent/content regression tests.
- Added `__tests__/security/content-agent-neutrality.test.ts` and `__tests__/scripts/changed-area-classifier.test.ts` so the neutrality and gate-routing fixes are pinned.

Validation:

- `scripts/closed-beta-identity-scan.sh --strict --json`: passed with `0` flags.
- `npx tsc --noEmit`: passed.
- Focused neutrality/security gate: `content-agent-neutrality`, `creator-config-neutrality`, `p0-chat-identity-isolation`, and content formatter identity tests passed: 4 files / 30 tests.
- Content agent regression gate passed: 5 files / 105 tests.
- Classifier gate passed: 2 files / 3 tests.
- Broader security/content scope pass completed locally: 14 files / 113 tests.

Remaining caveat:

- Closed beta remains `READY_WITH_CONDITIONS`, not unconditional ready. Live signed two-account validation, real provider/non-production calendar lifecycle smoke, and portal user-console preference editing remain external validation conditions.

## 2026-05-03 Training Expert-Coach Codex Validation Addendum

Branch: `feature/training-expert-coach-codex-validation`

Status: second-pass Codex validation complete locally. No production deploy.

Findings and fixes:

- Claude's week-1 past-day floor was valid, but incomplete: same-day sessions could still schedule earlier than the plan creation time. Codex added a `notBefore` floor to `scheduleSessionWindow` and passed the plan/sync clock from persistence and calendar sync.
- Claude's plan-linter pure tests were valid, but the persistence bridge did not actually feed scheduled dates into lint sessions. Codex now pairs persisted calendar event starts back into lint sessions so exact-date rules catch boundary cases such as Sunday heavy lower before Monday long run.
- The archived `prompts/daily-content-discovery.md` prompt-cleanliness assertion was stale after closed-beta hardening archived that prompt. Codex updated the test to assert the runtime prompt stays removed and the archived evidence remains in `docs/archive/2026-05/content/`.

Validation:

- `npx tsc --noEmit`: passed.
- Focused Training persistence/linter tests passed.
- Broad Training regression passed: 39 files / 474 tests.
- Full backend Vitest passed: 437 files / 6645 tests.
- Local full Nexus engine smoke passed: 13 authenticated iOS API checks, including Training summary and Training today.
- Initial iOS Training fixture XCUITest partially passed: 3 rich-fixture interactions passed, but `test_noPlanFixture_createPlanSheetStrengthStepperAccepts5Sessions` failed because `training-action-createPlan` did not render. This is now superseded by the paired iOS validation branch, where the full physical-device `TrainingFixtureBypassUITests` passes 11/11.

Remaining caveat:

- Training is `READY_WITH_CONDITIONS`, not fully closed-beta ready. The backend is locally strong and the iOS no-plan create-plan CTA gap was fixed in the paired iOS validation branch, but full backend-generated iOS Training workflows A-I are not end-to-end validated and plan-linter blockers remain advisor-only instead of strict/repair.

Detailed report: `docs/training/training-expert-coach-codex-validation.md`.

### 2026-05-03 Training goal-mode / priority request-contract addendum

Status: app-facing request-contract closure completed locally on the same branch. No production deploy.

Changes verified:

- `/api/v1/training/plan/generate` now accepts allowlisted `goalMode`, `trainingPriority`, and request `raceDate`.
- Unsupported goal modes, priorities, and malformed dates are dropped before planning.
- Request `raceDate` is injected into the normalized running profile used by coach-kernel generation and plan-linter context, so an app-supplied race date no longer depends on stale stored profile data.
- Coach-kernel planning uses the requested goal mode to mark maintenance / return-to-training intent and uses requested training priority to order planning goals.
- Generation response echoes `goalMode`, `trainingPriority`, and `raceDate` for iOS contract verification.

Validation:

- `npx tsc --noEmit`: passed.
- Focused generation tests: `training-plan-generation.test.ts` 20/20 passed.
- Combined Training generation/regression slice: 74/74 passed across Training generation, coach-kernel generation, lifecycle, weekly-target, and persistence tests.

Remaining caveat:

- Plan-linter blockers remain advisor-only. Full backend-generated iOS Workflows A-I still need local full-engine/provider-safe validation.

## 2026-05-03 Closed-Beta Identity Validation Addendum

Branch: `feature/closed-beta-readiness-codex-validation`

Status: second-pass Codex validation complete locally. No production deploy.

Findings and fixes:

- Claude's closed-beta identity scanner was valid but too narrow. It missed legacy Content runtime strings such as `ÂNGULO DO FELIPE`, `Felipe's style`, `Felipe's take`, and `Felipe's niches`. The scanner now covers those patterns and excludes generated Python virtualenv/build output so strict scans finish quickly.
- Legacy deep-search briefings that still contain `ÂNGULO DO FELIPE:` are now rendered to users as `SEU ÂNGULO`, preserving backward compatibility without leaking founder copy into runtime output.
- Residual Content model comments and a live sidecar synthesis prompt were neutralized from founder-specific or male-default creator language to authenticated-creator language.
- The stale `prompts/daily-content-discovery.md` design doc was moved under `docs/archive/2026-05/content/` so active runtime prompt sweeps do not need to allowlist Felipe-specific prompt drafts.

Validation:

- `npx tsc --noEmit`: passed.
- `npx vitest run __tests__/agents/voice-evolution-agent.test.ts __tests__/agents/voice-evolution-qa-validation.test.ts __tests__/security/p0-chat-identity-isolation.test.ts __tests__/services/content-telegram-formatter-identity.test.ts __tests__/api/training-plan-calendar-sync.test.ts --reporter=default`: 5 files / 75 tests passed.
- `scripts/closed-beta-identity-scan.sh --strict --json`: 0 flags.
- Local engine `smoke`: 13 authenticated API checks passed.
- Local engine `chat-tenant-smoke`: 15 pass, 1 fixture-provider partial, 0 fail.
- Local engine `chat-eval`: deterministic Chat baseline passed.
- Local engine `cross-skill-fixtures`: deterministic local fixtures passed; staging provider section intentionally blocked in local dry-run mode.
- Direct local API `Who am I?` probe with two named users returned Alice for Alice and Bruna for Bruna, with no cross-user identity leak.
- iOS simulator build passed on iPhone 17 Pro iOS 26.4. Simulator interaction covered Home, Chat, Week agenda, Training, More/Settings, and Connections against the local engine; Chat `Who am I?` returned scoped authenticated-session language and no Felipe leak; 10 rapid bottom-tab taps completed without a hang.

Remaining caveat:

- This is still `READY_WITH_CONDITIONS` rather than unconditional closed-beta readiness because signed-device two-account switching and live non-production Google/Outlook calendar lifecycle smoke remain unvalidated.

## 2026-05-03 Training Poor-Recovery Time-Volume Coherence Addendum

Branch: `feature/p0-readiness-integration-task-isolation`

Status: **Released to production at version `4.14.123` (commit `396b8f0`) on 2026-05-03**, deployed via the documented `deploy-staging.sh` → `staging-smoke.sh` (17/17) → `promote-to-prod.sh` chain. PM2 confirms `nexus-hub` and `content-engine` online post-restart.

Issue addressed:

- The poor-recovery adaptation path in `src/services/coach-kernel/poor-recovery-variation.ts` shrunk `durationMinutes` to a recovery range (20-35 min) but left the original strength session's exercise list attached. The coach-engine evaluation harness flagged this as `time_volume_coherence: 82/100`, with critical failures of the form "Technique Strength + Mobility: claimed 20min, estimated 51min, action trimContent". The 2026-04-28 red-team artefact `docs/training/red-team-open-issues.md` referred to this class of issue under poor-recovery variety; the eval harness pinned the precise pattern.
- The fix applies two transformations after variant selection in `adaptSessionForPoorRecovery`:
  1. For variants with `sessionType: 'mobility'`, clear the inherited exercise list (mobility variants are explicitly empty-block sessions, matching the existing variety-test contract that mobility recovery sessions hold no exercises).
  2. For variants with `sessionType: 'strength_maintenance'`, run the existing `trimOverstuffedStrengthSessionToDuration` utility from `session-coherence.ts` to drop trailing accessory volume until the content matches the shrunk duration.
  3. After both transformations, run `validateSessionCoherence` and shrink `durationMinutes` to the estimated content when the session is still underfilled. The variant's `minMinutes` becomes a soft preference; coherence becomes a hard requirement so the user-visible duration matches what the session can credibly deliver.

Eval impact:

- Overall score: 97 → **99** across 156 cases.
- `time_volume_coherence` dimension: 82 → **98**.
- Lowest-case score: 88 → 94.
- Critical failures in lowest 10 cases: 7 → **0**.
- Eval baseline artefacts: `/tmp/training-eval-2026-05-03/results.json` (post-trim, before duration honesty), `/tmp/training-eval-2026-05-03/results-v2.json` (final).

Validation:

- `npx tsc --noEmit`: passed.
- Focused `coach-kernel-poor-recovery-variation` + `coach-kernel-session-coherence`: 35/35 passed (added 2 regression tests).
- Broader training suite: 46 files / 615 tests passed.
- Full backend vitest: 432 files / **6557 tests** passed (was 6555 pre-fix; the +2 are the new regression tests).

Files changed:

- `src/services/coach-kernel/poor-recovery-variation.ts`
- `__tests__/services/coach-kernel-poor-recovery-variation.test.ts`

Remaining caveat:

- Production-safe Felipe / Jaqueline / `nexushubbot` validation (workspace P1) was not part of this deploy and remains open. The TestFlight runbook for the fix is at `docs/release/training-recovery-fix-testflight-checklist.md` (workspace level).

## 2026-05-02 P0 Readiness / Garmin / Task-List Isolation Addendum

Branch: `feature/p0-readiness-integration-task-isolation`

Status: P0 backend fix pass complete locally. No production deploy.

Issues addressed:

- Readiness score and Body Battery reads now execute under the requested user context before Garmin data is fetched. This prevents a non-owner request from falling back to the owner Garmin session during readiness calculation.
- Garmin connection state now requires scoped token material. A stale `garmin_user_tokens.status='active'` metadata row without `garmin_sessions` or valid legacy DB token material no longer renders as connected in `/api/v1/connections` or canonical integration status.
- Passive Garmin data reads no longer import legacy filesystem tokens into arbitrary request-scoped users. Legacy filesystem token migration remains blocked outside explicit auth/manual flows.
- `/api/v1/tasks/list/:listId` bypasses a stale empty list-detail cache when the user-scoped list metadata cache reports a positive task count for the same list, fixing the “Entrada count > 0, detail empty” failure mode.

Validation:

- `npx vitest run __tests__/services/readiness-scorer.test.ts __tests__/services/garmin-session-store.test.ts __tests__/services/garmin-passive-auth.test.ts __tests__/services/integration-status.test.ts __tests__/api/connections-routes.test.ts __tests__/api/connections-tenant-isolation.test.ts __tests__/api/tasks-routes.test.ts --reporter=default` passed: 7 files / 117 tests.
- `npx tsc --noEmit` passed.

Remaining caveat:

- These changes are not deployed to production. Validate against Felipe, Jaqueline, and `nexushubbot` accounts after staging promotion before any production deploy.

## 2026-04-29 Content Editorial Mutation Contracts Addendum

Branch: `feature/content-editorial-mutation-contracts`

Status: Safe P1 backend closure for app-facing Content workflow mutations. No deployment.

Changes validated in this addendum:

- Added `/api/v1/content/workflow/:id` inspection for authorized workflow objects, events, and approval records.
- Added `/api/v1/content/workflow/:id/actions` for lifecycle/editorial actions with `202` approval-required responses.
- Added `/api/v1/content/workflow/:id/source-review` for source/claim review, provenance recording, and review-gate surfacing.
- Added `/api/v1/content/workflow/:id/approval` for approving/rejecting pending workflow gates.
- Added `/api/v1/content/workflow/:id/repurpose` for creating derived Content objects with tenant-scoped reuse lineage.
- Hardened source review so submitted references must match the active tenant scope, and user-private references must match the owner user before provenance is recorded.

Validation:

- `npm test -- --run __tests__/api/content-editorial-routes.test.ts __tests__/services/content-editorial-workflow.test.ts` passed: 2 files / 15 tests.
- `npm test -- --run __tests__/api/content-editorial-routes.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-pipeline-routes.test.ts __tests__/api/content-home-route.test.ts` passed: 5 files / 29 tests.
- `npm run typecheck` passed.

Remaining caveat:

- This closes the backend mutation-contract gap only. iOS/portal still need to call and render these flows, and full local product smoke was not rerun in this slice.

## 2026-04-29 Content-to-Secretary Agenda Ledger Addendum

Branch: `qa/nexus-hub-focused-review-selected-areas`

Status: Safe P1 backend closure. No deployment.

Changes validated in this addendum:

- Updated `requestContentScheduleThroughSecretary()` so Content scheduling requests submit through the Secretary scheduling arbitrator, persist the returned `secretary_agenda_item_id` on the Content object, and write a Content workflow event containing Secretary decision metadata.
- Added focused test coverage proving a Content schedule request creates a `content` agenda item in `secretary_agenda_items`, preserves tenant/user/source ownership, updates the Content object to `scheduled`, and records the Secretary intent in the workflow event log.
- Updated Content production blocker/readiness/risk docs to close `CONTENT-P1-07` for the backend ledger path while preserving the caveat that provider-backed staging calendar smoke and rich frontend schedule-state rendering are still separate release claims.

Validation:

- `npm test -- --run __tests__/services/content-editorial-workflow.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts` passed: 2 files / 19 tests.

Remaining Content P1 conditions:

- Real routed-provider quality sampling.
- Deep iOS Content workflow smoke.
- Tenant-facing portal UI/browser workflows and content-agent settings. Backend portal writes are scoped or blocked where unsafe by the later portal scope addendum below.
- Same-user tenant switching proof across frontend/local cache.
- Broader sensitive-log redaction audit, closed for audited backend/sidecar sinks by the later redaction addendum below.

## 2026-04-29 Content Engine Sidecar Fixture Smoke Addendum

Branch: `qa/nexus-hub-focused-review-selected-areas`

Status: Safe P1 closure for fixture-mode sidecar script generation. No deployment.

Changes validated in this addendum:

- Added explicit Content Engine fixture-mode controls so `CONTENT_ENGINE_FIXTURE_MODE=1` or `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0` blanks external search/provider keys.
- Blocked Python AI proxy calls in fixture mode before they can reach the TypeScript model-routing layer.
- Forced Reddit search to use deterministic mock results in fixture mode; this fixes the unauthenticated live Reddit call observed during the first sidecar smoke attempt.
- Started the Python sidecar locally and verified `/api/v1/script` returns a degraded, topic-grounded fixture script with mock sources and no provider call.

Validation:

- `npm test -- --run __tests__/services/python-engine-hardening.test.ts` passed: 1 file / 51 tests.
- `CONTENT_ENGINE_FIXTURE_MODE=1 NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 CONTENT_ENGINE_PORT=18102 ENV=production content-engine/.venv313/bin/python content-engine/main.py` started the sidecar locally.
- `curl -fsS -X POST http://127.0.0.1:18102/api/v1/script ...` returned HTTP 200 with `degraded=true`, mock sources, and the warning `AI generation was unavailable; returned a topic-aware degraded draft grounded in available research.`
- The sidecar process was stopped and port `18102` was no longer listening after cleanup.

Remaining caveat:

- This closes fixture-mode sidecar script generation only. It does not prove live web/source extraction, live provider quality, or staging sidecar deployment.

## 2026-04-29 Content Sensitive Logging Mitigation Addendum

Branch: `qa/nexus-hub-focused-review-selected-areas`

Status: P1 closure for audited backend/sidecar sensitive-log sinks. No deployment.

Changes validated in this addendum:

- Expanded `LOGGER_REDACTION_PATHS` to redact prompt, system prompt, message, context, memory, reference, draft, script, and voice-profile fields when they are logged as structured Pino properties.
- Added a shared `log-sanitizer` utility for durable sinks that redacts prompt, memory, references, drafts, scripts, voice profile data, provider tokens, cookies, and common secret fields while preserving operational metadata such as endpoint, tenant/user IDs, category, and retry count.
- Wired sanitizer coverage into `error_log`, `client_errors`, categorized agent errors, Sentry/operator-alert forwarding, telemetry summaries, and client-error ingestion.
- Removed raw model/provider response previews from Python Content Engine proxy errors, malformed JSON repair failures, Content gap finder logs, Content workflow topic-response parse failures, Training plan parse failures, and finance vision parse failures.
- Added focused tests for structured logger redaction, durable sink sanitization, client-error payload sanitization, Python raw-output logging guards, and static sensitive log-sink regressions.

Validation:

- `npm test -- --run __tests__/utils/log-sanitizer.test.ts __tests__/utils/logger-redaction.test.ts __tests__/services/error-monitor.test.ts __tests__/services/error-categorizer.test.ts __tests__/api/authenticated-support-routes-scope.test.ts __tests__/services/python-engine-hardening.test.ts __tests__/services/sensitive-log-sinks.test.ts` passed: 7 files / 110 tests.

Remaining caveat:

- This closes the audited backend/sidecar log-sink blocker. New sensitive sinks must use `log-sanitizer` or equivalent redaction with regression coverage before release.

## 2026-04-29 Local Fixture Provider Routing Addendum

Branch: `qa/nexus-hub-focused-review-selected-areas`

Status: P2 local resource-control closure. No deployment.

Changes validated in this addendum:

- Added `areModelProviderCallsDisabled()` for `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0` / `NEXUS_MODEL_FIXTURE_MODE=1`.
- Added a deterministic local `fixture` AI provider that satisfies classify, chat/domain, and tool-continuation calls without touching Gemini, OpenAI, or Anthropic.
- Updated provider registry pair construction so local fixture mode initializes as `routing(fixture)` instead of throwing when provider keys are intentionally blank.
- Preserved live provider routing and operator overrides for normal/staging/production modes; fixture mode is only activated by explicit local resource-control flags.

Validation:

- `npm test -- --run __tests__/services/provider-registry-fixture-mode.test.ts __tests__/services/python-engine-hardening.test.ts __tests__/utils/log-sanitizer.test.ts __tests__/services/sensitive-log-sinks.test.ts` passed: 4 files / 62 tests.

Remaining caveat:

- This proves fixture-mode startup/control semantics only. Live provider quality, fallback behavior, latency, and cost metadata still require a bounded real-provider smoke.

## 2026-04-29 Content Portal Scoped Links Addendum

Branch: `qa/nexus-hub-focused-review-selected-areas`

Status: Superseded partial P1 improvement for tenant-safe portal management writes. Later addendum closes the remaining locally actionable backend write-scope issue; portal UI/browser readiness remains open. No deployment.

Changes validated in this addendum:

- Added tenant/user-scoped backend routes for portal-managed Content links:
  - `GET /api/v1/admin/content/links?userId=&tenantId=`
  - `POST /api/v1/admin/content/links`
  - `DELETE /api/v1/admin/content/links/:id?userId=&tenantId=`
- The link routes require explicit user scope, default tenant to user only when tenant is omitted, use backend tenant/user predicates for reads/deletes, and persist `tenant_id`, `owner_user_id`, `visibility_scope`, `scope_status`, and audit metadata for writes.
- Existing portal write-token behavior is preserved; read tokens can list scoped links but cannot mutate them.

Validation:

- `npm test -- --run __tests__/api/content-admin-write-auth.test.ts __tests__/services/provider-registry-fixture-mode.test.ts` passed: 2 files / 11 tests.

Remaining caveat:

- This does not make the portal a full tenant Content power console. Books, channels, content-agent settings, private drafts, approvals, provenance inspection, and browser/UI smoke remain open release conditions.

## 2026-04-29 Content Eval History And Smoke Runner Addendum

Branch: `qa/nexus-hub-focused-review-selected-areas`

Status: P2 release-evidence and repeatability closure. No deployment.

Changes validated in this addendum:

- Added normalized Content eval-history storage with migration `096_content_eval_history.sql` and `src/services/content-eval-history.ts`.
- The eval-history tables store run/case score metadata, provider trace metadata, paths to report artifacts, open conditions, and release-gate state without raw prompts, transcripts, drafts, references, scripts, or provider outputs.
- Added `--persist-db` support to `npm run eval:content`, writing to an explicit local SQLite path such as `reports/content-eval/content-eval-history.sqlite`.
- Added `scripts/content-full-nexus-local-smoke.sh` and package script `npm run smoke:content:local` to run the Content-focused local smoke/eval/test sequence with fixture provider controls and cleanup.

Validation:

- `npm test -- --run __tests__/services/content-eval-history.test.ts __tests__/services/content-day-to-day-evaluation.test.ts` passed: 2 files / 9 tests.
- `npm run eval:content -- --json reports/content-eval/content-eval-latest.json --markdown docs/content/content-eval-baseline-results.md --fail-under 85 --persist-db reports/content-eval/content-eval-history.sqlite` passed and persisted a 15-case run.
- DB read-back from `reports/content-eval/content-eval-history.sqlite` showed latest run score 91/100, `PASS_WITH_CONDITIONS`, provider `fixture`, model `deterministic-content-fixture`, `real_provider_calls=0`, and `production_data_used=0`.
- `scripts/content-full-nexus-local-smoke.sh run` passed the full local backend wrapper path: backend build/start, authenticated API smoke 13/13, cross-skill fixtures, Chat tenant smoke 12 pass / 2 partial / 0 fail, Content focused tests 15 files / 124 tests, eval persisted, and cleanup stopped the backend with no local backend/content-engine listener remaining.

Remaining caveat:

- This closes repeatability and local eval-history persistence, not live provider quality, rich iOS workflows, tenant portal UI smoke, or true same-user tenant switching. A local credential check showed `GEMINI_API_KEY`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` missing, with `ANTHROPIC_ENABLED` unset, so bounded real-provider sampling could not be honestly run here.

## 2026-04-29 Content Day-To-Day Evaluation Harness Addendum

Branch: `qa/nexus-hub-focused-review-selected-areas`

Status: Deterministic Content Creation quality/simulation harness implemented. No deployment.

Changes validated in this addendum:

- Added `src/services/content-day-to-day-evaluation.ts` with Content persona bank, scenario bank, quality rubric, deterministic multi-turn workflow simulator, failure taxonomy, provider-routing metadata, and Markdown result rendering.
- Added `src/tools/content-evaluation-harness.ts` and `npm run eval:content` for repeatable fixture-first Content quality gates.
- Added `__tests__/services/content-day-to-day-evaluation.test.ts` for persona coverage, multi-turn scenario coverage, rubric scoring, tenant-switch safety, duplicate-topic suppression, provider metadata, and baseline report rendering.
- Created docs: `docs/content/content-day-to-day-simulation-harness.md`, `docs/content/content-persona-bank.md`, `docs/content/content-scenario-bank.md`, `docs/content/content-quality-rubric.md`, `docs/content/content-eval-baseline-results.md`, and `docs/content/content-quality-open-items.md`.

Validation:

- `npm test -- --run __tests__/services/content-day-to-day-evaluation.test.ts` passed: 1 file / 6 tests.
- `npx tsc --noEmit --pretty false` passed.
- `npm run eval:content -- --markdown docs/content/content-eval-baseline-results.md --json reports/content-eval/content-eval-latest.json --fail-under 85` passed.

Baseline result:

- Overall score: 91/100.
- Cases: 15 multi-turn cases.
- Critical failures: 0.
- Production data used: false.
- Real provider calls: false in default fixture mode.
- Release gate: `PASS_WITH_CONDITIONS`.

Remaining Content quality release conditions:

- Full local Nexus engine smoke still required for Chat -> Content -> Secretary -> persistence -> iOS/portal round trips.
- Limited real-provider quality sampling still required before claiming live routed-model output quality.
- iOS and portal rendering of Content source/provenance, approval, workflow, novelty, and scheduling states remains outside this harness.
- Secretary scheduling is evaluated as a contract event here, not as end-to-end agenda creation proof.

## 2026-04-29 Content Full Local Product Smoke Addendum

Branch: `qa/nexus-hub-focused-review-selected-areas`

Status: Full local Nexus product smoke focused on Content Creation completed in fixture mode. No deployment.

Documents created:

- `docs/local/content-full-nexus-local-smoke.md`
- `docs/local/content-full-nexus-local-smoke-results.md`
- `docs/local/content-full-nexus-local-open-blockers.md`
- `docs/local/content-local-cleanup-confirmation.md`

Validation:

- Local backend started attached on `http://127.0.0.1:8200` with `DATABASE_PATH=data/content-full-nexus-smoke.db`.
- `scripts/full-nexus-local-engine.sh health` passed.
- `scripts/full-nexus-local-engine.sh auth-token` created local sandbox iOS auth for user `2`.
- `scripts/full-nexus-local-engine.sh smoke` passed: 13/13 authenticated iOS API checks.
- Local Content REST probes passed for home, pipeline, ideas, books, channels, voice DNA, radar preferences, topic create/update/cancel, and portal read surfaces.
- Content-specific two-user probe passed: User A could not list/delete Tenant B book and could not read Tenant B voice memory.
- Content service suite passed: 10 files / 74 tests.
- Content eval passed with conditions: 91/100, 15 multi-turn cases, 0 critical failures.
- Cross-skill fixture smoke passed local fixture contracts; staging runtime section remained blocked by dry-run design.
- Chat tenant smoke passed with conditions: 12 pass, 2 partial, 0 fail.
- Model-routing local tests passed: 4 files / 33 tests.
- iOS simulator build/run succeeded; app launched with local backend/auth import and rendered Home plus Content workspace.

Resource-control finding:

- Superseded by later fix: with `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`, provider routing now initializes a deterministic local `fixture` provider instead of logging a no-provider initialization error or direct-Anthropic fallback language. No live provider quality claim is made by this fixture mode.

Release gate:

- `PASS WITH CONDITIONS` for local Content product smoke.
- Not a production-ready Content release proof until bounded real-provider sampling, deep iOS Content workflow smoke, tenant-safe portal management smoke, same-user tenant switching, content-engine sidecar validation, and provider-backed calendar staging claims are complete or explicitly accepted. Backend Content-to-Secretary ledger handoff and audited backend/sidecar log-sink sanitization were closed in later addenda above.

## 2026-04-29 Content Frontend Readiness Addendum

Branch: `qa/nexus-hub-focused-review-selected-areas`

Status: iOS and portal readiness audit plus frontend contract documentation. No deployment.

Changes validated in this addendum:

- Created `docs/ios/content-ios-readiness.md` for iOS support, current capabilities, tenant-cache risks, provenance gaps, lifecycle/approval gaps, novelty/reuse gaps, Secretary schedule-state gaps, and smoke blockers.
- Created `docs/portal/content-portal-readiness.md` for portal operator-dashboard vs tenant-safe power-console readiness, admin/support privacy boundaries, User Console requirements, Tenant Content Console requirements, and smoke blockers.
- Created `docs/content/content-frontend-contracts.md` with additive frontend DTO expectations for content objects, references, provenance, radar signals, workflow state, schedule decisions, and novelty/reuse.
- Created `docs/content/content-frontend-open-items.md` with P0/P1/P2/P3 frontend blockers and release-gate conditions.

Validation:

- Static audit of iOS Content files: `ContentRepository.swift`, `ContentService.swift`, `ContentHomeViewState.swift`, `ContentReferencesView.swift`, `ContentIntelligenceView.swift`, `ScriptGeneratorView.swift`, `TopicSchedulerView.swift`, and Content tests.
- Static audit of portal/backend Content files: `portal.html`, `portal/content-routes.ts`, `api/routes/content-dashboard.ts`, `api/routes/content-admin-write.ts`, `services/content-tenant-scope.ts`, `services/content-domain-ontology.ts`, `services/content-reference-provenance.ts`, and `services/content-editorial-workflow.ts`.

Release gate:

- NO-GO for claiming full iOS/portal readiness for upgraded Content Creation. The current iOS app supports the existing Content feature set, and the current portal supports an operator Content dashboard, but neither yet exposes the upgraded provenance, lifecycle, approval, memory, novelty/reuse, tenant-safe reference, or Secretary schedule-decision state as complete frontend product surfaces.

## 2026-04-29 Content Creation Intelligence Addendum

Branch: `feature/content-creation-intelligence-upgrade`

Status: First audit plus safe P1 hardening pass. No deployment.

Changes validated in this addendum:

- Created Content Creation current-state audit, gap analysis, upgrade plan, risk register, open blockers, implementation notes, and cross-skill memory/versioning plan.
- Added route-scope validation to app-facing Content discovery, reference, and learning routes.
- Replaced Content dedup's direct Anthropic API call with `completeOneShotWithFallback()` under category `content_dedup`, preserving live routing and Anthropic gating.
- Partitioned Content dedup cache by resolved user scope.
- Forwarded explicit user scope into Content discovery/workflow dedup call sites.
- Added optional scoped provider metadata to the internal AI proxy and Python content-engine script generation path.
- Scoped Content workflow feedback helpers when userId is supplied, and made the app-facing learning route pass userId.

Validation:

- `npm test -- --run __tests__/api/content-home-route.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/content-workflow-user-scope.test.ts` passed: 5 files / 24 tests.
- `npm test -- --run __tests__/api/internal-routes.test.ts __tests__/services/python-engine-hardening.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/content-reference-routes.test.ts __tests__/services/content-dedup-routing.test.ts` passed: 5 files / 83 tests.
- `npm test -- --run __tests__/services/content-workflow-user-scope.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/internal-routes.test.ts __tests__/services/python-engine-hardening.test.ts __tests__/services/content-dedup-routing.test.ts` passed: 5 files / 81 tests.
- `npm run typecheck` passed after the final code changes.

Remaining Content release blockers:

- No full tenant-owned Content reference model yet.
- Portal/admin Content surfaces remain platform-global until policy/hardening is implemented.
- Content source/provenance and link reference model is missing.
- Superseded by later addendum: Content-to-Secretary scheduling intents and backend ledger handoff are now implemented for `requestContentScheduleThroughSecretary()`.
- Skill memory/version tracking is docs-only.
- iOS readiness for rich Content states is audit-only.
- Local full-product smoke has not been run.

Release gate: NO-GO for production release of the upgraded Content Creation workstream.

## 2026-04-29 Content Domain Ontology Addendum

Branch: `feature/content-creation-intelligence-upgrade`

Status: Additive backend foundation. No deployment.

Changes validated in this addendum:

- Added `migrations/090_content_domain_ontology.sql` for Content ontology metadata, strategy tables, domain objects, and source-output lineage.
- Added `src/services/content-domain-ontology.ts` with typed object schemas, platform format definitions, reference/source definitions, generation readiness validation, and typed extension support.
- Created Content ontology docs: `docs/content/content-domain-ontology.md`, `docs/content/content-object-model.md`, `docs/content/platform-format-model.md`, and `docs/content/content-domain-test-matrix.md`.
- Added `__tests__/services/content-domain-ontology.test.ts` for object schema validity, platform metadata, reference metadata, tenant/user scope, pillar/audience linkage, source-output lineage, missing metadata rejection, and custom format extension.

Validation:

- `npm test -- --run __tests__/services/content-domain-ontology.test.ts` passed: 1 file / 7 tests.
- Fresh in-memory migration replay through all migrations passed.

Release gate: PASS WITH CONDITIONS for this ontology foundation. Existing generation routes do not yet persist ontology metadata for every output, and iOS/portal management surfaces for pillars, campaigns, audience segments, and custom formats remain open.

## 2026-04-29 Content Reference Provenance Addendum

Branch: `feature/content-creation-intelligence-upgrade`

Status: Additive backend trust/provenance foundation. No deployment.

Changes validated in this addendum:

- Added `migrations/091_content_reference_provenance_integrity.sql` for source-health fields, normalized reference registry, and output provenance ledger.
- Added `src/services/content-reference-provenance.ts` with scoped reference registry, source usability checks, claim grounding, output provenance, and source-output link recording.
- Hardened `src/services/content-reference-context.ts` so prompt-facing references exclude broken, stale, deprecated, failed, quarantined, or too-low-confidence sources before model routing.
- Created provenance docs: `docs/content/reference-provenance-integrity.md`, `docs/content/reference-registry-model.md`, `docs/content/content-provenance-model.md`, and `docs/content/reference-provenance-test-matrix.md`.
- Added `__tests__/services/content-reference-provenance.test.ts` for tenant-safe retrieval, book/link/channel use, broken-link exclusion, hallucinated reference rejection, unsupported claim detection, provenance persistence, and cross-tenant rejection.

Validation:

- `npm test -- --run __tests__/services/content-reference-provenance.test.ts` passed: 1 file / 4 tests.
- `npm test -- --run __tests__/services/content-reference-provenance.test.ts __tests__/services/content-domain-ontology.test.ts __tests__/services/content-tenant-scope.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/channel-learner-scope.test.ts __tests__/services/content-radar-preferences.test.ts` passed: 8 files / 37 tests.
- Fresh in-memory migration replay through all migrations passed.
- `npx tsc --noEmit --pretty false` passed.

Release gate: PASS WITH CONDITIONS for the provenance foundation. Existing generation/refinement routes still need broader calls into `recordContentOutputProvenance()`, and iOS/portal attribution rendering remains open.

## 2026-04-29 Content Editorial Lifecycle Addendum

Branch: `feature/content-creation-intelligence-upgrade`

Status: Additive backend lifecycle/workflow foundation. No deployment.

Changes validated in this addendum:

- Added `migrations/092_content_lifecycle_editorial_workflow.sql` for editorial state, approval state, review reasons, Secretary intent metadata, radar conversion metadata, workflow events, and approval records.
- Added `src/services/content-editorial-workflow.ts` with canonical editorial states, radar/reference lifecycle guards, approval evaluation, scoped workflow transitions, radar-to-idea conversion, workflow event inspection, approval record inspection, and Content-to-Secretary scheduling intent construction.
- Added workflow docs: `docs/content/content-lifecycle-model.md`, `docs/content/editorial-workflow.md`, `docs/content/human-approval-rules.md`, and `docs/content/content-lifecycle-test-matrix.md`.
- Added `__tests__/services/content-editorial-workflow.test.ts` for lifecycle transitions, invalid transition rejection, publish approval, tenant-shared schedule approval, low-confidence/unsupported source review, draft deletion protection, radar conversion, Secretary scheduling intent construction, and owner-scope denial.

Validation:

- `npm test -- --run __tests__/services/content-editorial-workflow.test.ts` passed: 1 file / 9 tests.
- `npm test -- --run __tests__/services/content-editorial-workflow.test.ts __tests__/services/content-reference-provenance.test.ts __tests__/services/content-domain-ontology.test.ts __tests__/services/content-tenant-scope.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/channel-learner-scope.test.ts __tests__/services/content-radar-preferences.test.ts` passed: 9 files / 46 tests.
- Fresh in-memory migration replay through all migrations passed.
- `npx tsc --noEmit --pretty false` passed.

Release gate: PASS WITH CONDITIONS for the lifecycle foundation. Existing generation/refinement routes still need broader lifecycle writes, iOS/portal approval/review UI remains open, external publishing is intentionally not implemented, and full local product smoke remains a later release gate.

## 2026-04-29 Content Memory And Voice Profile Addendum

Branch: `feature/content-creation-intelligence-upgrade`

Status: Additive backend memory/profile foundation. No deployment.

Changes validated in this addendum:

- Added `src/services/content-memory-profile.ts` as a Content-specific facade over the shared `skill_memories` ledger.
- Added typed voice profile memory for tone, style, pacing, vocabulary, hook preferences, structure, storytelling, directness, formality, banned phrases, CTAs, and platform-specific voice differences.
- Added tenant-shared brand profile memory for brand rules, audience, pillars, topics to avoid, preferred/disliked formats, positioning, recurring themes, reference preferences, and source trust preferences.
- Added performance-informed memory for successful topics/hooks/formats, weak topics, rejected patterns, and audience response signals.
- Added correction handling and version-aware memory staling through the shared skill memory service.
- Updated script generation to append scoped Content creative-profile memory to the existing creator profile while preserving live provider routing.
- Added docs: `docs/content/content-memory-and-voice-profile.md`, `docs/content/brand-profile-model.md`, `docs/content/content-memory-test-matrix.md`, and `docs/content/content-memory-open-items.md`.
- Added `__tests__/services/content-memory-profile.test.ts` for tenant isolation, private-vs-tenant-shared behavior, correction handling, stale memory exclusion, platform-specific voice, disliked/rejected pattern filtering, successful-pattern scoring, and follow-up prompts.

Validation:

- `npm test -- --run __tests__/services/content-memory-profile.test.ts` passed: 1 file / 8 tests.

Release gate: PASS WITH CONDITIONS for the Content memory foundation. Brand/profile management APIs, iOS/portal editing surfaces, and full product smoke through Chat/Content/model fixture remain open.

## 2026-04-29 Content Radar Opportunity Engine Addendum

Branch: `feature/content-creation-intelligence-upgrade`

Status: Additive backend Radar/opportunity foundation. No deployment.

Changes validated in this addendum:

- Added `migrations/093_content_radar_opportunity_engine.sql` for a tenant-scoped `content_radar_signals` ledger with source, freshness, confidence, relevance, novelty, audience fit, brand fit, platform fit, production feasibility, duplicate-risk, strategic-value, provenance, lifecycle, review, and conversion metadata.
- Added `src/services/content-radar-engine.ts` with deterministic opportunity scoring, tenant-safe signal retrieval, duplicate detection, source/reference signal creation, cross-skill opportunity signal creation, Secretary-capacity-aware prioritization, low-confidence review state, and conversion into Content workflow objects.
- Expanded Radar lifecycle states to include `review_required`, `converted_to_outline`, and `converted_to_calendar_item`.
- Hardened reference-derived Radar creation so cross-tenant references and another user's private references cannot influence Radar.
- Added docs: `docs/content/content-radar-engine.md`, `docs/content/content-opportunity-scoring.md`, `docs/content/cross-skill-content-opportunities.md`, and `docs/content/content-radar-test-matrix.md`.
- Added `__tests__/services/content-radar-engine.test.ts` for tenant-safe retrieval, scoring, stale downgrade, duplicate detection, channel/book-derived signals, private reference denial, Training milestone signal, Secretary capacity prioritization, low-confidence review state, and Radar-to-idea conversion lineage.

Validation:

- `npm test -- --run __tests__/services/content-radar-engine.test.ts` passed: 1 file / 10 tests.
- `npm test -- --run __tests__/services/content-radar-engine.test.ts __tests__/services/content-radar-preferences.test.ts __tests__/services/content-memory-profile.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/services/content-reference-provenance.test.ts __tests__/services/content-domain-ontology.test.ts __tests__/services/content-tenant-scope.test.ts` passed: 7 files / 44 tests.
- Fresh in-memory migration replay through all migrations passed.
- `npx tsc --noEmit --pretty false` passed.
- `git diff --check` passed.

Release gate: PASS WITH CONDITIONS for the Content Radar foundation. API route wiring, iOS/portal rendering, runtime cross-skill hooks beyond the tested Training signal contract, Secretary scheduling smoke, real external trend ingestion, and full local product smoke remain open.

## 2026-04-29 Content Generation Quality Addendum

Branch: `feature/content-creation-intelligence-upgrade`

Status: Additive backend generation/refinement quality foundation. No deployment.

Changes validated in this addendum:

- Added `src/services/content-generation-quality.ts` with platform/format normalization, generation package construction, format-specific output contracts, scoped voice/brand context, authorized reference selection, source-confidence review warnings, provider-routing metadata, generation quality evaluation, and refinement planning.
- Wired `/api/v1/content/script` to include the generation-quality contract in creator context and return backward-compatible optional `generationQuality` metadata.
- Updated `getScript()` so script cache/provider payloads include tenant metadata, preserving live routing and safer provider fallback context.
- Added docs: `docs/content/content-generation-pipeline.md`, `docs/content/platform-specific-generation.md`, `docs/content/content-refinement-workflow.md`, and `docs/content/generation-quality-test-matrix.md`.
- Added `__tests__/services/content-generation-quality.test.ts` for platform-specific output differences, voice profile application, reference-grounded generation context, unsupported claim review, refinement provenance, YouTube-vs-LinkedIn differences, short-form pacing/hook contract, cross-platform adaptation, low-confidence source review, and tenant-safe provider metadata before model calls.

Validation:

- `npm test -- --run __tests__/services/content-generation-quality.test.ts` passed: 1 file / 10 tests.
- `npm test -- --run __tests__/services/content-generation-quality.test.ts __tests__/services/content-radar-engine.test.ts __tests__/services/content-radar-preferences.test.ts __tests__/services/content-memory-profile.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/services/content-reference-provenance.test.ts __tests__/services/content-domain-ontology.test.ts __tests__/services/content-tenant-scope.test.ts` passed: 8 files / 54 tests.
- Fresh in-memory migration replay through all migrations passed.
- `npx tsc --noEmit --pretty false` passed.

Release gate: PASS WITH CONDITIONS for the backend generation-quality foundation. Real provider-backed quality evaluation, full API routes for every non-video format, iOS/portal rendering of generation/refinement quality metadata, and full local product smoke remain open.

## 2026-04-29 Content Duplicate Novelty Reuse Addendum

Branch: `feature/content-creation-intelligence-upgrade`

Status: Additive backend novelty/reuse foundation. No deployment.

Changes validated in this addendum:

- Added `migrations/094_content_duplicate_novelty_reuse.sql` for a tenant-scoped `content_novelty_candidates` ledger and `content_repurpose_history` lineage table.
- Added `src/services/content-novelty-reuse.ts` with deterministic duplicate detection, near-duplicate hook/topic scoring, stale radar repetition suppression, overused-reference warnings, intentional reuse decisions, content-series allowance, and repurpose provenance recording.
- Wired `src/services/content-generation-quality.ts` to assess novelty before provider calls and include scoped novelty/reuse constraints in the generation contract.
- Added docs: `docs/content/duplicate-novelty-reuse-control.md`, `docs/content/content-repurposing-model.md`, and `docs/content/duplicate-novelty-test-matrix.md`.
- Added `__tests__/services/content-novelty-reuse.test.ts` for duplicate idea detection, near-duplicate hook detection, intentional repurpose allowance, cross-tenant exclusion, stale radar suppression, successful-pattern reuse with new angle, content-series related ideas, and overused-reference warnings.

Validation:

- `npm test -- --run __tests__/services/content-novelty-reuse.test.ts` passed: 1 file / 8 tests.

Release gate: PASS WITH CONDITIONS for the backend novelty/reuse foundation. Route-wide artifact write-through, legacy artifact backfill, portal/iOS warning rendering, and full local product smoke remain open.

## 2026-04-29 Content Cross-Skill Orchestration Addendum

Branch: `feature/content-creation-intelligence-upgrade`

Status: Additive backend cross-skill orchestration foundation. No deployment.

Changes validated in this addendum:

- Added `src/services/content-cross-skill-orchestration.ts` with tenant-safe inbound signal consumption from Training, Cooking, Finance, Secretary, and Chat.
- Added code-level sensitive-signal policy for automatic use, summary-only use, review-required signals, and prohibited signals.
- Cross-tenant signals are rejected before Content Radar state is created.
- Accepted inbound signals are converted into tenant-scoped Content Radar signals with source attribution, policy metadata, and downstream implications.
- Permitted Training milestone signals can convert directly into Content workflow ideas; sensitive recovery signals require review.
- Finance constraints are anonymized/summarized and stripped of private evidence before Content use.
- Secretary availability/cadence signals affect Content production feasibility.
- Repeated cross-skill warnings dedupe through stable source references.
- Added outbound Content signals for Secretary scheduling intents and Chat status updates.
- Added docs: `docs/content/cross-skill-content-orchestration.md`, `docs/content/content-skill-signal-model.md`, `docs/content/sensitive-signal-policy.md`, and `docs/content/cross-skill-content-test-matrix.md`.
- Updated `docs/content/cross-skill-content-opportunities.md` and `docs/content/content-open-items.md`.
- Added `__tests__/services/content-cross-skill-orchestration.test.ts` for Training milestone conversion, Secretary cadence impact, Finance constraint handling, Chat recurring questions, sensitive-signal review, cross-tenant rejection, duplicate-warning prevention, and outbound Secretary/Chat signal contracts.

Validation:

- `npm test -- --run __tests__/services/content-cross-skill-orchestration.test.ts` passed: 1 file / 8 tests.

Release gate: PASS WITH CONDITIONS for the backend cross-skill orchestration foundation. Runtime hooks from source skills, sensitive-signal approval UX, iOS/portal rendering, and full local product smoke remain open.

## 2026-04-29 Final Production-Release Addendum

Branch: `release/chat-tenant-safe-production-candidate`

Latest release-gate validation:

- Previously failing legacy tests were updated to the tenant-safe contracts and passed: 5 files / 304 tests.
- `npm run verify` passed: 376 files / 5,939 tests.
- `npm run build` passed.
- `git diff --check` passed.
- `npm run chat:eval` passed: 24 scenarios, average 1.99 / 2.00.
- `node dist/tools/chat-day-to-day-simulation.js` passed: 10 scenarios, average 1.93 / 2.00.
- Staging and production `IOS_WS_ENABLED` were checked and are unset, which resolves to false.
- Deployment package now avoids live-provider quality/fallback/operator-pin, streaming, true workspace-switching, raw support-console, durable tool lifecycle, and durable attachment claims.

Remaining production actions are deployment-time gates, not code/test failures:

- Take a fresh production DB snapshot immediately before deploy.
- Deploy to staging first and run focused Chat staging smoke.
- Promote only after staging smoke passes.

## Executive Summary

This is a backend-only audit report for the Chat tenant-safe context workstream. It is not a release go/no-go.

The current working tree now contains foundational Chat tenant-scope hardening across REST persistence, conversation state, shared memory, domain execution, tool calls, fast-path cache, daily context cache, shared-decision cache, user export, audit schema, REST message lifecycle/idempotency, prompt-injection boundaries, and context minimization. Chat is still not production-ready for true multi-tenant workspace behavior because WebSocket streaming is not auth/tenant hardened if enabled, and no active tenant membership model exists yet. The `084`/`085` Chat migrations have now passed staging-clone apply/restore rehearsal.

## Beta Readiness Score

Current backend Chat readiness score: **90 / 100**

Reasoning:

- Strong progress on REST Chat persistence, tenant propagation, prompt-context cache scope, and provider-routing documentation.
- Focused tests now cover tenant isolation for history, context, cache, tools, and legacy quarantine.
- Prompt context now has a dedicated selection engine with relevance/freshness/confidence metadata, weak-context guardrails, and provider-fallback safety tests.
- OpenAI/Gemini/Anthropic domain call options now carry tenant/user metadata where available without changing the live routing architecture.
- Chat now has a deterministic skill-orchestration preflight, Secretary ownership override for multi-skill scheduling, route-level destructive confirmation, and server-side tool authorization context.
- REST Chat now has additive message lifecycle columns, early idempotent message claiming, completed-response replay, in-flight duplicate suppression, idempotency conflict detection, and tenant-scoped stuck-state repair helpers.
- Prompt context now labels retrieved/memory/history content as data-only, escapes tag-breaking content, flags prompt-injection attempts, refuses non-canonical tenant peer mesh context, and rejects explicit tool `user_id` mismatch.
- Chat now has a deterministic day-to-day simulation harness with 11 personas, 10 multi-turn scenarios, rubric scoring, tenant-switch checks, prompt-injection refusal checks, tool-failure retry/dedupe checks, provider trace metadata, and iOS-compatible response envelope validation.
- Local full-product smoke, iOS smoke, and staging-clone migration rehearsal passed. WebSocket hardening and active-tenant membership proof remain open.

## Critical Blockers

1. WebSocket Chat must remain disabled or be fixed for auth parity and tenant scope.
2. Active tenant membership is not modeled; do not claim true workspace switching.

## High-Priority Issues

- Provider usage write paths now accept tenant metadata for domain and classifier calls where options carry it; streaming and some one-shot paths still need a wider follow-up audit.
- WebSocket streaming remains a separate unsafe transport if enabled.
- Active tenant membership is not modeled.
- Durable tool-call lifecycle persistence is not implemented yet; route-level idempotency reduces duplicate action risk but does not replace tool-boundary idempotency.
- Attachment/file prompt-injection and tenant-scope audit remains open.
- Admin/support access to Chat remains open.
- Wider sensitive-log audit remains needed outside the Chat route/tool logs touched in this pass.
- Content shortcut/refinement failure logs were redacted after the initial pass; the remaining work is a wider non-Chat log audit.

## Architecture Risks

- Chat context construction still happens primarily around user ID.
- Provider routing is configurable, but provider audit/logging does not carry tenant scope.
- WebSocket streaming is a separate transport from REST and has drifted from REST security behavior.

## Security / Tenant Risks

See:

- `docs/chat/chat-tenant-security-gap-analysis.md`
- `docs/chat/chat-risk-register.md`
- `docs/chat/chat-open-items.md`

## Test Coverage Gaps

- WebSocket tenant/auth/revocation tests.
- WebSocket stream chunk/reconnect/idempotency tests.
- Provider usage tenant propagation tests.
- Production DB snapshot checkpoint immediately before deploy.
- Durable tool invocation lifecycle tests.
- Attachment/file prompt-injection tests.
- Admin/support access audit tests.
- Day-to-day full-product Chat simulations against a seeded local runtime. Deterministic fixture simulation is now implemented and passing.
- iOS local Chat smoke.
- Pending-confirmation state machine tests once follow-up confirmation UX is implemented.

## Recommended Fix Order

1. Keep WebSocket disabled or fix it.
2. Take a fresh production DB snapshot immediately before deploy.
3. Add durable tool invocation lifecycle and tool-boundary idempotency.
4. Add explicit provider usage tenant call options where still missing.
5. Finish sensitive-log audit outside the Chat route/tool paths touched here.
6. Connect the day-to-day Chat simulation harness to seeded local full-product runtime and bounded provider samples.

## Commands Run

Implementation pass validation:

```bash
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-degraded-response.test.ts
npm test -- --run __tests__/api/chat-message-execution.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/services/tool-executor.test.ts __tests__/services/context-engine.test.ts __tests__/services/shared-decision-context.test.ts
npm test -- --run __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/ai-provider-qa-validation.test.ts __tests__/services/domain-provider-router.test.ts
npm run typecheck
```

Actually run in this pass:

- `npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/api/chat-message-execution.test.ts __tests__/services/tool-executor.test.ts __tests__/services/context-engine.test.ts __tests__/services/shared-decision-context.test.ts` — 8 files / 152 tests passed.
- `npm test -- --run __tests__/api/chat-history-routes.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-message-degraded-response.test.ts __tests__/services/user-data-export.test.ts __tests__/services/audit-trail.test.ts` — 6 files / 85 tests passed.
- `npm test -- --run __tests__/api/chat-routes.test.ts __tests__/api/chat-message-degraded-response.test.ts` — 2 files / 43 tests passed after shortcut log redaction.
- `npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/openai-provider.test.ts __tests__/services/gemini-provider.test.ts __tests__/services/provider-fallback.test.ts __tests__/domains/domain-handler.test.ts __tests__/domains/secretary.test.ts` — 7 files / 170 tests passed.
- `npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/openai-provider.test.ts __tests__/services/gemini-provider.test.ts __tests__/services/provider-fallback.test.ts __tests__/domains/domain-handler.test.ts __tests__/domains/secretary.test.ts __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/api/chat-message-execution.test.ts __tests__/services/tool-executor.test.ts __tests__/services/context-engine.test.ts __tests__/services/shared-decision-context.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-message-degraded-response.test.ts __tests__/services/user-data-export.test.ts __tests__/services/audit-trail.test.ts` — 21 files / 407 tests passed.
- `npm run typecheck` — passed.
- `npm test -- --run __tests__/services/chat-skill-orchestrator.test.ts __tests__/services/tool-executor.test.ts __tests__/services/chat-context-engine.test.ts __tests__/router/classifier.test.ts` — 4 files / 361 tests passed.
- `npm test -- --run __tests__/api/chat-routes.test.ts __tests__/services/chat-skill-orchestrator.test.ts` — 2 files / 46 tests passed.
- `npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/chat-skill-orchestrator.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/openai-provider.test.ts __tests__/services/gemini-provider.test.ts __tests__/services/provider-fallback.test.ts __tests__/router/classifier.test.ts __tests__/domains/domain-handler.test.ts __tests__/domains/secretary.test.ts __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/api/chat-message-execution.test.ts __tests__/services/tool-executor.test.ts __tests__/services/context-engine.test.ts __tests__/services/shared-decision-context.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-message-degraded-response.test.ts __tests__/services/user-data-export.test.ts __tests__/services/audit-trail.test.ts` — 23 files / 684 tests passed.
- `npm run typecheck` — passed after the skill-orchestration pass.
- `npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-persistence.test.ts` — 3 files / 59 tests passed after the lifecycle pass.
- `npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-routes.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts` — 5 files / 82 tests passed after the lifecycle pass.
- `npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-local-responses.test.ts` — 4 files / 65 tests passed after cached response persistence was covered.
- `npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-routes.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-message-local-responses.test.ts` — 6 files / 88 tests passed after cached response persistence was covered.
- `npm test -- --run __tests__/services/tool-executor.test.ts __tests__/api/chat-message-execution.test.ts __tests__/api/chat-message-degraded-response.test.ts` — 3 files / 87 tests passed after the lifecycle pass.
- `npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/shared-decision-context.test.ts __tests__/services/tool-executor.test.ts` — 3 files / 111 tests passed after the prompt-injection/security pass.
- `npm test -- --run __tests__/services/chat-context-engine.test.ts __tests__/services/shared-decision-context.test.ts __tests__/services/tool-executor.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-history-routes.test.ts __tests__/state/user-isolation.test.ts` — 7 files / 181 tests passed after the prompt-injection/security pass.
- `npm run typecheck` — passed after the lifecycle pass.
- `npm test -- --run __tests__/services/chat-day-to-day-simulation.test.ts` — 1 file / 7 tests passed after the day-to-day simulation harness pass.
- `npm test -- --run __tests__/services/chat-day-to-day-simulation.test.ts __tests__/services/chat-context-engine.test.ts __tests__/services/chat-skill-orchestrator.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-history-routes.test.ts __tests__/state/user-isolation.test.ts` — 7 files / 92 tests passed after the day-to-day simulation harness pass.
- `npm run typecheck` — passed after the day-to-day simulation harness pass.
- `npm run build` — passed after the day-to-day simulation harness pass.
- `node dist/tools/chat-day-to-day-simulation.js` — passed, 10 scenarios / 28 turns, average score 1.93 / 2.00.
- `git diff --check` — passed after the day-to-day simulation harness pass.

Local full-product Chat smoke update:

- `npm run build` — passed before local runtime smoke.
- `npm run chat:eval` — passed, 24 scenarios, average score 1.99 / 2.00; 21 pass, 3 partial, 0 fail.
- `node dist/tools/chat-day-to-day-simulation.js` — passed, 10 scenarios, average score 1.93 / 2.00.
- Local backend started on `127.0.0.1:8200` with `DATABASE_PATH=./data/chat-full-nexus-local-smoke.db`, local invite auth, explicit portal admin token, local agenda/calendar mock flags, and provider keys blanked.
- Live local API smoke passed for auth/session, dashboard, skills, calendar, reminders, Training, Finance, Content, plan routes, Chat message/history, idempotency, destructive confirmation, tenant-separated histories, and portal model-routing/diagnostics metadata.
- Disposable full migration-directory check passed after adding deployed `082_training_session_identity_shape_hash.sql`, recovering `083_secretary_agenda_ledger.sql`, and renumbering Chat to `084`/`085`: 90 migrations applied, integrity `ok`, latest entries `083`/`084`/`085` present, temporary DB removed.
- iOS simulator build/run passed against the local backend with DEBUG auth import; Chat rendered provider-unavailable degraded state and a Secretary `Today` shortcut callback returned 200.
- Cleanup passed: no port 8200 listener, no booted simulator, no smoke process, and local auth/DB artifacts removed.
- Evidence docs: `docs/local/chat-full-nexus-local-smoke.md`, `docs/local/chat-full-nexus-local-smoke-results.md`, `docs/local/chat-full-nexus-local-open-blockers.md`, `docs/local/chat-local-cleanup-confirmation.md`.

Content tenant/privacy hardening update:

- Added `migrations/089_content_tenant_privacy_scope.sql` for explicit Content tenant/user ownership, visibility, lifecycle, scope status, and legacy quarantine metadata.
- Added `src/services/content-tenant-scope.ts` and `src/services/content-reference-context.ts`.
- Hardened Content books/channels/Voice DNA routes, radar preferences, learned patterns, script/performance storage, dedup lookup, and script prompt reference assembly.
- Global Reaction Radar and channel-learner system paths now scan only explicit active platform-owned references, not user-private tenant references.
- Validation:
  - Fresh in-memory migration replay through all migrations: passed.
  - `npm test -- --run __tests__/services/content-tenant-scope.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/api/content-script-duration.test.ts __tests__/services/channel-learner-scope.test.ts __tests__/services/content-radar-preferences.test.ts` — 8 files / 37 tests passed.
  - `npm test -- --run __tests__/api/content-home-route.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/internal-routes.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/content-tenant-scope.test.ts __tests__/services/python-engine-hardening.test.ts __tests__/api/content-script-duration.test.ts __tests__/api/content-script-quota.test.ts __tests__/api/content-script-route-utils.test.ts __tests__/services/script-pipeline.test.ts __tests__/api/chat-routes.test.ts` — 13 files / 177 tests passed.
  - `npx tsc --noEmit --pretty false` — passed.
  - Evidence docs: `docs/content/content-tenant-security-model.md`, `docs/content/content-data-model-scope.md`, `docs/content/content-security-test-matrix.md`, `docs/content/content-security-open-items.md`.

## Final Recommendation

**GO WITH CONDITIONS for production release review.** The production DB snapshot gate is closed for this deployment run: `/home/dominguez/telegram-hub-bot/data/release-snapshots/chat-tenant-safe-20260429T085055Z/predeploy-bot.db`, SHA-256 `11a54315544eee5872946b06c7f4b1cfffa357176a509d9e1654a608b2b03428`, integrity `ok`. Remaining gates are deployment-time controls: confirm WebSocket Chat remains disabled, deploy to staging first, and run a focused staging Chat smoke before production promotion. Release copy is already restrained: no true workspace-switching, streaming, raw support-console, durable attachment, or live-provider/fallback quality claim is made for this REST Chat release.

## Content Creation Security Red-Team Addendum — 2026-04-29

Focused Content Creation hardening was added for prompt-injection, provenance, tenant isolation, approval gates, and model metadata privacy:

- Hardened Content prompt contracts so authorized links/books/channels/drafts are labeled as untrusted evidence, not executable instructions.
- Added focused red-team coverage in `__tests__/services/content-security-red-team.test.ts`.
- Verified cross-tenant reference exclusion, malicious reference isolation, fake citation/unsupported claim review, broken/stale/unavailable source exclusion, approval gates, tenant-separated voice memory, tenant-shared memory omission, and provider metadata redaction where testable.

Commands run:

```bash
npm test -- --run __tests__/services/content-security-red-team.test.ts
npm test -- --run __tests__/services/content-generation-quality.test.ts __tests__/services/content-reference-provenance.test.ts __tests__/services/content-editorial-workflow.test.ts
```

Results: PASS, 4 files / 30 tests total.

Evidence docs:

- `docs/content/content-security-red-team.md`
- `docs/content/content-prompt-injection-defense.md`
- `docs/content/content-provenance-red-team.md`
- `docs/content/content-privacy-review.md`
- `docs/content/content-security-test-results.md`

Release-gate verdict for this focused Content security pass: PASS WITH CONDITIONS. Remaining conditions are external publishing integration tests before enabling publisher actions and full local product/iOS/portal smoke if bundled into a release. The audited backend/sidecar log-sink review was closed in the sensitive logging addendum above.

## Content Creation Production Candidate Addendum — 2026-04-29

The Content Creation release-candidate hardening pass created branch `release/content-creation-production-candidate` and registered `content@2.3.0-rc.1` as a candidate skill version. The active registry version remains `content@2.0.0`; no deployment or activation was performed.

Safe P1 fixed:

- Skill version metadata now exists for the Content Creation candidate via `migrations/095_content_creation_production_candidate_version.sql`.

Test evidence:

```bash
npm test -- --run __tests__/services/content-tenant-scope.test.ts __tests__/services/content-reference-provenance.test.ts __tests__/services/content-security-red-team.test.ts __tests__/services/content-generation-quality.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/services/content-memory-profile.test.ts __tests__/services/content-radar-engine.test.ts __tests__/services/content-novelty-reuse.test.ts __tests__/services/content-domain-ontology.test.ts __tests__/services/content-cross-skill-orchestration.test.ts __tests__/services/content-day-to-day-evaluation.test.ts __tests__/services/skill-memory.test.ts __tests__/services/skill-version-registry.test.ts
npm test -- --run __tests__/api/content-home-route.test.ts __tests__/api/content-reference-routes.test.ts __tests__/api/content-learning-routes.test.ts __tests__/api/content-script-duration.test.ts __tests__/api/content-script-quota.test.ts __tests__/api/content-script-route-utils.test.ts __tests__/api/content-topic-routes.test.ts __tests__/api/content-pipeline-routes.test.ts __tests__/api/content-ideas-routes.test.ts __tests__/api/content-intelligence-routes.test.ts __tests__/api/content-generation-meta.test.ts __tests__/api/internal-routes.test.ts __tests__/api/skills-routes.test.ts __tests__/services/content-workflow-user-scope.test.ts __tests__/services/content-dedup-routing.test.ts __tests__/services/channel-learner-scope.test.ts __tests__/services/python-engine-hardening.test.ts
npm test -- --run __tests__/services/content-dashboard-service.test.ts __tests__/services/content-learning-store.test.ts __tests__/services/content-intelligence.test.ts __tests__/services/content-home-view-state.test.ts __tests__/services/content-notifications.test.ts __tests__/services/content-topic-secretary-sync.test.ts __tests__/services/content-owner-scope.test.ts __tests__/skills/content-skill-refactor-qa-validation.test.ts __tests__/api/chat-content-refinement.test.ts __tests__/api/content-admin-write-auth.test.ts __tests__/api/content-topic-context.test.ts __tests__/api/content-learning-route-utils.test.ts __tests__/api/content-home-route-utils.test.ts __tests__/api/content-topics-recommendation.test.ts __tests__/api/content-dashboard.test.ts __tests__/api/content-intelligence-detail.test.ts __tests__/api/content-intelligence-summary.test.ts __tests__/api/content-intelligence-route-utils.test.ts __tests__/api/content-script-utils.test.ts
npm run eval:content -- --markdown docs/content/content-eval-baseline-results.md --json reports/content-eval/content-eval-latest.json --fail-under 85
npm run typecheck
npm run lint
git diff --check
```

Results: PASS for all test/typecheck/lint/diff checks. Content eval remains PASS WITH CONDITIONS at 91/100, fixture mode, 15 cases, zero critical failures.

Release-gate verdict: GO WITH CONDITIONS for a backend Content Creation candidate. Conditions remain for live routed-provider quality sampling, rich iOS Content workflows, tenant-facing portal UI/browser workflows, same-user tenant switching, content-engine sidecar smoke for live extraction/provider quality, and provider-backed calendar staging claims.

## Content Portal Backend Scope Addendum — 2026-04-29

The remaining backend portal write risks for Content books/channels/manual Voice DNA were reduced after the initial Content RC review:

- `/api/v1/admin/content/books`, `/channels`, and `/voice-dna` mutations now require explicit `userId`/`tenantId` and apply Content scope predicates before add/retry/delete/reanalyze/update operations.
- Scoped Content book extraction no longer writes private book knowledge into the global `book_knowledge` signal bus.
- Scoped channel add persists tenant metadata; non-default tenant channel knowledge synthesis is deliberately skipped until the synthesis path accepts explicit tenant scope.
- Tenant-scoped portal Voice DNA synthesis now returns `UNSUPPORTED_SCOPE` instead of running the global voice evolution agent.
- Legacy portal write routes `/api/books` and `/api/channels` now return `SCOPED_V1_REQUIRED`; unscoped portal dashboard reads are constrained to platform/system seed rows.

Focused validation:

```bash
npm test -- --run __tests__/api/content-admin-write-auth.test.ts __tests__/services/content-dashboard-service.test.ts __tests__/api/content-dashboard.test.ts
npm run typecheck
npm run lint
```

Results: PASS, 44 focused tests plus typecheck/lint. This closes the locally actionable backend portal write-scope issue. It does not close rich portal UI/browser smoke, tenant-facing Content console workflows, or same-user multi-tenant frontend cache proof.

## Content Notification Deep-Link Resolver Addendum — 2026-04-29

Backend Content notification deep-linking is now implemented as a read-only resolver:

- Added `GET /api/v1/content/notifications/:id`.
- The resolver reads notifications through `id + user_id` ownership scope before returning any target metadata.
- The resolver does not mark notifications read or resolved; clients can use the returned `/api/v1/notifications/:id/read` and `/api/v1/notifications/:id/resolve` endpoints after navigation.
- Supported target kinds include script, topic, workflow object, approval, source review, radar signal, reference, pipeline item, weekly package, performance, agent insight, and safe Content Home fallback.
- No title/date matching or broad artifact lookup was introduced.

Focused validation:

```bash
npm test -- --run __tests__/services/content-notifications.test.ts __tests__/api/content-notification-routes.test.ts
npm test -- --run __tests__/api/content-notification-routes.test.ts __tests__/api/content-editorial-routes.test.ts __tests__/api/content-home-route.test.ts
npm run typecheck
git diff --check
```

Results: PASS. Notification resolver coverage passed 31 focused service/API tests; the route-registration/editorial/home slice passed 11 focused API tests; typecheck and diff hygiene passed.

Release-gate verdict for this backend resolver: PASS. End-to-end notification deep-link UX remains PASS WITH CONDITIONS until iOS/portal route handling consumes the resolver.

## Content Secretary-Owned Scheduling Actions Addendum — 2026-04-29

The app-facing Content editorial action route now performs live Secretary-owned scheduling for `schedule_content`:

- `POST /api/v1/content/workflow/:id/actions` with `action: "schedule_content"` submits a typed Content scheduling intent to Secretary.
- The route returns the Secretary scheduling decision, agenda item, and source-skill feedback.
- Content workflow objects persist `secretary_intent_id` and `secretary_agenda_item_id`.
- Tenant-shared Content scheduling remains approval-gated before Secretary placement.
- New unavailable/protected windows can be supplied to model live schedule conflicts and trigger Secretary reflow.

Focused validation:

```bash
npm test -- --run __tests__/api/content-editorial-routes.test.ts __tests__/services/content-editorial-workflow.test.ts __tests__/services/secretary-scheduling-arbitrator.test.ts
npm run typecheck
git diff --check
```

Results: PASS. The focused action/scheduling slice passed 3 files / 28 tests, including live route scheduling, reflow after a new unavailable window, tenant-shared approval gating before placement, Content object agenda identity persistence, Secretary source-skill feedback, typecheck, and diff hygiene.

Release-gate verdict for backend live Content scheduling actions: PASS. Provider-backed calendar sync, full local product smoke, and iOS/portal rendering of scheduling states remain separate release claims.

## Chat Same-User Tenant-Switch Smoke Addendum — 2026-04-29

The backend now handles unsupported same-user tenant switching explicitly and safely:

- `authMiddleware` detects `x-nexus-active-tenant-id` and `x-nexus-tenant-id`.
- If the requested active tenant is the canonical `userId`, the request proceeds normally.
- If the requested active tenant differs from the canonical tenant, the request fails closed with `403 FORBIDDEN` before Chat history, memory, prompt construction, or tool execution.
- A tenant-scope anomaly is recorded with operation `ios_auth_active_tenant`.
- The existing no-header path remains backward compatible.

Focused validation:

```bash
npm test -- --run __tests__/api/auth-middleware-device-revocation.test.ts __tests__/api/chat-routes.test.ts __tests__/state/shared-memory.test.ts __tests__/state/user-isolation.test.ts
npm run build
node scripts/chat-tenant-security-smoke.js --base-url http://127.0.0.1:8297 --portal-admin-token local-chat-tenant-admin
```

Results: PASS WITH CONDITIONS. Focused tests passed 4 files / 74 tests. Live local smoke passed 15 checks, left 1 provider-fallback condition partial, had 0 failures, and cleanup stopped the backend plus removed the temporary smoke DB.

Release-gate verdict for same-user tenant-switch behavior: PASS WITH CONDITIONS. The backend is safe because unsupported active-tenant overrides fail closed. This still does not claim true same-user workspace switching; that remains blocked until membership-backed active tenants, tenant-aware iOS cache/UI smoke, and end-to-end workspace switch validation exist.

## Full Local Nexus Product Smoke Addendum — 2026-04-29 22:54

Full local runtime validation was run on backend branch `feature/content-editorial-mutation-contracts` at `21a27ff8a7f350244105fe189de677367bbd665d` with iOS branch `feature/ios-content-creation-intelligence-upgrade` at `ca99f11a40855882b3690192bb9e17d90bb38c55`.

Rollback branch/tag pairs were created in both repos before the smoke: `backup/full-local-smoke-before-run-20260429-2254` and `backup-full-local-smoke-before-run-20260429-2254`.

Local backend runtime:

- Base URL: `http://127.0.0.1:8298`
- DB: `/tmp/nexus-full-smoke-20260429-2254.db`
- Provider mode: `NEXUS_MODEL_FIXTURE_MODE=1`, `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`
- Workers/cache: scheduler/workers started inside the backend process; SQLite/KV cache initialized
- Optional content-engine sidecar: not started

Backend/skill smoke results:

- Authenticated API smoke: PASS, 13/13 checks.
- Chat tenant isolation smoke: PASS WITH CONDITIONS, 15 pass / 1 provider-fallback partial / 0 fail.
- Cross-skill fixture checks: PASS, with staging runtime section intentionally blocked by local dry-run mode.
- Chat evaluation harness: PASS WITH CONDITIONS, 24 scenarios, average 1.99/2.00.
- Chat day-to-day simulation: PASS, 12 scenarios, average 1.94/2.00.

iOS local smoke:

- Focused iOS tests: PASS, 77/77.
- Simulator launch against local backend: PASS.
- Home did not show "Couldn't reach Nexus Hub"; Chat routed a Secretary shortcut; Skills, Content, and Training rendered local backend state.

Release-gate verdict for this local full-product smoke: PASS WITH CONDITIONS. Remaining conditions are WebSocket/stream interruption proof, true same-user workspace switching, provider-backed Google/Outlook calendar lifecycle, optional content-engine sidecar smoke, and automation of the iOS leg inside the runner.
