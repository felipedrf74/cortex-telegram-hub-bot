# Nexus Hub — Focused QA Release Risk Register

**Generated:** 2026-04-29 18:48 WEST
**Source audit:** `docs/qa/nexus-hub-focused-qa-findings.md`

Risk axes:
- **Severity** = blast radius if the risk materializes (1=cosmetic, 5=catastrophic)
- **Probability** = likelihood the risk materializes in production within 30 days post-deploy (1=rare, 5=very likely)
- **Impact score** = Severity × Probability

Risks are ordered by impact score, descending.

---

## R1 — Cross-tenant content data leakage via unscoped queries

| Field | Value |
|---|---|
| Severity | 5 (catastrophic — tenant leakage is contractual breach + regulatory risk) |
| Probability | 4 (active codepaths; no allowlist defending against the gap) |
| Impact | **20** |
| Findings | E-P0-1, E-P0-2, E-P0-3 |
| Mitigation | Block 1 of `nexus-hub-focused-qa-open-blockers.md` — sweep `content-learning-store.ts` queries through `contentScopePredicate()` with mandatory `(userId, tenantId)` parameters. Add adversarial test in `__tests__/scope/`. |
| Owner | Content workstream |
| Acceptance | All `content_*` reads/writes scoped; cross-tenant test green; no regression in 14-test focused subset. |

## R2 — Anthropic spend cannot be reliably disabled (kill switch bypass)

| Field | Value |
|---|---|
| Severity | 4 (financial / operational — the April 9 2026 kill-switch comment in `config.ts` shows this was a deliberate cost-control decision) |
| Probability | 5 (active code today; happens on every Garmin coach run, every invoice file, every channel-learner pass) |
| Impact | **20** |
| Findings | B-P0-1 |
| Mitigation | Block 5 — wrap all `new Anthropic(...)` SDK instances through a kill-switch-aware factory that consults `isAnthropicRuntimeEnabled()` before delegation. |
| Owner | Platform workstream |
| Acceptance | `git grep -n "new Anthropic"` returns zero hits outside the factory module; `ANTHROPIC_ENABLED=false` results in zero Anthropic API calls in a 1-hour soak. |

## R3 — Multi-tenant isolation broken on `training_agenda_event_ownership`

| Field | Value |
|---|---|
| Severity | 5 (orphan reconciliation runs globally; one tenant's stale event could be cleaned up by another tenant's regenerate path) |
| Probability | 3 (only fires on regenerate-with-orphans; today is single-tenant prod, but enabling multi-tenant exposes this immediately) |
| Impact | **15** |
| Findings | I-P0-2 |
| Mitigation | Block 2 — schema migration to add `tenant_id NOT NULL DEFAULT ''`, backfill from `fitness_training_plans.tenant_id`, update unique index, scope all insert/query sites. |
| Owner | Training workstream |
| Acceptance | Migration applied; `findOrphanedOwnerships(userId, tenantId)` filters by tenant; cancellation saga test asserts no cross-tenant orphan match. |

## R4 — Cancellation saga is not test-covered (operationally critical path)

| Field | Value |
|---|---|
| Severity | 4 (silent calendar duplication / orphan corruption on retry) |
| Probability | 4 (every plan regenerate-on-error executes one of the 5 saga branches) |
| Impact | **16** |
| Findings | I-P0-1, D-P1-1 |
| Mitigation | Block 2 — write 5 dedicated integration tests (one per outcome). Cover `local_delete_failed` orphan-row transition. |
| Owner | Training workstream |
| Acceptance | `__tests__/api/training-plan-cancellation.test.ts` has ≥5 `it()` cases; each saga branch returns the expected discriminated outcome and leaves `training_agenda_event_ownership` in the documented state. |

## R5 — Tool authorization can be bypassed (default-allow + missing allowlist)

| Field | Value |
|---|---|
| Severity | 5 (model-driven privilege escalation; the model's `tool_use` block could potentially target tools outside the active scope) |
| Probability | 3 (requires either a context-loss bug or a prompt injection) |
| Impact | **15** |
| Findings | A-P0-1, A-P0-2 |
| Mitigation | Block 4 — add `ALLOWED_TOOLS` set in `tool-executor.ts`. Flip `chat-tool-authorization.ts:92-94` to fail-closed. |
| Owner | Chat workstream |
| Acceptance | Adversarial test: emitting `executeToolCall('weird_tool', ...)` returns error before any side effect. Test for missing-context returns `allowed: false`. |

## R6 — Adaptation engine crashes on first-launch users with no wearable data

| Field | Value |
|---|---|
| Severity | 4 (uncaught exception → 500 → poor onboarding UX) |
| Probability | 5 (every user on day-1 without HealthKit/Garmin connected hits this path) |
| Impact | **20** |
| Findings | D-P0-1, D-P0-2, D-P0-3 |
| Mitigation | Block 3 — null-guards in `adaptation-engine.ts:165`, `biomechanics-and-ordering.ts:83-89`, `session-coherence.ts:298-302`. Add tests for each null/zero path. |
| Owner | Training workstream |
| Acceptance | Three new tests covering the three null/zero paths green. Manual simulator smoke for first-launch user without wearable data succeeds. |

## R7 — Skill version registry mutations are unauthenticated

| Field | Value |
|---|---|
| Severity | 4 (a non-admin code path could promote a broken version, breaking all users on the affected skill) |
| Probability | 2 (today, no end-user surface invokes these; risk is internal/automation drift) |
| Impact | **8** |
| Findings | G-P0-1 |
| Mitigation | Block 4 — add `requirePortalAdminToken()` middleware to `setSkillVersionStatus`/`activateSkillVersion`. |
| Owner | Platform workstream |
| Acceptance | Non-admin caller is denied; admin caller succeeds; tests cover both. |

## R8 — `tenant_shared` memory readable across tenants

| Field | Value |
|---|---|
| Severity | 5 (cross-tenant memory access is the same class as R1) |
| Probability | 2 (requires knowing another tenant's `tenant_id`, which is not currently exposed in normal flows) |
| Impact | **10** |
| Findings | H-P0-1 |
| Mitigation | Block 4 — `assertUserBelongsToTenant(userId, tenantId)` before fetch on `tenant_shared` scope. |
| Owner | Memory workstream |
| Acceptance | Adversarial test where user from tenant B is denied tenant A's shared memory. |

## R9 — Memory schema-version compatibility not validated on activation

| Field | Value |
|---|---|
| Severity | 4 (a user's memory rows from an older schema may be misread by a newer skill version → data corruption or feature breakage) |
| Probability | 3 (only triggers on a major skill-version promotion; happens during release cadence) |
| Impact | **12** |
| Findings | H-P0-2 |
| Mitigation | Block 4 — `getActiveSkillVersion` cross-checks user's existing `skill_memories.schema_version` and refuses or runs migration. |
| Owner | Platform workstream |
| Acceptance | Test asserts a user with v1 schema cannot activate a skill version requiring v2 without migration. |

## R10 — PII leakage via classifier prompt to providers

| Field | Value |
|---|---|
| Severity | 3 (data minimization concern; provider logs/training risk) |
| Probability | 5 (every classify call passes the raw user message + last assistant message) |
| Impact | **15** |
| Findings | B-P1-3 |
| Mitigation | Block 5 — lightweight regex redactor for emails, phone, card numbers before classifier dispatch. |
| Owner | Platform workstream |
| Acceptance | Test asserting that a message like `"my email is alice@example.com"` arrives at the classifier scrubbed. |

## R11 — Provider-fallback context drift between Gemini → OpenAI → Anthropic

| Field | Value |
|---|---|
| Severity | 4 (silent prompt drift could leak/corrupt context; hardest to detect after the fact) |
| Probability | 2 (only fires under primary provider outage) |
| Impact | **8** |
| Findings | A-P1-2 |
| Mitigation | Build a single `RoutedPrompt { system, user, hash }` and assert hash equality across all fallback stages. Log a warning on mismatch. |
| Owner | Platform workstream |
| Acceptance | Forced-fallback test: same prompt hash logged at all three providers. |

## R12 — Per-domain operator pins ignored on OpenAI/Gemini

| Field | Value |
|---|---|
| Severity | 3 (operator override fails silently; cost/quality tuning unavailable) |
| Probability | 4 (every chat call on a non-Anthropic primary today) |
| Impact | **12** |
| Findings | B-P1-1, B-P1-2 |
| Mitigation | Block 5 — apply `getDomainModelOverride()` to OpenAI + Gemini call sites; resolve internal AI proxy through the override system. |
| Owner | Platform workstream |
| Acceptance | Setting a Gemini per-domain pin from the portal results in that model being used at the next call; test asserts. |

## R13 — Training writes calendar events directly, bypassing Secretary

| Field | Value |
|---|---|
| Severity | 4 (architecture drift; agenda audit trail is incomplete) |
| Probability | 5 (every Training plan generation today) |
| Impact | **20** |
| Findings | C-P1-3, F-P1-4 |
| Mitigation | Block 6 — wire `submitSchedulingIntent` through Secretary. This is architecture work; can be deferred to post-release with documented exception. |
| Owner | Secretary + Training (joint) |
| Acceptance | All Training calendar mutations go through Secretary intent submission; agenda items have a `source_intent_id`. |

## R14 — Secretary lifecycle states underused (5 of 11 written)

| Field | Value |
|---|---|
| Severity | 3 (iOS rendering of states like `synced`, `deferred`, `failed_sync` never exercises real backend payloads) |
| Probability | 5 (every Secretary write today) |
| Impact | **15** |
| Findings | I-P1-2 |
| Mitigation | Block 6 — map decision states → lifecycle states explicitly in orchestration. |
| Owner | Secretary workstream |
| Acceptance | All 11 lifecycle states are reachable from orchestration; tests cover each. |

## R15 — `recordCalendarOwnership` race on concurrent insert

| Field | Value |
|---|---|
| Severity | 3 (only fires under high concurrency; unique constraint catches but recovery returns null `ownershipId`) |
| Probability | 2 (uncommon in single-user prod) |
| Impact | **6** |
| Findings | I-P1-1 |
| Mitigation | Block 2 — `INSERT OR IGNORE` then always refetch; never return null `ownershipId` on success. |
| Owner | Training workstream |

## R16 — `reminders` table allows duplicates

| Field | Value |
|---|---|
| Severity | 2 (UX nuisance, not data corruption) |
| Probability | 3 (any double-trigger of `setReminder` for same agenda item) |
| Impact | **6** |
| Findings | C-P1-2 |
| Mitigation | Block 2 / 6 — add `UNIQUE(user_id, agenda_item_id, remind_at)`. |
| Owner | Secretary workstream |

## R17 — Stale cross-skill memory after plan cancellation

| Field | Value |
|---|---|
| Severity | 3 (Cooking/Secretary may continue to consume signals tied to a canceled plan version) |
| Probability | 4 (every plan cancellation today) |
| Impact | **12** |
| Findings | F-P1-1, F-P1-2, F-P1-3 |
| Mitigation | Block 6 — invalidation hook + signal origin enforcement + warning deduplication. |
| Owner | Memory + cross-skill workstream |

## R18 — Determinism gap on session shape hash

| Field | Value |
|---|---|
| Severity | 3 (intermittent test failures; possible duplicate session detection false-positives) |
| Probability | 1 (depends on `stableStringify` impl, currently unverified) |
| Impact | **3** |
| Findings | D-P1-3 |
| Mitigation | Block 2 — verify or replace `stableStringify` to guarantee key-sort. |
| Owner | Training workstream |

## R19 — Plan-version increment not test-asserted before re-persist

| Field | Value |
|---|---|
| Severity | 3 (regression-prone area; today appears correct but no guard) |
| Probability | 2 |
| Impact | **6** |
| Findings | D-P1-2 |
| Mitigation | Block 2 — add the assertion test. |
| Owner | Training workstream |

## R20 — `decision_explanation` column missing

| Field | Value |
|---|---|
| Severity | 2 (read-back loses context for reflow/defer/compress decisions; degrades operator debuggability) |
| Probability | 5 (every decision today) |
| Impact | **10** |
| Findings | C-P0-1 |
| Mitigation | Block 2 — add column + persist. |
| Owner | Secretary workstream |

---

## Risk-impact heatmap

| Probability ↓ / Severity → | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| 5 | | R16 (P=3,S=2) | R10 (P=5,S=3), R12 (P=4,S=3), R14 (P=5,S=3), R20 (P=5,S=2) | R6 (P=5,S=4), R13 (P=5,S=4) | R2 (P=5,S=4) |
| 4 | | | R17 (P=4,S=3) | R4 (P=4,S=4) | R1 (P=4,S=5), R6/13/2 |
| 3 | | | R12 | R3 (P=3,S=5), R9 (P=3,S=4) | R3, R9 |
| 2 | | R15 (P=2,S=3) | R15, R19 (P=2,S=3) | R7 (P=2,S=4), R11 (P=2,S=4) | R8 (P=2,S=5) |
| 1 | | | R18 (P=1,S=3) | | |

---

## Acceptance criteria for "PASS WITH CONDITIONS" (instead of FAIL)

The audit's verdict is FAIL today. To upgrade to PASS WITH CONDITIONS, the following risks must be mitigated to documented acceptance:

1. **R1, R2, R3, R4, R5, R6** must be fully mitigated (impact ≥ 15) — these are pre-deploy work.
2. **R7, R8, R9, R10** must have explicit operator-accepted exceptions or be fully mitigated.
3. **R13, R14, R17** can be deferred to a follow-up release with a documented exception in `docs/release/` and a follow-up tracking issue.
4. **All other risks** can be deferred with documented acceptance.

To upgrade to **PASS**, every risk above must be fully mitigated and the test layer must include adversarial coverage for all 15 P0 findings.
