# Training Evaluation Persona Bank

The persona bank is the stable set of synthetic athletes used by the Training coach benchmark. Personas are intentionally broader than the known screenshot regressions so the engine cannot pass by hardcoding one plan shape.

Source of truth: `src/services/coach-kernel/evaluation/personas.ts`.

## Coverage Goals

- Gym-only, running-only, cycling-only, and hybrid users.
- Beginner, intermediate, and advanced training ages.
- Full gym, dumbbell-only, and travel/hotel-gym contexts.
- Low-time and inconsistent-adherence constraints.
- Explicit discomfort and substitution pressure.
- Swim/triathlon and race-prep coverage with pool, bike, run, and support
  strength expectations.
- Explicit sex/gender-aware context only when user-provided and relevant.

## Personas

| ID | Category | Coaching Story | Key Expectations |
| --- | --- | --- | --- |
| `beginner-gym-dumbbells` | strength | New lifter with dumbbells and short lunch windows. | Strength-only, 2-4 sessions, avoid barbell/rack work. |
| `intermediate-hypertrophy-full-gym` | strength | Four-day full-gym hypertrophy user. | Exactly 4 strength sessions with enough work density. |
| `advanced-strength-focused` | strength | Advanced lifter prioritizing max strength. | Four strength sessions with credible barbell-friendly structure. |
| `runner-half-marathon` | running | Half-marathon runner with one support strength day. | 4+ runs, no more than 1 strength session, long/quality run coverage. |
| `cyclist-ftp-build` | cycling | Cyclist building FTP with trainer access. | 3+ cycling sessions, no more than 2 strength sessions. |
| `hybrid-gym-running` | hybrid | User who prefers morning runs and lunch strength. | Running plus strength, supports up to 2 sessions/day. |
| `hybrid-gym-cycling` | hybrid | User mixing cycling and strength. | Cycling plus strength, differentiated hybrid week. |
| `triathlon-swim-bike-run-race-prep` | triathlon | Sprint-triathlon user with pool access, bike/run targets, and one support strength window. | Swim, bike, run, and strength must all appear without over-scheduling race-prep week. |
| `low-time-user` | constraints | Busy user with three 35-minute windows. | Compressed plan, no two-a-days, no overfilled sessions. |
| `inconsistent-adherence-user` | adherence | Recent misses and lower compliance. | Realistic load, fewer key sessions, no catch-up stacking. |
| `equipment-limited-home` | equipment | Home user with dumbbells only. | Avoid barbell/rack assumptions. |
| `travel-week-hotel-gym` | travel | Travel week with hotel gym and reduced windows. | Hotel-gym-safe plan, short sessions, no stale full-gym assumptions. |
| `discomfort-knee-limitation` | safety | Strength user with knee discomfort. | Exercise choices must respect pain flags. |
| `explicit-cycle-aware-user` | personalization | Advanced runner who opted into cycle-aware planning context. | Running-primary output, explicit context used carefully and only because it was provided. |

## Extension Rules

- Add personas for durable user populations, not one-off bugs.
- Keep each persona's `AthleteState` internally coherent.
- Store expected sports and high-level bounds in `expectations`; avoid exact exercise snapshots.
- If adding sensitive context, include it only when explicit user-provided data exists.
- If a persona exposes a known production risk, add a matching scenario or rubric check instead of embedding hidden pass/fail logic in the persona.
