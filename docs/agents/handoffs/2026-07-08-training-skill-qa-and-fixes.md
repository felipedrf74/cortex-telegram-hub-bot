# 2026-07-08 Training Skill QA And Fixes Handoff

Scope: backend Training/calendar QA in `cortex-telegram-hub-bot` plus paired iOS Training decoder, repository, view-model, and Plan UI proof in `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub`.

Local fixes made:

- Backend Training calendar sync now rolls back provider-created events when calendar ownership recording fails, marks the Secretary agenda item for cleanup, and avoids reporting false success.
- Backend Training calendar owner lookup now filters by tenant in SQL and post-filtering.
- Backend plan generation now persists the full quality gate payload, including the plan rationale.
- Backend read models now mark stale wearable readiness as stale instead of fresh.
  (Correction from the 2026-07-08 Claude QA review: this mapping only fires
  when `readiness.asOf` is old, but `calculateReadiness` stamps `asOf` at
  compute time on every path, so truly stale wearable data still reads as
  fresh in production. The mapping is correct plumbing but the staleness
  conduit — a real wearable capture timestamp — is not wired yet; see the
  review section below.)
- Backend static plan QA uses dynamic race-date buckets instead of hardcoded historical dates.
- iOS Training decoders, repository snapshots, view-model pass-through, and Plan UI now surface backend `calendarCleanup` and degraded sync warnings safely.

Verification evidence:

- `git diff --check` passed in both backend and iOS repos.
- Backend focused Vitest for Training calendar sync, generation, read models, tenant scope, and creation validation passed.
- `npm run typecheck` passed.
- `scripts/changed-area-classifier.sh --json` selected Training/calendar focused gates.
- `scripts/risk-gate.sh --dry-run` produced the expected focused Training/calendar gate plan.
- `scripts/risk-gate.sh` passed.
- `npm run training:plan-validation-matrix` passed with no failures.
- `npm run eval:training` passed with a high score.
- `npx tsx src/tools/training-aad-e2e-fixture-harness.ts --out-dir /tmp/nexus-training-aad-qa-20260708 --fail-under 5` passed all local A-AD fixture scenarios.
- `npx tsx -e "...runTrainingAadNegativeControls..."` passed all A-AD negative controls.
- `npm run verify` passed.
- iOS `scripts/ios-single-simulator-test.sh` passed focused Training decoder, repository/view-model, and Plan presentation tests on the canonical `Nexus Hub` scheme.
- After Docker was started, the previously blocked isolated Training E2E run passed:
  - `npm run training:e2e:down` cleaned stale state.
  - `npm run training:e2e:up` started run `training-e2e-20260708115719-12d76196` with healthy backend/content-engine services.
  - `npm run training:e2e:smoke` passed.
  - `npm run training:e2e:flow` passed with plan `1`, 10 sessions checked, and evidence at `.local/training-e2e/training-e2e-20260708115719-12d76196/training-flow-evidence.json`.
  - `npm run training:e2e:ios` passed 23 UI tests with evidence at `.local/training-e2e/training-e2e-20260708115719-12d76196/ios/TrainingE2E.xcresult`.
  - `npm run training:e2e:down` stopped and removed the isolated containers/network.

Blocked or intentionally not run:

- Live Google/Outlook calendar writes, production provider-state validation, staging promotion, deploy, commit, push, TestFlight, physical device, two-account proof, HealthKit, Garmin, APNs, and production calendar cleanup were not authorized.
- XcodeBuildMCP tools were not callable in this session, so iOS verification used the repo's existing single-simulator harness.

## 2026-07-08 Claude QA Review And Remediation

Independent multi-agent review (8 dimensions, adversarially verified: 36 raw
findings, 31 confirmed, 5 refuted) of the Codex work above, followed by local
fixes. Verdict: GO-WITH-FOLLOWUPS for local readiness; not a release verdict.

Confirmed findings fixed locally in this pass:

- P1 (in-diff, tenant scope): the tenant-scoped owner lookup silently disabled
  the cross-tenant deletion/adoption vetoes in
  `training-plan-cancellation.ts` (`hasActiveTrainingOwner`,
  `isOwnedByAnotherTrainingPlan`) and the sync route's existing-event adoption
  (`isTrainingCalendarEventUnclaimed`) — on a shared provider calendar,
  tenant B could delete or adopt tenant A's training events. Fixed by adding
  boolean-only `isTrainingCalendarEventClaimedOutsideTenant` (no foreign
  metadata leaves the module; fails closed on lookup errors) and wiring it as
  a veto in all three places. New real-SQL `:memory:` integration suite
  `__tests__/services/training-calendar-scope-tenant-isolation.test.ts`
  exercises the SQL predicates and bind order the mocked unit test cannot.
- P2 (in-diff, rollback): ownership-record rollback demoted the session to
  `unscheduled`, which the candidate filter excludes forever, contradicting
  `retryable: true`. Fixed: rollback now clears only the calendar linkage and
  keeps the session schedulable; regression pinned.
- P1 (pre-existing, iOS deep links): `didConsumePendingTrainingRoute` was a
  one-shot boolean, so every Training deep link after the first was silently
  dropped while the view stayed mounted. Replaced with a consumed-route-token
  guard (`TrainingRouteConsumptionReducer`), handoff reducer updated, source
  pin updated, and regression tests added in
  `TrainingPlanBuilderPrefillTests`. Note: an IDENTICAL token re-sent while
  mounted still cannot re-fire (value-based `.task(id:)`); a route nonce in
  the deep-link plumbing is the follow-up if that repeat matters.
- P2 (in-diff, iOS): decoded `degraded`/`warnings` on the sync response were
  consumed by no surface — degraded syncs rendered plain success copy. The
  sync result message now appends a localized "conflicts weren't checked"
  caveat when `degraded == true` (`TrainingViewModel.calendarSyncMessage`,
  now statically testable and pinned).
- P2 (in-diff, iOS): the calendar-cleanup note could order the user to
  re-connect while rendering no button when the `/connections` row was
  missing. `TrainingCalendarCleanupPresentation.reconnectProvider` now falls
  back to the plan's own calendar source; VoiceOver structure fixed so the
  Re-connect button stays a separately focusable control instead of being
  swallowed by the combined element.
- P3 (in-diff): cross-provider duplicate-cleanup read failures now push a
  `calendar_cleanup_read_unavailable` warning instead of staying silent;
  literal-tab indentation in the sync return block normalized to repo style;
  `secretary_agenda_item_missing` guard, delete-success rollback leg,
  main-path degraded flag, healthy-path degraded absence, second
  `markSecretaryAgendaProviderSyncSatisfied` call args, readiness asOf edge
  cases (fresh/boundary/invalid/future/no-data-wins), and `whyThisPlan`
  readback for both new and legacy persisted quality shapes are all now
  test-pinned; the race-date bucket test now freezes the clock and imports a
  fresh module so it cannot flake across midnight UTC; `test-summary.json`
  added to the iOS `.gitignore`; SKILL.md goal-loop wording now covers
  `NOT_APPLICABLE`.

Confirmed findings NOT fixed (follow-ups, need owner decision or wider scope):

- P1: stale wearable readiness detection is unreachable in production —
  `calculateReadiness` stamps `asOf` at compute time on every path, so the
  new `stale_provider` mapping only fires in mocked tests. Real fix requires
  propagating a wearable capture/last-sync timestamp into readiness (touches
  the Garmin/Apple Health pipelines); the doc-contract `capturedAt` field on
  `CoachKernelReadinessInput` is also unwired.
- P2 (pre-existing): `markSecretaryAgendaProviderSyncSatisfied` leaves the
  provider-sync fingerprint unset, so the 5-minute agenda-sync cron can
  rewrite training-created event titles/descriptions (event churn risk); the
  same pattern already ships via `training-plan-persistence.ts`.
- P2 (pre-existing): the reflow confirm path never updates the Secretary
  agenda mapping, so a stale `synced` agenda item can resurrect a ghost event
  at the pre-reflow slot.
- P2 (pre-existing dirty work): `scripts/testflight-export.sh` beta-toolchain
  guard rejects any Xcode build number ending in a lowercase letter — Apple
  release builds (e.g. 14E300c) match, so future TestFlight exports may
  false-positive; `IOS_ALLOW_BETA_TOOLCHAIN=1` is the escape hatch.
- P3 (pre-existing): `filterCalendarEventsForTrainingScope` still uses
  tenant-unscoped SQL, diverging from the now tenant-scoped owner lookup.
- P3: iOS `project.pbxproj` carries an uncommitted build-number bump 48 → 52
  across all 9 configurations — confirm against the TestFlight upload record
  before committing or reverting.
- Committed HEAD note: `NavigationPerformanceSourcePinsTests` is red at the
  iOS repo's HEAD (Content Studio pin expects strings removed by iOS commit
  `19f3a1d` in `Nexus Hub IOS`); the uncommitted `ContentStudioView.swift` +
  pins-test edits repair it and must land together.

Verification evidence for this review pass (all local, no deploy/commit):

- Backend `npm run typecheck` passed after fixes.
- Backend focused Vitest (risk-gate focused globs): 131 files / 2086 tests
  passed, including the new tenant-isolation integration suite and all new
  regression pins.
- Backend `npm run verify` (full Vitest) rerun after fixes: 867 files /
  12,725 tests passed.
- `scripts/changed-area-classifier.sh --json` and
  `scripts/risk-gate.sh --dry-run` re-selected the Training/calendar focused
  gates including the new test files.
- iOS focused single-simulator run (`scripts/ios-single-simulator-test.sh`
  with `-only-testing` for the 7 touched suites): 154/154 passed on the
  canonical `Nexus Hub` scheme.

## 2026-07-08 iOS Dirty-File Provenance Investigation

Scope: read-only provenance pass requested after the Claude QA review. No
commit, push, revert, stash, clean, deploy, TestFlight upload, live provider
write, or iOS file fix was performed. Existing dirty backend and iOS work was
preserved.

Baseline evidence:

- Backend repo remained on `main...origin/main` with the Training QA/fix files
  dirty and this handoff untracked.
- iOS repo remained on `main...origin/main`, HEAD `fcb854c`, with the
  pre-existing dirty clusters below plus unrelated Training fixes from the
  2026-07-08 QA pass.

### Cluster A: Content Studio Scroll Runway

Files:

- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub/Views/Content/Studio/ContentStudioView.swift`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus HubTests/NavigationPerformanceSourcePinsTests.swift`

Origin and intent:

- The originating feature/request trail is the June Content Studio release and
  deep-QA work. Workspace handoffs dated 2026-06-10 cover Content Studio
  build/QA/TestFlight promotion work, and commit `38d5475` (`Fix Content
  Studio QA issues`, 2026-06-13) introduced the original bottom scroll runway
  pattern: `bottomScrollRunway = NexusLayout.tabBarScrollReserve + 80`,
  `.padding(.bottom, Self.bottomScrollRunway)`, `.contentMargins(...)`, and a
  bottom viewport spacer/FAB clearance.
- Commit `19f3a1d` (`Harden content studio validation`, 2026-06-25) retired the
  old FAB/standalone spacer path in `ContentStudioView.swift` but left source
  pins expecting the old scroll-runway strings. Merge commit `d371198` carried
  that mismatch into main.
- The current uncommitted July 2 hunk is a repair of that mismatch: it restores
  a canonical `.contentMargins(.bottom, Self.bottomScrollRunway, for:
  .scrollContent)` runway using `NexusLayout.tabBarScrollReserve`, while keeping
  the FAB gone. The paired source pin was updated to expect this canonical
  string instead of the removed `.padding(.bottom, Self.bottomScrollRunway)`.

How far it got:

- The broader Content Studio release reached App Store Connect/TestFlight
  upload scope in June, but this exact scroll-runway repair is not committed and
  is not proven to be in any uploaded build.
- At clean iOS HEAD `fcb854c`, `NavigationPerformanceSourcePinsTests` is red
  because the committed pin expects strings not present in the committed view.
  The dirty view/test pair is required to make that source-pin contract coherent.
- Workspace handoffs dated 2026-07-02 explicitly classify
  `ContentStudioView.swift` and `NavigationPerformanceSourcePinsTests.swift` as
  pre-existing user/other-session dirty work and exclude them from the Training
  UX commit.

Why it stopped:

- The mismatch was introduced by the June 25 content validation merge, then
  repaired locally in another session, but later Training/iOS work preserved the
  dirty files instead of bundling unrelated Content Studio changes into a
  Training commit.

Landing plan:

1. Keep the two files together in a dedicated Content Studio navigation/visual
   commit; do not split the view repair from the pin repair.
2. Run the focused source pin test plus Content Studio navigation/visual smoke
   on the canonical iOS project:
   `scripts/ios-single-simulator-test.sh -only-testing:Nexus\\ HubTests/NavigationPerformanceSourcePinsTests`.
3. Add screenshot evidence for Content Studio with enough entries to prove the
   bottom action/last section is reachable above the floating tab bar.
4. After proof, commit only the two Content Studio files and their evidence, or
   leave them dirty until Felipe explicitly authorizes landing.

Manual verification still required:

- If exact chat/session authorship matters beyond repo evidence, inspect the
  Codex/Claude app session around 2026-07-01 to 2026-07-02. The repository
  handoffs prove the files were pre-existing by July 2, but they do not name the
  precise initiating chat.

### Cluster B: TestFlight/App Store Upload Chain

Files:

- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/scripts/testflight-export.sh`
- `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj/project.pbxproj`

Origin and intent:

- Workspace release state documents the 2026-07-03 App Store Connect upload:
  an archive built with Xcode 27 beta (`DTXcodeBuild=27A5194q`,
  `DTSDKName=iphoneos27.0`) was rejected, the export script was hardened to use
  stable `/Applications/Xcode.app`, stable build `49` reached ASC but was
  rejected for build-number monotonicity, and stable build `51` uploaded
  successfully with ASC reporting processing/success.
- The dirty script changes match that documented intent: default
  `DEVELOPER_DIR` to stable Xcode, assert selected/archive toolchain metadata,
  and reject beta SDK/toolchain archives before upload.
- The dirty project file currently sets `CURRENT_PROJECT_VERSION = 52` across
  all 9 configurations. The release doc proves successful upload for build
  `51`; no scoped workspace release doc or local archive artifact was found
  proving build `52` was uploaded or attempted.

How far it got:

- Production/TestFlight pipeline impact got as far as App Store Connect
  ingestion for `1.5.0 (51)` on 2026-07-03. The release doc explicitly says
  this was not TestFlight install proof, physical-device smoke, App Review,
  approval, or live App Store release proof.
- Local Xcode state during this investigation was stable Xcode 26.6
  (`17F113`) with `xcode-select` pointing to
  `/Applications/Xcode.app/Contents/Developer`.
- The only local archive found under `~/Library/Developer/Xcode/Archives` was
  the older build `48` archive built with the beta toolchain; no July 3 build
  51/52 archive remains in the default archive directory.

Why it stopped:

- The script hardening and build-51 upload were documented but not committed.
  Build `52` appears to be a later local/manual bump and cannot be reconciled
  from repository evidence alone. Committing or reverting it without ASC
  confirmation could either lose the next valid build number or preserve an
  unnecessary bump.

Known defect at investigation time (superseded — fixed in the
"Dirty-Cluster Resolution Pass" below):

- `scripts/testflight-export.sh` rejected any selected Xcode build number
  ending in a lowercase letter. That caught beta strings, but it could
  false-positive on Apple release builds such as `14E300c`. The resolution
  pass replaced the lowercase-suffix heuristic with explicit beta
  path/metadata checks plus an archive-SDK-newer-than-selected comparison.

Landing plan:

1. Verify the latest App Store Connect build numbers for bundle
   `me.nexushub.app`.
2. If ASC latest is `51`, decide whether build `52` is the next intended local
   build and commit it with the script hardening after fixing the false-positive
   guard.
3. If ASC already has `52`, document the upload evidence before committing the
   build bump.
4. If ASC does not justify `52`, restore the build number to the intended next
   value only after Felipe authorizes the change.
5. Re-run archive/export on stable Xcode and keep the validation bounded to
   local export unless Felipe authorizes upload.

Manual verification still required:

- App Store Connect console: open App Store Connect -> Nexus Hub -> TestFlight
  -> iOS Builds, then record the latest `1.5.0` build numbers and processing
  state for builds 51 and 52.
- CLI/API option if Felipe provides App Store Connect API credentials:
  `xcrun altool --list-builds --app-identifier me.nexushub.app --platform ios --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>`.
  Do not expose or commit `.p8`, issuer, or key material in handoffs.

### Cluster C: Deleted iOS QA Evidence PNG/Log Files

Files:

- 33 deleted files under
  `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/docs/qa/ios-evidence/2026-05-22-alpha`
- 4 deleted files under
  `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/docs/qa/ios-evidence/2026-06-12-codex-interactive-rerun-6`
- 3 deleted files under
  `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub/docs/qa/ios-evidence/2026-06-12-codex-interactive-rerun`

Origin and intent:

- The deleted 2026-05-22 alpha evidence was created for the formal full-app iOS
  QA trail and last committed by `b20ee9b` on 2026-05-29.
- The three 2026-06-12 base rerun images were committed by `6c0e114`; the four
  rerun-6 readable-light screenshots were committed by `d612ef3`.
- The QA plan says not to delete existing canonical audit evidence, and the
  full-app QA report points to `docs/qa/ios-evidence/2026-05-22-alpha/` as the
  evidence home.
- No committed deletion, handoff, or scoped repo document was found proving a
  Felipe request to delete these 40 files. A later context-cleanup style note
  listed iOS evidence paths as possible cleanup candidates, but the note said
  it did not edit or delete anything.

How far it got:

- The deletion exists only as working-tree state. It has not been committed.
- Many other evidence files remain in those directories, so the current state is
  a partial evidence deletion rather than a whole-run archive removal.

Why it stopped:

- No authorization or cleanup commit was found. The safest interpretation is
  accidental or unproven cleanup, especially because canonical QA docs still
  tell agents not to delete this evidence.

Landing plan:

1. Default recommendation: restore the 40 evidence files to preserve the
   historical QA trail, then keep evidence cleanup out of unrelated Training or
   TestFlight commits.
2. If Felipe explicitly confirms cleanup is desired, create a dedicated
   `chore(qa)` cleanup commit that updates all doc/test references and preserves
   a compact manifest of removed artifacts.
3. Do not mix evidence cleanup with Content Studio, Training, or TestFlight
   fixes.

Manual verification still required:

- Ask Felipe whether these 40 evidence deletions were intentional. Without that
  confirmation, treat restoration as the recommended path.

### Provenance Verdict

Verdict: NO-GO for landing the dirty iOS clusters as-is.

Reasons:

- Cluster A is a coherent two-file fix and likely should land, but it needs a
  dedicated Content Studio validation pass and should not be bundled into
  Training QA.
- Cluster B is release-pipeline work with a known guard false-positive and an
  unreconciled build `51` vs `52` state; App Store Connect must be checked
  before commit, revert, or upload.
- Cluster C has no proven authorization and conflicts with canonical QA
  evidence-retention guidance; default action should be restore unless Felipe
  confirms cleanup.

## 2026-07-08 Dirty-Cluster Resolution Pass

Scope: local fix pass authorized after the provenance investigation. No commit,
push, deploy, TestFlight upload, live App Store Connect write, or live provider
write was performed. Existing unrelated dirty Training/iOS/backend files were
preserved.

Resolved locally:

- Cluster A: kept the Content Studio view and source pin together. The view now
  uses a tab-bar-only `bottomScrollRunway` with
  `.contentMargins(.bottom, Self.bottomScrollRunway, for: .scrollContent)`;
  the source pin no longer expects the removed FAB-era
  `.padding(.bottom, Self.bottomScrollRunway)` string.
- Cluster B: fixed `scripts/testflight-export.sh` so Apple release build
  identifiers ending in lowercase, such as `14E300c`, no longer trip the beta
  guard. The script still rejects explicit beta Xcode paths/metadata and now
  rejects archives built with a newer iPhoneOS SDK than the selected stable
  upload toolchain, preserving the Xcode 27 beta-archive protection.
- Cluster C: restored the 40 deleted historical QA evidence PNG/log files under
  the 2026-05-22 alpha and 2026-06-12 rerun evidence directories. The iOS
  working tree no longer shows deletions under those evidence paths.

Deliberately not resolved without human console proof:

- The iOS project remains bumped to build `52`. Based on the release doc, build
  `51` was successfully uploaded and build `52` is a plausible next monotonic
  local build. It should not be uploaded, committed, or reverted until App Store
  Connect confirms the latest `1.5.0` build list.

Verification evidence:

- `bash -n scripts/testflight-export.sh` passed.
- Temporary local export guard harness passed for a stable archive plist with
  `DTXcodeBuild=14E300c` and `DTSDKName=iphoneos26.5`; it did not perform a
  real archive or upload.
- Temporary local export guard harness rejected a newer-SDK archive plist with
  `DTXcodeBuild=27A5194q` and `DTSDKName=iphoneos27.0` with exit 65 and the
  expected "Archive SDK is newer than the selected App Store upload toolchain"
  error; it did not perform a real archive or upload.
- `scripts/ios-single-simulator-test.sh -only-testing:Nexus\ HubTests/NavigationPerformanceSourcePinsTests`
  passed 43/43 on `Nexus Hub`.
- `IOS_SCHEME="Nexus Hub Debug UI Smoke" scripts/ios-single-simulator-test.sh -only-testing:Nexus\ HubUITests/ContentStudioShellUITests`
  passed 4/4 on the UI smoke scheme. The first attempt on the default
  `Nexus Hub` scheme correctly failed before execution because
  `Nexus HubUITests` is not a member of that scheme/test plan.
- `scripts/ios-release-hardening-validate.sh` passed.
- `git diff --check` passed for the touched iOS cluster files and restored
  evidence paths.

Manual verification still required:

- App Store Connect console: open App Store Connect -> Nexus Hub -> TestFlight
  -> iOS Builds, then record whether `1.5.0 (51)` is the latest uploaded build
  or whether `1.5.0 (52)` already exists. This is required before any commit,
  revert, archive, or upload involving the build number.
- TestFlight install, physical-device smoke, App Review submission/approval,
  APNs, HealthKit, Garmin, two-account proof, and live provider calendar
  validation were not authorized or run.

Resolution verdict: GO-WITH-FOLLOWUPS for local dirty-cluster fix readiness;
NO-GO for TestFlight/App Store release action until App Store Connect build
state is manually verified.

### 2026-07-08 Claude QA Verification Of The Resolution Pass

Independent reproduction of the resolution claims (read-only plus doc
annotations; no cluster code changed):

- Reproduced: `bash -n` under stock bash 3.2.57; guard-function smokes
  (release `14E300c`/`iphoneos26.5` accepted; `iphoneos27.0` archive vs
  `iphoneos26.5` selected rejected exit 65; `Xcode-beta.app` path rejected
  exit 65; `IOS_ALLOW_BETA_TOOLCHAIN=1` escape hatch honored);
  `NavigationPerformanceSourcePinsTests` 43/43; committed-HEAD red-pin claim
  (committed view has zero `bottomScrollRunway`/`contentMargins` occurrences
  while the committed pin expects them); evidence tree porcelain-clean under
  `docs/qa/ios-evidence`; `scripts/ios-release-hardening-validate.sh` passed;
  reward check WARN / 98 / PASS 5 reproduced exactly.
- Deviation: `ContentStudioShellUITests` first full run was 3/4 —
  `test_studioShellRendersAndSwitchesZones` failed once on "Today hero did
  not render" (`content-next-action-card`, 6s existence timeout), then passed
  1/1 on immediate rerun. The test is timing-flaky on first Studio entry, not
  a regression of the dirty view change; treat single-run UI-smoke evidence
  accordingly and consider a fixture-ready wait or longer hero timeout.
- New residual gaps found in the rewritten export guard (smoke-proven, not
  fixed — recommend before landing Cluster B):
  - Same-major mid-cycle beta SDK passes: archive `iphoneos17.4` (beta-era,
    `DTXcodeBuild=15E5178f` carries no "beta" marker) vs selected
    `iphoneos17.2` is accepted because only the SDK MAJOR is compared.
    Recommend comparing major.minor (e.g. major*1000 + minor).
  - A beta Xcode renamed outside the `Xcode-beta.app`/`Xcode-beta/` patterns
    and explicitly exported as `DEVELOPER_DIR` passes the selected-toolchain
    check (`xcodebuild -version` emits no "beta" string). Mitigated by the
    stable default; optional hardening: treat Apple seed build numbers
    (`NN[A-Z]5xxx?` pattern) as beta signals.
- Doc fix applied: the provenance section's "known defect, not fixed" block
  for the lowercase-suffix heuristic is now annotated as superseded by the
  resolution pass to prevent stale-claim drift.

### 2026-07-08 Guard-Gap And UI-Smoke Fix Pass (Claude, owner-authorized)

Fixes applied after Felipe authorized remediation of the QA findings:

- `scripts/testflight-export.sh`: SDK comparison now uses major.minor as a
  single comparable value (`iphoneos_sdk_comparable`, 26.5 -> 26005), closing
  the same-major mid-cycle beta gap (archive `iphoneos17.4` vs selected
  `iphoneos17.2` now rejects exit 65). `reject_beta_toolchain` additionally
  treats Apple seed build numbers (train letter followed by a 4-digit
  component starting with 5, e.g. `27A5194q`, `15E5178f`, `16B5001e`) as beta
  signals, closing the renamed-beta-DEVELOPER_DIR gap. 15-case smoke matrix
  under stock bash 3.2.57 passed: release ids `14E300c`/`17F113`/`15E204a`/
  `21G527` accepted; beta path, cross-major SDK, same-major-newer SDK, and all
  three seed builds rejected; equal/older SDK accepted; empty-metadata
  fail-open unchanged; `IOS_ALLOW_BETA_TOOLCHAIN=1` escape hatch honored;
  `bash -n` clean.
- `Nexus HubUITests/ContentStudioShellUITests.swift`: the intermittent
  `test_studioShellRendersAndSwitchesZones` failure was NOT timing — the
  raised hero timeout still failed. Root cause: `@SceneStorage` zone
  selection persists across relaunches within a test run, so the
  alphabetically-previous DNA-zone test could hand this test a non-Today
  zone where the Today-only hero never renders (non-deterministic scene
  snapshotting explains fail/pass/fail). Fixed by explicitly selecting the
  Today zone before asserting the hero; the raised first-entry timeout was
  kept as headroom. Suite then passed 4/4 twice consecutively.
- Training E2E stack re-run against the current worktree (today's sync-route
  rollback/veto changes included), run `training-e2e-20260708161048-12d76196`:
  `training:e2e:up` healthy, `training:e2e:smoke` passed, `training:e2e:flow`
  passed (plan 1, 10 sessions checked, evidence under
  `.local/training-e2e/training-e2e-20260708161048-12d76196/`);
  `training:e2e:ios` passed 23/23 with the result bundle at
  `.local/training-e2e/training-e2e-20260708161048-12d76196/ios/TrainingE2E.xcresult`;
  `training:e2e:down` removed the isolated containers/network.

### 2026-07-08 Production Promote Closeout

Felipe authorized landing and promoting this work, excluding TestFlight/App
Store upload. Backend and iOS source were landed and pushed; production backend
was promoted.

- Backend commits pushed to `origin/main`:
  - `b28a47b6 fix(training): harden calendar sync lifecycle`
  - `90d0a8a3 docs(agents): capture training qa handoff`
  - `b1916a76 docs(release): record training qa staging smoke`
- iOS commits pushed to `origin/main`:
  - `9093526 fix(training): harden plan and route state`
  - `88e48bc fix(content-studio): preserve bottom scroll runway`
  - `e1d1ca0 chore(release-tooling): harden testflight export guard`
- iOS `Nexus Hub.xcodeproj/project.pbxproj` remains the only dirty iOS file,
  intentionally uncommitted pending Felipe's App Store Connect build-number
  confirmation.
- Backend classifier selected T0/T1/T2/T4/T5-on-promote/T6-postdeploy.
- Backend `scripts/risk-gate.sh` passed focused Training/calendar 131 files /
  2,086 tests and changed sweep 54 files / 1,431 tests; pre-push repeated the
  gate and build verification.
- iOS release gates passed:
  - `NavigationPerformanceSourcePinsTests`: 43/43.
  - touched Training bundle: 154/154.
  - `ContentStudioShellUITests` on `Nexus Hub Debug UI Smoke`: 4/4.
- `deploy-staging.sh` passed; soak ran `2026-07-08T17:24:35Z` to
  `2026-07-08T17:29:35Z`; staging smoke passed 19/19 with evidence
  `docs/release/smoke-evidence/staging-smoke-90d0a8a3-20260708T173034Z.json`.
- `promote-to-prod.sh` completed. Production now runs `4.14.213` at
  `b1916a76`; deploy-time validation passed migration safety (216 migrations),
  typecheck, science-policy, and full Vitest 867 files / 12,725 tests.
- Post-promote probes passed: public `/health` healthy, public
  `/public-status` ok, PM2 `nexus-hub` and `content-engine` online on
  `4.14.213`, and authenticated Decision Center overview returned `ok: true`.
- Still not run / not authorized: TestFlight/App Store upload, physical-device
  proof, live Google/Outlook production calendar writes, two-account provider
  proof, HealthKit, Garmin, APNs live push, and production provider-state
  validation.

## Verifiable Reward Summary

Verdict: GO-WITH-FOLLOWUPS for local Training QA/fix readiness; not a production
release verdict. The dirty-cluster resolution pass is GO-WITH-FOLLOWUPS for
local fix readiness and remains NO-GO for TestFlight/App Store release action
until App Store Connect build state is manually verified.

Evidence: backend risk gate, full backend verify, Training plan matrix, Training
eval harness, A-AD profile fixture/negative-control harness, docs audit, focused
iOS simulator tests, and the isolated Docker-backed Training E2E stack all ran
locally for the Training QA pass. The provenance addendum was a read-only
git/docs/archive investigation. The dirty-cluster resolution pass added focused
iOS source-pin/UI-smoke validation, release hardening validation, script guard
smokes, and restored evidence-file status proof.

Reward loop: latest post-promote `npm run reward:check -- --area auto
--advisory --handoff docs/agents/handoffs/2026-07-08-training-skill-qa-and-fixes.md`
returned `WARN`, score 88, no hard failures, mandatory checks PASS 3,
`verify-deliverable` warning, and export ineligible pending manual human
review. Earlier pre-promote local reward reproduction was `WARN`, score 98,
mandatory checks PASS 5.

Skipped checks: live provider calendar writes, physical-device and TestFlight
validation, App Store Connect live-build verification, two-account proof,
production deploy/promotion, and live HealthKit/Garmin/APNs validation.
