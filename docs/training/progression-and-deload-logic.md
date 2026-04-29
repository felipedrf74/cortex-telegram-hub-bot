# Progression and Deload Logic

## Progression Principles

Progression is now driven by a combination of:

- Recent RPE/RIR.
- Completion quality.
- Adherence.
- Recovery/readiness.
- Session duration realism.
- Training-history trend by sport.

The engine progresses only when evidence supports it. It holds or downshifts when the evidence is unclear or negative.

## Build State

The engine enters a build posture when:

- Adherence is strong.
- Readiness is ready.
- Recent sessions are balanced or too easy.
- Soreness is not high.
- There are no repeated missed key sessions.

Current implementation:

- Strength sessions add a set to early priority exercises and reduce RIR modestly.
- Endurance sessions can receive a small duration increase.
- Plan notes include the feedback-loop reason.

## Hold State

The engine holds when:

- Adherence is steady but not strong.
- Readiness is watch-level.
- Difficulty feedback is balanced.
- There is not enough data for stronger decisions.

Hold is intentionally conservative. It avoids pretending that missing evidence equals readiness to progress.

## Deload State

The engine enters a deload posture when:

- Readiness is critical or strained.
- Average soreness is high.
- Recent RPE indicates repeated overreach.
- Pain tags appear in feedback.

Current implementation:

- Weekly phase shifts to `deload`.
- Duration, volume, and intensity multipliers are reduced.
- Key-session flags are softened.
- Threshold/VO2 work is downshifted toward aerobic work.
- Notes explain the reason.

## Re-Entry State

The engine enters re-entry when:

- Trailing adherence is broken.
- Consecutive misses are high.
- Multiple recent sessions are skipped or partial.
- A key session was missed.

Current implementation:

- Weekly session targets are reduced by one per affected sport when possible.
- Max sessions per day is capped at 1.
- The block phase shifts to maintenance instead of trying to catch up aggressively.

## Variation State

The engine triggers variation when:

- A sport has a flat trailing four-week volume trend.
- Adherence is good enough that the plateau is not simply non-compliance.

Current implementation:

- Affected sport sessions receive `plateau_variation` tags.
- Titles and alternatives signal variation while preserving the session role.

## Safeguards

- The feedback layer emits typed decisions before changing output.
- Existing guardrails still run after feedback decisions.
- Multipliers are bounded to prevent extreme swings.
- Recovery and adherence decisions win over progression decisions.

## Future Extensions

- Per-lift progression using `progression-analytics.ts`.
- Per-run pace progression and plateau detection.
- Cycling FTP/power-zone progression.
- More explicit user feedback fields from iOS: too hard, too easy, too long, pain, substituted exercise, time lost.
