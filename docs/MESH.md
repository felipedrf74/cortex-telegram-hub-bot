# Nexus Hub Multi-Skill Mesh

## Status

This mesh layer is feature-flagged behind `NEXUS_MULTISKILL_MESH=on`.

- When the flag is `off`, `/api/v1/plan/*` returns `404`.
- The current iOS app does not consume these endpoints yet.
- That makes the Stage 2 plan API `contract-ready for iOS`, not user-visible today.

## Product-Truth Guardrails

1. The mesh never silently rewrites a day.
2. Cross-skill decisions cite the originating signal in the response.
3. Same-priority collisions become `ConflictNote[]` instead of hidden guesses.
4. Free tier only gets Training + Secretary in the mesh response.
5. Over-cap users still get a deterministic plan, but creative copy is blank and `degraded=true`.
6. If Garmin is stale (`needs_reauth`), the response sets `garmin_stale=true`.

## Priority Systems

Three different ranking systems coexist:

| Field | Purpose |
| --- | --- |
| `SignalPriority` | Existing dispatch urgency on the signal bus (`urgent`, `normal`, `background`) |
| `SkillTier` | Access control (`free`, `pro`, `max`, `owner`) |
| `meshPriority` | Conflict resolution rank for multi-skill planning (`1` highest, `4` lowest) |

Do not merge these concepts.

## meshPriority Rules

- `1` immutable: travel, calendar busy blocks, tax deadlines, sponsor deliverables
- `2` high: rest day, recovery protection, hard budget pressure
- `3` default: training prescription, meal-plan coverage, filming slots, grocery planning
- `4` advisory: inbox pressure, content opportunity, renewals, anomalies

If two directives hit the same `date + target`:

1. Lower meshPriority number wins automatically.
2. Same meshPriority => emit `ConflictNote`.
3. Two meshPriority-1 directives => critical conflict; never auto-resolve.

## Adherence-Gated Aggressiveness

- `< 2 weeks` on plan => `conservative`
- `low_adherence` active => `conservative`
- Garmin stale => `conservative`
- `high_adherence` active **and** trailing 4 weeks >= 90% adherence => `push`
- otherwise => `steady`

## Cache Contract

- Weekly: `plan:week:u:{userId}:{weekStart}`
- Daily: `plan:today:u:{userId}:{date}`
- TTL: `30 min`
- Any newly written `meshPriority=1` signal invalidates both plan prefixes.
