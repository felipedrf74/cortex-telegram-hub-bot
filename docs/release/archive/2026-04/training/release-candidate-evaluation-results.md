# Training Release Candidate Evaluation Results

Date: 2026-04-28  
Command: `npm run eval:training`

## Result

Overall score: **99/100**  
Cases: **156**  
JSON artifact: `reports/training-eval/training-eval-2026-04-28T11-18-03-028Z.json`  
Markdown artifact: `reports/training-eval/training-eval-2026-04-28T11-18-03-028Z.md`

## Dimension Scores

| Dimension | Score |
| --- | ---: |
| Profile fit | 99 |
| Plan coherence | 99 |
| Weekly structure quality | 100 |
| Session role differentiation | 97 |
| Variety quality | 99 |
| Time-volume coherence | 96 |
| Modality quality | 99 |
| Progression quality | 96 |
| Adaptability quality | 100 |
| Substitution quality | 100 |
| Biomechanics quality | 100 |
| Adherence realism | 100 |
| Explainability | 99 |
| Agenda lifecycle correctness | 99 |
| Warning quality and deduplication | 98 |

## Lowest Scoring Cases

| Case | Score | Notes |
| --- | ---: | --- |
| `advanced-strength-focused__poor-recovery` | 90 | Minimum-dose and mobility reset sessions were flagged by the evaluator as under-estimated relative to claimed duration. |
| `beginner-gym-only__poor-recovery` | 93 | Poor-recovery quality remains acceptable, but still carries the weakest time-volume rubric. |
| `intermediate-hypertrophy__poor-recovery` | 93 | Same recovery-week time-volume tolerance gap. |
| `runner-10k__poor-recovery` | 93 | Same recovery-week time-volume tolerance gap. |
| `cyclist-endurance__poor-recovery` | 93 | Same recovery-week time-volume tolerance gap. |
| `hybrid-gym-running__poor-recovery` | 93 | Same recovery-week time-volume tolerance gap. |
| `hybrid-gym-cycling__poor-recovery` | 93 | Same recovery-week time-volume tolerance gap. |
| `time-constrained-parent__poor-recovery` | 93 | Same recovery-week time-volume tolerance gap. |

## GPT-5.5 Intelligence-Quality Review

The harness output shows broad persona and scenario variation rather than a tiny happy-path set. The engine now demonstrates profile-sensitive planning, modality-specific structure, schedule reconciliation, adaptation, explainability, and warning deduplication across beginner, hypertrophy, strength, endurance, hybrid, travel, recovery, discomfort, and weak-profile cases.

No P0/P1 evidence of shallow template collapse appeared in this run. The remaining quality issue is narrower: poor-recovery minimum-dose sessions can still be scored as claiming a few minutes more than the estimator believes their content supports. That should remain visible as a P2 quality follow-up, not a release blocker by itself.

## Artifacts

- `reports/training-eval/training-eval-2026-04-28T11-18-03-028Z.json`
- `reports/training-eval/training-eval-2026-04-28T11-18-03-028Z.md`

