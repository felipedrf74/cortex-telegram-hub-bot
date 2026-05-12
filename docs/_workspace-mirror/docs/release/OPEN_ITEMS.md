# Open Items

Status: canonical
Owner: release lead (Felipe)
Last verified: 2026-05-11
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
| W1-FIN-COLLECTORS | P1/P2 | finance collectors | OPEN | Amazon and Uber invoice collectors still use global filesystem browser sessions/credentials for manual Telegram commands. Run a focused tenant-safety round before broad multi-user finance rollout. |
| PHASE2B5-CHAT-FASTPATH | P2 | chat architecture | PARKED / REOPEN TRIGGER ONLY | Reopen only if beta usage shows fastpath cache/coalescing bugs, a third real fastpath implementation appears, or a planned feature needs a unified iOS/Telegram/WebSocket fastpath. |
| GAP-CONT-1 | P0/P1 | content runtime | PARTIAL | OAuth/owned-channel writer still needs owner authorization before live creator analytics can be considered enabled. |
| GAP-TRN-1 | P1 | training | OPEN / OWNER DECISION REQUIRED | Decide whether plan-linter blockers should become strict pre-persist or rollback-safe training batch behavior. |
| GAP-CONT-3 | P1 | content loop | OPEN / PRODUCT WORKSTREAM REQUIRED | Wire performance-feedback adaptation to live `content_performance` before claiming the radar loop is closed. |
| GAP-CONT-4 | P1 | iOS content | PARTIAL | Add performance dashboard truth for views/retention/likes/comments; publishing calendar coverage alone is not complete. |
| GAP-CAL-1 | P1 | secretary | PARTIAL | Conflict-detection cron emits NotificationIntent, but broader Telegram-only cron migration remains open. |
| GAP-FIN-2 | P1 | finance | OPEN / OWNER DECISION REQUIRED | Decide non-Brazil finance jurisdiction model and behavior contract. |
| GAP-REL-1 | P1 | docs/identity | OPEN / REVALIDATE | Re-run release identity generation and docs audit; previous row cited stale workspace release identity. |
| GAP-REL-2 | P1 | docs/release | OPEN / REVALIDATE | Reconcile engine/workspace current release docs after latest production deploys. |
| GAP-REL-6 | P1 | mock lint | OPEN / OWNER DECISION REQUIRED | Either authorize a larger mock-factory reduction batch or revise the <100-by-2026-08-01 commitment. |
| GAP-REL-7 | P1 | release gate | OPEN / OWNER DECISION REQUIRED | Decide whether two-account E5 becomes a hard CI/deploy gate or remains operator evidence. |
| ROUND-B-FIXTURE | P2 | staging fixture | OPEN | Add a 100-calendar-event seeding mode to produce repeatable Felipe-volume before/after dashboard wall-time evidence. |

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
