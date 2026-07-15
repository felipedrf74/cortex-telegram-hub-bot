# Testing and QA Harness Standard

Status: canonical
Owner: QA + release lead
Last verified: 2026-07-15
Update policy: update when test categories, evidence requirements, or
risk-based test selection rules change. `config/test-policy.json` is the
machine-readable tier/disposition policy; `docs/release/README.md` describes
how its conditional release result is bound to an exact artifact.

This standard defines what "tested" means for Nexus Hub. It is grounded in
the no-launch-only-validation rule that closed the v4.14.118 incident,
the changed-area classifier at `scripts/changed-area-classifier.sh`,
and the Apple/OWASP guidance referenced in the iOS architecture and
security standards.

## 1. Test categories

| Category | Where | What it proves |
|---|---|---|
| **Unit** | `__tests__/services/`, `__tests__/utils/`, iOS `*Tests/` | Pure functions, decoders, derivations, view-model logic |
| **Integration** | `__tests__/api/`, `__tests__/portal/` | Route + service + repository wired to a copied, fully migrated SQLite test template |
| **Security** | `__tests__/security/`, `__tests__/scope/` | Tenant/identity isolation, prompt cleanliness, audit log emission |
| **Contract** | iOS `<DTO>DecoderTests.swift`, `__tests__/api/<route>.test.ts` | DTO shape, error envelope shape, idempotency semantics |
| **Local smoke** | `scripts/*-smoke.{sh,ts}`, `npm run smoke:*` | Multi-route sequence against a local backend |
| **Staging smoke** | `scripts/staging-smoke.sh` plus domain smokes | Production-shape checks against staging; count is release-dependent |
| **iOS XCUITest** | `Nexus HubUITests/` | SwiftUI workflow on simulator/device |
| **iOS interaction (manual)** | QA report walk-through | Physical-device tap/scroll/navigation responsiveness |
| **Production health** | exact-artifact promotion readiness + smoke evidence | Node `/health`, authenticated `/api/snapshot`, authenticated Content Engine, native SQLite integrity, stable PM2 cwd/SHA, and `current` symlink identity |
| **Drill** | `__tests__/**` + scripted on staging | Synthetic alerts, identity-scan strict, vi.mock completeness |

## 2. Test quality bar (must)

Every test must:

1. **Assert behavior, not shape only.** A test that only checks
   `expect(response.body).toBeDefined()` is non-evidence.
2. **Use frozen, named fixtures.** Inline `{ foo: 'bar' }` literals are
   acceptable for single-case tests; reused backend fixtures live in
   `__tests__/fixtures/`; iOS fixtures live in the iOS repo's test fixture
   folders.
3. **Mock all external APIs.** Tests that hit real network fail CI by
   policy. Use the SDK wrapper mocks (`vi.mock('@google/...', ...)`).
4. **Start from one fully migrated SQLite template per worker.** Use
   `createMigratedTestDatabase()` to copy its serialized bytes, or wrap a
   compatible test in a transaction that rolls back. Only migration-rehearsal
   tests may replay every migration from an empty database.
5. **Prefer dependency injection and explicit fakes.** Reset only state owned
   by the unit under test. Avoid `vi.resetModules`, partial module factories,
   and global-registry resets when a scoped provider/fake can express the
   dependency directly.
6. **Be deterministic.** A test that "sometimes passes" is broken;
   investigate via `--repeat 30` before merging.
7. **Be fast.** A unit test normally runs in <100 ms; integration setup must not
   replay the migration tree. No non-exempt deterministic test file may exceed
   10 s. Shared-runner wall-clock benchmarks belong in `test:benchmark`, not a
   correctness assertion.

## 3. `vi.mock` completeness (must)

Vitest uses a bounded four-worker fork pool. A partial module factory can still
replace unlisted exports with `undefined`, hide a real dependency boundary, and
make behavior depend on mock evaluation order.

1. **Every `vi.mock(modulePath, factory)` factory returns ALL exports**
   of the mocked module. Use `vi.importActual` to get the real exports
   and only override the ones the test needs.
2. **Run `scripts/vi-mock-completeness-lint.mjs` before merge when the diff
   changes mocked module boundaries.**
   Strict mode runs nightly; advisory mode runs per-PR.
3. **Do not use module resets as routine isolation.** Inject database,
   provider, clock, transport, or registry dependencies explicitly. Retain a
   module-boundary mock only when the boundary itself is the behavior under
   test.

## 4. Risk-based test selection (must)

`scripts/changed-area-classifier.sh` supplies changed-area risk and cannot-skip
classification. `scripts/select-vitest-files.mjs` combines that result with an
inert static source-to-test dependency graph and `config/test-policy.json`.
Candidate code is parsed as data and never evaluated to select tests.

The stable commands are:

| Command | Contract |
|---|---|
| `npm run test:fast` | Deterministic unit, schema, policy, and release-tooling subset; target ≤90 s. |
| `npm run test:changed -- --base <sha>` | Static changed dependencies ∪ critical ∪ cannot-skip/focused risks; unresolved production impact fails closed to all Vitest files. |
| `npm run test:critical` | Auth, tenant, migration, billing, provider fallback, public contract, release-safety, and production-regression set. |
| `npm run test:release -- --base <sha>` | Local release gate: Node/toolchain check, typecheck, build, migration rehearsal, selected Vitest, full Content Engine pytest, artifact validation, and inventory. |
| `npm run test:full:sharded` | Complete deterministic Vitest suite across four local shards; files with the `eval` disposition are excluded. |
| `npm run test:evaluate` | Exactly the files with the `eval` disposition: persona, provider-quality, subjective product, and long-running evaluation corpora. Runs on the scheduled/manual `evaluation.yml` workflow, outside release correctness evidence. |
| `npm run test:profile` | Full machine-readable timings and inventory under ignored `.local/`. |

These governed selections feed the Git hooks, CI matrix dispatch, and signed
exact-artifact evidence used by `scripts/release-operator.sh`.

The classifier maps changed files to:

- Recommended risk tier (T0–T6)
- Vitest mode and focused/cannot-skip globs
- XCTest mode (skip/focused) and class names
- Staging smoke domains (generic 17 + per-domain smokes)
- Cannot-skip safety gates (tenant-auth-security, etc.)

**Cannot-skip gates take precedence over minimization.** The release-candidate
workflow runs the exact `changed ∪ critical ∪ cannot-skip` selection only when
a successful full nightly no more than 36 hours old is an ancestor of the
candidate, used the same test-policy digest, and proves the complete Vitest
file set. Missing/stale/mismatched nightly proof, test-infrastructure changes,
removed tests, or unresolved production impact force the complete four-shard
suite. The full suite is therefore nightly/manual/conditional, not a routine
gate for every production artifact.

## 5. Two-user / two-tenant matrix (must)

Every new app-facing scoped read or write needs a matrix test:

```typescript
describe('<route> tenant isolation', () => {
  it('user A cannot read user B data', async () => {
    const userA = seedUser('a@test.invalid');
    const userB = seedUser('b@test.invalid');
    seedDataFor(userB, /* recognizable payload */);
    const res = await asUser(userA).get('/api/v1/<route>');
    expect(res.body).not.toContain(/* user B's payload */);
  });
});
```

The reference shape is
`__tests__/security/p0-chat-identity-isolation.test.ts`. Copy the seed/asUser
helpers; do not invent a new test infrastructure.

## 6. Account / tenant cache (iOS) (must)

Per the iOS architecture standard §5, every per-user repo has an
`ensureCurrentScope()` method that drops the cache when the
`user-<id>.tenant-<id>` scope changes.

Tests required:

1. **`AuthManager.logout()` invalidates every per-user cache.** Test:
   sign in as A, populate caches, sign out, sign in as B, assert B's
   reads do not return A's data.
2. **`MainTabView` re-mounts on auth flip.** Test: assert the
   `AuthManager` instance count stays at 1 across an account switch
   (no leaked instance retains pre-switch state).
3. **`ChatRepository.ensureCurrentScope()` resets messages on scope
   change.** Test: scope A populates, scope flips to B, message store
   is empty.

The `Nexus HubTests/AuthManagerFixtureLeakTests.swift` is the
reference test for fixture-scoped account isolation.

## 7. Calendar and agenda lifecycle (must, when calendar, Training, or Secretary scheduling code is touched)

Calendar bugs are uniquely insidious because state lives in two systems
(SQLite + Google/Outlook) and a stale cross-reference looks fine
locally. Tests required when calendar or agenda code is touched:

1. **Training plan create → events created**, all events owned by the plan
   (`training_agenda_event_ownership` rows).
2. **Training plan cancel → events deleted** (or marked `'orphaned'` with
   reason).
3. **Training plan re-create with same plan_id but new plan_version** — new
   events are created; old events are linked to the previous plan
   version, not the new one.
4. **Provider-side delete reconciliation**: a calendar event deleted
   in Google does not leak as an "active" session in SQLite.
5. **Stale calendar-link detection**: a session marked `synced` but
   missing the provider event surfaces as `unsynced` in the iOS read
   model.
6. **Secretary scheduling intent persistence**: `submitSecretarySchedulingIntent`
   creates or reuses exactly one `secretary_agenda_items` row for the
   `(ownerUserId, tenantId, sourceSkill, sourceIntentId)` scope.
7. **Secretary provider sync lifecycle**: provider create/update/retry/delete
   uses exact provider event IDs, cleans duplicates, repairs missing provider
   events, and leaves `provider_sync_state` recoverable on failure.
8. **Cross-skill feedback**: Training, Cooking, Finance, and Content requests
   that route through Secretary retain source attribution and tenant scope.

Reference test files include:

- `__tests__/api/training-plan-calendar-sync.test.ts`
- `__tests__/services/secretary-scheduling-arbitrator.test.ts`
- `__tests__/services/secretary-agenda-provider-sync.test.ts`
- `__tests__/services/scheduler-secretary-agenda-sync.test.ts`

Provider-live testing requires dedicated non-prod Google/Outlook OAuth
credentials and explicit staging write gates. Until provisioned,
deterministic fixture/no-write coverage substitutes, and live-provider proof
must be reported as blocked rather than implied.

## 8. Provider fallback (must, when routing code touched)

Required tests when `providerRouting`, `tool-executor`, or any SDK
wrapper changes:

1. **Primary success path** — Gemini returns, no fallback fires.
2. **Primary timeout, fallback success** — Anthropic is invoked,
   `provider.fallback` log emitted, response returned.
3. **Both primary and fallback fail** — OpenAI is invoked (secondary
   fallback), then if all fail, the error envelope is returned with
   `degraded: true`.
4. **Per-user cost cap reached** — request returns `429 RATE_LIMITED`
   without calling any provider.
5. **Tool filter applied per task type** — a tool not authorized for
   the active task type is not exposed to the model.

## 9. Prompt context isolation (must, when prompt or context code touched)

1. **`buildKnowledgePromptBlock(userId)`** called twice with different
   userIds returns two different prompt blocks (no shared state leak).
2. **`creator_profile.felipes_angle` legacy field is read but with
   `nx-allow-identity-scan` annotation**, AND the new `creator_angle`
   field is preferred.
3. **`closed-beta-identity-scan --strict`** returns 0 flags on the diff.

## 10. Migration tests (must, when migrations touched)

1. **The dedicated migration rehearsal applies every migration to a fresh
   DB.** This is the one correctness lane that must start empty and execute the
   complete production runner.
2. **Migration applies cleanly to a fixture DB matching last
   production state.** Test fixtures under
   `__tests__/migrations/fixtures/` represent prior schemas.
3. **Migration is idempotent** if it can re-run during deploy retries.
4. **Down-migration applies cleanly** for any reversible migration.
5. **Migration rehearsal job runs nightly.**
6. **Partial-schema replay is tested for additive migrations that may have
   been self-healed at runtime.** If a migration adds columns later referenced
   defensively by startup code or tests, include fixtures for "column already
   exists" and "previous migration applied only" cases.
7. **All other database tests copy the migrated template or roll back a
   transaction.** `npm run test:migration-hook-lint` rejects full migration
   execution from per-test hooks. Do not add a private migration replay helper
   to bypass the guard.

## 11. iOS unit / contract tests (must, when iOS code touched)

Per the iOS architecture standard §6 (DTO contract):

1. **Every server enum has a `.unknown(rawValue:)` test case.**
2. **Every decoder has a "field absent" test.**
3. **Every decoder has an "end-to-end realistic payload" test.**
4. **Every view-model has a "state transition" test** for any state
   it owns.
5. **Every account-switch-relevant cache has a "fixture leak" test**
   modeled on `AuthManagerFixtureLeakTests`.

## 12. iOS XCUITest (must, when UI workflow touched)

1. **Pin simulator UDID via `IOS_REQUIRE_UDID=1`.** Name-only matching
   is back-compat-only and warns loudly.
2. **Every tappable surface in the workflow has an accessibility
   identifier** (per the iOS architecture standard §7).
3. **Tests are sequential, not parallel.** SwiftUI navigation state on
   a single simulator is fragile under concurrent runs.
4. **Test runs include simulator log capture on failure** (14-day
   artifact retention).

The reference test file is
`Nexus HubUITests/TrainingFixtureBypassUITests.swift`. Its fixture-bypass
strategy avoids provider dependency; copy that pattern.

## 13. Isolated Training E2E lane (must, when Training plan generation, calendar sync, feedback, progression, or iOS Training surfaces are touched)

Training spans backend generation, calendar ownership, read models, and iOS
Today/Plan/Progress surfaces. Evidence must prove the tested app used the
fresh target worktree, not another local engine or simulator.

Use the isolated harness:

- `npm run training:e2e:up`
- `npm run training:e2e:smoke`
- `npm run training:e2e:flow`
- `npm run training:e2e:ios`
- `npm run training:e2e:live-calendar` when, and only when, the run was
  started with explicit live sandbox calendar authorization.
- `npm run training:e2e:down`

Required evidence:

1. **Fresh backend/content containers from target HEAD.** Record git SHA,
   compose project, image IDs/digests, `/api/snapshot`, backend/content
   ports, DB path, and state directory from `.local/training-e2e/<run-id>/`.
2. **No default or shared ports.** The lane refuses 8200/8100 and uses
   project-scoped compose state plus isolated data/log mounts.
3. **Provider-safe default.** Fixture/no-write mode is the default.
   `TRAINING_CALENDAR_WRITES_ENABLED=false` and
   `TRAINING_CALENDAR_SYNC_ENABLED=false` stay in the E2E compose file unless
   Felipe explicitly authorizes live provider writes for a named run.
4. **Dedicated simulator.** iOS E2E must run with `IOS_REQUIRE_UDID=1`,
   unique DerivedData/result-bundle/summary paths, and
   `IOS_SHUTDOWN_OTHER_SIMS=0`. Cleanup is UDID-specific; do not globally
   shut down simulators that may belong to another worktree.
5. **Active-plan seed for iOS assertions.** `npm run training:e2e:ios`
   pre-seeds a backend-generated active plan through
   `scripts/training-e2e-ios-seed.mjs prepare`, then cancels only that
   seeded plan after simulator assertions unless
   `NEXUS_TRAINING_E2E_IOS_KEEP_SEEDED_PLAN=1` is set for debugging.
   This seed is not a replacement for the fixture-safe backend lifecycle
   flow; it exists so XCUITest can inspect real remote Training content.
6. **Base URL proof.** iOS tests must receive `NEXUS_TRAINING_E2E_BASE_URL`
   from the isolated run metadata and must reject default `127.0.0.1:8200`
   evidence.
7. **Workflow coverage.** The flow must cover first-run/profile gate, plan
   preview/review, generation, activation, Today rendering, Plan roadmap,
   Progress, complete/skip/partial feedback, easy/normal/hard feedback,
   soreness/pain signals, repeated misses, reflow/swap, calendar sync state,
   stale/degraded states, cancel/no-plan recovery, and read-model verification.
8. **Quality scenarios.** Plan-quality evidence must include beginner gym,
   intermediate hypertrophy, hybrid run + strength, cycling + gym,
   swim/triathlon, travel week, limited-time week, injury/discomfort, poor
   adherence, fatigue/plateau, stale wearable, no wearable,
   calendar-conflicted, and race-prep personas. Fail the gate if plans are
   generic, unsafe, incoherent, repetitive, unschedulable, or lack rationale.

Provider-live calendar lifecycle proof remains separate from fixture-safe E2E:
activation, retry idempotency, cancellation/replacement cleanup, disconnect
degradation, external delete/move repair-needed state, and duplicate prevention
require dedicated non-prod provider credentials plus explicit owner
authorization.

Live sandbox execution starts the same isolated container lane but with a
local-only compose override generated under `.local/training-e2e/<run-id>/`.
Required operator environment:

```bash
NEXUS_TRAINING_E2E_LIVE_CALENDAR=1
NEXUS_TRAINING_E2E_LIVE_CALENDAR_ACK=sandbox-non-prod-calendar
NEXUS_TRAINING_E2E_LIVE_CALENDAR_PROVIDERS=google,outlook
NEXUS_TRAINING_E2E_GOOGLE_ACCOUNT_LABEL=<sandbox/test/e2e label>
NEXUS_TRAINING_E2E_GOOGLE_REFRESH_TOKEN=<sandbox refresh token>
NEXUS_TRAINING_E2E_OUTLOOK_ACCOUNT_LABEL=<sandbox/test/e2e label>
NEXUS_TRAINING_E2E_OUTLOOK_REFRESH_TOKEN=<sandbox refresh token>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OUTLOOK_CLIENT_ID=...
OUTLOOK_CLIENT_SECRET=...
OUTLOOK_TENANT_ID=...
OAUTH_ENCRYPTION_KEY=...
```

The live lane must abort if the backend URL is the default local engine, if
the DB path is outside `.local/training-e2e/`, if production-looking account
labels are supplied, or if provider tokens are missing. The harness seeds
tokens into the isolated E2E user through the OAuth token store and leaves
global owner refresh-token env vars empty inside the container. Cleanup must
query provider calendars by the run marker and fail if any run-owned event
remains.

## 14. Smoke matrix

The closed-beta smoke matrix is the umbrella that aggregates per-domain
smokes. Today (`scripts/closed-beta-smoke.sh`) it includes:

- Identity scan strict
- Generic staging smoke (check count is release-dependent; recent releases
  have used 19, 22, and 26 checks)
- Training cross-skill staging smoke
- Training calendar staging smoke
- Training full-flow staging smoke
- Cooking portal browser smoke
- Content full Nexus local smoke
- Decision Center notification smoke where the changed area touches decision
  delivery, notification count, or iOS decision surfaces
- Secretary agenda/provider smoke when the changed area touches
  `secretary-scheduling-arbitrator`, `secretary-agenda-provider-sync`,
  scheduler agenda sync, calendar provider adapters, or cross-skill scheduling

Adding a new domain smoke requires:

1. A wrapper through `scripts/with-smoke-evidence.sh` so JSON
   evidence is written.
2. A line in `closed-beta-smoke.sh`.
3. A line in the classifier output for the relevant changed area.
4. A documented no-live-provider fallback when the smoke can run safely with
   fixture adapters, plus a separate live/sandbox lane gated by explicit
   staging env and cleanup identities.

## 15. Performance regression (should)

Per the iOS architecture standard §4, hang fixes require physical
device proof. The recommended additions to lock these in:

1. **A perf-regression XCUITest** that asserts a critical interaction
   completes in under N ms on a known-good simulator. Today this is
   informal; promoting to an enforced matrix is a future improvement.
2. **Backend algorithmic performance uses the benchmark lane.** Warm up,
   collect repeated samples, and compare p95 with a governed baseline. A raw
   shared-runner assertion such as "50,000 events in <1 second" must not fail
   correctness CI.

## 16. Stale or skipped tests

Tests are removed only when:

1. The behavior they assert is removed from production AND every other
   test that asserted overlapping behavior continues to pass.
2. The test was skipped (`it.skip` / `xit`) for >30 days. Skipped
   tests rot. A skipped test must have an OPEN_ITEMS entry within
   one week or be removed.
3. A test that "tests itself" (asserts its own mock) is removed
   without ceremony.

## 17. Evidence requirements (per change)

Every PR records, in the description or the QA report:

```
Tests added/modified: <count> in <files>
Tests run locally:
  - typecheck: <pass | fail>
  - focused vitest: <count pass / count total>
  - release Vitest tier: <changed-critical-cannot-skip | full-sharded>
  - selected/full vitest: <count pass / count total>
  - iOS xcodebuild: <pass | fail>
  - iOS focused XCTest: <count pass / count total>
  - iOS XCUITest: <count pass / count total>
  - simulator/device: <UDID + iOS version>
Evidence level (iOS): <E1 | E2 | E3 | E4>
Two-user matrix (if applicable): <added | already-covered | not-applicable>
Smoke evidence (if backend): <smoke-evidence file path>
```

A "tests passed" claim without this block is not actionable evidence.

## 18. Forbidden test patterns

- ❌ Tests that import from the source under test using a relative path
   that goes through `index.ts` re-exports — masks circular import
   bugs at runtime.
- ❌ Tests that call `process.exit()` or `console.log` to "verify".
- ❌ Tests that depend on test execution order. Use `beforeEach` to
   reset state.
- ❌ Tests that assert against a literal `Date.now()` — use a frozen
   clock helper.
- ❌ Tests that mock the function they claim to test.
- ❌ Full migration execution in `beforeEach`/per-test setup; copy the migrated
  template or use transaction rollback.
- ❌ Routine `vi.resetModules` or global-registry resets where dependency
  injection and an explicit fake can isolate the behavior.
- ❌ XCUITest that taps a coordinate instead of an accessibility id.
- ❌ Smoke scripts that pass when the backend is offline.

## 19. PR checklist (testing-relevant)

- [ ] Every new test has a clear "what does this prove" sentence in the
      describe/it block.
- [ ] Test follows §2 quality bar.
- [ ] Mocks are complete (`vi.mock` factory returns all exports).
- [ ] Two-user matrix added for new scoped surfaces.
- [ ] Calendar/provider/migration tests added when those areas
      touched.
- [ ] Secretary agenda/Decision Center lifecycle tests added when those
      surfaces are touched.
- [ ] iOS DTO test added for new DTO fields.
- [ ] iOS XCUITest added for new tappable workflows.
- [ ] Evidence block present in PR description or QA report.
- [ ] `npm run test:migration-hook-lint` passes after database-test changes.
- [ ] Release evidence names the selected conditional tier and exact test-file
      identity rather than relying on a raw test-count floor.
