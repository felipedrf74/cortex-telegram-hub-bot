# Nexus Hub — Focused QA Report

**Generated:** 2026-04-29 18:48 WEST (v1 Sonnet baseline) + 19:30 WEST (Opus 4.7 rerun)
**Audit branch:** `qa/nexus-hub-focused-review-selected-areas`
**Reviewed HEAD:** `888b69e2a792106bc75a93744e02a64ae5412835`
**Audit commits:** `a0341d5` (Sonnet baseline) — Opus rerun deltas in [`nexus-hub-focused-qa-opus-rerun-addendum.md`](nexus-hub-focused-qa-opus-rerun-addendum.md)
**Backup tag:** `backup-qa-focused-nexus-hub-review-20260429-1848`
**Backup branch:** `backup/qa-focused-nexus-hub-review-20260429-1848`
**Reviewed working tree:** 59 uncommitted Codex files (the in-flight content-creation intelligence upgrade)

> **⚠️ READ THE OPUS ADDENDUM**: the Sonnet baseline below is preserved for traceability, but **9 net-new P0 findings** and **13 refuted/downgraded findings** appear in the Opus rerun. The corrected catalog is in [`nexus-hub-focused-qa-opus-rerun-addendum.md`](nexus-hub-focused-qa-opus-rerun-addendum.md) and supersedes selected entries in [`nexus-hub-focused-qa-findings.md`](nexus-hub-focused-qa-findings.md).

---

## 1. Executive Summary

### Final verdict: **FAIL** (confirmed by Opus 4.7 rerun)

The reviewed scope contains, after the Opus 4.7 max-effort rerun on all 9 critical sections:

- **24 P0 findings** (up from 15 in Sonnet baseline). Net change: -7 Sonnet P0s refuted/downgraded (coach-engine null guards work, cancellation saga branches are tested, route-level auth gates exist for skill version mutations), +13 net-new Opus findings (prompt injection via `[Current State]` markers, provider fallback restoring full TOOLS array, internal AI proxy reachable from any network, 6 *more* unscoped content queries Sonnet missed, lifecycle never advancing past `'scheduled'`, dead-code `incrementPlanVersion`, missing `tenant_id` on cross-skill signal bus, `skill_specific_memory` umbrella bypass, `UNSAFE_MEMORY_PATTERNS` missing every modern token shape, illegal version status regressions). +3 escalations from Sonnet P1 → P0.
- **35 P1 findings** (up from 20). Includes routing parity gaps, conditional-tenant filters in content-workflow, training calendar bypassing Secretary, agenda lifecycle states underused (8 of 11 written, not 5 as Sonnet thought), no reminder–agenda link at all, classifier PII leakage, signal origin not enforced, server-pinned timezone in training, concurrent cancel race.
- **A clean test layer.** All 14 focused targets passed (140 tests, 0 failures), full pre-commit suite ran 410 files / 6233 tests in 485s with 0 failures, `npx tsc --noEmit` clean. **Test coverage proves what's written, not what's missing.** The P0/P1 findings are gaps, missing scope predicates, missing authorization checks, and dead-code paths — categories existing tests do not exercise adversarially.

## 1.5 QA Agent Model/Tier Usage

Per task instruction, every critical QA agent must run on Claude Opus 4.7 with maximum effort. The audit was executed in two waves:

| Section | Wave 1 (initial) | Wave 2 (Opus rerun) | Final coverage |
|---|---|---|---|
| Phase 1 — Chat security/memory/tools | Sonnet 4.6 (default) | **Opus 4.7 max effort** | ✅ Opus-validated |
| Phase 2 — Live model-routing safety | Sonnet 4.6 (default) | **Opus 4.7 max effort** | ✅ Opus-validated |
| Phase 3 — Secretary scheduling | Sonnet 4.6 (default) | **Opus 4.7 max effort** (combined with C/D/I rerun) | ✅ Opus-validated |
| Phase 4 — Training engine + iOS | Sonnet 4.6 (default) | **Opus 4.7 max effort** (combined with C/D/I rerun) | ✅ Opus-validated |
| Phase 5 — Content references/provenance | Sonnet 4.6 (default) | **Opus 4.7 max effort** | ✅ Opus-validated |
| Phase 6 — Cross-skill orchestration | Sonnet 4.6 (default) | **Opus 4.7 max effort** (combined with F/G/H rerun) | ✅ Opus-validated |
| Phase 7 — Skill versioning | Sonnet 4.6 (default) | **Opus 4.7 max effort** (combined with F/G/H rerun) | ✅ Opus-validated |
| Phase 8 — Cross-skill memory | Sonnet 4.6 (default) | **Opus 4.7 max effort** (combined with F/G/H rerun) | ✅ Opus-validated |
| Phase 9 — Calendar/agenda lifecycle | Sonnet 4.6 (default) | **Opus 4.7 max effort** (combined with C/D/I rerun) | ✅ Opus-validated |
| Phase 10 — Test execution | n/a (general-purpose tool runner) | n/a | n/a — test results are deterministic |
| Final synthesis (this report) | Sonnet/Opus (parent agent) | Opus updated this report directly | ✅ |

**Wave 1 limitation:** The `Explore` subagent type defaulted to Sonnet 4.6 in this environment. The initial 8 parallel evidence agents and the Phase 10 test runner ran on Sonnet, not Opus 4.7. This was identified as a QA confidence risk and mitigated in Wave 2.

**Wave 2 mitigation:** All 9 critical sections were rerun on `Explore` with `model: "opus"` override (Claude Opus 4.7) at maximum effort. Each Wave 2 agent received Wave 1's findings as a baseline and was instructed to (a) validate each finding with file:line evidence, (b) hunt for what Wave 1 missed, (c) extend the catalog with new findings.

**Wave 2 outcomes:**
- Wave 2 **refuted or downgraded 13 Wave 1 findings** (the largest cluster being three Training-engine "crash bug" P0s that turned out to be properly defended; another being the route-level auth gate Wave 1 missed for skill version mutations).
- Wave 2 **surfaced 41 net-new findings**, including 13 new P0s.
- Full deltas in [`nexus-hub-focused-qa-opus-rerun-addendum.md`](nexus-hub-focused-qa-opus-rerun-addendum.md).

**Final QA confidence:** **HIGH** — no critical section is left as a Sonnet-only review. Wave 2 evidence is read-grounded with file:line citations.

> Reasoning/effort setting in Wave 2: each Opus agent was given a tightly scoped brief with file paths and line ranges to inspect, plus instructions to "apply Opus-level depth here". Final reports averaged 1200–1500 words of evidence-dense content per agent. No Wave 2 agent terminated early or returned shallow output.

> **Critical distinction preserved:** Nexus Hub's runtime model routing is NOT hardcoded to Opus 4.7. The audit verifies — and the corrected findings catalog continues to enforce — that Nexus uses live model routing (Gemini primary, OpenAI fallback, Anthropic gated by `ANTHROPIC_ENABLED`, per-domain pins, tier pins, env overrides, portal/operator overrides). The Opus 4.7 max-effort requirement applies only to the Claude Code QA review agents.

---

### Why FAIL, not PASS WITH CONDITIONS:

A PASS WITH CONDITIONS verdict requires that all P0s be either accepted (with documented mitigations) or trivially fixable in a follow-up commit. The current P0 set includes:
- **Cross-tenant content leakage** in three queries (`content-learning-store.ts:586-587, 234-243, 622-627`). One known leak is a release blocker. Three is a re-architecture signal.
- **Missing `tenant_id` on `training_agenda_event_ownership`** — multi-tenant isolation cannot be guaranteed for cancellation/orphan reconciliation until this column is added and backfilled.
- **Tool allowlist absent** in `tool-executor.ts` — the model can theoretically dispatch any string as a tool name, which is a fundamental authorization gap.
- **Adaptation engine null-readiness crash** at `adaptation-engine.ts:165` — production users without HealthKit/Garmin data will hit this path.

These are not "ship-and-fix-next-sprint" issues. They are pre-deploy fixes.

### Biggest release blockers (the must-fix list)

1. Backfill `tenant_id` on `training_agenda_event_ownership` and update unique index (P0, schema migration)
2. Sweep `content-learning-store.ts` for unscoped queries — minimum 3 known leaks (P0, query rewrite)
3. Add backend-side tool allowlist in `tool-executor.ts` (P0, ~20 LOC)
4. Default-deny tool authorization context (`chat-tool-authorization.ts:92-94` flips `allowed: true` → `allowed: false`) (P0, 1 LOC)
5. Wrap all direct `new Anthropic()` instantiations through `trackedCreate` to enforce kill switch (P0, ~7 services)
6. Null-guard `adaptation-engine.ts:165 readiness?.level` and zero-guard `session-coherence.ts:298-302` (P0, defensive coding)
7. Auth-gate `setSkillVersionStatus` and `activateSkillVersion` (P0, portal admin token check)
8. Apply `getDomainModelOverride()` to OpenAI + Gemini call sites, not just Anthropic (P1, routing parity)
9. Write integration tests for the 5 cancellation saga branches (P1, test gap on operationally critical path)
10. Replace conditional `${userId != null ? 'AND user_id = ?' : ''}` with mandatory `contentScopePredicate()` in `content-workflow.ts` (P1, 3 sites)

> **Post-Opus update:** Items 5 (Anthropic SDK wrap), 6 (null/zero guards), 7 (skill-version auth gate), and 9 (saga tests) above were **REFUTED or downgraded by the Opus rerun** — see [`nexus-hub-focused-qa-opus-rerun-addendum.md`](nexus-hub-focused-qa-opus-rerun-addendum.md). Replacement P0s: loopback-restrict `/api/v1/internal/*`, sanitize `[Current State]` markers, add `tenant_id` to `agent_signals`, expand `UNSAFE_MEMORY_PATTERNS`, schema-validate `skill_specific_memory`, wire `'synced'`/`'failed_sync'`/`'completed'` lifecycle writes, route Cooking/Training/Finance through Secretary `submitSecretarySchedulingIntent`, decide `incrementPlanVersion` (delete or wire), version-status transition validation, 3 *more* unscoped queries in `content-learning-store.ts` (lines 557-561, 572-573, 595-599, 612-618 — 4 more sites Sonnet missed), 1 cross-tenant write path in `content-workflow.ts:79-99`, AsyncLocalStorage fallback in `content-dedup.ts:62-89`, provider-fallback TOOLS allowlist enforcement in `gemini-provider.ts:802, :862`, approval-gate actor permission check in `content-editorial-workflow.ts:439-445`. **The corrected must-fix list is in the updated [`nexus-hub-focused-qa-open-blockers.md`](nexus-hub-focused-qa-open-blockers.md).**

### Highest-impact improvements (ranked by leverage)

1. **One sweep, one PR**: rewrite all `content_*` table reads/writes through `contentScopePredicate()` + `contentScopeParams(userId, tenantId)`. Closes ~40% of the P0/P1 content findings. ~2 hours.
2. **Auth-gate the skill version registry mutations** + add a portal admin guard test. Closes 2 P0s. ~1 hour.
3. **Defensive guards on coach kernel inputs** (null readiness, undefined painFlags, zero claimedMinutes). Closes 3 P0s. ~30 minutes.
4. **Integration tests for the cancellation saga** (5 branches × 1 test each). Closes 1 P0 + reduces release risk on the most operationally complex path. ~3 hours.

### Areas that look healthy

- **Backend tests pass** (140/140) and typecheck is clean against the full uncommitted change set.
- **Skill memory boundaries** (`skill-memory.ts MEMORY_BOUNDARIES`) are correctly designed — credential guard works for at least one pattern, scope-by-skill is enforced.
- **Migration 087-092 schema design** is solid: scope columns are present, unique constraints cover the right tuples, lifecycle/decision enums are richly modeled.
- **iOS commits today (4 commits, including `fc9e7c7` and `f146fba`)** ship the correct forward-compat pattern: `RawRepresentable` + `.unknown` fallback for lifecycle enums.
- **Provider routing architecture** (Gemini-first cascade with Anthropic kill-switch gate) is correctly designed at the policy layer (`config.ts`, `gemini-provider.ts`); the gaps are in enforcement at call sites.

### Areas that are under-tested

- **Cancellation saga (slice 4.D.2)**: zero dedicated integration tests for any of its 5 outcomes.
- **Real metrics history (slice 4.E)**: no test file matches.
- **Adaptation engine null/edge paths**: no test for null readiness, missing painFlags, zero-duration sessions.
- **Tool authorization adversarial tests**: no test asserts that a model emitting an unknown tool name is rejected before dispatch.
- **Skill version mutation authorization**: no test for unauthorized `setSkillVersionStatus`/`activateSkillVersion`.
- **Cross-tenant memory `tenant_shared` scope adversarial test**: no test where user from tenant B queries tenant A's `tenant_shared` memory.
- **Provider fallback tenant safety**: no test confirms the fallback prompt is identical to the primary's, so a regression silently corrupting context would not be caught.

---

## 2. Coverage Summary

| Area | Inspected | Tests run | Could not validate | Confidence |
|---|---|---|---|---|
| Chat security/memory/context/retrieval/tool calls | YES — Read 9 service files, grep on 8 patterns | NO targeted chat tests run (existed but not in QA targets) | Live SSE streaming behavior under retry; tenant-switch on iOS+backend round-trip | MEDIUM — code review thorough, runtime not validated |
| Live model-routing & provider fallback safety | YES — Read 7 service files, including provider hooks | NO targeted routing tests in QA targets (existing tests pass) | Real Gemini→OpenAI→Anthropic cascade under outage; portal override round-trip | MEDIUM — design correct, enforcement gaps cited |
| Secretary scheduling/agenda/reminders/reflow | YES — Read 4 service files, migrations 081-083 | Existing arbitrator tests pass | External calendar deletion repair; cross-skill agenda intent submission | MEDIUM-LOW — schema solid but lifecycle states underused |
| Training engine/lifecycle/calendar/iOS readiness | YES — Read 7 coach-kernel files, 4 plan-lifecycle files | Indirect (focused tests via QA targets pass) | Cancellation saga branches; iOS rich-payload field-level parity | MEDIUM-LOW — core logic gaps cited |
| Content references/provenance/memory/voice/workflow/quality | YES — Read 8 service files, 6 migrations, 4 docs | YES — content-tenant-scope, content-domain-ontology, content-reference-provenance, content-dedup-routing, content-workflow-user-scope, content-home/learning/reference routes (~50 tests, all green) | Real content generation with provenance enforcement | MEDIUM — tests pass but several queries still bypass scope |
| Cross-skill orchestration/shared context | YES — Read intelligence-bus, shared-memory, skill-memory | NO targeted cross-skill tests | End-to-end multi-skill chat orchestration | LOW-MEDIUM — agenda intent submission is unimplemented |
| Skill versioning/release metadata | YES — Read skill-version-registry, migration 087, tests | YES — skill-version-registry.test.ts (6/6 pass) | Authorization on mutation; rollback orchestration | MEDIUM — schema solid, missing auth gate is the gap |
| Cross-skill memory/version-aware memory | YES — Read skill-memory.ts, migration 088, tests | YES — skill-memory.test.ts (9/9 pass) | tenant_shared cross-tenant adversarial; version compatibility validation | MEDIUM — well designed, missing 1 boundary check |
| Calendar/agenda lifecycle Secretary × Training | YES — Read 4 service files + migrations 081, 082, 083 | NO — cancellation saga tests are the gap | External-deletion repair; staged real-provider sync | LOW — operationally most risky area + zero integration tests |

Confidence aggregate: **MEDIUM** for design review, **LOW** for runtime validation. The audit captures evidence-based gaps but does not claim to certify runtime correctness without further integration testing.

---

## 3. Branches and commits

| Item | Value |
|---|---|
| Active branch | `qa/nexus-hub-focused-review-selected-areas` |
| Reviewed HEAD | `888b69e2a792106bc75a93744e02a64ae5412835` (chore: bump version to 4.14.105 [deploy]) |
| Backup branch | `backup/qa-focused-nexus-hub-review-20260429-1848` |
| Backup tag | `backup-qa-focused-nexus-hub-review-20260429-1848` |
| Branch divergence vs main | +2 commits (already on `feature/content-creation-intelligence-upgrade`'s commits + the QA branch) |
| Working tree | 59 uncommitted Codex files preserved untouched |

---

## 4. Documents reviewed

- `docs/qa/QA_BACKEND_REPORT.md` (337 lines) — prior Chat tenant-safe context audit + 2026-04-29 Content addendum (release gate: NO-GO)
- `docs/qa/QA_RELEASE_GATE_REPORT.md` (68 lines)
- `docs/chat/*` (71 files) — security review, threat model, memory model, day-to-day risk map
- `docs/training/*` (114 files) — coach-engine slices, plan-lifecycle, calendar repair handoff
- `docs/content/*` (40 files) — including new content-domain-ontology, content-provenance-model, content-object-model, content-lifecycle-model
- `docs/memory/*` (5 files) — skill-memory-model, memory-test-matrix
- `docs/skills/*` (5 files) — skill-version-registry-design
- `docs/secretary/*`, `docs/calendar/*`, `docs/portal/*`, `docs/ios/*`, `docs/local/*`, `docs/release/*`, `docs/agents/claude/*`

---

## 5. Pointer to detailed findings

See companion docs:
- `docs/qa/nexus-hub-focused-qa-findings.md` — detailed findings catalog (45 entries, P0–P3, grouped by area)
- `docs/qa/nexus-hub-focused-qa-open-blockers.md` — P0/P1 only with ownership recommendations
- `docs/qa/nexus-hub-focused-qa-test-results.md` — test execution log
- `docs/qa/nexus-hub-focused-qa-release-risk-register.md` — risk register with severity × probability matrix
- `docs/qa/nexus-hub-focused-qa-recommendations.md` — prioritized action plan ordered by leverage
