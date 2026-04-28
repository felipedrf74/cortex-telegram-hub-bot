# Adherence and Minimum-Dose Specification

## Goal

Training quality drops when the coach keeps prescribing full sessions to users who are missing sessions, losing time, or reporting workouts as too long. This spec defines the minimum-effective-dose behavior added to the Coach kernel.

## When Minimum Dose Applies

The engine can compress strength sessions when the feedback analysis detects:

- poor adherence or re-entry state
- repeated missed sessions
- declared high time constraint
- feedback that sessions are taking too long
- travel/time-loss feedback tags

## Strength Minimum-Dose Rules

For a strength session:

- Re-entry weeks keep the first 2 highest-priority exercises.
- Low-time or too-long weeks keep up to 3 exercises.
- Sets are capped at 2.
- RIR is raised to at least 3.
- Rest is capped to 75 seconds for the first lift and 60 seconds after that.
- Duration is capped to 20 minutes for re-entry and 25 minutes for low-time/too-long compression.
- The session receives `minimum_effective_dose` and `adherence_realistic` tags.
- The session adds a user-facing alternative: if time is still tight, do the first exercise plus one core movement.

## Why This Is Better

This avoids the fake-coach pattern of "same workout, smaller number in the header." The prescription itself is changed so the workload is actually finishable. The user gets a clear, repeatable fallback instead of a session they are likely to abandon halfway through.

## Non-Goals

- This does not replace the full progression engine.
- This does not apply medical advice.
- This does not permanently downgrade the user's training level.
- This does not remove higher-quality full sessions when adherence and time are healthy.

## Files Changed

- `src/services/coach-kernel/feedback-analysis.ts`
- `__tests__/services/coach-kernel-feedback-analysis.test.ts`

