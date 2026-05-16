# Independent QA Prompt — Skill Interaction Catalog / Action Registry Consolidation v2

Status: QA prompt for independent reviewer
Owner: Felipe (release lead)
Date: 2026-05-15
Purpose: Hand this prompt to a fresh Claude Code (or Codex) instance for independent review of the architecture decision package.

---

## 0. Reviewer instructions (read first)

You are an independent reviewer. The package you are reviewing was produced by a multi-role audit (Principal Software Architect / Staff Backend Engineer / LLM Systems Engineer / Security Engineer / QA-Eval Lead / Product Architecture Advisor). Your job is to verify the package's claims, challenge its recommendations, and emit a clear verdict.

**Do NOT trust the package's findings without checking them.** Verify file paths, line numbers, function signatures, and test claims against the actual codebase. If you find a discrepancy, note it; if you find an error, escalate it.

You are NOT implementing anything. This is a planning review.

---

## 1. Repositories under review

Verify these paths exist and are git repositories where claimed:

- **Backend**: `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` — should be a git repo on `main` at production `4.14.164`
- **iOS Xcode project**: `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub` — should be a git repo on `main` at HEAD `835a985`
- **iOS workspace dir** (parent of Xcode project): `/Users/felipedominguez/Desktop/Nexus Hub IOS` — should NOT be a git repo; `specs/` lives here filesystem-only
- **Workspace docs root** (where the 7 docs you're reviewing live): `/Users/felipedominguez/Desktop/Nexus Hub` — should NOT be a git repo; `docs/` is a subdirectory

If any of these is wrong, escalate and stop.

---

## 2. Documents to review

Seven docs under `/Users/felipedominguez/Desktop/Nexus Hub/docs/`:

1. `skill_interaction_catalog_architecture_audit.md`
2. `skill_interaction_catalog_decision_matrix.md`
3. `skill_interaction_catalog_implementation_plan.md`
4. `skill_interaction_catalog_schema_proposal.md`
5. `skill_interaction_catalog_eval_plan.md`
6. `skill_interaction_catalog_security_review.md`
7. `claude_code_qa_prompt_for_catalog_plan.md` (this file — meta-review)

Read all seven. Pay special attention to the architecture audit's §10 (command-like task title — current-code conflict confirmed; product policy resolved 2026-05-15 as literal-title; implementation must update planner and 4 tests/fixtures) — that section captures the load-bearing claim and the resulting implementation work.

---

## 3. Recommended methodology

Run in this order:

### Step 3.1 — Verify roots

```bash
ls -la "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot" && git rev-parse --show-toplevel && git log --oneline -5
ls -la "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub"
cd "/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub" && git rev-parse --show-toplevel && git log --oneline -5
ls -la "/Users/felipedominguez/Desktop/Nexus Hub/docs/"
```

Expected: backend HEAD ~`f1247c8c` or later; iOS HEAD `835a985` or later; 7 doc files present.

### Step 3.2 — Verify the existing schema claim

Open `src/services/chat-action-registry.ts:85-105`. Confirm `ChatActionDefinition` interface declares (verbatim):

- `skill: ChatActionSkill`
- `action: ChatActionName`
- `version?: string`
- `readableIntents: string[]`
- `requiredFields: string[]`
- `optionalFields: string[]`
- `slotExtractors?: string[]`
- `slotValidators?: string[]`
- `providerDependencies: ChatProvider[]`
- `risk: ChatActionRisk`
- `riskClass?: ChatActionRiskClass`
- `confirmationPolicy: 'none' | 'clarify' | 'confirm' | 'strong_confirm'`
- `executionPolicy?: 'read_only' | 'idempotent_write' | 'preview_then_confirm' | 'blocked'`
- `executor: string`
- `verifier: 'provider_read_back' | 'local_read_back' | 'none'`
- `verificationPolicy?: 'provider_readback_required' | 'local_readback_required' | 'not_required'`
- `uiSurfaces?: string[]`
- `examples?: Array<{ text: string; expectedSlots?: Record<string, unknown> }>`
- `supportedCards: string[]`

If the interface differs materially, the audit's "schema already exists" claim is weakened.

### Step 3.3 — Verify the tuple-shorthand claim

Open `src/services/chat-action-registry.ts:262-310`. Confirm this is a `...([...] as const).map((...) => ({...}))` spread that converts tuples to definitions. Count the tuples: should be 35.

### Step 3.4 — Verify the `examples` population claim

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
grep -c "examples:" src/services/chat-action-registry.ts
```

Should be small (~1-2). Confirm only `schedule_event` (line 138) has a populated `examples` array.

### Step 3.5 — Verify the phrase scatter claim

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
rg -n "\b(task|todo|tarefa|subtarefa|checklist|lembrete|reminder)\b" src/
```

You should see hits in at least: `skill-config.ts`, `chat-action-registry.ts`, `chat-action-planner.ts`, `chat-skill-capability-registry.ts`, `domain-handler.ts`, `secretary-fastpath.ts`, `chat-message-local-responses.ts`. The audit claims 7+ files scatter; verify.

### Step 3.6 — Verify the command-like title policy state (was BLOCKER; RESOLVED 2026-05-15)

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
rg -n "delete all my tasks|apagar todas|REFUSAL_FIXTURES" __tests__/ src/
```

Expected hits (these encode the ORIGINAL refusal behavior; per audit §10 these tests need migration during implementation):
- `__tests__/services/chat-action-planner.test.ts:466` — `text: 'Create a task called delete all my tasks'`
- `__tests__/services/chat-action-planner.test.ts:476` — `expect(plan?.steps[0]?.args).toMatchObject({ title: null, rejectedTitle: 'delete all my tasks' })`
- `__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts:195` — `REFUSAL_FIXTURES`
- `__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts:908` — refusal guard

**The policy was resolved on 2026-05-15.** Felipe approved the literal-title policy: destructive language inside a trusted title span (after `called`/`chamada`/`titulo:`/`named`/quoted-string) is treated as user-provided content; outside the title span it remains subject to standard destructive-action policy; ambiguous cases ask a clarification. The existing test/fixture sites above are marked as "needing update during implementation" — verify the audit doc §10 reflects this approved policy and that the implementation plan / schema proposal / eval plan have been updated accordingly. If the tests still show the refusal behavior, that's expected — they are migrated as part of the Phase 0/1 implementation PRs, NOT in the audit itself.

### Step 3.7 — Verify the security defenses

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
rg -n "FORBIDDEN_MODEL_ARG_KEYS|sanitizePlannerArgs|authorizeChatToolCall|sanitizeChatActionRunResult|DEBUG_LEAKAGE_PATTERNS" src/
```

Expected: each symbol exists in the claimed file at the claimed approximate line.

### Step 3.8 — Verify the smoke corpus pin

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
rg -n "toHaveLength\(180\)" __tests__/
```

Expected: `__tests__/services/chat-hybrid-action-smoke-fixtures.test.ts:597`.

### Step 3.9 — Verify the gate thresholds

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
rg -n "macroActionPrecision|wrongEntityRate|criticalRiskFalseExecutionCount" src/services/chat-evaluation-harness.ts
```

Expected: thresholds at lines 455-471 with values `>= 0.98`, `<= 0.005`, `=== 0` respectively.

### Step 3.10 — Optionally run validation commands

If practical and safe:

```bash
cd "/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot"
npm run typecheck  # should pass cleanly
# Skip full test run unless you have time; the codebase is at production 4.14.164
```

Workspace docs audit:

```bash
cd "/Users/felipedominguez/Desktop/Nexus Hub/engine"
npm run docs:audit -- --json 2>&1 | head -50
# Look for new workspace-mirror-stale findings (should be 0)
```

---

## 4. Specific claims to verify (checklist)

### 4.1 Audit doc

- [ ] The `ChatActionDefinition` interface at `chat-action-registry.ts:85-105` declares the fields listed in audit §6 row "Action registry has `ChatActionDefinition`".
- [ ] 35 of 45 actions use tuple shorthand at `chat-action-registry.ts:262-310`.
- [ ] Only `schedule_event` (line 138) has populated `examples`.
- [ ] Phrase regexes for "task" are scattered across at least 7 files (`skill-config.ts`, `chat-action-registry.ts`, `chat-action-planner.ts`, `chat-skill-capability-registry.ts`, `domain-handler.ts`, `secretary-fastpath.ts`, `chat-message-local-responses.ts`).
- [ ] Three orphan skills (`connections`, `notifications`, `decision_center`) are NOT in `DEFAULT_SKILLS` but ARE in `ChatActionSkill` type.
- [ ] `chat-pending-confirmations.ts` exists and is 76 lines.
- [ ] 5 `manifest.json` files exist under `src/skills/{secretary,triathlon,content,cooking,finance}/`.
- [ ] `riskClassForRisk` is duplicated (one in registry.ts, one in planner.ts).
- [ ] `retrievePlannerExamples` at `chat-action-planner.ts:4303` is hand-coded with ~3 examples capped at 6.
- [ ] **Policy resolution verified**: audit §10 documents Felipe's 2026-05-15 approval of the literal-title policy. Verify the audit doc reflects the approved policy AND that the existing tests at `chat-action-planner.test.ts:466-485` and `chat-hybrid-action-smoke-fixtures.test.ts:195/198/216/908` are explicitly listed as "tests needing update during implementation" (NOT pre-blockers).
- [ ] All security defenses in §9 of the audit are present and verifiable.
- [ ] iOS findings marked NOT VERIFIED (no iOS code change in this audit) is honest given audit scope.

### 4.2 Decision matrix doc

- [ ] 8 options (A-H) scored on 15 dimensions.
- [ ] Option G recommended; Option A as Phase 0; Option C as cheapest first slice; Option D as fallback.
- [ ] Rejection rationale for B, E, F documented with reasoning (not just "rejected").
- [ ] Option G score (70) is the highest. Reproduce the math by summing the column for G.
- [ ] Conditions for future Option F reconsideration (§5) are documented.

### 4.3 Implementation plan doc

- [ ] Phase 0 → 1 → 2 → 3 → 4 → 5 sequence is coherent.
- [ ] Phase 0 prerequisite work is described (planner split, registry merge, manifest deletion, etc.).
- [ ] Phase 1 MVP scope = 5 actions (Tasks: create_task + complete_task; Calendar: schedule_event + summarize_agenda; Training: training_plan_create + pending-continuation).
- [ ] Each phase has goals, files, contracts, tests, validation commands, risks, success criteria, rollback.
- [ ] DELETE candidates have explicit verification gates.
- [ ] The "what we should refuse to build now" list (10 items) is sensible.

### 4.4 Schema proposal doc

- [ ] Schema is documented as **extension** of existing `ChatActionDefinition`, NOT a new artifact.
- [ ] No YAML, no JSON, no DB. TypeScript object literals colocated per-skill.
- [ ] `buildLlmSafePromptSlice(entry: ChatActionDefinition): LlmSafeActionView` helper is specified with explicit exclusion list (`executor`, `verifier`, internal IDs, etc.).
- [ ] Three worked examples present (Tasks create_task, Calendar schedule_event, Training training_plan_create).
- [ ] §8 ("What must NOT be in metadata") and §9 ("What must remain code") are clear and don't overlap.

### 4.5 Eval plan doc

- [ ] Existing gate thresholds preserved (macroActionPrecision ≥ 0.98, etc.).
- [ ] Per-action minimum case categories defined (golden + ambiguous + negative + prompt_injection).
- [ ] Shadow/parity rollout described before flipping to registry-primary.
- [ ] PT coverage discussed.
- [ ] Provider mismatch and wrong-entity coverage extension described.

### 4.6 Security review doc

- [ ] OWASP LLM Top 10 cell-by-cell mapping done.
- [ ] NCSC prompt-injection architecture argument present.
- [ ] NIST AI RMF alignment present (Govern, Map, Measure, Manage).
- [ ] Catalog-specific new risks (example injection, confused-deputy, stale entry, data leakage, executor leakage, priority poisoning, tuple promotion, manifest deletion, capability merge) all have mitigations.
- [ ] Verdict: catalog consolidation is "net positive for security." Is this defensible? Stress-test it.

### 4.7 QA prompt doc

- [ ] This file is self-contained.
- [ ] Verdict rubric is clear.

---

## 5. Verdict rubric

Emit ONE verdict at the end of your review:

| Verdict | Meaning |
|---|---|
| **PASS** | All claims verified; recommendation is sound; no required changes. |
| **PASS WITH MINOR ISSUES** | Most claims verified; minor inaccuracies or omissions but the recommendation stands. Document the minor issues. |
| **PARTIAL** | Some major claims verified, some not. Recommendation might be sound but needs targeted re-work. List the gaps. |
| **FAIL** | Major factual errors OR the recommendation is unsafe / incorrect. Block proceeding. |
| **NOT VERIFIED** | You could not verify enough claims (e.g., repo unavailable, time-constrained). Explain what couldn't be verified. |

---

## 6. Required sections in your QA response

Your output MUST include:

1. **Scope** — what you reviewed, what you didn't, why
2. **Methodology** — commands run, files read, time spent
3. **Findings table** — column structure: `Claim | Verified? | Evidence | Severity if false`
4. **Missed findings** — anything the audit missed that you found (e.g., another scattered phrase file)
5. **Recommendation parity** — do you agree with "Option G — Action Registry Consolidation v2"? If not, what's the alternative?
6. **Overfit check** — did the audit overfit to the CEO's original idea? Did it sufficiently challenge?
7. **Unnecessary complexity check** — does the plan add abstraction that isn't immediately used?
8. **Existing-architecture preservation** — does the plan break Token-Zero? Does it preserve sanitization, authorization, read-back verification?
9. **Reliability/safety/tests/maintainability improvement check** — net positive or negative?
10. **Delete-candidate safety** — are the DELETE CANDIDATE verification gates sufficient?
11. **executor/verifier leakage risk** — could the `buildLlmSafePromptSlice` helper accidentally leak forbidden fields?
12. **Eval realism** — is the generated-fixture strategy actually buildable with the existing infrastructure?
13. **Verdict** — one of PASS / PASS WITH MINOR ISSUES / PARTIAL / FAIL / NOT VERIFIED
14. **Required follow-ups before implementation** — if not PASS, what must happen before Phase 0 can start?

---

## 7. Specific challenges to test the recommendation

Stress-test these claims:

### Challenge 7.1 — "Net code likely shrinks"

The audit (§17) and decision matrix (§9) both claim consolidation likely reduces net code. Quantify:
- Lines added by Phase 0 (~7 new per-skill `actions.ts` files + `slot-extractors.ts` files + `buildLlmSafePromptSlice` helper + completeness test): estimate
- Lines removed (deleted manifest.json files, deleted `chat-pending-confirmations.ts`, extracted parsers leaving planner shorter, deleted parallel `chat-skill-capability-registry.ts`, deduplicated `riskClassForRisk`): estimate
- Is the claim defensible? Within ±20%, is the net delta negative?

### Challenge 7.2 — Migration risk for `chat-pending-confirmations.ts`

The audit marks this as DELETE CANDIDATE. Verify:
- All callers of `getPendingConfirmation` / `setPendingConfirmation` (or equivalent) — list them
- Can the DB-backed `chat_pending_actions` table preserve their semantics (TTL, account-switch cancellation, lookup by user+tenant+conversation)?
- If a caller uses in-memory for performance reasons (sub-ms read), is DB-backed performance acceptable?

### Challenge 7.3 — Tuple-shorthand promotion safety

The audit (§5 BLOCKER, §8.5) flags this. Verify:
- Pick 3 random tuple entries from `chat-action-registry.ts:262-310`. Manually convert them to full literals. Did you preserve `risk` and `confirmationPolicy`?
- Does the conversion change `executor` dispatch in any way?
- Is the proposed "paired smoke test per conversion" actually feasible at scale (35 entries × paired tests)?

### Challenge 7.4 — `buildLlmSafePromptSlice` completeness

Open the schema proposal §6. The exclusion list has ~18 fields. Verify:
- Is the exclusion list complete? Are there any other fields that could leak internals?
- The function signature returns `LlmSafeActionView` with `description: string` — derived how? The audit says "derived from action name + intent" — is that safe (no internal IDs in the derivation)?
- The `riskLabel` mapping (`safe`/`sensitive`/`destructive`) collapses R0-R4 to 3 labels. Is this collapse safe, or does it lose information the LLM needs?

### Challenge 7.5 — Eval generator feasibility

The eval plan §2 specifies the generator interface. Verify:
- Is `PlannerFixture` shape compatible with what the generator would emit?
- The `requiresPendingActionId` flag implies the generator builds prior pending state — how exactly? The plan doesn't fully specify the seeding mechanism. Is this a gap?

### Challenge 7.6 — Phase 0 estimate

The plan estimates Phase 0 at 1-2 weeks (calendar; 5-8 engineering days). Stress-test:
- Planner split (4336 lines → ≤ 2000) PR-by-PR for 10+ skills — is 5-8 days realistic?
- 35 tuple promotions with paired tests — is the audit underestimating?
- Manifest deletion + caller migration — is the verification gate realistic?

### Challenge 7.7 — Command-like-title policy implementation (was BLOCKER; RESOLVED 2026-05-15)

The audit §10 originally flagged this as a BLOCKER; Felipe resolved it by approving the literal-title policy. Stress-test the approved policy and its implementation path:
- The approved policy distinguishes "destructive verb inside trusted title span" (literal title, create task) from "bare destructive intent" (standard destructive-action policy: confirm/block) from "ambiguous" (clarification). Is the title-span detection actually implementable using `called`/`chamada`/`titulo:`/`named`/quoted-string syntactic markers, or are there natural-language edge cases where the markers don't apply?
- Does the test-migration plan (audit §10.2: chat-action-planner.test.ts:466-485 + chat-hybrid-action-smoke-fixtures.test.ts:195/198/216/908) cover all the existing refusal sites? Use `rg` to find any others I might have missed.
- Is the relationship to LLM01 prompt injection cleanly preserved? Prompt-injection markers (`ignore previous instructions`, `<|im_start|>`, `[INST]`, etc.) should STILL be refused regardless of whether they appear inside a title span (the literal-title policy covers destructive vocabulary, NOT LLM-instruction syntax). Verify the schema proposal §6 `buildLlmSafePromptSlice` excludes `prompt_injection`-tagged examples from LLM context.
- The bare-destructive test case (`"Delete all my tasks"` as bare instruction) is the symmetric coverage the existing tests don't have. Is the eval plan's coverage of this case sufficient?
- Is the `tasks.create_task` example in schema_proposal.md §7.1 consistent with the audit §10 approved policy?

---

## 8. Output format

Produce a single Markdown report. Suggested structure:

```markdown
# QA Review: Action Registry Consolidation v2 Plan

## Verdict
[PASS | PASS WITH MINOR ISSUES | PARTIAL | FAIL | NOT VERIFIED]

## Summary (3-5 sentences)
[…]

## Scope
[what you reviewed, what you didn't]

## Methodology
[commands run, files read]

## Findings table
| Claim | Verified? | Evidence | Severity if false |
|---|---|---|---|
| […] | […] | […] | […] |

## Missed findings
[…]

## Recommendation parity
[agree / disagree, with reasoning]

## Overfit check
[…]

## Unnecessary complexity check
[…]

## Existing-architecture preservation
[…]

## Reliability/safety/tests/maintainability check
[…]

## Delete-candidate safety
[…]

## executor/verifier leakage risk
[…]

## Eval realism
[…]

## Required follow-ups before implementation
[…]

## Appendix: stress-test results
[challenges 7.1-7.7]
```

---

## 9. References

- Architecture audit: `skill_interaction_catalog_architecture_audit.md`
- Decision matrix: `skill_interaction_catalog_decision_matrix.md`
- Implementation plan: `skill_interaction_catalog_implementation_plan.md`
- Schema proposal: `skill_interaction_catalog_schema_proposal.md`
- Eval plan: `skill_interaction_catalog_eval_plan.md`
- Security review: `skill_interaction_catalog_security_review.md`

External:
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
- [OpenAI Evals](https://developers.openai.com/api/docs/guides/evals)
- [Google Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Google Gemini Structured Output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Google Vertex/Gemini structured output reference](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output)
- [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [OWASP LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [NCSC Prompt Injection Is Not SQL Injection](https://www.ncsc.gov.uk/blog-post/prompt-injection-is-not-sql-injection)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)

---

## 10. Time budget

Suggested:
- Root verification + symbol existence checks: 15-20 minutes
- Reading the 6 substantive docs: 60-90 minutes
- Stress-testing challenges 7.1-7.7: 60-90 minutes
- Writing the QA report: 30-45 minutes

Total: 3-4 hours for a thorough review. If you have less time, prioritize: audit doc → security review → schema proposal → implementation plan; skip decision matrix and eval plan if necessary; QA prompt review is least critical.
