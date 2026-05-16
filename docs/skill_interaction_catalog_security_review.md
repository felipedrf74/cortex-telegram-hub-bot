# Skill Interaction Catalog — Security Review (Retrospective)

_Phase 15 batch 80 (2026-05-16): retrospective record of the security defenses that protect the catalog._

## OWASP LLM Top 10 (mapping cell-by-cell)

| OWASP LLM Risk | Existing defense | Catalog impact | Phase 1-15 mitigation |
|---|---|---|---|
| **LLM01 Prompt Injection** | `sanitizeUserFacingChatText`, `DEBUG_LEAKAGE_PATTERNS` (28-pattern regex), per-action `prompt_injection` example tags | `examples` may contain injection examples used in eval — never in prompts | Phase 15 batch 79: EVERY `external_side_effect` + `financial` action ships ≥ 1 `prompt_injection` example; tagged + excluded from few-shot retrieval |
| **LLM02 Insecure Output Handling** | `chat-action-run-store.ts:265-298` `sanitizeChatActionRunResult` strips provider payloads on writeback | none new | Unchanged |
| **LLM03 Training Data Poisoning** | N/A (no fine-tuning) | none | N/A |
| **LLM04 Model DoS** | Tier 1 timeout 1800ms; per-skill latency budget via `SKILL_METADATA.latencyBudgetMs` (Phase 13 batch 69) | Catalog adds examples and prompt slices for few-shot ranking | Hard cap in retrieval code: Tier 2 planner examples are capped to six and registry entries are capped to a relevance-ranked subset; per-skill latency budget surfaced |
| **LLM05 Supply Chain** | dependency lockfile, SBOM, dependabot | none new | Unchanged |
| **LLM06 Permission Issues** | `authorizeChatToolCall` via AsyncLocalStorage; `FORBIDDEN_MODEL_ARG_KEYS` | `executor` stays server-side — never reaches LLM context | Phase 15 schema doc enforces in `buildLlmSafePromptSlice` |
| **LLM07 Data Leakage** | `LOGGER_REDACTION_PATHS` (145 paths); `audit_trail` GDPR-exempt | `examples` are user-text shapes, not real data | Lint: `examples` cannot contain emails/phones (audit-level review) |
| **LLM08 Excessive Agency** | Risk class R0-R4 with TTL; confirmation policy per action; read-back required for mutations | Catalog makes risk class explicit per intent — STRENGTHENS | Phase 15 batch 79 gate: every financial action has `strong_confirm` policy |
| **LLM09 Overreliance** | Calibrated score thresholds; false-success gate; debug-leakage gate | STRENGTHENS — fixture generation increases coverage of overreliance edges | Phase 14 batch 74 shadow gate adds generator + comparator |
| **LLM10 Model Theft** | Provider-managed | N/A | N/A |

## Catalog-specific risks (audited Phase 0; mitigated Phases 1-15)

### Risk: Example injection vector

**Threat**: malicious example text shipped via code review could include "ignore previous instructions"-style content unchecked.

**Mitigation**: lint rule scans `examples[].text` for injection markers; CI blocks. The audit's `embedded_llm_instruction_markers` condition tag (used on 30+ examples) IS the marker — those examples are exclusively used as REFUSAL fixtures, NOT as few-shot prompts. The retrieval layer filters by `tags` and excludes `prompt_injection` / `adversarial` from prompt context.

### Risk: Registry expansion confused-deputy

**Threat**: a new action shipped without proper risk classification could bypass confirmation.

**Mitigation**: type system requires `risk` and `confirmationPolicy` on every entry (compile-time). `status: 'experimental'` available so new actions don't ship to production until promoted. Phase 15 batch 79 hard-gates financial → strong_confirm parity.

### Risk: Stale entry execution

**Threat**: a `deprecated` action remains in registry → planner could still pick it.

**Mitigation**: `selectRegistrySubsetForMessage` filters by `status === 'active'`. The `status` field defaults to `'active'` via the `getChatActionRegistry()` fallback, so explicit deprecation must be opted into.

### Risk: Multi-region channel drift

**Threat**: per-region channel constructed from missing env var lands in wrong region's payload.

**Mitigation**: Phase 11 batch 57 + 12 batch 65 — `pickRegionalEnv` requires ALL required keys per region; falls back to base form only when no regional vars exist. `validateMultiRegionChannelRoutingPolicy` checks ALL referenced channel IDs at startup.

### Risk: Smoke-run impersonating real incident

**Threat**: weekly smoke probe hits a real PagerDuty / Slack channel and gets mistaken for a real incident.

**Mitigation**: Phase 10 batch 55 `buildSmokeAlertPayload` tags every smoke payload with `[SMOKE]` in the title. Severity = `info`. Operators configure dedicated test channels or use the `--dry-run` flag.

## Catalog-specific security tests

| Test | Phase | What it pins |
|---|---|---|
| `chat-action-prompt-safety.test.ts` | Phase 0+ | Sanitization + redaction across all actions |
| `chat-action-registry-lint.test.ts` | Phase 1+ | 10 lint rules over entry shape |
| `chat-action-registry-state-required-parity.test.ts` | Phase 5+ | 28 state-required scenarios |
| `chat-action-registry-shadow-parity.test.ts` | Phase 7+ | 3 shadow-parity checks |
| `registry-cross-tenant-alert-channels.test.ts` | Phase 8+ | 18 channel-formatter tests |
| `registry-alert-channels-ci-gate.test.ts` | Phase 9+ | 36 channel-contract tests |
| `registry-real-eval-gates.test.ts` | Phase 7+ | 6 macro real-eval gates |
| `registry-real-eval-gates-locale.test.ts` | Phase 11+ | 7 per-locale gates |
| `registry-per-action-minimum-eval-gate.test.ts` | Phase 15 | 6 per-action minimum gates |

## NCSC "Prompt injection is not SQL injection" alignment

The NCSC piece argues that prompt injection differs from SQL injection because there's no algorithmic separation between data and instructions in an LLM. The catalog's architectural response:

* **Trust boundary**: `executor` and `verifier` are SERVER-SIDE labels. They never appear in LLM context.
* **`buildLlmSafePromptSlice`** (Phase 15 schema doc): strips executor / verifier / internal IDs / tenant IDs before LLM dispatch.
* **`FORBIDDEN_MODEL_ARG_KEYS`** in planner: identity-key normalization — `userId`, `tenantId`, `accountId`, etc. never sent to LLM.
* **Risk-class + confirmation policy**: separates "what the user asked for" from "what the engine is willing to do" — even a successful injection can't bypass the confirmation policy.

## NIST AI RMF alignment

| RMF Function | Catalog mechanism |
|---|---|
| Measure | Real-eval CI gates + per-locale gates + per-action minimum eval gates |
| Manage | `status: 'experimental'` for new actions; shadow-mode rollout (Phase 14 batch 74) |
| Govern | Phase snapshots in `docs/release/eval-evidence/phase-*-catalog-snapshot.md` |
| Monitor | `chat_action_telemetry` table + adversarial discovery (Phases 6-9) |
| Rollback | Per-batch commits; per-channel `minSeverity` + per-region policy let operators disable a channel without code change |
