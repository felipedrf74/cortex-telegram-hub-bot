# Full-System Hostile QA Scan — Nexus Hub Wave 1

Date: 2026-05-13
Reviewer: Claude (opus, max effort) — 12 specialist agents run in parallel
Production: engine `4.14.156` / iOS `1.4.3(17)`. Wave 1 cohort: Felipe + Jaqueline (both Lisbon).

## Verdict

**GO_WITH_HARD_CONDITIONS** — Wave 1 is releasable for Felipe + Jaqueline only after closing 2 P0s. Wave 2 (broader cohort) is blocked until ~12 P1s in tenant isolation, silent failures, and prompt-injection coverage are closed. Backend cybersecurity baseline is otherwise strong (parameterized SQL, JWT key rotation, HMAC webhooks, timing-safe compares, no committed secrets).

## P0 — HARD BLOCKERS (Wave 1 cannot ship without these)

| # | Finding | File | Lens |
|---|---|---|---|
| 1 | **iOS `PrivacyInfo.xcprivacy` missing** — required by Apple since May 2024; TestFlight/App Store will reject the build. | iOS workspace (no file) | observability-privacy |
| 2 | **GDPR account deletion not recorded in `audit_trail`** — Art 17 evidence gap; `audit_trail` is deliberately exempt from deletion specifically to prove the deletion happened, but nothing writes the proof row. | `src/api/routes/settings.ts:253-266`, `src/services/user-data-export.ts:147-150` | observability-privacy |

## P1 — Wave 2 Blockers (15)

### Tenant isolation (5)
1. **`GET /api/signals` + `/api/signals/ranked` unscoped** — operator with read-tier portal token sees every tenant's voice DNA + Garmin signals. `src/portal/intelligence-routes.ts:45,92` [backend-qa]
2. **`dismissSignal(signalId)` no tenant check** — one admin click can dismiss another tenant's signal. `src/services/intelligence-bus.ts:637-643` [backend-qa]
3. **Pillar routes ignore `resolvePortalContentScope`** — cross-tenant pillar enumeration + deletion. `src/api/routes/content-admin-write.ts:695-779` [backend-qa]
4. **Garmin SSO/rate-limit files are global** — second user's login overwrites first; rate-limit backoff applies globally. `src/services/garmin.ts:189-217` [backend-qa]
5. **`error_log`/`api_usage`/`client_errors` lack `tenant_id`** — anyone with portal admin sees cross-tenant PII in logs. `migrations/021_error_log.sql:2-15`, `migrations/007_api_usage.sql`, `migrations/041:28` [backend-qa + data-integrity]

### Silent failures (5)
6. **Garmin read functions** — 25+ functions return `null`/`[]` on any non-handled error with zero logging. Recent P0 history was Garmin MFA — this pattern hides exactly that regression. `src/services/garmin.ts:1199-1327` [silent-failure-hunter]
7. **GDPR export `safeAll`** — silently incomplete export = Article 15 violation. `src/api/routes/settings.ts:182-184` [silent-failure-hunter]
8. **Registration verification email** — `.catch(() => {});` on send; new user never gets code, no operator alert. `src/api/routes/auth.ts:875` [silent-failure-hunter]
9. **APNs `getPushTokensForUser` returns `[]` on DB failure** — silently kills Decision Center delivery; no operator signal. `src/services/apns-sender.ts:250-253` [silent-failure-hunter]
10. **Decision Center action error rewrap** — drops original `err.message`/stack into generic "verification failure"; untriageable in production. `src/services/decision-center.ts:965-968` [silent-failure-hunter]

### Performance / scaling (3)
11. **`listDecisionItems` N+1 supersession** — up to 200× secondary SELECTs per `/decisions` poll; iOS polls high-frequency. Will bite at ~30-50 users. `src/services/decision-center.ts:564-573` [performance]
12. **`notification_release` per-row UPDATE without transaction** — each row is its own WAL commit. `src/services/notification-orchestrator.ts:806-825,834-875` [performance]
13. **SQLite PRAGMAs missing `synchronous=NORMAL`, `cache_size`, `mmap_size`** — defaults waste latency at every write. `src/services/storage-provider.ts:83-88` [data-integrity + performance]

### AI safety (2)
14. **Prompt-injection sanitizer applied to only ~7 sites** — email subjects/bodies, calendar descriptions, scraped web text feed `completeOneShotWithFallback` (autoresearch, channel-learner, content-workflow, invoice-filer) bypassing sanitization. `src/services/context-engine.ts:135,156,178`, `src/utils/prompt-sanitizer.ts:3-32` [ai-safety]
15. **Tool results returned to LLM unsanitized** — indirect injection vector: poisoned email → tool result → next-turn LLM instruction. `src/services/tool-executor.ts:574-595, 460-573` [ai-safety]

### Operational (4)
16. **Garmin `/tmp/garmin-step3-debug.html` + `/tmp/garmin-mfa-debug.html`** — plaintext MFA flow internals world-readable on shared VPS; path leaked in thrown user-visible error. `src/services/garmin.ts:472,568` [backend-qa]
17. **iOS WebSocketManager not disconnected on sign-out/scope change** — singleton keeps `pingTimer` + URLSession delegate retain alive across accounts; stale ping to stale token. `Core/AppState.swift:602-623`, `Core/AuthManager.swift:520-562` [ios-qa]
18. **`notification_intents.dedupe_key` not UNIQUE** — race-condition double-fires unpreventable at schema level. `migrations/113_secretary_notification_orchestrator.sql:41-71` [data-integrity]
19. **`api_usage` no retention sweep** — unbounded growth (~3M rows/month at 10 tenants) will degrade cost rollup within 30 days. `src/services/scheduler.ts:887-913` [data-integrity]

### Email PII (1)
20. **`email_log` writes raw `recipient` + `subject`** — calendar/finance subject lines are PII; no redaction, no retention. `src/services/outlook-mail.ts:15-21` [observability-privacy]

## Specialist Verdicts (12 lenses)

| Lens | Verdict | P0 | P1 | Top risk |
|---|---|---|---|---|
| Backend architecture + tenant | NEEDS_ATTENTION | 0 | 6 | Cross-tenant signal/PII exposure; Garmin global filesystem |
| iOS bugs + memory + UX | MINOR_ISSUES | 0 | 1 | WebSocketManager retains across accounts |
| Wave 1 release gatekeeper | GO_WITH_CONDITIONS | 0 | 4 | All operator-physical (Felipe with devices) |
| Cybersecurity OWASP + secrets | MINOR_ISSUES | 0 | 0 | Portal CSP `unsafe-inline`; Apple JWKS DoS amp |
| iOS mobile security | MINOR_ISSUES | 0 | 0 | No App Switcher privacy overlay; URL scheme hijack |
| Database + migrations | MINOR_ISSUES | 0 | 4 | Missing PRAGMAs; tenant_id gaps; unbounded api_usage |
| Performance + cost | MINOR_ISSUES | 0 | 3 | Decision Center N+1; scaling cliff ~30-50 users |
| Dependency / supply chain | CLEAN | 0 | 0 | Anthropic SDK 17 minor versions behind |
| AI provider safety | MINOR_ISSUES | 0 | 2 | Sanitizer coverage; indirect injection via tool results |
| Background jobs / scheduler | MINOR_ISSUES | 0 | 0 | Garmin keepalive schedule mismatch (cosmetic) |
| Observability + GDPR + PII | NEEDS_ATTENTION | 2 | 4 | Privacy Manifest; deletion audit gap; cron reqId gaps |
| Silent failure hunter | NEEDS_ATTENTION | 0 | 5 | Garmin reads pattern; GDPR safeAll; decision-action rewrap |
| Test quality | MINOR_ISSUES | 0 | 0 | iOS `Thread.sleep` flake risk; CI runs focused only |

## Pre-Wave-1 Critical Path (sequenced)

**Must close before TestFlight cut:**

1. **PrivacyInfo.xcprivacy** (~4h) — declare NSPrivacyAccessedAPITypes (UserDefaults, FileTimestamp, SystemBootTime, DiskSpace), NSPrivacyTracking=false, NSPrivacyCollectedDataTypes covering health/email/finance.
2. **Account-deletion audit log** (~15min) — add `logAudit({action:'delete', resource:'account', ...})` in settings.ts:259 and matching call in `/export:171`.

**Strongly recommended before broader cohort:**

3. **Garmin `/tmp/*-debug.html` gate** (~10min) — env-gate behind `GARMIN_DEBUG_DUMP=true`; scrub path from thrown error.
4. **WebSocketManager.disconnect() on scope change** (~15min) — one-line addition to `handleScopeChange()`.
5. **Verification email .catch logging** (~5min) — replace `.catch(() => {})` with `logger.error`.
6. **APNs token-load error propagation** (~30min) — distinguish "no devices" from "DB unavailable".

## Wave 2 Blockers Cluster

Before opening to a 3rd+ tenant:

- Close P1s #1-5 (tenant isolation cluster).
- Close P1 #15 (tool-result sanitization).
- Migrate iOS deeplink to Universal Links (`applinks:`).
- Anthropic SDK 0.78 → 0.95 bump.
- Add `vi-mock-completeness-lint --strict` + `docs:audit` as PR-blocking CI jobs.
- Apply migration 122-style pre-flight dedup pattern to any future `CREATE UNIQUE INDEX`.
- Add transactional migration runner (wrap each `db.exec(sql)` in `db.transaction`).

## Wave 3+ Architectural Investments

- Garmin multi-tenant rework (per-user cookie/rate-limit storage).
- Scheduler split (`scheduler.ts` is 1949 LoC across 35 cron jobs).
- iOS Sentry SDK integration (referenced in comments but never wired).
- Aggregate `decision_quality_score`/`specificity`/`actionability`/`explanation_open_rate` metrics.
- Universal Link migration with AASA file.
- Anthropic prompt caching for conversation history blocks (not just system).

## Strengths Confirmed Across Lenses

- **Cybersecurity baseline strong** — parameterized SQL everywhere user input flows; JWT `kid` rotation with rate-limited force-refresh; timing-safe token compare via `crypto.timingSafeEqual`; HMAC webhook signatures; bcrypt for passwords; dedicated `PORTAL_ADMIN_TOKEN` with operator scoping; strong CSP + security headers; `esc()` HTML escaper on every dynamic substitution; zero committed secrets.
- **Dependency audit CLEAN** — 0 critical/high/moderate/low npm advisories; zero GPL/AGPL deps; license headers consistent; iOS confirmed zero third-party deps.
- **iOS security baseline solid** — Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` + `kSecAttrSynchronizable: false`; user-scoped Keychain keys; sign-out fully drains DeepLinkRouter/NotificationManager/URLCache/repositories; Apple Sign-In nonce is SecRandomCopyBytes 32-byte SHA256.
- **Backup/restore HIGH confidence** — Online Backup API (WAL-safe); AES-256-GCM optional encryption; daily backup + Sunday restore-test cron; off-site Google Drive replica; restore.sh supports dry-run + integrity check.
- **Cron infrastructure solid** — DST watchdog (`2,17,32,47 * * * *` re-fires overdue jobs); `wrapJob` overlap guard via `inFlightJobs`; `seedJobLastRunFromHistory` survives restart; `recordOperatorAlert` on every failure with exp-backoff.
- **Provider routing CORRECT** — Gemini-first verified; Anthropic-fallback only via explicit env + kill-switch (`anthropic-hook.ts:85-97` hard-throws otherwise); classifier uses cheapest tier (`gemini-2.5-flash-lite`).
- **Tool dispatch STRONG** — Static allowlist + `ChatToolRisk` taxonomy + `confirmedDestructiveAction` gate + tenant-scope mismatch detection + ownership checks.

## File index (worst-offender hot spots)

- `src/services/garmin.ts` — P1 silent reads, P1 tmp dumps, P1 single-tenant files, monkey-patches console.error
- `src/portal/intelligence-routes.ts` — P1 unscoped signals endpoints
- `src/services/decision-center.ts` — P1 N+1 supersession, P1 generic error rewrap
- `src/services/intelligence-bus.ts` — P1 unscoped dismiss
- `src/api/routes/content-admin-write.ts:695-779` — P1 unscoped pillar routes
- `src/api/routes/settings.ts` — P0 audit gap, P1 safeAll silent
- `src/services/scheduler.ts` (1949 LoC) — P1 unbounded api_usage retention, god-file
- `migrations/021_error_log.sql`, `007_api_usage.sql`, `041` — P1 missing tenant_id
- `migrations/113_secretary_notification_orchestrator.sql:41-71` — P1 non-UNIQUE dedupe
- `src/utils/prompt-sanitizer.ts` — P1 weak pattern set + silent truncation
- `src/services/tool-executor.ts:460-595` — P1 unsanitized tool results to LLM
- `Core/AppState.swift:602-623` + `Core/WebSocketManager.swift` — P1 WS not disconnected
- iOS workspace — P0 PrivacyInfo.xcprivacy missing

## Recommendations By Owner

**Felipe (operator-physical, ~half day):**
1. Create PrivacyInfo.xcprivacy in Xcode (use Apple template).
2. Cut TestFlight from `feature/training-intelligence-orchestration-consolidation` after the 2 P0s close.
3. Run two-account walkthrough Felipe ↔ Jaqueline on iPhones.
4. Verify APNs live delivery on signed build.
5. Reconnect Google to clear `invalid_grant` state.

**Codex / engineering (mechanical fixes, ~1-2 days):**
1. Add `logAudit` to deletion + export routes (P0).
2. Tenant-scope sweep on `intelligence-routes.ts`, `intelligence-bus.dismissSignal`, pillar routes, `error_log`/`api_usage`/`client_errors` columns.
3. Garmin tmp dump env gate + path scrub.
4. WebSocketManager.disconnect() in handleScopeChange.
5. Silent-failure cluster: Garmin reads, safeAll, registration email, APNs token load, decision-action rewrap.
6. Prompt-injection sanitizer expansion + tool-result wrapping.
7. SQLite PRAGMA tuning.
8. notification_intents UNIQUE constraint + retention sweep for api_usage.

**Wave 2 prep (~3-5 days engineering):**
1. Garmin multi-tenant rework (per-user files).
2. Universal Link migration.
3. Anthropic SDK 0.78 → 0.95.
4. CI gates: vi-mock-completeness-lint --strict + docs:audit.
5. Transactional migration runner.
6. Scheduler.ts split.

## Confidence: MEDIUM-HIGH

The codebase is exceptionally well-structured for a single-author beta. The P0s are mechanical, not architectural. The P1 cluster reveals that the next architecture investment must be **multi-tenant correctness** — every gap that the agents found is solvable with the existing `assertScope`/`requireOperatorTargetUser`/`resolvePortalContentScope` helpers; it's a sweep, not a rewrite.

The biggest unaddressed assumption is that *operator-physical Wave 1 evidence has not been produced on `4.14.156`/`1.4.3(17)`* — APNs has never been confirmed live on this build, two-account device switching has not run on the latest backend contract, Garmin MFA on Jaqueline is unverified. These are not unknowns about whether the code works; they are unknowns about whether the device/credential layer behaves as the contracts assume.

## References

Individual specialist reports retained in chat history. Aggregate xcresults at `docs/release/qa-evidence/round{4,5,6}-ios-results.xcresult`.
