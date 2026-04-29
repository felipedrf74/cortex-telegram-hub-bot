# Content Memory Open Items

Updated: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Current Verdict

PASS WITH CONDITIONS for the backend Content memory/voice foundation.

## Still Open Before Production Release

| Priority | Item | Closure Requirement |
| --- | --- | --- |
| P1 | Brand/profile management API | Add permissioned API routes for editing tenant-shared brand profiles and user-private voice preferences. |
| P1 | iOS profile editing/readiness | iOS must render/edit voice, brand, platform, corrections, and missing-profile prompts without leaking tenant data. |
| P1 | Portal tenant controls | Portal/admin must expose profile diagnostics without raw private drafts or user-private style unless role/policy allows it. |
| P1 | End-to-end generation proof | Run local full-product smoke showing Content script generation receives scoped creative memory and not stale/cross-tenant memory. |
| P2 | Automatic performance learning policy | Define how high/low performance thresholds promote memories without overfitting. |
| P2 | Memory quality dashboard | Show completeness/confidence/staleness per tenant/brand without exposing sensitive profile text by default. |
| P2 | Cross-skill signal review | Define which Training/Secretary/Cooking/Finance signals may influence content and when approval is required. |

## Closed In This Pass

- Content voice/profile facts are stored in the typed `skill_memories` ledger.
- Tenant and user scopes are enforced by the shared memory retrieval layer.
- User-private memory is omitted from tenant-shared output unless explicitly allowed.
- Corrections supersede stale voice/profile facts.
- Platform-specific voice is applied only for the target platform.
- Successful and rejected patterns can influence suggestions without hardcoded templates.
- Script generation now receives the scoped creative-profile context block.
