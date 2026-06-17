# Handoff: Content Studio E2E verification — Codex

Date: 2026-06-10
From: Claude (Fable 5) — Content Studio end-to-end implementation session
To: Codex — full E2E test run + navigation/input sweep
Repo: `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub` (main, local commits NOT pushed)
Companion: engine repo (workspace `engine/` symlink), commit `6651085e`, also not pushed.

## Part 1 — Scope and context (prose)

The Content Creation skill was rebuilt end to end as the **Content Studio**
(ADR-0005, ADR-0006 in `docs/adr/`): four zones (Today / Pipeline / Calendar /
DNA) behind a custom serif masthead + pill switcher, one unified content item
(detail screen with Brief/Script/Schedule/Tasks/Notes facets), a
create-then-attach Composer, a quick-capture bar with a file-protected offline
outbox, and typed deep links (`DeepLinkRouter.ContentDestination`). The legacy
landing page and three legacy screens are deleted; the studio is the only
content path. Backend gained skill-scoped decision overview + capture
provenance + idempotent topic creates (engine `6651085e`).

iOS commits, in order: `126fb20` `c43f7f2` (Phase 0) · `3c086af`
(release-hardening drift fix) · `47d2511` `31144fe` `2752434` `8c2bd4e`
(Phase 1) · `537f97a` `3ff7156` `c7addb5` `1d90120` `bf730e0` `2e72fc3`
`49fba1a` `7952a22` (Phase 2) · `8d33f9c` `097d8f9` `d51a73f` `c995e5f`
`ba5e42a` + UI-suite commit (Phase 3) · `0bef70d` `e191def` (Phase 4).

Evidence so far (all on iPhone 17 Pro, UDID below): every phase closed its
gate — final close: **1,667 unit passed** with exactly the 3 documented
pre-existing baseline reds (below), **20/20 studio UI tests**, serif guard
clean, build clean. Your job: independent full E2E confirmation + the
navigation/input sweep, and an honest findings log. **Fix nothing without
approval — report.**

### Known baseline (NOT yours to fix, do not count as new findings)
1. `NavigationPerformanceSourcePinsTests.test_chatTopTrailingButtonRoutesHomeNotCommandPalette`
   — stale source pin (`pendingTab = 0` literal gone since before this work).
2. `NexusNLPTests.test_intentKeywords_verbsAndNouns` + `_lowercased` — NLP
   tagger drift on the iOS 26.5 runtime. (Both have a pending task chip.)
3. `WorkspaceLandingVisualUITests` content-domain cells are `XCTSkip`'d —
   the studio radar surface (`ContentIntelligenceView`) cannot be
   scenario-forced yet; re-enable condition named in the skip message.
4. Live-workflow suite: 2 tests skip without a live `nexushubbot` session;
   two QA topics tagged "Codex QA …" may be created on bot runs (tag-don't-
   delete policy; clean up manually).
5. Deliberately surviving legacy files: `ContentTasksView`,
   `TopicSchedulerView` (real internal links from `ContentIntelligenceView`),
   `TopicEditorView`, `ContentStudioFlags` (kill-switch seam, unconsulted).

## Part 2 — Test execution (caveman)

Environment hazards. Respect all five:
- Sim pinned: `IOS_SIM_UDID=4F72CBB1-1600-4821-AB9B-6A1DDFA43D8C` (two
  "iPhone 17 Pro" exist — unpinned runner aborts).
- Derived data MUST be isolated: `IOS_DERIVED_DATA_PATH=/tmp/<yours>` —
  shared DerivedData locks against concurrent agent builds (your own
  xcodebuildmcp included).
- Scheme split strict both ways: default "Nexus Hub" scheme = unit-only;
  UI bundle needs `IOS_SCHEME="Nexus Hub Debug UI Smoke"`. Mixed targets in
  one invocation → "isn't a member of test plan" error. Always two runs.
- Chunked CI workflow never sets IOS_SCHEME — latent gap, do NOT "fix"
  silently; note it.
- Studio UI launch recipe (already inside studio suites, FYI for manual
  drives): `-NexusUITestMode YES` + env `NEXUS_UI_TEST_MODE=1`,
  `NEXUS_SKIP_AUTH=1`, `NEXUS_ENTITLEMENT_FIXTURE=max`. State forcing:
  `-nexus_quality_scenarios content_studio_{cold_start,quiet,stale_cache,degraded,empty_pipeline}`.

Run, in order:
1. Full unit: `cd "/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub" && IOS_SIM_UDID=4F72CBB1-1600-4821-AB9B-6A1DDFA43D8C IOS_DERIVED_DATA_PATH=/tmp/codex-dd ./scripts/ios-single-simulator-test.sh`
   Expect: 3 baseline fails only. Anything else = finding.
2. Studio UI (5 suites): same script + `IOS_SCHEME="Nexus Hub Debug UI Smoke"` +
   `"-only-testing:Nexus HubUITests/ContentStudioShellUITests"` … TodayStates,
   Pipeline, Composer, QuickCapture. Expect 20/20.
3. Chunked UI sweep: `IOS_SCHEME="Nexus Hub Debug UI Smoke" IOS_SIM_UDID=… bash scripts/ios-ui-suite-chunked-test.sh`
   (export IOS_SCHEME — see hazard above). Live suites skip without bot
   session — skips are policy, not failures.
4. Guards: `./scripts/ios-serif-usage-check.sh` + `./scripts/ios-release-hardening-validate.sh` + `./scripts/beta-smoke-local.sh`.
5. Engine (only if touching backend): `cd engine && npm run release:focused-verify`.

Evidence format: `TestResults.xcresult` + `test-summary.json` per run +
findings log in the 21-IOS-PRODUCT-FLOW-AUDIT structure (Open / Fixed /
Retest / Remaining risks). Per finding: repro steps, severity, file pointer.

## Part 3 — Navigation/input sweep (caveman)

Manual simulator drive, studio launch recipe above. Sweep, PT-BR primary +
one EN pass; Dynamic Type AX3 + Bold Text pass on masthead/pills/quotes:

- Entry: Áreas tab → content card → studio renders, masthead collapses on
  scroll (crossfade, no glyph tearing), pill switcher AA contrast.
- Zones ×4: switch repeatedly; pushed detail survives zone switch (root owns
  destinations); @SceneStorage stickiness across backgrounding.
- Deep links: `xcrun simctl openurl <UDID> "nexus://content/script/1"` (tap
  Open) → lands content; all four push types via `-nexus_quality_scenarios`
  equivalents not available — verify mapping table via
  ContentStudioRouterTests instead (unit, already green).
- Hero ladder: force each of 5 states → card honest, id stable, CTA presence
  per state (cold-start/empty have CTA, quiet/stale/degraded do not).
- Pipeline: lane switches; Ideas shelf verbs (context menu + ellipsis);
  Undeveloped strip + Triage card 4 verbs; lifecycle disclosure expands
  (loading/retry honest against dead backend).
- Item detail: stage tracker tap → picker (persistent undo path); all 5
  facet sheets open/close; back from detail keeps zone.
- Composer: pristine dismiss silent; dirty dismiss guarded; develop step
  embeds script card; finalize stage chips honest (film/edit collapse note).
- Capture: faux field → bar morph (feed must NOT scroll); mic permission
  honest path; return files (soft) vs hardware newline; burst: 3 rapid
  captures → aggregate toast; offline: submits park in outbox chip → Retry
  all; cancel keeps visible draft; outbox purge on sign-out.
- Keyboard: bar never traps focus; AX sizes keep submit reachable.
- Wrong-turn: from deep facet sheet, escape to another zone ≤3 taps.
- Entitlement: relaunch WITHOUT `NEXUS_ENTITLEMENT_FIXTURE` → locked card +
  paywall path renders (studio never leaks).

Report: issues/bugs/gaps only, with repro + severity + file pointer. No
fixes without approval. Leftover QA topics: tag, don't delete.
