# Training Production Open Blockers

Date: 2026-04-29
Scope: Training production hardening follow-up after the release blocker audit.

## Current Verdict

**No open P0 Training blocker was found in this audit.**

Current release gate: **PASS WITH CONDITIONS**.

The remaining items below are production-hardening blockers, product-claim blockers, or follow-up risks. Some are conditional: they become higher priority only if the release or product copy claims the behavior is fully complete.

## P0 Production Blockers

None currently identified.

## P1 Must Fix Or Explicitly Accept Before Next Training Release

### TRAIN-P1-01 Canonical Release Evidence Drift

Status: open

Problem:

Older Training docs still describe calendar staging, cross-skill staging, inactive state persistence, and calendar description update gates as blocked after newer release docs say those gates passed or were downgraded.

Why it matters:

Operators could follow stale blockers or stale approvals during the next release. This is a release-safety issue even when the code is healthy.

Required closure:

- Make `docs/training/production-open-blockers.md` and `docs/training/production-readiness-criteria.md` the canonical Training release truth.
- Mark superseded open-item docs as historical or update them with closure notes.
- Ensure release notes only cite current evidence.

### TRAIN-P1-02 Rich Feedback End-To-End Adaptive Claim

Status: conditional open

Problem:

iOS and backend both support structured feedback pieces, and backend tests prove feedback can influence planning. The full product loop still needs explicit evidence:

- iOS submits rich feedback.
- Backend persists it with enough structure.
- A later plan uses it.
- The user sees an explanation of what changed.

Why it matters:

The product should not claim finished closed-loop adaptive coaching until the loop is validated end to end.

Required closure:

- Run an end-to-end local or staging feedback scenario.
- Verify persisted feedback fields.
- Regenerate or adjust a plan.
- Verify the new plan changes for a documented feedback reason.
- Capture the result in Training docs.

### TRAIN-P1-03 Signed iOS Device / TestFlight Training Validation

Status: open for public beta confidence

Problem:

Simulator and fixture proof is strong, but signed-device/TestFlight validation remains the only way to close real auth, provider state, HealthKit, Apple Health, and user-facing Training behavior.

Why it matters:

Training is highly visible in the iOS product. Simulator success does not prove signed-device behavior.

Required closure:

- Run signed TestFlight/device smoke with a profile-complete account.
- Verify Training Home, weekly plan, rich session detail, feedback, skip/complete, and provider/HealthKit state.
- Confirm no stale calendar state or unsupported rich states appear in the UI.

### TRAIN-P1-04 Secretary-Precomputed Calendar Intelligence Claim

Status: conditional open

Problem:

Training handles constrained weeks and no-valid-slot outcomes, and it consumes Secretary context. However, Secretary busy windows are not yet a complete first-class pre-generation capacity input for the coach-kernel.

Why it matters:

If release copy claims Training is fully planned by Secretary before generation, the architecture must match that claim.

Required closure:

- Either avoid the claim, or wire Secretary availability/busy windows into the pre-generation capacity model.
- Add tests for Secretary-derived busy windows affecting Training generation before persistence/calendar sync.

### TRAIN-P1-05 Production-Safe Post-Deploy Mutation Proof

Status: conditional open

Problem:

Release docs indicate production-safe Training mutation/calendar proof is deferred until an approved safe production test tenant/user/calendar exists.

Why it matters:

Read-only health checks are not the same as proving production-safe Training create/cancel/calendar cleanup.

Required closure:

- Use only an approved safe production test tenant/calendar.
- Create and cancel a Training plan.
- Verify agenda/provider cleanup.
- Verify no unrelated provider events are touched.
- Record cleanup evidence.

## P2 Should Fix Before Release If Low Risk

### TRAIN-P2-01 Scheduled Orphan Agenda Reconciler

Status: open

Problem:

The service-level reconciliation path exists, but a scheduled production reconciler is not documented as live.

Closure:

- Add or document a safe scheduled reconciliation job.
- Keep it identity-based.
- Do not delete legacy events by title/date.

### TRAIN-P2-02 Legacy Unmarked Provider Event Reporting

Status: open

Problem:

Legacy provider events without identity markers cannot be deleted safely.

Closure:

- Add an operator report for suspect legacy Training events.
- Require manual review or explicit identity confirmation before cleanup.

### TRAIN-P2-03 Manual Provider Move Semantics

Status: open

Problem:

If a user manually moves a Training event in Google/Outlook, Training's source-of-truth behavior is not fully specified.

Closure:

- Define whether provider moves become Training reflows, user overrides, or sync conflicts.
- Add tests for provider-moved events.

### TRAIN-P2-04 Durable Follow-Up Prompt Resolution

Status: open

Problem:

Weak-profile prompts exist, but durable resolution/history remains incomplete.

Closure:

- Persist answered prompts.
- Avoid repeat prompts across devices.
- Add direct profile answer write routes or document the existing path.

### TRAIN-P2-05 Schedule-Compression Explanation Persistence

Status: open

Problem:

Decision reasons exist in generation responses and tests, but persistence/read-model/live API reconstruction needs continued focused coverage.

Closure:

- Add route-level regression coverage for persisted `decisionReasons`.
- Verify iOS renders the structured explanation from live/local API payloads.

### TRAIN-P2-06 Poor-Recovery Minimum-Dose Precision

Status: open

Problem:

Eval results remain high, but poor-recovery minimum-dose cases are the weakest scoring cases because estimated content can exceed claimed short duration.

Closure:

- Add minute-level estimator tests for red/orange readiness.
- Cover running-only recovery and swim recovery variety.

### TRAIN-P2-07 Transition Buffers And Slot-Sharing Preference

Status: open

Problem:

Constrained-week slot feasibility is functional, but transition buffers and avoiding stacked sessions are still shallow.

Closure:

- Model transition buffer needs in capacity reconciliation.
- Add tests for stacked sessions and travel/constrained days.

### TRAIN-P2-08 Catalog Depth And Schema Guardrails

Status: open

Problem:

Catalog breadth has improved, but bad-output risk remains around hybrid interference, public running taxonomy compression, strength machine/barbell depth, cycling specialization, warmup/cooldown structure, and substitution ranking.

Closure:

- Expand catalog coverage where evaluation cases still rely on generic substitutions.
- Add runtime schema validation around generated session sections.

### TRAIN-P2-09 Fully Authenticated Local iOS Backend Smoke

Status: open

Problem:

Training local smoke has strong fixture proof, but older docs note non-Training local API calls can show debug local auth errors when `NEXUS_SKIP_AUTH=1` does not seed a backend token/user.

Closure:

- Use the debug auth-token import/bootstrap path.
- Run local iOS against the full local backend with an authenticated seeded user.

### TRAIN-P2-10 Training Log And Prompt Privacy Audit Refresh

Status: open

Problem:

Training touches health-adjacent, schedule, and profile data. Security docs report no open P0/P1, but post-deploy or next-release log review should remain routine.

Closure:

- Re-scan Training logs for private calendar details, raw profile data, and provider tokens.
- Confirm no raw prompts/context dumps contain sensitive Training data.

## P3 Deferrable

### TRAIN-P3-01 Extended Provider Metadata

Add richer provider extended properties for diagnostics and migration safety.

### TRAIN-P3-02 Localization Polish

Localize profile follow-up prompts, decision reasons, and Training explanation copy.

### TRAIN-P3-03 Swim Recovery Catalog Depth

Add more swim recovery variants.

### TRAIN-P3-04 Human Coach Labels

Improve coach-facing labels and diagnostics for Training session decisions.

### TRAIN-P3-05 Analytics And Evaluation Dashboards

Expose active/deferred/unscheduled counts and poor-recovery catalog quality in operator dashboards.

## Recently Closed Or Downgraded Gates

These should not be re-opened unless new evidence contradicts them:

- Google Calendar staging lifecycle: documented pass `training-calendar-smoke-20260428165035-7ljwng`.
- Outlook Calendar staging lifecycle: documented pass `training-calendar-smoke-20260428165107-7fsbbr`.
- Cross-skill staging smoke: documented pass `training-cross-skill-smoke-20260428164946-829lm7`.
- Calendar event identity marker update gap: documented fixed with `new_description` update support and staging provider proof.
- GPT-5.5 runtime claim risk: mitigated by release-copy restraint. Training plan generation is deterministic/rule-based in the audited path.
- Inactive/deferred/unscheduled persistence: implemented in current backend code and covered by constrained-week tests, but keep regression coverage.

## Release Recommendation

Proceed only under these constraints:

1. No release copy claims GPT-5.5 runtime execution.
2. No release copy claims fully closed rich-feedback adaptation until end-to-end proof exists.
3. No release copy claims fully Secretary-precomputed Training calendar planning until Secretary busy windows feed generation directly.
4. Signed-device Training validation remains required for public-beta confidence.
5. Stale Training release docs are reconciled before the next operator deployment step.
