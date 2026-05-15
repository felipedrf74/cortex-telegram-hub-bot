# Explainability Test Matrix

## Automated Coverage Added

| Test | File | Proves |
| --- | --- | --- |
| `deduplicates noisy decision lines while preserving first useful wording` | `__tests__/services/coach-kernel-decision-trail.test.ts` | Duplicate rationale/warning lines collapse even when one copy is prefixed as a guardrail display line. |
| `rebuilds weekly notes from current plan state and drops stale auto-summary lines` | `__tests__/services/coach-kernel-decision-trail.test.ts` | Auto-generated weekly summaries are regenerated from current phase/readiness and stale old summaries are removed. |
| `attaches explicit weekly decision notes instead of generic phase/readiness labels` | `__tests__/services/coach-kernel-planner.test.ts` | Plan notes now explain structure/readiness/adherence and no longer expose generic labels as the main explanation. |
| `deduplicates repeated guardrail and weekly-note rationale after plan updates` | `__tests__/services/coach-kernel-planner.test.ts` | Daily rationale removes duplicate warnings while preserving the complete raw guardrail result list. |

## Existing Coverage That Still Matters

| Existing Area | Why It Matters |
| --- | --- |
| Guardrail enumeration in daily rationale | Ensures adjusted guardrails still reach the user-facing "why" surface. |
| Fatigue adjustment tests | Ensures red/orange readiness still changes phase and produces updated guardrails. |
| Session coherence tests | Ensures time-volume corrections still happen before sessions are surfaced. |
| Biomechanics substitution tests | Ensures safety substitutions are deterministic and inspectable. |

## Manual QA Checklist

- Generate a normal plan and confirm weekly notes explain structure, readiness, and adherence.
- Trigger a low-readiness adjustment and confirm old phase wording does not remain.
- Trigger repeated warning paths and confirm the UI does not show duplicate text.
- Inspect debug logs for plan generation and verify they contain decision metadata without free-form private user data.
- Inspect debug logs for strength coherence/substitution and verify they identify the correction path without leaking profile notes.

## Future Test Targets

- Contract-level tests if a dedicated `decisionTrail` API field is introduced.
- Snapshot-free UI tests that verify grouped warnings render once.
- Plan-version tests that verify explanations remain coherent after replacement/regeneration.
