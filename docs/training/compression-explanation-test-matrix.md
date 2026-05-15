# Training Compression Explanation Test Matrix

Date: 2026-04-28  
Branch: `feature/training-schedule-compression-explanations`

## Automated Coverage

| Test File | Coverage |
| --- | --- |
| `__tests__/services/coach-kernel-constrained-week-capacity.test.ts` | Constrained-week compression, reflow, unscheduled state, weekly frequency cap, and evidence-bearing decision reasons. |
| `__tests__/services/coach-kernel-decision-trail.test.ts` | Decision-note deduplication, stale auto-note removal, and recovery-driven decision reason surfacing. |

## Regression Cases

| Case | Expected Behavior | Coverage |
| --- | --- | --- |
| Compressed session | Session receives `session_compressed` with before/after duration and source constraint. | Covered. |
| Reflowed session | Session receives `session_reflowed` with original and new day/window evidence. | Covered. |
| Capped weekly frequency | Plan receives `weekly_frequency_capped` when not all sessions fit. | Covered. |
| Unscheduled session | Session and plan reasons include `session_unscheduled`; no fake start/end time is created. | Covered. |
| Recovery-driven volume drop | Plan receives `recovery_volume_reduced` or `recovery_intensity_reduced`. | Covered. |
| Duplicate explanation after rebuild | Stale `Plan adjustment:` notes are removed and rebuilt from current reasons. | Covered. |
| API payload support | Coordinated plan/week/session types include `decisionReasons`. | Covered by typecheck. |

## Validation Commands

```bash
npm run typecheck
npx vitest run '__tests__/services/coach-kernel-constrained-week-capacity.test.ts' '__tests__/services/coach-kernel-decision-trail.test.ts'
```

## Recommended Next Tests

- Route-level response test proving `decisionReasons` survive persistence/read-model serialization.
- iOS rich-payload smoke rendering `decisionReasons` for compressed, reflowed, unscheduled, and recovery-downshifted sessions.
- Calendar staging smoke showing unscheduled/deferred sessions do not create active calendar events.

