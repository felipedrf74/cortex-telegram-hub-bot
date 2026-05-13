# Wave 1 Full-Scan Hardening — Round 7 hostile validation

Date: 2026-05-13
Reviewer: Claude (opus, max effort)
Codex closeout reviewed: `docs/archive/2026-05/wave1-fullscan-hardening/report.md`
Round 0 baseline: `docs/release/full-system-scan-2026-05-13.md`

## Round 7 result: **GO_WITH_CONDITIONS**

Both P0s closed cleanly. 17 of 19 P1s closed cleanly. **One P1 fix (S5) introduced a new client-side leak**, and **one existing test was not updated to match the P1-T3 scope change**. Both are mechanical 30-minute fixes that Codex must close before Felipe ships. Once those two land, this becomes GO.

## Per-finding verification

| ID | Codex claim | Source check | Test check | Verdict |
|---|---|---|---|---|
| P0-1 PrivacyInfo.xcprivacy | created + project membership + plutil OK + test | file exists 3932 B; `plutil -lint`: OK; `project.pbxproj:30, 88`; `PrivacyManifestTests.swift:3` asserts `NSPrivacyTracking==false` + `NSPrivacyTrackingDomains==[]` | iOS privacy tests PASS on iPhone 17 Pro | ✅ CLOSED |
| P0-2 GDPR audit log | export `:267`, delete `:289` | export logAudit at `settings.ts:267` w/ `action:'export'` + `tableCounts` + `exportErrors`; delete logAudit at `:289` w/ `action:'delete'` + `tableCounts` + `ipAddress: req.ip` | settings-routes.test.ts in vitest sweep PASS | ✅ CLOSED |
| P1-T1 signals routes scope | `:40, :69, :124` | `intelligence-routes.ts` uses `scope.userId/tenantId` at `:73, :77, :92, :133` | portal-intelligence-routes.test.ts PASS | ✅ CLOSED |
| P1-T2 dismissSignal scope | `:637` | `intelligence-bus.ts:637` accepts `(signalId, userId?, tenantId?)` with `hasTenantColumn` guard + `resolveSignalTenantId` | intelligence-bus.test.ts PASS | ✅ CLOSED |
| P1-T3 pillar routes scope | `:696, :720, :764, :799` | GET `:696`, DELETE `:798` both call `resolvePortalContentScope(req, res, true)` + `contentScopePredicate()` w/ bound params | **content-admin-write-auth.test.ts FAILS — stale test (R7-NEW-001 below)** | ⚠️ CLOSED with test-update regression |
| P1-T4 tenant_id on logging tables | migration 124 | `migrations/124_tenant_scope_logging_tables.sql` adds `user_id+tenant_id` to error_log, `tenant_id` to client_errors, + 3 indexes | error-monitor.test.ts PASS | ✅ CLOSED |
| P1-T5 Garmin per-user SSO | `:191-:230, :270` | `LEGACY_SSO_COOKIES_FILE` retained at `:191`; per-user via `garminUserTokenDir(userId)` at `:207`; `warnLegacyGarminPersistenceOnce` at `:270, :294` | garmin-passive-auth.test.ts PASS | ✅ CLOSED |
| P1-S1 Garmin read logging | `:1270` | `logGarminReadFallback(err, url, opts)` at `:1270`; applied to user-summary, sleep, stress reads (and more) | garmin-passive-auth.test.ts PASS | ✅ CLOSED |
| P1-S2 export safeAll | `:182-:196` | `exportErrors.push(table)` + `logger.error({err, table, sql.slice(0,80)})`; `userData._exportErrors` populated via `[...new Set(exportErrors)]`; export audit log includes `exportErrors` in details | settings-routes.test.ts PASS | ✅ CLOSED |
| P1-S3 verification email | `:875` | `.catch((err: unknown) => logger.error({err, userId: user.id, email: user.email}, 'Verification email send failed'))` at `auth.ts:875` | auth-routes.test.ts PASS | ✅ CLOSED |
| P1-S4 APNs token load | `:251, :261` | `apns-sender.ts:251` `throw err`; `recordPushTokenLoadFailure` calls `recordOperatorAlert({severity:'warning', source:'apns', dedupeKey:'APNS_TOKEN_LOAD_FAILED:${userId}'})` | apns-sender.test.ts PASS | ✅ CLOSED |
| P1-S5 Decision Center error rewrap | `:965-:976` | `logger.error({err, decisionId, actionId, userId, tenantId})` BEFORE rewrap; `originalCode`+`originalMessage` attached to `details` | decision-center.test.ts PASS — but see **R7-NEW-002 below** | ⚠️ CLOSED with NEW LEAK |
| P1-P1 SQLite PRAGMAs | `:83-:89` | `synchronous=NORMAL`, `cache_size=-65536`, `mmap_size=268435456`, `temp_store=MEMORY`, `wal_autocheckpoint=1000` all present | tsc + sweep PASS | ✅ CLOSED |
| P1-P2 notification_release transaction | `:788` | `updateReleasedLogs = db.transaction(...)` at `:788` | notification-orchestrator.test.ts PASS | ✅ CLOSED |
| P1-P3 notification dedupe UNIQUE | migration 125 | ROW_NUMBER() OVER PARTITION dedup + `CREATE UNIQUE INDEX … WHERE dedupe_key IS NOT NULL AND status != 'expired'` (mirrors migration 122 pattern) | notification-orchestrator.test.ts PASS | ✅ CLOSED |
| P1-A1 prompt sanitizer | `:14-:48` | 9 patterns added (im_start/end, `### Instruction:`, `<system>`, `ignore (previous|above)`, `disregard/forget`, `you are now`, `role-play`, `pretend you/to be`); truncation now logs `originalLen` warn | prompt-sanitizer.test.ts PASS | ✅ CLOSED |
| P1-A2 tool result wrapping | `tool-executor.ts:178, :206` | `wrapToolResultContent` wraps via `<untrusted_tool_result>` framing + sanitizes via JSON.parse(sanitizeForPromptInterpolation); applied recursively to `UNTRUSTED_TOOL_RESULT_FIELDS` set | tool-executor.test.ts PASS | ✅ CLOSED |
| P1-O1 Garmin /tmp gate | `:233, :239, :544` | `process.env.GARMIN_DEBUG_DUMP !== 'true'` early-return; writes to `./data/private` with mode `0o600`; thrown error path scrubbed | garmin-passive-auth.test.ts PASS | ✅ CLOSED |
| P1-O2 iOS WebSocket disconnect | AppState `:603`, AuthManager `:521`, WebSocketManager `:94` | `WebSocketManager.shared.disconnect()` at both call sites; disconnect() cancels timers/tasks/session | iOS suite TEST SUCCEEDED | ✅ CLOSED |
| P1-O3 api_usage retention | `:897` | `{ table: 'api_usage', days: 180, tsCol: 'ts' }`; also added `email_log` 60d (closes O4 retention) | error-monitor.test.ts PASS | ✅ CLOSED |
| P1-O4 email_log redaction | `:19, :25` | SHA256(recipient).slice(0,16) at `:19`; subject truncated to 40 + `(N chars)` summary at `:25` | error-monitor.test.ts PASS | ✅ CLOSED |
| P1-X1 Sentry options | `:87-:89` | `sendDefaultPii: false`, `replaysSessionSampleRate: 0`, `replaysOnErrorSampleRate: 0`, `attachStacktrace: true`, `maxBreadcrumbs: 30` | error-monitor.test.ts PASS | ✅ CLOSED |
| P1-X2 cron reqId/timezone | scheduler.ts cited sites | `{ timezone: tz }` added to the 8 cited tz-less `cron.schedule` sites; `wrapJob` AsyncLocalStorage retained | error-monitor.test.ts PASS | ✅ CLOSED |

## R7 new findings (regressions introduced by the fixes)

### R7-NEW-001 — Stale test not updated for P1-T3 scope tightening (P2)

**File**: `__tests__/api/content-admin-write-auth.test.ts:266-292` (`sanitizes portal admin write failures instead of leaking internals`).

**Symptom**: test expects `res.status === 500` from a GET `/pillars` call that mocks the DB to throw `sqlite exploded`. The P1-T3 fix correctly added `resolvePortalContentScope(req, res, true)` to GET `/pillars` at `content-admin-write.ts:696`. With no scope context in the test setup, the route returns 400 BEFORE reaching `mockDbAll`, so the DB-error-sanitization path is never exercised.

**Impact**: the production code is correct (scope is enforced). The TEST is asserting the old un-scoped reach-DB behavior. Codex's closeout claimed the focused sweep passed, but my independent run found this single stale-test failure.

**Recommendation**: update the test to either (a) provide a scope context so the route reaches the DB mock, or (b) split into two tests — one for "without scope → 400" and one for "with scope, DB throws → 500 sanitized".

**Status**: open — Codex must close before GO.

### R7-NEW-002 — P1-S5 fix leaks original error message to client via `DecisionActionError.details` (P1)

**File**: `src/services/decision-center.ts:968-971` — `new DecisionActionError(..., { originalCode, originalMessage })`.

**Symptom**: the original Codex prompt said: *"Do NOT expose the original message to the client response — log only."* Codex put `originalMessage` into `DecisionActionError.details`. Both the API route handler `src/api/routes/decisions.ts` (`decisionError` → `sendError(res, err.code, err.message, err.status, err.details)`) and the portal handler `src/portal/decision-center-routes.ts:sendDecisionError` serialize `err.details` to the client. Original error message is therefore reachable in production.

**Impact**: any downstream throw (DB error, third-party API error, validation message) becomes visible to authenticated clients of the decision-action endpoint. Could leak internal table names, SQL fragments, third-party error codes, or stack-trace strings depending on the source error.

**Recommendation**: either (a) move `originalCode`/`originalMessage` into a non-serialized field on `DecisionActionError` (e.g., `internalDetails: object`) and update `decisionError`/`sendDecisionError` to NOT serialize it, or (b) strip `originalMessage` from `details` in the error-rewrap site at `decision-center.ts:968` and rely solely on the `logger.error` line for triage.

**Status**: open — P1 regression, Codex must close before GO.

## Independent test results

- `npx tsc --noEmit`: **PASS** (exit 0)
- Engine focused vitest (Codex's focused sweep): PASS except the stale pillar-scope test called out in R7-NEW-001
- iOS xcodebuild test (PrivacyManifestTests on iPhone 17 Pro A0B13967, iOS 26.4.1): PASS, TEST SUCCEEDED
- `npm run docs:audit`: PASS at the active issue ceiling

## Probe results (gaps NOT introduced)

- **Did sanitizer expansion produce false positives on legitimate copy?** Low risk. Patterns like `/pretend (you|to be) /` could match informal user copy ("pretend you understand"), replacing with `[removed instruction-like text]` — minor UX impact, no security issue. Acceptable trade-off.
- **Did migrations 124 and 125 work on fresh+existing DBs?** 124 uses `ADD COLUMN` (idempotent, NULL backfill). 125 uses the migration-122 ROW_NUMBER() pre-flight pattern proven in Round 4. Safe.
- **Did PrivacyInfo declare what app actually collects?** Declares Email, Name, Health & Fitness — matches the app's auth + Garmin + Apple Health collection. Does NOT declare "Financial Info" despite a finance skill (Stripe, invoices) — minor under-declaration risk. Worth a follow-up to add `NSPrivacyCollectedDataTypeOtherFinancialInfo` linked-to-user purpose=AppFunctionality if Stripe is wired.
- **Did audit log fire on partial-failure deletion paths?** Code path: `deleteAllUserDataForAccountDeletion(userId)` runs the cascade then returns `tableCounts`. If it throws, the outer `catch` (settings.ts) returns 500 and logAudit is NEVER called. This is correct per GDPR Article 17(3)(e): the audit row should reflect a successful deletion, not an attempt. Acceptable.
- **Did Sentry options break event flow?** `sendDefaultPii: false` was the existing implicit default; making it explicit doesn't change behavior. `replaysSessionSampleRate: 0` — no replays SDK installed; null-op. Safe.

## Cleanup

- Simulators: shut down (`xcrun simctl list devices booted` empty).
- Ports 8200, 8201, and 8203: clear.
- xcodebuild/vitest/tsx processes: none remain.
- xcresult preserved at `docs/release/qa-evidence/round7-validation-ios-results.xcresult`.
- Engine + iOS dirty state: PRESERVED. Codex committed nothing to feature/wave1-fullscan-hardening; all changes are in working tree per closeout note.

## Acceptance gate scorecard

| Gate | Status |
|---|---|
| Both P0 findings closed at source + test level | ✅ PASS |
| ≥18 of 19 P1 findings closed | ⚠️ 17 clean + 2 with regressions (R7-NEW-001 stale test, R7-NEW-002 leak) |
| All engine + iOS focused tests PASS | ❌ FAIL — 1 test failed (R7-NEW-001) |
| docs:audit at or below 480 ceiling | ✅ PASS — 480 at ceiling |
| No new P0/P1 introduced by the fixes | ❌ FAIL — R7-NEW-002 is a P1 client-side leak |
| Cleanup confirmed | ✅ PASS |

## Round 7 conclusion: GO_WITH_CONDITIONS

Codex's work is overwhelmingly correct — 17 of 19 P1s closed cleanly, both P0s solid, tests substantially better than baseline. But two findings block a clean GO:

1. **R7-NEW-002 (P1)** must close — the `originalMessage` leak via `DecisionActionError.details` is a direct violation of the original Codex prompt's "log only" constraint and exposes internal error text to authenticated clients.
2. **R7-NEW-001 (P2)** must close — the failing test in `content-admin-write-auth.test.ts:289` is a stale assertion of pre-T3 behavior; either fix the test or split into two.

Both are mechanical 30-minute fixes. After Codex closes them, this becomes a clean GO for Wave 1.

## Proposed Codex Round 8 mini-prompt

```
Two mechanical fixes on feature/wave1-fullscan-hardening (no push, no deploy,
preserve dirty state):

1) R7-NEW-002 (P1) — Decision Center action error rewrap leaks original message
   - src/services/decision-center.ts:968 — STOP putting originalMessage into
     DecisionActionError.details (it is serialized to client by both
     src/api/routes/decisions.ts:decisionError and
     src/portal/decision-center-routes.ts:sendDecisionError).
   - Either drop originalMessage from details OR add a separate
     internalDetails field on DecisionActionError that is NEVER serialized.
   - Keep the logger.error(...) call BEFORE the rewrap — that's correct.
   - Add a regression test in __tests__/services/decision-center.test.ts:
     when performDecisionAction throws a generic Error('db boom'), the
     response body's error.details must NOT contain 'db boom'.

2) R7-NEW-001 (P2) — stale test asserts pre-scope behavior on /pillars
   - __tests__/api/content-admin-write-auth.test.ts:266-292
   - Test 'sanitizes portal admin write failures instead of leaking internals'
     mocks DB to throw but P1-T3 made GET /pillars require scope first.
   - Either provide scope context so the route reaches the DB mock, OR
     split into two tests: (a) no scope → 400, (b) with scope + DB throw → 500
     sanitized.

After both close, rerun the same focused vitest sweep and confirm all tests pass.
Then send Claude a one-shot validation request:

"Round 7 follow-up — verify only R7-NEW-001 and R7-NEW-002 at source + test
level, then output GO or NO_GO."
```

Once both close, ship Wave 1.
