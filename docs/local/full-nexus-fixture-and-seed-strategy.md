# Full Nexus Fixture and Seed Strategy

## Principle

Use the real local product engine where behavior matters, deterministic fixtures
where UI/contract rendering matters, and staging providers only when provider
read-back is the point.

## Local Data Sources

| Source | Use for | Notes |
| --- | --- | --- |
| Local sandbox user via `/auth/register` | Authenticated API and iOS simulator smoke | Created from `IOS_INVITE_CODE`; no production data. |
| Local SQLite DB | Tenant/user/session/cache state | Defaults to `data/local-full-nexus-smoke.db`. |
| Deterministic Training iOS fixture `rich-v1` | Rich frontend states and unknown block fallback | Avoids repeated model calls during simulator smoke. |
| Backend generation | Training/coaching behavior smoke | Use blank model keys for deterministic/degraded shape checks; opt in to model calls only for quality review. |
| Local mock calendar/agenda state | Lifecycle/idempotency tests | Real Google/Outlook writes remain staging-only. |
| Staging provider credentials | Real provider gates | Must never point at production calendars. |

## Seed Personas

The local environment should maintain these test personas over time:

| Persona | Purpose |
| --- | --- |
| Local normal user | Basic Home/Secretary/Training/Cooking/Finance/Content smoke. |
| Local tenant admin | Owner/admin route and scope smoke. |
| Second local tenant user | Cross-tenant isolation checks. |
| Weak Training profile user | Follow-up prompt and conservative planning checks. |
| Travel/constrained user | Capacity reconciliation and unscheduled state checks. |
| Poor-recovery user | Recovery adaptation and guidance dedupe checks. |
| Rich feedback user | Feedback-loop/adaptation checks. |

## Fixture Coverage Required

- normal Training plan
- constrained/travel week
- capped, reflowed, unscheduled, canceled, superseded sessions
- regenerated plan
- gym-heavy, running, cycling, and hybrid weeks
- poor-recovery week
- weak-profile follow-up prompts
- rich feedback submission
- schedule-compression explanations
- Secretary schedule conflict
- Cooking fueling gap
- Finance equipment/budget constraint
- Content workload signal
- tenant isolation and unauthorized mutation cases

## Current Gap

The runner can create a local sandbox user and run authenticated API smoke.
Dedicated seed scripts for every persona/context above are still needed for a
fully automated full-product scenario bank.
