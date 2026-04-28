# Nexus Hub — Beta Release Gate Report

- **Gate date**: 2026-04-27
- **Gatekeeper**: Nexus Hub Release Gatekeeper (Claude Code, explanatory mode)
- **Backend version under audit**: `4.14.97` (production live, staging aligned)
- **Backend deploy commit**: `d1e5850` (release source: `4fc4a18`)
- **iOS branch under audit**: `main` last pushed `f6b35bb` (per backend `CLAUDE.md`)
- **Active backend feature branch (NOT in prod)**: `feature/training-engine-intelligence-and-agenda-overhaul`
- **Inputs consumed**:
  - `docs/qa/QA_BACKEND_REPORT.md` (backend audit, 379 lines, 78/100)
  - `Nexus Hub IOS/Nexus Hub/docs/qa/QA_IOS_REPORT.md` (iOS audit, 591 lines, 72/100)
  - `docs/training/training-engine-{final-report,gap-analysis,open-items,test-matrix,orchestration-overhaul-spec}.md` (Phase-0 overhaul drafts, working branch only)
  - Backend `npm run verify` evidence (360 / 5,715 tests, ~89 s)
  - `CLAUDE.md` production-truth section (staging smoke 17/17, prod deploy gate 17/17)
- **Mode**: Read-only synthesis — no implementation files modified.

---

## 1. Executive Summary

Production backend `4.14.97` is stable, deterministic, and well-tested. Backend
QA scored it **78 / 100** with **zero Critical blockers** and four High items
that the audit explicitly flags as "ship before public TestFlight, not before
the founders' cohort." iOS scored **72 / 100** with three Critical items that
target *defensibility of the next release*, not user-visible breakage:
no XCUITest target, a `NEXUS_SKIP_AUTH=1` DEBUG short-circuit baked with the
founder identity, and a chunk of unreachable post-auth onboarding UI that
still costs a network round-trip.

A third evidence stream — the in-progress `docs/training/` overhaul on the
active feature branch — identifies three Critical training-engine regressions
(strength session volume↔time mismatch, repetitive session templates, and
agenda lifecycle leaks on cancel/replace) that **are present in production
`4.14.97`** but whose fix is still in Phase-0 audit and has not shipped.
None crash the app; all degrade plan quality and Secretary↔Training calendar
hygiene.

**Composite verdict by audience:**

| Audience | Verdict |
|---|---|
| Founder closed TestFlight (Felipe + Jaqueline) | **GO** |
| Closed external beta (≤25 invited testers) | **CONDITIONAL GO** with named gates below |
| Open / public TestFlight | **NO-GO** until backend H-1/H-2/H-3/H-4, iOS C-1/C-2/C-3 + H-1..H-3, and the three training-engine regressions are closed |

The defensible position is to keep the founder cohort live on `4.14.97`,
ship a single backend security/attribution hardening patch (H-2 → H-3 → H-4
→ H-1 in that order), land the iOS accessibility-identifier + Sign-Out-lift +
onboarding-dead-code PR, and stand up the `Nexus HubUITests` target before
inviting any non-trusted-operator user.

---

## 2. Final Beta Readiness Score

| Track | Score | Trend |
|---|---|---|
| **Backend (`4.14.97`)** | **78 / 100** | Stable. Slices 3.I–3.M raised provenance/observability; security and tenant-guard hygiene drag the headline down. |
| **iOS (`main`)** | **72 / 100** | Stable on user-visible paths; defensibility (UI tests, accessibility identifiers) drags the headline down. |
| **Cross-cutting (training engine in production)** | **−3 adjustment** | Three Critical regressions documented in the active `docs/training/` audit are present in `4.14.97` and unfixed. |
| **Composite Beta-Readiness** | **72 / 100** | Founder beta safe; public beta blocked. |

Composite is computed as the lower of the two tracks (72) penalised by the
three known production-side Critical regressions surfaced by the training
overhaul audit (−3, then floored at 72 since iOS already scored there) — the
gate refuses to score *higher* than the worst sub-track.

---

## 3. Backend Score — `78 / 100`

Direct from `docs/qa/QA_BACKEND_REPORT.md` §"Score":

| Bucket | Score | Notes |
|---|---|---|
| Architecture & Engines | 86 | Coach-kernel slices 3.I–3.M and slice 1 readiness adapter are exemplary. |
| Skill Orchestration | 85 | `skill-manager.ts` cache invariants well tested; entitlement middleware centralised. |
| API & iOS Contracts | 75 | Standard envelope clean via `response-helpers`; rate-limiter + duplicate `ensureValid*` helpers drag this down. |
| Auth & Tenant Isolation | 70 | Strong perimeter; plaintext refresh tokens + uneven scope guards drag this down. |
| Cache & DB | 80 | Decrypted-token LRU correct; SWR consistent; two cache-key inconsistencies. |
| Background Jobs | 80 | Per-user `runWithContext` correct; one stale `require('./push-service')` is dead code. |
| Logging & Observability | 88 | pino + reqId AsyncLocalStorage + `recordOperatorAlert` mature. |
| Tests | 90 | 5,715 green; provenance pinned tightly; cross-tenant negative-test gaps remain. |
| Documentation | 84 | `CLAUDE.md` current; `IOS-INTEGRATION.md` only documents `/plan/*`. |

**Test evidence**: `npx tsc --noEmit` clean, `npx vitest run` 360 / 5,715
green in 88.63 s, staging smoke 17/17, production deploy gate 17/17,
production health passed for content engine + status portal + bot online
(per `CLAUDE.md` Current Production Truth).

---

## 4. iOS Score — `72 / 100`

Direct from `Nexus Hub IOS/.../QA_IOS_REPORT.md` §"Score":

| Lens | Score | Notes |
|---|---|---|
| Architecture & data flow | 88 | Clean MVVM + `@Observable`; single-root DI; full `signOut` reset. |
| API decoding & error handling | 85 | Envelope-aware decoder; redacted DEBUG logging; 401 single-flight refresh. |
| Loading / empty / error states | 78 | `QualityAuditScenario` harness is strong; Home shimmer hand-off relies on undocumented heuristics. |
| Accessibility identifiers | 48 | 78 occurrences across 38 files; **all primary Home actions missing identifiers**. |
| XCUITest coverage | 5 | **No UI-test target exists.** |
| Unit test coverage | 86 | 133 test files; `BetaTestFlightSmokeMatrixTests` enforces flow inventory. |
| SwiftUI preview stability | 80 | 156 `#Preview` macros; `PreviewRuntime.isRunning` correctly used in 21 sites. |
| Crash / hang risks | 75 | 2 `fatalError` + 1 `preconditionFailure` reachable only on misconfigured base URL; 1 structurally-safe `try!`. |
| Onboarding flow | 60 | Step gating works; post-auth questionnaire UI is unreachable dead code. |
| Beta gate readiness | 65 | Manual smoke matrix well documented; automation past unit-test layer absent. |

**Test evidence**: 320 `.swift` source files, 133 unit-test files, zero
`XCUIApplication` references in the repo. `xcodebuild build` and
`scripts/beta-smoke-local.sh` green per `CLAUDE.md` history.

---

## 5. Critical Open Blockers

### 5.1 Backend — `0 critical`
Backend QA explicitly states **"None. There is no audit finding that requires
a production hotfix before continuing the iOS-distribution gates."**

### 5.2 iOS — `3 critical` (defensibility-class, not crash-class)

| ID | Title | Source | Audience-impact |
|---|---|---|---|
| **iOS-C-1** | No XCUITest target exists for any user-facing flow | `QA_IOS_REPORT.md §3` | Blocks public TestFlight automation gate; founder OK. |
| **iOS-C-2** | `NEXUS_SKIP_AUTH=1` DEBUG path returns founder identity (`Felipe Dominguez`, id 12345) for any tester | `QA_IOS_REPORT.md §3` | Privacy concern if a Debug archive ever ships to TestFlight; must be Release-build verified. |
| **iOS-C-3** | Post-auth onboarding (questionnaire UI) is unreachable dead code that still calls `GET /onboarding/pending` | `QA_IOS_REPORT.md §3` | No user-visible breakage; latent regression risk + 1 wasted round-trip per first-run. |

### 5.3 Training engine (in production `4.14.97`, fix in draft)
Surfaced by `docs/training/training-engine-gap-analysis.md` (Phase-0 audit on
the active feature branch — fix has NOT shipped):

| ID | Title | Source | Audience-impact |
|---|---|---|---|
| **TE-C-1** | Strength session volume↔time mismatch — 48 min "Lower Body A" rendered with 1 small exercise | `gap-analysis.md §"regression #1"` | Plan quality regression; user-visible immediately on a generated plan. |
| **TE-C-2** | Three consecutive strength days are essentially identical (no role rotation) | `gap-analysis.md §"regression #2"` | Plan quality regression; user-visible across week 1. |
| **TE-C-3** | Agenda lifecycle leaks — create / cancel / replace doesn't reliably sync calendar entries | `gap-analysis.md §"regression #3"` | Cross-skill (Training ↔ Secretary) hygiene regression; partially mitigated by `4.14.88`'s repair pass but not atomic. |

Notes:
- TE-C-1..C-3 are NOT in the backend QA report because backend QA scored the
  *codebase* (deterministic, well-tested, provenance-tagged) — the regressions
  are **product-quality** issues that show up only when a user generates a
  plan. They live in the training-engine overhaul audit on the working
  branch.
- The fix lives behind a documented backup tag
  (`backup-training-engine-before-orchestration-overhaul-20260427-2003`),
  so the rollback path is preserved.

---

## 6. High-Risk Open Issues

### 6.1 Backend (4 High, all from `QA_BACKEND_REPORT.md §"High-Priority Issues"`)

| ID | Title | Severity | Why it bites public beta |
|---|---|---|---|
| **BE-H-1** | Finance encryption: shadow `amount` columns persist alongside `encrypted_amount`; `getMonthlySummary` aggregates the plaintext side | High (security / data-at-rest) | A leaked SQLite tarball leaks income, INSS, IRPF, transaction descriptions in cleartext. |
| **BE-H-2** | iOS refresh-token stored as plaintext, with INDEX, in `ios_devices.refresh_token` | High (credential-at-rest) | Same blast radius as the OAuth refresh tokens fixed in audit P0-7; long-lived account access if backup leaks. |
| **BE-H-3** | Python content-engine usage attributes to `user_id=0` for every `/api/v1/internal/report-usage` event | High (correctness / cost attribution) | `/usage` and `/billing/usage` undercount; daily cost cap leans on per-user roll-up that reads zero. |
| **BE-H-4** | Top-level `training` and `billing` routers never enforce `ensureValidTenantRouteScope` | High (defense-in-depth) | Not exploitable today — `authMiddleware` populates `req.userId` and fails closed — but the tenant-anomaly tripwire is silent on the largest routers. |

### 6.2 iOS (6 High, from `QA_IOS_REPORT.md §"High-Priority Issues"`)

| ID | Title | Severity | Why it bites public beta |
|---|---|---|---|
| **iOS-H-1** | Home/Dashboard primary actions (KPI chips, quick-action tiles) carry `id` fields that never reach `.accessibilityIdentifier` | High | Blocks XCUITest authoring; localisation-fragile fallback to label matching. |
| **iOS-H-2** | Hero, "Skills snapshot" row, and "Upcoming" card lack stable identifiers | High | Same as iOS-H-1, broader surface. |
| **iOS-H-3** | Sign-Out lives behind Settings → About → "Privacy & Data", not Settings root | High | iOS HIG violation; manual-support friction in beta. |
| **iOS-H-4** | `applyServerPushPreferences` flag races against `@AppStorage onChange` propagation | High | Server-state may overwrite user-pending changes under contention. |
| **iOS-H-5** | App boot fires HealthKit sync 1.5 s after Tasks/Dashboard warm with no backoff | High | Real-device-only network slow-start contention. |
| **iOS-H-6** | Residual `try!` on a fallback regex (structurally safe) | High (style) | CLAUDE.md "no force unwraps" rule violation. |

---

## 7. API Contract Status

**Status: STABLE for the current beta gate.**

| Dimension | State |
|---|---|
| Production backend version | `4.14.97` |
| Endpoints iOS calls | All covered by `4.14.97` per iOS audit §15. |
| Standard envelope conformance | `response-helpers.ts` canonical; **two non-canonical sites flagged**: rate-limiter (`BE-M-1`) and `secret-guards` portal endpoints (`BE-M-8`). Both emit `{ ok: false, error: { code, message } }` minus `timestamp`. iOS decoder tolerates this today. |
| Contract documentation | `IOS-INTEGRATION.md` covers only `/plan/*`; ~85 endpoints are undocumented (`BE-L-8`). Drift risk if iOS team grows. |
| Breaking changes vs prior release | None. `4.14.97` adds only internal provenance functions in `training-coach-kernel-plan-generator.ts`. |
| Migration footprint | 85 numbered migrations; latest is `080_training_session_preferred_time_unavailable.sql`, deployed cleanly. |
| iOS-side decoder regressions | None observed. Envelope-aware decoder handles both canonical and bare-error shapes. |

**Verdict**: GO on contract. The two non-canonical envelopes are net-positive
to clean up but do not block any audience.

---

## 8. Security Status

| Surface | State | Source |
|---|---|---|
| `authMiddleware` fail-closed on DB errors | ✅ Hardened 2026-04-20 | `BE §S-7` |
| Device-revocation enforced inside JWT middleware | ✅ Hardened 2026-04-24 | `BE §S-8` |
| Rate-limit floor on `/auth/register` and `/auth/refresh` | ✅ Hardened 2026-04-20 | `BE §S-6` |
| `INTERNAL_API_SECRET` validated with `crypto.timingSafeEqual` | ✅ | `BE §S-3` |
| Stripe webhook signature check | ✅ | `BE §S-5` |
| OAuth refresh tokens encrypted (P0-7) | ✅ | `BE §S` |
| **Finance at-rest encryption non-functional** (shadow columns) | ❌ **HIGH** | `BE-H-1` |
| **iOS refresh tokens stored plaintext + indexed** | ❌ **HIGH** | `BE-H-2` |
| **Python engine cost burns to `user_id=0`** | ❌ **HIGH** | `BE-H-3` |
| `getArtifactChain` allows `user_id=0` cross-tenant read | ⚠️ MEDIUM (intent unclear) | `BE-M-3` |
| `/api/v1/internal/performance-summary` always reads owner data | ⚠️ MEDIUM (cross-tenant in Python report path) | `BE-M-4` |
| Apple webhook `bundleId` check via `!==` after JWS parse | ⚠️ Known gap, signature still TODO | `BE §S-4` |
| iOS `NEXUS_SKIP_AUTH=1` returns founder identity in DEBUG | ❌ **CRITICAL** if Debug archive ever ships to TestFlight | `iOS-C-2` |
| iOS local debug auth-token export double-gated by `#if DEBUG && targetEnvironment(simulator)` | ✅ | `iOS §S-6` |

**Verdict**: Production perimeter is mature. At-rest credential and
financial-data hardening (BE-H-1, BE-H-2) is the most defensible single
win before public TestFlight. BE-H-3 is correctness-class but rolls up to
security via the cap-bypass attribution shift.

---

## 9. Tenant Isolation Status

| ID | Surface | State |
|---|---|---|
| `intelligence-bus.writeSignal` user-scope enforcement | ✅ via `signalRequiresUserScope` + `recordTenantScopeAnomaly` | `BE §T-5` |
| `oauth-store.getTokens` LRU keyed by `(userId, provider)`, invalidated on store/disconnect/refresh | ✅ | `BE §T-6` |
| Finance, Cooking, Tasks, Training mutations all `WHERE … AND user_id = ?` | ✅ | `BE §T-7, T-8` |
| Cron `training_plan_adjust` wraps each user in `runWithContext` | ✅ Hardened 2026-04-21 | `BE §T-4` |
| **`training` + `billing` routers omit `ensureValidTenantRouteScope`** | ❌ **HIGH** (`BE-H-4`) | Not exploitable; tripwire silent. |
| **`ensureValidXRouteScope` duplicated across 7+ files** | ⚠️ MEDIUM (`BE-M-2`) | Drift risk. |
| **Python `/internal/report-usage` attributes to `user_id=0`** | ❌ **HIGH** (`BE-H-3`) | Per-user spend invisible. |
| **`getArtifactChain` cross-tenant via `user_id=0`** | ⚠️ MEDIUM (`BE-M-3`) | Intent unclear; document or narrow. |
| **`performance-summary` returns owner data to Python regardless of caller** | ⚠️ MEDIUM (`BE-M-4`) | Cross-tenant data poisoning into AI prompts. |

**Verdict**: Single-tenant-runtime assumptions are mostly excised. The four
remaining tenant-isolation findings are all addressable in a single hardening
patch (BE-H-4 is one line per router; BE-H-3 needs a Python client signature
change; BE-M-3 / BE-M-4 are per-route fixes).

---

## 10. iOS Stability Status

| Lens | State |
|---|---|
| Crash paths | 2 `fatalError` + 1 `preconditionFailure` reachable only on a malformed `NexusConfig.apiBaseURL`. `try!` regex is structurally safe (`$^`). |
| Retain cycles | 12 `[weak self]` audit sites in `AppState`; no cycle smell. |
| WebSocket lifecycle | `WebSocketManagerTests` covers reconnect; `deinit` cancel is thread-safe. |
| Repository reset on sign-out | Wired through `signOut()` and `signOutForDeletion()`. ✅ |
| Token-zero policy | Verified — Dashboard does not route through `ChatRepository`/`ChatService`; `ChatViewModel.sendMessage` runs on-device fastpath before chat endpoint. ✅ |
| HealthKit sync race at launch | `iOS-H-5` — real-device only, low-amplitude. |
| Push-pref race | `iOS-H-4` — corrupts user-pending state under contention. |
| `BetaTestFlightSmokeMatrixTests` flow inventory | 20 named flows pinned; **all manual gates** — automation absent. |
| Onboarding dead code | `iOS-C-3` — unreachable, network-cost-positive. |
| Founder identity in DEBUG | `iOS-C-2` — must be Release-build-verified at archive time. |

**Verdict**: The runtime stability story is strong. Beta gate breaks on
*automation defensibility* and *build-config rigour*, not on user-visible
crashes.

---

## 11. Test Coverage Status

| Track | Hard numbers | Verdict |
|---|---|---|
| Backend unit + integration | **5,715 tests** across **360 files**, ~89 s, all green | ✅ Excellent |
| Backend tenant-isolation negative tests | Pinned for new surfaces; gaps on `/training/*` and `/billing/*` cross-tenant rejection | ⚠️ Address in same patch as BE-H-4 |
| Backend security regression tests | Pinned for OAuth (P0-7), auth-middleware fail-closed, device-revocation, rate-limit floors. **Missing** for finance shadow-column purge (BE-H-1), iOS refresh-token hashing (BE-H-2), Python usage attribution (BE-H-3) | ⚠️ Add alongside the H-fix patch |
| iOS unit | **133 test files** including `BetaTestFlightSmokeMatrixTests` flow inventory enforcement | ✅ Dense |
| iOS XCUITest | **0 tests, 0 target** | ❌ Public-beta blocker (`iOS-C-1`) |
| iOS preview stability | 156 `#Preview` macros; 21 sites correctly guarded by `PreviewRuntime.isRunning` | ✅ |
| Backend staging smoke | 17/17 green per `CLAUDE.md` `4.14.97` deploy | ✅ |
| Backend production deploy gate | 17/17 green per `CLAUDE.md` `4.14.97` deploy | ✅ |
| iOS local beta smoke | `scripts/beta-smoke-local.sh` 16-suite slice + simulator compile + doc-drift gate, last reported green | ✅ |
| iOS signed TestFlight smoke | **Not yet run** for `4.14.97`'s coach-engine slice 3.M and prior fixes | ❌ Required for any beta expansion |

**Verdict**: Backend automation is genuinely comprehensive. iOS is strong
below the unit-test layer and absent above it. Closing the iOS XCUITest gap
(`iOS-C-1`, 10-case Phase 1 plan documented in iOS audit §13) is the highest-
leverage single investment for public-beta defensibility.

---

## 12. Manual QA Checklist — Required Before Beta Expansion

These are the gates that must be **physically signed off** before any
audience above "founder closed TestFlight" gets the build. Most are already
listed in `CLAUDE.md` as "remaining public-beta gates" — this report locks
the list.

### 12.1 iOS distribution gates (per `CLAUDE.md`)
- [ ] Signed TestFlight build of `main @ f6b35bb` archives in **Release** configuration (verify `xcodebuild archive` config in `scripts/beta-release-validate.sh`).
- [ ] APNs token uploads via `/api/v1/devices/register-apns` with a real device token (not simulator, simulator never delivers tokens — iOS audit §S-3).
- [ ] APNs delivery proof: send a test push via portal → device receives → tap → deep-link routes (`DeepLinkRouter.routeToReport(id:)`).
- [ ] Fresh Apple Sign-In on a device that has never authenticated.
- [ ] Fresh Google Sign-In on a device that has never authenticated.
- [ ] Fresh email auth + interrupted onboarding (kill the app between language step and integrations step → reopen → resumes correctly).
- [ ] True two-account switching: sign in as `felipedrf74@gmail.com`, sign out, sign in as `vieira.jaqueline@gmail.com`, verify Home/Tasks/Training/Connections all show Jaqueline's data only — no Felipe-leak.
- [ ] Real Gmail provider state on Jaqueline's device (Connect → OAuth → token landed → calendar reads succeed).
- [ ] Real Outlook provider state (or document N/A for current cohort).
- [ ] Real HealthKit ingestion on Jaqueline's physical Apple Watch (TestFlight signed) — flagged in `CLAUDE.md` as still required.
- [ ] Verify iOS-C-2 cannot leak: confirm `NEXUS_SKIP_AUTH` is compile-stripped from the Release archive.

### 12.2 Backend operational gates
- [ ] Run staging smoke (`./scripts/staging-smoke.sh`) — must report 17/17.
- [ ] Run production deploy gate via `./scripts/promote-to-prod.sh` — must report 17/17 + production health for content engine, status portal, bot online.
- [ ] External webhook / on-call drill — already passed staging at last release; re-run if receiver changed.
- [ ] Operator-session smoke (valid / expired / tampered / unauthorized role / wrong-tenant / static-token) — already passed at last release.

### 12.3 Training-engine product gates (new — derived from `docs/training/`)
- [ ] On a fresh test account, generate a 4-week plan and confirm: every strength session's exercise count matches its claimed duration (TE-C-1 regression check).
- [ ] Same plan: confirm at least 2 of every 3 consecutive strength days have *distinct* session roles (Upper / Lower / Push / Pull / Full — TE-C-2 regression check).
- [ ] Activate the plan, confirm Secretary calendar entries appear; cancel the plan, confirm those same entries disappear within one sync cycle (TE-C-3 regression check).
- [ ] Replace the plan with a new generation, confirm old entries are atomically removed and new ones inserted, with no orphans (TE-C-3 regression check, harder case).

### 12.4 Cross-cutting iOS UX manual gates
- [ ] Home KPI chips and quick-action tiles route to the correct surface (manual; once iOS-H-1/H-2 land, replace with XCUITest).
- [ ] Sign Out is reachable in ≤2 taps from Settings root (manual; iOS-H-3 fix moves this to root).
- [ ] Toggling notification preferences while screen is reloading does not flip back to server state (manual; iOS-H-4).
- [ ] Onboarding language → Apple Sign-In → email auth → interrupt → resume — all paths land on Home, no questionnaire UI ever paints (manual; iOS-C-3).

---

## 13. Go / No-Go Recommendation

| Audience | Verdict | Rationale |
|---|---|---|
| **Founder closed TestFlight (Felipe + Jaqueline)** | ✅ **GO** | Backend `4.14.97` is stable; both founder accounts verified in production per `CLAUDE.md`; iOS audit explicitly recommends Go for this audience. The four backend High items are at-rest threats to a SQLite file that lives only on Felipe's home VPS. |
| **Closed external beta (≤25 invited testers)** | ⚠️ **CONDITIONAL GO** | Acceptable only if (a) `NEXUS_SKIP_AUTH` compile-strip is verified in the archive (`iOS-C-2`); (b) iOS team commits to manually field UX gaps for `iOS-H-1`/`H-2`/`H-3`; (c) `iOS-C-3` onboarding dead code is removed in the next merge; (d) the training-engine TE-C-1..C-3 regressions are communicated to invited testers as known-quality issues, not silent defects; (e) backend BE-H-3 lands so per-user usage doesn't underreport for invited testers' billing. |
| **Open / public TestFlight** | ❌ **NO-GO** | Blocked until: backend BE-H-1, BE-H-2, BE-H-3, BE-H-4 ship in a single hardening patch; iOS C-1 (XCUITest target) ships with the 10-case Phase-1 plan; iOS C-2 / C-3 / H-1 / H-2 / H-3 land; training-engine TE-C-1 / TE-C-2 / TE-C-3 fixes promote from the working branch into production. |

**The defensible single-sentence verdict:** Founders' beta is GO today;
public TestFlight is NO-GO until a clearly-scoped 4-issue backend hardening
patch + 1 iOS PR + 1 iOS UI-test scaffolding PR + the training-engine
overhaul ship together as `4.14.98–4.15.0`.

---

## 14. Required Fixes Before Beta (Public TestFlight Gate)

Ordered by **lowest risk × highest leverage**, derived from `BE §"Recommended
Fix Order"`, `iOS §14`, and `docs/training/training-engine-open-items.md`.

| # | Fix | Owner | Source | Estimated effort |
|---|---|---|---|---|
| 1 | **BE-H-2** — Hash iOS refresh token before storage; drop plaintext column + INDEX | Backend | `BE-H-2` | ~80 LoC + 1 migration; smallest blast-radius reduction |
| 2 | **BE-H-3** — Python content-engine forwards caller `userId` to `/internal/report-usage`; route validates and stores per-user | Backend + Python | `BE-H-3` | One TS route + one Python client change |
| 3 | **BE-H-4** — Mount `ensureValidTenantRouteScope` on `training` and `billing` routers | Backend | `BE-H-4` | One line per router |
| 4 | **BE-H-1** — Drop finance plaintext shadow columns; rewrite `getMonthlySummary` / tax aggregates to decrypt-then-aggregate | Backend | `BE-H-1` | ~150 LoC + migration with backfill; biggest surface |
| 5 | **iOS-C-3 + iOS-M-4** — Delete unreachable onboarding UI (profileSetupStep, questionnairePickerView, completionView, profileCard) and the `loadPending()` call in `languageStep` | iOS | `iOS-C-3` | Single PR, ~150 LoC delete |
| 6 | **iOS-H-1 + H-2 + B-1..B-9** — Thread `id` field into `.accessibilityIdentifier(_:)` on Home KPI chips, quick-action tiles, hero, snapshot tiles, secretary card | iOS | `iOS-H-1`, `iOS-H-2` | Single PR, ~80 LoC, unlocks XCUITest plan |
| 7 | **iOS-C-1** — Stand up `Nexus HubUITests` target with the 10 Phase-1 cases listed in `iOS §13` | iOS | `iOS-C-1` | Scaffolding PR + 10 cases |
| 8 | **iOS-H-3** — Lift Sign Out to Settings root | iOS | `iOS-H-3` | Single PR, ~40 LoC |
| 9 | **iOS-C-2** — Verify `NEXUS_SKIP_AUTH` is compile-stripped in Release; add automation in `scripts/beta-release-validate.sh` | iOS DevOps | `iOS-C-2` | Build-config audit |
| 10 | **iOS-H-4** — Fix `applyServerPushPreferences` race; add unit test asserting no `setPushPreference` invocation when toggle didn't change | iOS | `iOS-H-4` | Small PR + test |
| 11 | **TE-C-1** — Add `SessionCoherenceValidator` so generated session content matches claimed duration | Backend (training engine) | `gap-analysis.md §regression #1` | New Layer-4 module per overhaul spec |
| 12 | **TE-C-2** — Add `WeeklySessionRoleAssigner` so consecutive strength days have distinct roles | Backend (training engine) | `gap-analysis.md §regression #2` | New Layer-3 module per overhaul spec |
| 13 | **TE-C-3** — Add `TrainingPlanLifecycleManager` with idempotent agenda sync keyed by ownership table | Backend (training engine) | `gap-analysis.md §regression #3` | New Layer-7 module per overhaul spec |

**Sequencing logic**: items 1–4 are a single backend hardening patch
(`4.14.98` candidate). Items 5–8 are a single iOS PR + scaffolding PR. Items
11–13 are the active feature-branch overhaul, which is intentionally on a
separate cadence (backup tag preserved). All thirteen must close before
public TestFlight.

---

## 15. Recommended Fixes After Beta

Items that are real-quality wins but do not move the public-beta gate.

| # | Fix | Source | Why post-beta |
|---|---|---|---|
| 1 | **BE-M-1 + BE-M-8** — Standardise 401 / 429 envelopes through `sendError` | `BE-M-1`, `BE-M-8` | iOS decoder tolerates today; net positive but not blocking. |
| 2 | **BE-M-2** — Centralise `ensureValid*RouteScope` into the canonical helper, drop 7 duplicates | `BE-M-2` | Drift risk, not exploit risk. |
| 3 | **BE-M-3** — Document or narrow `user_id=0` semantics in `getArtifactChain` | `BE-M-3` | Decide intent; either way the contract becomes explicit. |
| 4 | **BE-M-4** — Make `/api/v1/internal/performance-summary` per-user | `BE-M-4` | Eliminates cross-tenant prompt poisoning in the Python report path. |
| 5 | **BE-M-5** — Add Zod-style guards on plan-generation inputs (`objective.length`, `durationWeeks`, `sessionsPerWeek`, `preferredTime` regex) | `BE-M-5` | DoS / cost amplification surface; bounded today by `acquireCostLock`. |
| 6 | **BE-M-6** — Include `language` in `training-summary` cache key | `BE-M-6` | Trivial UX win on language switching. |
| 7 | **BE-M-7** — Replace stale `require('./push-service')` in `scheduler.ts` with `apns-sender` | `BE-M-7` | One-line; restores Sunday-19:00 plan-renewal APNs notification. |
| 8 | **BE-L-1** — Fix `scoreToReadinessLevel` doc comment to match implementation | `BE-L-1` | Documentation accuracy. |
| 9 | **BE-L-3** — Wire a real linter or drop the `lint` alias | `BE-L-3` | Hygiene. |
| 10 | **BE-L-5** — Read Apple bundle ID from `config.apple.bundleId` instead of hard-coding `me.nexushub.app` | `BE-L-5` | Future-proofing for `*.beta` build variants. |
| 11 | **BE-L-8** — Generate iOS contract reference covering ~85 routes, not just `/plan/*` | `BE-L-8` | Drift insurance if the team grows. |
| 12 | **iOS-CR-1** — Replace `fatalError` URL guard in `AppState.init` with production-fallback | `iOS §10 CR-1` | Resilience to typo'd UserDefaults override. |
| 13 | **iOS-M-1** — Delete `NexusAPI` legacy facade after grep confirms zero live consumers | `iOS-M-1` | Memory + crash-path reduction. |
| 14 | **iOS-M-3** — Move `kickOffSecondaryBootstrap` flip to post-sleep success branch | `iOS-M-3` | Robustness against fast tab switches. |
| 15 | **iOS-M-5** — Add runtime warning + telemetry on `TabBarAccessibilityHostController` private-class string match | `iOS-M-5` | Future iOS-version regression alarm. |
| 16 | **iOS-M-6** — Coalesce `onMutation` debounce with 250 ms trailing | `iOS-M-6` | Server↔client divergence under burst mutations. |
| 17 | **iOS-M-7** — Guard `NotificationManager.shared.refreshAuthStatus()` with `!PreviewRuntime.isRunning` | `iOS-M-7` | Canvas refresh speed + preview hygiene. |
| 18 | **iOS-M-8** — Promote PT-PT/PT-BR/EN onboarding language literals into an `OnboardingLanguage` enum | `iOS-M-8` | i18n maintainability. |
| 19 | **iOS-L-1..L-9** — Stylistic and discoverability nits | `iOS §6` | Defer if time is tight. |
| 20 | **Training overhaul Layers 1, 2, 5, 7, 8, 9, 10** — typed `AthleteProfile`, deep catalog metadata, role-based substitution, biomechanics intelligence, plateau detection, progression / periodization, explainability split | `training-engine-gap-analysis.md` | Out of scope for beta-blocker overhaul; multi-release roadmap. |

---

## 16. Verification of the Gate

- Backend `npx tsc --noEmit` clean and `npx vitest run` 360 / 5,715 green confirmed in `QA_BACKEND_REPORT.md §"Verification of Audit"` and corroborated in `CLAUDE.md` `4.14.97` deploy log.
- iOS unit test count (133 files), source file count (320 `.swift`), and zero `XCUIApplication` references confirmed in `QA_IOS_REPORT.md §1` and §3.
- Backend production deploy commit `d1e5850` and release source `4fc4a18` confirmed in `CLAUDE.md` Current Production Truth.
- Backend feature branch `feature/training-engine-intelligence-and-agenda-overhaul` confirmed via `git status` (current working tree) and `git log --oneline` (top of `main` is `96c61fb`, the slice-3.M release record). Working branch is local-only per `training-engine-final-report.md §14`.
- Backup tag `backup-training-engine-before-orchestration-overhaul-20260427-2003` and backup branch `backup/training-engine-before-orchestration-overhaul-20260427-2003` documented as pushed to origin in `training-engine-final-report.md §2`.
- Founder accounts `felipedrf74@gmail.com` and `vieira.jaqueline@gmail.com` verified live per `CLAUDE.md`.
- This gate report is read-only synthesis. No implementation files were modified.

---

*End of Beta Release Gate Report.*
