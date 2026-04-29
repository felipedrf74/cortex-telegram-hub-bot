# Content Creation Release Candidate Risk Register

Date: 2026-04-29  
Candidate version: `content@2.3.0-rc.1`

## High Risks

| ID | Risk | Priority | Status | Mitigation |
| --- | --- | --- | --- | --- |
| CONTENT-RC-R1 | Real routed-provider output quality is not sampled | P1 | Open | Run bounded provider smoke or restrict release claim to fixture-proven contracts |
| CONTENT-RC-R2 | iOS does not render full upgraded provenance/lifecycle/approval state | P1 | Open | Do not market rich iOS support; keep current UI compatibility claim only |
| CONTENT-RC-R3 | Portal is not tenant Content power console-ready | P1 | Open | Keep portal scoped to operator/readiness surfaces until tenant-safe write flows exist |
| CONTENT-RC-R4 | Same-user tenant switching is not fully proven | P1 | Open | Do not claim true multi-workspace Content switching |
| CONTENT-RC-R5 | External publishing can create brand/legal risk | P1 | Controlled | Keep publishing disabled or behind explicit approval/audit |

## Medium Risks

| ID | Risk | Priority | Status | Mitigation |
| --- | --- | --- | --- | --- |
| CONTENT-RC-R6 | Sidecar extraction/generation not smoked | P1/P2 depending release scope | Mitigated for fixture-mode script generation | Fixture mode now blanks external keys, blocks AI proxy calls, mocks Reddit, and `/api/v1/script` returned a degraded fixture response; live extraction/provider-quality smoke remains required before live sidecar claims |
| CONTENT-RC-R7 | Content-to-Secretary agenda lifecycle not end-to-end proven | P1/P2 depending release scope | Mitigated for backend ledger handoff | `requestContentScheduleThroughSecretary()` now writes through the Secretary ledger and stores the agenda identity on the Content object; run staging/provider smoke before provider calendar lifecycle claims |
| CONTENT-RC-R8 | Process-wide log redaction not fully audited | P1/P2 depending release scope | Mitigated for audited backend/sidecar sinks | Shared sanitizer now covers durable error/client sinks and identified raw model/provider response logs; require sanitizer coverage for any new sensitive sink |
| CONTENT-RC-R9 | Local fixture provider logs remain confusing | P2 | Closed | Provider registry now initializes deterministic `fixture` routing when local model calls are disabled |

## Lower Risks

- Eval history is document/JSON based rather than normalized DB.
- Portal screenshot/browser automation is not archived.
- Source snippet evidence spans are lightweight.

## Accepted Candidate Scope

This candidate can be reviewed as a backend Content intelligence foundation. It is not a final production GO for full rich iOS, portal, sidecar, live-provider quality, or external publishing.
