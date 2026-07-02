# Open Items

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-07-02
Update policy: keep only current carryovers here. Historical closed, fixed, and
deferred rows for the 2026-05 sweep live in
`docs/release/OPEN_ITEMS_ARCHIVE_2026-05.md`. Rotate monthly with
`engine/scripts/rotate-open-items.mjs`.

## Current Wave 1 Operator Gates

These require Felipe/operator action or physical devices. They are not Codex
closable without explicit authorization and live credentials/devices.

- Signed TestFlight archive/upload from Xcode.
- Two-account physical walkthrough on Felipe + Jaqueline devices.
- Real provider-state validation for Gmail/Outlook/Health/Garmin on devices.
- First-48-hours Garmin tenant-isolation watcher observation after cohort start.
- App Store metadata / privacy nutrition label review before broad Wave 1.

## Current Engineering Carryovers

| ID | Severity | Area | Status | Next step |
| --- | --- | --- | --- | --- |
| TRN-SKILL-E2E-VALIDATION | P1 | training | CONTAINER LANE EXECUTED 2026-07-02 / LIVE-CALENDAR AUTH PENDING | The authorized isolated container lane ran formally for the first time on main (run `training-e2e-20260702143816-f0c3fc3e`): **23 iOS tests / 22 passed**; the isolated-backend loop (Today → complete → feedback persists → Plan incl. learning focus + sync row → Progress) PASSED. It caught and drove the fix for a real learning-path persistence regression (see handoff `docs/agents/handoffs/2026-07-02-training-ux-round.md`). Residual: one infra-flaky fixture test (`kAXErrorIPCTimeout`, stabilization task filed); harness hardening landed (fileURLToPath, COPYFILE_DISABLE, DerivedData relocated to /private/tmp). Live-provider calendar lifecycle writes remain gated (`NEXUS_TRAINING_E2E_LIVE_CALENDAR_ACK` + non-prod tokens). |
| TRN-REDFLAG-PRODUCER | P2 | training | OPEN / PRODUCT DECISION | Red-flag safety surfacing shipped on iOS (`TrainingSignal` gates on `safety_red_flag` family, 38e4927/94be966), but the only backend producer is `publishSafetyRedFlag` via structured health intake (`training-coach-v2.ts` `/health-intake/red-flag`), which is feature-flag gated and never called by iOS — the state is dormant in production paths. Decision recorded 2026-07-02: keep dormant for now; the roadmap option is shipping structured-intake UI plus enabling the coach-v2 flag. Deriving red flags from completion `painScore` was rejected (consent-scope implications). |
| TRN-DEADLETTER-VISIBILITY | P2 | training | IN PROGRESS 2026-07-02 (conditional) | Dead-lettered provider events (migration 220, `delete_failed` + `provider_sync_failure_count >= 5`) are invisible to iOS. This round exposes an additive `calendarCleanup` count on the plan read models ONLY if a reliable Training-linkage predicate exists on `secretary_agenda_items`; otherwise document as invisible and drop. Never surfaced via home `meta.reasonCodes` (would falsely flip `isFallback`). |
| REL-EVIDENCE-PERSISTENCE | P2 | release process | OPEN | The 2026-06-29 and 2026-07-02 promotes did not persist staging-smoke evidence JSON under `engine/docs/release/smoke-evidence/` (newest tracked file is `staging-smoke-7d529331-20260610T204235Z.json`). Restore evidence persistence in the promote pipeline so release-state sections can cite artifacts instead of session records. |
| REL-DRYRUN-AUTHOR | P2 | release hygiene | OPEN | Release-prep commits are authored as `Release Dry Run Test <test@example.invalid>` (`f0c3fc3e`; same class flagged in the 2026-06-15 QA). Fix the author identity in the release-prep flow. |
| PHASE2B5-CHAT-FASTPATH | P2 | chat architecture | PARKED / REOPEN TRIGGER ONLY | Reopen only if beta usage shows fastpath cache/coalescing bugs, a third real fastpath implementation appears, or a planned feature needs a unified iOS/Telegram/WebSocket fastpath. |
| GAP-CAL-1 | P1 | secretary | PARTIAL | Conflict-detection cron emits NotificationIntent, but broader Telegram-only cron migration remains open. |
| GAP-FIN-2 | P1 | finance | OPEN / OWNER DECISION REQUIRED | Decide non-Brazil finance jurisdiction model and behavior contract. |
| GAP-REL-6 | P1 | mock lint | OPEN / OWNER DECISION REQUIRED | Either authorize a larger mock-factory reduction batch or revise the <100-by-2026-08-01 commitment. |
| GAP-REL-7 | P1 | release gate | OPEN / OWNER DECISION REQUIRED | Decide whether two-account E5 becomes a hard CI/deploy gate or remains operator evidence. |
| CF-BOT-MGMT-1 | P2 | Cloudflare edge tooling | OPEN | Update `scripts/cloudflare-edge-unblock.mjs` to use a focused Free-plan-safe Bot Management payload so operators no longer need `--skip-bot-management` plus manual focused `curl`. |

## Recently Closed

| ID | Severity | Area | Closed | Evidence |
| --- | --- | --- | --- | --- |
| TR-REDESIGN-GATES | P1 | training redesign | 2026-07-02 | The zone redesign (Today/Plan/Progress + coach reasoning sheet) shipped: iOS `training-redesign/retirement` is an ancestor of `main` (main at `38b3bb5` carries the zone IA plus 18 follow-up Training commits), and the paired backend Phase-0 endpoints are live in prod `4.14.211`. Gate history: Q0 PASS; Q1/Q2 executed with findings; Q3 last formal verdict was NO-GO (2026-06-12), and its blockers were subsequently fixed individually on main — `de7d170`/`013bec1` (day-anchor, carousel, gate-card id), `2d54ce1` (light-mode Progress picker contrast), `2926be8` (history unit pairing), `b4c359b`/`3a90f7b` (Athlete Profile questionnaire CTA), and engine `training.ts` energy-from-fatigue derivation (pinned by `training-routes.test.ts` rerun-5/6 S12 tests). No formal Q3 re-run happened; residual manual sweeps (wearable matrix, pt-PT/pt-BR runtime, keep-original loop) are folded into the 2026-07-02 Training UX round manual matrix. Parked v1.1 follow-ups remain listed in the Q3 work order. |
| TRN-REMEDIATION | P1/P2 | training | 2026-06-03 | Code remediation executed end-to-end across backend Training coach, chat/parser/action registry, plan generation, safety/load math, sport engines, lifecycle/routes, iOS decoding/state/rendering, and low-adherence product surface. Evidence: backend `npm run verify` passed typecheck, science-policy pin check, and full Vitest **807 files / 11,794 tests**; `NODE_ENV=development TELEGRAM_BOT_TOKEN=local-training-eval-token-disabled TELEGRAM_ALLOWED_USER_IDS=1 npm run eval:training` passed with score **99/100** across **156** cases; iOS simulator build passed; focused iOS Training suite passed **113/113**; full `scripts/ios-single-simulator-test.sh` passed **1,451 XCTest tests** plus **10 Swift Testing cases**. Remaining signed TestFlight/device, HealthKit/Watch, Garmin, provider-state, APNs, and two-account proof stays in the operator gates above. |
| GAP-TRN-1 | P1 | training | 2026-05-12 | Engine `b35ed604` runs strict write-free plan-linter preflight before cancellation/persistence and returns `plan_quality_blocked` without plan/session/calendar writes; iOS `d337636` renders that state as failed/requires-review instead of created. Focused backend 36/36, route 31/31, broad Training 908/908, iOS focused 14/14, and broader iOS Training subset 85/85 passed. |
| GAP-REL-1 | P1 | docs/identity | 2026-05-12 | Re-ran `engine/scripts/release-identity.sh markdown --persist --quiet`; `docs/release/release-identity.md` now points at backend `feature/decision-center-logic-v2` commit `9d34f3fd` and iOS `feature/decision-center-logic-v2` commit `460850c`. Docs audit rerun after mirror refresh. |
| GAP-REL-2 | P1 | docs/release | 2026-05-12 | Reconciled workspace current release state so 4.14.149 Round E + Decision Center remains the active production truth and older 4.14.132 notes are marked historical. |
| W1-FIN-COLLECTORS | P1/P2 | finance collectors | 2026-05-12 | Added collector-service owner-scope enforcement before Amazon/Uber global browser session or Playwright launch paths, preserving the existing Telegram command and owner-tier scheduler gates. Broad per-user collector sessions remain a separate future product/credential workstream. |
| GAP-CONT-1 | P0/P1 | content runtime | 2026-05-12 | Portal channel writes now reject client-supplied owned-channel markers unless ownership is server-verified, and YouTube creator analytics scope resolution ignores unverified manual metadata. Backend live performance aggregation and iOS performance dashboard truth are now wired under GAP-CONT-3/GAP-CONT-4. |
| GAP-CONT-3 | P1 | content loop | 2026-05-12 | Content performance aggregate now reads tenant-scoped live `content_performance` metrics for recent views, retention, likes, comments, subscriber gain, top items, and retention warnings instead of stopping at radar feedback. Focused aggregate tests cover live metrics and user isolation. |
| GAP-CONT-4 | P1 | iOS content | 2026-05-12 | Verified existing iOS content performance surface from commit `d91b3ec`: `ContentIntelligenceView` renders views, retention, likes, comments, subscriber gain, and top performer from `performanceSummary`; focused `ModelDecodingTests` for summary/detail performance payloads passed 2/2. |
| ROUND-B-FIXTURE | P2 | staging fixture | 2026-05-12 | Added `--felipe-volume-calendar` / `--calendar-events 100` staging fixture mode. Synthetic reserved users can now seed 100 DB-backed read-only calendar events consumed by `unified-calendar`, calendar routes, and dashboard timing probes without real OAuth/provider writes. Operator still needs to run staging before/after evidence. |

## Authorization-Gated Codex Workstreams

| Queue | Status | Notes |
| --- | --- | --- |
| Batch 25 | pending authorization | Content lifecycle unification phase 1: audit and plan. |
| Batch 26 | pending authorization | Content lifecycle schema migration phase. |
| Batch 27 | pending authorization | Content lifecycle service/API migration phase. |
| Batch 28 | pending authorization | Content lifecycle iOS/Python contract and cleanup phase. |

## Evidence Gaps To Preserve

- Batch 17 iOS P2 remediation report was not reconstructable in the Batch 24
  archive pass. Revalidation exists at
  `docs/archive/2026-05/tech-debt-validation/codex-batch-17-revalidation.md`.
- Batch 1 does not have a standalone remediation artifact; evidence is
  preserved in
  `docs/archive/2026-05/tech-debt-validation/codex-tech-debt-pass.md` and
  `docs/archive/2026-05/tech-debt-validation/codex-validation-matrix.md`.
