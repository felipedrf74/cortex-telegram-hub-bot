# Content Creation Production Readiness Criteria

Date: 2026-04-29  
Candidate version: `content@2.3.0-rc.1`

## Required For Backend Candidate

| Criterion | Status | Evidence |
| --- | --- | --- |
| Not on main/master/production | PASS | Branch `release/content-creation-production-candidate` |
| Rollback protection exists | PASS | `backup/content-before-production-hardening-*` branch/tag |
| No unresolved backend P0 security blocker | PASS | Security tests and red-team docs pass |
| Tenant-safe reference retrieval | PASS | `content-tenant-scope.test.ts`, `content-security-red-team.test.ts` |
| Tenant-safe creative memory | PASS | `skill-memory.test.ts`, `content-memory-profile.test.ts` |
| Unauthorized prompt context excluded before provider call | PASS | `content-generation-quality.test.ts`, `content-security-red-team.test.ts` |
| Fake citations/unsupported claims flagged | PASS | `content-reference-provenance.test.ts`, `content-generation-quality.test.ts` |
| Publishing/scheduling/destructive approvals | PASS | `content-editorial-workflow.test.ts`, `content-security-red-team.test.ts` |
| Content lifecycle/workflow states covered | PASS | `content-editorial-workflow.test.ts` |
| Content Radar backend scoring covered | PASS | `content-radar-engine.test.ts` |
| Duplicate/novelty/reuse backend controls covered | PASS | `content-novelty-reuse.test.ts` |
| Cross-skill Content signal contracts covered | PASS | `content-cross-skill-orchestration.test.ts` |
| Day-to-day quality evaluation exists | PASS | `npm run eval:content`, score 91/100 |
| Eval history is persistable/queryable | PASS | `096_content_eval_history.sql`, `--persist-db`, latest local DB run 91/100 with 15 cases |
| One-command local Content smoke runner exists | PASS WITH CONDITIONS | `npm run smoke:content:local`; full local backend wrapper path validated, rich iOS workflow smoke still separate |
| Portal backend Content writes are tenant-scoped | PASS WITH CONDITIONS | Links/books/channels/manual Voice DNA admin write routes require explicit user/tenant scope; legacy portal write bypasses return `SCOPED_V1_REQUIRED`; portal browser UX remains open |
| Skill version registry updated | PASS | `content@2.3.0-rc.1` candidate record |
| Typecheck/lint/build pass | PASS | `npm run typecheck`, `npm run lint`, `npm run eval:content` build |
| Full local product smoke completed or blockers documented | PASS WITH CONDITIONS | `docs/local/content-full-nexus-local-smoke-results.md` |

## Required Before Production Promotion

- Fresh production DB snapshot immediately before deploy.
- Exact RC deployed to staging.
- Focused staging Content smoke passes.
- P1 conditions in `content-production-open-blockers.md` are fixed or explicitly accepted.
- Monitoring is configured for Content generation, reference retrieval, provenance review warnings, approval blocks, provider fallback, and tenant authorization failures.

## Required Before Full Rich Product Claim

- Rich iOS Content workflow implementation and simulator smoke.
- Tenant-safe portal Content UI/workflows and browser smoke. Backend write routes are scoped/blocked where unsafe; tenant-facing console UX remains incomplete.
- Same-user tenant switching smoke for Content references, voice memory, drafts, and local cache.
- Bounded live provider quality sample with synthetic data and provider/model/tier/category/cost metadata.
- Live Content-engine sidecar extraction/provider-quality smoke. Fixture-mode sidecar script generation is covered by the local `/api/v1/script` smoke.
- Provider-backed Content calendar staging proof and rich frontend schedule-state rendering. Backend Content scheduling through the Secretary agenda ledger/local mock is covered by `content-editorial-workflow.test.ts`, `content-editorial-routes.test.ts`, and `secretary-scheduling-arbitrator.test.ts`.

## Release-Copy Constraints

Approved release wording may claim:

- Backend Content Creation intelligence foundations are candidate-ready.
- Tenant-safe references, memory, provenance, workflow, radar, novelty, and deterministic eval foundations are tested.
- Live model routing remains provider-agnostic and operator-configurable.

Do not claim yet:

- Full rich iOS Content readiness.
- Tenant-facing portal Content power console readiness.
- Live provider output quality across all routed providers.
- True same-user multi-tenant Content workspace switching.
- Live sidecar source extraction quality.
- External publishing readiness.
- Provider-backed Content calendar lifecycle proof beyond the backend Secretary ledger handoff.
