# Training Production Monitoring Checklist

Date: 2026-04-28

Monitor the following after deployment:

## Training Engine

- Plan generation failures and latency.
- Constrained-week sessions marked unscheduled/capped/reflowed.
- Recovery-week variation and repeated warning counts.
- Weak-profile follow-up prompt emission.
- Feedback submission errors.

## Calendar / Agenda

- Google/Outlook create/update/delete failures.
- Duplicate event detection by plan/session identity.
- Stale canceled/superseded plans shown as active.
- Ownership rows without provider events.
- Provider auth refresh failures.

## Cross-Skill

- Secretary conflict signals influencing Training schedules.
- Cooking fueling guidance duplication.
- Finance constraint visibility.
- Content milestone/workload signal scoping.
- Cross-tenant/user signal leakage or unexpected user IDs.

## Model / Resource Control

- Model/provider timeout and fallback rates.
- Nightly coach analysis failures.
- Cost/latency spikes.
- Any repeated generation loop or runaway worker.

## iOS Compatibility

- Training payload decode/render errors.
- Feedback submission failures.
- Stale active plan after cancel/regenerate.
- Missing lifecycle labels for capped/reflowed/unscheduled/canceled/superseded sessions.

## Security / Privacy

- Unauthorized Training mutation attempts.
- Cross-user/cross-tenant access denials.
- Sensitive profile, injury/discomfort, sex/gender, and feedback data in logs.
