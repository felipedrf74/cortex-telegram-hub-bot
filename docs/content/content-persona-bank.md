# Content Persona Bank

The persona bank is intentionally workflow-oriented. Each persona represents a realistic Content Creation user state that must be supported without production data.

| Persona ID | User Type | Evaluation Focus |
| --- | --- | --- |
| `solo_creator` | Solo creator | Weekly planning, lightweight references, calendar coordination. |
| `creator_with_references` | Creator with books, links, and channels | Source grounding, no fake citations, reference-aware generation. |
| `strong_voice_creator` | Creator with strong voice profile | Voice consistency, style memory, platform adaptation. |
| `weak_setup_creator` | Creator with weak setup | Safe defaults, targeted setup questions, no hallucinated strategy. |
| `training_milestone_creator` | Creator using Training milestones | Cross-skill signal use, sensitive-signal review, claim safety. |
| `tight_schedule_creator` | Creator with tight schedule | Secretary handoff, capacity-aware plans, realistic cadence. |
| `multi_tenant_brand_creator` | Creator with multiple tenants/brands | Tenant partitioning, brand-safe memory, reference isolation. |
| `tenant_admin_reviewer` | Tenant admin reviewing shared content | Approval gates, provenance review, private draft boundaries. |
| `voice_correction_user` | User correcting voice/style | Correction memory, stale voice downgrade, style updates. |
| `repeat_rejection_user` | User rejecting repeated ideas | Duplicate suppression, novelty scoring, rejection memory. |

## Coverage Requirements

Every release candidate should keep coverage for:

- At least one source-heavy creator.
- At least one weak-context creator.
- At least one multi-tenant or multi-brand creator.
- At least one cross-skill creator.
- At least one user correcting memory or rejecting repeated suggestions.

## Fixture Scope

Personas use synthetic `tenant-*` and `user-*` IDs. References are synthetic and must not be copied from production data.
