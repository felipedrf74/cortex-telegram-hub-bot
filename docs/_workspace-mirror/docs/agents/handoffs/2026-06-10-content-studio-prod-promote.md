# Handoff: Content Studio → production promotion — Codex

Date: 2026-06-10
From: Claude (Fable 5) — Content Studio implementation + E2E fix + TestFlight cut session
To: Codex — finish the production promotion
Style: prose context first, caveman execution after.

## Part 1 — State (prose, read once)

Everything is on main in both repos; nothing is on side branches.

iOS repo `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub`, branch
`main` @ `6393ab2`, pushed. Build **1.5.0 (38)** (Content Studio + the five
Codex-E2E fixes) was archived and **uploaded to App Store Connect at
2026-06-10 21:18 — "Upload succeeded"**. The iOS side of prod is DONE except
App-Store-Connect-side verification and tester assignment (manual, below).
Release gate `scripts/beta-release-validate.sh local` passes (curated
2026-06-10 at Felipe's direction, commit `6393ab2`); evidence note:
`docs/beta/release-evidence-current.md`.

Engine repo (workspace `engine/` symlink), branch `main` @ `6651085e`,
pushed. Sandbox gates already passed this evening (sandbox:up, sandbox:smoke
"Release sandbox smoke passed", deploy-harness — all exit 0). What remains
is the standard staging → prod chain. `6651085e` is additive only: decision
overview `sourceSkill` filter, capture provenance into audit_metadata_json,
idempotent topic create (no migrations — verify with the gate as usual).

WHY the engine promote matters for iOS: build 1.5.0's offline capture outbox
relies on the backend honoring `idempotencyKey` on POST /api/v1/content/topics
for duplicate-safe retries. Until `6651085e` is in prod, capture retries can
duplicate topics. Promote BEFORE external testers; internal testers are
acceptable meanwhile.

Known/accepted (do not re-litigate): 3 pre-existing iOS baseline unit reds
(chipped); workspace-landing content visual cells XCTSkip'd; paywall-
disclosure audit finding OPEN — flag before any EXTERNAL TestFlight cohort.

## Part 2 — Engine promote (caveman)

Work in the engine repo. One human owner. One deploy path. No skipped gates.

1. Confirm state:
   git status --short --branch        # main, clean, at 6651085e
   npm run release:focused-verify     # must be green (was green at commit)
2. RC evidence per the standard gate (full Vitest in signed CI evidence —
   follow the same chain CURRENT_RELEASE_STATE.md documents for 4.14.208).
   npm run release:rollback-drill-check   # drill must be fresh
3. Staging deploy + staging smoke. Use the SAME commands the last promote
   used (documented in docs/release/CURRENT_RELEASE_STATE.md). Staging smoke
   must pass FULLY before any production mutation. Do not skip.
4. Production promote:
   ./scripts/promote-to-prod.sh
   Expect: typecheck, science-policy pin validation, full Vitest, build,
   bot.db backup, native rebuild, PM2 restart — same shape as the 4.14.208
   entry.
5. Post-deploy health: content engine status ok + decision overview
   responds; then run scripts/release-identity.sh --persist and update
   docs/release/CURRENT_RELEASE_STATE.md per its update policy.
6. Verify the new contract live (read-only):
   curl prod /api/v1/decisions/overview?sourceSkill=content → 200 with
   sourceSkillFilter + sourceSkillTotalCount in envelope.

## Part 3 — iOS App Store Connect follow-through (caveman, manual UI)

1. App Store Connect → Nexus Hub → TestFlight.
2. Confirm build 1.5.0 (38) finished processing (uploaded 2026-06-10 21:18).
   If processing FAILED: capture Apple's error verbatim, report, stop.
3. Assign to the INTERNAL tester group. Release notes: Content Studio
   (four zones, composer, quick capture), plus stability fixes.
4. Do NOT invite external cohorts yet: paywall-disclosure audit finding is
   open, and the engine promote (Part 2) must land first for capture
   idempotency. Both conditions, not either.
5. Record the cut in the workspace ledger per CURRENT_RELEASE_STATE.md
   conventions (TestFlight section — this upload does not claim App Store
   public release).

## Rules

- Branches: main only, both repos. No force-push, no reset, no cleanup.
- Do not modify scripts/beta-release-validate.sh further.
- Report blockers with exact output; fix nothing outside this scope without
  approval.
