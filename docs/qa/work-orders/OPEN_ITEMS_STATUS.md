# Open items across plans — status snapshot (2026-06-02)

## Current ChatV2 production push — remaining open items

The current branch is green for the backend release bundle, but full ChatV2 legacy retirement is **not** complete and must not be represented as complete.

**Ready to push:** local implementation fixes, merge resolution, ChatV2 safety scaffolding, deterministic read/write guardrails, training calendar cleanup, provider forwarding, and the release bundle that passed `npm run verify`.

**Still open before full ChatV2 legacy decommission:**

1. Collect fresh distinct-endpoint parity observations on the current held-out corpus for every legacy route-exit row.
2. Import only Claude/manual signed labels bound to complete raw-pair review artifacts. `runtime_tool` labels remain plumbing evidence only.
3. Keep all 9 legacy route-exit rows blocked until each has `>=50` samples, `>=95%` parity, zero safety regressions, zero quality regressions, and zero degraded-not-comparable rows.
4. Unblock `selective_internet_research` by fixing/validating answer completeness on the current corpus, then rerun a fresh distinct-endpoint review. Prior Claude review found truncation/partial-answer quality blockers and issued no signable labels.
5. Treat write-route retirement as one coupled firewall rollout. Before enforcing writes, prove `CHAT_CORE_V2_ACTION_GATEWAY_MODE=enforce` plus `CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK=on`, write-intent detector recall, preview/card parity, idempotency/readback, and iOS card rendering.
6. Keep `legacyFallbackDisabled=false` until per-tenant soak, attributed fallback counters, rollback rehearsal, and independent parity labels all pass.
7. Rotate any API key that was pasted into chat before enabling production traffic.

Authoritative detailed Work Order: `docs/qa/work-orders/WO-chatv2-completion.md`.

---

# Older open items across plans — status snapshot (2026-05-26)

This file enumerates every open item across the v3.2 + Phase K + Option 3 work and labels what's been resolved on the VPS vs what still requires operator action.

## P0 — Mac source-of-truth sync (URGENT)

The next routine Mac → VPS rsync deploy will silently overwrite v3.2 + Phase K + Option 3 production work unless the operator lands these patches on Mac main first.

**Status:** Bundle is shipping-ready on VPS. Operator action pending.

**Patch verified to apply cleanly with `patch -p1` from `cortex-telegram-hub-bot/` root.**

**Bundle path (VPS):** `/home/dominguez/snapshots/pre-ollama-v3.2-20260526-164248/option-3/`

| File | Apply |
|------|-------|
| `option-3-src.patch` (3,861 lines, 12 src files) | `patch -p1` |
| `install-ollama.sh.patch` | `patch -p1` |
| `ollama-provider.test.ts.patch` | `patch -p1` |
| `new-files/171_classify_shadow_runs.sql` | copy → `migrations/` |
| `new-files/classifier-golden-set.json` | copy → `data/` |
| `new-files/classifier-golden-eval.ts` | copy → `scripts/llm/` (chmod +x) |
| `new-files/option-3-classifier.test.ts` | copy → `__tests__/services/` |
| `.env` additions (12 lines) | manually add; `CLASSIFY_SHADOW_HASH_SECRET` is generate-once on Mac |

Full instructions in `docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md` "How to apply on Mac".

## P1 — Shadow accumulation + cutover (operator-driven)

**Step 7 (accumulate ≥50 real classify shadow rows):** waiting on production traffic. As iOS users send chat messages, `classify_shadow_runs` populates.

Check progress:
```sql
SELECT COUNT(*) AS n,
       SUM(agree) AS agreed,
       SUM(CASE WHEN agree=0 AND manually_reviewed=0 THEN 1 ELSE 0 END) AS unreviewed_disagreements
FROM classify_shadow_runs;
```

**Step 8 (cutover decision):** blocked on Step 7 + operator manual review per O3-A24.

## P2 — Classifier prompt improvements (DONE on VPS, pending Mac sync)

After the initial golden eval surfaced 5 gate failures on qwen2.5:3b + v1 (budget/price keyword anchoring), I:

1. Added an `OLLAMA_CLASSIFIER_PROMPT_VERSION=v2` compact prompt with explicit disambiguation rules.
2. Re-ran the golden eval across 4 quadrants:

| Model | Prompt | Overall | Gates passed | p95 ms |
|-------|--------|---------|--------------|--------|
| qwen2.5:3b | v1 | 95.0% | 6/11 | 3816 |
| **qwen2.5:3b** | **v2** | **99.2%** | **10/11** | **4209** |
| gemma2:2b | v1 | 92.5% | 7/11 | 3305 |
| gemma2:2b | v2 | 95.0% | 10/11 | 3987 |

**Recommendation:** qwen2.5:3b + v2 is the winner — 4.2pp better overall vs v1, fixes all 4 quality gates that v1 failed, only the p95 latency gate (4.2s vs 3s gate) still red (but under the 5s shadow timeout). Full analysis in `data/classifier-golden-runs/CLASSIFIER-COMPARISON-2026-05-26.md`.

**Production env stays on v1** until Mac sync; switching prompts on VPS-only would diverge from Mac source. Operator flips `OLLAMA_CLASSIFIER_PROMPT_VERSION=v2` AFTER Mac sync lands.

## P3 — Staging better-sqlite3 NODE_MODULE_VERSION mismatch (FIXED)

Pre-existing infrastructure bug unrelated to Option 3. `npm rebuild better-sqlite3` in `/home/dominguez/telegram-hub-bot-staging` resolved.

## P4 — Documentation drift (MINOR)

`docs/ai/model-routing-current-state.md` body still describes 2026-05-19 pre-Phase-K state in detail. I added a 2026-05-26 addendum at the top + Phase K + Option 3 sections at the bottom. The middle of the doc is technically stale but the addendum + bottom sections cover the correct current state. Could be rewritten end-to-end in a future cleanup pass.

## Round 2 (after this status doc was first written)

| Priority | Item | Result |
|---|---|---|
| **P1** | End-to-end shadow validation | ✅ Forced two real shadow rows via standalone node script. First row hit timeout (5s) — provider init race in standalone context. Second row succeeded in 1518ms, `agree=1`, `ollama_domain=secretary`. Confirmed: O3-A12 (zero api_usage rows for shadow), O3-A18 (AbortController-driven timeout fires + records error), O3-A19 (correct schema-version + model + prompt-version fields). Minor finding: `gemini_model` field comes through as null because the live classifier doesn't pass through Gemini's model name. Easy fix, not blocking. |
| **P1** | Production env propagation | ✅ Indirect proof via shadow row metadata (ollama_prompt_version='v1', ollama_model='qwen2.5:3b-instruct-q4_K_M' — both from `process.env`). `/proc/$PID/environ` doesn't show dotenv-loaded vars (same as GEMINI_API_KEY, OPENAI_API_KEY, PORT — also absent). Expected behavior. |
| **P2** | v3 compact prompt | ✅ Attempted. REGRESSION vs v2: 96.7% overall (-2.5pp), p95 6031ms (got SLOWER not faster), triathlon recall 92% (back to v1 level), 4 failures. v2's verbosity does real work — compression doesn't pay. Kept v3 in source as paper trail with explicit "DO NOT PROMOTE" comment. Stay with v2. |
| **P2** | Codex QA prompt drift check | ✅ Fixed item 22 grep (was `ACTIVE_MAIN_MODEL`, docs use `ACTIVE_MAIN`/`ACTIVE_CLASS`). Added items 26 (v2 prompt exists, env-versioned) and 27 (4-quadrant comparison documented). Item count: 25 → 27. |

## What I'd recommend next

In order:

1. **Operator: apply Mac patches** (P0). Without this, the next routine deploy wipes everything.
2. **Operator: send Codex angry-QA** — prompt at `docs/qa/prompts/codex-option-3-classifier-qa.md` (25 items + 10 red-team scenarios).
3. **After Codex round + fixes:** flip `OLLAMA_CLASSIFIER_PROMPT_VERSION=v2` on production. Observe shadow rows.
4. **After ≥50 shadow rows + manual review:** cutover to `AI_CLASSIFY_PRIMARY=ollama` if effective_agree_pct ≥90% and tool-domain recall ≥95%.
5. **Optional Stage 3B:** `OLLAMA_MAX_LOADED_MODELS=2` only if cutover succeeds and the operator wants to keep qwen2.5:3b resident alongside qwen3.6:35b-a3b. Memory cap stays unchanged unless swap thrash appears.

## Closed items

- ✅ Phase K rollback intact (`AI_DOMAIN_PROVIDER_OVERRIDES` absent; runtime + config-parse hard-blocks in source).
- ✅ Stop-gap: classify recovered from 60s → ~1s.
- ✅ Shadow-eval code + migration + tests deployed on VPS.
- ✅ 14/14 Option-3 vitest tests passing.
- ✅ Production /health 200; uptime healthy.
- ✅ Memory 25GB available; swap delta zero.
- ✅ Codex QA prompt drafted (`docs/qa/prompts/codex-option-3-classifier-qa.md`).
- ✅ Mac handoff doc complete (`docs/qa/work-orders/WO-ollama-local-llm-mac-handoff.md`).
- ✅ Runbook updated (`docs/runbooks/ollama-local-llm.md`).
- ✅ v2 prompt code committed (env-versioned, back-compat with v1).
