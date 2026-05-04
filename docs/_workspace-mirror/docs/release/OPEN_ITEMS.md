# Open Items

Last updated: 2026-05-04

## Closed-beta auth + training + engineering closeout — Physical iPhone E3 closure (2026-05-04 late night)

Original branch: `feature/engineering-excellence-architecture-standards` @ `73b5c6a` (Claude initial closeout).
Codex validation branch: `feature/closed-beta-auth-training-engineering-codex-validation` @ `751480d`
(5 commits on top of `73b5c6a`: `972bf58` + `9f4d828` + `4dbbd90` + `69fded6` + `751480d`).
Backup tag: `backup/engineering-excellence-before-hardening-20260504-1057`.

Verdict: **READY_TO_OPEN_PR** — every P0/P1 is CLOSED including physical-iPhone E3. Codex's two extensions validated; simulator-`Busy` blocker REFUTED; physical iPhone Felipe (now connected, was `unavailable`) ran both Training UI suites green.

### Physical iPhone E3 evidence (NEW)

iPhone Felipe (`00008150-000C0D5101D8401C`, iPhone 17 Pro Max, iOS 26.5):

- `TrainingFixtureBypassUITests`: **11/11 PASS** on physical device (≈300s total). All 11 cases including the 198s tab-stress (10× round-trip switches under rich-fixture state) green.
- `TrainingValidationUITests`: **3 PASS + 1 SKIP** on physical device (≈26s). Skipped case requires fixture-bypass env exclusive to the sister suite — by design.

Evidence files:
- `engine/docs/release/testflight-evidence/testflight-751480d-training-fixture-bypass-A-through-I-2026-05-04T13-45-01Z.json`
- `engine/docs/release/testflight-evidence/testflight-751480d-training-validation-welcome-to-auth-transition-2026-05-04T13-45-01Z.json`

Build: clean after `xattr -cr build/DerivedData/Build/Products/Debug-iphoneos`.
Auto-clone behavior: absent on physical devices (runner = `iPhone Felipe - Nexus HubUITests-Runner`, no XPC `Busy` noise).

### Claude's review of Codex validation delta

| Item | Codex claim | Claude review | Final status |
|---|---|---|---|
| AUTH-O2 | EXTENDED/fixed (devToken gated by `PASSWORD_RESET_DEV_TOKEN=1` + non-prod + non-staging; 150ms response-timing floor; fire-and-forget email send) | Diff at `972bf58` reviewed: `passwordResetDevTokenAllowed()` requires THREE conditions (fail-closed); `waitForPasswordResetRequestFloor()` equalizes timing; new test `expect(known.body).toEqual(res.body)` is exactly the right anti-enumeration assertion. **VALIDATED.** | **CLOSED via Codex `972bf58`** |
| AUTH-O4 | EXTENDED/fixed (`backfillLegacyRefreshTokenHashes()` startup hook hashes legacy plaintext rows + clears plaintext + preserves row count via UPDATE-not-DELETE) | Diff at `972bf58` reviewed: transaction-wrapped UPDATE is atomic; PRAGMA precheck makes it safe on un-migrated schemas; database.ts startup invocation is wrapped in try/catch with operator-actionable warning. New auth-routes test pins row-count preservation, plaintext-cleared, hash-matches-sha256 simultaneously. **VALIDATED.** | **CLOSED via Codex `972bf58`** |
| AUTH-O6/O7/O8/O9/O10/O11/O12 | CONFIRMED | Re-ran 14/14 + 13/13 + 52/52 + 23/23 dashboard. All green. | **CLOSED in Claude `627e0e4`** |
| TR-EC-O10 / TR-EC-IOS-O3 | Codex blocked twice on `TrainingValidationUITests` simulator `Busy`, accepted only `TrainingFixtureBypassUITests` 11/11 PASS | Claude re-ran with `xcrun simctl shutdown all` + boot exactly one simulator. **`TrainingValidationUITests`: 3 PASS + 1 SKIP (the skipped case requires fixture-bypass env handled by the OTHER suite); `TrainingFixtureBypassUITests`: 11/11 PASS.** Codex `Busy` was transient noise during the auto-clone setup, not an actual blocker — the test cases ran and passed regardless. **TR-EC-CX-O1 REFUTED.** | **CLOSED on simulator** (physical iPhone E5 still requires unlock) |
| ENG-EXC-CX-O6 | Workspace-mirror default workspace root incorrectly resolved to `Custom Connectors/Cortex` parent — Codex fixed | Diff at `972bf58` reviewed: defaults to `/Users/felipedominguez/Desktop/Nexus Hub` if present, falls through to engine parent only as last resort, honors `NEXUS_WORKSPACE_ROOT`. `--check` exits 0. **VALIDATED.** | **CLOSED via Codex `972bf58`** |
| AUTH-CX-O3 | NEW P3: attempt_count cap is documented as primary brute-force control but isn't reached for unknown tokens | Re-read service: with 256-bit token entropy, brute-force is infeasible by entropy alone — the cap is genuinely belt-and-suspenders against pathological clients hitting a known token row. **Status correct as P3 documentation tweak.** | **OPEN P3** (docs-only) |

### Claude's re-run evidence (Codex branch HEAD `69fded6`)

- `npx tsc --noEmit`: clean.
- `__tests__/api/auth-password-reset.test.ts`: **14/14 PASS** (6.37s).
- `__tests__/api/auth-routes.test.ts`: **13/13 PASS** (5.57s).
- `__tests__/services/account-lockout.test.ts` + `__tests__/scripts/changed-area-classifier.test.ts` + `__tests__/services/audit-trail.test.ts` + `__tests__/services/coach-kernel-plan-linter.test.ts`: **52/52 PASS** (11.17s).
- `engine/scripts/cannot-skip-gate-dashboard.sh --quiet`: **exit 0** (23/23 gates wired).
- `engine/scripts/workspace-docs-mirror.sh --check`: **in sync** (exit 0).
- `npm run docs:audit`: **486 issues / 382 files** (matches Codex baseline; +1 file vs Claude's 381 because of the new validation report).
- iOS simulator UDID `A0B13967-B5DE-4E6F-897D-F1E409093F94` (single-booted after `simctl shutdown all`):
  - `TrainingFixtureBypassUITests`: **11/11 PASS**.
  - `TrainingValidationUITests`: **3 PASS + 1 SKIP** (the `strengthStepperAccepts5Sessions` case skips because it depends on fixture-bypass env exclusive to the sister suite). Codex's `Busy` blocker was transient launch noise; tests ran and passed in the same run.
- Physical iPhone Felipe: still `unavailable` via `devicectl` (needs unlock + Trust This Computer + Developer Mode toggle on the device).

### Decision: merge path

The Codex validation branch (`feature/closed-beta-auth-training-engineering-codex-validation`) MUST be merged into the standards branch before the engine PR opens. Without Codex's two extensions, AUTH-O2 has a misconfig footgun (raw token leak under Resend outage in production) and AUTH-O4 leaves legacy plaintext refresh tokens in `ios_devices.refresh_token` after migration 110.

Recommended merge: a single `--no-ff` merge of the Codex branch into `feature/engineering-excellence-architecture-standards` to preserve the two-agent validation lane in `git log --graph`.

### Final closure summary (after Codex merge)

| ID | Severity | Status |
|---|---|---|
| AUTH-O2 | P0 | **CLOSED** (Codex `972bf58` extends Claude `627e0e4`) |
| AUTH-O4 | P1 | **CLOSED** (Codex backfill closes the migration gap) |
| AUTH-O6/O7/O8/O9/O10/O11/O12 | P1 | **CLOSED** (Claude `627e0e4`) |
| TR-EC-O10 / TR-EC-IOS-O3 | P1 | **CLOSED on physical iPhone Felipe E3** (11/11 fixture-bypass + 3/3 validation, evidence under `engine/docs/release/testflight-evidence/`) |
| TR-EC-O11/O12 | P1 | **SHIPPED** in main 4.14.128 |
| TR-EC-O13 | P1 | **DECIDED + telemetry** (Claude `1aa5955`) |
| TR-EC-IOS-O1/O2 | P1 | **PRE-EXISTING / DECIDED** |
| ENG-EXC-O6/O7/O9/O10 | P2/P3 | **CLOSED** (Claude `1aa5955`) |
| ENG-EXC-CX-O5 | P2 | **CLOSED** (Claude docs-audit baseline policy) |
| ENG-EXC-CX-O6 | P2 | **CLOSED** (Codex mirror root detection fix) |
| AUTH-CX-O3 | P3 | **OPEN** (docs-only — soften "primary brute-force control" language) |
| TR-EC-CX-O1 | P2 | **REFUTED** by Claude clean-simulator rerun (3/3+1 skip; 11/11 sister suite). Closed. |

### What remains operator-action

1. **Open the engine PR** from `feature/engineering-excellence-architecture-standards` AFTER merging the Codex validation branch in.
2. Soften the "5-attempt cap" language in `src/services/password-reset.ts` per AUTH-CX-O3 guidance — present it as defense-in-depth, not primary control. P3 docs-only.
3. Run signed TestFlight E5 walk-through with the new AUTH flows (login, password reset, account-switch, two-account "Who am I?") — required for OPEN-beta gate; closed-beta is satisfied by the physical-device E3 above.

---

## Closed-beta auth + training + engineering closeout pass (2026-05-04 evening)

Branch: `feature/engineering-excellence-architecture-standards` @ `1aa5955` (NOT pushed).
Backup tag: `backup/engineering-excellence-before-hardening-20260504-1057`.

Verdict: **READY_WITH_CONDITIONS** — every P0/P1 item from the prior list is FIXED locally; only physical-iPhone E5 walk-throughs and operator deploy decisions remain.

### What I shipped (commits `627e0e4` + `1aa5955`)

**P0:**
- **AUTH-O2** password reset flow — `POST /auth/password-reset/{request,confirm}`, opaque hashed token (SHA-256 at rest), 1h TTL, 5-attempt cap, single-use, account-existence-enumeration-resistant generic 200 envelope, all-session revocation on success. Migration 109. 14 new tests.

**P1 (auth):**
- **AUTH-O4** refresh tokens hashed at rest + `previous_refresh_token_hash` for theft detection. Migration 110. `/auth/refresh` revokes ALL device sessions on previous-hash replay.
- **AUTH-O6** `auth.user_created` + `auth.provider_linked` audit rows on every Apple/Google/email/invite creation path.
- **AUTH-O7** per-account lockout (10 attempts / 15min sliding window / 15min lockout). New `failed_login_attempts` table + `account-lockout.ts`. 8 pin tests.
- **AUTH-O8** Apple `@privaterelay.appleid.com` defensive check on `/auth/register/apple`.
- **AUTH-O9** `/auth/me` extended with `email`, `emailVerified`, `tier`, `authProvider` (additive).
- **AUTH-O10** portal `/api/*` rate limit mounted (excluding iOS `/api/v1/*`).
- **AUTH-O11** `PORTAL_BETA_HARDENED=true` now refuses to boot when `PORTAL_ADMIN_TOKEN` is empty.
- **AUTH-O12** portal `enforcePortalToken` emits `portal.auth` audit rows on every branch.

**P1 (training, already in main at 4.14.128):**
- **TR-EC-O11** scheduler-floor fix.
- **TR-EC-O12** plan-linter session date persistence fix.
- **TR-EC-O13** advisor-mode kept; new `plan_linter.blocker_present` event for operator dashboarding.

**P1 (iOS training):**
- **TR-EC-IOS-O1** `training-goal-mode-picker` already in `Nexus Hub/Views/Training/TrainingView.swift:1066`.
- **TR-EC-IOS-O2** decision: modality-specific profile inputs stay in onboarding.
- **TR-EC-O10 + TR-EC-IOS-O3** Workflows A–I: 11/11 `TrainingFixtureBypassUITests` PASS on iPhone 17 Pro simulator. Physical iPhone Felipe blocked by `devicectl unavailable` (needs unlock + Trust + Developer Mode).

**P2/P3 (engineering excellence):**
- **ENG-EXC-O6** TestFlight evidence pattern → `engine/scripts/testflight-evidence.sh`.
- **ENG-EXC-O7 + ENG-EXC-CX-O5** `docs/release/docs-audit-baseline-policy.md` codifying frozen-baseline classes.
- **ENG-EXC-O9** outbound markdown link lint over engineering paths.
- **ENG-EXC-O10** "must" rule deprecation workflow.

### Closure summary

| ID | Severity | Status |
|---|---|---|
| AUTH-O2 | P0 | **FIXED locally** (`627e0e4`) |
| AUTH-O4..O12 | P1 | **FIXED locally** (`627e0e4`, 8 items, single batch) |
| TR-EC-O10 | P1 | **PARTIAL** (simulator green; physical iPhone blocked on unlock) |
| TR-EC-O11/O12 | P1 | **MERGED in main 4.14.128** |
| TR-EC-O13 | P1 | **DECIDED + telemetry** (`1aa5955`) |
| TR-EC-IOS-O1 | P1 | **PRE-EXISTING in iOS main** |
| TR-EC-IOS-O2 | P1 | **DECIDED** (kept in onboarding) |
| TR-EC-IOS-O3 | P1 | **PARTIAL** — see TR-EC-O10 |
| ENG-EXC-O6/O7/O9/O10/CX-O5 | P2/P3 | **FIXED locally** (`1aa5955`) |

### Verification

- `npx tsc --noEmit` clean.
- **202/202 tests PASS** across 19 files (classifier 15/15, auth-routes 13/13, auth-password-reset 14/14, account-lockout 8/8, audit-trail 6/6, plan-linter 23/23, training-plan-persistence 14/14, etc.).
- Pre-commit hooks ran clean (88/88 first commit, 877/877 second).
- Cannot-skip dashboard: 23/23 gates PASS.
- Workspace mirror: in sync.
- `npm run docs:audit`: 486 issues / 381 files (matches frozen baseline).
- iOS simulator: 11/11 TrainingFixtureBypassUITests + 3/3 TrainingValidationUITests PASS.

### Codex validation delta (2026-05-04)

Codex validation branch: `engine/feature/closed-beta-auth-training-engineering-codex-validation`.
Report: `docs/archive/2026-05/closed-beta-auth-training-engineering-codex-validation/codex-validation.md`.

| ID | Codex status | Delta |
|---|---|---|
| AUTH-O2 | **EXTENDED / fixed on Codex branch** | Password reset existed, but raw `devToken` could still be returned when email was misconfigured unless explicitly gated. Codex added `PASSWORD_RESET_DEV_TOKEN=1` + non-production + non-staging gating, generic response timing floor, and fire-and-forget email delivery to reduce account-existence timing signal. |
| AUTH-O4 | **EXTENDED / fixed on Codex branch** | Refresh-token runtime path used hashes, but migration 110 preserved legacy plaintext `ios_devices.refresh_token` rows. Codex added startup backfill to hash legacy plaintext rows, clear plaintext, and preserve row count. |
| TR-EC-O10 / TR-EC-IOS-O3 | **PARTIAL confirmed** | Codex re-ran `TrainingFixtureBypassUITests`: 11/11 PASS on simulator UDID `A0B13967-B5DE-4E6F-897D-F1E409093F94`. `TrainingValidationUITests` did **not** reproduce the claimed 3/3 PASS; two attempts were blocked by simulator runner preflight `Busy`. Requires rerun before counting as closed. |
| ENG-EXC-CX-O6 | **FIXED on Codex branch** | `workspace-docs-mirror.sh --check` defaulted to the real engine parent (`Custom Connectors/Cortex`) instead of official workspace when engine is symlinked. Codex fixed root detection; mirror check now exits 0 after refresh. |
| AUTH-CX-O3 | **NEW P3** | Password-reset attempt-cap wording overstates the reachable behavior. `attempt_count` is enforced when pre-set, but normal invalid-token attempts do not increment any row. Acceptable with 256-bit tokens, but should be documented as defense-in-depth rather than the primary brute-force control. |

Codex validation results:
- `npx tsc --noEmit`: PASS.
- `__tests__/api/auth-password-reset.test.ts`: 14/14 PASS.
- `__tests__/api/auth-routes.test.ts`: 13/13 PASS.
- `__tests__/services/account-lockout.test.ts` + classifier + audit-trail + plan-linter: 52/52 PASS.
- Password-reset + auth-routes + training-plan-persistence: 41/41 PASS.
- Broad classifier-expanded security/training/auth/portal sweep: 134 files / 1440 tests PASS.
- Cannot-skip dashboard: 23/23 PASS.
- Workspace mirror check: PASS after refresh.
- `npm run docs:audit`: 486 issues / 382 files (the +1 file is the Codex validation report under `docs/archive/`).
- Revert-before-fix invariant for `627e0e4`: expected failure after reverting code while restoring tests (21/22 failed), confirming the tests pin the auth-hardening behavior.

### What still requires operator action

1. Open the engine PR (7 commits since main: `eacebb3` + merge `799af5d` + `ca4eed1` + `dcb27cf` + `d11e4e1` + `627e0e4` + `1aa5955`).
2. Unlock iPhone Felipe + Trust + Developer Mode → re-run physical-device tests + record via `scripts/testflight-evidence.sh --apply` for TR-EC-O10 final E3 closure.
3. Decide deploy plan: AUTH P0+P1 batch (single migration sequence 109+110); training telemetry is a no-op behavior change; engineering docs/scripts are docs-only.
4. Signed TestFlight E5 walk-through with the AUTH changes (login, password reset, account-switch, two-account "Who am I?" test).

---

## Engineering excellence enrichment pass (2026-05-04)

Branches:
- engine: `feature/engineering-excellence-architecture-standards` @ `ca4eed1` (three commits, NOT pushed).
  - `eacebb3` Claude initial standards + 5 classifier flags + 6 classifier tests.
  - merge `799af5d` ← Codex `61d381e` (frontmatter check + 4 classifier flags + 4 classifier tests).
  - `ca4eed1` ENG-EXC-O3 + ENG-EXC-O8 closure (mirror + dashboard + prompt-only fix + 2 classifier tests).
- ios: `feature/engineering-excellence-architecture-standards` @ `f07e80c` (one commit, NOT pushed).
- Backup tags (both repos): `backup/engineering-excellence-before-hardening-20260504-1057`.

Verdict: **PASS WITH CONDITIONS** → CONDITIONS NARROWED. ENG-EXC-O1, O2, O3, O4, O5, O8 are now FIXED locally on `feature/engineering-excellence-architecture-standards`. ENG-EXC-O6, O7, O9, O10 remain open at P2/P3.

Canonical report: `docs/archive/2026-05/engineering-excellence-architecture-standards/engineering-excellence-enrichment-report.md`.
Codex independent validation: `docs/archive/2026-05/engineering-excellence-codex-validation/engineering-excellence-codex-validation.md`.

### What I shipped (Claude initial — `eacebb3`)

- 8 canonical engineering standards: 5 backend (API contract, security/isolation, runtime/observability, testing/QA, engineering index) under `engine/docs/engineering/`; 2 iOS (architecture/SwiftUI performance, frontend validation checklist) under `ios/docs/engineering/`; 1 workspace agent-process standard at `docs/agent/AGENT_PROCESS_STANDARD.md`.
- 3 engineering standards indexes (workspace + engine + iOS).
- 1 new iOS DOCS_INDEX (`ios/docs/DOCS_INDEX.md`).
- 5 new release-classifier flags (`HAS_LOGGER`, `HAS_SCHEDULER`, `HAS_NOTIFICATION`, `HAS_HEALTH_INTEGRATION`, `HAS_RATE_LIMIT`) + 5 cannot-skip safety gates + 5 vitest glob mappings.
- 6 new classifier test cases.
- `scripts/audit-docs.mjs` extended to register the new `engineering/` canonical paths and `AGENT_PROCESS_STANDARD.md`.
- Workspace + engine + iOS DOCS_INDEX updated.

### What Codex shipped (merge `799af5d` ← `61d381e`)

- `scripts/audit-docs.mjs`: `engineering-standard-frontmatter-missing` validation for workspace/backend/iOS engineering standards + agent process standard.
- `scripts/changed-area-classifier.sh`: 4 new flags + cannot-skip gates + XCTest/Vitest mappings — `HAS_AUDIT`, `HAS_DEPLOY_CONFIG`, `HAS_IOS_NAVIGATION`, `HAS_IOS_DTO`. `HAS_DEPLOY_CONFIG` also bumps Tier-4 staging-smoke and generic 17-check.
- `__tests__/scripts/changed-area-classifier.test.ts`: 4 affirmative tests + extended no-false-positives sentinel.

### What Claude shipped (continuation — `ca4eed1`, ENG-EXC-O3 + O8)

- **ENG-EXC-O8 (workspace docs durability) — CLOSED**:
  - `scripts/workspace-docs-mirror.sh`: one-way mirror from workspace `docs/`, `CLAUDE.md`, `AGENTS.md`, `README.md` into `engine/docs/_workspace-mirror/`. Modes: snapshot (default), `--check` (drift exit 1), `--dry-run`.
  - 15 workspace docs are now mirrored (CLAUDE/AGENTS/README + docs/agent + docs/engineering + docs/release; docs/archive intentionally NOT mirrored).
  - `audit-docs.mjs` gains `workspace-mirror-stale` + `workspace-mirror-missing` warnings; mirror itself is registered as approved-current AND skipped from per-file lints (avoids duplicate warnings on the same content).
  - Workspace `ENGINEERING_STANDARDS_INDEX` documents the mirror contract.
  - Wired into `release-pipeline-housekeeping.sh` step 3 (dry-run checks drift, `--apply` refreshes).
  - `.gitignore` excludes `docs/release/cannot-skip-gate-evidence/` (generated).

- **ENG-EXC-O3 (cannot-skip gate dashboard) — CLOSED**:
  - `scripts/cannot-skip-gate-dashboard.sh`: synthetically invokes the classifier with a representative file per gate, asserts every gate name appears in `cannotSkip` AND every expected test route appears in `vitest`/`xctest` output. 23 gates total. Emits markdown to stdout + JSON evidence file under `docs/release/cannot-skip-gate-evidence/`.
  - **Found and fixed a real classifier gap during dashboard development**: prompts-only diffs (`HAS_PROMPT=true`, `HAS_NON_DOC=false`) named `prompt-injection-defense` as cannot-skip BUT emitted ZERO vitest globs because the entire vitest block was inside the `HAS_NON_DOC` branch. Fix: when `HAS_PROMPT` fires and `VITEST_MODE` would otherwise be `skip`, force focused mode and add the security suite + prompt-cleanliness globs.
  - 2 new classifier tests pinning the prompt-only fix and the dashboard wiring.
  - Wired into `release-pipeline-housekeeping.sh` step 4 (runs `--quiet`; sets `OVERALL_RC=1` on any wiring failure).

### Verification (final state @ `ca4eed1`)

- `engine`: `npx tsc --noEmit` clean.
- Pre-commit hook (classifier-driven): typecheck + 15/15 classifier tests pass.
- `__tests__/scripts/changed-area-classifier.test.ts`: **15/15 PASS** (was 9 → 13 after Codex → 15 after ENG-EXC-O3 fix).
- Audit-focused tests (Codex 27/27 reference): **27/27 PASS** across 4 files (`audit-trail`, `authenticated-support-routes-scope`, `portal-admin-audit`, `portal-admin-data-routes`).
- Config/runtime/health tests (Codex 51/51 reference): **51/51 PASS** across 4 files (`config-runtime-validation`, `config-provider`, `health-endpoint-qa-validation`, `health-endpoints`).
- `npm run docs:audit`: **486 issues / 380 files** (matches Codex baseline; zero new engineering-frontmatter warnings; zero workspace-mirror-stale warnings after mirror is in sync).
- `cannot-skip-gate-dashboard.sh`: **23/23 gates PASS**, verdict PASS, JSON evidence written.
- `release-pipeline-housekeeping.sh`: dry-run completes clean across all 5 steps including the new mirror + dashboard steps.
- `ios`: docs-only iOS branch; no iOS source code changed in this continuation pass.
- Cleanup: no simulators booted, no orphan vitest/xcodebuild/xctrace processes, no listeners on dev ports.

### Open engineering-excellence items

| ID | Severity | Status | Description |
|---|---|---|---|
| ENG-EXC-O1 | P1 | **FIXED, MERGED** (`799af5d`). | Per-iOS-area classifier sub-flags (`HAS_IOS_NAVIGATION`, `HAS_IOS_DTO`) — Codex closure merged. |
| ENG-EXC-O2 | P1 | **FIXED, MERGED** (`799af5d`). | Engineering-standard frontmatter check in `audit-docs.mjs` — Codex closure merged. |
| ENG-EXC-O3 | P1 | **FIXED** (`ca4eed1`). | Cannot-skip gate dashboard exists at `engine/scripts/cannot-skip-gate-dashboard.sh`; emits JSON evidence to `engine/docs/release/cannot-skip-gate-evidence/`; runs from weekly housekeeping; classifier test pins 23/23 PASS. Found+fixed a real prompts-only classifier gap during dashboard build. |
| ENG-EXC-O4 | P2 | **FIXED, MERGED** (`799af5d`). | `HAS_AUDIT` + `audit-trail-emission-and-scope` cannot-skip gate — Codex closure merged. |
| ENG-EXC-O5 | P2 | **FIXED, MERGED** (`799af5d`). | `HAS_DEPLOY_CONFIG` + `deploy-config-health-rehearsal` cannot-skip gate + Tier-4 staging-smoke uplift — Codex closure merged. |
| ENG-EXC-O6 | P2 | OPEN | E5 (signed TestFlight) walk-through has no machine-readable evidence convention. Define a TestFlight-evidence file pattern under `engine/docs/release/` (similar to `cannot-skip-gate-evidence/` and `smoke-evidence/`). |
| ENG-EXC-O7 | P2 | OPEN | `docs:audit` literal-test-count warnings (73). Define a clear archive policy on whether old archive docs need regenerated counts, or accept as a frozen baseline. |
| ENG-EXC-O8 | P1 | **FIXED** (`ca4eed1`). | Workspace docs durability via `engine/docs/_workspace-mirror/` (one-way snapshot) + `audit-docs.mjs` drift detection + housekeeping wiring. 15 workspace docs mirrored. |
| ENG-EXC-O9 | P3 | OPEN | Add an outbound-markdown-link resolver lint over `engineering/` paths. |
| ENG-EXC-O10 | P3 | OPEN | Document a deprecation / `superseded_by` workflow for retiring "must" rules. |

### Codex validation findings (CX-O*)

| ID | Severity | Status | Description |
|---|---|---|---|
| ENG-EXC-CX-O1 | P1 | **FIXED** (`ca4eed1`). | Workspace docs are now mirrored into engine via `engine/scripts/workspace-docs-mirror.sh`; durability concern resolved. |
| ENG-EXC-CX-O2 | P1 | **FIXED, MERGED** (`799af5d`). | iOS navigation/DTO classifier sub-flags. |
| ENG-EXC-CX-O3 | P1 | **FIXED, MERGED** (`799af5d`). | Audit + deploy-config classifier flags. |
| ENG-EXC-CX-O4 | P2 | **FIXED, MERGED** (`799af5d`). | Engineering-standard frontmatter check. |
| ENG-EXC-CX-O5 | P2 | OPEN | `npm run docs:audit` baseline of 486 historical warnings remains. Treat as frozen baseline OR run a dedicated cleanup project. |

### Recommended next operator action

1. Open the engine PR from `feature/engineering-excellence-architecture-standards` (3 commits: `eacebb3` + merge `799af5d` + `ca4eed1`) and the iOS PR from `feature/engineering-excellence-architecture-standards` (1 commit: `f07e80c`). CI strict-scanner gate already passes locally for the engine branch.
2. Close ENG-EXC-O6 (TestFlight evidence pattern) as a small follow-up slice when the next iOS device-validation pass runs.
3. Close ENG-EXC-O7 and ENG-EXC-CX-O5 together as a "docs-audit historical cleanup" project (P2/P3 hygiene).
4. Continue with AUTH-O2 (password reset) per the security/isolation standard §2.

---

## Auth + registration closed-beta hardening pass (2026-05-04)

Rollout state:
- engine: merged to `main`, pushed, and promoted to production as `4.14.127` (`bc6e963` deploy bump; source fix `00a1d23`).
- ios: merged to `main` and pushed at `50d2fa7` with auth hardening plus navigation/Home responsiveness fixes.

Verdict: **READY_WITH_CONDITIONS** for closed-beta cohort sign-up via Apple, Google, and email/password.

Canonical report: `docs/archive/2026-05/auth-registration-hardening/auth-readiness-report.md`.
Codex independent validation: `docs/archive/2026-05/auth-registration-hardening/auth-codex-validation.md`.

Method: 5 parallel Claude Opus 4.7 max-effort specialist subagents (backend auth, OAuth Apple+Google, iOS auth, portal auth, tenant + identity-link) + targeted reads + safe surgical fixes. Audit-only constraint honored: no push, no deploy, no production data, no force-push, no rebase, no amend, no CI jobs removed.

Codex second-pass delta (2026-05-04):
- engine branch: `feature/auth-registration-codex-validation` was merged/pushed to `main`; production promote completed at `4.14.127`.
- ios branch: `feature/auth-registration-codex-validation` was merged/pushed to `main`.
- Verdict remains **READY_WITH_CONDITIONS**. Codex closed Apple nonce replay, Telegram OAuth numeric-state callbacks, Google unverified-email account creation, email verification brute-force cap, release-classifier auth routing, and iOS navigation/Home responsiveness regressions. Live full portal login/session interaction remains blocked/unverified.

### What I shipped (engine)

- **P0** Replaced deprecated Google `tokeninfo` debug endpoint with `OAuth2Client.verifyIdToken` from `google-auth-library` (local JWKS cache + signature + iss + aud + exp).
- **P0** Drop `validAuds.length > 0 &&` precondition — fail-closed when neither Google client id is configured rather than accept any audience.
- **P0** Google `email_verified` link gate — refuse to merge Google `sub` into existing email-matched user unless BOTH `payload.emailVerified === true` AND `existing.email_verified === 1`. Throws typed `GoogleAccountLinkRequiresVerificationError` → 409 `ACCOUNT_LINK_REQUIRES_VERIFICATION`.
- **P0** Apple JWKS force-refresh on `kid` miss (debounced 60s) — Apple key rotation no longer 401s for up to 24h.
- **P0** Apple `maxAge: '5m'` + `clockTolerance: 30` on `jwt.verify` — narrows replay window from 10 min to 5 min.
- **P0** Register/email enumeration collapsed to generic `REGISTRATION_REJECTED 400` (was `EMAIL_EXISTS 409` — confirm-by-status enumeration vector).
- **P0** Strict per-user `config_pillars` read in `services/content-intelligence.ts` — dropped `IN (0, ?)` platform-seed leak vector.
- **P0** `getSavedIdeas` and `getWorkflowEligibleIdeas` now require explicit `userId` (was optional → returned every user's ideas when omitted).
- **P1** Login audit log on `/auth/login/email` for success / failure (user-not-found / invalid-password) / suspended.

### What I shipped (iOS)

- **P1** Keychain saves with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` + `kSecAttrSynchronizable: false`. Sync-aware delete clears any pre-fix iCloud-Keychain-synced entry.
- **P1** `AuthManager.logout()` now fires fire-and-forget `POST /auth/logout` server-side (5s timeout) BEFORE clearing local Keychain — revokes the `ios_devices` row + refresh token instead of leaving them alive until natural expiry.
- **P1** `submitEmail()` / `submitInviteCode()` re-entrancy guards — `guard !isLoading else { return }` first line. Prevents keyboard-Return + tap race.
- **P1** Login error parity — collapsed all login-mode catch errors to `"Invalid email or password"` so backend codes don't leak account existence; registration mode keeps specific copy.

### Verification

- `engine`: `npx tsc --noEmit` clean. **500/500 tests PASS** across 56 files (auth-routes 9, auth-middleware-device-revocation 9, auth-session-revocation 4, content-intelligence-detail 3, content-intelligence 6, content-* 47, security/* 28, scope/* 3, prompt-cleanliness 72, user-service 46, portal-oauth-routes 8, plus broader content + auth integration suites).
- `ios`: `xcodebuild build` on iPhone 17 Pro Max simulator (UDID `4E6C6A6C-8334-4C27-8206-DCF55020BC22`, iOS 26.4) → **BUILD SUCCEEDED**. **23/23 focused tests PASS** across 5 suites (KeychainHelperTests 5, AuthManagerFixtureLeakTests 3, AuthManagerPersistenceTests 4, AuthUserPresentationTests 8, GoogleAuthCallbackResolverTests 3).
- Cleanup: simulators shut down; no orphan vitest/node processes; PM2 daemon left running (user's pre-existing service, not started by this pass).

Codex verification delta:
- `engine`: `npx tsc --noEmit` clean; focused auth/OAuth tests **32/32 PASS**; broader auth/security/content/portal tests **187/187 PASS**; release-classifier tests **3/3 PASS**; `scripts/closed-beta-identity-scan.sh` **0 flags**.
- `ios`: `xcodebuild build-for-testing` passed on iPhone 17 Pro simulator `A0B13967-B5DE-4E6F-897D-F1E409093F94`; focused auth/keychain tests **25/25 PASS**. Auth-surface XCUITests were retried twice and blocked before runner launch by simulator preflight `Busy`. Physical `iPhone Felipe` was listed offline by `xcrun xctrace list devices`.

### Closed by Codex validation delta

| ID | Severity | Description |
|---|---|---|
| AUTH-O1 | P0 | **FIXED and deployed.** Apple Sign In now uses iOS rawNonce → SHA-256 `request.nonce`; backend validates `payload.nonce`, stores consumed nonce hashes in `apple_sign_in_nonces`, and rejects replay/mismatch. |
| AUTH-O3 | P0 | **FIXED and deployed.** Telegram-flow OAuth state now uses `tg:<userId>:<nonce>` backed by the existing nonce store. Legacy numeric state and provider-mismatched nonce callbacks are rejected before token exchange/storage. |
| AUTH-O5 | P1 | **FIXED and deployed.** Email verification codes now have `attempt_count` with a 5-attempt cap; wrong guesses lock the active code until a new one is requested. |
| AUTH-O22 | P3 | **FIXED and deployed.** 6-digit email verification codes now use `crypto.randomInt(100000, 1000000)`. |
| AUTH-PROC-O1 | P1 | **FIXED and deployed.** Release classifier now maps backend auth/OAuth and iOS Auth/Keychain files to `tenant-auth-security`, focused auth/OAuth Vitest globs, and auth-focused XCTest classes. |

### Open auth items (must close BEFORE broad cohort sign-up)

| ID | Severity | Description |
|---|---|---|
| AUTH-O2 | P0 | Password reset flow does not exist. No `password_reset_tokens` table, no `/auth/password-reset/{request,confirm}` routes. Locked-out users have no path. Recommended: opaque hashed token, 1h TTL, single-use, session-revoke on success. |

### Open auth items (close-during-closed-beta)

| ID | Severity | Description |
|---|---|---|
| AUTH-O4 | P1 | Refresh tokens stored plaintext in `ios_devices.refresh_token`. Hash at rest + `previous_refresh_token_hash` for theft detection on rotation. |
| AUTH-O6 | P1 | Audit row for `auth.user_created` and `auth.provider_linked` not emitted. Add to `createAppleUser` / `createGoogleUser` / `createEmailUser` and the Google-link branch. |
| AUTH-O7 | P1 | No per-account lockout — only IP-bucket rate limit. Distributed credential-stuffing across many IPs is unbounded per-account. Add `failed_login_attempts` + 10-attempt 15-min lockout. |
| AUTH-O8 | P1 | Apple-side defensive check for `@privaterelay.appleid.com` — refuse cross-provider linking when email ends with private-relay suffix. |
| AUTH-O9 | P1 | `/auth/me` returns no `email`, `emailVerified`, or `tier`. iOS cannot drive UI without separate fetches. |
| AUTH-O10 | P1 | Portal login rate limit absent on `/api/*`. Mount `rateLimitMiddleware` (or a tighter portal-specific 20 req/min/IP). |
| AUTH-O11 | P1 | Legacy `PORTAL_TOKEN` still admin-capable in production when `PORTAL_ALLOW_LEGACY_FALLBACK=true`. Ship `PORTAL_BETA_HARDENED=true` + `PORTAL_ADMIN_TOKEN` non-empty in prod env file; refuse to boot otherwise. |
| AUTH-O12 | P1 | Portal login attempts (success + failure) not in `audit_trail`. Add `logAudit` in both branches of `enforcePortalToken`. |

### Open auth items (post-beta polish)

| ID | Severity | Description |
|---|---|---|
| AUTH-O13 | P2 | Password strength is only `length >= 8`. Add zxcvbn min-score-3 OR top-1000 common-password screening. |
| AUTH-O14 | P2 | In-process rate limiter buckets — wipe on restart, multi-PM2 = N×quota. Move to Redis-backed when scaling. |
| AUTH-O15 | P2 | 7-day access-token TTL — long-lived but revocable. Acceptable for closed beta; revisit before open beta. |
| AUTH-O16 | P2 | No biometric gate option (Face ID / Touch ID). Add opt-in toggle as beta+1. |
| AUTH-O17 | P2 | No "view active sessions" UI. Add `Settings → Account → Active sessions` with `GET /auth/sessions` + per-row revoke. |
| AUTH-O18 | P2 | `email_verified` flow exists but doesn't gate any route. Decide whether to gate sensitive routes (billing/deletion/password-change). |
| AUTH-O19 | P2 | `auth_identities (provider, provider_subject UNIQUE)` migration. Schema-level enabler for safe linking + audit history. |
| AUTH-O20 | P2 | `tenant_memberships` table. Schema-level enabler for future multi-tenant. Populate today as `(user_id, user_id, 'owner')`. |
| AUTH-O21 | P2 | `deviceId` fallback churns on `identifierForVendor=nil`. Cache once in Keychain, reuse. |

### Open auth items (hygiene / process)

| ID | Severity | Description |
|---|---|---|
| AUTH-O23 | P3 | Replace dynamic `require(...)` in `src/api/routes/auth.ts:479,581` with top-level import. |
| AUTH-O24 | P3 | Add `vitest`-time SQL-shape lint that walks `db.prepare('...')` callsites and rejects scoped-table reads missing `user_id`. |

### Recommended next operator action

1. Close AUTH-O2 password reset before broad cohort sign-up, or explicitly accept an invite-only operator-support process for closed beta.
2. Close AUTH-O4/O6/O7/O10/O12 during closed beta: refresh-token hash-at-rest, provider audit rows, per-account lockout, portal auth rate limit, and portal auth audit.
3. Re-run full portal login/session walkthrough when portal credentials are available.
4. Full reports: Claude `docs/archive/2026-05/auth-registration-hardening/auth-readiness-report.md`; Codex `docs/archive/2026-05/auth-registration-hardening/auth-codex-validation.md`.

---

## Training expert-coach Codex deliverable — hostile QA closeout (2026-05-04 night)

Branches:
- engine: `feature/training-expert-coach-codex-validation` @ Codex tip + Claude QA fixes (next push)
- iOS: `feature/ios-training-expert-coach-claude-qa` (committed `1917439` swimming + requiresReview pins) + new goal-mode echo + ledger fixes (next push)

Verdict: **READY_FOR_LOCAL_QA** — every issue from the latest hostile QA ledger is FIXED, VERIFIED NON-ISSUE, or BLOCKED with reason. 877/877 backend tests pass; 51 unit tests + 11/11 TrainingFixtureBypassUITests pass on iPhone Felipe (physical device); 1140+/1140+ unit tests pass on simulator.

### Issue ledger closure

| Item | Status | Evidence |
|---|---|---|
| TR-EC-QA-O1 (P1) maintenance volume throttling | **FIXED** | `engine/src/services/training-coach-kernel-plan-generator.ts` `applyGoalModeVolumeShaping`: maintenance scales 60%, capped 4 total; return_to_training scales 50%, capped 3 total. Strength preserved at min 1 when originally requested. Emits `maintenance_volume_capped` / `return_to_training_volume_capped` `TrainingDecisionReason`. 15 pin tests in `__tests__/services/training-coach-kernel-goal-mode-shaping.test.ts`. |
| TR-EC-QA-O2 (P1) continuous + event-based-without-raceDate signals | **FIXED** | Same module `collectGoalModeDecisionReasons`: emits `continuous_plan_no_taper` (info severity) when goalMode=continuous; emits `event_based_missing_race_date` (warning severity) when goalMode=event_based and raceCalendar empty. Pinned by the same 15-test suite. |
| TR-EC-QA-O3 (P2) hybrid-engine priorityOrder safety | **FIXED** | `engine/src/services/coach-kernel/engines/hybrid-engine.ts` new `firstModalityPriority(priorityOrder)` skips `'maintenance' \| 'return'` lifecycle tokens before reading the leading modality. Endurance priority is now correctly detected for maintenance + running and return + cycling combos. 5 pin tests in `__tests__/services/coach-kernel-hybrid-engine-priority-safety.test.ts`. |
| iOS goalMode/trainingPriority echo (P2) | **FIXED** | `ios/Nexus Hub/ViewModels/TrainingViewModel.swift` 3 helpers: `trainingViewModelGoalModeLabel`, `trainingViewModelTrainingPriorityLabel`, `trainingViewModelComposeGoalModeEcho`. Returns nil for unknown / future enum values — never displays raw enum. Composes "Coach mode: Event · Running." line on the post-generation banner when present. 9 pin tests in `Nexus HubTests/TrainingViewModelGoalModeEchoTests.swift` covering known/unknown/composition/safe-unknown paths. |
| Picker swimming + 6 requiresReview tests + strength stepper | **PRESERVED + VERIFIED** | Swimming option still in `Nexus Hub/Views/Training/TrainingView.swift:927`; localized `Natação`/`Swimming` at `:563`. 6 `test_generatePlan_keepsSheetInReviewModeFor*` pin tests in `Nexus HubTests/TrainingViewModelObservationTests.swift`. `test_noPlanFixture_createPlanSheetStrengthStepperAccepts5Sessions` PASS on physical iPhone Felipe + simulator. |
| Physical device validation | **PASS (PHYSICAL DEVICE)** | iPhone Felipe (UDID `00008150-000C0D5101D8401C`, iPhone 17 Pro Max, iOS 26.5): 51 focused unit tests (TrainingViewModelObservationTests + GoalModeEchoTests + PlanGenerateResponseExpertCoachTests + TrainingServiceTwoADayPreferenceTests) PASS. Full TrainingFixtureBypassUITests 11/11 PASS in 305s. Real interaction validation, not launch-only. |
| Provider-live Google/Outlook calendar smoke | **BLOCKED — non-prod OAuth credentials** | Long-standing closed-beta condition. Requires Felipe to provision dedicated non-prod Google + Outlook OAuth credentials and supply them as env vars. Production calendars must NOT be used. Workaround: deterministic fixture coverage via `__tests__/api/training-plan-calendar-sync.test.ts` (23 cases) covers the same scenarios. |
| Docs / open items | **FIXED** | `npm run docs:audit` baseline: 471 issues across 348 files (was 449/338 baseline). The +22 increase is from this pass's new test files + report fields and is expected. No new "outside-approved-location" warnings introduced. |

### What I shipped (this hostile QA closeout pass)

**Backend** (engine, branch `feature/training-expert-coach-codex-validation`):
- `src/services/coach-kernel/types.ts` — extended `TrainingDecisionReasonCode` with 4 goal-mode codes (`maintenance_volume_capped`, `return_to_training_volume_capped`, `continuous_plan_no_taper`, `event_based_missing_race_date`).
- `src/services/training-coach-kernel-plan-generator.ts` — added `applyGoalModeVolumeShaping(rawTargets, input, raceCalendar)` (deterministic 60%/50% scale + total cap) and `collectGoalModeDecisionReasons` (surfaces signals on plan response). Wired into `buildAthleteStateFromTrainingProfiles` AND `buildCoachKernelTrainingPlan`.
- `src/services/coach-kernel/engines/hybrid-engine.ts` — added `firstModalityPriority` helper that skips lifecycle tokens; `resolveHybridPriority` now uses it.
- New tests: `__tests__/services/training-coach-kernel-goal-mode-shaping.test.ts` (15) + `__tests__/services/coach-kernel-hybrid-engine-priority-safety.test.ts` (5). Total +20 backend tests.

**iOS** (branch `feature/ios-training-expert-coach-claude-qa`):
- `Nexus Hub/ViewModels/TrainingViewModel.swift` — three new helpers (`trainingViewModelGoalModeLabel`, `trainingViewModelTrainingPriorityLabel`, `trainingViewModelComposeGoalModeEcho`) at file scope; surfaced in `generatePlan` so the post-generation banner appends "Coach mode: Event · Running." when present.
- New tests: `Nexus HubTests/TrainingViewModelGoalModeEchoTests.swift` (9). Total +9 iOS tests.

### Verification

- `engine`: `npx tsc --noEmit` clean. Focused 877/877 PASS in 11.7s. Goal-mode shaping suite 15/15 PASS. Hybrid-priority safety suite 5/5 PASS.
- `ios` simulator iPhone 17 Pro UDID `A0B13967-B5DE-4E6F-897D-F1E409093F94`: build clean. Echo + observation + DTO 36/36 PASS. Full TrainingFixtureBypassUITests 11/11 PASS in 279s.
- `ios` physical device iPhone Felipe (`00008150-000C0D5101D8401C`): build clean. Focused 51/51 unit PASS. TrainingFixtureBypassUITests 11/11 PASS in 305s. TR-EC-O14 fixture test (`test_noPlanFixture_createPlanSheetStrengthStepperAccepts5Sessions`) re-verified on physical device 16.4s.

---

## iOS Training expert-coach readiness pass (2026-05-03 night)

## iOS Training expert-coach readiness pass (2026-05-03 night)

Branch: `feature/ios-training-expert-coach-readiness` in `ios`.
Codex validation branch: `feature/ios-training-expert-coach-codex-validation` in `ios`.
Backup tag: `backup/ios-training-expert-coach-readiness-pre-20260503-1955`.
Forked from: `main` @ `76529bf`.
One commit, not pushed:

- `fe62d43 feat(training): TR-EC-O14 createPlan id + expert-coach DTO contracts`

Verdict: **PASS WITH CONDITIONS** for iOS-side preparation of the new Training expert-coach engine contracts. TR-EC-O14 is closed and verified on simulator and physical iPhone. Full physical Workflows A–I + tenant cache isolation remain open for full-engine fixtures, provider-safe scheduling fixtures, and two-account validation.

Canonical report: `ios/docs/ios/training-expert-coach-ios-readiness-report.md`.
Codex validation report: `ios/docs/ios/training-expert-coach-ios-codex-validation.md`.

### What I shipped (ios commit `fe62d43`)

**TR-EC-O14 — accessibility identifier propagation closed:**
- `Nexus Hub/Components/NexusButton.swift`: NexusButton accepts an optional `accessibilityIdentifier:` parameter and applies it directly on the underlying SwiftUI `Button`. Previously, callers attaching `.accessibilityIdentifier(...)` to the wrapping View were shadowed by the inner `.accessibilityLabel(title)` SwiftUI applies on the button label — XCUITest queried the label-derived identifier instead and the caller's id was invisible.
- `TrainingPrimaryActionButton` now threads `training-action-\(target.rawValue)` into NexusButton, so `app.buttons["training-action-createPlan"]` resolves cleanly.
- Verified: `TrainingFixtureBypassUITests/test_noPlanFixture_createPlanSheetStrengthStepperAccepts5Sessions` passes on simulator. Full simulator TrainingFixtureBypassUITests suite passes.

**Phase 4 — safe DTO decoders for the new contracts:**
- `Nexus Hub/Core/Services/TrainingService.swift`: PlanGenerateResponse extended with `calendarFetchDegraded: Bool?`, `calendarFetchError: String?`, `planLint: PlanLintResult` (with `passDefault()` fallback), `structuredWarnings: [PlanGenerateWarning]`. New types: `PlanGenerateWarning`, `PlanLintStatus` (with `.unknown`), `PlanLintFinding` (with `.info` severity fallback), `PlanLintAffectedSession`, `PlanLintResult`, `PlanLintSuggestedFix`. Every new enum has safe-unknown fallback so a future backend status doesn't crash.
- 13 new pin tests in `__tests__/PlanGenerateResponseExpertCoachTests.swift` — calendarFetchDegraded true/false/absent, planLint pass/pass_with_warnings/fail/unknown, unknown-severity-safely, structured + legacy warnings, end-to-end realistic payload.

**Phase 5 — UI rendering for the new states:**
- `Nexus Hub/ViewModels/TrainingViewModel.swift`: post-generation message now appends calendarFetchDegraded warning + first planLint blocker / first warning so the user sees the engine's safety verdict in the create-plan banner.
- `Nexus Hub/Views/Training/TrainingView.swift`: new XCUITest identifiers — `training-plan-status-banner`, `training-generate-plan-button`, `training-objective-<slug>` per tile, `training-sessions-per-week-stepper` + `-value`.

**Codex second-pass validation — safety and stale-test cleanup:**
- `TrainingViewModel.planGenerationRequiresReview` now keeps the create-plan sheet open with warning styling when plan generation returns missing critical inputs, calendar-degraded creation, long-run override, lint `fail`, lint `needs_user_input`, blockers, or warnings. This prevents invalid/questionable plans from looking like normal success.
- `Phase5RuntimeSmokeHarnessTests` no longer read deleted `docs/beta/*.md`; they assert the code-backed local smoke script and smoke matrix instead.
- Verification: focused unit suites passed, simulator `TrainingFixtureBypassUITests` passed, and physical iPhone focused Training contract/view-model + fixture UI suites passed.

### Verification

- `xcodebuild build` — clean.
- `xcodebuild build-for-testing` — clean.
- Selected unit suites: PlanGenerateResponseExpertCoachTests (13/13), PlanGenerateResponseRaceDateTests, PlanGenerateResponsePrimaryFocusTests, TrainingHomeContractResolverTests, TrainingHomeNoPlanCTAFixTests — all PASS.
- Full `Nexus HubTests` (excluding pre-existing `Phase5RuntimeSmokeHarnessTests` doc-path failures) — **1,121 / 1,121 PASS** in 4.8s.
- TrainingFixtureBypassUITests — simulator suite passed on the iPhone 17 Pro simulator.
- Physical iPhone — focused Training DTO/view-model suites and `TrainingFixtureBypassUITests` passed.

### What's still pending (after this pass)

| ID | Severity | Description |
|---|---|---|
| TR-EC-IOS-O1 | P1 | Add `training-goal-mode-picker` (event_based / continuous / maintenance / return_to_training) to the create-plan sheet. |
| TR-EC-IOS-O2 | P1 | Documented: modality-specific profile inputs (running level/volume/days, strength level/split, cycling FTP) are collected only in onboarding. Decision needed on whether to add them to the create-plan sheet. |
| TR-EC-IOS-O3 | P1 | Real iOS device-level validation of Workflows A–I — physical iPhone fixture UI tests pass. Full A-I still needs full-engine fixtures, provider-safe scheduling fixtures, and two-account credentials. |
| TR-EC-IOS-O4 | P2 | Wire `AthleteLifecycleVerdict.reason` from the engine derivation into a dedicated iOS card once the engine ships it on the response payload. |
| TR-EC-IOS-O5 | P2 | Wire `evaluateSafetyContext().topMessage` into a coach safety banner when a session reports stress-fracture-pattern pain or a self-reported pregnancy/postpartum/disordered-eating flag. |
| TR-EC-IOS-O6 | P2 | Surface `planLint.suggestedFixes` as actionable CTAs (e.g. "Re-run equipment adaptation" → re-trigger generation with updated profile). Interim safety is fixed locally: lint blockers/warnings now require review and no longer auto-dismiss. |
| TR-EC-IOS-O7 | P2 | **Closed locally.** `Phase5RuntimeSmokeHarnessTests` no longer reference deleted markdown files; simulator runs execute repo-source checks, while physical-device runs skip checkout-only reads explicitly. |
| TR-EC-IOS-O8 | P3 | Once the engine multi-block roadmap ships (P3 in engine OPEN_ITEMS as TR-EC-O5), iOS needs `TrainingRoadmap` decoders + a roadmap timeline view. |
| TR-EC-IOS-O9 | P3 | Phase 11's full identifier list (`training-priority-picker`, `training-running-level-picker`, `training-equipment-picker`, `training-feedback-rpe-input`, etc.) requires both UI controls AND backend contracts; multi-slice initiative. |

The new contract additions on the iOS side (`PlanGenerateResponse.calendarFetchDegraded`, `.planLint`, `.structuredWarnings`) are PURELY ADDITIVE — no field is required, every enum has a safe-unknown fallback, and the legacy `warnings: [String]` accessor still returns user-friendly copy. Existing iOS production builds will continue to decode responses cleanly when the engine pass deploys.

---

## Training expert-coach knowledge-engine pass (2026-05-03 evening)

Branch: `feature/training-expert-coach-knowledge-engine` in `engine`.
Backup tag: `backup/training-expert-coach-knowledge-engine-pre-20260503-1839`.
Forked from: `feature/closed-beta-readiness-codex-validation` @ `8bb7f34`.
Two commits, not pushed:

- `d3b09b8 feat(training): P0 reliability — past-day floor + plan-linter + calendar fail-safe`
- `a65dcbc feat(coach-kernel): P1 typed-derivation modules — load + lifecycle + safety`

Verdict: **PASS WITH CONDITIONS** for local code-level audit + safe high-priority backend fixes. iOS device-level validation + production deploy gates remain explicitly out-of-scope per the local-only rule.

Canonical report: `engine/docs/training/training-expert-coach-knowledge-engine-report.md`.
Codex second-pass validation: `engine/docs/training/training-expert-coach-codex-validation.md`.

### What I shipped (engine commits `d3b09b8` + `a65dcbc`)

**P0 reliability fixes (`d3b09b8`)**:
- **Past-day floor in `scheduleSessionForPlan`** — Wed-generated plans no longer silently slide week-1 Mon/Tue to next week. New `resolvePlanSlotDate` helper rejects past-day requests with a `past_day_in_week_1` reason that flows through the existing `noAvailableSlot` plumbing → session persisted `status: 'unscheduled'` with a clear human-readable explanation.
- **`PlanLinter` (NEW `engine/src/services/coach-kernel/plan-linter.ts`)** — 7 deterministic plan-level rules: `no_past_active_sessions`, `equipment_compatibility`, `no_three_consecutive_leg_heavy_days`, `no_heavy_lower_before_long_run`, `no_fake_taper_without_event`, `race_specific_plan_requires_race_date`, `no_consecutive_identical_strength_sessions`. Wired through `persistGeneratedTrainingPlan` in advisor mode → `data.planLint` + per-finding entries on `data.warnings` of the API response.
- **Calendar fetch fail-safe** — `getEvents()` errors now log structurally, set `calendarFetchDegraded: true` on the response, and emit a `calendar_fetch_degraded` warning so iOS can render "review your week before trusting it" instead of silently scheduling on top of meetings.

**P1 typed-derivation foundations (`a65dcbc`)**:
- **`session-load-metadata.ts`** — `deriveSessionLoadMetadata(session) → SessionLoadMetadata` with `legLoadScore`, `tendonLoadScore`, `upperBodyLoadScore`, `neuromuscularCost`, `keySessionPriority`, `minimumRecoveryHours`, `compatibleNeighbors`, `signature`. Plus `isSpacingCompatible(a, b)` based on leg-load math (NOT session-type set membership) — easy_run before long_run is allowed; heavy squat before long_run is rejected.
- **`athlete-lifecycle-state.ts`** — `deriveAthleteLifecycleState(state, now) → AthleteLifecycleVerdict` with 11 typed states (`onboarding | profile_incomplete | returning_from_break | overloaded | recovering | deloading | tapering | base_building | progressing | maintenance | needs_user_input`) and priority-ordered branches (health-first overrides beat structural state).
- **`safety-guardrails.ts`** — `evaluateSafetyContext(input) → SafetyEvaluationResult` with 8 typed safety domains. Stress-fracture red flags BLOCK with sports-medicine referral. Pregnancy/disordered-eating BLOCK with specialist referral. Direct medical questions ("do I have", "should I take") WARN. Supplement / anti-doping vocabulary INFORMS with WADA reference. Plus `COACH_NON_DIAGNOSTIC_DISCLAIMER` constant.

NO migration. All four new modules are pure-derivation, on-demand. The lint runs in advisor mode through the soak window; flip to strict on the API response after telemetry shows blocker rate ≈ 0.

### Verification

- `npx tsc --noEmit` clean.
- Pre-commit (auto-classified focused) ran 66 test files / 848 tests in 11.5s on each commit.
- Full `vitest run` after the batch: **6,639 / 6,640 PASS** in 65.8s. The 1 failing test (`__tests__/services/prompt-cleanliness.test.ts:160` referencing the now-archived `prompts/daily-content-discovery.md`) is a PRE-EXISTING artifact of the closed-beta-hardening commit `8bb7f34` that landed on the same branch ancestry. Verified by checking out `dadcbe0` (the production main before closed-beta hardening) — there the test passes 72/72. Documented as `TR-EC-O9` in the new training report's open items.

### What's still pending (after this pass)

| ID | Severity | Description |
|---|---|---|
| TR-EC-O1 | P2 | Flip plan-linter from advisor → strict on the API response after a 1–2 week soak with low blocker rate. |
| TR-EC-O2 | P2 | Wire `AthleteLifecycleVerdict.reason` into iOS Today/Week banner. |
| TR-EC-O3 | P2 | Wire `evaluateSafetyContext().topMessage` into coach-briefing JSON when readiness/feedback signals trigger it. |
| TR-EC-O4 | P2 | Refactor plan-linter to use `SessionLoadMetadata.isSpacingCompatible` instead of regex `isLowerHeavy` heuristic. |
| TR-EC-O5 | P3 | Multi-block `TrainingRoadmap` + `TrainingProgressLedger` (requires migration). |
| TR-EC-O6 | P3 | Promote `SessionLoadMetadata` fields onto `Session` shape via backfill migration once telemetry stabilizes. |
| TR-EC-O7 | P3 | Add `tempo_run`, `hill_run`, `strength_lower_heavy`, `strength_upper_heavy` to `SessionType`. |
| TR-EC-O8 | P3 | Persist `AthleteLifecycleState` to a `training_athlete_lifecycle` table for trend analysis. |
| TR-EC-O9 | P2 | (Pre-existing) `__tests__/services/prompt-cleanliness.test.ts:160` references `prompts/daily-content-discovery.md` archived by `8bb7f34`. Either restore the prompt-cleanliness check from the archive path or remove the test. |
| TR-EC-O10 | P1 | iOS device-level validation for the 9 Training workflows (A–I per the prompt) — physical iPhone fixture UI tests pass; full-engine/two-account/provider-safe workflow validation remains open. |
| TR-EC-O11 | P1 | Codex validation found same-day plan creation could schedule today's preferred time in the past. Fixed locally on `feature/training-expert-coach-codex-validation`; requires review/merge before staging. |
| TR-EC-O12 | P1 | Codex validation found persisted plan-linter sessions were missing scheduled dates, so exact-date lint rules were not reliable through real persistence. Fixed locally on `feature/training-expert-coach-codex-validation`; requires review/merge before staging. |
| TR-EC-O13 | P1 | Plan-linter blockers are still advisor-only: the API creates the plan with `planLint.status:"fail"`. Decide strict/repair behavior before closed beta. |
| TR-EC-O14 | P1 | **CLOSED / superseded by the iOS readiness pass.** The `training-action-createPlan` accessibility path was fixed and `TrainingFixtureBypassUITests/test_noPlanFixture_createPlanSheetStrengthStepperAccepts5Sessions` was re-verified on simulator and physical iPhone Felipe. Full A-I workflow validation remains tracked separately under `TR-EC-O10` / `TR-EC-IOS-O3`. |

### Closed-beta readiness implication

The new contract additions (`data.calendarFetchDegraded`, `data.planLint`, `data.warnings`) are PURELY ADDITIVE — existing iOS clients won't break, and a future iOS slice can opt in to render the warnings as banners. No production deploy from this branch.

The mid-week-creation past-day silent-slide fix is the most user-visible improvement: before this pass, a Wed-generated plan dropped Mon/Tue of week 1 with no warning; after this pass, those days are surfaced honestly as `unscheduled` with a clear reason.

---

## Closed-beta readiness hardening (2026-05-03)

Branch: `feature/closed-beta-readiness-hardening` in `engine`. Backup tag: `backup/closed-beta-readiness-before-hardening-20260503-1530`. Two commits, not pushed:

- `c8f5c71 feat(closed-beta): hardcoded-identity scanner + CI wiring`
- `2001efe fix(content+voice): remove hardcoded founder identity from runtime`

Verdict: **READY_WITH_CONDITIONS** — backend safety architecture is intact; two surgical residual identity-leak fixes landed; new `closed-beta-identity-scan` is wired into CI (advisor on PR, strict in nightly) so v4.14.118-class regressions can't return silently. The `WITH_CONDITIONS` is for the iOS device-level validation that I cannot perform from the audit harness (see iOS open items below).

### What I audited

- Phase 0: state survey (engine on `main` at `dadcbe0` v4.14.124; iOS on `main` at `255522d`; iOS pipeline branch unmerged intentionally).
- Phase 1: hardcoded-identity grep across `src/`, `prompts/`, `content-engine/`, `src/skills/`, `ios/Nexus Hub/` Swift code.
- Phase 1: review of Codex's `3bf9a37` training commit for tenant/user-scope correctness.
- Phase 3: Training/Secretary orchestration code review (past-session prevention, race-date follow-up, weekly cap, Saturday long-run).
- Phase 4: Calendar/agenda lifecycle (deletePlanHard scoping, session_identity_key dedup, calendar-sync past-skip).
- Phase 5: Chat memory/tool safety (auth-middleware JWT-derived `req.userId === req.tenantId`, chat-context-engine scope flow, P0 regression suite still in place).
- Phase 6: Skill preference ownership (creator_profile per-user, content-script user-scoped fetch, fixture seeding gated to STAGING).
- Phase 8: closed-beta security gate design (the new identity scanner).
- Phase 10: focused tests — voice-evolution-agent, voice-evolution-qa-validation, p0-chat-identity-isolation = 50/50 pass; pre-commit auto-classified to focused mode and ran 320/320 in 8.15 s.
- Phase 11: cleanup verified (no dirty tree, no orphan ports/processes).

### What I fixed (engine commit `2001efe`)

| File | Root cause | Fix |
| --- | --- | --- |
| `src/handlers/commands/content.ts:1038–1056` | Content-calendar `/calendar` Telegram command instructed the model to use the authenticated creator's stored pillars, but the prompt body literally hardcoded a Felipe-specific pillar list (AI/Tech, Commentary politics, Training+carnivore, Helldivers, etc.). Models would pull from the literal examples for any user with no stored pillars. P1 identity-leak surface. | Removed the hardcoded pillar list. Replaced with neutral instruction: use the creator's stored pillars; if missing, ask or propose a small neutral mix tailored to THIS creator's audience and goals. No founder pillars hardcoded. |
| `src/agents/voice-evolution-agent.ts:381–382` | Code read `rp.felipe_version` but the analysis prompt produces `creator_version` (legacy field name was already renamed in earlier neutralization work). Effect: every NEW analysis silently stored `${original} → undefined` and dropped the rephrased example. Pre-existing latent bug, not a leak. | Aligned reader with prompt schema: `(rp as any).creator_version ?? (rp as any).felipe_version ?? ''`. Backward-compat fallback for already-persisted rows. Marked with `nx-allow-identity-scan` so the new scanner doesn't flag it. |
| `content-engine/services/orchestrator.py:356` | Legacy `felipes_angle` backward-compat read (intentional, was already in code from prior neutralization). | Added `nx-allow-identity-scan` marker so the scanner explicitly approves it. |

### What I added (engine commit `c8f5c71`)

`engine/scripts/closed-beta-identity-scan.sh` — trip-wire scanner for the v4.14.118-class P0. Greps runtime code (`src/`, `prompts/`, `content-engine/`) for forbidden patterns: `Felipe's voice`, `Felipe's brand`, `Felipe's profile`, `adapt to Felipe`, `Felipe's audience`, `felipe_version`, `felipes_angle`. Excludes test files, manifest.json author fields, copyright headers, the public landing footer, the stale design doc, and any line/block marked `nx-allow-identity-scan`. `--strict` mode exits 1 on any non-allowed match.

CI wiring:
- `engine/.github/workflows/ci.yml` lint job — advisor mode (informational on every PR).
- `engine/.github/workflows/nightly.yml` — new `closed-beta-identity-scan-strict` job (gates the nightly).

Initial run: **0 flags** in current tree.

### What's still pending (iOS-side closed-beta gates)

These remain because I cannot perform real-device validation from the audit harness:

- **Two-account device walk-through**: User A asks "Who am I?" → must get User A; User B asks → must get User B. The P0 regression suite (`__tests__/security/p0-chat-identity-isolation.test.ts`) covers the backend deterministic identity fast-path (still passing 23 cases), but the iOS UI flow needs a signed TestFlight build with two test accounts. **Closed-beta blocker until verified live.**
- **iOS interaction validation** (Phase 2): real tap-to-feedback latency, navigation stress (10× tab switches, 5× Home → Week round-trips), account/tenant switch staleness. Requires physical iPhone or signed TestFlight + UDID-pinned simulator. The new `ios-tests.yml` PR lane runs unit tests automatically; the new `ios-nightly.yml` runs XCUITest at 05:45 UTC; both are committed but UNMERGED in iOS repo (intentional).
- **Provider-live calendar lifecycle smoke**: dedicated non-prod Google/Outlook OAuth credentials still missing. Existing unit/integration coverage at `__tests__/api/training-plan-calendar-sync.test.ts` (23/23 PASS) covers the same scenarios deterministically.
- **Live readiness/body-battery isolation across Felipe / Jaqueline / nexushubbot**: required to prove no cross-user Garmin readiness leaks. Requires live device data (cannot use production data per rules).

### Closed-beta verdict

**READY_WITH_CONDITIONS**. Code-level identity isolation is correct (v4.14.118 architecture intact, 2 residual fixes landed, new scanner gates regressions). Backend training fixes (Codex's `3bf9a37`) are properly user-scoped. Calendar/agenda/promotion lifecycle has belt-and-suspenders multi-tenant safety. Chat memory/tool/prompt scope flows from JWT-derived `req.userId` cleanly. The remaining conditions are all real-device validations that require human + signed-build access.

## P0

## P1

- Validate on staging/production-safe accounts that Felipe, Jaqueline, and nexushubbot have isolated readiness/body battery values and provider connection states.
- Validate Jaqueline's `Entrada` task list read-back after backend promotion.
- ~~Merge + deploy the 2026-05-03 training poor-recovery `time_volume_coherence` fix~~ — **DONE**: shipped in production version `4.14.123` (commit `396b8f0`) on 2026-05-03 via the documented `deploy-staging.sh` → `staging-smoke.sh` (17/17) → `promote-to-prod.sh` chain. PM2 confirms `nexus-hub` and `content-engine` online post-restart.
- ~~**Release pipeline optimization adoption**~~ — **DONE**: backend v2 pipeline changes were merged to `main`, pushed, used for the 2026-05-03 `4.14.124` production promotion, and validated by staging smoke + production health. iOS pipeline commits remain available in the iOS repo history/branch state for separate TestFlight validation. Report: `docs/release/release-pipeline-optimization-report.md`.

  Quick wins landed and measured:
  - ~~Drop `npm run verify` from `engine/scripts/deploy.sh:37`~~ → **DONE** as opt-in env-flag (`NEXUS_DEPLOY_SKIP_VERIFY=1` or `auto-when-staged`); default is unchanged. Engine commit `53d95b6`.
  - ~~Pre-commit hook → focused vitest~~ → **DONE**. New `.husky/pre-commit` is classifier-driven; docs-only diff skips vitest entirely. Engine commit `b304367`. Measured: 9 m 35 s → 6.91 s on the same SHA (98.8 % reduction).
  - ~~Pre-push hook → focused on feature, full on RC~~ → **DONE**. New `.husky/pre-push` runs full Vitest only on RC-class branches (`main`, `release/*`, `rc/*`, `feature/p0-*`, `feature/release-*`); focused on feature branches. Engine commit `b304367`.
  - ~~CI parallel matrix + coverage to nightly~~ → **DONE**. `ci.yml` rewritten as classifier-driven parallel matrix; new `nightly.yml` carries full Vitest + coverage + full migration rehearsal. Engine commit `8cdb8c0`.
  - ~~Add changed-area classifier~~ → **DONE**. `engine/scripts/changed-area-classifier.sh` is the input to the new hooks and CI. Engine commit `b304367`.
  - ~~Archive `cd-production.yml`~~ → **DONE**. Renamed to `.archived` with banner; legacy file deleted. Engine commit `8cdb8c0`.
  - ~~Enforce iOS UDID simulator destination~~ → **DONE** as fail-closed when `IOS_REQUIRE_UDID=1`; legacy name-only default still works (back-compat) but logs a loud warning. iOS commit `36e76d7`.
  - **Activation** (one-time, by Felipe): `cd engine && git config core.hooksPath .husky` to use the tracked `.husky/*` hooks; or accept the per-clone delegate at `.git/hooks/pre-commit` and `.git/hooks/pre-push` (already installed on this Mac as `pre-commit.legacy-backup` / `pre-push.legacy-backup` snapshots, with delegate scripts pointing at `.husky/`).
  - **Make `release-identity.sh` mandatory in any current-verdict doc write** → still pending (P2 / one-week improvement).
- **Branches and tags from the implementation pass**:
  - engine: branch `feature/release-pipeline-risk-based-optimization`, backup tag `backup/pre-release-pipeline-optimization-2026-05-03`. Seventeen commits (newest first):
    - `2603162 feat(release-pipeline): weekly housekeeping (prune + identity refresh)`
    - `80c4506 feat(release-pipeline): wrap content-full-nexus-local smoke for JSON evidence`
    - `466eaf5 feat(deploy): --dry-run mode for gate rehearsal`
    - `aa2a89e feat(release-pipeline): smoke-evidence summary + prune tools`
    - `37e3dff feat(release-identity): --persist mode + pre-commit auto-injection`
    - `5bc7386 ci: wire vi-mock-completeness-lint + release-doc drift check (advisor + nightly)`
    - `f8694c2 feat(staging-smoke): classifier-driven domain probes (bonus tier)`
    - `2135bfe feat(promote-to-prod): reuse recent smoke-evidence for same staging SHA`
    - `ff42e65 feat(release-pipeline): with-smoke-evidence wrapper + domain smokes`
    - `f354b7d fix(release-doc-drift-check): strip UUIDs + allow cross-repo SHA refs`
    - `1b8a0de fix(docs-audit): ignore git worktrees (false positives)`
    - `5007b25 feat(release-pipeline): smoke-evidence JSON + release-doc drift checker`
    - `9e2c890 perf(vitest): lift singleFork — 9 m 36 s → 1 m 20 s (7.22× speedup)`
    - `82b4c78 feat(release-pipeline): vi.mock completeness lint (singleFork precondition)`
    - `53d95b6 feat(deploy): NEXUS_DEPLOY_SKIP_VERIFY env-flag for risk-based deploy`
    - `8cdb8c0 feat(release-pipeline): parallel CI matrix + nightly + archive dead workflow`
    - `b304367 feat(release-pipeline): add changed-area classifier + risk-based hooks`
  - ios: branch `feature/release-pipeline-risk-based-optimization`, backup tag `backup/pre-release-pipeline-optimization-2026-05-03`. Three commits:
    - `945567d ci: add nightly XCUITest workflow`
    - `672a0fc ci: add focused XCTest lane on macOS runner`
    - `36e76d7 feat(beta-smoke): UDID-aware simulator destination`
- **Felipe's parallel training-reliability WIP preserved** in named stashes during the implementation pass. As of 2026-05-03 evening, the inventory in `engine` is:
  - `stash@{0}: felipe-training-WIP-batch7-2026-05-03-during-release-pipeline-perf-improvements` (most recent training files Felipe edited while the singleFork lift was in flight)
  - `stash@{1}: felipe-training-WIP-batch6-2026-05-03-on-20260503-suffix-branch`
  - `stash@{2}: felipe-training-WIP-batch5-2026-05-03-training.ts-only`
  - `stash@{3}: felipe-training-WIP-batch4-2026-05-03`
  - `stash@{4}: felipe-training-WIP-batch3-2026-05-03-during-release-pipeline-commits`
  - `stash@{5}: felipe-training-WIP-batch2-2026-05-03-parallel-with-release-pipeline-work`
  - `stash@{6}: training-reliability-WIP-paused-for-release-pipeline-quick-wins-2026-05-03`
  - `stash@{7}: preserve dirty backend-main worktree before 4.14.123 local merge 2026-05-03` (previously protected)
  - Older stashes (`p0-deploy-pause-unrelated-wip-20260502`, etc.) shifted accordingly; nothing dropped.
  - Restoration sequence (Felipe): switch to `feature/training-reliability-local-orchestration-hardening` (or its `-20260503` suffix variant), then `git stash pop` in order from oldest (`stash@{6}`) to newest (`stash@{0}`), resolving any conflicts file-by-file. The same training files appear across multiple batches because Felipe was iterating; merging conflicts intelligently is the right approach (newer batch wins for each file).

## P1.5 — Release-doc drift cleanup (post-adoption)

- `npm run docs:audit` baseline: **449 issues** across 338 files. Categories: 222 markdown-outside-approved-current-or-archive, 66 test-count-literal, 66 commit-hash-not-in-own-repo, 62 broken-markdown-reference, 33 duplicate-or-scattered-current-verdict.
- Sweep + relocate 222 outside-approved-location files under `docs/archive/2026-05/<workstream>/` and link relevant evidence from `engine/docs/release/current-release-index.md`.
- Add `engine/scripts/release-doc-drift-check.sh` (compares current-doc SHAs to `git log --all`).
- Make `npm run docs:audit` gating for PRs that touch `engine/docs/release/**`.

## P2

- Run `cd engine && npm run docs:audit` before future release-doc updates; the
  first implementation landed on 2026-05-03 and now flags scattered verdicts,
  commit-hash drift, literal test-count drift risk, broken markdown references,
  and markdown outside approved current/archive locations.
- **Release pipeline — one-week improvements** (post P1 adoption — ALL DONE):
  - ~~`vi.mock` completeness lint~~ → **DONE** as `engine/scripts/vi-mock-completeness-lint.mjs` (commit `82b4c78`). Wired into CI as advisor (commit `5bc7386`); strict mode + JSON artifact runs nightly. Initial scan: 1,020 partial mocks across 142 modules; top offenders `logger.ts` (206), `database.ts` (161), `user-service.ts` (46).
  - ~~Lift `singleFork: true` in `engine/vitest.config.ts`~~ → **DONE** (commit `9e2c890`). Full Vitest **9 m 35 s → 1 m 20 s (7.22× speedup)**, **6,557/6,557 pass**. The flake under `singleFork: true` was *caused by* the shared module cache.
  - ~~Smoke scripts write JSON evidence~~ → **DONE** end-to-end. `staging-smoke.sh` (commit `5007b25`) writes per-check rows. `cooking-portal`, `training-calendar-staging`, `training-cross-skill-staging` (commit `ff42e65`) wrap through `scripts/with-smoke-evidence.sh`.
  - ~~`release-doc-drift-check.sh`~~ → **DONE** (commit `5007b25`); UUID-stripping + cross-repo SHA acceptance fix in `f354b7d`; wired into CI as advisor (commit `5bc7386`); strict mode runs nightly. Final drift count: **0** (was 3, all UUID/cross-repo false positives).
  - ~~`promote-to-prod.sh` reuses recent (≤30 min) smoke evidence for same SHA~~ → **DONE** (commit `2135bfe`). `NEXUS_SMOKE_REUSE_MAX_AGE_S` configurable; `NEXUS_SMOKE_REUSE=0` disables.
  - ~~iOS focused-XCTest CI lane on macOS runners with single UDID~~ → **DONE** as `ios/.github/workflows/ios-tests.yml` (commit `672a0fc`). Conditioned on Swift/xcconfig/xcodeproj/plist diff; skips for docs/config-only PRs. UI tests deliberately not included (separate nightly).
  - ~~`staging-smoke.sh` classifier-driven domain checks~~ → **DONE** (commit `f8694c2`). Auth-401 contract probes for training, coach-kernel, calendar, cooking, content, secretary, plus a migration-count assertion. Disable with `NEXUS_SMOKE_DOMAIN_PROBES=0`.
- **Release pipeline — additional improvements (round 2, 2026-05-03 evening)**:
  - ~~Fix `audit-docs.mjs` to ignore `worktrees/`~~ → **DONE** (commit `1b8a0de`). Restored canonical 449 baseline.
  - ~~Add nightly full-coverage + migration-rehearsal workflow~~ → already DONE in `nightly.yml` from the first pass; round 2 added `release-doc-drift-strict` and `vi-mock-completeness` jobs (commit `5bc7386`).
- **Release pipeline — adoption tooling (round 4, 2026-05-03 night)**:
  - ~~Migrate workspace `CURRENT_RELEASE_STATE.md` to reference auto-generated `docs/release/release-identity.md`~~ → **DONE**. Volatile fields (production HEAD / version / migrations / dirty state) now read from the artifact the pre-commit hook auto-refreshes; manual SHA typing eliminated for those fields.
  - ~~Weekly housekeeping wrapper~~ → **DONE** as `engine/scripts/release-pipeline-housekeeping.sh` + `engine/.github/workflows/weekly-housekeeping.yml` (commit `2603162`). Sundays 06:00 UTC: prune smoke-evidence + refresh release-identity + print docs:audit total.
  - ~~Codex deploy-process brief~~ → **DONE** as `docs/release/codex-deploy-process-brief.md`. Self-contained operator prompt with environment, constraints, seven-step deploy loop, dry-run rehearsal, failure-mode escape hatches, report-back checklist.
- **Release pipeline — operator tooling (round 3, 2026-05-03 night)**:
  - ~~`release-identity.sh --persist` mode + pre-commit auto-injection~~ → **DONE** (commit `37e3dff`). Eliminates the 132 stale-SHA + stale-test-count warnings by construction (29 % of the 449 baseline) once canonical docs adopt the generated artifact.
  - ~~Smoke-evidence summary tool~~ → **DONE** as `engine/scripts/smoke-evidence-summary.sh` (commit `aa2a89e`). Markdown + JSON output, `--sha` / `--since` / `--latest` filters.
  - ~~Smoke-evidence retention/prune script~~ → **DONE** as `engine/scripts/smoke-evidence-prune.sh` (commit `aa2a89e`). 60-day default age cap; always preserves the 5 newest records per smokeName. Default dry-run; `--apply` deletes.
  - ~~`deploy.sh --dry-run` mode~~ → **DONE** (commit `466eaf5`). Exits after build phase; prints the full mutation surface that the real deploy would perform.
  - ~~`smoke:content:local` JSON-evidence wrap~~ → **DONE** (commit `80c4506`). Completes JSON-evidence coverage across all five smokes.
  - ~~iOS UI tests in nightly workflow~~ → **DONE** as `ios/.github/workflows/ios-nightly.yml` (commit `945567d`). Runs `Nexus HubUITests` on macos-latest at 05:45 UTC daily; UDID-pinned, sequential, simulator-log capture on failure, 14-day artifact retention.
- Training mobility-variant exercise catalogs: the 2026-05-03 fix now keeps mobility recovery sessions honest by shrinking duration to estimated content (~13 min for empty-block sessions). A follow-up could add a small mobility-exercise catalog (cat-cow, hip flexor, thoracic rotation, etc.) so the variant claims a richer 18-25 min and delivers it.
- Training cycling/hybrid progression depth (TR-P2-CYCLING from `engine/docs/training/training-final-deep-audit-report.md`).
- Production-safe TestFlight smoke for Training mutation + Garmin readiness + task-list read-back across Felipe/Jaqueline/nexushubbot. Scripted checklist: `docs/release/training-recovery-fix-testflight-checklist.md`.

## P3

- Gradually add frontmatter to high-value markdown files:
  - `doc_status`
  - `owner`
  - `last_verified`
  - `update_policy`
  - `supersedes`
  - `superseded_by`
- Doc hygiene sweep on `engine/docs/training/release-candidate-*.md` and `production-release-final-status.md` — these were release-candidate evidence for v4.14.100 (2026-04-28) and now belong under `engine/docs/release/archive/2026-04/training/` per the canonical hygiene rule.
