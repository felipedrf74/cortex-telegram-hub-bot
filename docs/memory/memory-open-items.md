# Memory Open Items

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## Current Verdict

PASS WITH CONDITIONS for the memory foundation.

The durable skill memory model, service, scope rules, correction handling, version invalidation helper, summaries, and focused tests are implemented. The foundation is not yet wired into every skill prompt builder or UI surface.

## Closed In This Pass

- Added additive `skill_memories` table.
- Added typed `src/services/skill-memory.ts`.
- Enforced tenant/user/scope filters.
- Enforced skill-specific memory boundaries.
- Added confidence and freshness metadata.
- Added correction supersession and correction history.
- Added schema version and related skill version fields.
- Added stale invalidation helper for major releases.
- Added safe memory summary builder.
- Added focused memory tests.

## P1 Open Items

| Item | Why It Matters | Closure Path |
|---|---|---|
| Wire Chat prompt construction to skill memory summaries | Chat should use scoped, fresh, correctable memory instead of ad hoc context | Use `buildSkillMemorySummary()` inside scoped prompt builders |
| Wire Content Creation to voice/source/creative memory | Content is a primary beneficiary and needs tenant-safe brand memory | Read `voice_brand_preference`, `content_creative_preference`, and `source_reference_preference` through service |
| Wire Secretary schedule profile to memory | Secretary planning should learn preferences safely | Read `schedule_preference` for planning and reflow |
| Wire Training/Cooking/Finance preference reads | Domain skills should use their scoped preferences | Add focused read adapters per skill |
| Export/delete retention policy | Memory must obey future privacy/export/delete flows | Add skill_memories to user data export/delete after policy review |
| Admin/support inspection | Support needs metadata without leaking private values | Build redacted portal/admin view with role/audit |

## P2 Open Items

| Item | Why It Matters | Closure Path |
|---|---|---|
| Memory write APIs | Current service exists, but no public route should be added until policy is settled | Add controlled backend-only or owner-gated APIs later |
| Memory quality diagnostics | Need detect stale/low-confidence/unused memories | Add dashboards or release reports from use_count/freshness/confidence |
| Automated major-version invalidation | Manual helper exists | Integrate with skill version activation flow after release process stabilizes |
| More cross-skill signal contracts | Current service supports explicit cross-skill signals | Add typed producers for Training -> Content, Training -> Cooking, Content -> Secretary |

## P3 Open Items

| Item | Notes |
|---|---|
| iOS memory explanation UI | Deferrable until product UX wants "why I remembered this" |
| Tenant admin memory controls | Deferrable until tenant admin model matures |

## Release Gate Notes

- No deployment performed.
- No global unsafe memory added.
- No live model routing behavior changed.
- This pass does not claim full product memory integration yet.

