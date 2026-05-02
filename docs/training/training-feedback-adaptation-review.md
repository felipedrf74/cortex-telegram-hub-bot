# Training feedback adaptation review

## Reviewed surfaces

- Coach feedback analysis tests exist and passed in full verification chunks.
- Adaptation engine tests exist and passed.
- Training feedback was not modified in this pass.

## Current gap

Feedback-driven future-week adaptation has coverage at service level, but this pass did not manually exercise iOS feedback submission or plan regeneration after feedback. That remains a P2 interaction-smoke gap.

## Recommended next scenarios

- Too easy -> increase progression within safe bounds.
- Too hard -> reduce volume/intensity or add recovery.
- Skipped -> reflow or lower load.
- Soreness/discomfort -> safer substitution and recovery emphasis.
- Too long -> compress future sessions.
- Substitution used -> future exercise choice updates.
