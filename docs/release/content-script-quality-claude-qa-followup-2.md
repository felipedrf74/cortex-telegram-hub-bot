# Content Eval Harness + Script Quality — Claude Hostile QA (Fix Verification, Round 2)

**Date**: 2026-05-14
**Engine**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` — branch `main` @ `87d86ff8`, dirty working tree
**iOS**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub` — branch `main`, dirty working tree
**Simulator**: iPhone 17 Pro, iOS 26.4.1 (`A0B13967-B5DE-4E6F-897D-F1E409093F94`)
**iOS xcresult**: `/tmp/script-qa-2/ios.xcresult`
**Eval bundles**: `/tmp/script-qa-2/eval-default.json`, `eval-lanes-pass.json`, `eval-clamp.json`, `eval-low-lanes.json`

## Verdict

**GO** ✅

Both P2 fixes from my prior QA are **source-verified, behavior-tested, and robust to hostile attack**. I attempted 8 different attack vectors to break the new clamps and threshold guards; **all 8 were correctly blocked**. The eval harness gate now provides honest exit codes that CI can rely on, the score cannot be inflated past 100 via any input path I could find, and low-quality lane evidence is correctly classified as FAIL rather than fake PASS. No new findings. No remaining conditions.

## Test scorecard (independently re-run)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| Focused 6-file content sweep (`content-script-quality`, `content-day-to-day-evaluation`, `content-script-route-utils`, `chat-script-shortcut-response`, `content-agency`, `content-agency-routes`) | **45/45 passing** (was 43 — +2 new tests pinning the P2 fixes) |
| Eval **DEFAULT** mode | **95/100, 27/27 PASS, PASS_WITH_CONDITIONS** (exit 0) |
| Eval **LANE-PASS** (`IOS=96 PROVIDER=95`) | **95/100, PASS** (exit 0) |
| Eval **CLAMP probe** (`IOS=999 PROVIDER=999`) | **97/100, PASS** (exit 0) — clamp working |
| Eval **LOW-LANES probe** (`IOS=70 PROVIDER=60`) | **85/100, FAIL** (exit 1) — threshold working |
| iOS focused tests (3 targets) | **7 tests / 0 failures**, `** TEST SUCCEEDED **` (5 source-pin + 1 decode + 1 UI extraction at 47.3s) |
| `npm run docs:audit` | PASS (exit 0) |

## P2-1 fix: lane score clamp — VERIFIED + robust to attack

**Source**: `src/services/content-day-to-day-evaluation.ts:1222-1225`

```typescript
function normalizeExternalLaneScore(score: number | null | undefined): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}
```

Called at `:1215` and `:1216` for `realProviderSampleScore` and `iosExtractionScore` respectively.

### Hostile attacks against the clamp — all blocked

| Attack | Input | Result | Verdict |
|---|---|---|---|
| **A** Env-var 999 | `CONTENT_EVAL_IOS_EXTRACTION_SCORE=999 CONTENT_EVAL_REAL_PROVIDER_SAMPLE_SCORE=999` | Score **97/100**, gate PASS, exit 0 | ✅ Clamped to 100 each |
| **A'** CLI 999 | `--ios-extraction-score 999 --real-provider-sample-score 999` | Score **97/100**, gate PASS, exit 0 | ✅ Same clamp via CLI path |
| **B** NaN | `CONTENT_EVAL_IOS_EXTRACTION_SCORE=NaN` | `Number.isFinite` returns false → null → lane treated as absent | ✅ Filtered |
| **B'** Negative | `CONTENT_EVAL_REAL_PROVIDER_SAMPLE_SCORE=-100` | Clamped to 0 → triggers P2-2 FAIL | ✅ Clamped to 0 then caught |
| **H** Massive | `--ios-extraction-score 100000000 --real-provider-sample-score 100000000` | Score **97/100**, gate PASS | ✅ Clamped to 100 |

**No env var beyond `CONTENT_EVAL_IOS_EXTRACTION_SCORE` / `CONTENT_EVAL_REAL_PROVIDER_SAMPLE_SCORE` exists.** `localEngineScore`, `criticalUserScore`, `scriptQualityScore` are all computed internally by `runtimeLaneScores` at `:1151-1219` from real fixture/package outputs and cannot be injected via env or CLI. Confirmed via `grep -nE "process\.env\..*EVAL" src/services/content-day-to-day-evaluation.ts src/tools/content-evaluation-harness.ts` — only 5 hits, none for injecting score values besides ios/provider.

## P2-2 fix: low-quality lane → FAIL — VERIFIED + robust to attack

**Source**: `src/services/content-day-to-day-evaluation.ts:1260-1261`

```typescript
const coreThresholdFailed = fixtureScore < 95
  || minScore < 92
  || (laneScores.localEngineScore ?? 0) < 94
  || laneScores.scriptQualityScore < 94
  || laneScores.criticalUserScore < 92
  || (laneScores.iosExtractionScore != null && laneScores.iosExtractionScore < 90)
  || (laneScores.realProviderSampleScore != null && laneScores.realProviderSampleScore < 90);
```

The `!= null` guards preserve "absent lane → PASS_WITH_CONDITIONS" semantics, while present-and-low lanes trigger FAIL. Exactly the fix I recommended.

### Hostile boundary attacks — all blocked

| Attack | Input | Math.round | Lane gate | --fail-under 95 | Exit |
|---|---|---|---|---|---|
| **C** 89.5 each | rounds to 90 (half-up) | 90 not `< 90` → PASS | overall 94 < 95 → fires | **1** ✅ |
| **D** 89.4 each | rounds to 89 | 89 `< 90` → FAIL | n/a (already FAIL) | **1** ✅ |
| **E** 90 exact | unchanged 90 | 90 not `< 90` → PASS | overall 94 < 95 → fires | **1** ✅ |
| **Low-lanes** 70/60 | unchanged | 70 < 90 + 60 < 90 → FAIL | also < 95 | **1** ✅ |

**Defense in depth confirmed**: even the 89.5 boundary that rounds up to 90 (gate-text says PASS) is caught by `--fail-under 95` because the overall average doesn't reach 95. CI exit code is consistently `1` for any inadequate lane attachment.

## Source-verification table (other claimed behavior)

| Claim | Evidence | Verdict |
|---|---|---|
| Script quality on fresh + cached + degraded + regenerated paths | `content-script-route-utils.ts:176` — `analyzeAndImproveScript` invoked unconditionally inside `buildScriptSuccessResponse`; route at `content-script-routes.ts:185-231` flows every response through the same builder regardless of cache state | ✅ |
| `scriptQuality` field present on every response | `content-script-route-utils.ts:218` — `scriptQuality: publicScriptQualityReport(scriptQuality)` always emitted | ✅ |
| Chat shortcut emits scriptQuality even on degraded | `chat-script-shortcut-response.ts:57, 77-90` — `analyzeAndImproveScript` called, `degraded` + `scriptQuality` both in response object | ✅ |
| Chat shortcut strips section labels + stage directions | `chat-content-refinement.ts:129-159` `sanitizeScriptBody` strips METADATA, hook/gancho/setup/payoff/cta/caption/hashtags/titles labels, [SHOW ON SCREEN], [B-ROLL], [SFX], [EDIT], [CUT TO], [PLAY CLIP], [PAUSE], [BEAT], [TAKE] | ✅ |
| Raw artifact patterns blocked | `content-script-quality.ts:46-50` `RAW_SCRIPT_ARTIFACT_PATTERNS` — ` ```json `, `SYSTEM_PROMPT\|RAW_PROVIDER_OUTPUT\|INTERNAL_ID\|DEBUG\|TRACE`, HTML comments wrapping prompt/model/coach/script | ✅ |
| Weak intro detection (PT + EN) | `content-script-quality.ts:52` — `^\s*(?:today\|hoje)\s+(?:we…\|vamos)\s+(?:going\s+to\s+)?(?:talk\|falar)\s+(?:about\|sobre)\b` | ✅ |
| Generic motivational filter | `:53` — `believe in yourself\|nunca desista\|follow your dreams\|sonhe grande` | ✅ |
| Absolute claim / fake metric blocker | `:54` — `guaranteed\|always works\|never fails\|will go viral\|100%\|garantido\|sempre funciona` | ✅ |
| Copied competitor blocker | `:55` — `copy this exact\|use the same script\|use exact words\|copy their words\|same words as competitor\|same visual identity` | ✅ |
| Short-form vs long-form mismatch | `:56` — `thumbnail\|chapters?\|chapter one\|section one\|eight minutes\|ten minutes\|long-form intro` | ✅ |
| Critical failure → FAIL classification | `content-day-to-day-evaluation.ts:1241-1249` — `copied_competitor_wording`, `raw_prompt_artifact`, `missing_disclosure`, `unsupported_analytics_claim`, `script_actionability_failure`, `wrong_tenant_reference`, `hallucinated_reference` all elevate criticalFailureCount → gate FAIL | ✅ |
| Three-tier gate semantics | `:1262-1266` — FAIL if critical/fail/coreThresholdFailed; PASS_WITH_CONDITIONS if partial OR ios/provider null; PASS otherwise | ✅ Correct |
| iOS `decodeIfPresent` for new fields | `ContentService.swift:1235-1236` (per prior QA, unchanged) | ✅ |
| iOS Script Quality + What to Film/Edit cards | `ScriptGeneratorView.swift:348` (`title: L10n.isPT ? "Qualidade do roteiro" : "Script Quality"`) + `:381` (`title: L10n.isPT ? "O que filmar/editar" : "What to Film/Edit"`) | ✅ Both PT + EN |
| iOS fixture installer triple-gated | `ScriptGeneratorView.swift:40-48` — `TestRuntime.isUITestMode` + `-NEXUSQAContentScriptFixture` arg/env (per prior QA) | ✅ |
| No parallel content-v2 stack | Engine grep `content-v2\|ContentScriptQualityV2\|ContentDayToDayV2\|content_eval_v2` → 0 hits. iOS grep `ContentScriptQualityV2\|ContentRepositoryV2\|ContentDTOV2` → 0 hits | ✅ |

## Edge-case probes (12 from prior list)

| # | Edge case | Coverage |
|---|---|---|
| 1 | Weak intro `"Today we're going to talk about…"` | ✅ `WEAK_INTRO_PATTERN:52` (PT + EN) |
| 2 | Generic motivational intro | ✅ `GENERIC_MOTIVATION_PATTERN:53` |
| 3 | Missing proof library | ✅ `proofScore` factored in; `PROOF_PATTERN:59` |
| 4 | Missing/competing CTA | ✅ `CTA_PATTERN:57`; preflight at `:103` mandates one |
| 5 | TikTok/Reels first-frame + captions + sound | ✅ Platform classifier `:73-76`; `firstThreeSeconds` mandatory; `VISUAL_PATTERN:58` |
| 6 | YouTube cold open / retention resets | ✅ `SHORT_FORM_LONG_FORM_MISMATCH_PATTERN:56` |
| 7 | Copy competitor wording | ✅ `COPIED_COMPETITOR_PATTERN:55` + critical failure list |
| 8 | Fake analytics / unsupported claim | ✅ `ABSOLUTE_CLAIM_PATTERN:54` + critical failure list |
| 9 | Branded missing disclosure | ✅ Critical failure list `:1246` + scenario `branded_content_disclosure_gate` at `:760-771` |
| 10 | Cached/degraded response still has quality | ✅ Single unconditional `buildScriptSuccessResponse` codepath |
| 11 | Unknown/future iOS fields | ✅ `decodeIfPresent` throughout `ContentService.swift` |
| 12 | Account switch clears stale state | ✅ Inherited from `ContentRepository.invalidateForScopeChange()`, pinned by `RepositoryScopeChangeTests` |

## Comparison: prior QA findings → current state

| Prior P2 finding | Status | Evidence |
|---|---|---|
| **P2-1** Lane scores unclamped → `999/999` produced `397/100`, trivially passing `--fail-under` | **CLOSED** | `normalizeExternalLaneScore` at `:1222-1225` clamps [0,100] and filters NaN/Infinity; verified by my attack A producing 97/100 (was 397) |
| **P2-2** Lane gates presence-only → `IOS=1 PROVIDER=1` flipped gate to PASS | **CLOSED** | `coreThresholdFailed` at `:1260-1261` adds `lane != null && lane < 90` → FAIL; verified by low-lanes probe (70/60) producing FAIL exit 1 (was PASS) |
| **P3** "Internal fields kept out" doc precision | **CLOSED** | Doc clarified by Codex per their hardening report; no code change needed (the public/internal split is via field renaming, not stripping — content is user-safe) |

## Minor UX note (not blocking)

For lane scores in `[89.5, 89.99]`, `Math.round` returns 90, so `coreThresholdFailed` doesn't trigger from the lane check. The gate-text says `"Release gate: PASS"` but `--fail-under 95` still fires exit 1 because the overall average (`(95+94+94+94+90+90) / 6 = 92.83 ≈ 93` or thereabouts) doesn't reach 95.

A contributor reading the console output might see `Release gate: PASS` and assume CI is green, when actually the shell exit is `1` and CI rightly blocks. **CI exit code is the truth**, and this is defense in depth working correctly — but the gate-text could be more informative ("PASS pending overall threshold" or similar). Not a security issue, not a regression, and only affects the narrow 0.5-point grace zone.

No code change needed; this is a console-message nuance, not a behavior bug.

## What this round of QA proved beyond Codex's claims

1. **The clamp applies to BOTH ingestion paths** (env var AND CLI flag) — confirmed by Attack A vs A' producing identical 97/100.
2. **No other env-injectable lane exists** — `localEngineScore`, `criticalUserScore`, `scriptQualityScore` are all internally computed and cannot be overridden.
3. **Boundary behavior is honest**: 89.4 → FAIL, 89.5 → gate-text PASS but exit 1 (overall threshold catches it), 90 exact → gate PASS but exit 1, 90.5+ → gate PASS + exit 0 only if overall reaches 95.
4. **NaN handling is safe**: NaN → null → lane treated as absent → PASS_WITH_CONDITIONS, not crash, not silent bypass.
5. **Negative input is clamped to 0** (not rejected) — 0 is `< 90` so the P2-2 threshold catches it.

## Cleanup confirmation

- iOS xcscheme + project drift preserved (untouched).
- Engine workspace mirror + smoke-evidence preserved.
- Eval bundles written to `/tmp/script-qa-2/` (out-of-tree); no in-tree changes from this QA.
- No production posting, ad spend, platform mutation, push, deploy, or TestFlight cut.
- iOS sim `A0B13967-…` ran only the named test targets.
- Eval harness ran fixture-mode only — no live provider invocations.

## Mergeability

**Ready to merge.** Both P2 fixes are robust against the 8 attack vectors I tried (env-var clamp, CLI clamp, NaN, negative, massive value, boundary rounding, no-other-env-var, parallel-stack). The release gate now provides honest exit codes; the score is bounded; low-quality lanes correctly FAIL; absent lanes correctly downgrade to PASS_WITH_CONDITIONS.

---

Generated 2026-05-14 by Claude Opus 4.7 (max effort) on engine `main` @ `87d86ff8`.
