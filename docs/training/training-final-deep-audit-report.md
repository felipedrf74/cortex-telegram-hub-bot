# Training / Coach deep audit and hardening report

## Executive summary

- verdict: PASS WITH CONDITIONS
- biggest gray areas found: five-day strength support was not complete across all layers; marathon missing race date was not being surfaced as critical context; physical-device and provider-calendar validation remain open.
- biggest bugs found: app-facing route normalization, volume enforcement, marathon strength engine maintenance logic, and deterministic fallback could still prevent or degrade explicit five-day strength requests.
- biggest fixes applied: five-day strength now survives route, engine, volume enforcement, and fallback; marathon without race date now gets a critical follow-up; fallback default behavior was restored after full verify caught a regression.
- remaining release risk: signed-device/TestFlight Training interaction and Google/Outlook non-production lifecycle smoke were not run.
- whether Training is ready to merge/main: yes, with the listed validation conditions.
- whether Training is ready for production: not from this pass alone; production needs staging/provider calendar smoke and signed-device validation.

## Execution behavior

- Did you proceed without unnecessary pauses: yes.
- Did you prioritize P0/P1 over easier tasks: yes; the incomplete five-day strength path and marathon missing-data path were fixed before docs/polish.
- Any hard blockers: physical iPhone was not available to Xcode; default local smoke user lacked a completed Training profile, so local generation correctly stopped at profile completion.
- Any task skipped due to risk: broad tenant-aware mesh reader redesign and provider calendar smoke were documented, not patched, because they require broader schema/provider work.

## Branch and backup

- repos: backend `/tmp/nexus-training-hardening-backend`; iOS `/tmp/nexus-training-hardening-ios`
- branches: `feature/training-coach-deep-audit-and-hardening` in both worktrees.
- commits: backend base `627d4fe`; iOS base `18678a3`.
- backup tags: `backup/training-coach-before-deep-audit-20260502-1808` in source repos.
- dirty state before/after: source repos had unrelated dirty work preserved; changes were made in clean worktrees. Backend worktree now has intentional code/test/docs changes; iOS worktree remains clean.

## Current-state map

- engine architecture: Training plan generation routes into coordination, coach kernel, volume enforcement, persistence, calendar/agenda reconciliation, and app read models.
- iOS contract: remote Training home payloads are deduped, Week Journey is removed, and weekly plan sync state uses plan-level status.
- Secretary/calendar integration: app-facing path uses a selected calendar source and Secretary-aware coordination; provider read-back remains a release gate.
- profile/questionnaire: equipment and experience vocabulary were expanded before this pass; this pass adds marathon race date as critical missing data.
- tests/smoke: focused Training tests, full backend verify, local full Nexus smoke, cross-skill fixtures, chat tenant smoke, and iOS focused tests were run.

## Findings

### P0

- None reproduced. Local chat tenant smoke passed 15 checks, with 1 partial provider-fallback check and 0 failures.

### P1

- ID: TR-P1-01
- area: strength planning
- file/line: `src/api/routes/training-plan-generation.ts:240`, `src/services/training-plan-volume-enforcement.ts:35`, `src/services/coach-kernel/engines/strength-engine.ts:1122`
- evidence: five-day strength was still capped/trimmed or forced to maintenance in several layers.
- user impact: an advanced athlete asking for 5x/week strength could receive fewer or less distinct sessions.
- root cause: the previous weekly-target fix did not update all downstream constraints.
- fix/recommendation: fixed route cap, additive running+strength enforcement, marathon high-frequency strength block, and fallback templates.
- status: fixed and tested.

- ID: TR-P1-02
- area: marathon profile completeness
- file/line: `src/services/training-profile-model.ts:202`
- evidence: marathon with no race date could proceed without making race date a critical follow-up.
- user impact: progression/taper confidence could be overstated.
- root cause: missing-data model did not treat marathon race date as required.
- fix/recommendation: added critical `race_date` follow-up.
- status: fixed and tested.

### P2

- TR-P2-DEVICE: physical-device Training interaction unavailable; run signed device/TestFlight smoke.
- TR-P2-PROVIDER: Google/Outlook provider lifecycle smoke not run; run non-production provider read-back/duplicate/cleanup test.
- TR-P2-MESH: shared mesh readers need tenant-explicit APIs before unconditional multi-tenant shared-context claims.
- TR-P2-FEEDBACK: iOS feedback submission/adaptation not manually exercised.
- TR-P2-CYCLING: cycling-specific periodization remains shallower than strength/running.

### P3

- Add richer local Training seed data so local smoke can generate a personalized plan.
- Add visual fixtures for partial, failed, canceled, and superseded sync states.

## User-reported issue re-check

- 5x strength support: fixed; route, engine, fallback, and tests now support explicit five-day strength.
- Saturday long run: partially verified through deterministic fallback and Felipe-style scenario; full Secretary/provider scheduling smoke still needed.
- profile ignored: prior vocabulary fixes plus this pass preserve high-volume/five-day intent; broader iOS profile-edit flow not manually tested.
- marathon date: fixed; missing race date now triggers critical follow-up.
- future-week progression: improved for strength maintenance/high-frequency logic; full multi-week visual review remains P2.
- calendar banner: iOS contract tests passed; provider evidence still needed.
- duplicate UI: focused iOS contract tests passed; static review confirms remote CTA dedup.
- Jornada da semana: removed/merged in iOS static state; not manually device-smoked.
- technical explanations: no new issue found; copy polish remains P3.
- Training lag/runtime: local smoke did not show read-path provider/model escape; physical-device measurement remains open.
- identity/tenant leakage: no Training P0 reproduced; context mesh tenant-explicit work remains P1/P2 follow-up.

## Engine intelligence review

- profile use: better after equipment/experience vocabulary plus five-day propagation and race-date follow-up.
- strength: high-frequency support fixed; race-close maintenance preserved.
- running: marathon minimums from prior work remain; long-run day is canonicalized.
- cycling: no new code change; deeper catalog/progression review remains.
- hybrid: no new regression found.
- progression: race-date confidence is now explicit; high-frequency strength is phase/race-aware.
- feedback: service tests pass; iOS interaction not verified.
- safety/biomechanics: existing guardrail/catalog tests pass; no medical-claim change made.
- catalog: fallback expanded for explicit five/six strength while preserving default four.
- gray areas: provider calendar lifecycle and physical-device interaction.

## Calendar and Secretary review

- scheduling intent: Training stays on the Secretary-aware coordination path.
- agenda state: local tests and smoke pass.
- provider sync: not provider-smoked in this pass.
- partial sync: iOS contract tests cover plan sync state.
- cleanup: cancellation/reconciliation surface passed tests.
- duplicates: no app-facing dual-provider write path found; provider duplicate proof still needs staging/non-prod smoke.
- timezone/week-start: no new issue reproduced.
- open risks: provider residue from legacy events requires provider read-back smoke.

## Identity and tenant safety review

- hardcoded user scan: no Training product runtime hardcoding of Felipe found.
- profile ownership: focused tests and smoke preserve user scope.
- plan ownership: route and lifecycle tests passed.
- feedback ownership: service-level tests pass; iOS submission not manually tested.
- memory/shared context: skill memory tests pass; mesh reader tenant-explicit redesign remains open.
- Chat/Secretary tool scope: local chat tenant smoke passed.
- iOS cache: account-switch stale-cache test not run.
- open risks: tenant-aware mesh API follow-up and physical-device account-switch smoke.

## iOS contract and frontend validation

- iOS run: focused xcodebuild tests on one selected simulator.
- physical device run if available: not available to Xcode.
- flows tested: contract/resolver/sync-state unit tests, not manual end-to-end UI interaction.
- rich states: plan sync state tests pass; full rich visual set remains open.
- UI copy: no new change.
- duplicate sections: fixed by prior iOS commit and revalidated statically/tests.
- technical details: no new issue found.
- account switch/stale cache: untested.

## Runtime performance

- endpoints: local smoke exercised app-facing Dashboard, Plan, Tasks, Training summary/today, Content, Finance, Connections, Inbox.
- latency: no multi-second backend blocker reproduced in local smoke.
- payload size: not measured in this pass.
- duplicate requests: not instrumented in this pass.
- expensive read paths: no plan regeneration/provider/model call on simple local smoke reads was observed.
- model/provider calls: fixture routing active; no real calls.
- calendar/provider calls: provider calls not run.
- improvements: no runtime performance code change was needed beyond Training generation correctness.

## Tests and smoke

- `npx tsc --noEmit`: pass.
- Focused engine/profile suite: 38/38 pass.
- Vocabulary/weekly-target suite: 83/83 pass.
- Broad Training suite: 192/192 pass.
- Fallback test after regression fix: 6/6 pass.
- `npm run verify`: first run caught 1 regression; final rerun 431/431 files, 6507/6507 tests pass.
- Local full Nexus smoke: 13/13 pass.
- Cross-skill fixtures: pass.
- Chat tenant smoke: 15 pass / 1 partial / 0 fail.
- iOS focused Training tests: 40/40 pass.

## Cleanup

- Local engine cleanup command completed; ports 8200 and 8326 are clear.
- Local smoke DB was removed.
- iOS simulators were shut down; `simctl list devices booted` reports no booted devices.
- One suspended CoreSimulator `Nexus Hub.app` process remained after `shutdown all`, `simctl terminate`, `kill`, and `kill -9`; no simulator is booted and no local service ports are listening.

## Fixes implemented

- Route/enforcement high-frequency strength support.
- Marathon high-frequency strength block with maintenance guardrails.
- Explicit five/six deterministic fallback templates with unchanged default.
- Marathon race date critical missing field.
- Security/context docs updated for Training slice.

## Evaluation harness

- scenarios added/run: route propagation, volume enforcement, high-frequency marathon strength, race-close maintenance, explicit fallback, missing race date.
- results: all pass after final rerun.
- gaps: executable full persona harness and device/provider smoke remain.

## Open items and next priorities

- P0: none.
- P1: none remaining from this code scope.
- P2: signed device/TestFlight Training smoke; Google/Outlook non-production lifecycle smoke; tenant-explicit mesh readers; iOS feedback interaction; cycling/hybrid progression harness.
- P3: richer local Training fixture; visual rich-state snapshots.

## Final verdict

PASS WITH CONDITIONS.

The high-risk engine correctness gaps found in this pass are fixed and heavily tested, including full backend verify. Production promotion should still wait for provider calendar lifecycle smoke and signed-device/TestFlight Training interaction because those were not executable here.
