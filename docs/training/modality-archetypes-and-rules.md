# Training Modality Archetypes And Rules

## Strength / Gym

### Session Roles

| Role | Typical Use | Examples |
| --- | --- | --- |
| Lower hypertrophy, quad bias | Hypertrophy users needing lower-body volume without max-strength loading. | Front squat, reverse lunge, calf raise, glute bridge, side plank. |
| Lower hypertrophy, posterior chain | Hypertrophy or hybrid users needing hinge/single-leg posterior work. | RDL, goblet squat, single-leg RDL, carry, dead bug. |
| Upper hypertrophy, push/pull | Upper body volume with stable pressing and pulling. | DB bench, lat pulldown, overhead press, row, hollow hold. |
| Upper hypertrophy, pull/trunk | Pulling volume plus trunk/carry work. | Pull-up, floor press, inverted row, suitcase carry, side plank. |
| Lower max strength | Strength users prioritizing compound lower work. | Front squat, RDL, split squat, carry, core. |
| Upper max strength | Strength users prioritizing heavy press/pull. | Bench, pull-up, overhead press, row, trunk. |
| Unilateral support | Hybrid or strength users needing lower fatigue balance. | Goblet squat, single-leg RDL, reverse lunge, glute bridge. |
| Maintenance | Race/peak/taper or recovery-support strength. | Minimum effective dose with conservative RIR. |

### Prescription Rules

- Hypertrophy uses higher set volume and moderate rests.
- Max strength uses lower rep ranges and longer rests.
- Novices receive lower complexity and more RIR.
- Power-purpose movements use low reps, higher RIR, and technique-first rests.
- Mobility/core/carry work remains lower fatigue and later in the session order.
- Express windows under 30 minutes compact sets/rest while preserving movement-role intent, so short calendar slots remain truthful instead of being inflated by the coherence gate.

## Running

### Archetypes

| Template | Public Session Type | Role |
| --- | --- | --- |
| `run_easy_aerobic` | `easy_run` | Aerobic volume and durability. |
| `run_recovery` | `recovery_run` | Post-load rhythm and recovery. |
| `run_tempo_progression` | `threshold_run` | Controlled aerobic power without max threshold stress. |
| `run_interval` | `interval_run` | VO2 / interval quality. |
| `run_hill_repeats` | `interval_run` | Neuromuscular power and mechanics under controlled uphill load. |
| `run_strides_aerobic` | `easy_run` | Easy support run with relaxed speed mechanics. |
| `run_long` | `long_run` | Weekly endurance anchor. |

### Placement Rules

- Long run remains the weekly endurance anchor.
- Key run rotates across interval, tempo, and hill roles by block week.
- Support runs rotate easy, strides, and recovery.
- Availability-aware day picking is preserved.
- Guardrails still handle readiness, deload, volume growth, and lower-body strength interference.

## Cycling

### Archetypes

| Template | Public Session Type | Role |
| --- | --- | --- |
| `ride_endurance` | `endurance_ride` | Long aerobic anchor. |
| `ride_recovery` | `recovery_ride` | Easy spin after load. |
| `ride_tempo_sweet_spot` | `tempo_ride` | Aerobic power / sweet spot. |
| `ride_threshold` | `threshold_ride` | FTP threshold work. |
| `ride_vo2_over_under` | `vo2_ride` | High-power VO2 / over-under stimulus. |
| `ride_cadence_technique` | `recovery_ride` | Low-fatigue technique support. |

### Placement Rules

- One long endurance ride anchors higher-frequency weeks.
- Key ride rotates threshold, tempo/sweet spot, and VO2 by block week.
- Support rides prefer cadence technique and recovery.
- VO2 remains a key session, not casual filler.
- Availability-aware day picking is preserved.

## Hybrid

Hybrid planning now supports:

- gym + running
- gym + cycling
- running + strength with endurance priority
- cycling + strength with endurance priority
- strength priority with endurance held to maintenance

Hybrid resolution uses:

- `weeklySessionsTarget.running`
- `weeklySessionsTarget.cycling`
- `weeklySessionsTarget.strength`
- `priorityOrder`
- phase
- race proximity
- strength goal

The planner no longer assumes every hybrid endurance user is a runner.

## Backward Compatibility

No new public `SessionType` values were required for this pass. New template IDs provide richer internal archetypes while keeping existing app-facing session-type contracts stable.
