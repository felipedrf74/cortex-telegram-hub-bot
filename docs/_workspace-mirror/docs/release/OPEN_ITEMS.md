# Open Items

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-12
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
| PHASE2B5-CHAT-FASTPATH | P2 | chat architecture | PARKED / REOPEN TRIGGER ONLY | Reopen only if beta usage shows fastpath cache/coalescing bugs, a third real fastpath implementation appears, or a planned feature needs a unified iOS/Telegram/WebSocket fastpath. |
| GAP-CAL-1 | P1 | secretary | PARTIAL | Conflict-detection cron emits NotificationIntent, but broader Telegram-only cron migration remains open. |
| GAP-FIN-2 | P1 | finance | OPEN / OWNER DECISION REQUIRED | Decide non-Brazil finance jurisdiction model and behavior contract. |
| GAP-REL-6 | P1 | mock lint | OPEN / OWNER DECISION REQUIRED | Either authorize a larger mock-factory reduction batch or revise the <100-by-2026-08-01 commitment. |
| GAP-REL-7 | P1 | release gate | OPEN / OWNER DECISION REQUIRED | Decide whether two-account E5 becomes a hard CI/deploy gate or remains operator evidence. |

## Recently Closed

| ID | Severity | Area | Closed | Evidence |
| --- | --- | --- | --- | --- |
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
