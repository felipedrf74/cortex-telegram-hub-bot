# Training Engine + Agenda Orchestration Overhaul — Spec

Status: **DRAFT — Phase 0 audit in progress**
Working branch: `feature/training-engine-intelligence-and-agenda-overhaul`
Rollback anchor: branch `backup/training-engine-before-orchestration-overhaul-20260427-2003`, tag `backup-training-engine-before-orchestration-overhaul-20260427-2003`, commit `96c61fb` (== `origin/main` aka backend `4.14.97`).

This spec is the architectural target for the rebuild. Phase 0 fills it in based on the gap analysis.

---

## 1. Mission

Redesign the Training engine into a real coaching intelligence layer with strong orchestration, variety, adaptation, profiling, biomechanics awareness, metrics-based feedback, and reliable calendar agenda lifecycle.

## 2. Mandatory regression cases

These are observed failures that any rebuild MUST close:

1. **Volume × time mismatch** — a "Lower Body Strength A" session reported ~48 min total but contained essentially one small exercise block (Dead Bug 2×10–15) plus generic warm-up/cool-down. The engine doesn't reason about session content vs duration coherently.
2. **Variety failure** — the next several strength days were near-identical. No session-role differentiation, no progression-aware variation, no modality-specific catalog.
3. **Agenda lifecycle broken** — plans don't reliably create calendar entries; cancelling/replacing a plan doesn't reliably delete the old entries. Stale schedule state, low product trust.

## 3. Target engine architecture

(Layers to be filled in Phase 1 with concrete file paths + module boundaries. Outline taken from prompt.)

1. Structured User Training Profile Layer
2. Training Domain Model / Catalog Layer
3. Session Time Estimator + Session Coherence Validator
4. Plan Orchestration Layer
5. Variation and Substitution Engine
6. Adaptability / Autoregulation Layer
7. Biomechanics and Movement Intelligence Layer
8. Metrics and Feedback Analysis Layer
9. Progression and Periodization Layer
10. Explainability Layer

Note: the current engine already has substrate for Layers 1, 4, 5, 6 from prior slices (1, 2.A, 2.B, 3.A, 3.H, 3.I–3.M). The audit identifies what's missing per layer.

## 4. Plan lifecycle state machine (target)

```
draft  →  active  →  scheduled  →  completed
                  ↘  superseded  ↗
                  ↘  cancelled
```

- Each transition has explicit triggers + side effects (agenda sync, cleanup).
- Agenda events linked to (plan_id, plan_version, day, session) — not date ranges.

## 5. Non-negotiables (from prompt)

- No hardcoded special-case patches for screenshots
- No fake intelligence (LLM around brittle templates)
- Fix root causes
- Preserve `trainning` legacy spelling where it exists
- Backup branch + tag created before any change
- Do not deploy/push to production
- Tests for improved behaviors
- Document what remains open

## 6. Out-of-scope for this overhaul

- Diagnostic medical recommendations
- Forced novelty everywhere (intentional repeated exposures are acceptable when justified)
- UI redesign
- iOS code changes (separate scope)

---

(Detailed architecture filled in Phase 1.)
