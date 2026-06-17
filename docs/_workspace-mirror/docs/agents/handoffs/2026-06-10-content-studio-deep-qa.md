# Handoff: Content Studio deep interactive QA — Codex

Date: 2026-06-10
From: Claude (Fable 5)
To: Codex — deep QA with REAL data input + validation, local Docker engine + simulator
Scope: ONLY what shipped in the Content Studio work (iOS commits `126fb20`..`6393ab2`,
engine `6651085e`). Do not audit unrelated skills.

## Part 1 — Mission (prose)

This is not a navigation smoke. Drive the app like a demanding creator for a
full session: press every button in scope, type real text, dictate, submit,
retry, schedule, reschedule, delete, undo. Watch behaviors and OUTPUTS, not
just screens: every action must produce the correct server-side state on the
LOCAL engine (verify via API/DB, not just UI), and every failure must surface
honestly (no silent drops, no dead spinners). Capture screenshots at each key
surface and judge visual quality against the ADRs. Two special mandates:
(1) prove the DNA section actually CHANGES script generation — edit the voice
profile/references, regenerate, and diff the outputs; (2) prove the engine
agents (script generation, decision center/needs-you, secretary topic sync,
radar) round-trip correctly with the iOS frontend.

Use the dedicated bot account `nexushubbot@gmail.com` for all data creation —
register/sign it into the LOCAL engine instance (never create dummy data
against production). All dummy data lives and dies in the local Docker engine.

## Part 2 — Environment (caveman, exact)

1. Engine in Docker (local):
   cd "/Users/felipedominguez/Desktop/Nexus Hub/engine"
   git status --short --branch   # main @ 6651085e or later
   docker compose -f docker-compose.local.yml up -d
   # readiness: curl http://127.0.0.1:8200/health (or the compose-documented
   # readiness route — read docker-compose.local.yml + engine README first)
2. iOS app → local engine:
   READ "Nexus HubUITests/LocalEngineUITestHelpers.swift" — it documents the
   exact launch environment that points the app at http://127.0.0.1:8200
   (simulator loopback). Use the SAME env when launching via xcodebuildmcp /
   simctl so your interactive session and any XCUITest runs hit the same
   local engine. Do NOT use NEXUS_SKIP_AUTH for this QA — sign in for real
   with nexushubbot@gmail.com against the local engine (register it locally
   if the local DB is fresh).
3. Simulator pins: UDID 4F72CBB1-1600-4821-AB9B-6A1DDFA43D8C (iPhone 17 Pro,
   iOS 26.5); your own derived data under /tmp; UI suites need
   IOS_SCHEME="Nexus Hub Debug UI Smoke"; unit suites default scheme.
   Build/install: xcodebuild or xcodebuildmcp; drive interactively with
   xcodebuildmcp (tap/type/screenshot) — that is the point of this QA.
4. Repos are read-only for you EXCEPT the findings report. Fix nothing.

## Part 3 — Deep QA script (caveman; per item: DO → EXPECT → VERIFY OUTPUT)

Seed reference: before starting, snapshot the local DB topic count for the
bot tenant (sqlite or GET /api/v1/content/topics) so every creation below is
verified by COUNT+CONTENT, not vibes. After EVERY step: check the app for
error banners; check `docker compose logs --since 2m` for engine errors;
screenshot if anything looks off.

A. CAPTURE → PIPELINE (creation truth)
   1. Today zone → quick capture: type "Treino de águas abertas — medo" →
      submit. EXPECT optimistic clear + refocus + toast "Filed to Pipeline".
      VERIFY: GET topics shows it, status planned, audit_metadata_json has
      provenance {source: "capture", clientRequestId}.
   2. Burst: file 3 captures in <10s. EXPECT aggregate toast ("3 filed"),
      3 topics server-side, zero duplicates.
   3. Long capture (>120 chars + newline). EXPECT split: title ≤80 at clean
      boundary, remainder in notes. VERIFY server title/notes exactly match
      the split rule.
   4. Offline: pause the engine container (docker compose pause), submit a
      capture. EXPECT honest error + draft parked in visible outbox chip.
      Unpause, tap Retry all. EXPECT exactly ONE topic created (idempotency
      key honored — this is engine 6651085e; duplicates = P1 finding).
   5. Mic: tap mic, grant permission, dictate a phrase. EXPECT partial
      transcript streaming into the field; submit files it.

B. COMPOSER (create-then-attach + plan creation)
   1. FAB → type title → "Just save it". EXPECT toast; topic exists server-
      side with source "composer".
   2. FAB → title → "Develop it" → fill brief fields → Continue. EXPECT
      topic notes gain the "— Brief —" block server-side.
   3. In develop step: generate a script (local engine must have its LLM
      path configured — if generation requires external keys absent locally,
      record as ENV-LIMITED, don't fake a pass). EXPECT generating state with
      budget copy + working cancel; on success, sections render (hook,
      titles, quality, sources); DISMISS THE SHEET MID-GENERATION once:
      EXPECT generation survives (FAB ring), re-entry resumes.
   4. Finalize: pick stage, schedule date+time via SchedulePicker → File.
      EXPECT single PATCH server-side (status + scheduled_at), dual-truth
      result (filed ✓ + sync state), and the SECRETARY agent creating the
      task/calendar artifacts (verify topic's secretary fields / task list
      via API; sync badge in item detail matches server state).
   5. Dirty dismiss (text typed, no topic): EXPECT Save/Discard/Keep dialog —
      verify each of the three actually does what it says (server-checked).
   6. Pristine-beyond-title discard at develop: EXPECT topic DELETED
      server-side (count returns to baseline).

C. PLAN CHANGES with dummy data (scheduling truth)
   1. Create 6+ dummy topics spread across: today, this week, next week,
      later, overdue (backdate via PATCH if the UI can't create past dates),
      unscheduled.
   2. Calendar zone: week strip dots match scheduled days; LIST mode groups
      EXACTLY per the server dates (overdue first, correct buckets);
      unscheduled tray shows the right set.
   3. Reschedule one topic via the schedule sheet. EXPECT change detection
      (Save disabled until changed), PATCH + read-back, day selection moves,
      Today hero/stage strip counts update after refresh.
   4. Delete one scheduled topic (confirm dialog). EXPECT server deletion +
      every zone consistent (calendar, pipeline counts, Today).
   5. Item detail stage tracker: move a topic forward AND backward via the
      stage picker. EXPECT status transitions persist server-side; film/edit
      both map to "ready" (documented collapse — verify the UI is honest
      about it, not lying about a distinct persisted stage).
   6. Triage: make 5+ undeveloped topics older than 7 days if feasible (or
      verify strip + single-item triage): run all four verbs — Develop,
      File as reference (EXPECT note created THEN topic deleted; kill the
      engine between legs once to force partial failure → EXPECT persistent
      retry, retry completes leg 2 only), Merge into (target notes gain
      "Merged capture:" line, source deleted), Delete (undo re-creates).

D. DNA → SCRIPT GENERATION (the causal test)
   1. Baseline: generate a script for a fixed topic title; save the full
      output text.
   2. DNA zone → Voice profile: change tone/audience/angle fields massively
      (e.g., "técnico e direto" → "humor irreverente, gírias cariocas");
      add a distinctive reference.
   3. Regenerate the SAME topic. EXPECT a materially different script
      reflecting the new voice (vocabulary, structure, hook style). Diff
      the two outputs; quote 3 concrete differences in the report. If the
      output is identical/near-identical → P1 finding: DNA not wired into
      generation (check whether the engine request carries the profile —
      inspect engine logs/request payloads to say WHERE it breaks).
   4. Learnings: weekly-learning highlight renders italic-sans until
      "Applied" (session-local serif flip — verify exactly that, no more).
   5. Radar row → run reaction radar; Pick/Skip/Reject one idea each from
      the Ideas shelf. EXPECT radar feedback POSTs land (engine logs/API)
      and the shelf state reflects them.

E. ENGINE AGENTS ↔ FRONTEND (decision center contract)
   1. Needs-you queue: with the local engine seeded (topics + decisions),
      EXPECT max 3 real prioritized items, no padding, vanish at zero;
      tapping each lands on the thing it announces.
   2. GET /api/v1/decisions/overview?sourceSkill=content (curl, local):
      EXPECT 200 + sourceSkillFilter + sourceSkillTotalCount fields.
   3. Notification deep links: simctl push or openurl for the four mapped
      types (topic_candidates_ready→Pipeline, script_ready→item Script
      facet, weekly_package_ready→DNA, content_action_required→item Tasks)
      — each lands item-level where applicable, never just the root.

F. VISUAL + ERROR SWEEP (continuous, plus one dedicated pass)
   - Screenshot: Today (each hero state you can reach with real data),
     Pipeline lanes, item detail + each facet, composer steps 1-3, calendar
     3 modes, DNA, Journal. Judge against ADR-0006: serif ONLY masthead/
     detail titles/hero/earned quotes; cards/chips sans; domainContent
     purple with near-black ink (never white-on-purple); honest empty
     states; no truncated PT-BR copy; spacing/alignment consistent between
     zones. File visual discrepancies WITH screenshots + concrete
     improvement suggestions (severity P3 unless it breaks comprehension).
   - Repeat key flows at Dynamic Type AX3 + Bold Text and in EN locale.
   - Console/log discipline: any SwiftUI runtime warning, layout loop,
     engine 5xx, or unhandled rejection during interactions = finding.

## Part 4 — Report

Findings log in the 21-IOS-PRODUCT-FLOW-AUDIT structure (Open / Fixed /
Retest / Remaining risks) with per-finding: repro steps, severity (P1-P3),
screenshot path, file pointer (iOS or engine), and for output-truth items
the API/DB evidence. Evidence bundle: screenshots dir + the topic-count
ledger (baseline → final, every delta explained). ENV-LIMITED items listed
separately (what couldn't run locally and why). Fix NOTHING without
approval. Teardown: docker compose -f docker-compose.local.yml down (local
dummy data may be destroyed with it).
