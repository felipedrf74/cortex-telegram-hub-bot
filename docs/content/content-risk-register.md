# Content Risk Register

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

| ID | Severity | Risk | Status | Mitigation |
|---|---:|---|---|---|
| CONTENT-P0-001 | P0 | Cross-tenant leak through Content references, memory, generated artifacts, or prompt context | Open until tenant model and tests exist | Enforce tenant/user scope before retrieval and prompt construction; add tenant isolation tests |
| CONTENT-P0-002 | P0 | Unauthorized source or memory included in provider prompt | Open | Build scoped context/source selector before model calls; test fallback paths |
| CONTENT-P0-003 | P0 | Portal/admin Content surface exposes private tenant/user content | Open | Keep founder/platform-only until explicit roles, audit, and tenant policy exist |
| CONTENT-P1-001 | P1 | Direct fixed-provider Content AI path bypasses live routing | Partially closed | Dedup fixed; discovery fallback still needs central routing or documented provider-specific tests |
| CONTENT-P1-002 | P1 | Tenant/user metadata missing from some Content model-call observability | Partially closed | Internal proxy accepts metadata and script path forwards user_id; tenant_id flow remains open |
| CONTENT-P1-003 | P1 | Source/provenance is incomplete | Open | Add unified source registry and source ledger on artifacts |
| CONTENT-P1-004 | P1 | Links are not first-class references | Open | Add link source model with extraction and prompt-injection safety metadata |
| CONTENT-P1-005 | P1 | Content scheduling bypasses Secretary arbitration | Closed for backend live action path | `schedule_content` now routes through Secretary with agenda identity and feedback; provider/iOS claims remain separate |
| CONTENT-P1-006 | P1 | Id-only mutations can be unsafe if reused in app paths | Partially closed | Workflow helpers improved; channel/admin helpers still need explicit ownership contracts |
| CONTENT-P1-007 | P1 | Content artifact lifecycle is fragmented | Open | Introduce versioned lifecycle across ideas/topics/scripts/pipeline |
| CONTENT-P1-008 | P1 | Skill memory and version tracking are missing | Open | Add per-skill capability/version/test/open-item ledger |
| CONTENT-P1-009 | P1 | Quality evaluation is missing | Open | Add scenario/rubric/eval harness |
| CONTENT-P1-010 | P1 | iOS cannot represent source/lifecycle/novelty states | Open | Extend DTOs and rendering after backend contracts are stable |
| CONTENT-P2-001 | P2 | Static creator assumptions cause generic or founder-shaped output | Open | Replace with versioned creator profile and targeted follow-ups |
| CONTENT-P2-002 | P2 | Duplicate detection is too narrow | Partially improved | Expand from idea dedup to artifact, angle, hook, caption, and repurpose novelty |
| CONTENT-P2-003 | P2 | Cross-skill opportunity detection is shallow | Open | Add typed scoped summaries from Training/Cooking/Finance/Secretary |
| CONTENT-P2-004 | P2 | Content notifications do not deep-link to exact artifact | Partially closed | Backend resolver API exists and is tested; add iOS/portal routing |
| CONTENT-P2-005 | P2 | Provider metadata and source usage are not visible enough per artifact | Open | Add artifact-level provider/source/quality metadata |
| CONTENT-P3-001 | P3 | Documentation/comments can drift toward fixed-provider wording | Partially improved | Keep docs provider-agnostic and add routing tests |

## Release-Copy Guardrails

- Do not claim Content is fully tenant-safe until tenant-owned source/reference/memory tests pass.
- Do not claim Content uses GPT-5.5, Claude, Gemini, or any single model as fixed runtime.
- Do not claim source-grounded output unless the artifact carries source lineage.
- Do not claim Content schedules intelligently until Secretary intent arbitration is implemented and tested.
- Do not claim iOS/portal readiness for richer states until those clients render them.

## Immediate Posture

No deployment is approved. Current work is a feature-branch workstream with rollback protection. Earlier safe hardening closed several P1 hazards, but the product remains NO-GO for a production Content intelligence release until P0/P1 items above are closed or explicitly accepted.
