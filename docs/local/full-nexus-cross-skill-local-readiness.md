# Full Nexus Cross-Skill Local Readiness

## Current Local Readiness

| Flow | Local readiness | Notes |
| --- | --- | --- |
| Training reads Secretary schedule | Partial | Backend routes/services exist; rich local conflict seed is still needed. |
| Training writes agenda/calendar requests | Partial | Local internal state/tests exist; real provider writes are staging-only. |
| Secretary/calendar reflow feedback | Partial | Requires seeded conflict windows to prove end-to-end locally. |
| Training reads Cooking/fueling context | Partial | Cooking endpoints exist; fueling-gap seed is pending. |
| Training emits Cooking guidance | Partial | Needs scenario fixture and dedupe assertion. |
| Training reads Finance constraints | Partial | Finance endpoints exist; budget/equipment seed is pending. |
| Training emits Content milestones | Partial | Content routes exist; milestone/context seed is pending. |
| Shared context tenant scoping | Test-backed elsewhere | Needs local multi-tenant seed smoke for full proof. |

## Local vs Staging Boundary

Local smoke should prove orchestration shape, tenant scoping, degraded behavior,
and iOS compatibility. Real Google/Outlook read-back and real external provider
state belong to staging gates.
