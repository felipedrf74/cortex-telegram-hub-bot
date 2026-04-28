# Full Nexus Local Smoke Scenarios

| Scenario | Skills | Expected result | Current automation |
| --- | --- | --- | --- |
| Product health | API/Auth/DB/Cache | Public API and local DB boot successfully. | `scripts/full-nexus-local-engine.sh health` |
| Authenticated iOS API | API/Auth/all skills | Curated `/api/v1` routes return valid envelopes. | `scripts/full-nexus-local-engine.sh smoke` |
| Training normal plan | Training | Plan/today/week endpoints do not crash and degrade honestly when providers are absent. | Partial via authenticated smoke. |
| Constrained week | Training/Secretary | Sessions are capped/reflowed/unscheduled, not impossible. | Needs local seed persona. |
| Agenda lifecycle | Training/Calendar | Create/update/cancel/regenerate are idempotent. | Unit/integration tests; staging provider smoke separate. |
| Training + Secretary | Training/Secretary | Calendar conflicts influence placement. | Needs local seed persona. |
| Training + Cooking | Training/Cooking | Fueling gaps generate one useful warning. | Needs local seed persona. |
| Training + Finance | Training/Finance | Budget/equipment constraints are respected. | Needs local seed persona. |
| Training + Content | Training/Content | Milestones/workload signals are scoped and useful. | Needs local seed persona. |
| Rich iOS Training UI | iOS/Training | Rich payload states render without decode/layout caps. | iOS `rich-v1` fixture tests/simulator smoke. |
| Security/tenant | API/Auth/all skills | Cross-user access denied. | Unit/security suites; local multi-tenant seed pending. |
| Resource control | All | Local services stop and model calls do not loop. | Runner `stop`, `cleanup`, status checks. |
