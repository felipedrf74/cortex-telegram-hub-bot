# Round-3 PR #145 QA Review — Low-Confidence Classify Escalation

Date: 2026-05-27
Reviewer: Codex
Branch: `qa/round3-pr145-review`
Candidate reviewed: `6d1805e6` (`feat(classify): low-confidence Ollama→Gemini escalation + Qwen license note`)
Base context: production deploy commit `e5ca0034`, version `4.14.198`

## Summary

PR #145 is directionally sound: low-confidence escalation runs only after a successful primary classify result, so it does not burn circuit-breaker failures or mark the primary provider unhealthy. The tool-domain set is correct (`secretary`, `triathlon` only), the new mocks use valid domain/confidence shapes, and the fallback retry is awaited synchronously with the caller's `ClassifyOptions`.

Two findings remain. First, O3-A7 telemetry is missing: a confidence-driven second opinion returns the fallback classification but does not surface `fallbackUsed=true` / `fallbackReason='low_confidence'` anywhere in the returned classify result or fallback event stream. Second, fallback errors are caught broadly, so programmer errors in the fallback classify path are silently degraded to the low-confidence primary result.

## Findings

| ID | Severity | Finding | Recommendation |
| --- | --- | --- | --- |
| R3-PR145-1 | HIGH | Missing O3-A7 telemetry for low-confidence escalation. `ClassificationResult` only contains `domain` and `confidence`; `TaskRoutingProvider.classify` returns `fallbackResult` directly after the second-opinion call and does not emit an `onFallback` event or attach `fallbackUsed=true` / `fallbackReason='low_confidence'`. | Add a classify-result metadata channel or explicit trace field, extend fallback reason typing with `low_confidence`, and add a regression test asserting the escalated result carries the O3-A7 signal. |
| R3-PR145-2 | HIGH | Low-confidence fallback catch is too broad. The catch catches all thrown values from `pair.fallback.classify`, logs only the message, and returns the primary low-confidence result. That hides TypeError/configuration/programmer failures the same way as transient provider failures. | Narrow the catch to known provider/classifier failure classes or retryable provider errors; rethrow unexpected programming/configuration errors. |
| R3-PR145-3 | MEDIUM | Branch coverage is incomplete for the threshold helper. The 3 new tests cover low non-tool, low tool-domain, and fallback-failure behavior, but not exact threshold equality, above-threshold no-escalation, undefined thresholds, missing threshold fields, or same-provider/no-fallback no-op. | Add focused tests for strict `<` behavior and defensive config branches before enabling Ollama-primary cutover. |

No CRITICAL findings were found.

## Verification Details

### 1. Branch coverage of `isLowConfidenceClassifyResult`

Evidence:

```bash
rg -n "classifyConfidenceThresholds|TOOL_BEARING_CLASSIFY_DOMAINS|isLowConfidenceClassifyResult" \
  src/services/provider-fallback.ts src/config.ts __tests__/services/provider-fallback.test.ts
```

Observed implementation:

- `config.classifyConfidenceThresholds` exists with defaults `0.65` and `0.80`.
- `isLowConfidenceClassifyResult` has a defensive `if (!thresholds) return false`.
- Missing field behavior is implicit, not explicit: `confidence < undefined` evaluates false through `NaN` coercion.
- Exact-equals threshold behavior is correct by inspection because the predicate uses strict `<`, not `<=`.

Observed test coverage:

- Covered: confidence below non-tool threshold (`cooking`, `0.4`).
- Covered: confidence below tool-domain threshold but above general threshold (`secretary`, `0.75`).
- Covered: fallback throws after low-confidence primary.
- Not covered: undefined threshold object, missing threshold fields, exact equality, above-threshold, no fallback, same primary/fallback provider.

Verdict: PASS for implementation behavior by inspection; MEDIUM coverage gap.

### 2. Circuit-breaker isolation

Evidence:

```bash
sed -n '700,760p' src/services/provider-fallback.ts
sed -n '901,966p' src/services/provider-fallback.ts
```

`executeWithFallback('classify', ...)` records primary success before returning the low-confidence primary result. The second-opinion fallback call occurs after that return and outside the `executeWithFallback` error path. It does not throw inside `executeWithFallback`, does not call `primaryBreaker.recordFailure()`, does not increment the primary failure count, and does not open the primary circuit.

Verdict: PASS.

### 3. `onFallback` metric semantics

Evidence:

```bash
rg -n "emitFallbackEvent|onFallback|fallbackTriggerCount|low-confidence" src/services/provider-fallback.ts
```

The confidence escalation path does not call `emitFallbackEvent` and does not increment `fallbackTriggerCount`. That matches the semantic distinction requested in the work order: this is a second opinion after a successful primary result, not a primary failure fallback.

Verdict: PASS for current semantic intent. Related telemetry finding remains because no replacement low-confidence signal is surfaced.

### 4. Telemetry on escalated result

Evidence:

```bash
sed -n '39,44p' src/domains/types.ts
sed -n '936,953p' src/services/provider-fallback.ts
rg -n "fallbackReason.*low_confidence|low_confidence.*fallbackReason" src/services/provider-fallback.ts __tests__/services
```

`ClassificationResult` is:

```ts
export interface ClassificationResult {
  domain: DomainName;
  confidence: number;
}
```

The escalation path returns `fallbackResult` directly and does not attach metadata. No `low_confidence` fallback reason exists in `FallbackReason`, and no test asserts provider metadata.

Verdict: FAIL, HIGH finding R3-PR145-1.

### 5. Failure mode when fallback throws

Evidence:

```bash
sed -n '951,961p' src/services/provider-fallback.ts
sed -n '259,270p' __tests__/services/provider-fallback.test.ts
```

The third O3-A7 test verifies fallback failure returns the low-confidence primary result. This is graceful for provider availability errors. However, the catch is broad:

```ts
} catch (err) {
  logger.warn(...);
  return primaryResult;
}
```

It does not distinguish known provider/classifier errors from programmer errors or malformed fallback implementations.

Verdict: PARTIAL, HIGH finding R3-PR145-2.

### 6. `TOOL_BEARING_CLASSIFY_DOMAINS` correctness

Evidence:

```bash
rg -n "TOOL_BEARING_CLASSIFY_DOMAINS" src/services/provider-fallback.ts
```

The set is exactly:

```ts
new Set(['secretary', 'triathlon'])
```

It does not include `training`, which is correct because `ClassificationResult.domain` uses the domain enum, not `ownerSkill`.

Verdict: PASS.

### 7. Concurrency and abort behavior

Evidence:

```bash
sed -n '901,966p' src/services/provider-fallback.ts
```

The fallback classify call is awaited synchronously:

```ts
const fallbackResult = await pair.fallback.classify(message, activeContext, options);
```

The same `ClassifyOptions` object is forwarded, including `timeoutMs` and `abortSignal` when present. There is no fire-and-forget race. If the parent `AbortController` fires between primary and fallback, the fallback provider receives the same signal and should abort according to provider-specific implementation.

Verdict: PASS, with expected latency tradeoff when escalation fires.

### 8. Test mock realism

Evidence:

```bash
sed -n '235,270p' __tests__/services/provider-fallback.test.ts
```

The new mocks use valid `ClassificationResult` shapes:

- `domain: 'cooking', confidence: 0.4`
- `domain: 'cooking', confidence: 0.95`
- `domain: 'secretary', confidence: 0.75`
- `domain: 'secretary', confidence: 0.99`

All domains are valid classifier domains and confidence values are in `[0, 1]`.

Verdict: PASS.

## Acceptance Outcome

- CRITICAL: 0
- HIGH: 2
- MEDIUM: 1
- LOW: 0

Recommendation: keep production as-is (`AI_CLASSIFY_PRIMARY=gemini`) and address HIGH findings before any Ollama-primary classify cutover. No emergency production rollback is indicated because the new path is effectively dormant in current Gemini-primary production except for unusually low Gemini confidence, where returning a second opinion is still safer than accepting the low-confidence primary classification.
