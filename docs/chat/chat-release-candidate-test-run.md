# Chat Release Candidate Test Run

Date: 2026-04-29  
Release branch: `release/chat-tenant-safe-production-candidate`  
Mode: local/backend fixture-first, no production data, no deployment

## Summary

Result: **PASS WITH DOCUMENTED RELEASE CONDITIONS**

The final hardening pass closed one model-routing P1 by validating portal model pins against `MODEL_OPTIONS`, then ran the focused Chat release-candidate regression suite, typecheck, build, deterministic evaluation harness, day-to-day simulation, and whitespace diff check.

## Commands Run In This Pass

```bash
npm test -- --run __tests__/portal/portal-provider-routes.test.ts
```

Result: pass, 1 file / 8 tests.

```bash
npm test -- --run __tests__/services/chat-history-store.test.ts __tests__/state/user-isolation.test.ts __tests__/api/chat-history-routes.test.ts __tests__/api/chat-persistence.test.ts __tests__/api/chat-message-context.test.ts __tests__/api/chat-routes.test.ts __tests__/api/chat-message-degraded-response.test.ts __tests__/api/chat-message-execution.test.ts __tests__/api/chat-message-local-responses.test.ts __tests__/services/tool-executor.test.ts __tests__/services/context-engine.test.ts __tests__/services/shared-decision-context.test.ts __tests__/services/chat-context-engine.test.ts __tests__/services/chat-skill-orchestrator.test.ts __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/openai-provider.test.ts __tests__/services/gemini-provider.test.ts __tests__/router/classifier.test.ts __tests__/portal/chat-diagnostics.test.ts __tests__/portal/portal-chat-routes.test.ts __tests__/portal/portal-provider-routes.test.ts __tests__/services/chat-evaluation-harness.test.ts __tests__/services/chat-day-to-day-simulation.test.ts __tests__/services/user-data-export.test.ts __tests__/services/audit-trail.test.ts
```

Result: pass, 26 files / 683 tests.

```bash
npm run typecheck
```

Result: pass.

```bash
npm run lint
```

Result: pass. The current `lint` script delegates to `npm run typecheck`.

```bash
npm run chat:eval
```

Result: pass, 24 scenarios, average 1.99 / 2.00, 21 pass, 3 partial, 0 fail.

Partials:

- streaming interruption and retry
- provider fallback case
- operator-pinned model case

```bash
npm run build
node dist/tools/chat-day-to-day-simulation.js
git diff --check
```

Result: build pass; day-to-day simulation pass, 10 scenarios, average 1.93 / 2.00; whitespace diff check pass. A second `git diff --check` after documentation packaging also passed.

## Final Production-Release Hardening Addendum

Run after migration-history alignment and release-package restraint:

```bash
npm test -- --run __tests__/api/chat-message-request.test.ts __tests__/integration/message-flow.test.ts __tests__/domains/thin-wrappers.test.ts __tests__/regression/skill-extraction.test.ts __tests__/services/training-plans-tools.test.ts
```

Result: pass, 5 files / 304 tests. This closed the legacy test-contract drift from tenant-safe function signatures, valid scoped user IDs, and authenticated Training tool mutations.

```bash
npm run verify
```

Result: pass, 376 files / 5,939 tests.

```bash
npm run build
git diff --check
npm run chat:eval
node dist/tools/chat-day-to-day-simulation.js
```

Result: build pass; whitespace diff check pass; Chat eval pass with 24 scenarios, average 1.99 / 2.00; day-to-day simulation pass with 10 scenarios, average 1.93 / 2.00.

Release-copy scope check:

- Staging and production `IOS_WS_ENABLED` are unset, which resolves to false.
- `docs/chat/chat-production-release-notes.md` avoids live-provider quality/fallback/operator-pin claims.
- Release package avoids true workspace switching, streaming readiness, raw support-console, durable tool lifecycle, and durable attachment claims.

## Prior Evidence Read Into This RC

| Evidence | Result | Source |
| --- | --- | --- |
| Local full-product Chat smoke | Pass with documented limitations | `docs/local/chat-full-nexus-local-smoke-results.md` |
| Local cleanup confirmation | Pass | `docs/local/chat-local-cleanup-confirmation.md` |
| iOS Chat readiness | Ready for rich DTO/rendering/cache scope, partial for true tenant switch/streaming | `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/chat-ios-readiness.md` |
| iOS local smoke | Pass for local backend connectivity and rendering; partial for live streaming/multi-skill fixtures | `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/docs/ios/chat-ios-local-smoke-results.md` |
| Portal Chat readiness | Metadata-only diagnostics ready; raw content support not built | `docs/portal/chat-portal-readiness.md` |
| Security test results | No new P0 in REST Chat path | `docs/chat/chat-security-test-results.md` |

## Code Changes In Final Hardening

- `src/portal/provider-routes.ts`
  - Added provider role-tier model validation for `/api/model-config`.
  - `chat` and `secretary` roles accept only chat-tier models.
  - classifier and non-Secretary skill roles accept only classifier-tier models.
- `__tests__/portal/portal-provider-routes.test.ts`
  - Updated model option fixture to the real nested shape.
  - Added invalid model rejection and wrong-tier model rejection coverage.
- `docs/ai/model-routing-risk-register.md`
  - Closed `MR-P1-04`.
- `docs/chat/chat-open-items.md`
  - Marked portal model override value validation closed.

## Not Run In This Pass

| Item | Reason | Release Interpretation |
| --- | --- | --- |
| Real provider fallback/operator-pinned smoke | Avoided unapproved provider spend and no production data usage. | Required only for live-provider quality/fallback claims. |
| WebSocket/streaming transport smoke | Streaming remains gated off. | Keep disabled for this release. |
| Migration `084`/`085` predeploy clone rehearsal | Closed after RC packaging on 2026-04-29. | Staging-clone proof passed; fresh production snapshot remains required before deployment. |
| Full iOS simulator rerun | Existing iOS smoke/readiness docs were read; backend-only final hardening changed no iOS code. | Existing iOS evidence remains valid; live gaps remain documented. |
| Portal browser smoke | Backend portal diagnostics tests pass; no portal UI was added. | API-only metadata diagnostics ready. |

## Final Test Status

The backend Chat RC test surface is green for deterministic security, tenant scoping, route lifecycle, provider routing safety, portal diagnostics, day-to-day simulation, typecheck, and build.

Subsequent gate closure:

- `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql` staging-clone apply/restore rehearsal passed on 2026-04-29.
- Evidence: `docs/chat/chat-migration-084-085-rehearsal.md`.
- Staging and production `IOS_WS_ENABLED` are currently unset, and `src/config.ts` resolves unset to false.
- After adding deployed `082_training_session_identity_shape_hash.sql`, recovering `083_secretary_agenda_ledger.sql`, and renumbering Chat to `084`/`085`, a disposable local full migration-directory check passed: 90 migrations applied, `PRAGMA integrity_check=ok`, and `083`/`084`/`085` entries were present. The temporary DB was removed.

The RC remains conditional for production deployment only on deployment-time controls: take a fresh production DB snapshot immediately before deployment, keep WebSocket Chat disabled, deploy to staging first, and run a focused staging Chat smoke before production promotion. Live-provider/fallback quality, streaming, workspace switching, raw support-console, durable tool lifecycle, and durable attachment support are intentionally not claimed in the restrained REST Chat release package.
