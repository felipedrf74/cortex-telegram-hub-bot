# Training / Coach deep audit and hardening report

## Executive summary

- verdict: PASS WITH CONDITIONS for local QA only.
- biggest gray areas found: persisted onboarding profiles were passed to plan generation as wrapper rows, no-equipment text could fall through to full-gym defaults, and iOS did not have a read-only all-weeks endpoint for visible progression.
- biggest bugs found: Training ignored profile data in the persisted-profile path; explicit five-day strength targets were still limited by coordination logic; weekly capping could remove the wrong sessions; RDL variants survived bodyweight-only adaptation.
- biggest fixes applied: unwrap persisted profile rows before planning, raise strength target support to six, cap only the exact excess sessions, add bodyweight/no-equipment normalization including RDL aliases, and add `/api/v1/training/plan/weeks`.
- remaining release risk: full UI questionnaire plan creation, account-switch isolation in iOS, real provider calendar lifecycle, and physical-device performance were not completed in this local pass.
- whether Training is ready to merge/main: locally ready after review of this branch and remaining P2 conditions.
- whether Training is ready for production: no; staging/provider/TestFlight gates remain required.

## Execution behavior

- Did you proceed without unnecessary pauses: yes.
- Did you prioritize P0/P1 over easier tasks: yes; profile unwrap and no-equipment enforcement were fixed before documentation.
- Any hard blockers: full iOS questionnaire creation was not completed through the app; plans were generated through local API and then loaded/reviewed through the app UI.
- Any task skipped due to risk: external Google/Outlook provider smoke and production/staging promotion were intentionally not run by the local-only rule.

## Branch and backup

- repos: backend isolated worktree `/Users/felipedominguez/Desktop/Nexus Hub/worktrees/engine-training-hardening-codex`; iOS `/Users/felipedominguez/Desktop/Nexus Hub/ios`.
- branches: backend `feature/training-reliability-local-orchestration-hardening-codex-20260503`; iOS `feature/release-pipeline-risk-based-optimization` with no Training edits from this pass.
- commits: backend base `82b4c78`; iOS observed at `945567d`.
- backup tags: backend `backup/training-reliability-local-before-hardening-20260503-1325`.
- dirty state before/after: backend worktree intentionally dirty with Training fixes/tests/report until committed locally; iOS not modified in this pass.

## Local engine and iOS validation setup

- local engine commands: `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 scripts/full-nexus-local-engine.sh up`.
- backend health: local engine served on `127.0.0.1:8200`.
- test users/tenants: local full-Nexus fixture user `Beta-local-fu` from `.local/full-nexus/local-ios-auth.json`.
- simulator/device: iPhone 17 Pro simulator `A0B13967-B5DE-4E6F-897D-F1E409093F94`, iOS 26.4.
- iOS local API: launched with `-nexus_allow_local_backend YES -nexus_base_url http://127.0.0.1:8200 -nexus_debug_local_auth_import YES`.
- fixture/provider mode: model routing logs showed fixture paths and `fixtureMode: true`; no real provider calls were used.
- cleanup: required at end of pass; see final cleanup status.

## Current-state map

- engine architecture: app route -> onboarding profiles -> coordination -> coach kernel -> equipment adaptation -> persistence -> read models.
- iOS contract: Training home and week views consume app-facing REST endpoints, not fake chat commands.
- Secretary/calendar integration: local plans were created without external provider sync; read models now expose honest missing/unsynced counts.
- profile/questionnaire: persisted profile wrappers must be unwrapped before profile data is passed into planning.
- tests/smoke: focused vitest, typecheck, build, local API smokes, and simulator interaction were run.

## Findings

### P0

- none found in this local pass.

### P1

- ID: TR-P1-PROFILE-UNWRAP
- area: profile/questionnaire
- file/line: `src/api/routes/training-plan-generation.ts:193`
- evidence: local generation logs showed `rawGymProfile:null` and `rawFitnessProfile:null` while profile API contained profile data.
- user impact: advanced/gym users could receive beginner or wrong-equipment plans.
- root cause: `onboarding.getProfile()` returns persisted rows shaped as `{ data, ... }`, but the route passed the wrapper directly.
- fix/recommendation: unwrap `.data` for `fitness`, `triathlon-gym`, and `triathlon-running`; keep direct-data legacy tests supported.
- status: fixed and pinned in `__tests__/api/training-plan-generation.test.ts:244` and `:271`.

- ID: TR-P1-STRENGTH-CAP
- area: strength planning
- file/line: `src/services/training-plan-coordination.ts:106`
- evidence: explicit five-strength plans still entered coordination with a four-session cap.
- user impact: Felipe-style five-day strength requests could be silently compressed.
- root cause: downstream coordination still clamped strength sessions to four after prior target-resolver fixes.
- fix/recommendation: allow up to six strength sessions with recovery guardrails intact.
- status: fixed and pinned in `__tests__/services/training-plan-coordination.test.ts:221` and `:246`.

- ID: TR-P1-WEEKLY-CAP-REMOVAL
- area: session feasibility
- file/line: `src/services/training-plan-coordination.ts:396`
- evidence: capping logic used `removable.slice(cap)`, which did not remove the exact excess and could leave too many sessions or remove the wrong set.
- user impact: long runs or higher-value sessions could be lost when a week was capped.
- root cause: index math used cap as a slice offset instead of excess count.
- fix/recommendation: remove `activeSessions.length - cap` lowest-scored sessions.
- status: fixed and pinned in `__tests__/services/training-plan-coordination.test.ts:270`.

- ID: TR-P1-NO-EQUIPMENT
- area: equipment constraints
- file/line: `src/services/training-plan-equipment-adaptation.ts:247`
- evidence: local no-equipment smoke initially kept `Single-Leg RDL`; no-equipment strings could default to full gym.
- user impact: no-equipment or bodyweight users could receive gym/free-weight movements.
- root cause: no-equipment vocabulary and RDL acronym were not normalized into bodyweight substitutions.
- fix/recommendation: map no-equipment/bodyweight Portuguese and English variants to `bodyweight`, and treat `rdl` as a hinge/deadlift alias.
- status: fixed and pinned in `__tests__/services/training-plan-equipment-adaptation.test.ts:97` and `:108`.

### P2

- ID: TR-P2-IOS-CREATION
- area: iOS workflow
- evidence: plan creation was API-driven and then loaded through iOS; the full questionnaire creation path was not completed through UI.
- user impact: UI wiring could still hide a backend capability issue.
- recommendation: run a dedicated signed/simulator plan-creation XCUITest that fills the questionnaire and verifies the generated weekly plan.
- status: open.

- ID: TR-P2-SESSIONS-SEMANTICS
- area: API/product contract
- evidence: local advanced smoke with `sessionsPerWeek:7` and `strengthSessionsPerWeek:5` produced 12 active sessions/week because backend interprets the first value as primary-modality sessions.
- user impact: if iOS labels this as total weekly sessions, users may see more sessions than expected.
- recommendation: align API naming or UI copy: primary sessions plus strength sessions versus total weekly sessions.
- status: open.

- ID: TR-P2-TECHNICAL-COPY
- area: iOS copy
- evidence: simulator Training view showed internal labels such as `Strength/cardio Conflict`, `Capacity Compressed`, and `Capacity Reflowed`.
- user impact: useful coach reasoning is exposed in too-technical language.
- recommendation: map reason codes to user-facing Portuguese copy and hide raw codes behind debug/details.
- status: open.

- ID: TR-P2-PROVIDER-CALENDAR
- area: calendar lifecycle
- evidence: local plans were honest as `unsynced`/`missing`; Google/Outlook provider read-back, duplicate retry, and cleanup were not run by local-only rule.
- user impact: external calendar state still needs proof before production.
- recommendation: run non-production provider lifecycle smoke before staging/prod.
- status: open.

### P3

- docs audit still reports broad pre-existing markdown drift warnings. Do not copy verdicts/test counts into new scattered docs.

## User-reported issue re-check

- 5x strength support: fixed locally in coordination and validated by API smoke.
- Saturday long run: locally generated advanced plan kept `Long Run` on Saturday.
- profile ignored: fixed for persisted profile rows; local smoke confirmed advanced and beginner/no-equipment profiles materially changed output.
- marathon date: API smoke confirmed missing race date returns `missingCriticalData: race_date` and a race-date follow-up prompt.
- future-week progression: `/training/plan/weeks` now returns all active weeks for iOS progression review; visual iOS upcoming-week creation remains P2.
- calendar banner: local read model exposes honest `unsynced`/missing counts; provider sync remains unverified.
- duplicate UI: simulator Training screen showed one CTA pair, not duplicate cards.
- Jornada da semana: week plan timeline rendered; no duplicate legacy section observed in this pass.
- technical explanations: still partially too technical; P2 open.
- Training lag/runtime: no freeze observed during 10 rapid tab switches on simulator; physical-device profiling not run.
- identity/tenant leakage: no Training leak found locally; account-switch UI flow not completed.

## Engine intelligence review

- profile use: improved by persisted-wrapper unwrap.
- strength: five/six-session requests now survive coordination; session cap keeps highest-value work.
- running: marathon plan kept Saturday long run in local advanced smoke.
- cycling: not changed in this pass.
- hybrid: advanced marathon plus strength created 7 run + 5 strength sessions; semantic naming remains open.
- progression: all-weeks endpoint exposes future weeks without regenerating or syncing.
- feedback: not changed; iOS feedback adaptation remains open.
- equipment: bodyweight/no-equipment enforcement improved.
- safety/biomechanics: no new medical guidance added.
- catalog: RDL alias fixed for equipment fallback.
- gray areas: provider calendar lifecycle and UI questionnaire creation.

## Calendar and Secretary review

- scheduling intent: Training still produces local plan/session state; external sync is not faked.
- agenda state: local API reports missing calendar blocks instead of pretending sync.
- provider sync: not run.
- partial sync: sync summary fields are now available from week/all-weeks read models.
- cleanup: not changed in this pass.
- duplicates: no provider write path was exercised.
- timezone/week-start: not deeply reworked in this pass.
- open risks: provider retry/no-duplicate cleanup still needs non-production calendar smoke.

## Identity and tenant safety review

- hardcoded user scan: no Training-specific Felipe hardcoding was introduced.
- profile ownership: local smokes used authenticated local user only.
- plan ownership: new `/plan/weeks` uses authenticated `userId`.
- feedback ownership: not touched.
- memory/shared context: not touched.
- Chat/Secretary tool scope: not used for plan creation; token-zero rule preserved.
- iOS cache: account-switch stale-cache flow not run.
- open risks: real two-account TestFlight smoke remains required before beta confidence.

## iOS simulator/device Training workflows

- Workflow A - Advanced hybrid plan creation: PARTIAL. Inputs were applied via local API, plan generated locally, and iOS loaded/reviewed the resulting Training home and week plan. Actual UI questionnaire entry was not completed.
- Workflow B - Beginner no-equipment plan creation: PARTIAL. API generation passed no-equipment checks; iOS visual review after this specific profile was not repeated.
- Workflow C - Mid-week creation: PARTIAL. Local generated plan showed no past sessions in visible week, but constrained mid-week UI flow was not fully exercised.
- Workflow D - Missing marathon date: PARTIAL. API returned missing race date/follow-up; iOS follow-up rendering was not verified.
- Workflow E - Saturday conflict: BLOCKED. No local Secretary/calendar fixture was configured to force Saturday unavailable.
- Workflow F - Feedback adaptation: BLOCKED. Feedback UI/adaptation was not exercised.
- Workflow G - Account/tenant isolation: BLOCKED. No second local account-switch flow was completed.

Simulator evidence:

- Training home rendered local plan with `Recovery Run`, readiness, one `Ver plano da semana` CTA, one `Atualizar coach` CTA, and no duplicate CTA card.
- Week plan rendered 12 sessions, 12 unsynced/missing calendar blocks, W1/W2 timeline, Saturday `Long Run (Capped)`, and honest unsynced banner.
- Session detail rendered duration, effort, warm-up, cool-down, notes, and missing calendar sync state.
- Ten rapid bottom-tab switches returned to Home without freeze.

## Runtime performance

- endpoints: local smoke exercised profile patching, plan generation, `/api/v1/training/week`, and `/api/v1/training/plan/weeks`.
- latency: not systematically benchmarked; no multi-second local backend wait was observed during simulator interaction.
- payload size: not measured.
- duplicate requests: not instrumented.
- expensive read paths: `/plan/weeks` is read-only and does not regenerate or provider-sync.
- model/provider calls: fixture mode active; no real model/provider calls.
- calendar/provider calls: external provider calls not used.
- improvements: read models now expose progression/sync state without requiring generation.

## Tests and smoke

- `npx vitest run __tests__/services/training-plan-equipment-adaptation.test.ts __tests__/api/training-plan-generation.test.ts __tests__/services/training-plan-coordination.test.ts __tests__/api/training-routes.test.ts --reporter=default`: PASS, 4 files / 61 tests.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run docs:audit`: PASS exit 0, with pre-existing markdown-drift warnings.
- Local beginner/no-equipment API smoke: PASS after RDL fallback fix; no forbidden barbell/dumbbell/machine/cable terms remained.
- Local advanced marathon + five-strength API smoke: PASS; generated 5 gym sessions, 7 run sessions, Saturday long run, and 4 weeks.
- Local missing-marathon-date API smoke: PASS; returned `missingCriticalData: race_date` and `followup:race_date_clarification`.
- iOS simulator interaction: PARTIAL PASS; Training plan review and navigation stress completed, UI questionnaire creation not completed.

## Fixes implemented

- Files: `src/api/routes/training-plan-generation.ts`, `__tests__/api/training-plan-generation.test.ts`.
- Summary: persisted onboarding wrapper rows are unwrapped before planning, restoring real profile/equipment data.
- Test: missing-profile wrapper and unwrap/adaptation tests.
- Validation: focused vitest plus local API plan generation.

- Files: `src/services/training-plan-coordination.ts`, `__tests__/services/training-plan-coordination.test.ts`.
- Summary: strength target cap raised to six and session-cap removal corrected to remove only true excess.
- Test: five-day strength, six-cap, and long-run preservation tests.
- Validation: focused vitest and advanced local smoke.

- Files: `src/services/training-plan-equipment-adaptation.ts`, `__tests__/services/training-plan-equipment-adaptation.test.ts`.
- Summary: no-equipment/bodyweight profile text and RDL aliases now map to bodyweight-compatible substitutions.
- Test: no-equipment profile and equipment-dependent lift removal tests.
- Validation: focused vitest and beginner/no-equipment local smoke.

- Files: `src/api/routes/training-read-models.ts`, `src/api/routes/training.ts`, `__tests__/api/training-routes.test.ts`.
- Summary: added all-weeks read model and route with sync summaries for iOS progression review.
- Test: route returns every active week without regenerating/syncing.
- Validation: focused vitest and local API smoke.

## Evaluation harness

- scenarios added/run: persisted profile wrapper, advanced marathon + five strength, beginner no-equipment, missing marathon date, all-weeks read model.
- results: all local checks passed after the RDL fallback fix.
- gaps: executable UI questionnaire plan-creation harness, provider calendar lifecycle harness, account-switch iOS harness.

## Open items and next priorities

- P0: none.
- P1: none confirmed after local fixes.
- P2:
  1. Build an iOS Training plan-creation XCUITest that fills the questionnaire and asserts generated weekly plan content.
  2. Clarify `sessionsPerWeek` semantics across iOS/API so users know whether it means total sessions or primary modality sessions.
  3. Map technical coach reason codes to user-facing copy.
  4. Run non-production Google/Outlook lifecycle smoke for sync, retry/no-duplicate, and cleanup.
  5. Run true two-account/account-switch Training cache isolation.
- P3:
  1. Reduce existing docs-audit warning surface.
  2. Add visual fixtures for partial, failed, canceled, and superseded Training sync states.

## Local-only release recommendation

READY_FOR_LOCAL_QA_ONLY.

- why: P1 local correctness issues found in this pass are fixed and validated with focused tests, typecheck, build, API smokes, and simulator plan review.
- what must run before staging: iOS questionnaire creation test, account-switch isolation, provider calendar lifecycle smoke, changed-area backend verify gate.
- what must run before production: staging smoke, non-production Google/Outlook provider read-back/no-duplicate/cleanup, signed TestFlight/fresh-auth/Apple/Health/APNs/two-account validation, owner approval.
- owner approval needed: yes for any staging/prod promotion.

## Final verdict

PASS WITH CONDITIONS.

The local backend Training fixes are strong enough for local QA handoff, and no P0/P1 Training blocker remained after focused validation. This is not production-ready evidence by itself because full UI questionnaire creation, provider calendar lifecycle, and two-account/TestFlight validation remain open.
