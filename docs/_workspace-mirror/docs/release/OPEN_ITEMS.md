# Open Items

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-06
Update policy: update when a P0/P1/P2/P3 item opens or closes. Rotate every
Friday or every production release: archive dated `## ` sections older than
7 days whose items are all closed to the monthly open-items archive using
`engine/scripts/rotate-open-items.mjs`. Active surface target: <= 250 LOC.
Older sections record state at their original closeout time; backfill with
FIXED LATER pointers when the item is closed in a subsequent pass.

Last updated: 2026-05-06

## Standing authorizations

BATCH-13-J1-AUTHORIZED: base=feature/tech-debt-2026-05-f4-mock-ratchet-stack
- Granted by Felipe via 2026-05-06 delegated-approval message ("If anything needs my approval, send in the next prompt that is approved to move on.").
- Scope: Codex may branch the Batch 13 J1 mock-baseline ratchet from the F4 stack (`feature/tech-debt-2026-05-f4-mock-ratchet-stack`) and lower `engine/scripts/.vi-mock-baseline.txt` toward 640. `main` still fails strict lint until D5/F4 land — that gate stays open and is tracked in I1's merge-readiness analysis.
- Closed annotation: J1 ran on the authorized F4 stack and is closed in source at `feature/tech-debt-2026-05-j1-mock-ratchet-640` (`e4884c2b`), lowering the staged strict baseline from 655 to 640 with current partial mocks at 637. Marker retained for audit trail; do not reuse for other workstreams.
- Expires: closed by Batch 13 J1. D5/F4 still need to land on `main` before strict mock lint is a `main` gate.

## Batch 18 Active Fix-First Item (2026-05-06)

| ID | Severity | Status | Description |
|---|---|---|---|
| TD-CS-O1 | P0-class | **CLOSED IN SOURCE BRANCH** | `coach-state.ts` userId validation hardened to match the positive-user contract after Batch 16 M2 exposed the fix-first blocker. Closed on `feature/tech-debt-2026-05-o1-coach-state-userid-fix` (`4e7e89df`); focused RED→GREEN proof and full verify evidence are archived in `docs/archive/2026-05/tech-debt-validation/codex-batch-18-coach-state-userid-fix-rationale.md`. |

## Tech-debt Batch 18 — coach-state fix-first + Batch 16 retry (2026-05-06)

Report:
`docs/archive/2026-05/tech-debt-validation/codex-batch-18-remediation.md`.
Revalidation:
`docs/archive/2026-05/tech-debt-validation/codex-batch-18-revalidation.md`.

Verdict: **PARTIAL SOURCE CLOSURE / STOP CONDITION HONORED**. O1 closed the
`coach-state.ts` invalid-user bug in source. O2 deferred because no J2 stack
authorization marker exists. O3 stopped before adding the six-module state test
pack because non-coach modules still accept `userId=0` writes and require their
own fix-first branch.

Branches:

- `feature/tech-debt-2026-05-o1-coach-state-userid-fix` (`4e7e89df`)
- `feature/tech-debt-2026-05-o3-state-modules-finish-retry` — **BLOCKED /
  NO TEST COMMIT**; preflight found additional invalid-user write paths.
- `feature/tech-debt-2026-05-o4-batch-18-closure` (`8f89821a`) — report-only
  branch with workspace mirror refresh.

Closure delta:

| Finding | Status | Evidence |
|---|---|---|
| TD-CS-O1 `coach-state.ts` invalid-user fix | **CLOSED IN SOURCE BRANCH** | O1 adds positive-user guards to `saveCoachState`, `loadCoachState`, and `deleteCoachState`. Focused RED→GREEN proof: 18 invalid-user assertions failed pre-fix and 19/19 passed post-fix. Full verify passed: 456 files / 6848 tests. |
| P2-24 remaining state isolation tests | **STILL BLOCKED / FIX-FIRST REQUIRED** | O3 preflight found `fiscal-collection-profiles.ts`, `invoice-filings.ts`, and `invoice-vendors.ts` can still accept `userId=0` writes. The test-only O3 scope stopped instead of adding known-red tests or changing source. |
| Python pytest finish | **DEFERRED** | `BATCH-18-O2-AUTHORIZED` is absent; J2 exists but is not on `main`; `main` has zero Python pytest files. |

Required next fix-first branch for P2-24:

1. Harden invalid-user guards in fiscal collection profiles, invoice filings,
   and invoice vendors.
2. Preserve intentional `content-references.ts` system-scope administration
   separately from app-facing user-private paths.
3. Re-run the six-module state isolation pack only after the guards pass.

## Tech-debt Batch 16 — test-infra finish + deploy safety (2026-05-06)

Report:
`docs/archive/2026-05/tech-debt-validation/codex-batch-16-remediation.md`.
Revalidation:
`docs/archive/2026-05/tech-debt-validation/codex-batch-16-revalidation.md`.

Verdict: **PARTIAL SOURCE CLOSURE / STOP CONDITIONS HONORED**. Batch 16
closed P2-34 and P2-29 in source branches. M1 and M2 did not run because their
pre-flight checks hit explicit blockers: M1 depends on an unmerged Python
pytest stack while Batch 16 required branching from `main`, and M2's test-only
scope would expose a real invalid-user contract bug in `coach-state.ts`.

Branches:

- `feature/tech-debt-2026-05-m3-python-version-drift-detection` (`c47aae56`)
- `feature/tech-debt-2026-05-m4-deploy-skip-verify-audit` (`add2a2cb`)
- `feature/tech-debt-2026-05-m5-batch-16-closure` (report-only branch)

Closure delta:

| Finding | Status | Evidence |
|---|---|---|
| P2-24 remaining state isolation tests | **STILL BLOCKED / FIX-FIRST REQUIRED** | `src/state/coach-state.ts` does not reject `userId === 0` or invalid/missing user IDs; M2 was tests-only and stopped. |
| P2-29 `deploy.sh --no-verify` policy | **CLOSED IN SOURCE BRANCH** | M4 adds skip-verify audit rows, a smoke-evidence freshness gate for `auto-when-staged`, `/health/detailed.lastDeploy`, and `docs/runbooks/deploy-safety.md`. Full verify passed: 457 files / 6835 tests. |
| P2-34 Python ↔ TS version drift | **CLOSED IN SOURCE BRANCH** | M3 adds `content-engine/version.txt`, deploy-time version bake, TS drift classification, and `/health/detailed.contentEngine.versionDrift`. Full verify passed: 456 files / 6835 tests. |
| Python pytest finish | **BLOCKED** | `main` has 0 pytest files and no `content-engine/tests/conftest.py`; Batch 13 J2 has the 114-case scaffold on a staged branch. |

Next unblock actions:

1. Land or authorize the Python pytest stack through Batch 13 J2, then run the
   remaining-module finish pass.
2. Run a fix-first state-scope branch for `coach-state.ts`, then rerun M2's
   six-module isolation-test pack.
3. Merge M3 before M4 if possible; both touch `scripts/deploy.sh`, but the
   conflict is mechanical: keep M3's version-bake step and M4's skip-verify
   audit/smoke-evidence gate.

## Tech-debt validation pass (2026-05-05)

Validation report:
`docs/archive/2026-05/tech-debt-validation/codex-tech-debt-pass.md`.
Validation matrix:
`docs/archive/2026-05/tech-debt-validation/codex-validation-matrix.md`.
Batch 2 revalidation:
`docs/archive/2026-05/tech-debt-validation/codex-batch-2-revalidation.md`.
Batch 2 remediation:
`docs/archive/2026-05/tech-debt-validation/codex-batch-2-remediation.md`.
Batch 3 revalidation:
`docs/archive/2026-05/tech-debt-validation/codex-batch-3-revalidation.md`.

Verdict: **PHASE B COMPLETE WITH CONDITIONS** - Codex validated all supplied
P0/P1 findings, validated P2-23 through P2-44 after Claude added
`docs/archive/2026-05/tech-debt-validation/claude-tech-debt-2026-05-05.md`,
completed Phase A1-A7, and staged Phase
B1-B6 on separate `main`-based feature branches. Nothing was pushed or
deployed. Conditions: branches remain independent/not merged, docs:audit
remains above the frozen budget on current source, and the B4/B5 signed
two-account E5 walkthroughs are documented but not executed.

Batch 3 status: **BLOCKED BEFORE REMEDIATION**. Codex revalidated C1-C6 and
stopped before code changes because C1 found explicit transaction control in
`engine/migrations/042_unified_fks.sql`, while C5 depends on Batch 2/C4
centralization not present on `main` under the prompt's "branch from main" rule.

Batch 4 status: **D1-D6 STAGED ON SOURCE BRANCHES / NOT PUSHED / NOT
DEPLOYED**. Codex reopened the C-batch work with a `042_unified_fks.sql`
carve-out and staged D1-D6 on separate `main`-based branches. Reports:
`docs/archive/2026-05/tech-debt-validation/codex-batch-4-revalidation.md`
and
`docs/archive/2026-05/tech-debt-validation/codex-batch-4-remediation.md`.

Batch 5 status: **E2/E3/E5/E6 STAGED ON SOURCE BRANCHES / E1 AND E4
BLOCKED / NOT PUSHED / NOT DEPLOYED**. Report:
`docs/archive/2026-05/tech-debt-validation/codex-batch-5-remediation.md`.
E1 remains blocked because B3 model constants and D4 retry extraction are not
on `main` and no stack-branch authorization exists. E4 remains blocked because
the D2/D3/D6 validation stack is staged but not authorized as the local-stack
base for operator evidence.

Batch 5 E1/F1 supersession: Felipe authorized stacked branches on 2026-05-06.
Codex stacked B3 + D4 on `main` and closed the Anthropic wrapper in source on
`feature/tech-debt-2026-05-f1-anthropic-wrapper-stack` (`2f02196c`, plus audit
cleanup `6b2eadf0`). Report:
`docs/archive/2026-05/tech-debt-validation/codex-batch-9-remediation.md`.

Batch 5 E4/F2 supersession: the same stack authorization allowed a
validation-only D1/D2/D3/D6 stack. Codex captured local `/health` healthy and
degraded evidence, restore-test alert/history evidence, and Cloudflare headers
on `feature/tech-debt-2026-05-f2-d2-d3-d6-validation-stack` (`920a3e1b`
evidence commit). Public Cloudflare health headers report
`cf-cache-status: DYNAMIC`, so no repository config change was required.

Batch 6 F4 supersession: stack authorization allowed D5's mock-factory branch
to be ratcheted without waiting for `main`. Codex staged
`feature/tech-debt-2026-05-f4-mock-ratchet-stack` (`142398f3`, audit cleanup
`5488ed8e`), lowering the strict partial-mock baseline from 660 to 655 with
current count 653. Full verify passed (`6829/6829`) and docs-audit is at
490 issues / 408 markdown files on the stack.

Batch 6 F3 supersession: stack authorization allowed the E5 observability shim
cleanup to be staged on top of E5. Codex staged
`feature/tech-debt-2026-05-f3-shim-removal-stack` (`ad0ce25e`) based on E5
(`d42a1e6b`), deleting `src/portal/anthropic-hook.ts` and
`src/portal/telemetry.ts` and updating the remaining runtime imports to
`src/observability/*`. Full verify passed (`6831/6831`) and docs-audit is at
492 issues / 410 markdown files on the stack.

Batch 6 E8 docs-mirror supersession: Codex refreshed
`engine/docs/_workspace-mirror` from the current canonical workspace docs on
`feature/tech-debt-2026-05-e8-docs-mirror-sync`. The mirror now includes the
current agent process/open-items/release identity docs and the three runbooks.

## Tech-debt Batch 6 - merge-safety analysis (2026-05-06)

Reports:
`docs/archive/2026-05/tech-debt-validation/codex-batch-6-revalidation.md`
and
`docs/archive/2026-05/tech-debt-validation/codex-batch-6-merge-safety-analysis.md`.

Verdict: **F0 COMPLETE / F1, F2, F3, F4 CLOSED IN SOURCE STACK BRANCHES /
F5 CLOSED IN SOURCE**. Current
`main` remains `ed53f84`; none of the Batch 1-5 tech-debt feature branches
has landed. Batch 6 revalidation found 27 existing
`feature/tech-debt-2026-05-*` branches before F0, docs-audit baseline
491 issues / 402 markdown files, and strict mock lint still failing at
1,039 partial mocks on `main` because D5 is not merged there. Felipe's later
stack authorization allowed source closure for F1, F2, F3, and F4 on dedicated
stack branches.

Operator action checklist for Felipe:

1. Merge `feature/tech-debt-2026-05-open-items-cleanup` first.
2. Merge the Phase A low-risk cluster: audit fix, drop-types-sharp,
   audit allowlist, delete WhatsApp, auth-failure paths, hash-email,
   migration-collision gate, and Sentry gate.
3. Merge `feature/tech-debt-2026-05-model-id-constants` and
   `feature/tech-debt-2026-05-d4-with-retry` to unblock F1/C5.
4. Merge D1 -> D2 -> D3 -> D6 to unblock F2 operator validation.
5. Merge D5, then E5. D5 unlocks F4; E5 should land after B3 so the moved
   Anthropic hook already contains the model-id changes.

Conditional readiness:

| Batch | Status | Reason |
|---|---|---|
| F1 C5/E1 Anthropic wrapper | **CLOSED IN SOURCE STACK BRANCH** | Felipe authorized stacking after F0. `feature/tech-debt-2026-05-f1-anthropic-wrapper-stack` carries B3 (`6284fb3b`), D4 (`5660da9d`), and the wrapper implementation (`2f02196c`). |
| F2 D2/D3/D6 validation | **CLOSED IN SOURCE STACK BRANCH** | Felipe authorized stacking after F0. `feature/tech-debt-2026-05-f2-d2-d3-d6-validation-stack` carries D1/D2/D3/D6 and captured local health, restore-test, and Cloudflare evidence. |
| F3 E5 shim removal | **CLOSED IN SOURCE STACK BRANCH** | Felipe authorized stacking after F0. `feature/tech-debt-2026-05-f3-shim-removal-stack` is based on E5 (`d42a1e6b`) and removes the legacy portal observability shims in `ad0ce25e`. |
| F4 D5 mock ratchet | **CLOSED IN SOURCE STACK BRANCH** | Felipe authorized stacking after F0. `feature/tech-debt-2026-05-f4-mock-ratchet-stack` carries D5 (`13c9cc74`), ratchets strict baseline 660 -> 655, and current partial mocks drop to 653. |
| F5 Python pytest expansion | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-f5-python-pytest-expansion` (`49cf23a1`) carries the E6 bootstrap forward from `main`, expands content-engine pytest to 53 cases across 10 modules, and leaves Python source semantics untouched. |

### Closure delta

| ID | Severity | Status | Description |
|---|---|---|---|
| TD-H1 | P2/P1 | **CLOSED IN SOURCE STACK BRANCH** | `feature/tech-debt-2026-05-f1-anthropic-wrapper-stack` (`2f02196c`, audit cleanup `6b2eadf0`) closes the C5/E1/F1 Anthropic-wrapper item by stacking B3 model constants (`6284fb3b`) and D4 retry helper (`5660da9d`) on `main`. Direct task-style Anthropic callers now go through `src/services/anthropic-task.ts`; structural guard tests block new runtime SDK construction outside approved wrappers. Full verify passed (`6845/6845`), P0 identity passed (`23/23`), and docs-audit is at 491 issues / 408 markdown files. |
| TD-H2 | P1 ops | **CLOSED IN SOURCE STACK BRANCH** | `feature/tech-debt-2026-05-f2-d2-d3-d6-validation-stack` (`920a3e1b` evidence commit) closes the D2/D3/D6 operator-validation blocker on a validation stack. Local `/health` returned 200 healthy and 503 when content-engine was stopped; `/health/detailed` surfaced `migrationChecksums` and restore-test backup state; manual scheduler-equivalent restore-test failure inserted `restore_test_history` and a critical `operator_alerts` row; `https://api.nexushub.me/health` returned `cf-cache-status: DYNAMIC`. Full verify passed (`6848/6848`), docs-audit passed at 487 issues / 411 markdown files, and no listeners remained on 8100/8200/8201. |
| TD-H3 | P2 test infra | **CLOSED IN SOURCE STACK BRANCH** | `feature/tech-debt-2026-05-f4-mock-ratchet-stack` (`142398f3`, audit cleanup `5488ed8e`) closes the D5/F4 strict mock-ratchet blocker on a stack. The branch carries D5 (`13c9cc74`), lowers `engine/scripts/.vi-mock-baseline.txt` from 660 to 655, and current partial mocks are 653. Focused tests + P0 identity passed (`262/262`), full verify passed (`6829/6829`), strict lint passed, and docs-audit passed at 490 issues / 408 markdown files. |
| TD-H4 | P2 architecture | **CLOSED IN SOURCE STACK BRANCH** | `feature/tech-debt-2026-05-f3-shim-removal-stack` (`ad0ce25e`) closes the E5/F3 shim-removal item on a post-E5 stack. The branch deletes `src/portal/anthropic-hook.ts` and `src/portal/telemetry.ts`, updates remaining runtime imports to `src/observability/*`, extends the architecture guard to block shim reintroduction, and passes full verify (`6831/6831`). Merge order: E5 first, then F3 after dependent branches have been rebased or merged. |
| TD-H5 | P2 docs gate | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-e8-docs-mirror-sync` refreshes `engine/docs/_workspace-mirror` from the current workspace docs so `workspace-docs-mirror.sh --check` has a source branch that passes after the staged docs branches land. |
| TD-G2 | P3 tests | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-f7-python-pytest-expansion-3` (`e637f219`) continues the unblocked Python pytest expansion, raises content-engine pytest to 91/91 cases across 29 modules, and adds app/router/searcher/config/model coverage without changing Python source semantics. Report: `docs/archive/2026-05/tech-debt-validation/codex-batch-8-remediation.md`. |
| TD-G1 | P3 tests | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-f6-python-pytest-expansion-2` (`01385b69`) continues the Batch 6 Python pytest expansion, raises content-engine pytest to 71/71 cases across 18 modules, fixes `book_knowledge.py` SerpAPI config lookup (`cfg.serpapi_key`), and keeps Python pytest advisory until Felipe approves the 2026-06-01 blocking flip. Report: `docs/archive/2026-05/tech-debt-validation/codex-batch-7-remediation.md`. |
| TD-F0 | P1 merge gate | **CLOSED** | `docs/archive/2026-05/tech-debt-validation/codex-batch-6-merge-safety-analysis.md` inventories 27 pre-existing tech-debt feature branches, records the conflict-shape matrix, and gives Felipe the next-five merge checklist inline above. |
| TD-F1 | P2/P1 | **CLOSED IN SOURCE STACK BRANCH** | Superseded by Felipe's 2026-05-06 stack authorization. `feature/tech-debt-2026-05-f1-anthropic-wrapper-stack` stacks B3 + D4 and closes the Anthropic wrapper in source. Merge order: land B3, land D4, then merge or replay this stack branch. |
| TD-F2 | P1 ops | **CLOSED IN SOURCE STACK BRANCH** | Superseded by Felipe's 2026-05-06 stack authorization. The F2 validation stack captured healthy/degraded local `/health`, restore-test alert/history, detailed backup health, and Cloudflare dynamic-cache evidence. |
| TD-F3 | P2 architecture | **CLOSED IN SOURCE STACK BRANCH** | Superseded by Felipe's 2026-05-06 stack authorization. `feature/tech-debt-2026-05-f3-shim-removal-stack` stacks on E5 and removes the one-merge-cycle portal observability shims. |
| TD-F4 | P2 test infra | **CLOSED IN SOURCE STACK BRANCH** | Superseded by Felipe's 2026-05-06 stack authorization. `feature/tech-debt-2026-05-f4-mock-ratchet-stack` stacks D5 and ratchets the staged baseline from 660 to 655 with current partial mocks at 653. |
| TD-F5 | P3 tests | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-f5-python-pytest-expansion` (`49cf23a1`) adds Batch 6 Python tests for hook generator, caption writer, thumbnail generator, title tester, repurpose engine, gap finder, and competitor analyzer. Content-engine pytest now passes 53/53 cases across 10 modules; full backend verify passes on the branch. |
| TD-A1 | P0 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-audit-fix` (`2139235`) refreshes vulnerable transitive packages. `npm audit --json` reports 0 vulnerabilities on that branch; focused provider/auth tests, full verify, and staging-smoke passed. |
| TD-A2 | P0/P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-sentry-gate` (`463d5da`) documents `SENTRY_DSN`, adds production deploy warning-only posture, surfaces Sentry status in `/health/detailed`, and pins disabled-with-warning behavior. |
| TD-A3 | P0 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-hash-email` (`8145b82`) unifies email hash normalization through `src/utils/identity.ts`. Follow-up: historical audit-log `emailHash` joins may need a one-time backfill note if old drifted hashes matter. |
| TD-A4 | P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-migration-collision-gate` (`26a583c`) fails startup for non-allowlisted duplicate migration prefixes and adds a CI duplicate-prefix gate while preserving known legacy duplicates. |
| TD-A5 | P2 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-audit-allowlist` (`2aff001`) aligns docs:audit with DOCS_INDEX for `engine/docs/agents/claude/handoff.md` without promoting the handoff to a canonical link root. |
| TD-A6 | P2 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-delete-whatsapp` (`1ef044e`) deletes the dead WhatsApp adapter, its adapter-only tests, historical task spec, and adapter re-export; active webhook tests remain. Full verify passed (`453` files / `6716` tests). |
| TD-A7 | P3 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-drop-types-sharp` (`a4dd949`) removes deprecated `@types/sharp`; TypeScript, invoice-focused tests (`25/25`), and full verify (`455` files / `6829` tests) passed. |
| TD-B1 | P0 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-auth-failure-paths` (`7538749`) adds a 12-case auth failure-path safety net. Auth-routes + P0 identity focused run passed (`54/54`); full verify passed (`455` files / `6841` tests). |
| TD-B2 | P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-coverage-threshold` (`33745b5`) rebaselines Vitest coverage thresholds to statements/lines 69%, branches 72%, functions 78%, adds a coverage baseline doc, and documents the monthly ratchet. Full verify passed (`455` files / `6829` tests). |
| TD-B3 | P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-model-id-constants` (`3ededc3`) centralizes Anthropic model IDs behind `config.anthropic.*`; literal grep now returns only `src/config.ts`. Full verify passed (`456` files / `6831` tests). |
| TD-B4 | P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-jwt-helper` (`43fb15d`) centralizes Nexus JWT and Apple identity-token verification in `src/services/auth-tokens.ts`; runtime `jwt.verify` call sites are reduced to the helper. Full verify passed (`456` files / `6837` tests). E5 two-account walkthrough remains manual/operator action. |
| TD-B5 | P0 | **CLOSED IN SOURCE BRANCHES** | Backend `feature/tech-debt-2026-05-timezone-resolver` (`025319e`) and iOS `feature/tech-debt-2026-05-timezone-resolver` (`1a82150`) replace Lisbon assumptions with saved-user timezone resolution. `users.timezone` exists in `migrations/030_users.sql` and `migrations/051_multi_auth_users.sql`; non-Lisbon users now use their saved timezone in touched flows. Backend full verify passed (`456` files / `6833` tests); iOS focused timezone/currency/parser tests passed (`17/17`). |
| TD-B6 | P0/P2 | **CLOSED IN SOURCE BRANCH** | iOS `feature/tech-debt-2026-05-ios-scope-unification` (`55bc2e2`) adds `AuthScope` and `ScopedUserDefaults`, preserving the historical scoped-key shape while removing repeated `currentScopeKey` definitions. iOS build passed; focused scope/content/navigation tests passed (`67/67`). |
| TD-CX-O1 | P2 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-open-items-cleanup` adds `scripts/filter-existing-vitest-globs.mjs` and wires pre-commit/pre-push focused Vitest runs through it, dropping stale no-match globs before Vitest is invoked. |
| TD-CX-O2 | P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-open-items-cleanup` repairs stale current-doc references and updates `audit-docs.mjs` so skipped workspace-mirror snapshots no longer inflate the active markdown-file budget. `npm run docs:audit -- --json` now reports 482 issues / 379 audited files, with 15 mirror files disclosed separately as skipped duplicates. |
| TD-CX-O3 | P2 | **OPEN E5 VALIDATION** | Requires a signed TestFlight build containing B4/B5/B6 before closure. Walkthrough: sign in as Felipe, verify `/auth/me`, read Content/Home/Calendar/Training state, rotate or refresh the session, create/read scoped local Content profile/reference/brief state, set/confirm Felipe timezone; sign out, sign in as nexushubbot, verify `/auth/me`, confirm Felipe state is invisible, create bot-scoped Content state, set/confirm a different timezone, relaunch, switch back to Felipe, and confirm identity, timezone labels, and local cache scopes remain partitioned. Record screenshots/log notes with `engine/scripts/testflight-evidence.sh --apply`. |
| TD-CX-O4 | P1 | **CLOSED IN SOURCE STACK BRANCH** | D1 resolved the C1 blocker by adding a filename-specific carve-out for self-transactional `042_unified_fks.sql` while wrapping non-legacy migrations in `db.transaction(...)`. The F2 validation stack carries D1 (`fc20ef19`) plus D2/D3/D6 evidence. |
| TD-CX-O5 | P1 | **CLOSED IN SOURCE STACK BRANCH** | Felipe approved stacked branches on 2026-05-06. `feature/tech-debt-2026-05-f1-anthropic-wrapper-stack` carries the required B3/D4 prerequisites plus the Anthropic wrapper closure. |
| TD-D1 | P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-d1-migration-safety` (`3a68ccc2`) wraps non-legacy migrations in `db.transaction(...)`, adds `_migrations.checksum`, surfaces checksum drift, and preserves `042_unified_fks.sql` as the only self-transactional carve-out. Full verify and P0 identity passed on branch. |
| TD-D2 | P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-d2-health-extension` (`a61dc5ec`) adds content-engine/provider readiness to `/health` and `/health/detailed`, with degraded 503 semantics. Follow-up: verify Cloudflare cache rules do not mask 503 responses. |
| TD-D3 | P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-d3-restore-test-alerts` (`605f0f46`) persists restore-test history and routes failures through operator alerts instead of Telegram-only best effort. |
| TD-D4 | P1 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-d4-with-retry` (`47fb7ed6`) centralizes retry behavior in `src/utils/retry.ts` and codemods Telegram, Microsoft Todo, content-engine, OpenAI, and Gemini callers while preserving existing retry semantics. |
| TD-D5 | P2 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-d5-mock-factories` (`a83e4517`) adds logger/database/user-service mock factories and strict-ratchets `vi-mock-completeness-lint` from 1,039 partial mocks to a 660 baseline. |
| TD-D6 | P2 | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-d6-runbook-trio` (`93308a6e`) adds canonical VPS cold-start, Cloudflared tunnel, and secret-rotation runbooks, a sanitized Cloudflare config example, and a dry-run-first OAuth encryption-key rotation script. |
| TD-D7 | P2 | **CLOSED IN SOURCE STACK BRANCH** | F2 validation captured public `https://api.nexushub.me/health` headers with `cf-cache-status: DYNAMIC`; no stale 200 cache behavior was visible from Cloudflare's public health route. |
| TD-E1 | P2/P1 | **CLOSED IN SOURCE STACK BRANCH** | Batch 5's E1 blocker was resolved by Felipe's later stack authorization. The stack branch includes B3/D4 prerequisites and the wrapper implementation; no push or deploy has occurred. |
| TD-E2 | P1 docs | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-e2-claude-md-bootloader` (`d3b7ec7c`) slims `engine/CLAUDE.md` to a bootloader, archives release narrative, and pins the shape with `claude-md-bootloader-shape` tests. E2 branch docs-audit improved to 472 issues / 402 markdown files from the Batch 5 baseline of 493 / 399. |
| TD-E3 | P1 docs | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-e3-open-items-rotation` (`8bd70cf7`) adds `rotate-open-items.mjs`, weekly housekeeping wiring, tests, and the May archive template. Dry-run moved 0 sections on current source and warned on undated priority sections. |
| TD-E4 | P1 ops | **CLOSED IN SOURCE STACK BRANCH** | Superseded by the F2 validation stack after Felipe authorized stacking. Evidence is committed under `engine/docs/release/smoke-evidence/2026-05-batch9-f2-*` and summarized in `docs/archive/2026-05/tech-debt-validation/codex-batch-9-remediation.md`. |
| TD-E5 | P2 architecture | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-e5-observability-extraction` (`d42a1e6b`) moves cost telemetry from `portal/` to `observability/`, keeps one-merge-cycle re-export shims, and adds a structural no-portal-import-from-services test. Merge note: B3 edits inside the moved `anthropic-hook` must be applied to the new observability path; D4 conflicts should be import-path-only; E1 should use the observability path if E5 lands first. |
| TD-E6 | P3 tests | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-e6-python-pytest-bootstrap` (`48624b2c`, includes `c1aa931b`) adds pytest bootstrap for content-engine creator profile, orchestrator, and script writer. Python pytest passed 17/17; latest Batch 5 full verify passed 455 files / 6829 tests. |
| TD-E7 | P2 merge gate | **CLOSED IN SOURCE STACK BRANCH** | Batch 5 final strict mock gate is source-closed on the F4 stack after Felipe authorized stacking. `main` still has the old 1,039 partial-mock state until D5/F4 are merged, but the stack branch passes strict lint at baseline 655 with current count 653. |
| TD-E8 | P2 docs gate | **CLOSED IN SOURCE BRANCH** | `feature/tech-debt-2026-05-e8-docs-mirror-sync` refreshes the engine workspace mirror from current canonical docs, including D6 runbooks and current OPEN_ITEMS/release identity state. |

### Deferred validated tech-debt

- **Phase C/D queue**: P1-09 retry helper, P1-13 cost tables, P1-14 scheduler split, P1-17 formatter centralization, P1-21 restore-test alerting, P1-22 health/content-engine readiness, P2-25/P2-38/P2-39/P2-43/P2-44 infra runbooks, P2-30 provider-bypass wrapper, P2-33 observability module extraction, P2-35 Garmin client ownership, P2-37 docs verdict cleanup, P2-41 Content XCUITest identifier walk, P2-42 mock factories, `@google/generative-ai` -> `@google/genai`, migration-runner transaction wrapping, iOS fastlane/TestFlight automation, self-hosted GitHub runner, and Python content-engine pytest bootstrap.
- **P2 count corrections**: `src/state` currently has 15 files, not 87; of Claude's ten listed untested state modules, only `coach-state.ts` lacked direct test-name evidence. `PreviewRuntime` hits are 21, `services/* -> portal/*` imports are 29, and partial mocks remain 1,039.

## Content Creation workflow promote (2026-05-05)

Backend source: `main` @ `e3de170`; production deploy bump `583b431` (`4.14.131`).
iOS source: `main` @ `6d76f53`.

Verdict: **PROMOTED TO BACKEND PRODUCTION / IOS SOURCE PUSHED** — the validated Content Creation workflow branch was merged and pushed to both `main` branches. Backend was staged, smoke-tested, and promoted to production. iOS source is pushed; TestFlight/App Store distribution remains a separate operator release action.

### Closure delta

| ID | Severity | Status | Description |
|---|---|---|---|
| CONTENT-CX-O1 | P1 | **CLOSED IN SOURCE + PROD BACKEND** | Content Creation REST/portal contracts for creator profile, radar feedback, lifecycle, references/provenance, and performance aggregates are merged to backend `main` and live in production `4.14.131`. |
| CONTENT-CX-O2 | P1 | **CLOSED IN IOS SOURCE** | iOS Content Creation workflow surfaces are merged to iOS `main` with focused profile tests passing. Signed TestFlight delivery is separate from source promotion. |
| CONTENT-CX-O3 | P2 | **OPEN E5 VALIDATION** | Run a signed TestFlight two-account Content Creation walkthrough: create/edit profile, read back profile/voice, accept/reject radar idea, open brief/script, verify no cross-user/tenant leakage, and confirm neutral/no-profile fallback for non-founder accounts. |
| CONTENT-CX-O4 | P2 | **OPEN PORTAL SMOKE** | Run operator-scoped portal Content smoke with realistic dummy entries after the next portal QA window; do not count shell load only. |

### Evidence

- Backend focused Content/portal tests: **100 files / 783 tests passed**.
- Backend main pre-push/deploy full suite: **454 files / 6809 tests passed**.
- Staging smoke before promote: **17/17 passed**.
- Production health: `nexus-hub` online, `content-engine` online, status portal reported `4.14.131`.
- iOS Content source: `xcodebuild build-for-testing` passed; `ContentCreatorProfileTests` **27/27 passed**.

## Technical suite mastery Codex validation (2026-05-04 late)

Workspace validation branch: `feature/technical-suite-mastery-codex-validation`.
iOS validation branch: `feature/technical-suite-mastery-codex-validation`.
Validation report: `docs/archive/2026-05/technical-suite-mastery-codex-validation/codex-validation.md`.

Verdict: **READY_WITH_CONDITIONS** — the technical mastery pack is usable for agent onboarding after Codex's docs/process corrections. Remaining condition: merge the restored iOS engineering docs to iOS `main` and keep the historical docs-audit cleanup/symlink-resolution workstream open.

### Validation delta

| ID | Severity | Status | Description |
|---|---|---|---|
| TECH-CX-O1 | P2 | **FIXED LOCALLY** | Canonical indexes referenced `ios/docs/engineering/*`, but iOS `main` did not contain those docs. Codex restored the iOS engineering standards on the validation branch and cross-linked the technical mastery pack. |
| TECH-CX-O2 | P2 | **FIXED** | `CURRENT_RELEASE_STATE.md` still described production `4.14.129` after the auth-UX promote to `4.14.130`. Codex refreshed the production/source/deploy/iOS status and mirrored the workspace doc. |
| TECH-CX-O3 | P3 | **FIXED** | `docs/agent/AGENT_TECHNICAL_MASTERY.md` omitted `engine/src/router/` and `engine/src/sdk/` from the source-tree map. Codex added path-specific rows and test/ownership guidance. |
| TECH-CX-O4 | P3 | **FIXED** | The mastery pack described docs-audit as a simple frozen-count check. Codex updated it to require per-class drift investigation when totals exceed the baseline policy. |
| TECH-CX-O5 | P3 | **CLOSED IN SOURCE BRANCH** | Batch 10 reduced docs:audit from 494 issues / 408 audited files on engine `main` to 268 issues / 396 audited files on `feature/tech-debt-2026-05-g5-tech-cx-o5-closure` (-226 total). Residual broken-link noise remains tracked as future cross-repo path-resolution cleanup, but the historical outside-approved/SHA/test-count/verdict noise is now materially below budget. |

## Tech-debt Batch 10 — TECH-CX-O5 docs-audit cleanup (2026-05-06)

Branches:

- `feature/tech-debt-2026-05-g1-archive-sweep` — `08dc585b`
- `feature/tech-debt-2026-05-g2-auditor-refinements` — `b441fdc0`
- `feature/tech-debt-2026-05-g3-verdict-backlinks` — `b45d1444`
- `feature/tech-debt-2026-05-g4-frontmatter-completion` — `3bd7c0b5`
- `feature/tech-debt-2026-05-g5-tech-cx-o5-closure` — `e4149b02`

docs:audit:

| Metric | Start | End | Delta |
|---|---:|---:|---:|
| Total issues | 494 | 268 | -226 |
| Audited markdown files | 408 | 396 | -12 |
| markdown-outside-approved-current-or-archive-location | 229 | 128 | -101 |
| commit-hash-not-found-in-own-repo | 78 | 32 | -46 |
| test-count-literal-outside-current-report | 75 | 30 | -45 |
| broken-markdown-reference | 68 | 76 | +8 |
| duplicate-or-scattered-current-verdict | 35 | 2 | -33 |

Verdict: **CLOSED IN SOURCE BRANCH** because cumulative reduction is 226 issues, above the 175-issue closure threshold. Remaining broken-link noise is mostly cross-repo/iOS path resolution and stays deferred to a dedicated follow-up.

### Evidence

- `npm run docs:audit`: **487 issues / 387 files** (inside frozen baseline budget after iOS docs restoration, validation report, and mirror refresh).
- `engine/scripts/workspace-docs-mirror.sh --check`: PASS.
- `npx tsc --noEmit`: PASS.
- `engine/scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: PASS, 23 gates / 0 failures.

## Tech-debt Batch 11 — residual non-operator cleanup (2026-05-06)

Branches:

- `feature/tech-debt-2026-05-h1-cross-repo-link-resolver` — `a5a72b31`
- `feature/tech-debt-2026-05-h2-frontmatter-error-flip` — `6cffb0b4`
- `feature/tech-debt-2026-05-h3-mock-ratchet-645` — **DEFERRED**; D5/F4 mock baseline is not on `main` and no `BATCH-11-H3-AUTHORIZED` marker exists.
- `feature/tech-debt-2026-05-h4-python-pytest-expansion` — `96459575`
- `feature/tech-debt-2026-05-h5-batch-11-closure` — `a7d0d953`

Closure delta:

| Item | Status | Evidence |
|---|---|---|
| Dedicated broken-markdown-reference pass | **CLOSED IN SOURCE BRANCH** | docs:audit `broken-markdown-reference` dropped 68 -> 1 on the Batch 11 stack. |
| G4 follow-up: canonical engine frontmatter promotion | **CLOSED IN SOURCE BRANCH** | `engineering-standard-frontmatter-missing` remains 0; missing frontmatter is now error-severity for canonical `engine/docs/**/*.md`. |
| D5 mock baseline ratchet 655 -> 645 | **DEFERRED** | main still lacks D5/F4 baseline; strict mock lint reports the historical 1,039 partial mocks. |
| Python content-engine pytest expansion | **CLOSED IN SOURCE BRANCH** | 50 pytest cases pass across hook, caption, thumbnail, title, repurpose, gap finder, and competitor analyzer modules. |

docs:audit:

| Metric | Start on main | End on Batch 11 stack | Delta |
|---|---:|---:|---:|
| Total issues | 494 | 418 | -76 |
| Audited markdown files | 410 | 417 | +7 |
| broken-markdown-reference | 68 | 1 | -67 |
| markdown-outside-approved-current-or-archive-location | 229 | 229 | 0 |
| commit-hash-not-found-in-own-repo | 78 | 78 | 0 |
| test-count-literal-outside-current-report | 75 | 75 | 0 |
| duplicate-or-scattered-current-verdict | 35 | 35 | 0 |

Note: Batch 10's G1-G5 stack already source-closed TECH-CX-O5 at 268 issues.
Batch 11 intentionally ran from `main`, so it does not include the G1 archive
sweep/G2 regex/G3 verdict consolidation reductions. Do not raise Batch 10's
lower baseline from this main-derived stack; merge Batch 10 first, then apply
Batch 11's `broken-markdown-reference <= 1` result on top.

Evidence:

- `npx vitest run __tests__/scripts/audit-docs-cross-repo-resolver.test.ts`: 4/4 PASS.
- `npx vitest run __tests__/scripts/canonical-frontmatter-coverage.test.ts __tests__/scripts/audit-docs-frontmatter-error.test.ts`: 5/5 PASS.
- `cd content-engine && .venv313/bin/python -m pytest tests/ -v`: 50/50 PASS. Literal `python -m pytest` is blocked locally because no `python` shim exists; `python3` lacks pytest outside the content-engine venv.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: 23/23 PASS.
- `npm run verify`: PASS on H2, 458 files / 6,838 tests.

## Batch 12 — merge-readiness analysis (2026-05-06)

Reports:

- Revalidation:
  `docs/archive/2026-05/tech-debt-validation/codex-batch-12-revalidation.md`
- Merge-readiness analysis:
  `docs/archive/2026-05/tech-debt-validation/codex-batch-12-merge-readiness-analysis.md`

Verdict: **I1 COMPLETE / I2 GATE UNMET AT START**. Engine `main` remains
`ed53f84a`; docs:audit baseline is 494 issues / 412 audited markdown files;
strict mock lint on `main` still reports 1,039 partial mocks because D5/F4 are
not on `main`.

D5/F4 unblock options:

| Option | Action | Impact |
|---|---|---|
| A | Land D5, then F4, on `main`. | Cleanest path; future mock ratchets branch from `main`. |
| B | Add `BATCH-12-I2-AUTHORIZED: base=feature/tech-debt-2026-05-f4-mock-ratchet-stack`. | Lets Codex ratchet 655 -> 640 on the stack; `main` still fails strict lint until D5/F4 land. |
| C | Queue mock work until after the landing wave. | Lowest immediate risk; no partial-mock progress until merge cadence catches up. |

Operator action checklist:

1. Pick D5/F4 unblock option A, B, or C.
2. If A: merge/cherry-pick D5 (`a83e4517`, carrying D5 `13c9cc74`), then F4
   (`5488ed8e`, carrying ratchet `142398f3` and cleanup).
3. If B: add the `BATCH-12-I2-AUTHORIZED` marker above.
4. Merge B3 (`model-id-constants`) and D4 (`with-retry`) before replaying F1/C5.
5. Merge Batch 10 before Batch 11 docs branches so the lower docs-audit
   baseline remains the ceiling.

## Tech-debt Batch 12 — D5/F4 merge gate + independent work (2026-05-06)

Branches:

- `feature/tech-debt-2026-05-i1-merge-readiness-analysis` — `c1e71788`
- `feature/tech-debt-2026-05-i2-mock-ratchet-640` — **DEFERRED**; D5/F4 are not on `main` and no `BATCH-12-I2-AUTHORIZED` marker exists.
- `feature/tech-debt-2026-05-i3-python-pytest-expansion-2` — `12e1fd03` standalone, integrated into I5 as `04f7b218` + `5411fce6`
- `feature/tech-debt-2026-05-i4-workspace-ios-frontmatter-error` — engine `7633d259`, iOS `d660792`
- `feature/tech-debt-2026-05-i5-batch-12-closure` — final closure stack

Report: `docs/archive/2026-05/tech-debt-validation/codex-batch-12-remediation.md`

Closure delta:

| Item | Status | Evidence |
|---|---|---|
| D5/F4 merge-readiness decision tree | **CLOSED IN SOURCE BRANCH** | I1 produced `docs/archive/2026-05/tech-debt-validation/codex-batch-12-merge-readiness-analysis.md` and inlined the 3-option D5/F4 unblock proposal above. |
| Mock baseline ratchet 655 -> 640 | **DEFERRED** | `main` still lacks D5/F4; strict mock lint remains the historical 1,039 partial mocks. Use option A or B from the I1 proposal to unblock. |
| Python content-engine pytest expansion | **CLOSED IN SOURCE BRANCH** | I3 adds pytest bootstrap plus 82/82 passing tests across core, creative, and intelligence content-engine modules without changing Python source semantics. |
| Workspace + iOS canonical frontmatter enforcement | **CLOSED IN SOURCE BRANCH** | I4 extends `engineering-standard-frontmatter-missing` to workspace and iOS canonical docs at error severity; docs:audit reports 0 frontmatter errors. |

docs:audit:

| Metric | Start on main | End on I5 stack | Delta |
|---|---:|---:|---:|
| Total issues | 494 | 485 | -9 |
| Audited markdown files | 412 | 420 | +8 |
| engineering-standard-frontmatter-missing | 0 | 0 | 0 |
| markdown-outside-approved-current-or-archive-location | 229 | 229 | 0 |
| broken-markdown-reference | 68 | 68 | 0 |

Evidence:

- `npm run verify`: PASS on I5, 456 files / 6,830 tests.
- `cd content-engine && .venv313/bin/python -m pytest tests/ -q`: 82/82 PASS.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: 23/23 PASS on I1, I3, and I4.
- `bash scripts/workspace-docs-mirror.sh --check`: PASS.
- iOS frontmatter doc change is staged on iOS branch `feature/tech-debt-2026-05-i4-workspace-ios-frontmatter-error` (`d660792`). Existing iOS code edits in `CalendarRepository.swift` / `DashboardViewModel.swift` remain untouched.

## Tech-debt Batch 13 — mock ratchet + pytest expansion + cross-repo replay (2026-05-06)

Report: `docs/archive/2026-05/tech-debt-validation/codex-batch-13-remediation.md`

Branches:

- `feature/tech-debt-2026-05-j1-mock-ratchet-640` — source-stack branch from authorized F4 base; commit `e4884c2b`.
- `feature/tech-debt-2026-05-j2-python-pytest-expansion-3` — main-rooted Python pytest expansion; commit `04fd36e3` on top of replayed I3 scaffold.
- `feature/tech-debt-2026-05-j3-cross-repo-resolver-on-main` — main-rooted H1 resolver replay; commits `8fa5919f`, `96c0fb2b`, `1681205c`.
- `feature/tech-debt-2026-05-j4-batch-13-closure` — combined J2+J3 closure stack for final verification/reporting.

Closure delta:

| Item | Status | Evidence |
|---|---|---|
| I2 / TD-H3 mock baseline ratchet 655 -> 640 | **CLOSED IN SOURCE STACK BRANCH** | J1 ran under the standing authorization on `feature/tech-debt-2026-05-f4-mock-ratchet-stack`; strict lint passed at 637 partial mocks with baseline 640; full verify passed 455 files / 6,829 tests; P0 identity passed 23/23. |
| Python content-engine pytest expansion | **PROGRESSING** | J2/J4 expand content-engine pytest to 114 passing cases and disable `.pytest_cache` generation so docs:audit does not count generated pytest markdown. Python source semantics unchanged. |
| Cross-repo broken-md-ref replay onto main-rooted base | **CLOSED IN SOURCE BRANCH** | J3 replays the H1 resolver onto a fresh `main` branch; docs:audit broken-markdown-reference drops from 68 at Batch 13 start to 1 on J3/J4; resolver regression test passes 4/4. |

docs:audit:

| Metric | Start on main | End on J4 stack | Delta |
|---|---:|---:|---:|
| Total issues | 498 | 418 | -80 |
| Audited markdown files | 415 | 421 | +6 |
| broken-markdown-reference | 68 | 1 | -67 |
| markdown-outside-approved-current-or-archive-location | 229 | 229 | 0 |

Evidence:

- J1: `node scripts/vi-mock-completeness-lint.mjs --strict` PASS at baseline 640; `npm run verify` PASS (455 files / 6,829 tests).
- J2/J4: `cd content-engine && .venv313/bin/python -m pytest tests/ -q` PASS (114/114).
- J3/J4: `npx vitest run __tests__/scripts/audit-docs-cross-repo-resolver.test.ts` PASS (4/4); `bash scripts/workspace-docs-mirror.sh --check` PASS.
- P0 identity: `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts` PASS (23/23) on J1, J2, and J3/J4.

## Tech-debt Batch 14 — quick-win mechanical sweep + state-module isolation (2026-05-06)

Report: `docs/archive/2026-05/tech-debt-validation/codex-batch-14-remediation.md`

Branches:

- `feature/tech-debt-2026-05-k1-cost-per-mtk-consolidation` — engine source branch, commit `e448e437`.
- `feature/tech-debt-2026-05-k2-ios-date-formatters` — iOS source branch, commit `4bc6fe6`.
- `feature/tech-debt-2026-05-k3-named-scoring-weights` — engine source branch, commit `2850d47d`.
- K4 state-module isolation tests — **BLOCKED before branch** by a `saved_ideas` scoped-mutation bug.

Closure delta:

| Item | Status | Evidence |
|---|---|---|
| P1-13 `COST_PER_MTK` duplication | **CLOSED IN SOURCE BRANCH** | K1 centralizes Anthropic/OpenAI pricing in `engine/src/services/provider-pricing.ts`; full backend verify passed 456 files / 6,835 tests; P0 identity passed 23/23. |
| P1-17 iOS formatter proliferation | **CLOSED IN SOURCE BRANCH WITH BROAD-SUITE RISK** | K2 adds `Date+Formatters.swift`, `DateFormattersTests`, and the formatter cookbook. iOS build passed; focused formatter XCTest passed 5/5; constructor grep is reduced to helper implementation only. Broad iOS suite still fails 7 non-formatter tests and needs separate cleanup. |
| P2-32 inline scoring weights | **CLOSED IN SOURCE BRANCH** | K3 names notification/content scoring constants, adds `scoring-weights-rationale.md`, and passes focused tests plus full backend verify. |
| P2-24 state isolation tests | **BLOCKED / P0 FIX-FIRST REQUIRED** | Source inspection found `markIdeaPromoted(id)`, `markIdeaUsed(id)`, and `deleteIdea(id)` mutate `saved_ideas` by raw `id` only. K4 was test-only by prompt, so Codex stopped instead of adding failing tests or changing production code in the test slice. |
| P1-14 scheduler decomposition | **CLOSED IN SOURCE STACK BRANCH** | Batch 15 L0-L3 decomposed `engine/src/services/scheduler.ts` into a registry bootloader plus per-domain job modules. `scheduler.ts` is now 150 LOC with 0 inline `cron.schedule(...)` calls; inventory invariant pins 34 registry jobs / 33 telemetry jobs. Full backend verify passed 463 files / 6,845 tests. |

Required next fix-first branch for P2-24:

1. Change `engine/src/state/saved-ideas.ts` mutation helpers to require `userId` and mutate with `WHERE id = ? AND user_id = ?`.
2. Update `engine/src/services/content-workflow.ts` to pass the authenticated `userId` into `markIdeaPromoted`.
3. Add the K4 state isolation tests for `notes`, `reminders`, `saved-ideas`, and `todos` after the scoped mutation fix is in place.

Evidence:

- K1: `npx tsc --noEmit` PASS; focused provider-pricing/usage-metering/P0 identity tests PASS 55/55; full `npm run verify` PASS 456 files / 6,835 tests.
- K2: iOS `xcodebuild build` PASS; focused `DateFormattersTests` PASS 5/5; P0 identity PASS 23/23; broad `xcodebuild test` FAILS 1,247 passed / 12 skipped / 7 failed in unrelated contract/UI tests.
- K3: `npx tsc --noEmit` PASS; focused scoring/P0 identity tests PASS 29/29; docs:audit PASS 498 issues / 419 audited; full `npm run verify` PASS 456 files / 6,835 tests.
- Post-report docs:audit: 499 issues / 420 audited, within Batch 14's start-baseline +2 allowance but not a completion signal because K4 is blocked.

## Tech-debt Batch 15 — scheduler.ts decomposition (2026-05-06)

Report: `docs/archive/2026-05/tech-debt-validation/codex-batch-15-remediation.md`

Branch stack and merge order:

1. `feature/tech-debt-2026-05-l0-scheduler-inventory` — source branch commit `597849e2`; stack replay commit `2282f099`.
2. `feature/tech-debt-2026-05-l1-scheduler-wave-1` — `59320777`.
3. `feature/tech-debt-2026-05-l2-scheduler-wave-2` — `31569528`.
4. `feature/tech-debt-2026-05-l3-scheduler-wave-3-final` — `d8523505`.
5. `feature/tech-debt-2026-05-l4-batch-15-closure` — documentation closure on top of L3.

Closure delta:

| Item | Status | Evidence |
|---|---|---|
| P1-14 `scheduler.ts startScheduler` decomposition | **CLOSED IN SOURCE STACK BRANCH** | L0 captured 34 scheduled jobs / 33 telemetry jobs; L1-L3 moved all jobs through `scheduler-registry`; L3 reduced `engine/src/services/scheduler.ts` from ~1,407 LOC on L2 / 1,711 LOC in the original finding to 150 LOC. |

Evidence:

- `npx tsc --noEmit` PASS.
- Focused scheduler + P0 identity: PASS 49/49.
- Full backend `npm run verify`: PASS 463 files / 6,845 tests.
- `node scripts/audit-docs.mjs --json`: 486 issues / 426 audited after workspace mirror refresh, below Batch 15 L0 baseline (499 issues / 419 audited).
- Inventory invariant: registry contains all 34 baseline jobs, 33 telemetry-registered jobs, and `dst_watchdog` remains intentionally raw.

Residual scheduler policy:

- Add new cron jobs only through `engine/src/services/scheduler/jobs/<domain>.ts`.
- Preserve `registerJob` + `wrapJob` telemetry through `engine/src/services/scheduler-registry.ts` unless a job is explicitly raw like `dst_watchdog`.
- Felipe merge order must keep the stack order above, or merge L0-L4 together.

## Engineering excellence Codex validation refresh (2026-05-04 late)

Codex validation branch: `feature/engineering-excellence-codex-validation-20260504`.
Validation report: `docs/archive/2026-05/engineering-excellence-codex-validation-20260504/engineering-excellence-codex-validation.md`.

Verdict: **PASS WITH CONDITIONS** — standards/classifier layer verified; Codex fixed documentation drift in current release state and security standards. No runtime P0/P1 issue found in this engineering-standards pass.

### Validation delta

| ID | Severity | Status | Description |
|---|---|---|---|
| ENG-EXC-CX-O7 | P2 | **FIXED** | `CURRENT_RELEASE_STATE.md` still described 4.14.127 after the 4.14.129 production/staging align. Codex refreshed release scope/status and mirrored the workspace doc into engine. |
| ENG-EXC-CX-O8 | P2 | **FIXED** | `engine/docs/engineering/security-and-data-isolation-standard.md` still called AUTH-O4/O6/O7/O8/O10/O12 open after OPEN_ITEMS closed them. Codex updated the canonical standard to describe the current permanent controls. |
| ENG-EXC-CX-O9 | P3 | **FIXED** | Agent-process issue-ledger example reused live AUTH-O1/AUTH-O2 IDs and looked like stale state. Codex made the sample IDs generic and clarified generated identity vs manual rollout summary rules. |

### Evidence

- `npm run docs:audit`: **487 issues / 384 files** (within frozen baseline budget; +1 archive report).
- `engine/scripts/workspace-docs-mirror.sh --check`: PASS.
- `npx tsc --noEmit`: PASS.
- `__tests__/scripts/changed-area-classifier.test.ts`: PASS.
- `engine/scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: PASS.
- Representative routed suites for logger/secrets, scheduler, notifications, health integrations, rate limits, audit/admin scope, config/deploy health, prompt cleanliness, and P0 chat identity: PASS.

## Backlog drain pass — frontmatter hygiene + archive sweep + mobility catalog (2026-05-04 night, post-merge)

Engine branch: `feature/engineering-excellence-architecture-standards` @ `9a64df4` (NOT pushed).
iOS branch: `feature/engineering-excellence-architecture-standards` @ `ced1cb4` (NOT pushed).
Codex validation branch: `feature/closed-beta-backlog-drain-codex-validation` (required before opening the engine PR).
Backup tags preserved on both repos.

Verdict: **EXTENDED — frontmatter + archive sweep confirmed; mobility catalog required Codex fix before opening the engine PR.**

### What I shipped (commits `61f974a` + `626067b` + `612cf52` + `ced1cb4`)

**P3 frontmatter hygiene — CLOSED (`61f974a` + `ced1cb4`):**
- Added `Status: / Owner: / Last verified: / Update policy:` frontmatter to 22 high-value canonical docs (workspace AGENTS/CLAUDE/DOCS_INDEX/OPERATING_CONTEXT, engine 9 root docs, engine 7 release docs, engine QA report, iOS QA report).
- Codex's `audit-docs.mjs` engineering-frontmatter check already enforces the shape on `engineering/` paths; this extension unifies the shape across all canonical surfaces.
- `audit-docs.mjs` baseline went from 486 → 485 issues / 382 files (1 BELOW the frozen baseline of 486).

**P3 archive sweep — CLOSED (`626067b`):**
- Moved `engine/docs/release/archive/2026-04/training/training-release-fixes.md` into the release archive for consistency with the 8 already-archived release-candidate-* and production-release-final-status docs.
- Net effect: `markdown-outside-approved-current-or-archive-location` 227 → 226; `duplicate-or-scattered-current-verdict` 36 → 35.

**P2 training mobility-variant catalog — CLOSED (`612cf52`):**
- Added `cat_cow` and `childs_pose` to `engine/src/services/coach-kernel/knowledge/entities/exercises.json`. Catalog now has 12 mobility-pattern exercises.
- New module `engine/src/services/coach-kernel/mobility-recovery-builder.ts` (247 LOC) with two-pass selection (greedy-novel-buckets, then fill) producing 4-5 distinct exercises spanning ≥3 distinct `warmupNeeds`. Estimator-aware: per-rep math mirrors `session-coherence.ts` exactly. Falls back to null when catalog can't span 3 buckets — caller uses empty-block + shrink (existing behavior).
- Wired into `engine/src/services/coach-kernel/poor-recovery-variation.ts` mobility-variant branch.
- Effect: poor-recovery-day mobility sessions now claim AND deliver 18-25 min (was: empty-block shrunk to ~13 min).
- 16 new pin tests in `__tests__/services/coach-kernel-mobility-recovery-builder.test.ts`.

**Codex validation delta — EXTENDED (2026-05-04 night):**
- **MOBILITY-CX-O1 (P2) — FIXED on `feature/closed-beta-backlog-drain-codex-validation`:** `adaptSessionForPoorRecovery()` built the catalog mobility list, but `guardrails.ts` discarded strength mobility exercises before the full plan surfaced. A realistic low-readiness strength-athlete plan still produced `exerciseCount:0`, `duration:18`, `estimated:13` at `9a64df4`.
- Codex fix preserves `adaptation.session.exercises` for strength mobility variants and aligns `durationMinutes` to the estimator-derived mobility flow, clamped to the 18-25 minute band. End-to-end probe now produces two mobility sessions with `exerciseCount:4`, `duration:22`, `estimated:22`, all catalog-backed.
- Added regression coverage: builder test count is now **17/17** (adds the 4-candidates/1-bucket fallback pin), and poor-recovery planner-path tests fail against `9a64df4` without the source fix.
- **FRONTMATTER-CX-O1 (P3) — FIXED by mirror refresh:** initial Codex run found `workspace-docs-mirror.sh --check` failing on stale `release-identity.{json,md}` mirror files. Mirror is refreshed in the Codex validation branch after this validation report.
- Validation report: `docs/archive/2026-05/closed-beta-backlog-drain-codex-validation/codex-validation.md`.

### Verification

- `npx tsc --noEmit`: clean.
- `__tests__/services/coach-kernel-mobility-recovery-builder.test.ts`: **17/17 PASS** after Codex extension (constants lock-step, candidate filter, one-bucket fallback, builder bounds, integration with `estimateStrengthSessionMinutes`).
- Touch-risk regression: poor-recovery-variation 8/8 PASS, session-coherence 27/27 PASS, plan-linter 23/23 PASS, training-plan-persistence 14/14 PASS.
- Pre-commit hook (classifier-driven, mobility commit triggered focused training sweep): **893/893 PASS** across 69 files.
- `npm run docs:audit`: initial Codex rerun 488 / 382 due 2 stale mirror warnings; final post-refresh count **486 / 383**, inside the frozen-baseline budget of 486 ± 5.
- Workspace mirror: initial Codex check found stale release identity mirror; fixed by Codex validation branch refresh (`workspace-docs-mirror.sh --check` exits 0).

### Closure summary (cumulative across all 2026-05-04 sessions)

| ID | Severity | Status |
|---|---|---|
| AUTH-O2 | P0 | **CLOSED** |
| AUTH-O4..O12 | P1 | **CLOSED** (8 items, single batch + Codex hardening) |
| AUTH-CX-O3 | P3 | **CLOSED** (`2688b23` docs softening) |
| TR-EC-O10 / TR-EC-IOS-O3 | P1 | **CLOSED on physical iPhone E3** |
| TR-EC-O11/O12 | P1 | SHIPPED in main 4.14.128 |
| TR-EC-O13 | P1 | DECIDED + telemetry |
| TR-EC-IOS-O1/O2 | P1 | PRE-EXISTING / DECIDED |
| ENG-EXC-O6/O7/O9/O10 | P2/P3 | CLOSED |
| ENG-EXC-CX-O5/O6 | P2 | CLOSED |
| TR-EC-CX-O1 | P2 | REFUTED + closed (clean-simulator rerun) |
| **P3 frontmatter hygiene** | **P3** | **CLOSED** (this pass) |
| **P3 archive sweep** | **P3** | **CLOSED** (this pass) |
| **P2 training mobility-variant catalog** | **P2** | **EXTENDED / FIXED ON CODEX VALIDATION BRANCH** |
| MOBILITY-CX-O1 | P2 | **FIXED** (Codex validation branch; merge before opening engine PR) |
| FRONTMATTER-CX-O1 | P3 | **FIXED** (mirror refresh) |

### What still requires operator action

1. **Merge `feature/closed-beta-backlog-drain-codex-validation` into `feature/engineering-excellence-architecture-standards`, then open the engine PR.** Opening directly from `9a64df4` would ship the full-plan mobility discard bug.
2. **Open the iOS PR** from `feature/engineering-excellence-architecture-standards` (3 commits since main).
3. **Open-beta gate (E5)**: signed TestFlight walk-through with the new AUTH flows when ready. Closed-beta is fully satisfied by the E3 evidence in `engine/docs/release/testflight-evidence/`.

---

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
| AUTH-CX-O3 | NEW P3: attempt_count cap is documented as primary brute-force control but isn't reached for unknown tokens | Re-read service: with 256-bit token entropy, brute-force is infeasible by entropy alone — the cap is genuinely belt-and-suspenders against pathological clients hitting a known token row. **FIXED LATER:** `src/services/password-reset.ts` now presents the cap as defense-in-depth and names 256-bit token entropy as the primary control. | **CLOSED** (`2688b23` docs softening) |

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
| AUTH-CX-O3 | P3 | **CLOSED** (`2688b23` docs softening; `src/services/password-reset.ts` now documents the cap as defense-in-depth) |
| TR-EC-CX-O1 | P2 | **REFUTED** by Claude clean-simulator rerun (3/3+1 skip; 11/11 sister suite). Closed. |

### What remains operator-action

1. **Open the engine PR** from `feature/engineering-excellence-architecture-standards` AFTER merging the Codex validation branch in.
2. AUTH-CX-O3 is now closed in source: `src/services/password-reset.ts` presents the 5-attempt cap as defense-in-depth and 256-bit token entropy as the primary brute-force control.
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
| AUTH-CX-O3 | **CLOSED LATER** | Password-reset attempt-cap wording overstates the reachable behavior. `attempt_count` is enforced when pre-set, but normal invalid-token attempts do not increment any row. `src/services/password-reset.ts` now documents the cap as defense-in-depth and the 256-bit token entropy as the primary brute-force control. |

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
- `scripts/audit-docs.mjs` extended to register the new `engineering/` canonical paths and `docs/agent/AGENT_PROCESS_STANDARD.md`.
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
  - Workspace `engine/docs/engineering/ENGINEERING_STANDARDS_INDEX.md` documents the mirror contract.
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
| ENG-EXC-O6 | P2 | **FIXED LATER** (`1aa5955`, 2026-05-04 evening). | TestFlight evidence pattern at `engine/scripts/testflight-evidence.sh` — see Closed-beta evening pass for closure. |
| ENG-EXC-O7 | P2 | **FIXED LATER** (`1aa5955`, 2026-05-04 evening). | docs:audit baseline policy at `engine/docs/release/docs-audit-baseline-policy.md`. |
| ENG-EXC-O8 | P1 | **FIXED** (`ca4eed1`). | Workspace docs durability via `engine/docs/_workspace-mirror/` (one-way snapshot) + `audit-docs.mjs` drift detection + housekeeping wiring. 15 workspace docs mirrored. |
| ENG-EXC-O9 | P3 | **FIXED LATER** (`1aa5955`, 2026-05-04 evening). | Outbound markdown link lint enabled by extending `audit-docs.mjs` `isCurrentLike()` to engineering paths. |
| ENG-EXC-O10 | P3 | **FIXED LATER** (`1aa5955`, 2026-05-04 evening). | Standard deprecation workflow added to workspace `engine/docs/engineering/ENGINEERING_STANDARDS_INDEX.md`. |

### Codex validation findings (CX-O*)

| ID | Severity | Status | Description |
|---|---|---|---|
| ENG-EXC-CX-O1 | P1 | **FIXED** (`ca4eed1`). | Workspace docs are now mirrored into engine via `engine/scripts/workspace-docs-mirror.sh`; durability concern resolved. |
| ENG-EXC-CX-O2 | P1 | **FIXED, MERGED** (`799af5d`). | iOS navigation/DTO classifier sub-flags. |
| ENG-EXC-CX-O3 | P1 | **FIXED, MERGED** (`799af5d`). | Audit + deploy-config classifier flags. |
| ENG-EXC-CX-O4 | P2 | **FIXED, MERGED** (`799af5d`). | Engineering-standard frontmatter check. |
| ENG-EXC-CX-O5 | P2 | **FIXED LATER** (`1aa5955`, 2026-05-04 evening). | docs:audit baseline policy doc codifies frozen-baseline classes (227 outside-approved + 78 commit-hash + 73 test-count) vs actionable classes (broken-link + duplicate-verdict). Total budget: 486 ± 5. |

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
- Full `vitest run` after the batch: **6,639 / 6,640 PASS** in 65.8s. The 1 failing test (`__tests__/services/prompt-cleanliness.test.ts:160` referencing the now-archived `engine/docs/archive/2026-05/content/daily-content-discovery.md`) is a PRE-EXISTING artifact of the closed-beta-hardening commit `8bb7f34` that landed on the same branch ancestry. Verified by checking out `dadcbe0` (the production main before closed-beta hardening) — there the test passes 72/72. Documented as `TR-EC-O9` in the new training report's open items.

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
| TR-EC-O9 | P2 | (Pre-existing) `__tests__/services/prompt-cleanliness.test.ts:160` references `engine/docs/archive/2026-05/content/daily-content-discovery.md` archived by `8bb7f34`. Either restore the prompt-cleanliness check from the archive path or remove the test. |
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

- **Content Creation UI workflow follow-ups** (2026-05-04 vertical slice
  closeout — see `engine/docs/portal/content-portal-readiness.md` and
  `engine/docs/content/content-frontend-contracts.md`):
  - ~~**CONTENT-UI-O1**~~ → **DONE 2026-05-04**: migration `111_content_creator_profile.sql`,
    `src/state/content-creator-profile.ts`, REST routes
    `GET/PUT/DELETE /api/v1/content/creator-profile`, 15 backend tests,
    iOS round-trip via `ContentService.getCreatorProfile()` /
    `putCreatorProfile()` with offline-first local cache.
  - ~~**CONTENT-UI-O2**~~ → **DONE 2026-05-04**: migration
    `112_content_radar_feedback.sql`,
    `src/state/content-radar-feedback.ts`, REST routes
    `POST/GET /api/v1/content/radar/feedback`, 13 backend tests, iOS
    per-card accept/reject/save/create-brief buttons in
    `ContentIntelligenceView` with confirmation chip + Undo + error
    inline. Accessibility ids `content-idea-accept-button`,
    `content-idea-reject-button`, `content-create-brief-button`.
  - ~~**CONTENT-UI-O3**~~ → **DONE 2026-05-04**:
    `src/state/content-performance-aggregate.ts` aggregator (read-only
    over existing tables), admin route
    `GET /api/v1/admin/content/performance`, 8 backend tests, portal
    Performance card with KPI strip + highlights/warnings + top
    accepted/rejected topics (visible only when scope is active).
  - ~~**CONTENT-UI-O4**~~ → **DONE 2026-05-04**:
    `src/state/content-lifecycle.ts` canonical-12-stage mapper
    (`mapContentTopicStatusToCanonical` collapses 22 `ContentTopicStatus`
    cases into 12; `mapSavedIdeaStatusToCanonical` covers the legacy
    `saved_ideas` set; radar-feedback signals feed `accepted` /
    `rejected` buckets). Routes `GET /api/v1/content/lifecycle` (iOS,
    JWT) + `GET /api/v1/admin/content/lifecycle` (portal, scope picker).
    19 backend tests. iOS canonical lifecycle pill band on
    `PipelineDetailView`. Portal canonical lifecycle band inside the
    Content Pipeline card.
  - ~~**CONTENT-UI-O5**~~ → **DONE 2026-05-04**: portal browser-runtime
    smoke at `engine/scripts/content-portal-browser-smoke.mjs` — two
    modes: `--validate-only` (31 structural + JS-presence assertions, no
    browser, no engine) and Playwright live-smoke mode (boots Chromium,
    applies scope, asserts `x-nexus-user-id` / `x-nexus-tenant-id`
    headers ride along on `/api/v1/admin/content/*`). The validate-only
    mode is wired into the focused-test lane.
  - ~~**CONTENT-UI-O6**~~ → **DONE 2026-05-04**:
    `ios/Nexus Hub/Views/Content/ContentBriefEditorView.swift` — 12-field
    brief editor (objective, audience, platform, format, angle, source
    material, main points, claims, CTA, constraints, deadline, approval
    owner) with offline-first tenant-scoped `ContentBriefLocalStore`,
    `POST /api/v1/content/workflow/:id/actions` round-trip when a
    `contentObjectId` is attached. Brief nav card on Content Home
    (`content-brief-button`). Save button id `content-brief-save-button`.
  - ~~**CONTENT-UI-O7**~~ → **DONE 2026-05-04**: `TopicSchedulerView`
    now defaults to a 7-column week-grid view of the current + next 3
    weeks, with status-tinted topic chips, today highlight, mode picker
    (`topic-scheduler-mode-picker`) toggling to the legacy week-grouped
    list, and the unscheduled drawer below the grid. Accessibility id
    `topic-scheduler-week-grid`.
  - ~~**CONTENT-UI-O8**~~ → **DONE 2026-05-04**: `ios-specs/03-SCREENS-UI.md`
    Content section rewritten to match the shipped IA (Skills tab slot 3
    → ContentSkillView). Tab 5/More section is now marked **legacy**;
    new Tab 4: Skills section is normative. Includes accessibility ids,
    nav order, Profile/Voice editor, Brief editor, week-grid topic
    scheduler, canonical lifecycle band, and per-card Radar action
    contracts.

  Codex validation delta (2026-05-05): READY_WITH_CONDITIONS for local QA
  after second-pass fixes; archive evidence:
  `docs/archive/2026-05/content-creation-ui-codex-validation/codex-validation.md`.
  Added/fixed: iOS Radar `create_brief` now opens a seeded Brief editor;
  Content Home profile completeness refreshes backend state before rendering;
  sign-out clears new Content profile/brief local stores; portal scope controls
  work inside the IIFE; scoped Performance/Lifecycle panels load independently
  from the legacy content dashboard; portal smoke asserts live scoped route
  2xx responses; Performance aggregate now counts scripts using the real
  `content_scripts.created_at` schema. Verification: backend `tsc --noEmit`
  clean; 60/60 backend Content tests PASS across state/API suites; portal
  validate-only smoke PASS (38/38 assertions); portal live Chromium smoke PASS
  against local throwaway DB with 6 scoped V1 admin Content requests carrying
  tenant/user headers and 4 scoped panel endpoint responses returning 2xx; iOS
  `xcodebuild build-for-testing` PASS; iOS `ContentCreatorProfileTests` PASS
  (27/27). Remaining conditions: provider-backed semantic quality and
  tenant-facing portal profile/brief/script/calendar/memory workflows still
  require staging-safe or explicit follow-up validation. `docs:audit` baseline
  was 488 issues / 387 markdown files immediately before this validation
  report/update.

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
- Doc hygiene sweep on `engine/docs/training/release-candidate-*.md` and `engine/docs/release/archive/2026-04/training/production-release-final-status.md` — these were release-candidate evidence for v4.14.100 (2026-04-28) and now belong under `engine/docs/release/archive/2026-04/training/` per the canonical hygiene rule.
