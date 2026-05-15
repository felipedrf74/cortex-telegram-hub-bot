# Decision Trail Quality Review

## Problems Found

| Area | Finding | Impact | Action |
| --- | --- | --- | --- |
| Weekly notes | `Phase`, `Readiness`, and `Compliance` were labels, not explanations. | Users could see state but not understand why the plan changed. | Replaced with explicit weekly structure, readiness, and adherence decision lines. |
| Daily rationale | Adjusted guardrails and weekly notes were concatenated without deduplication. | Repeated warnings could appear after refreshes, replacements, or multiple guardrail passes. | Added `dedupeDecisionLines` before rationale is returned. |
| Fatigue adjustment | Existing auto-summary notes could survive after a readiness downshift. | A deload/maintenance plan could retain stale base-phase wording. | Weekly decision notes are rebuilt from final plan state. |
| Debugging | Plan generation and coherence fixes lacked compact operational traces. | Root-cause analysis required stepping through tests or inspecting payloads manually. | Added redacted debug metadata at planner and strength-engine decision points. |

## Current Decision Trail Shape

Weekly plans now start with:

1. `Weekly structure: ...`
2. `Readiness decision: ...`
3. `Adherence decision: ...`

Then they preserve useful extra context:

- profile follow-up needs
- hybrid planning notes
- feedback-loop notes
- fatigue override notes

Daily recommendations now include:

1. primary session rationale
2. adjusted guardrail messages
3. weekly decision notes

Duplicate lines are removed after trimming whitespace and normalizing guardrail prefixes.

## Quality Bar

A user-facing decision line should:

- explain a decision, not merely label a state
- be specific enough to answer "why did this change?"
- avoid repeated copies of the same warning
- keep technical evidence concise
- preserve raw structured guardrail results for deeper inspection

## Open Questions

- Should API clients receive both `decisionTrail` and `debugTrail` fields so UI can distinguish public explanation from internal evidence?
- Should repeated warnings be grouped by category, such as readiness, schedule, volume, and fueling?
- Should the coach store generated explanation snapshots per plan version for later auditability?
