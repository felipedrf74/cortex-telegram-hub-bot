# Full Nexus Local Smoke Personas

| ID | Persona | Required local state | Smoke focus |
| --- | --- | --- | --- |
| `local-normal` | Normal active user | Sandbox auth session, max trial entitlement | Home, Settings, basic skill endpoints. |
| `local-admin` | Tenant/admin user | Owner code or scoped portal session | Admin/user-scope routes. |
| `local-tenant-b` | Second tenant user | Separate auth session and fixtures | Cross-tenant isolation. |
| `training-weak-profile` | Incomplete Training profile | Missing equipment/duration/modality priority | Follow-up prompts and conservative plan. |
| `training-travel` | Travel week user | Limited windows, hotel/bodyweight equipment | Capacity reconciliation. |
| `training-poor-recovery` | Low readiness user | Sleep/recovery/fatigue signals | Recovery variation and safety. |
| `training-rich-feedback` | User with prior feedback | Completion, partial, skipped, RPE, soreness | Adaptation and feedback mapping. |
| `secretary-conflict` | User with schedule pressure | Calendar/task blocks in busy windows | Training reflow/cap/unscheduled states. |
| `cooking-gap` | User with training load but no fueling | Meal plan gap | Deduped fueling guidance. |
| `finance-limited` | Budget/equipment constrained user | Finance/equipment constraints | Equipment-aware plan choices. |
| `content-heavy` | High content workload user | Content workload signal | Training workload awareness. |

These personas are the target bank for durable local smoke. The initial runner
creates `local-normal`; the remaining personas need seed tooling before they
can be marked automated.
