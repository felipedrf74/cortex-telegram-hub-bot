# Done Index — completed task-execution work-streams

Status: canonical
Last verified: 2026-05-10
Owner: workspace lead (Felipe)
Update policy: append a row when a closeout or hostile-QA verdict closes a work-stream. Files are NOT moved here; this is a catalog over the archive convention. The actual artifacts live under `docs/archive/YYYY-MM/<round>/` (workspace) and `engine/docs/archive/YYYY-MM/<round>/` (engine mirror).

Why a catalog instead of physical moves:
1. `docs/archive/YYYY-MM/` is already the project's de facto Done folder.
2. Moving files would break cross-references in `docs/release/OPEN_ITEMS.md` and DOCS_INDEX.
3. The catalog gives a single read-only view of every closed work-stream while preserving git history and links.

If Felipe wants physical moves, that's a follow-up cleanup round after Wave 1 ships.

## Production-shipped rounds (engine 4.14.x)

| Work-stream | Closeout | Verdict | Production version | Notes |
|---|---|---|---|---|
| P0 Garmin tenant leak + Apple Health cascade | `docs/archive/2026-05/p0-garmin-tenant-leak-and-applehealth-cascade/closeout.md` | READY_FOR_LOCAL_QA → promoted | engine 4.14.146, deploy commit `d05e3bac` | 5 contaminated production rows cleaned (users 25, 28, 29, 30, 86) |
| P0 tenant + safety Round A | `docs/archive/2026-05/p0-tenant-and-safety-2026-05/closeout.md` | SOURCE_AND_LOCAL_VALIDATION_COMPLETE → promoted | engine 4.14.147, deploy commit `95a42c80` | google-drive per-user OAuth, iOS sign-in race, deep-link scope, keychain scoping, APNs revoke, chat-fastpath cache key, websocket tenantId, onboarding UserDefaults, Sentry redaction, api_cache safety valve, closed-beta gate verification |
| P0 tenant + safety + perf Round B | `docs/archive/2026-05/p0-tenant-and-safety-and-perf-2026-05/closeout.md` | SOURCE_AND_STAGING_VALIDATION_COMPLETE → promoted | engine 4.14.148, deploy commit `8ceb99e1` | DASHBOARD_READINESS_CACHE_TTL 300s, fetchTraining parallelization, daily_context_cache index, reminder cron mutex, cache cascade batch, logger redaction once, /content/topics pagination, audit_trail compound index, provider router cold-start, iOS DateFormatter static, ReceiptReviewSheet image, weak-self timer, JSON decode off-main, Dynamic Type, reduce-motion, a11y labels |
| Round E launch blockers | `docs/archive/2026-05/round-e-launch-blockers/closeout.md` | SOURCE_AND_STAGING_VALIDATION_COMPLETE | not promoted yet | F-A tenant source audit clean; Decision Center/APNs Round D fixes; App Store/GDPR/LLM hardening; Sentry/cache/onboarding carryovers; staging smoke 18/18 |
| Launch-readiness sweep (Tasks A/B/C/D) | `docs/archive/2026-05/launch-readiness-sweep/closeout.md` | READY_FOR_LOCAL_QA → promoted | engine 4.14.147 base | iOS single-flight test (Task A on phase2b4), Apple Health partial sufficiency (Task B), Amazon/Uber audit memo (Task C), Garmin tenant isolation watcher (Task D) |
| Tech-debt sweep | `engine/docs/archive/2026-05/tech-debt-validation/sweep-closeout-dossier.md` | source-closed and deployed | engine 4.14.134 | 27 codex-validation batches (workspace) + 5 batches (engine archive). State isolation, JWT rotation, PM2 recovery, Gemini SDK migration, mock hygiene, docs hygiene |

## Phase 2B architecture rounds

| Round | Closeout | Verdict | Notes |
|---|---|---|---|
| Phase 2B.1 — workspace landing state module | `docs/archive/2026-05/phase2b1-workspace-state-module/closeout.md` + `visual-qa-closure-closeout.md` + 3 hostile-QA reports | READY_FOR_LOCAL_QA + visual closure complete | iOS-only; visual matrix 38 cells across 5 surfaces; merged to iOS main on 2026-05-09 |
| Phase 2B.2 — cache-invalidator registry | `docs/archive/2026-05/phase2b2-cache-invalidator-registry/closeout.md` + `manual-probe-addendum.md` | READY_FOR_HOSTILE_QA → promoted | Engine; deleted 11 invalidator modules; centralized in `cache-coherence-registry.ts`; 22-event graph |
| Phase 2B.3 — API route helper | `docs/archive/2026-05/phase2b3-api-route-helper/closeout.md` + `hostile-qa-report.md` + `manual-probe-addendum.md` | READY_FOR_HOSTILE_QA → promoted | Engine; cached-route-handler primitive; migrated 6 route files (plan, calendar, content, dashboard, notifications, tasks); -81 LoC |
| Phase 2B.4 — iOS Repository primitive | `docs/archive/2026-05/phase2b4-ios-repository-primitive/closeout.md` + `hostile-qa-report.md` + `visual-matrix-manifest.md` | READY_FOR_LOCAL_QA → merged to iOS main + version bump 1.4.2(16) | iOS; CachedResource<Value> primitive composed by 13 repositories; visual matrix 80/80 with 80 PNG screenshots; release optimizer crash fix landed |
| Phase 2B.5 — chat fastpath dedup | `engine/docs/archive/2026-05/phase2b5-chat-fastpath-dedup/closeout-deferred.md` | DEFERRED_WITH_REASON | Source-side probe: 14 mentions, 4 actual call sites, prototype LoC delta +152 → deferred. Re-open trigger documented |

## Other completed work-streams

| Work-stream | Closeout | Verdict | Notes |
|---|---|---|---|
| Phase 2A Wave 2 blockers | `docs/archive/2026-05/phase2a-wave2-blockers/closeout.md` | local impl + staging smoke | superseded by later Wave-1 sweep |
| Perf cache + compression | `docs/archive/2026-05/perf-cache-and-compression/closeout.md` | superseded by Round B | |
| Perf Outlook token cache | `docs/archive/2026-05/perf-outlook-token-cache/closeout.md` | promoted | engine 4.14.141 |
| Closed-beta block fixes | `docs/archive/2026-05/closed-beta-block-fixes/closeout.md` | phase 1 staged | |
| Staging fixture harness | `docs/archive/2026-05/staging-fixture-harness/closeout.md` | READY_FOR_HOSTILE_QA → landed | harness with `--seed-apple-health` etc. |
| Secretary notification orchestrator | `docs/archive/2026-05/secretary-notification-orchestrator/` (5 files) | closed via APNs prod ops verification | substrate for Decision Center |
| Event backbone read-models + delta sync | `docs/archive/2026-05/event-backbone-readmodels-delta-sync/` (6 files) | READY_FOR_LOCAL_QA per OPEN_ITEMS | |
| Chat reasoning engine v1 | `docs/archive/2026-05/chat-reasoning-engine-v1/` (3 hostile-QA reports v1/v2/v3) | F-IOS-1 / F-DOCS-1 v4 closure complete | |
| Auth registration hardening | `docs/archive/2026-05/auth-registration-hardening/` | shipped per release index | engine 4.14.127 |
| Closed-beta backlog drain codex-validation | `docs/archive/2026-05/closed-beta-backlog-drain-codex-validation/codex-validation.md` | codex-validated | |
| Closed-beta auth/training codex-validation | `docs/archive/2026-05/closed-beta-auth-training-engineering-codex-validation/codex-validation.md` | codex-validated | |
| Content creation UI codex-validation | `docs/archive/2026-05/content-creation-ui-codex-validation/codex-validation.md` | codex-validated | |
| Technical suite mastery codex-validation | `docs/archive/2026-05/technical-suite-mastery-codex-validation/codex-validation.md` | codex-validated | |
| Engineering excellence codex-validation | `docs/archive/2026-05/engineering-excellence-codex-validation/` + `-20260504/` | codex-validated | |
| Engineering excellence architecture standards | `docs/archive/2026-05/engineering-excellence-architecture-standards/engineering-excellence-enrichment-report.md` | shipped | |
| Closed-beta gap analysis | `docs/archive/2026-05/closed-beta-gap-analysis/all-skills-gap-analysis-report.md` | baseline; all P0/P1 closed in OPEN_ITEMS | |
| Workspace release docs (training recovery, event backbone, claude.md sync) | `docs/release/training-recovery-fix-testflight-checklist.md`, `docs/release/event-backbone-readmodels-delta-sync-report.md`, `docs/release/staged-claude-md-update-after-2026-05-deploy.md` | superseded by Wave1 runbook + later remediation | |
| Engine training release archive | `engine/docs/release/archive/2026-04/training/` (8 files) | resolved per 4.14.x production releases | |
| Engine cooking-training pre-v2 archive | `engine/docs/release/archive/2026-05-01-pre-v2/cooking-training/` (5 files) | resolved | |
| Engine nexus-hub-rc pre-v2 archive | `engine/docs/release/archive/2026-05-01-pre-v2/nexus-hub-rc/` (4 files) | resolved | |
| Engine closed-beta hardening report 2026-05-03 | `engine/docs/release/archive/2026-05/closed-beta/` | shipped | |

## Evidence files (closeout supporting docs)

These are evidence artifacts (smoke probes, cleanup script outputs, etc.) under `engine/docs/release/smoke-evidence/`. They are not work-streams themselves but document the verification trail. Top files:

- `engine/docs/release/smoke-evidence/staging-smoke-{commit}-{timestamp}.json` — staging smoke verdicts
- `engine/docs/release/smoke-evidence/staging-perf-a11y-fixture-probe-20260510T154733Z.json` — Round B fixture probe
- `engine/docs/release/smoke-evidence/staging-garmin-tenant-isolation-watcher-20260509T233855Z.json` — watcher verification
- `engine/docs/release/smoke-evidence/prod-cleanup-{phase}-{timestamp}.json` — production Garmin cleanup script outputs (May 9, user 25/28/29/30/86 cleaned)
- `engine/docs/release/smoke-evidence/prod-non-owner-readiness-probe-user28-clean-20260509T174858Z.json` — Jaqueline post-fix readiness probe (84 score, 78 body battery, Apple Health driven)

## Counts

- Total done work-streams catalogued: **25**
- Total closeout/hostile-QA artifacts: **~56 files** under `docs/archive/2026-05/` (workspace) + `engine/docs/archive/2026-05/` (engine mirror)
- Plus 27 tech-debt-validation batch files + 5 engine-side batches

## Cross-reference safety

The Bucket A files in this index are referenced by:
- `docs/release/OPEN_ITEMS.md` — points to several archive paths via relative links; the catalog approach preserves these
- `docs/release/CURRENT_RELEASE_STATE.md` — references production deploy commits; archive paths unchanged
- `docs/DOCS_INDEX.md` — does NOT reference archive contents directly; safe

Moving files would require updating OPEN_ITEMS.md cross-refs. Catalog approach has zero breakage risk.
