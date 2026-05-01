# Nexus Hub Release Candidate Test Run

Generated: 2026-04-29

## Release Candidate

| Repo | Branch | Base commit at branch creation | Status |
|---|---|---:|---|
| Backend | `release/nexus-hub-production-candidate` | `34add9aa8b05c100b28a116fa12b920e118e4d15` | Local branch created; not pushed by this run |
| iOS | `release/nexus-hub-production-candidate` | `dd7e3e0163e5e3ee37360d3f0ffbaca54fdfb7a2` | Local branch created; not pushed by this run |

No staging or production deploy was performed in this test run.

## Verdict

**PASS WITH CONDITIONS for a release candidate.**

The backend regression suite, backend build, iOS unit/scheme tests, local full-product smoke, and focused iOS local smoke all completed successfully after fixing test mocks that had not been updated for the Chat context engine surface. This is not an unconditional production GO: staging deploy, focused staging Chat smoke, fresh production DB snapshot, and production health checks remain required before promotion.

## Fix Applied During RC Regression

The first full backend verification failed because several test mocks of `src/state/shared-memory` did not export `getSharedMemoryByScope`, which is now required by the Chat/Secretary context path. The production code was not changed for this fix; only affected test mocks were aligned.

Updated test files:

- `__tests__/services/chat-triggered-onboarding.test.ts`
- `__tests__/services/secretary-context.test.ts`
- `__tests__/integration/message-flow.test.ts`
- `__tests__/domains/secretary.test.ts`
- `__tests__/domains/domain-handler.test.ts`

Targeted rerun after the fix:

```bash
npx vitest run \
  __tests__/services/chat-triggered-onboarding.test.ts \
  __tests__/domains/domain-handler.test.ts \
  __tests__/integration/message-flow.test.ts \
  __tests__/domains/secretary.test.ts \
  __tests__/services/secretary-context.test.ts
```

Result: **PASS** - 5 test files, 136 tests.

## Regression Results

| Area | Command / method | Result | Evidence |
|---|---|---|---|
| Backend typecheck/lint alias | `npm run verify` | PASS | `verify` includes `npm run typecheck`; `lint` is an alias for typecheck in `package.json` |
| Backend unit/integration/security regression | `npm run verify` | PASS | 398 test files, 6,137 tests |
| Backend build | `npm run build` | PASS | TypeScript build plus portal/knowledge asset copy completed |
| Chat tenant isolation | Included in backend tests and local smoke | PASS WITH CONDITIONS | Tenant smoke: 12 pass, 2 partial, 0 fail |
| Chat day-to-day simulations | Included in local full-product smoke | PASS | 12 scenarios, average 1.94 / 2.00 |
| Chat evaluation harness | Included in local full-product smoke | PASS | 24 scenarios, average 1.99 / 2.00; 21 pass, 3 partial |
| Secretary scheduling/orchestration | Included in backend tests and local smoke | PASS WITH CONDITIONS | Local fixture paths pass; universal write-path ownership remains conditional |
| Training release tests | Included in backend regression suite | PASS | Training tests included in 6,137-test verify run |
| Calendar lifecycle tests | Included in backend regression suite and local smoke | PASS WITH CONDITIONS | Local lifecycle paths pass; universal provider repair remains conditional |
| Model-routing tests | Included in backend regression suite | PASS WITH CONDITIONS | Live routing preserved; off-path streaming/proxy attribution remains conditional |
| Shared context tests | Included in backend regression suite | PASS WITH CONDITIONS | Shipped paths pass; known shared-context tenant mesh gaps remain limited by release scope |
| Security / prompt-injection tests | Included in backend regression suite and local smoke | PASS WITH CONDITIONS | Fixture coverage passed; live provider prompt-injection smoke not run |
| Local full-product smoke | `scripts/full-nexus-local-engine.sh full-smoke` | PASS WITH CONDITIONS | See local smoke section below |
| iOS unit/scheme tests | XcodeBuildMCP `test_sim` | PASS | 922 total, 922 passed, 0 failed/skipped |
| iOS build and run | XcodeBuildMCP `build_run_sim` | PASS | App built, installed, and launched on iPhone 17 Pro simulator |
| iOS local smoke | Local backend + simulator launch args | PASS WITH CONDITIONS | Home and Chat connected to local backend; Chat fast path response rendered |
| Cleanup | `FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup` | PASS | No backend listener on port 8200; local smoke DB removed; app not running |

## Backend Full Verification

Final backend command:

```bash
npm run verify
```

Result:

- Typecheck: PASS
- Vitest: PASS
- Test files: 398 passed
- Tests: 6,137 passed

Backend build command:

```bash
npm run build
```

Result: PASS.

## Local Full-Product Smoke

Initial detached run found a local-environment issue:

- `scripts/full-nexus-local-engine.sh start` against a stale local DB failed with `SqliteError: duplicate column name: tenant_id`.
- The DB was reset with `FULL_NEXUS_RESET_DB=1`.

Successful local smoke sequence:

```bash
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
scripts/full-nexus-local-engine.sh start
scripts/full-nexus-local-engine.sh full-smoke
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
```

Result: **PASS WITH CONDITIONS**.

Summary:

- Authenticated API smoke: 13 / 13 passed.
- Chat tenant security smoke: PASS WITH CONDITIONS, 12 pass / 2 partial / 0 fail.
- Cross-skill fixtures: local fixture checks passed; staging runtime section remains intentionally blocked in local dry-run mode.
- Chat evaluation fixtures: PASS, average 1.99 / 2.00.
- Chat day-to-day simulation: PASS, average 1.94 / 2.00.

Conditional items:

- True same-user multi-workspace switching is not fully supported by the current iOS Chat ingress.
- Provider fallback was covered by tests/fixtures, not by a live provider failure path.
- WebSocket reconnect/streaming transport was not enabled and smoked as a production claim.

## iOS Regression And Local Smoke

Xcode test result:

- Simulator: iPhone 17 Pro
- Scheme: `Nexus Hub`
- Result: PASS
- Count: 922 total, 922 passed, 0 failed/skipped

Observed warnings that should remain tracked but did not fail the build:

- Main actor-isolated initializer warnings in `TrainingHomeViewStateBuilderTests.swift`.
- Swift 6 main actor isolated `Equatable` warnings in HealthKit/App Entitlement tests.
- Sendable closure capture warning in `ChatRepositoryTests.swift`.

Focused iOS local smoke:

1. Launched the app with:

```text
-nexus_debug_local_auth_import YES
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8200
```

2. Imported the local auth fixture from:

```text
/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.local/full-nexus/local-ios-auth.json
```

3. Confirmed Home loaded from the local backend with HTTP 200 responses for dashboard, notifications, billing, calendar, home, plan, content, cooking, finance, inbox, skills, tasks, and Chat history.

4. Opened Chat and sent the schedule shortcut. Chat returned:

```text
No events today - enjoy the free time.
```

with source metadata from the local calendar repository.

5. The iOS client safely rendered an unknown structured response kind (`local_grounded`) with fallback copy while preserving the main message.

Important local runner finding:

- Original finding: detached `start` mode could leave the simulator with a red "Could not reach Nexus Hub" / `NSURLErrorDomain Code=-1004` banner if the backend process exited.
- Follow-up fix: `scripts/full-nexus-local-engine.sh start` now launches `node dist/index.js` directly, records the actual Node PID, prints backend logs on readiness failure, and verifies the backend PID is still alive after the API readiness probe.
- Follow-up validation: `bash -n scripts/full-nexus-local-engine.sh && FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup && scripts/full-nexus-local-engine.sh start && sleep 3 && scripts/full-nexus-local-engine.sh health && scripts/full-nexus-local-engine.sh auth-token && scripts/full-nexus-local-engine.sh smoke && FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup && scripts/full-nexus-local-engine.sh status` passed; authenticated API smoke was 13/13 and no listener remained on port 8200 after cleanup.

## Post-Package Closure Fixes

Two left-behind RC polish items were closed after the initial package:

| Item | Fix | Validation |
|---|---|---|
| Detached local runner durability | `start` now launches `node dist/index.js` directly and verifies the backend PID after readiness. | Detached start + health + auth-token + smoke + cleanup passed, 13/13 authenticated API checks. |
| iOS `local_grounded` structured Chat metadata | iOS now treats `local_grounded` as a known metadata type, so local grounded facts/memory render without the unknown-type fallback card. | XcodeBuildMCP focused `ChatStructuredCardRenderingTests`: 3/3 passed. |

## Cleanup Confirmation

Final cleanup command:

```bash
FULL_NEXUS_RESET_DB=1 scripts/full-nexus-local-engine.sh cleanup
scripts/full-nexus-local-engine.sh status
lsof -nP -iTCP:8200 -sTCP:LISTEN || true
```

Result:

- Backend PID: none
- Backend running: no
- Backend listener: no
- Content engine: not running
- Local smoke DB removed
- Auth token absent
- No listener on TCP port 8200

The simulator app was also checked; there was no running `me.nexushub.app` process left to terminate.

## Release-Gate Conditions

The following remain required before production promotion:

1. Commit and push backend and iOS release branches.
2. Take a fresh production DB snapshot immediately before deployment.
3. Merge/deploy the exact backend RC commit to staging.
4. Run focused staging Chat smoke against that staging commit.
5. Run any scoped Secretary/calendar smoke required by release claims.
6. Promote to production only after staging smoke passes.
7. Run production health checks and verify monitoring for Chat, tenant auth, model-routing, iOS decode/render errors, duplicate messages/events, stale state, and provider/cost anomalies.
