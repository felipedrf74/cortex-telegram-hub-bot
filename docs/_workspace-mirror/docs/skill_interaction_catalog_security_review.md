# Skill Interaction Catalog — Security Review

Status: Decision document
Owner: Felipe (release lead)
Date: 2026-05-15
Reviewer perspective: Security Engineer
Companion to: [`skill_interaction_catalog_architecture_audit.md`](skill_interaction_catalog_architecture_audit.md), [`skill_interaction_catalog_schema_proposal.md`](skill_interaction_catalog_schema_proposal.md)

This review covers the security implications of **Action Registry Consolidation v2** (Option G). The chat-action stack at `4.14.164` already has strong defenses; this review verifies the consolidation **preserves and extends** them, and identifies catalog-specific new risks.

---

## 1. Existing security boundary (what we keep)

The engine owns truth, authority, identity, tenant/account scope, provider ownership, state, policy, execution, verification, UI state, and user-facing success claims. The LLM only proposes structured interpretations. No LLM output may directly: execute side effects, choose trusted IDs, override permissions/scope/readiness, claim mutation success, or expose internals.

**Defenses verified in the codebase**:

| Defense | Implementation | File:line | Verified |
|---|---|---|---|
| Recursive arg sanitization | `sanitizePlannerArgs` / `sanitizePlannerArgValue`; returns `Object.create(null)` to defeat prototype pollution | [chat-action-planner.ts:1215](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) | YES (read) |
| Forbidden model arg keys | `FORBIDDEN_MODEL_ARG_KEYS` covers `userid, uid, user, tenantid, tenant, accountid, account, owneruserid, ownerid, owner, proto, prototype, constructor, customerid, subjectid, principalid, memberid, actorid`; key match normalizes via `replace(/[^a-z0-9]/gi, '').toLowerCase()` so `user_id`, `userID`, `__proto__` all collapse | [chat-action-planner.ts:1194-1213](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) | YES (read) |
| Applied at parse boundary | `parseLlmPlannerJson` calls `sanitizePlannerArgs` BEFORE any step is constructed | [chat-action-planner.ts:1722](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) | YES (read) |
| Result sanitization | `sanitizeChatActionRunResult` strips provider payloads; only `status, verified, providerObjectId, source, resultType, replaySafe: true` reaches `result_json` | [chat-action-run-store.ts:265-298](../cortex-telegram-hub-bot/src/services/chat-action-run-store.ts) | YES (read) |
| Tool authorization | `authorizeChatToolCall` uses AsyncLocalStorage context; refuses on mismatched `userId`/`tenantId`; destructive + external_send require `confirmedDestructiveAction` | [chat-tool-authorization.ts:86-167](../cortex-telegram-hub-bot/src/services/chat-tool-authorization.ts) | YES (read) |
| User-facing text scrub | `sanitizeUserFacingChatText` | [chat-response-quality-gate.ts:112](../cortex-telegram-hub-bot/src/services/chat-response-quality-gate.ts) | Referenced |
| Debug leakage detection | `DEBUG_LEAKAGE_PATTERNS` — 28 regex patterns including `accountId`, `providerObjectId`, `tenantId=`, SQL fragments, `traceId`, `source_facts` | [chat-hybrid-metrics.ts:146-174](../cortex-telegram-hub-bot/src/services/chat-hybrid-metrics.ts) | YES (read) |
| Logger redaction | `LOGGER_REDACTION_PATHS` (145 paths) | [src/utils/logger.ts:182](../cortex-telegram-hub-bot/src/utils/logger.ts) | Referenced |
| Risk class TTL | R3=10min, R2=20min, else 60min | [chat-action-state.ts:522](../cortex-telegram-hub-bot/src/services/chat-action-state.ts) | YES (read) |
| Confirmation gate | `confirmation_state='required'` when `riskClass ∈ {R2, R3}` | [chat-action-state.ts:227](../cortex-telegram-hub-bot/src/services/chat-action-state.ts) | YES (read) |
| Read-back verification | `verified_pending` vs `verified_success` based on provider/local read-back | [chat-action-planner.ts:254, 290, 1416](../cortex-telegram-hub-bot/__tests__/services/chat-action-planner.test.ts) (tests) | YES (cross-test) |
| Action run claim atomicity | `claimChatActionRun`, `claimChatActionRunForExecution` (txn) | [chat-action-run-store.ts](../cortex-telegram-hub-bot/src/services/chat-action-run-store.ts) | YES (read) |
| Zombie reaper | bounded sweep | [chat-action-run-store.ts](../cortex-telegram-hub-bot/src/services/chat-action-run-store.ts) | YES (read) |
| Pending expiry sweep | bounded in batches of 500 | [chat-action-state.ts:473](../cortex-telegram-hub-bot/src/services/chat-action-state.ts) | YES (read) |
| REST handoff scoping | `ensureValidChatRouteScope(res, userId, tenantId, 'chat_pending_action_read')`; no-store headers; response strips userId/tenantId/accountId/action_hash | [chat-message-routes.ts:343-385](../cortex-telegram-hub-bot/src/api/routes/chat-message-routes.ts) | YES (read) |
| Slot provenance | Typed sources: `user_message | planner | classifier | reviewer | safe_default | provider_read_back | visible_card | pending_action` | [chat-action-state.ts:10-29](../cortex-telegram-hub-bot/src/services/chat-action-state.ts) | YES (read) |

---

## 2. OWASP LLM Top 10 mapping

Per [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — cell-by-cell mapping of risks to existing defenses and consolidation-specific implications.

### LLM01 — Prompt Injection

**Risk**: User-supplied text (or text inside attachments / provider data) contains embedded instructions that hijack the LLM into executing unintended actions.

**Existing defenses**:
- `sanitizeUserFacingChatText` ([chat-response-quality-gate.ts:112](../cortex-telegram-hub-bot/src/services/chat-response-quality-gate.ts)) scrubs user-facing output
- `DEBUG_LEAKAGE_PATTERNS` flags injection markers in responses
- Smoke fixtures pin injection cases (11 test sites including [content-agency.test.ts:184](../cortex-telegram-hub-bot/__tests__/services/content-agency.test.ts) `competitor_prompt_injection_blocked`)
- Architectural: per [NCSC's "Prompt Injection Is Not SQL Injection"](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection), the only reliable defense is architectural — keep the LLM out of the trust loop. Nexus Hub does this: `executor`/`verifier` are server-side dispatch keys; the LLM never executes anything directly.

**Catalog impact**:
- `examples[].text` may contain injection patterns (intentionally, tagged `prompt_injection`) for eval.
- These examples are USED in eval to verify the planner refuses; they MUST NOT be used in LLM context.

**Mitigation if new**:
- `buildLlmSafePromptSlice` excludes any example tagged `'prompt_injection'` or `'adversarial'` (schema_proposal.md §6.2).
- Lint rule on `examples[].text`: any text matching known injection markers (`ignore previous instructions`, `system:`, `<\|im_start\|>`, `<\|im_end\|>`, `\[INST\]`, `\\[/INST\\]`) MUST be tagged `prompt_injection` or `adversarial`; CI fails otherwise.

### LLM02 — Insecure Output Handling

**Risk**: LLM output passed directly to a downstream component (DB query, shell command, HTTP request) without validation.

**Existing defenses**:
- `sanitizeChatActionRunResult` ([chat-action-run-store.ts:265-298](../cortex-telegram-hub-bot/src/services/chat-action-run-store.ts)) strips provider payloads before DB writeback; only typed status fields persist.
- LLM-produced action args go through `sanitizePlannerArgs` (recursive sanitization) AND `FORBIDDEN_MODEL_ARG_KEYS` (identity-key normalization) BEFORE step construction at [chat-action-planner.ts:1722](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts).
- Executor dispatch is by string label looked up in a server-side map; LLM cannot inject arbitrary code.
- Response text is scrubbed (`sanitizeUserFacingChatText` + `DEBUG_LEAKAGE_PATTERNS`).

**Catalog impact**: None new — the catalog provides metadata about actions; it never provides executable code paths.

**Mitigation if new**: N/A.

### LLM03 — Training Data Poisoning

**Risk**: Adversarial training data influences model behavior.

**Existing defenses**: N/A — Nexus Hub uses pretrained Gemini/Anthropic/OpenAI models; no fine-tuning.

**Catalog impact**: None.

**Mitigation if new**: N/A.

### LLM04 — Model DoS

**Risk**: Adversarial input causes excessive resource consumption (long inferences, infinite loops).

**Existing defenses**:
- Tier 1 classifier: 1800ms timeout, max 450 tokens
- Tier 2/3 structured planner / reviewer: configured timeouts with provider fallback
- Per-skill `latencyBudgetMs` ([chat-skill-capability-registry.ts:6-18](../cortex-telegram-hub-bot/src/services/chat-skill-capability-registry.ts))
- Smoke gate: `p95LatencyMs ≤ 6000`
- AbortSignal forwarding for provider write/read-back

**Catalog impact**:
- `examples[]` array could grow unbounded if not capped. Risk: prompt size inflation.
- Few-shot retrieval reads `examples` — must be bounded.

**Mitigation if new**:
- Few-shot retrieval **hard cap** at 4 examples per skill subset (recommended in schema_proposal.md §6).
- `priority` field drives selection order; cap is on count, not size.
- Lint rule: `examples[].text.length ≤ 200` characters (long example texts inflate cost).

### LLM05 — Supply Chain

**Risk**: Compromised third-party dependencies (model APIs, libraries, plugins).

**Existing defenses**:
- Dependency lockfile (`package-lock.json`)
- Dependabot configured (per `4.14.160` security hardening)
- Dependency direction lint (codex-dep-direction-lint branch)
- Per-provider fallback (Gemini primary → OpenAI fallback) reduces single-provider compromise impact

**Catalog impact**: None — the catalog adds no new dependencies.

**Mitigation if new**: N/A.

### LLM06 — Sensitive Information Disclosure

**Risk**: LLM leaks data that shouldn't be in its context (PII, credentials, internal IDs).

**Existing defenses**:
- `LOGGER_REDACTION_PATHS` (145 paths)
- `audit_trail` GDPR-exempt classification
- `sanitizeChatActionRunResult` strips identity fields before DB writeback
- REST handoff at `chat-message-routes.ts:343-385` strips `userId`, `tenantId`, `accountId`, `action_hash` from response

**Catalog impact**:
- `examples[].text` could contain real user PII if authors copy-paste real chat messages.
- `examples[].expectedSlots` could contain real provider IDs or internal IDs.

**Mitigation if new**:
- Lint rule on `examples[].text`: blocks email patterns (`[\w.-]+@[\w.-]+\.[a-z]{2,}`) and phone patterns (`\+?[\d\s().-]{7,}`) UNLESS the example is a documented placeholder (e.g., `placeholder@nexushub.test`, `user@example.com`).
- Lint rule on `examples[].expectedSlots`: blocks any key matching `FORBIDDEN_MODEL_ARG_KEYS` or value matching real ID patterns (UUIDs, base64 SHAs, etc.).
- Code review checklist: example authoring must use placeholder data, never real chat content.

### LLM07 — Insecure Plugin Design

**Risk**: Plugins or tool calls without sufficient access control, allowing the LLM to invoke actions it shouldn't.

**Existing defenses**:
- `authorizeChatToolCall` checks AsyncLocalStorage context; refuses on `userId`/`tenantId` mismatch
- Tool array filtered per domain by `skill-manager.ts getToolsForDomain`
- `FORBIDDEN_MODEL_ARG_KEYS` blocks LLM-supplied trusted IDs
- `executor` is server-side dispatch key, never reaches LLM

**Catalog impact**: Strengthens — `risk` and `confirmationPolicy` make every action's classification explicit at the catalog layer.

**Mitigation if new**:
- New action without proper `risk` classification could bypass confirmation. Mitigation: TypeScript requires `risk` and `confirmationPolicy` on every entry; `status: 'experimental'` gates new actions; `selectRegistrySubsetForMessage` filters `status === 'active'`.
- Test: `chat-action-registry-completeness.test.ts` asserts no `status: 'active'` entry has `risk: 'ambiguous'` (ambiguous is blocked from execution).

### LLM08 — Excessive Agency

**Risk**: LLM granted excessive authority to take actions without sufficient oversight.

**Existing defenses**:
- Risk classes R0-R4 with TTL
- Confirmation required for R2/R3 ([chat-action-state.ts:227](../cortex-telegram-hub-bot/src/services/chat-action-state.ts))
- Read-back required for mutations
- Atomic action-run claim ([chat-action-run-store.ts](../cortex-telegram-hub-bot/src/services/chat-action-run-store.ts))
- Pending-action expiry sweep
- Zombie reaper

**Catalog impact**: Strengthens — `examples` make per-action risk explicit; `confirmationPolicy` is reified per action.

**Mitigation if new**:
- `status: 'experimental'` MUST gate new actions until shadow telemetry proves safety. Recommended: 30 days in shadow before promotion to `active`.
- Failing safe: `selectRegistrySubsetForMessage` returns ONLY `status === 'active'` entries. A deprecated or experimental entry can be in the registry but is NOT routable.

### LLM09 — Overreliance

**Risk**: System or user over-trusts LLM output without verification.

**Existing defenses**:
- Calibrated score thresholds (`tier1_classifier` score must exceed 0.72)
- False-success gate (`falseSuccessWithoutReadBackCount === 0`)
- Debug-leakage gate (`debugInternalLeakageCount === 0`)
- `verified_pending` vs `verified_success` taxonomy enforces read-back before success claim

**Catalog impact**: Strengthens — fixture generation increases coverage of overreliance edges.

**Mitigation if new**:
- Generator (Phase 2) produces provider-mismatch cases for every mutation action; ensures the engine never claims `verified_success` without read-back.
- Per [OpenAI Evals](https://developers.openai.com/api/docs/guides/evals): continuous regression tracking is essential. Nightly suite + production telemetry feedback (Phase 4) close the loop.

### LLM10 — Model Theft

**Risk**: Adversary exfiltrates proprietary model weights or fine-tunes.

**Existing defenses**: N/A — Nexus Hub uses provider-hosted models.

**Catalog impact**: None.

**Mitigation if new**: N/A.

---

## 3. NCSC architecture argument

Per [NCSC's "Prompt Injection Is Not SQL Injection"](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection): "There is no equivalent of a parameterised query for a Large Language Model. Therefore, you must assume that any LLM model that takes user input will treat that input as instructions to be followed."

The implication for Nexus Hub:
1. **The LLM cannot be hardened against prompt injection by prompt wording alone.** Defense must be architectural: keep the LLM out of execution paths.
2. **The catalog must respect this boundary.** `executor` and `verifier` are server-side; the catalog provides the LABEL but the IMPLEMENTATION is in code; the LLM sees a sanitized view via `buildLlmSafePromptSlice` (schema_proposal.md §6).
3. **The trust gradient**:
   - LLM proposes (untrusted)
   - Planner sanitizes (`sanitizePlannerArgs`)
   - Schema validates (`requiredFields`, `slotValidators`)
   - Authorization gates (`authorizeChatToolCall`)
   - Executor runs (server-side code)
   - Verifier confirms (provider/local read-back)
   - Telemetry records (sanitized result)
   - UI renders (typed cards, no raw output)

The catalog consolidation **must NOT collapse this gradient.** Every layer's defense is independent; the catalog only strengthens (or at worst preserves) the boundary.

---

## 4. NIST AI RMF alignment

Per [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework):

**Govern** — Action Registry Consolidation v2 has:
- Explicit `owner` field per action
- Explicit `version`, `status` for deprecation lifecycle
- Code review + CI typecheck + lint = governance gates
- Audit log via `audit_trail` table

**Map** — Audit doc (§3, §4) maps the chat-action surface end-to-end. Telemetry feedback (Phase 4) maps production behavior to expected.

**Measure** — Eval plan (§4) maps 13 existing gated metrics + 10 new consolidation metrics. Smoke + nightly + production telemetry triangulate.

**Manage** — Feature flags per action (Phase 5); per-action shadow → active promotion; rollback per flag. Per-action rollback within 1 minute. No automatic registry mutation from telemetry.

All four NIST AI RMF functions have explicit implementation paths in the consolidation plan.

---

## 5. Catalog-specific new risks (and mitigations)

### 5.1 Example injection vector (NEW RISK)

**Description**: Malicious example text shipped via PR could include instructions that, if the example is later inlined to LLM context, hijack the model.

**Likelihood**: Medium (requires PR review failure)
**Impact**: High (could bypass injection defenses if reached LLM)
**Mitigation**:
- Lint rule on `examples[].text` (already specified in §2 LLM01 above)
- `buildLlmSafePromptSlice` excludes `prompt_injection`/`adversarial`-tagged examples from LLM context
- Code review checklist explicitly calls out example security review

### 5.2 Registry confused-deputy on new action (NEW RISK)

**Description**: A new `ChatActionDefinition` could be added with incorrect risk classification, bypassing confirmation.

**Likelihood**: Low (TypeScript requires `risk` field)
**Impact**: High (could enable destructive actions without confirmation)
**Mitigation**:
- Required `risk` and `confirmationPolicy` (TypeScript)
- `status: 'experimental'` for new actions; gates routing
- `selectRegistrySubsetForMessage` filters `status === 'active'`
- Test: `chat-action-registry-completeness.test.ts` asserts no active entry has `risk: 'ambiguous'`

### 5.3 Stale entry execution (NEW RISK)

**Description**: A deprecated `ChatActionDefinition` could still be picked by the planner if not filtered.

**Likelihood**: Low
**Impact**: Medium (executes obsolete action with potentially outdated executor)
**Mitigation**:
- `selectRegistrySubsetForMessage` filters `status === 'active'`
- Tests assert `deprecated` entries don't reach planner

### 5.4 Example data leakage (NEW RISK)

**Description**: `examples[].text` could contain real user PII (email, phone, name) if authors copy-paste real chat content.

**Likelihood**: Medium (engineers might use real data while debugging)
**Impact**: Medium (data privacy / GDPR)
**Mitigation**:
- Lint rule blocks email/phone patterns in `examples[].text`
- Lint rule blocks any value in `expectedSlots` matching `FORBIDDEN_MODEL_ARG_KEYS`
- Pre-commit hook runs lint

### 5.5 executor/verifier leakage to LLM (NEW RISK — CRITICAL)

**Description**: A future LLM prompt builder could accidentally include `executor` strings (`'task_store.createTask'`, `'unified_calendar.deleteEvent'`) or `verifier` strings in the context window. The LLM would then have visibility into the dispatch keys it should never see.

**Likelihood**: Medium (refactor accident)
**Impact**: HIGH (LLM learns internal action names → could produce more confident injections)
**Mitigation**:
- **MANDATORY**: All LLM prompt builders MUST route through `buildLlmSafePromptSlice` (schema_proposal.md §6). No raw `ChatActionDefinition` reaches LLM context.
- Test: `__tests__/services/chat-action-prompt-safety.test.ts` (Phase 3) asserts `executor`, `verifier`, internal IDs are NEVER in `buildLlmSafePromptSlice` output.
- Lint rule: any new function that takes `ChatActionDefinition` and produces an LLM prompt MUST use `buildLlmSafePromptSlice` (manual code review enforcement for now; static analysis if practical).

### 5.6 Few-shot retrieval poisoning via `priority` (NEW RISK)

**Description**: An attacker (or careless engineer) could set `priority: 100` on a malicious example, forcing it into LLM context.

**Likelihood**: Low (code review + lint should catch)
**Impact**: Medium (LLM behavior change)
**Mitigation**:
- `priority` is a normal integer; lint warns on values outside 0-100
- Examples tagged `prompt_injection`/`adversarial` are excluded regardless of priority
- Code review checklist: priority changes require justification

### 5.7 Tuple-to-full-literal promotion error (Phase 0 RISK)

**Description**: When converting tuple-shorthand registry entries to full `ChatActionDefinition` literals, a copy-paste error could change `risk` or `confirmationPolicy`, weakening confirmation gates.

**Likelihood**: Medium (35 conversions)
**Impact**: HIGH (could allow destructive action without confirmation)
**Mitigation**:
- Paired smoke test PER conversion: assert `riskClassForRisk(getChatActionRegistry().find(a => a.action === X)?.risk) === expectedRiskClass`
- One PR per skill (incremental); each PR includes the paired tests for its conversions

### 5.8 Manifest deletion side effect (Phase 0 RISK)

**Description**: Deleting `manifest.json` files could break a portal or test that reads them.

**Likelihood**: Low (no live consumers identified in audit)
**Impact**: Low (build-time failure, not security)
**Mitigation**:
- `rg -n "manifest.json|skills/.*/manifest" src/` before deletion; verify no runtime imports
- Staging deploy + smoke before each manifest deletion

### 5.9 Capability registry merge regression (Phase 0 RISK)

**Description**: Merging `chat-skill-capability-registry.ts CAPABILITIES` into `ChatActionRegistry` could lose fields like `responseCardType`, `latencyBudgetMs`, `privacyPolicy`, `fallbackPolicy`.

**Likelihood**: Medium (10 capability entries × 4 fields × 45 actions)
**Impact**: Low (UI fields, not security; latency budget is informational)
**Mitigation**:
- Field-by-field migration with `@deprecated` aliasing for one release
- Per-skill migration test asserts the merged registry preserves all capability fields

---

## 6. Security tests required

Per implementation plan Phase 0, Phase 1, Phase 3:

| Test | When | Path | Purpose |
|---|---|---|---|
| `chat-action-registry-completeness.test.ts` | Phase 0 | `__tests__/services/` | Every entry has `version`, `status`, `owner`; no tuple shorthand; no `status: 'active' && risk: 'ambiguous'` |
| `chat-action-prompt-safety.test.ts` | Phase 3 | `__tests__/services/` | `buildLlmSafePromptSlice` excludes `executor`, `verifier`, internal IDs; no `prompt_injection`/`adversarial` examples |
| `registry-fixture-builder.test.ts` | Phase 2 | `__tests__/lib/` | Generator parity, category coverage per action |
| Existing smoke corpus (180 cases) | continuous | `__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts` | All `CHAT_HYBRID_ACTION_GATE_THRESHOLDS` met |
| Pending REST handoff scope | continuous | `__tests__/api/chat-routes.test.ts` | Cross-tenant request returns 403/404; identity stripped from response |
| Lint script | continuous | `scripts/lint-registry.mjs` + `__tests__/scripts/lint-registry.test.ts` | No PII in examples; no injection markers without tag; no forbidden keys |
| Provider mismatch coverage | Phase 2 | derived in smoke corpus | Every mutation action has a provider-mismatch case |
| Wrong-entity coverage | Phase 1 | derived in smoke corpus | Every follow-up action has an ambiguous-recent-entity case |

---

## 7. Privacy / data protection

**GDPR alignment**: `audit_trail` is GDPR-exempt (operational log); `chat_action_telemetry` stores normalized labels (route_tier, skill, action, calibrated_score) NOT user content. Phase 4 telemetry report MUST anonymize phrases.

**PII handling in examples**: `examples[].text` is shipped in code. It MUST use placeholder data (e.g., `user@example.com`, `placeholder@nexushub.test`). Lint rule blocks real PII patterns (see §5.4).

**Cross-tenant**: every catalog field is global; per-tenant customization is NOT supported. If enterprise customers ever require per-tenant intents, that's Option F (DB-managed) and requires a new tenant-isolation review.

---

## 8. UI leakage prevention

Required by approved plan's behavior case #10. Existing gate: `DEBUG_LEAKAGE_PATTERNS` regex + `debugInternalLeakageCount === 0`. Catalog extension:

- Every action's golden fixture also asserts response text does NOT contain `accountId`, `providerObjectId`, internal IDs, SQL fragments, `Resposta estruturada`, prompt artifacts, raw JSON, stack traces.
- `chat-response-quality-gate.ts sanitizeUserFacingChatText` is the final gate before response leaves the engine.

---

## 9. High-risk action confirmation

Today's flow:
1. Planner emits step with `risk` field
2. `chat-action-state.ts:227` sets `confirmation_state='required'` when `riskClass ∈ {R2, R3}`
3. iOS or chat shows "Confirm: X?" card
4. User confirms via REST endpoint
5. Executor runs only after confirmed

Catalog impact: Strengthens — every action's `risk` and `confirmationPolicy` are explicit and version-locked. The catalog version field provides a graceful deprecation path: bumping `version` and setting `status: 'deprecated'` lets old pending actions complete but no new ones are created.

---

## 10. Read-back verification

Today's enforcement:
- `verified_pending` vs `verified_success` is set based on read-back result
- Tests: [chat-action-planner.test.ts:254, 290, 1416](../cortex-telegram-hub-bot/__tests__/services/chat-action-planner.test.ts) (and many others)
- Late-write reconciliation handled by zombie reaper

Catalog impact: Strengthens — every mutation action's `verifier` field is explicit; `verificationPolicy` makes the read-back requirement reified.

Phase 2 generator MUST produce provider-mismatch cases for every action with `verifier ∈ {provider_read_back, local_read_back}`.

---

## 11. Cross-tenant / cross-account safety

Today's enforcement:
- AsyncLocalStorage `RequestContext` carries `userId, tenantId, accountId`
- `authorizeChatToolCall` validates context vs claimed scope
- `cancelPendingChatActionsForAccountSwitch` cancels pending actions on account switch
- REST handoff is `WHERE user_id = ? AND tenant_id = ?` scoped

Catalog impact: None new — the catalog is global; per-tenant rules are NOT in scope.

If enterprise multi-tenancy adds per-tenant intent customization, that's a separate design (Option F in decision matrix).

---

## 12. Security review summary

| Risk class | Existing defense quality | Catalog impact | Required new test |
|---|---|---|---|
| LLM01 Prompt Injection | STRONG | Example tagging + LLM-safe slice | Lint + prompt-safety test |
| LLM02 Insecure Output Handling | STRONG | None | None new |
| LLM03 Training Data Poisoning | N/A | N/A | None |
| LLM04 Model DoS | STRONG | Few-shot cap | Cost regression test |
| LLM05 Supply Chain | STRONG | None | None new |
| LLM06 Sensitive Info Disclosure | STRONG | Lint on examples PII | Lint script test |
| LLM07 Insecure Plugin Design | STRONG | Status gating new actions | Completeness test |
| LLM08 Excessive Agency | STRONG | Strengthens (status experimental) | None new |
| LLM09 Overreliance | STRONG | Strengthens (provider-mismatch coverage) | Generator parity test |
| LLM10 Model Theft | N/A | N/A | None |

**Verdict**: Catalog consolidation is **net positive for security**. New risks are mitigated by lint + tests; existing defenses are preserved or strengthened.

---

## 13. Recommended pre-commit security gates (catalog-specific)

To be added in Phase 0:

```bash
# scripts/pre-commit-registry-security.sh

set -euo pipefail

# 1. Lint registry
node scripts/lint-registry.mjs --strict

# 2. Run completeness test
npx vitest run __tests__/services/chat-action-registry-completeness.test.ts

# 3. Run prompt-safety test (after Phase 3 ships buildLlmSafePromptSlice)
if [ -f __tests__/services/chat-action-prompt-safety.test.ts ]; then
  npx vitest run __tests__/services/chat-action-prompt-safety.test.ts
fi

# 4. PII scan in examples
node scripts/scan-examples-pii.mjs

# 5. Forbidden-key scan in expectedSlots
node scripts/scan-examples-forbidden-keys.mjs
```

Existing pre-commit hook (per CLAUDE.md):
- `npx tsc --noEmit`
- `npx vitest run`
- `detect-secrets`

The catalog gates extend this without replacing.

---

## 14. References

External:
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [OWASP LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [NCSC Prompt Injection Is Not SQL Injection](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)

Internal:
- [src/services/chat-action-planner.ts:1194-1232](../cortex-telegram-hub-bot/src/services/chat-action-planner.ts) — `FORBIDDEN_MODEL_ARG_KEYS` + `sanitizePlannerArgs`
- [src/services/chat-action-run-store.ts:265-298](../cortex-telegram-hub-bot/src/services/chat-action-run-store.ts) — `sanitizeChatActionRunResult`
- [src/services/chat-tool-authorization.ts:86-167](../cortex-telegram-hub-bot/src/services/chat-tool-authorization.ts) — `authorizeChatToolCall`
- [src/services/chat-hybrid-metrics.ts:146-174](../cortex-telegram-hub-bot/src/services/chat-hybrid-metrics.ts) — `DEBUG_LEAKAGE_PATTERNS`
- [src/services/chat-action-state.ts:227](../cortex-telegram-hub-bot/src/services/chat-action-state.ts) — confirmation gate
- [src/services/chat-action-state.ts:522](../cortex-telegram-hub-bot/src/services/chat-action-state.ts) — risk class TTL
- [src/api/routes/chat-message-routes.ts:343-385](../cortex-telegram-hub-bot/src/api/routes/chat-message-routes.ts) — REST handoff scoping
- [src/services/chat-evaluation-harness.ts:455-471](../cortex-telegram-hub-bot/src/services/chat-evaluation-harness.ts) — gate thresholds

---

## Cross-references

- Architecture audit: [`skill_interaction_catalog_architecture_audit.md`](skill_interaction_catalog_architecture_audit.md)
- Decision matrix: [`skill_interaction_catalog_decision_matrix.md`](skill_interaction_catalog_decision_matrix.md)
- Implementation plan: [`skill_interaction_catalog_implementation_plan.md`](skill_interaction_catalog_implementation_plan.md)
- Schema proposal: [`skill_interaction_catalog_schema_proposal.md`](skill_interaction_catalog_schema_proposal.md)
- Eval plan: [`skill_interaction_catalog_eval_plan.md`](skill_interaction_catalog_eval_plan.md)
- Independent QA prompt: [`claude_code_qa_prompt_for_catalog_plan.md`](claude_code_qa_prompt_for_catalog_plan.md)
