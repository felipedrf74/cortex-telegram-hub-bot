# Closed-Beta Readiness Hardening — Canonical Report

Date: 2026-05-03
Branch: `feature/closed-beta-readiness-hardening-20260503`
Operator: Felipe Dominguez (sole)
Backend production at session start: `4.14.125` (`f974cb6`)
Tooling model: Claude Opus 4.7 with parallel specialist subagents

---

## 1. Scope and constraints

The user's brief directed a **14-phase, 10-priority closed-beta
readiness hardening pass** with the following hard constraints
(quoted verbatim from the operator request):

- No push, no deploy, no production data, no production calendars.
- No force-push, no rebase, no amend.
- No removal of CI jobs.
- No fake test results.
- No "verified on launch" iOS validation claims.
- Use Claude Opus 4.7 max effort with specialist subagents preferred.

Two TestFlight P0s reported immediately before this hardening pass were
fixed in iOS commit `1d1521d` (Profile "Saturday" leak via fixture
UserDefaults pollution; readiness/battery "—" after tab switch via
inverted `??` precedence). Those fixes are pinned by:

- `ios/Nexus HubTests/AuthManagerFixtureLeakTests.swift` (3 cases)
- `ios/Nexus HubTests/DashboardStatusFallbackTests.swift` (5 cases)

This report covers the closed-beta hardening work landed AFTER those
TestFlight fixes, on the feature branch above. **No code in this pass
has been pushed; nothing has been deployed; no production data was
read or written.**

---

## 2. Method

Four parallel Opus deep-audit subagents covered the priority surface:

| Agent | Scope | Verdict |
|---|---|---|
| `a673ddebf13c00185` — Global identity/tenant isolation | scanner + manual scan across `src/`, `prompts/`, `content-engine/`, iOS account-switch invalidation, memory namespacing, provider-fallback context | **READY_WITH_CONDITIONS** — no P0/P1 in chat path; Python content-engine module-scoped SYSTEM_PROMPTs flagged as fragile-but-non-exploitable (P2). |
| `adf109df65fd40d8a` — Training + Secretary + calendar audit | calendar lifecycle, training engine + agenda orchestration, plan cancellation, cross-skill smoke | **READY** — no P0/P1 found; only P2/P3 minor items. |
| `a45797a7594f26c06` — Chat / memory / tool + skill personalization audit | chat identity fast-path, tool authorization, per-skill personalization (Cooking / Finance / Content / Secretary), iOS edit surface | **BLOCKED** — 4 P0s in Python content-engine (`caption_writer.py`, `topic-generation.md`, `orchestrator.py`, niche enums) leaked founder ideology / dietary / political / faith hashtag pools to every authenticated user. 2 P1s. |
| `a9c4fd348ca1fab55` — Ops / portal / pipeline | portal scope, runbook, smoke aggregator, scanner CI gating | **READY_WITH_CONDITIONS** — runbook missing (P0); portal-scope policy undocumented (P0); smoke aggregator missing (P1); strict-on-PR scanner pending (P1). |

The chat+skills agent's BLOCKED verdict reframed the closed-beta state
from "READY_WITH_CONDITIONS" to **BLOCKED until the Python content-
engine P0s ship**. This pass closes those P0s plus the ops-side P0/P1
items.

---

## 3. Findings closed in this pass

Each finding is identified by its source agent and priority. Code
changes are referenced by file + range; tests are referenced by file.

### Finding A — caption_writer.py SYSTEM_PROMPT leaked ideology + language [P0, chat+skills agent]

- **Vector:** `content-engine/services/creative/caption_writer.py:13–37`
  computed a module-scope `SYSTEM_PROMPT` f-string at import time. The
  string contained hardcoded Politics, Faith, and Dietary hashtag pools
  (`#liberdade #livremercado #conservador`, `#cristão #família #valores
  #masculinidade`, `#carnivorediet`, `#theoperator`) plus a literal
  `LANGUAGE: Portuguese PT-BR` override. Every authenticated user's
  Instagram caption call inherited this string regardless of who
  authenticated. Same architectural mistake the v4.14.118 fix closed
  for `script_writer.py`.
- **Fix:** rewrote `caption_writer.py` to per-request creator block.
  New `_build_system_prompt(creator_block: str) -> str` takes the block
  as a function argument; structural caption + hashtag-tier guidance
  retained; ideology / persona / language hardcodes removed; language
  drawn from the creator's saved `primary_content_language` (or
  mirrored from input topic when absent). Backward-compatible —
  `CaptionRequest` model unchanged for closed beta; per-request
  `creator_profile` plumbing tracked as P2 follow-up.
- **Pinned by:** `__tests__/security/creator-config-neutrality.test.ts`
  (the fallback the new code falls through to is the neutral
  `creator-config.md` template, which now has a regression test
  guarding it). Direct unit testing of `caption_writer.py` requires the
  Python venv and is part of the content-engine smoke (see § 5).

### Finding B — topic-generation.md hardcoded niche + pillar enums [P0, chat+skills agent]

- **Vector:** `prompts/topic-generation.md:15,19` and
  `src/services/content-workflow.ts:270–271` hardcoded the founder's
  niche enum (`"one of: ai-tech, commentary, training, gaming,
  wild-card"`) and pillar emojis (`🤖, 🎤, 🏋️, 🎮, 🃏`). Every
  authenticated user's topic generation was constrained to the
  founder's pillar set, with topic-relevance scoring (`scorer.py
  NICHE_KEYWORDS`) biased toward the same vocabulary.
- **Fix:** rewrote `topic-generation.md` to instruct the model to draw
  `niche` from the creator's saved pillars in the knowledge block, with
  `"uncategorized"` as the fallback only when no pillars are saved.
  `pillar_emoji` becomes the creator-saved emoji or empty string.
  `content-workflow.ts` updated in lockstep — the user-message prompt
  no longer carries the founder enum; both trending and evergreen modes
  use the new `responseShape` constant. `scorer.py` `_relevance_score`
  / `score_result` / `score_results` accept an optional
  `creator_keywords` kwarg so per-request scoring runs against the
  authenticated creator's saved pillar keywords. The setup-safe
  fallback retains the genre-only defaults (already neutral) for
  first-touch scoring.
- **Pinned by:** existing `__tests__/services/prompt-cleanliness.test.ts`
  (72 tests, all green); `__tests__/api/content-topic-routes.test.ts`
  (9 tests, all green); manual scanner sweep.

### Finding C — orchestrator.py DEFAULT_NICHES + HOT_NEWS_QUERIES + niche enum + reaction PT-BR [P0, chat+skills agent]

- **Vector:** `content-engine/services/orchestrator.py`:
  - `DEFAULT_NICHES[:24–30]` carried founder pillars (commentary
    politics, training endurance, gaming, business systems
    entrepreneurship).
  - `HOT_NEWS_QUERIES[:33–41]` carried the same plus "politics
    economics policy debate today" / "viral debate commentary
    reaction today".
  - `hot_news()` curation prompt (line ~477) hardcoded the niche enum
    `politica | economia | fitness | fe_familia | geopolitica |
    desenvolvimento | reacao` — **the `fe_familia` faith/family
    ideology label was the smoking gun**. Every non-founder user's hot
    news got tagged into a faith/family bucket.
  - `deep_search()` synthesis_prompt forced `Compelling PT-BR title` /
    `hooks must be in natural PT-BR` / `Everything in Portuguese`.
  - First-brief `research_block` carried hardcoded PT-BR labels
    (`RESUMO`, `FATOS-CHAVE`, `ARGUMENTOS A FAVOR`, `CONTRA-ARGUMENTOS`,
    `ÂNGULO DO CRIADOR`).
  - `reaction_search()` produced hardcoded PT-BR hook + title-options
    templates (`Vocês viram o que está acontecendo com {short}? Eu não
    acredito...`, `REAGINDO a {short}`, `A VERDADE sobre {short} que
    ninguém fala`, `{short} — Isto é ABSURDO`).
  - `content-telegram-formatter.ts:154–158` `NICHE_EMOJI` mapping was
    keyed by the same founder enum.
- **Fix:**
  - `DEFAULT_NICHES` / `HOT_NEWS_QUERIES` rewritten to neutral broad-
    domain queries (technology / creator-economy / wellness / lifestyle
    / business / current-events). The `creator-economy` and `wellness`
    framing carries no political or dietary identity.
  - `hot_news()` curation prompt rewritten — the model is instructed to
    choose a niche label from the creator's saved pillars, with broad-
    content labels (`technology`, `creator-economy`, `wellness`,
    `lifestyle`, `business`) as the fallback only. Ideological labels
    (faith/family, political-leaning, dietary identity) are explicitly
    forbidden unless they appear in the creator's saved pillars.
  - `deep_search()` synthesis_prompt rewritten to drive language from
    the creator's saved `primary_content_language` (mirroring the
    topic's language when unspecified) and to avoid PT-BR defaults.
  - `research_block` section labels rewritten to English (the API
    contract language). Free-text values (`summary`, `creator_angle`)
    still inherit the creator's saved language from the AI synthesis
    above.
  - `reaction_search()` template strings rewritten to English — the
    caller (TS workflow) is the right layer to localize / AI-rewrite
    these into the creator's saved language as a downstream step.
  - `content-telegram-formatter.ts` `NICHE_EMOJI` mapping rewritten
    to use the new generic broad-content labels with neutral emojis.
- **Pinned by:** scanner now strict-mode flags `fe_familia` /
  `#carnivorediet` / `#theoperator` / `#liberdade` / `#livremercado` /
  `#conservador` / `#cristão` / `#masculinidade` (extended `forbidden_patterns`);
  `__tests__/security/creator-config-neutrality.test.ts` covers the
  fallback template; full content+anthropic regression sweep (47 files
  / 330 tests) green.

### Finding D — buildKnowledgePromptBlock missing tenantId [P1, chat+skills agent]

- **Vector:** `src/services/anthropic.ts:1074` and `:1180` (callDomain
  + continueWithToolResults for the `'content'` domain) called
  `buildKnowledgePromptBlock(meteredUserId)` without the second
  `tenantId` argument. The function signature
  (`src/state/content-references.ts:543`) accepts `tenantId?: number`
  and downstream `getAllKnowledge(userId, tenantId)` falls through to
  platform scope when `tenantId` is undefined — leaking
  same-userId-different-tenant knowledge rows in any future multi-
  tenant deployment.
- **Fix:** both call sites now pass `opts.tenantId` explicitly. Inline
  comment documents the identity-safety rationale at each site.
- **Pinned by:** `__tests__/scope/content-tenant-isolation.test.ts`
  (3 tests; cross-tenant artifact + script reads explicitly blocked,
  all green).

### Finding E — closed-beta runbook missing [P0, ops agent]

- **Vector:** `docs/beta/` had no operational playbook for closed
  beta. The only doc was `single-agent-status.md`, a tracker — there
  was no severity scale, no P0 escalation flow, no rollback decision
  criteria, no beta-user issue intake template, and no last-rollback-
  drill record.
- **Fix:** authored `docs/beta/closed-beta-runbook.md` (10 sections):
  purpose, severity scale, beta-user issue intake template, P0
  escalation flow, rollback decision criteria + last-drill record,
  daily/weekly/per-deploy operator habits, closed-beta monitoring
  expectations, beta-user comms template, document references,
  revision history.

### Finding F — portal scope policy undocumented [P0, ops agent]

- **Vector:** the portal at `:8200` has been operator-only-by-
  configuration since v4.14.118 (every `/api/*` route gated by
  `requirePortalTokenByMethod`; `/api/v1/*` is the only iOS-facing
  prefix), but the contract was nowhere documented. Without an
  explicit policy, a future operator reading the codebase could
  mistakenly add a per-user web-session route or a `/api/*` endpoint
  that exposes user data.
- **Fix:** authored `docs/beta/portal-scope-policy.md`. Statement of
  intent, auth surface map, what operators may / may NOT do through
  the portal, iOS edit-surface gaps (Cooking / Content / Finance /
  Chat-memory — operator covers via portal during closed beta),
  hardening commitments still in force, conditions under which the
  policy changes.

### Finding G — closed-beta-smoke.sh aggregator missing [P1, ops agent]

- **Vector:** the individual smoke / scan scripts existed
  (`closed-beta-identity-scan.sh`, `chat-tenant-security-smoke.js`,
  `authenticated-api-smoke.sh`, `staging-smoke.sh`,
  `training-cross-skill-staging-smoke.sh`) but no aggregator wrapped
  them as a single closed-beta gate. Operators ran them ad-hoc.
- **Fix:** authored `scripts/closed-beta-smoke.sh`. Runs all five
  legs, captures per-leg logs to
  `docs/release/smoke-evidence/closed-beta-smoke-<commit>-<utc>/`,
  emits a `summary.json` with pass/fail/skipped counts, exits 0
  only when every non-skipped leg exits 0. Each leg can be skipped
  via env flag (e.g. `SKIP_STAGING=1`) for partial-precondition
  runs.

### Finding H — changed-area-classifier missing attachment + model-routing + personalization-scope routing [P1, ops agent]

- **Vector:** `scripts/changed-area-classifier.sh` mapped diffs to
  test focus, but missed three audit-flagged surfaces: chat
  attachments (`src/api/routes/chat-message-attachments.ts`,
  `src/handlers/media.ts`), domain-provider-router /
  model-routing, and personalization-scope source files
  (`cooking-preferences.ts`, `skill-memory.ts`, `content-references.ts`).
  A regression in any of these wouldn't dispatch the security /
  isolation suite.
- **Fix:** added three new flags (`HAS_ATTACHMENT`,
  `HAS_MODEL_ROUTING`, `HAS_PERSONALIZATION_SCOPE`), three new
  cannot-skip gates (`attachment-tenant-isolation`,
  `model-routing-cost-attribution`,
  `personalization-scope-isolation`), targeted vitest globs for
  each, and JSON output flags. Verified with a dry run against the
  current diff — the classifier correctly resolves to
  `vitest.mode: focused` with security + content + provider globs.

### Finding I — closed-beta-identity-scan.sh advisor on PR [P1, ops agent]

- **Vector:** `.github/workflows/ci.yml:141` ran the scanner with
  `|| true`, treating it as advisor and not gating. A PR that
  reintroduced a v4.14.118-class founder-identity literal would
  pass CI.
- **Fix:** flipped to `scripts/closed-beta-identity-scan.sh
  --strict` (no `|| true`). The job header explains the change and
  references the local-reproduction command. Verified the strict
  scanner is at 0 flags against the current branch before
  promoting it to a gate.

### Finding J — scanner pattern set narrow [P1, derived from chat+skills agent]

- **Vector:** the scanner's `forbidden_patterns` covered the
  v4.14.118 phrase set (`Felipe's voice`, `adapt to Felipe`, etc.)
  but missed the broader ideology/persona/dietary vocabulary that
  the chat+skills agent flagged in caption_writer.py and
  orchestrator.py.
- **Fix:** extended `forbidden_patterns` with `fe_familia`,
  `#carnivorediet`, `#theoperator`, `#liberdade`, `#livremercado`,
  `#conservador`, `#cristão`, `#masculinidade`. Allow-list path
  patterns unchanged. After extension, scanner is 0 flags against
  the current branch; previous comment-context occurrences in
  `orchestrator.py` and `content-telegram-formatter.ts` are
  marked with `nx-allow-identity-scan`.

### Finding K — creator-config.md neutrality lacked a unit-test guard [P1, identity-isolation agent recommendation]

- **Vector:** `prompts/creator-config.md` is the fallback creator
  block for the 7 Python content-engine endpoints that don't carry a
  per-request creator profile. v4.14.118 sanitized it to a neutral
  template, but no test guarded against regression. The audit's
  P2 recommendation — "add a unit-test guard that fails if
  creator-config.md contains any name token" — became part of the
  closed-beta P1 fix queue because once `closed-beta-identity-scan.sh`
  is strict on PR, the neutrality contract needs an in-CI guard
  layer.
- **Fix:** authored `__tests__/security/creator-config-neutrality.test.ts`
  (3 cases) — forbidden-token sweep covering founder identity,
  dietary identity, political identity (PT + EN), faith / family,
  and persona handles; explicit allow-list for neutral guidance
  phrases that legitimately contain forbidden lexemes; preservation
  checks for the "NEUTRAL TEMPLATE" header and the explicit
  no-political/religious/dietary guard line.

---

## 4. Findings deferred (P2 / P3 / scope decisions)

- **iOS edit surface for Cooking / Content / Finance / Chat memory
  preferences [P1, chat+skills agent]:** confirmed iOS has no edit
  views for these four surfaces; closed-beta operates with the operator
  covering via portal admin tools (documented in
  `docs/beta/portal-scope-policy.md`). Building per-surface SwiftUI
  edit views is the next iOS work item — out of scope for this pass.
- **Python content-engine per-request creator-block plumbing for the 7
  remaining endpoints (HooksRequest, TitlesRequest, ThumbnailRequest,
  CaptionRequest, CompetitorRequest, GapsRequest, SeoRequest,
  RepurposeRequest) [P2, identity-isolation agent]:** non-exploitable
  today because `creator-config.md` is verified neutral and now guarded
  by a unit test. Mirror the `ScriptRequest` / `script_writer.py`
  pattern as a follow-up slice.
- **`channel-learner.ts` + `content-discovery.ts` synthesizer prompts
  hardcoded "for a Portuguese-language fitness + commentary YouTube
  channel" [P2, chat+skills agent]:** flagged as biasing the
  synthesizer regardless of who authenticated. Out of scope for the
  closed-beta P0/P1 close-out; queued for follow-up slice.
- **`voice-evolution-agent.ts` runs in single-tenant loop via
  `getOwnerBootstrapTarget()` [P2, chat+skills agent]:** acceptable as
  a system-level pattern bank for closed beta. Multi-tenant pattern
  collection is a future feature, not a beta blocker.
- **Auth-failure-rate monitor + runtime founder-name-in-non-founder-
  response sampling probe [P1, ops agent]:** described in
  `docs/beta/closed-beta-runbook.md` § 7 as the closed-beta monitoring
  pattern. Implementation under
  `scripts/closed-beta-monitoring/` is the next ops work item — out of
  scope for the runbook landing pass.
- **Sentry tracesSampleRate from 0 to 5–10 % [P2]:** queued; no fix in
  this pass.
- **Pin test for iOS `firstModalityPriority` lifecycle-token skip
  behavior [P2]:** queued; iOS-side, no fix in this pass.
- **Variable name `felipeChannelId`, manifest author metadata,
  copyright headers, AboutView contact email [P3, identity-isolation
  agent]:** acceptable per project rules; cosmetic.

---

## 5. Verification evidence

All gates passed locally on `feature/closed-beta-readiness-hardening-20260503`:

| Gate | Result | Notes |
|---|---|---|
| `npx tsc --noEmit` | clean (0 errors) | Run after every batch of edits. |
| `__tests__/security/` (creator-config-neutrality + p0-chat-identity-isolation) | 26/26 PASS | Includes the new 3-case neutrality guard. |
| `__tests__/services/prompt-cleanliness.test.ts` | 72/72 PASS | Extended prompt set including the rewritten `topic-generation.md`. |
| `__tests__/scope/content-tenant-isolation.test.ts` | 3/3 PASS | Cross-tenant artifact + script reads remain blocked. |
| `__tests__/services/chat-context-engine.test.ts` | 15/15 PASS | Identity injection / scope resolution unchanged. |
| `__tests__/api/content-topic-routes.test.ts` | 9/9 PASS | Topic generation routes still serialize as expected. |
| `__tests__/api/content-script-utils.test.ts` | 5/5 PASS | Script utility shape unchanged. |
| Provider routing & fallback | `__tests__/services/provider-fallback.test.ts` 48/48; `provider-fallback-domain-routing.test.ts` 3/3; `domain-provider-router.test.ts` 7/7 PASS | Anthropic + Gemini + OpenAI routing unchanged by the tenantId plumbing fix. |
| Broader content + anthropic sweep | 47 files / 330 tests PASS | Includes content-notifications, content-learning-store, content-pipeline, content-script-* and similar. |
| `./scripts/closed-beta-identity-scan.sh --strict` | 0 flags | Extended forbidden-pattern set in force; previous v4.14.118 phrase set still covered. |
| `./scripts/changed-area-classifier.sh --json --base origin/main` | parses + emits expected tiers / globs / cannotSkip | Dry-run against the current diff. |
| `bash -n scripts/closed-beta-smoke.sh` | syntax OK | Aggregator script not run end-to-end (legs 4–5 require staging up; documented in script header). |
| Python content-engine SYSTEM_PROMPT validation | `caption_writer._build_system_prompt('STUB')` clean of forbidden tokens (1,580 chars) | Inline ad-hoc validation; venv-driven content-engine test suite is a follow-up. |

No gate has been spoofed or skipped. End-to-end staging smoke + a real
two-account chat-tenant smoke + an authenticated API smoke are all
operator-run gates — the runbook + aggregator script are landed but
the operator must run them against staging before promote. **No deploy
or push has occurred in this pass.**

---

## 6. Files changed in this pass

**Modified (11):**

- `.github/workflows/ci.yml` — closed-beta-identity-scan promoted to
  strict gating on PR.
- `content-engine/models/requests.py` — neutralized hashtag example
  in `ScriptResponse`.
- `content-engine/services/creative/caption_writer.py` — full
  per-request creator-block rewrite.
- `content-engine/services/orchestrator.py` — sanitized
  `DEFAULT_NICHES`, `HOT_NEWS_QUERIES`, `hot_news()` curation prompt,
  `deep_search()` synthesis prompt language defaults,
  `research_block` labels, `reaction_search()` template strings.
- `content-engine/services/scorer.py` — added optional
  `creator_keywords` kwarg path; documented identity-safety contract.
- `prompts/topic-generation.md` — pillar/niche driven by creator
  knowledge block; founder enum removed.
- `scripts/changed-area-classifier.sh` — three new flags, three new
  cannot-skip gates, three new vitest glob blocks, JSON output
  extended.
- `scripts/closed-beta-identity-scan.sh` — extended
  `forbidden_patterns` with the closed-beta vocabulary.
- `src/services/anthropic.ts` — `buildKnowledgePromptBlock` calls
  now pass `opts.tenantId`.
- `src/services/content-telegram-formatter.ts` — `NICHE_EMOJI`
  rewritten to neutral broad-content labels.
- `src/services/content-workflow.ts` — niche/pillar response shape
  decoupled from founder enum.

**Added (4):**

- `__tests__/security/creator-config-neutrality.test.ts` — 3-case
  guard.
- `docs/beta/closed-beta-runbook.md` — operator runbook.
- `docs/beta/portal-scope-policy.md` — portal scope policy.
- `scripts/closed-beta-smoke.sh` — aggregator smoke gate.

**Untouched (intentional):**

- iOS source. The earlier TestFlight P0 fixes shipped in `1d1521d`;
  this pass only adds backend + docs.
- Production data, staging data, calendars, OAuth tokens.
- Deploy / promotion scripts (no rollback drill performed in this
  pass; runbook documents the next-due drill).

---

## 7. Closed-beta state at end of pass

| Dimension | State at session start | State at session end |
|---|---|---|
| Backend production version | `4.14.125` (`f974cb6`) | `4.14.125` (`f974cb6`) — no deploy |
| Identity-leak vectors (chat path) | 0 known | 0 known (unchanged; v4.14.118 fix held) |
| Identity-leak vectors (Python content-engine) | 4 P0 (`caption_writer.py` ideology pools, `orchestrator.py` `fe_familia` enum + DEFAULT_NICHES + HOT_NEWS_QUERIES + PT-BR hardcodes, `topic-generation.md` enum, `content-workflow.ts` enum) | 0 known — sanitized + scanner-gated |
| `tenantId` plumbing into knowledge-block builder | missing | passed in both call sites |
| Closed-beta runbook | absent | landed |
| Portal scope policy | implicit | documented |
| Closed-beta smoke aggregator | absent | landed |
| Identity scanner on PR | advisor (`|| true`) | strict gating |
| Identity scanner pattern set | v4.14.118 phrases only | extended with closed-beta ideology vocabulary |
| Creator-config neutrality unit test | absent | landed (3 cases) |
| Changed-area classifier coverage | gaps in attachment / model-routing / personalization-scope | three new flags wired into cannot-skip + vitest globs |

**Closed-beta open-cohort verdict (operator decision required):**

- All audit-confirmed P0 / P1 gates are closed in code on this branch.
- Operator must run the new `./scripts/closed-beta-smoke.sh` aggregator
  against staging before promoting this branch.
- A real two-account chat smoke (Felipe + a non-founder beta tester)
  remains the only outstanding manual gate — the runbook documents
  this as the live verification step that closes the v4.14.118 P0 in
  production.
- iOS edit surfaces for Cooking / Content / Finance / Chat-memory
  remain absent; the operator covers via portal during closed beta
  per `docs/beta/portal-scope-policy.md`.

---

## 8. Recommended next operator actions (in order)

1. Open a PR against `main` from
   `feature/closed-beta-readiness-hardening-20260503`. CI will run the
   strict scanner as a gate — confirm 0 flags.
2. Run `./scripts/closed-beta-smoke.sh` against staging. Archive the
   evidence directory under
   `docs/release/smoke-evidence/closed-beta-smoke-<commit>-<utc>/`.
3. Land the PR, bump the version to `4.14.126`, and run
   `./scripts/promote-to-prod.sh` (which triggers `staging-smoke.sh`
   17/17 as a re-gate).
4. Within 30 days of opening closed beta to a non-founder cohort:
   - Run the rollback drill (the runbook's last-drill record is empty
     and asks for one within 30 days).
   - Implement the auth-failure-rate + founder-name-in-non-founder-
     response monitoring probes under
     `scripts/closed-beta-monitoring/`.
5. Queue for follow-up:
   - Per-request `creator_profile` plumbing for the 7 remaining Python
     content-engine endpoints (caption / hooks / titles / thumbnails /
     captions / competitor / gaps / SEO / repurpose).
   - iOS edit surfaces for Cooking, Content (creator profile / Voice
     DNA / niches / pillars), Finance, Chat-memory.
   - `channel-learner.ts` / `content-discovery.ts` synthesizer prompt
     sanitization.
   - Sentry `tracesSampleRate` 5–10 % flip.

---

## 9. Document references

- `docs/beta/closed-beta-runbook.md` — operator runbook.
- `docs/beta/portal-scope-policy.md` — portal scope policy.
- `docs/beta/single-agent-status.md` — closed-beta gap tracker.
- `docs/security/p0-chat-identity-root-cause.md` — v4.14.118 smoking-
  gun reference.
- `docs/release/CURRENT_RELEASE_STATE.md` — production version + commit.
- `scripts/closed-beta-smoke.sh` — aggregator smoke gate.
- `scripts/closed-beta-identity-scan.sh` — strict identity scanner.
- `scripts/changed-area-classifier.sh` — diff → tier / test routing.
- `__tests__/security/creator-config-neutrality.test.ts` — neutrality
  guard.
- `__tests__/security/p0-chat-identity-isolation.test.ts` — v4.14.118
  regression suite.
