# Full Nexus Cross-Skill Local Smoke Results

Date: 2026-04-28

| Flow | Result | Evidence | Blocker |
| --- | --- | --- | --- |
| Training + Secretary | Basic route smoke passed, rich conflict not fully run | Authenticated smoke covered dashboard, plan, tasks, training, and connections endpoints. | Needs local seeded calendar/task conflict persona. |
| Training + Cooking | Basic route smoke passed, fueling gap not fully run | Authenticated smoke covered current meal plan endpoint. | Needs fueling-gap local seed. |
| Training + Finance | Basic route smoke passed, budget constraint not fully run | Authenticated smoke covered finance monthly summary endpoint. | Needs budget/equipment constraint seed. |
| Training + Content | Basic route smoke passed, workload signal not fully run | Authenticated smoke covered content pipeline and intelligence endpoints. | Needs workload/milestone seed. |
| Shared context scoping | Not fully run locally | Auth/session runner can create one sandbox user. | Needs second-tenant seed and access-denial smoke. |

None of these are marked passed until seed personas and command evidence exist.
