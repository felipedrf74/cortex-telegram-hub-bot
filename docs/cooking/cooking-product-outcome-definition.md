# Cooking Product Outcome Definition

Date: 2026-04-30
Branch: `feature/cooking-intelligence-upgrade`
Base: `123d80ea6aa42550fa982443a4f8a772beab15b8`

## Product Goal

Cooking should be the Nexus skill that turns food intent into realistic execution: meals the user can shop for, prep, cook, repeat, adjust, and fit around training, schedule, budget, pantry, dietary constraints, and tenant/user context.

Cooking is not a generic recipe generator. It should behave like a practical meal-planning and kitchen operations assistant.

## Excellent Outcomes

Excellent Cooking responses are:

- Practical: bounded by available time, equipment, groceries, skill level, and fatigue.
- Personalized: uses tenant/user-authorized preferences, allergies, dislikes, favorite patterns, and corrections.
- Schedule-aware: coordinates meal prep, grocery blocks, and constrained days with Secretary.
- Training-aware: supports hard training days, recovery days, travel weeks, and readiness context without medicalizing advice.
- Budget-aware: uses Finance budget signals when available and flags expensive plans.
- Pantry-aware: uses known inventory, avoids expired items, and labels uncertainty.
- Grocery-coherent: shopping lists match meal plans, merge duplicates, and group items usefully.
- Safe: never ignores allergies/restrictions or gives medical diagnosis/treatment advice.
- Explainable: states why meals or swaps were suggested and which constraints mattered.
- Tenant-safe: no meal plan, recipe, pantry, grocery, memory, or prompt context crosses tenants/users.

## Bad Outputs

Bad outputs include:

- Generic recipes disconnected from the user's real week.
- Ignoring allergies, restrictions, disliked foods, or equipment limits.
- Unrealistic prep/cook time for a busy day.
- Grocery lists that do not match the meal plan.
- Expensive suggestions despite budget pressure.
- Training-day meals that ignore fueling/recovery context when that context exists.
- Pantry certainty invented from thin air.
- Repeated meal suggestions without acknowledging intentional reuse.
- Unsupported medical or diet-treatment claims.
- Cross-tenant or cross-user context leakage.

## Workflows To Support

- "What should I eat today based on my schedule?"
- "Plan meals for this week within my budget."
- "Use what I already have."
- "I only have 20 minutes."
- "Avoid this ingredient."
- "Batch cook for the next 3 days."
- "Adjust meals because training changed."
- "Make a grocery list."
- "Schedule meal prep."
- "Why are you suggesting this?"
- "That was for another tenant."

## iOS vs Portal

iOS should prioritize day-to-day use: today/this week meal plan, recipe detail, shopping list, warnings, substitutions, training/fueling notes, and quick corrections.

Portal should be the power surface: preferences, allergies/restrictions, pantry, recipe library, grocery planning settings, memory review, tenant/shared rules, deeper editing, and quality diagnostics.

## Cross-Skill Coordination

- Chat routes day-to-day Cooking requests and preserves multi-turn corrections.
- Secretary owns scheduling for meal prep and grocery blocks.
- Training contributes load/recovery/fueling context.
- Finance contributes budget/spend constraints.
- Content Creation may receive cooking routine/story opportunities only when safe and permissioned.

