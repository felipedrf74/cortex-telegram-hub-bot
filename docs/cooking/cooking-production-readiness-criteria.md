# Cooking Production Readiness Criteria

Date: 2026-04-30

Cooking can be promoted only when:

- No unresolved P0 tenant/security/safety issue remains.
- Allergy/restriction tests pass.
- Tenant isolation tests cover recipes, meal plans, shopping lists, pantry, preferences, and memory.
- Cooking tool calls cannot cross tenant/user scope.
- Prompt construction excludes unauthorized Cooking context.
- Meal planning passes practical day-to-day scenarios.
- Secretary scheduling handoff is tested end to end.
- Training and Finance context integrations are tested or documented as unavailable.
- iOS can render returned Cooking states without crashing.
- Portal/admin surfaces do not expose private Cooking data.
- Full local product smoke is archived.
- Live model routing remains provider-agnostic.
- Rollback plan and skill version metadata exist.

