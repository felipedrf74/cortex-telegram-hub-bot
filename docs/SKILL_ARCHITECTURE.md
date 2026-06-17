# Nexus Hub Skill Architecture

Status: canonical
Owner: backend skills lead (Felipe)
Last verified: 2026-06-16
Update policy: update when `src/skills/skill-config.ts`, skill-manager startup,
sub-skill dependency enforcement, entitlement gating, or runtime skill loading
rules change.

## Current Model

Nexus Hub currently ships with built-in skills, not a blank marketplace core.
The runtime uses a declarative skill/sub-skill catalog plus database-backed
enablement state:

- `src/skills/skill-config.ts` is the source of truth for built-in skill
  definitions, routes, sub-skills, tool ownership, prompt files, dependencies,
  and minimum tiers.
- `src/skills/skill-manager.ts` seeds default skills into `installed_skills`,
  preserves user/operator toggles, filters tools by enabled sub-skills, enforces
  dependency checks, and invalidates cached tool arrays on toggle changes.
- `src/skills/registry.ts` stores installed skills and submodules in SQLite.
- `src/skills/prompt-validator.ts` verifies prompt files declared by the
  catalog during startup validation.
- `src/skills/credentials.ts` stores skill-scoped credentials.
- Portal skill routes expose operator/admin toggles; entitlement logic in
  `src/services/entitlement.ts` gates skills by plan/tier.

## Built-In Skills

Current `DEFAULT_SKILLS`:

| Skill | Purpose | Tier posture |
| --- | --- | --- |
| `secretary` | Tasks, calendar, email, reminders, notes, briefings, operational follow-through. | Free baseline with sub-skill toggles. |
| `triathlon` | Training plans, sport personas, Garmin/Health data, readiness, coach feedback. | Plan/tier gated by sub-skill. |
| `content` | Content radar, ideas, scripts, editorial workflow, scheduling. | Plan/tier gated by sub-skill. |
| `finance` | Financial reminders, categorization, taxes/bills/subscription review. | Plan/tier gated by sub-skill. |
| `cooking` | Meal planning, recipes, pantry, preferences, nutrition-adjacent cooking support. | Plan/tier gated by sub-skill. |
| `connections` | Provider integration health and reconnection guidance. | Free platform skill. |
| `notifications` | APNs, notification preferences, delivery state, notification intents. | Free platform skill. |
| `decision_center` | Choices, dismissals, snoozes, follow-ups for high-stakes decisions. | Free platform skill. |

`connections`, `notifications`, and `decision_center` are platform skills.
Their current action surface is mostly owned by deterministic routes and the
chat-action registry rather than the legacy Anthropic tool-call array.

## Routing And Tool Ownership

Each skill definition owns:

- command/pattern routes,
- keyword route hints,
- classifier examples,
- sub-skill names and descriptions,
- legacy tool names where that skill still exposes Anthropic tools,
- optional cron job ownership,
- dependency edges between sub-skills,
- optional prompt-file/persona mapping,
- minimum tier requirements.

Do not add a tool directly to a domain handler without also updating the skill
definition that owns it. Do not add user-visible skill behavior without checking
entitlement and sub-skill toggles.

## Skill Toggles

Runtime toggle rules:

1. Startup calls seed built-in skills into `installed_skills`.
2. Existing enabled/disabled state is preserved during reseed.
3. New sub-skills are added with their default enablement.
4. Enabling a sub-skill validates declared dependencies.
5. Disabling a dependency cascade-disables dependent sub-skills.
6. Tool arrays are cached by domain and invalidated after toggle changes.

If a known skill is absent from the DB, registry helpers fall back to the
declarative defaults for sub-skill checks. Unknown skills stay disabled.

## Entitlements

Access is controlled at two levels:

- `requiredTier` on the parent skill or sub-skill.
- Plan-level allowed skills and per-skill caps from `plan_configs`.

Owner users can bypass allowed-skill limits for internal/admin workflows, but
ordinary users must only see and execute skills allowed by their plan. Any new
route, tool, or portal surface that exposes a skill must preserve this rule.

## Prompts And Manifests

Prompt files declared in `skill-config.ts` are runtime inputs and must stay
neutral, tenant-safe, and present on disk.

`src/skills/<skill>/manifest.json` files still exist and `src/skills/loader.ts`
can validate/load them when called directly. They are **not** currently the
primary production startup catalog. Treat manifest loading as a maintenance or
future-runtime path unless a startup import is intentionally added and tested.

## Extension Rules

When adding or changing a skill:

1. Update `src/skills/skill-config.ts`.
2. Add or update sub-skill prompt files if referenced.
3. Update entitlement and plan config expectations if tier access changes.
4. Add focused tests for routing, tool filtering, dependency behavior, and
   tenant/entitlement isolation.
5. Update iOS/API docs if the change affects native DTOs or visible skill
   surfaces.
6. Update release gate docs if the change adds a new required smoke or check.

## Known Gaps

- Manifest files are not the canonical startup source yet.
- Marketplace install/publish/revenue flows are not current product reality.
- Some older chat-action and legacy tool surfaces still overlap; keep the
  action registry, capability registry, and skill catalog in sync when moving
  behavior between deterministic actions and tool calls.
