# Training evaluation harness

This pass did not build a new executable harness; it consolidated the required scenario bank for the next automated harness upgrade and added focused regression tests for the highest-risk scenarios.

## Personas

- Beginner gym user.
- Advanced strength user.
- Five-day ABCDE strength user.
- Advanced marathon runner.
- Marathon runner without race date.
- High-volume runner.
- Hybrid strength + marathon user.
- Cyclist.
- Travel/constrained-week user.
- Poor-recovery user.
- Injury/discomfort user.
- Low-adherence user.
- Multiple tenants/users.

## Rubric

- Profile fit.
- Feasibility.
- Progression.
- Variety.
- Time-volume coherence.
- Recovery realism.
- Calendar correctness.
- Explanation quality.
- Feedback adaptation.
- Tenant safety.
- iOS renderability.

## Automated coverage added

- Five-day strength route/enforcement/engine/fallback.
- Marathon missing race date.
- Advanced marathon scenario with long run and five distinct strength sessions.
