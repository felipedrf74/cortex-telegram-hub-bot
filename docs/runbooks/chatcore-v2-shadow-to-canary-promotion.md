# ChatCoreV2 Shadow → Canary Promotion Runbook (Phase 2 → 3 / G2-shadow → G3-canary)

**Date:** 2026-05-29
**Repo:** `cortex-telegram-hub-bot` (`@nexushub/core`)
**Status of the gate as of this runbook:** **CANNOT PASS YET.** `evaluateChatCoreV2ShadowGateReadiness().gateMet` is the structural literal `false` (`src/services/chat-core-v2/shadow-gate-readiness.ts:60`, `:98`), `recallAt8` is the literal `'requires_labeled_corpus'` (`:55`, `:97`), the peer-reviewed real corpus does not exist (only the 263-item synthetic seed at recall@8 = 0.5627), and `< 50` real shadow rows have been accumulated. See **Section 9 — Why This Gate Cannot Pass Today**.
**Companion docs:** `docs/ai/chatcore-v2-orchestrator-runtime-build-plan.md` (§6 gate ladder; WP-00.5/01/02/03/04/05/06/07/09/10/11/13/14/19/19-seed), `docs/ai/chatcore-v2-golden-corpus-spec.md`, `docs/qa/peer-reviews/WO-chatcore-v2-production-activation-peer-review.md` (GATE 0b), `docs/qa/work-orders/WO-chatcore-v2-production-activation.md`, `DEPLOY.md`, `STAGING.md`.

---

## 1. Purpose, Scope, and Standing Invariants

### 1.1 Purpose

This runbook is the single, machine-checkable procedure for promoting Chat Core v2 from **Phase 2 Shadow** to **Phase 3 Canary**. It exists to make the **G2-shadow exit gate** (build plan §6) and the **G3-canary entry gate** auditable: every promotion is gated on runtime evidence produced by named functions/commands, captured in a copy-per-promotion **privacy-safe** evidence bundle, and signed off before any flag is flipped.

Promotion is never granted on helper-completeness. It is granted only when the listed criteria are **measured `true` by the cited code**, the evidence is privacy-safe (HMAC/aggregate/enum only), and Felipe has authorized.

### 1.2 Scope

**In scope:** the G2-shadow → G3-canary transition only. The flag-flip sequence (the full env tuple — see Section 6 Step 2 — not a single flag), its staging-validated promotion (mirroring `scripts/promote-to-prod.sh` house style), the new ChatCoreV2 + kill-switch smoke additions, the privacy-safe evidence bundle, the go/no-go record, and rollback.

**Out of scope:** Phase 3 → 4 write-enable (G4-write), Phase 4 → 5 full-on (G5-full), and Phase 6/8 retire (G6/8). Those have their own gates in build plan §6. Canary in scope is **answer-only / read** canary; write execution stays default-off (`CHAT_CORE_V2_ALLOW_WRITE_EXECUTION` defaults `false`, `activation-flags.ts:52`).

### 1.3 Standing Invariants (must hold through every step; a violation is an automatic NO-GO)

1. **Default-off.** When `CHAT_CORE_V2_ORCHESTRATOR_MODE` is absent or `off`, the activation config force-collapses every flag (`resolveChatCoreV2ActivationConfig()`, `activation-flags.ts:63-77`). Promotion to canary is an **explicit env change**, never a code default flip.
2. **Kill-switch wins — and the chokepoint consolidation is DONE (WP-00.5); the remaining GATE-P1 piece is the WP-07 override-flip proof.** As built, `off` wins on the live path because **both** parsers now route their kill-switch decision through the shared `isChatCoreV2MasterKillSwitchOff(env)` helper (`activation-flags.ts:90`): `resolveChatCoreV2LocalChatLlmMode` (`local-chat-orchestrator.ts:118`, call at `:121`) and `resolveChatCoreV2ActionGatewayMode` (`action-gateway.ts:103`, call at `:108`) each begin with `if (isChatCoreV2MasterKillSwitchOff(env)) return 'off';`. That helper fires only on an **explicit** `CHAT_CORE_V2_ORCHESTRATOR_MODE=off` (trim/lowercase); an **absent** mode does NOT kill — it defers to the sub-mode flags (`CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE` / `CHAT_CORE_V2_ACTION_GATEWAY_MODE` / the legacy `CHAT_CORE_V2_ENABLED` activation), which is behavior-preserving. No inline `CHAT_CORE_V2_ORCHESTRATOR_MODE` kill compare remains in either parser (grep returns zero). The single-chokepoint **consolidation is complete**; the activation-config collapse (`activation-flags.ts:63-77`) is a separate code path (interpretation "A" — strict default-off subordination — is deferred). The remaining GATE-P1 piece is the **WP-07 runtime-override integration proof**: WP-07 must EXTEND `isChatCoreV2MasterKillSwitchOff` (or move both parsers to a Map-aware resolver) so a per-tenant override flip is proven to stop the live path without a restart (precondition GATE-P1, Section 2). Do **not** require a single `resolveChatCoreV2ActivationConfig(env).mode` chokepoint — the live parsers route through the helper, not the resolver.
3. **Token-zero reads preserved.** Pure lookups are served by `tryBuildChatCoreV2DeterministicReadRoute()` / REST routes, never the chat LLM. Canary must not move any read off the token-zero path.
4. **No raw text in evidence / no raw text to cloud.** Shadow rows carry only a 64-hex HMAC `messageHash` and never a raw `message`/`messagePreview` (write-time redaction + the structural `hasSafeHashedShape`, `shadow-gate-readiness.ts:135-142`). **All evidence in this runbook is HMAC/aggregate/enum only** — never a raw message, paraphrase, `messagePreview`, provider `errorMessage` string, or decrypted token. `allowCloudFallback` stays `false`. This invariant is enforced field-by-field in the Section 4 bundle and in C3/C4/C5/C7.
5. **Tenant + user id at every boundary.** Every metric, override, and revert record carries `tenantId` **and** `userId`. With Felipe + Jaqueline both live, single-tenant framing is invalid: the auto-revert override Map (WP-07), the `allowedDomains` gate (WP-16), and the legacy-fallback flag (WP-20) are per-tenant keyed (build plan §5.J). **Raw `tenantId:userId` is acceptable only inside the uncommitted server-side `.env`; every committed artifact (decision record, bundle) references the canary cohort by HMAC tenant-scoped token (`hmacTenantScopedEntityId`, `cloud-allowlist-packet.ts:97-105`) or a stable cohort label, never raw IDs.**
6. **DMV / no false success.** A criterion is satisfied only when a runtime-integration test exercises the **real wired path**, not a helper unit test, and the verifier is not a tautology. `gateMet`/`gateCanPromote` are never asserted from a report that cannot derive them (`shadow-gate-readiness.ts` returns `gateMet: false` by construction because recall@8 needs a separately-validated corpus). Grep checks are **smell-checks, not gates** (see GATE-P1).

---

## 2. Preconditions (close these before opening the G2-shadow exit gate)

These come from the GATE 0b peer review's "Precise list of what must change for GATE 0b to PASS" (items 1–10) and the cross-cutting D3/corpus blockers. The G2-shadow checklist (Section 3) **must not be started** until every precondition is closed and independently re-verified. Each is a hard gate.

| ID | Precondition | Source | Verified by |
|---|---|---|---|
| **GATE-P1** | Kill-switch consolidation DONE: both live parsers delegate to the shared `isChatCoreV2MasterKillSwitchOff()` helper; no inline `ORCHESTRATOR_MODE` kill compare remains in `local-chat-orchestrator.ts`/`action-gateway.ts` (grep returns zero). **Remaining requirement:** the WP-07 runtime-override flip proven to stop the live path (integration test). | WP-00.5 (consolidation, done) + WP-07 (override-flip proof); peer review item 10 | **Gate = the integration test, not the grep.** Consolidation is verified: both parsers begin with `if (isChatCoreV2MasterKillSwitchOff(env)) return 'off';` (`local-chat-orchestrator.ts:121`, `action-gateway.ts:108`). The kill-switch integration test (`__tests__/api/chat-core-v2-live-path-killswitch.integration.test.ts`) green: with mode `off`, both `runChatCoreV2ActionGateway` and `runChatCoreV2LocalChatTurn` are no-ops on the live `chat-message-routes` path. The remaining open item is the **WP-07 per-tenant override-flip** DMV test: a `setChatCoreV2RuntimeOverride(tenantA,...)` flip (once WP-07 extends `isChatCoreV2MasterKillSwitchOff`) stops tenant A's live path without restart. **Smell-check only (non-gating):** `grep -rnE "(process\.env\|env)\.CHAT_CORE_V2_ORCHESTRATOR_MODE" src/services/chat-core-v2/local-chat-orchestrator.ts src/services/chat-core-v2/action-gateway.ts` now returns **ZERO** after WP-00.5 (it previously returned two — `:119` and `:105`, both using the `env` parameter, not `process.env`; a `process.env`-only grep was always a false-negative trap and must never be the gate). |
| **GATE-P2** | **Partially met.** Layer-1 prepass IS wired into the live `route-decision.ts` path (DONE — not the barrel re-export). `ChatTurnPlanMicro` schema/repair (`enforceAndRepairChatTurnPlanMicro`) is **DEFERRED / not yet wired** (carved out to land with the Layer-2 planner path), so GATE-P2 is only partially closed. | WP-01 (prepass, done); ChatTurnPlanMicro deferred; peer review item 1 | Prepass DONE: `__tests__/services/chat-core-v2-prepass-route-decision-wiring.test.ts` green; a real `planChatCoreV2ShadowTurn` persists a `kind='custom'`, `name='prepass_candidate_selection'` span via the real `recordChatV2TraceSpan` (`shadow-orchestrator.ts:160`). In `'observe'`/shadow the prepass is observation-only (routing unchanged, `route-decision.ts:143-144`). The `ChatTurnPlanMicro` schema-validate/repair wiring is NOT delivered and has no live caller. |
| **GATE-P3** | D10 measurement implemented: composer-mode usage share computed and `composer_mode_drift` can fire; budget value reconciled (code `0.35` vs spec `0.30`) before Phase 3. | WP-04; peer review item 2 | `__tests__/services/chat-core-v2-composer-mode-counter.test.ts` — 40/100 drift fires; pino-only, no tenant leak. |
| **GATE-P4** | Evidence binding actually binds in the runtime path (`factualClaims[]` populated); cross-tenant evidence rejected by `assertEvidenceScopedToTurn` + test. | WP-05; peer review item 5 | `__tests__/services/chat-core-v2-evidence-binding.test.ts` — `unsupported_factual_claim` fires; cross-tenant item filtered. |
| **GATE-P5** | Auto-revert has **live** inputs (`legacyFallbackRate24h` per tenant; real Ollama health via `getLatestHealthByProvider`, `integration-health.ts:351`, with explicit `ok`/`fail`/`skipped`/stale mapping) and the per-tenant executor flip is proven to stop the **live** path through `chat-message-routes`. | WP-06 + WP-07; peer review items 7 + 10 | `__tests__/services/chat-core-v2-metrics-aggregator.test.ts` + `__tests__/services/chat-core-v2-auto-revert-executor.test.ts` (DMV through `chat-message-routes`). |
| **GATE-P6** | Repo-wide Layer-1 determinism sweep is green (no provider/network imports on any `prepass`/`layer1`/`candidate-selection` file). | WP-03; peer review item 9 | `__tests__/services/chat-core-v2-layer1-determinism-ci.test.ts` green; flagged LLM-importing modules moved off the Layer-1 path. |
| **GATE-P7** | D12 model residency wired to actual keep-alive (string→numeric adapter; `ollama-provider.ts` reads the policy instead of hardcoding `-1`). | WP-02; peer review item 8 | `__tests__/services/chat-core-v2-keep-alive-adapter.test.ts` — outbound body asserts `keep_alive` per role. |
| **GATE-P8** | Write-risk governance wired + operator notification on enqueue + resolution/expiry. Canary here is read-only, so the binding requirement is: class-C blocking and human-review enqueue/notify paths exist and do not fire on read-only turns. | WP-10/WP-12/WP-08; peer review item 6 | `__tests__/services/chat-core-v2-write-risk-governance-wiring.test.ts`. |
| **GATE-P9 (D3 cross-cut)** | D3 production-sized latency: either the full 100-seq / 5-concurrent / 5-min run on target hardware meets p95 ≤ 5s, **or** a serialized-only (concurrency-1) activation profile is formally ratified with `runWithLocalInferenceSlot` wired and documented as the production constraint. The CI `burst5` proxy is green but **NOT binding**. | D3; peer review item 3; build plan §8 | `scripts/bench-gate.sh` (`burst5` proxy, CI) green = C6a; binding C6b = a VPS/GPU artifact under `docs/release/` with measured p95, OR a signed serialized-profile ratification. GO gates on C6b only. |
| **GATE-P10 (corpus cross-cut)** | The B4 per-language recall gate is closeable: a **real ≥200-turn peer-reviewed corpus** exists (not the synthetic seed), the 5 operator-authored seeds are promoted, and the "mixed real-failure seed" overstatement is fixed. The persisted recall writer (WP-13 store + WP-19 + WP-19-seed) and the **per-language** evaluator exist. The corpus file lives only in the approved private evidence store, never in the git worktree. | B4; corpus spec §"Storage Rules" / §"Current Status"; peer review item 4; build plan §5.C | `validateGoldenCorpus(corpus)` returns `[]` against a **strengthened** validator (`synthetic_only` requires a minimum real-evidence count/share, not ≥1) + `evaluatePerLanguagePrepassRecallAtK(corpus,8)` exists + `gate-metrics-store.ts` + `migrations/174_chat_v2_gate_metrics.sql` present with green tests + `upsertRecallAt8`/`getLatestRecallAt8` exported + the persisted recall is bound to a corpus content-hash that is **not** the hash of `CHAT_CORE_V2_GOLDEN_CORPUS_SEED`. |

> **Honest status:** GATE-P1's **chokepoint consolidation is DONE** — both parsers now route through `isChatCoreV2MasterKillSwitchOff` (`local-chat-orchestrator.ts:121`, `action-gateway.ts:108`), and the inline `ORCHESTRATOR_MODE` compares are gone (grep returns ZERO). The remaining GATE-P1 item is the **WP-07 override-flip integration proof** (WP-07 must extend `isChatCoreV2MasterKillSwitchOff` to consult the per-tenant override Map, then prove the flip stops the live path without restart). GATE-P5, GATE-P9, and GATE-P10 are **open**. None of `setChatCoreV2RuntimeOverride`/`_runtimeOverrides`/`global_mode` (`activation-flags.ts`), `metrics-aggregator.ts`, `auto-revert-executor.ts`, `gate-metrics-store.ts`, `canary-gate-guard.ts`, `upsertRecallAt8`/`getLatestRecallAt8`, `evaluatePerLanguagePrepassRecallAtK`, `measureChatCoreV2ShadowGateReadiness`/`gateCanPromote`, `scripts/bench-gate.sh`, or migrations `172`–`177` exist in the worktree yet (highest migration is `171_classify_shadow_runs.sql`; only `auto-revert-policy.ts` exists from the auto-revert WPs). The `enforceAndRepairChatTurnPlanMicro` ChatTurnPlanMicro schema/repair helper is also still unwired (deferred to the Layer-2 planner path). The peer-reviewed real corpus does not exist; only `golden-corpus-seed.ts` (synthetic, 263 items / 112 unique, recall@8 = 0.5627) is present, and that synthetic seed currently **passes** `validateGoldenCorpus` (it carries `real_failure`/`operator_seed` items, so the `synthetic_only` check at `golden-corpus.ts:69-70` does not fire). Therefore this runbook documents the gate but **cannot be executed to a GO verdict** until those WPs land, the validator is strengthened, and the real corpus is built.

---

## 3. G2-shadow Exit Gate — Machine-Checkable Checklist

Each criterion is checked off **only** when the cited command/function returns the stated value on the staging shadow install (and, where noted, the VPS). Copy the **privacy-safe projection** of measured values into the Section 4 bundle. The `Pass?` column is filled per promotion.

> All commands run against the **staging** install (`/home/dominguez/telegram-hub-bot-staging`, port 8201) over ssh, mirroring `staging-smoke.sh`, against the real `chat_v2_replay_bundles` rows accumulated while shadow was live on staging. Recall@8 is additionally computed against the **real peer-reviewed corpus** held in the private evidence store (not the synthetic seed).

### C1 — ≥ 50 real shadow rows

- **Producer:** `evaluateChatCoreV2ShadowGateReadiness()` (`shadow-gate-readiness.ts:64`) reading real `chat_v2_replay_bundles` rows whose `replay_bundle_id LIKE 'chatv2-shadow-replay:%'` (`:70`), written by `recordChatV2ReplayBundle` during live shadow traffic.
- **Threshold:** `rowCount >= 50` ⇒ `meetsMinRows === true` (`minRows = 50`).
- **Command (run on the server, against the live staging DB):**
  ```bash
  ssh "${DEPLOY_SERVER:-dominguez@serverdominguez}" "
    cd /home/dominguez/telegram-hub-bot-staging
    node -e \"
      const {evaluateChatCoreV2ShadowGateReadiness}=require('./dist/services/chat-core-v2/shadow-gate-readiness');
      const Database=require('better-sqlite3');
      const db=new Database(process.env.DATABASE_PATH||'data/bot.db',{readonly:true});
      const r=evaluateChatCoreV2ShadowGateReadiness(db);
      // notes is aggregate-only by contract (see below); safe to print.
      console.log(JSON.stringify({rowCount:r.rowCount, meetsMinRows:r.meetsMinRows, schemaValidPct:r.schemaValidPct, meetsSchemaValidity:r.meetsSchemaValidity, safeShapeViolationCount:r.safeShapeViolationCount, meetsSafeShape:r.meetsSafeShape, recallAt8:r.recallAt8, gateMet:r.gateMet, notes:r.notes}, null, 2));
    \"
  "
  ```
- **`notes` constraint:** `buildNotes` (`shadow-gate-readiness.ts:144-164`) is aggregate-only by contract (counts/percentages/threshold verdicts). **Do not extend `buildNotes` to interpolate any per-row content (routeMethod, sample message), and do not copy `notes` into the bundle if it ever contains anything beyond counts/percentages/verdicts.**
- **Real-traffic check (machine, not prose):** `meetsMinRows === true` proves only that ≥50 rows with the `chatv2-shadow-replay:%` prefix exist — a fixture or hand-seeded row counts identically. To assert *real traffic*, additionally record in the bundle: (a) `COUNT(DISTINCT turn_id) ≥ 50`, (b) `MIN(created_at)`/`MAX(created_at)` spanning ≥ the staging soak window, and (c) the staging deploy commit + the timestamp range during which `CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE=shadow` was live, with `created_at` min/max falling inside that range. Without these, downgrade C1 to "rows present" and do not assert "real traffic" as verified.
- **Pass condition:** `meetsMinRows === true`, `rowCount` recorded, and the three real-traffic sub-checks recorded.

### C2 — Schema validity ≥ 99%

- **Producer:** same `evaluateChatCoreV2ShadowGateReadiness()` call as C1.
- **Threshold:** `schemaValidPct >= 0.99` AND `rowCount > 0` ⇒ `meetsSchemaValidity === true` (`minSchemaValidPct = 0.99`). Structural: each row must carry `response.type === 'chat_core_v2_shadow_plan'`, `response.wouldExecute === false`, a non-empty `response.routeMethod`, and a `contextPack.hashVersion` (`isValidShadowBundleSchema`, `:111-127`).
- **Pass condition:** `meetsSchemaValidity === true`; record `schemaValidPct` as a percentage.

### C3 — No raw `message`/`messagePreview`; valid HMAC `messageHash` (NOT a blanket raw-text guarantee)

- **Producer:** same call; `safeShapeViolationCount` from `hasSafeHashedShape` (`:135-142`). A clean row carries a 64-hex HMAC `contextPack.messageHash` and exposes **no** `contextPack.message`/`messagePreview`.
- **True scope (honest):** `hasSafeHashedShape` inspects **only** `contextPack.messageHash`/`message`/`messagePreview`. It does **not** scan `response.*`, `response.routeMethod`, nested context fields, or unknown top-level keys. C3 therefore proves "`message`/`messagePreview` absent + valid `messageHash` present on `contextPack`", **not** "no raw strings anywhere." Raw text smuggled under e.g. `response.note` or a new subfield would still pass with `safeShapeViolationCount = 0`. Defense-in-depth comes from the write-time redaction + no-raw-storage tests, not from C3 alone.
- **Threshold:** `safeShapeViolationCount <= 0` ⇒ `meetsSafeShape === true` (`maxSafeShapeViolations = 0`), across **all** ≥50 rows (not a sample).
- **Hardening follow-up (should-fix before Phase 3):** strengthen `hasSafeHashedShape` to recursively reject any string field outside an allowlist of known enum/hash fields that exceeds N chars or matches natural-language heuristics, and cite that stronger check here. Until then, do not lean on C3 as a blanket raw-text guarantee.
- **Pass condition:** `meetsSafeShape === true` AND `safeShapeViolationCount === 0` over the full row set, recorded with `rowsScanned`.

### C4 — Per-language recall@8 on the REAL corpus

- **Producers:** `evaluatePerLanguagePrepassRecallAtK(corpus, 8)` (WP-13/WP-19 — filters items by `language` and returns the four recalls; **this helper does not exist yet** — see Section 9) **and** `getLatestRecallAt8()` for the persisted aggregate. NOTE: the existing `evaluateGoldenCorpusPrepassRecallAtK(corpus, 8)` (`prepass-recall-eval.ts:96`) returns a flat `{recallAtK, total, scored, hits, misses}` with **no** `language` field and no language filter — it **cannot** produce the four per-language numbers. Do not list per-language targets as machine-verified until `evaluatePerLanguagePrepassRecallAtK` emits them.
- **Targets (corpus spec §"Acceptance Metrics"):** en ≥ 0.98, pt-BR ≥ 0.97, pt-PT ≥ 0.92, mixed ≥ 0.90. The single promotion authority (build plan §5.C/WP-14) is the **persisted** `recall_at_8_latest ≥ 0.90` written by WP-19-seed via `upsertRecallAt8()`.
- **Real-corpus provenance (machine, not a free-text field):**
  1. C4 MUST call `validateGoldenCorpus(corpus)` and assert `[]`. The validator must first be **strengthened**: `synthetic_only` (`golden-corpus.ts:69-70`) currently fires only when *not one* item is `real_failure`/`operator_labeled`/`operator_seed`, which the synthetic seed already passes. It must instead require a **minimum count/share** of real-evidence items AND that the 5 operator seeds are promoted.
  2. The persisted recall MUST be bound to a corpus **content hash** stored by `gate-metrics-store`, and C4 MUST assert that hash `!=` the hash of `CHAT_CORE_V2_GOLDEN_CORPUS_SEED`.
  3. `CORPUS_PEER_REVIEW_SIGNOFF_HASH` is a verifiable `sha256` of the corpus file recorded in a committed manifest, never free text.
- **Privacy projection (BLOCKING):** the C4 evidence artifact MUST be the **aggregate projection only**. `evaluateGoldenCorpusPrepassRecallAtK`/`evaluatePerLanguagePrepassRecallAtK` return `misses: PrepassRecallMiss[]` where each miss carries `message` = up to 200 chars of the corpus message, up to `MAX_RECORDED_MISSES = 50` of them (`prepass-recall-eval.ts:28-33,76-84`). **Never serialize the raw result.** Project to counts + capability-ID enums first:
  ```bash
  npx tsx -e "const {evaluatePerLanguagePrepassRecallAtK}=require('./src/services/chat-core-v2/prepass-recall-eval'); const corpus=require('<APPROVED_PRIVATE_EVIDENCE_STORE_PATH>'); const byLang=evaluatePerLanguagePrepassRecallAtK(corpus,8); const safe=Object.fromEntries(Object.entries(byLang).map(([lang,r])=>[lang,{recallAtK:r.recallAtK,total:r.total,scored:r.scored,hits:r.hits,missCount:r.misses.length,missCapabilityIds:r.misses.map(m=>({expected:m.expectedCapabilityIds,candidates:m.candidateCapabilityIds}))}])); console.log(JSON.stringify(safe,null,2))"
  ```
  The only C4 evidence is the per-language recall numbers + miss **capability IDs**. The raw `misses[].message` array is **forbidden** in the bundle; raw miss text stays in the private evidence store.
- **Corpus-location guard (corpus spec §"Storage Rules"):** the real corpus file MUST reside in the approved private evidence store, **never** in the git worktree; the bundle records only its content-hash + peer-review signoff hash, never an in-repo path. CI/pre-commit must reject committing any file matching the real-corpus shape.
- **Anti-overfitting rule (corpus spec §"Recall@8 gate runbook"):** the corpus MUST be the real peer-reviewed set (≥200 turns, all four languages, ≥1 `real_failure`); `selectPrepassCandidateCapabilities` MUST NOT be tuned to the synthetic seed.
- **Pass condition:** `validateGoldenCorpus(corpus) === []` (strengthened validator), every per-language target met on the real corpus, AND `getLatestRecallAt8()` returns a persisted aggregate ≥ 0.90 bound to a content hash ≠ the seed's. Record each language's value, the persisted value, and the content/signoff hashes.

### C5 — Auto-revert proven on LIVE input + per-tenant executor flip

- **Producer:** the live metrics aggregator (`metrics-aggregator.ts`, WP-06) + the executor (`auto-revert-executor.ts`, WP-07), exercised by `__tests__/services/chat-core-v2-auto-revert-executor.test.ts` **through `chat-message-routes`** (DMV).
- **What must be proven (build plan §6 G2-shadow, §5.A/§5.I):**
  - `computeChatCoreV2OllamaHealthy` reads `getLatestHealthByProvider()['ollama']` (`integration-health.ts:351`) with the explicit mapping: `ok`→healthy; `fail`→unhealthy; `skipped`/`'not configured'`/missing key→short-circuit healthy; stale row (older than `OLLAMA_HEALTH_STALENESS_MS`)→short-circuit healthy (never auto-flip on stale data).
  - A `setChatCoreV2RuntimeOverride(tenantA,'global_mode','shadow')` flip causes `runChatCoreV2ActionGateway` for tenant A to return mode ≠ `enforce` AND `runChatCoreV2LocalChatTurn` for tenant A to return `null` on the SAME process without restart, while tenant B still serves its mode.
- **Privacy (should-fix, enforced):** `getLatestHealthByProvider()` returns `ProbeResult` carrying `errorMessage: string | null` (`integration-health.ts:44`, truncated to 500 chars at `:90`, surfaced verbatim at `:137`/`:145`/`:152`). C5 evidence records **only** the derived health enum (`ollamaHealthy` boolean + the `ok`/`fail`/`skipped`/`stale` classification) and the aggregate `legacyFallbackRate24h`. **Do NOT paste `ProbeResult.errorMessage` or any raw health row into the bundle/log.** The DMV test must assert on the mapping, not on logging the raw row.
- **Pass condition:** the DMV integration test is green AND the live aggregator produces real per-tenant `legacyFallbackRate24h`. Record the test name + the measured live fallback rate (number only) + the mapped health enum.

### C6 — Bench p95 (D3) — split into proxy (necessary) and binding

- **C6a (necessary, NON-binding):** `scripts/bench-gate.sh` `burst5` phase (5 concurrent, p95 ≤ 5000 ms) green in CI. A green proxy is **not** a PASS for the gate.
- **C6b (BINDING — GO gates on this, not C6a):** a VPS/GPU artifact under `docs/release/` with a measured p95 ≤ 5s for the full 100-seq / 5-concurrent / 5-min run, **OR** a signed serialized-only (concurrency-1) profile ratification with `runWithLocalInferenceSlot` wired and documented as the production constraint. **C6b FAILs by default until the artifact path exists and is non-empty.**
- **Pass condition:** C6a green AND C6b satisfied (record which binding form was used + artifact path).

### C7 — Tenant-salted, mandatory HMAC in the corpus loader + no raw text emitted

- **Producer:** `loadShadowReplayCorpusItems(db, {windowDays, limit, hmacSecret})` (WP-19; **does not exist yet**). `hmacSecret` is **hard-fail required** against a real DB; tokenisation is tenant+user-salted (`${tenantId}:${userId}:${text}`, matching `prepass-miss-log.ts:38` and `hmacTenantScopedEntityId` `cloud-allowlist-packet.ts:97-105`); a global unsalted HMAC is forbidden.
- **Pass condition (three sub-assertions):**
  1. Two tenants → **different** tokens for identical text.
  2. Missing secret on a real DB → **hard fail**.
  3. **The loader's returned item shape contains no raw `text`/`message` field — only the HMAC token.** OD-4 ("drop text entirely") is the **mandatory** terminal state, not merely "preferred"; salting must replace, not augment, the raw text. Mirror the proven contracts: `prepass-miss-log.ts:24,38` stores `messageHash` only; `cloud-allowlist-packet.ts:67-103` returns `scopedEntityId` HMAC tokens only.

### C8 — Standing invariants hold (Section 1.3)

- Default-off parity test green (mode=off → bit-identical legacy output — **name the actual test file; if none exists, mark BLOCKED**); kill-switch single-chokepoint **integration test** green (GATE-P1, the test — not the grep); token-zero reads still served by `tryBuildChatCoreV2DeterministicReadRoute`; `allowCloudFallback === false`.
- **Pass condition:** all four invariant checks pass; reference GATE-P1 by ID (do not re-run the grep here — it inherits the false-negative trap). Record the default-off parity test name or BLOCKED.

---

## 4. Evidence Bundle Template (copy per promotion)

Copy this fenced block verbatim into the promotion record, fill each field, and obtain reviewer sign-off. **Privacy rule (enforced field-by-field):** only HMAC tokens, aggregate counts, percentages, capability-ID enums, health enums, and boolean verdicts may appear — never a raw message, paraphrase, `messagePreview`, provider `errorMessage`, decrypted token, or raw `tenantId:userId`. **Producers that do not exist yet default to the literal `BLOCKED — producer not implemented (WP-xx)`; the reviewer must confirm the producer file exists (path + git sha) before any boolean may be entered.**

```
=========================================================================
ChatCoreV2  G2-shadow → G3-canary  PROMOTION EVIDENCE BUNDLE
=========================================================================
runbook_date:        2026-05-29
promotion_attempt:   <YYYY-MM-DD-HHMMZ>
staging_dist_sha:    <git rev-parse --short HEAD on staging>
staging_version:     v<package.json version on staging>
local_version:       v<package.json version local>
node/sqlite:         <node -v> / <better-sqlite3 version>
operator:            <name>
reviewer:            <name>
authorizer:          Felipe (required — see Section 6)
-------------------------------------------------------------------------
PRECONDITIONS (Section 2)  [all must be CLOSED before the gate opens]
  GATE-P1  killswitch one-chokepoint   PASS|FAIL  integ_test=<name green?>  grep_smell=<count, non-gating>
  GATE-P2  prepass+plan wired           PASS|FAIL  test=<name>
  GATE-P3  D10 measurement+drift        PASS|FAIL  test=<name>
  GATE-P4  evidence binding+tenant      PASS|FAIL  test=<name>
  GATE-P5  auto-revert live inputs      PASS|FAIL  test=<name>
  GATE-P6  determinism sweep            PASS|FAIL  test=<name>
  GATE-P7  keep-alive wired             PASS|FAIL  test=<name>
  GATE-P8  write-risk governance        PASS|FAIL  test=<name>
  GATE-P9  D3 latency (binding form)    PASS|FAIL  form=<vps_run|serialized_profile>  artifact=<docs/release/ path>
  GATE-P10 real corpus + persist writer PASS|FAIL  validator_strengthened=<bool>  per_lang_eval_exists=<bool>
                                                   corpus_content_hash=<sha256, != seed>  store_present=<bool>
-------------------------------------------------------------------------
G2-SHADOW EXIT CRITERIA (Section 3)
  C1  shadow rows >= 50 (REAL traffic)
      MEASURED: rowCount=<n>  meetsMinRows=<bool>  distinct_turn_id=<n>
                created_at_min=<ts>  created_at_max=<ts>  shadow_on_window=<ts..ts>
                staging_deploy_commit=<sha>
      COMMAND:  evaluateChatCoreV2ShadowGateReadiness(db)  (Section 3 C1)
      ARTIFACT: <path/to/readiness-output.json>   (notes field is aggregate-only by contract)
      PASS:     <PASS|FAIL>

  C2  schema validity >= 99%
      MEASURED: schemaValidPct=<pct>  meetsSchemaValidity=<bool>
      ARTIFACT: <same readiness-output.json>
      PASS:     <PASS|FAIL>

  C3  no raw message/messagePreview; valid HMAC messageHash (NOT blanket raw-text)
      MEASURED: safeShapeViolationCount=<n>  meetsSafeShape=<bool>  rowsScanned=<n>
      SCOPE:    proves contextPack.message/messagePreview absent + 64-hex messageHash present ONLY
      ARTIFACT: <same readiness-output.json>
      PASS:     <PASS|FAIL>

  C4  per-language recall@8 on REAL corpus  [aggregate projection ONLY]
      MEASURED: en=<v>  pt-BR=<v>  pt-PT=<v>  mixed=<v>  persisted_aggregate=<v>
                miss_capability_ids_only=<bool, raw misses[].message FORBIDDEN in bundle>
                validateGoldenCorpus=<[] ?>  validator_strengthened=<bool>
      TARGETS:  en>=0.98  pt-BR>=0.97  pt-PT>=0.92  mixed>=0.90  persisted>=0.90
      COMMAND:  evaluatePerLanguagePrepassRecallAtK(REAL_corpus,8) + getLatestRecallAt8()
      CORPUS:   <content-hash ONLY> (peer-reviewed real; in PRIVATE evidence store; NOT in git; NOT seed)
      CORPUS_CONTENT_HASH: <sha256>   (MUST != sha256 of CHAT_CORE_V2_GOLDEN_CORPUS_SEED)
      CORPUS_PEER_REVIEW_SIGNOFF_HASH: <sha256 from committed manifest>
      ARTIFACT: <path/to/recall-per-language-AGGREGATE.json>
      PASS:     <PASS|FAIL>

  C5  auto-revert live + per-tenant flip stops live path  [health ENUM only]
      MEASURED: live_legacyFallbackRate24h(tenantA-as-HMAC)=<v>  ollamaHealth_enum=<ok|fail|skipped|stale>
                ollamaHealthy=<bool>  tenant_isolation_proven=<bool>
                raw_errorMessage_excluded=<bool>
      COMMAND:  __tests__/.../chat-core-v2-auto-revert-executor.test.ts (DMV via chat-message-routes)
      ARTIFACT: <path/to/test-run.log>  (must NOT contain ProbeResult.errorMessage)
      PASS:     <PASS|FAIL>

  C6a bench p95 CI proxy (necessary, NON-binding)
      MEASURED: burst5_p95_ms=<v>
      COMMAND:  scripts/bench-gate.sh
      PASS:     <PASS|FAIL>   (green is necessary but does NOT satisfy the gate)

  C6b bench p95 BINDING (GO gates on THIS)
      MEASURED: p95_ms=<v>  form=<vps_run|serialized_profile>
      ARTIFACT: <docs/release/ path>   (FAIL by default until this exists and is non-empty)
      PASS:     <PASS|FAIL>

  C7  tenant-salted mandatory HMAC corpus loader (no raw text emitted)
      MEASURED: salting_proof=<bool>  hard_fail_on_missing_secret=<bool>  no_raw_text_in_output=<bool>
      COMMAND:  __tests__/.../chat-core-v2-corpus-loader.test.ts
      ARTIFACT: <path/to/test-run.log>
      PASS:     <PASS|FAIL>

  C8  standing invariants
      MEASURED: killswitch_gate=<GATE-P1 integ test green?>  defaultoff_parity=<test name | BLOCKED>
                token_zero_preserved=<bool>  allowCloudFallback=<false?>
      ARTIFACT: <path/to/invariants.log>
      PASS:     <PASS|FAIL>
-------------------------------------------------------------------------
GATE READINESS (raw, for audit):
  evaluateChatCoreV2ShadowGateReadiness().gateMet = <false today — structural literal>
  getLatestRecallAt8() persisted recall_at_8_latest = <v or BLOCKED — producer not implemented (WP-13/19)>
  gateCanPromote (WP-13 measureChatCoreV2ShadowGateReadiness) = <BLOCKED — producer not implemented (WP-13)>
-------------------------------------------------------------------------
CANARY COHORT (privacy-safe):
  cohort_hmac_tokens: <hmacTenantScopedEntityId list>   (raw tenant:user lives ONLY in uncommitted .env)
  cohort_count:       <n>
  private_mapping_ref: <opaque pointer into private store>
-------------------------------------------------------------------------
REVIEWER SIGN-OFF:
  All C1–C8 PASS (C6 = C6b binding) and all GATE-P* CLOSED: <YES|NO>
  All producers confirmed to EXIST (path + git sha) before any boolean entered: <YES|NO>
  Privacy-safe (HMAC/aggregate/enum only; no raw message/errorMessage/raw IDs): <YES|NO>
  Reviewer name + date: ______________________
  Notes / exceptions:   ______________________
=========================================================================
```

---

## 5. Go / No-Go Decision Record Format

Record one of these per promotion attempt, immediately after the evidence bundle is reviewer-signed and before any flag flip.

```
ChatCoreV2 G2→G3 PROMOTION DECISION
  attempt:            <YYYY-MM-DD-HHMMZ>
  evidence_bundle:    <link/path to the Section 4 bundle>
  verdict:            GO | NO-GO
  basis:              <one line: "all C1–C8 PASS (C6b binding), all GATE-P* CLOSED" | which criterion blocked>
  blocking_items:     <list of FAIL criteria / open GATE-P*; empty on GO>
  reviewer:           <name>  (signed Section 4 bundle)
  felipe_authorized:  YES | NO   (mandatory for GO — Section 6)
  authorized_at:      <timestamp>
  canary_scope:       read-only; cohort recorded as HMAC tokens + count (raw tenant:user only in uncommitted .env)
  staging_rollback_rehearsal_done: YES | NO   (Section 7.5 — mandatory before GO)
  rollback_owner:     <name>   rollback_plan: Section 7
```

> **Default verdict today is NO-GO**, because `gateMet` is structurally `false`, the real corpus does not exist, `< 50` real shadow rows are accumulated, the WP-00.5/05/06/07/13/19/19-seed infrastructure is not yet present, and the C6b binding D3 evidence does not exist (Section 9). A GO requires every C1–C8 = PASS (C6 satisfied via C6b), every GATE-P* = CLOSED, the staging rollback rehearsal done, and Felipe's authorization.

---

## 6. Flag-Flip Sequence (shadow → canary), mirroring `promote-to-prod.sh` house style

Only execute after a **GO** decision record exists. The sequence mirrors validated-promote: focused tests/typecheck/verify → deploy-staging → staging soak + smoke (incl. the new ChatCoreV2 + kill-switch smoke) → Felipe authorization → promote. The flag is an env change (staging first, then production), never a code default flip (Invariant 1).

> **Env model (verified, BLOCKING correction):** canary is **NOT** turned on by `CHAT_CORE_V2_ORCHESTRATOR_MODE=canary` alone. The live chat path resolves through `resolveChatCoreV2LocalChatLlmMode`, which reads the **separate** `CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE` var (`local-chat-orchestrator.ts:122`), and in production hard-requires `CHAT_CORE_V2_LOCAL_CHAT_ALLOW_PROD === '1'` (`:139`). The action gateway reads `CHAT_CORE_V2_ACTION_GATEWAY_MODE` (`action-gateway.ts:109`). Setting only `ORCHESTRATOR_MODE=canary` resolves the local-chat LLM mode to `off` (`:124` default), so canary would silently never serve and Step 6's success criterion would fail unexplained. **WP-00.5 (interpretation B) deliberately did NOT collapse this multi-var model into a single `ORCHESTRATOR_MODE`** — it only consolidated the explicit-`off` kill-switch through `isChatCoreV2MasterKillSwitchOff` (an absent master mode still defers to the sub-mode vars). So the **full tuple below remains the only correct sequence** (the strict single-flag collapse is the deferred interpretation "A", not part of WP-00.5).

### Step 1 — Local gate (matches `promote-to-prod.sh` preflight + `.husky/pre-push`)
```bash
npm run typecheck            # tsc --noEmit
npm run verify               # typecheck + science-policy:check + full Vitest (science-policy:check is a non-ChatCoreV2 gate that can fail independently)
# ChatCoreV2 spot-check (these suites are created by the listed WPs and DO NOT EXIST pre-implementation —
# "no test files found" today is expected, not a tooling failure; see Section 9):
npx vitest run __tests__/services/chat-core-v2 __tests__/api/chat-core-v2-live-path-killswitch.integration.test.ts
npm run build                # tsc + asset copy
```
Verification floor (CLAUDE.md): full backend verify = 718 Vitest files / 10,525 tests; main pre-push gate = typecheck + full Vitest + build.

### Step 2 — Set the canary env on STAGING first (full verified tuple)
Edit staging `.env` (server-side; never commit secrets). Set the full tuple; keep writes and cloud off:
```
CHAT_CORE_V2_ORCHESTRATOR_MODE=canary
CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE=canary                      # REQUIRED — the actual local-chat mode source (local-chat-orchestrator.ts:122)
CHAT_CORE_V2_ACTION_GATEWAY_MODE=shadow                      # read-only canary keeps the gateway in shadow (NOT enforce) (action-gateway.ts:109)
CHAT_CORE_V2_LOCAL_CHAT_ALLOW_PROD=1                         # production-only hard gate (local-chat-orchestrator.ts:139); harmless on staging
CHAT_CORE_V2_LOCAL_CHAT_CANARY_USERS=<tenantId:userId,...>   # explicit allowlist (parseCanaryList, local-chat-orchestrator.ts:140)
CHAT_CORE_V2_ALLOW_WRITE_EXECUTION=false                     # read-only canary (default)
CHAT_CORE_V2_ALLOW_CLOUD_FALLBACK=false                      # no raw text to cloud (default)
CHAT_CORE_V2_CANARY_MIN_RECALL_AT_8=0.80                     # boot floor (NOT the promotion gate — WP-14)
# Do NOT set CHAT_CORE_V2_CANARY_GATE_OVERRIDE in production; if ever set it refuses to
# apply unless CHAT_CORE_V2_CANARY_GATE_OVERRIDE_ALLOW_PROD=1 is ALSO set (WP-14 §5.I).
```
Two gates, distinct: the **0.80 boot floor** (`assertCanaryGateOrExit`, WP-14) only prevents booting on a clearly-broken selector; the **0.90 persisted recall** (`getLatestRecallAt8()`, seeded by WP-19-seed) is the real promotion authority and is **not** override-able.
> NOTE: WP-00.5 (interpretation B) did **not** collapse this multi-var model into a single `ORCHESTRATOR_MODE` — it only consolidated the explicit-`off` kill-switch through `isChatCoreV2MasterKillSwitchOff`, so the sub-mode vars still drive activation. The single-flag collapse (strict default-off subordination, interpretation "A") is a separate **deferred** decision. Use the full tuple.

### Step 3 — Deploy to staging + soak
```bash
./scripts/deploy-staging.sh   # isolated install on :8201
# let staging soak >= 5 min so crons (incl. chat_v2_auto_revert_eval */5) fire at least once
```

### Step 4 — Staging smoke (incl. the new ChatCoreV2 + kill-switch smoke)
```bash
./scripts/staging-smoke.sh    # must exit 0 (all dynamically-counted checks pass — the script computes TOTAL=PASS+FAIL; do NOT assume a fixed "17")
```
Extend `staging-smoke.sh` in the same change set, following its `test_ios_401`/`test_ios_chat_route_mounted` house style. The existing chat smoke is an **unauthenticated** 401-envelope/route-mounted check (`test_ios_chat_route_mounted`), so it cannot read back a `routeMethod`. The two new checks must observe canary-vs-legacy **without spending tokens** via one of:
- **Resolver-level node -e probe (preferred, token-free):** on staging, `require` the built `isChatCoreV2LocalChatVisibleEnabled`/`resolveChatCoreV2LocalChatLlmMode` and assert, against a **fixture env**, that a canary-listed synthetic `tenant:user` resolves to canary while a non-listed one resolves to legacy; and that with mode forced `off` both resolve to no-op. This is a deterministic, no-model assertion.
- **OR a non-LLM, auth-gated diagnostic** that returns the resolved `routeMethod` for a synthetic canary `tenant:user` (read-only, no model call), if such an endpoint is added.

Both new checks MUST assert only on resolver result / HTTP status and **MUST NOT log request or response bodies**; use a fixed non-sensitive probe payload and assert structurally (token-zero / no-raw-text posture).
- **ChatCoreV2 canary boundary smoke:** canary-listed `tenant:user` → v2; non-canary → legacy.
- **Kill-switch smoke:** mode forced `off` (or per-tenant Map flip to `shadow` once WP-07 lands) → canary user gets no-op/legacy — DMV of GATE-P1/C5 on the deployed artifact.

A smoke failure here is an automatic NO-GO; `promote-to-prod.sh` refuses to promote unless `staging-smoke.sh` exits 0.

### Step 5 — Felipe authorization (EXPLICIT, MANDATORY)
> **STOP. Do not promote to production, and do not touch the production `.env`, without Felipe's explicit authorization.** This is the human gate: Felipe reviews the signed Section 4 bundle and the Section 5 GO record, confirms the canary cohort (read-only; cohort recorded as HMAC tokens), and authorizes. Record `felipe_authorized: YES` + timestamp in the decision record. This mirrors the interactive `type YES to confirm` gate in `promote-to-prod.sh` and is non-skippable for a canary flip.

### Step 6 — Promote to production (prod .env edit is a Felipe-authorized substep)
> **The production `.env` MUST NOT be touched on a NO-GO**, and must only ever be written **immediately before** the authorized promote, never left set across a non-canary deploy (a stray prod canary env would be activated by the next ordinary deploy — `deploy.sh`'s `ensure_clean_deploy_tree` guard, `:77-102`, does not cover an out-of-band `.env` edit). `.env` is on CLAUDE.md's Forbidden-to-modify list, so this is a deliberate, logged, Felipe-authorized exception.

1. **(Authorized substep — only after `felipe_authorized: YES`)** Set the same full canary tuple from Step 2 on the production `.env`.
2. Force a **fresh** smoke so the new ChatCoreV2/kill-switch checks actually run as the gate (do not let `promote-to-prod.sh` reuse a stale smoke-evidence JSON authored by a pre-additions smoke binary — it reuses for the same staging dist hash when age ≤ `NEXUS_SMOKE_REUSE_MAX_AGE_S`, default 1800s):
```bash
NEXUS_SMOKE_REUSE=0 ./scripts/promote-to-prod.sh   # forces a fresh staging-smoke gate, then deploy.sh, then /health check
```
   (Alternatively, confirm the reused evidence SHA == the SHA that contains the smoke additions.)

Promotion succeeds when production `/health` returns 200, PM2 shows `nexus-hub` + `content-engine` online, and a canary-listed user gets a v2 `routeMethod` while non-canary users stay on legacy.

### Step 7 — Post-promote watch
- Confirm `getLatestRecallAt8()` persisted ≥ 0.90 still holds; confirm the `chat_v2_auto_revert_eval` cron (`*/5`) is registered and producing per-tenant metrics.
- Tail the canary split log (`chat_v2_canary_turn_log`, WP-14) and the auto-revert decisions (`chat_v2_auto_revert_decisions`, WP-07) for the first hour. Keep all tailed evidence aggregate/HMAC only.

---

## 7. Rollback

> **Rollback tested?** Today, **7.1 (env-revert + restart) is the ONLY path testable**, because 7.2's runtime-override Map and 7.4's audit writer are unbuilt (Section 9). 7.1 MUST be dry-run on staging (Section 7.5) as part of the same change set that adds the kill-switch smoke, and the GO record is gated on that rehearsal.

For a flag/behavior regression, **always reach for 7.1 first**: it is data-safe and instant. 7.3 (`rollback.sh`) is **only** for a genuinely bad build artifact and is **data-destructive** (see 7.3).

### 7.1 Primary — env-only revert (requires a process restart; NO hot-reload today)
Revert the **full canary tuple** in the production `.env`, then restart the process. Reverting only `ORCHESTRATOR_MODE` does **not** disable a canary enabled via `LOCAL_CHAT_LLM_MODE=canary` — you must also revert `LOCAL_CHAT_LLM_MODE` (and `ACTION_GATEWAY_MODE`):
```
CHAT_CORE_V2_ORCHESTRATOR_MODE=shadow      # back to observation-only
CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE=shadow    # REQUIRED — the actual local-chat mode source
CHAT_CORE_V2_ACTION_GATEWAY_MODE=shadow
# or, for full dormant (Invariant 1 collapses the activation config; both live parsers also short-circuit on 'off'):
CHAT_CORE_V2_ORCHESTRATOR_MODE=off
```
**Resolution path as it actually exists post-WP-00.5 (honest):** the live mode for the chat path is resolved by `resolveChatCoreV2LocalChatLlmMode` (`local-chat-orchestrator.ts:118`, kill check at `:121`) and `resolveChatCoreV2ActionGatewayMode` (`action-gateway.ts:103`, kill check at `:108`). Each now begins with `if (isChatCoreV2MasterKillSwitchOff(env)) return 'off';`, so both short-circuit to `off` on an explicit `CHAT_CORE_V2_ORCHESTRATOR_MODE=off` through the **one shared helper** (`activation-flags.ts:90`) — the two duplicated inline `off`-checks are gone (grep returns zero). An **absent** mode does NOT force off; it defers to each parser's own sub-mode env (behavior-preserving). The activation-config collapse (`activation-flags.ts:63-77`) remains a **separate** code path (interpretation "A" deferred). So "`off` wins" is now true through a single chokepoint helper, NOT two duplicated inline checks. The in-process parsers re-read env only on **process restart**; there is no `.env` hot-reload today, so the restart is mandatory (the WP-07 override Map, once it extends `isChatCoreV2MasterKillSwitchOff`, will be the no-restart per-tenant path — 7.2). This matches the Phase-2 WO rollback contract (`WO-chatcore-v2-production-activation.md:399` — "set `CHAT_CORE_V2_ORCHESTRATOR_MODE=off`").

### 7.2 Faster, no-restart — per-tenant runtime-override Map flip — **FUTURE / UNBUILT (WP-07)**
> **This mechanism does NOT exist in the worktree today** (no `setChatCoreV2RuntimeOverride`/`_runtimeOverrides`/`global_mode` in `src/`). Until WP-07 lands, the env-revert + restart in **7.1 is the only currently-real runtime control** — do not reach for 7.2 in a live incident before then.
>
> When WP-07 ships, this becomes the immediate per-tenant revert (and the exact mechanism the auto-revert executor uses):
> ```
> setChatCoreV2RuntimeOverride(<tenantId>, 'global_mode', 'shadow')   // WP-07; per-tenant keyed
> ```
> Designed semantics (to be DMV-verified by WP-07/WP-14, not yet proven): the resolver reads the Map before env; a per-tenant flip reverts canary on the live request path **without restart**; a startup `off` cannot be un-offed by the Map; the in-process Map is wiped on restart (intended) and the durable record is the persisted decision row. **Do not document any of these as facts until the WP-07 DMV tests are green.**

### 7.3 `scripts/rollback.sh` awareness — artifact-level fallback (DATA-DESTRUCTIVE)
> **WARNING:** `rollback.sh` → `restore.sh --apply` does an atomic swap of **dist, migrations, prompts, AND `data/bot.db`** (plus `garmin-tokens`), with a pre-restore snapshot (`rollback.sh:190`). For a canary regression that is purely a flag problem (the common case), restoring `bot.db` **rolls back all user data written since the backup** — almost never what you want, and it loses legitimate writes. **Never use 7.3 to undo a flag mistake; use 7.1.** 7.3 is ONLY for a genuinely bad build artifact.
```bash
./scripts/rollback.sh                    # list available backups (read-only)
./scripts/rollback.sh --dry-run latest   # validate the latest backup (remote restore.sh dry-run)
./scripts/rollback.sh latest             # apply the latest backup (PM2 stop/start, npm ci, atomic swap incl. bot.db, /health check)
```
`promote-to-prod.sh` already prints these exact instructions on a failed promote.

### 7.4 Record the rollback — **audit writer is a WO requirement, not yet implemented**
Emit the `chat_core_v2_rollback` audit/event row (`WO-chatcore-v2-production-activation.md:400`) capturing: trigger (manual vs auto-revert), the **aggregate metric snapshot** (rates + health **enum**) that prompted it, the mode transition (`canary→shadow`/`canary→off`), affected tenant(s) **as HMAC tenant-scoped tokens**, and an **HMAC/opaque reference** to failure evidence held in the private store — **never inlined raw text, never raw `errorMessage`, never raw `tenantId:userId`** (mirror the per-tenant HMAC keying used everywhere else). File a follow-up Work Order with the failure evidence (`WO…:401`). This writer does not exist yet — implement it alongside WP-07's `chat_v2_auto_revert_decisions` so manual rollbacks and auto-reverts share one durable, privacy-safe trail.

### 7.5 Mandatory staging rollback rehearsal (gates the GO)
Before a GO, perform and record a one-time staging rehearsal of 7.1: flip the canary tuple → shadow on staging, restart, and confirm a canary-listed user falls back to legacy. Record `staging_rollback_rehearsal_done: YES` in the Section 5 decision record. (7.3 dry-run, `./scripts/rollback.sh --dry-run latest`, may also be validated, but is not the flag-revert rehearsal.)

---

## 8. Quick Reference — Pass Map

| Criterion | Function / command | File | Pass when |
|---|---|---|---|
| C1 rows ≥ 50 (real) | `evaluateChatCoreV2ShadowGateReadiness().meetsMinRows` + distinct turn_id / created_at spread / shadow-on window | `shadow-gate-readiness.ts:64,83,70` | `rowCount >= 50` AND real-traffic sub-checks recorded |
| C2 schema ≥ 99% | `…schemaValidPct` / `…meetsSchemaValidity` | `:82,84` | `>= 0.99` |
| C3 no raw msg field | `…safeShapeViolationCount` / `…meetsSafeShape` | `:78,85,135` | `=== 0` (scope: contextPack msg/preview only, NOT blanket) |
| C4 recall@8 real | `evaluatePerLanguagePrepassRecallAtK(corpus,8)` (WP-13/19, unbuilt) + `getLatestRecallAt8()` + `validateGoldenCorpus` (strengthened) | `prepass-recall-eval.ts`; WP-13 store | per-lang targets + persisted ≥ 0.90, content-hash ≠ seed, aggregate projection only |
| C5 auto-revert live | DMV test through `chat-message-routes`; `getLatestHealthByProvider` (health enum only) | WP-06/07; `integration-health.ts:351` | per-tenant flip stops live path; no raw errorMessage |
| C6a bench proxy | `scripts/bench-gate.sh` burst5 | WP-11 | CI green (necessary, NON-binding) |
| C6b bench binding | VPS/GPU artifact under `docs/release/` OR ratified serialized profile | D3; build plan §8 | GO gates on this; FAIL until artifact exists |
| C7 HMAC salting | `loadShadowReplayCorpusItems` salting test (WP-19, unbuilt) | WP-19 | 2 tenants → different tokens; hard-fail on no secret; no raw text in output |
| C8 invariants | GATE-P1 integration test + default-off parity | WP-00.5 | killswitch integ test green (NOT grep); parity test named or BLOCKED |

---

## 9. Why This Gate Cannot Pass Today (honest status)

This runbook is complete and executable as a procedure, but a **GO verdict is impossible as of 2026-05-29** for the following independently-verified reasons:

1. **`gateMet` is structurally `false`.** `evaluateChatCoreV2ShadowGateReadiness()` returns `gateMet: false` by construction (`shadow-gate-readiness.ts:60`, `:98`) and `recallAt8: 'requires_labeled_corpus'` (`:55`, `:97`), because recall@8 needs a separately-validated labeled corpus and cannot be derived from shadow rows. Intentional honesty, not a bug.
2. **The real corpus does not exist, and the validator green-lights the synthetic seed.** Only `golden-corpus-seed.ts` (synthetic, 263 items / 112 unique, recall@8 = 0.5627) is present; the corpus spec (§"Storage Rules"/§"Current Status") requires a peer-reviewed real ≥200-turn corpus held in the approved private evidence store, **not** in the git repo. Worse, `validateGoldenCorpus(CHAT_CORE_V2_GOLDEN_CORPUS_SEED)` returns `[]` today: the `synthetic_only` check (`golden-corpus.ts:69-70`) fires only if *not one* item is real/operator-sourced, and the seed already carries such items. So a synthetic recall could be passed off as the gate. C4 cannot pass until the validator is strengthened (minimum real-evidence count/share + operator-seed promotion), the per-language evaluator exists, and the persisted recall is bound to a content hash ≠ the seed's.
3. **C4 has no per-language producer.** `evaluateGoldenCorpusPrepassRecallAtK` (`prepass-recall-eval.ts:96`) returns a flat result with no `language` field/filter; `evaluatePerLanguagePrepassRecallAtK` does not exist. The four per-language numbers the bundle demands cannot be machine-produced yet.
4. **`< 50` real shadow rows.** The shadow runtime is default-off; no real `chat_v2_replay_bundles` rows at scale have been accumulated, so C1 cannot pass yet (and "real traffic" must be machine-checked, not asserted in prose).
5. **The gate-opening infrastructure is unbuilt.** None of `setChatCoreV2RuntimeOverride`/`_runtimeOverrides`/`global_mode`, `metrics-aggregator.ts`, `auto-revert-executor.ts`, `gate-metrics-store.ts`, `canary-gate-guard.ts`, `upsertRecallAt8`/`getLatestRecallAt8`, `evaluatePerLanguagePrepassRecallAtK`, `measureChatCoreV2ShadowGateReadiness`/`gateCanPromote`, `scripts/bench-gate.sh`, or migrations `172`–`177` exist (highest is `171_classify_shadow_runs.sql`; only `auto-revert-policy.ts` exists). So GATE-P5, GATE-P9, GATE-P10 and criteria C4/C5/C6b/C7 have no producer to measure, and the spot-check vitest suites in Step 1 will report "no test files found" until the WPs land.
6. **The kill-switch chokepoint consolidation is DONE; the remaining GATE-P1 item is the WP-07 override-flip proof.** `local-chat-orchestrator.ts:121` and `action-gateway.ts:108` now both call `if (isChatCoreV2MasterKillSwitchOff(env)) return 'off';` (the shared helper at `activation-flags.ts:90`); the inline `String(env.CHAT_CORE_V2_ORCHESTRATOR_MODE ?? '').trim().toLowerCase() === 'off'` compares WP-00.5 had to remove are gone (grep returns ZERO). What is NOT yet done is the WP-07 runtime-override integration: WP-07 must extend `isChatCoreV2MasterKillSwitchOff` (or move both parsers to a Map-aware resolver) and prove a per-tenant flip stops the live path without restart. The real gate for that piece is the integration test, not the grep.
7. **The D3 concurrency baseline fails the gate.** D3 burst/concurrent/sustained p95 is ~10–15s vs the 5s gate, and the production-sized run was never executed (peer review item 3; build plan §8). C6b requires a passing VPS run or a formally-ratified serialized-only profile; the CI `burst5` proxy (C6a) is necessary but not binding.
8. **GATE 0b is NO-GO for activation.** The peer review's verdict is "NO-GO (CONDITIONAL) for production activation; GO only for shipping dormant (default-off)." Promotion to canary is blocked until items 1–9 of the peer review's precise-change list are delivered-and-verified (item 10, the kill-switch/default-off guard, being the always-on invariant).

When the build-plan WPs land (WP-00.5/01/02/03/04/05/06/07/09/10/11/13/14/19/19-seed), the validator is strengthened and the real peer-reviewed corpus is built in the private evidence store, the per-language evaluator + persisted recall writer exist, ≥50 real shadow rows are accumulated, the C6b binding D3 form is satisfied, and the staging rollback rehearsal is done, re-run Sections 3–4, obtain reviewer + Felipe sign-off (Sections 5–6), and only then set the full canary env tuple to flip shadow → canary.