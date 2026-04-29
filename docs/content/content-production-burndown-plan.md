# Content Creation Production Burndown Plan

Date: 2026-04-29  
Branch: `release/content-creation-production-candidate`  
Candidate version: `content@2.3.0-rc.1`  
Deployment: not performed

## Executive Summary

Content Creation has enough backend foundation to become a release candidate for a scoped backend/intelligence release, not a full rich iOS/portal product launch.

No unresolved backend P0 was found in this hardening pass. Cross-tenant reference leakage, cross-tenant voice leakage, unauthorized prompt context, fake citations, approval bypass, and Content security red-team cases are covered by focused tests.

Several P1 conditions remain and must be accepted explicitly before production promotion. They mostly concern release claims outside the deterministic backend fixture path: real routed-provider quality sampling, deep iOS Content workflow smoke, tenant-facing portal UI/browser workflows, and true same-user tenant switching proof.

## P0 Production Blockers

| ID | Item | Status | Evidence |
| --- | --- | --- | --- |
| CONTENT-P0-01 | Cross-tenant reference leakage | Closed | `content-tenant-scope.test.ts`, `content-security-red-team.test.ts` |
| CONTENT-P0-02 | Cross-tenant voice profile leakage | Closed | `content-memory-profile.test.ts`, `content-security-red-team.test.ts` |
| CONTENT-P0-03 | Unauthorized draft access | Closed for backend scope helpers/routes tested | `content-workflow-user-scope.test.ts`, `content-editorial-workflow.test.ts` |
| CONTENT-P0-04 | Unauthorized publishing/scheduling | Closed for workflow gates | `content-editorial-workflow.test.ts`, `content-security-red-team.test.ts` |
| CONTENT-P0-05 | Fake citations/fake provenance | Closed for claim review path | `content-reference-provenance.test.ts`, `content-generation-quality.test.ts`, `content-security-red-team.test.ts` |
| CONTENT-P0-06 | Model prompt receives unauthorized references | Closed for Content generation package | `content-generation-quality.test.ts`, `content-security-red-team.test.ts` |
| CONTENT-P0-07 | Memory leakage across tenant/user | Closed for skill memory foundation tests | `skill-memory.test.ts`, `content-memory-profile.test.ts` |
| CONTENT-P0-08 | Destructive workflow actions without permission | Closed for Content workflow approval evaluator | `content-editorial-workflow.test.ts`, `content-security-red-team.test.ts` |
| CONTENT-P0-09 | Security red-team failure | Closed | 7/7 focused red-team tests passed |

## P1 Must Fix Or Explicitly Accept

| ID | Item | Classification | Current Status | Release Decision |
| --- | --- | --- | --- | --- |
| CONTENT-P1-01 | Missing skill version metadata | Must-fix | Fixed | `content@2.3.0-rc.1` registered as candidate in migration `095` |
| CONTENT-P1-02 | Real routed-provider quality sampling not run | Must-fix for provider quality claims | Open | Accept only if release copy says fixture quality passed and live provider quality remains staging condition |
| CONTENT-P1-03 | Deep iOS Content workflow smoke not complete | Must-fix for rich iOS launch | Open | Accept only if iOS is described as compatible with current Content UI, not full upgraded Content intelligence |
| CONTENT-P1-04 | Tenant-facing portal Content console not complete | Must-fix for tenant-facing portal launch | Backend safer but UI/product open | Links, books, channels, and manual Voice DNA admin writes now require explicit tenant/user scope; legacy portal write bypasses are disabled. Accept only if portal remains operator/readiness surface until browser-smoked tenant workflows and agent settings are complete |
| CONTENT-P1-05 | Same-user tenant switching proof partial | Must-fix for multi-workspace release claim | Open | Accept only if release does not claim true same-user multi-tenant Content switching |
| CONTENT-P1-06 | Content-engine sidecar smoke not run | Must-fix for extraction/generation sidecar claims | Fixed for fixture-mode script sidecar | Added fixture-mode guards and smoked `/api/v1/script`; live extraction/provider quality remains a separate claim |
| CONTENT-P1-07 | Content-to-Secretary scheduling is contract-level, not full agenda proof | Must-fix for calendar lifecycle claim | Fixed for backend ledger handoff | `requestContentScheduleThroughSecretary()` now writes through Secretary and stores the returned agenda identity on Content objects; provider/iOS staging claims remain out of scope |
| CONTENT-P1-08 | Process-wide log redaction not fully proven | Must-fix for audited backend privacy claim | Fixed for audited backend/sidecar sinks | Shared `log-sanitizer` now protects durable `error_log`, `client_errors`, categorized agent errors, Sentry/operator-alert forwarding, telemetry summaries, and client-error ingestion. Python Content Engine, Content workflow, Training plan parsing, and finance vision parse-failure logs no longer emit raw model/provider response previews. |

## P2 Should Fix

| ID | Item | Status |
| --- | --- | --- |
| CONTENT-P2-01 | Add first-class no-op fixture provider path to remove confusing local fallback logs | Fixed |
| CONTENT-P2-02 | Persist Content eval run history in registry/report artifacts | Fixed |
| CONTENT-P2-03 | Add automated Content full local smoke runner | Fixed |
| CONTENT-P2-04 | Add richer evidence span IDs for source snippet claim mapping | Open |
| CONTENT-P2-05 | Add portal dashboard for Content eval/source/provenance trends | Open |

## P3 Deferrable

- Browser-driven portal smoke screenshots.
- Published-content analytics fixtures.
- Podcast/carousel/newsletter rubric calibration.
- Dynamic plugin skill release metadata generation.

## Safe Fixes Completed In This Pass

- Added migration `095_content_creation_production_candidate_version.sql`.
- Registered Content Creation candidate `content@2.3.0-rc.1` without activating it.
- Added skill-version regression test for the candidate record.
- Closed the backend Content-to-Secretary agenda ledger proof: Content schedule requests now submit to Secretary, persist `secretary_agenda_item_id`, and record Secretary decision metadata in the Content workflow event log.
- Closed the fixture-mode Content-engine sidecar smoke: sidecar startup and `/api/v1/script` returned a provider-free degraded fixture response, with explicit fixture guards for external keys, AI proxy calls, and unauthenticated Reddit search.
- Closed the audited sensitive-log risk by expanding structured logger redaction, adding durable sink sanitization, removing raw model/provider response previews from identified TypeScript and Python paths, and adding focused sanitizer/log-sink tests.
- Closed local fixture-provider startup noise: provider routing now uses a deterministic `fixture` provider when local model calls are disabled, preserving provider-agnostic routing while avoiding false direct-Anthropic fallback warnings.
- Added tenant/user-scoped backend portal APIs for Content reference links (`GET/POST/DELETE /api/v1/admin/content/links`) with focused auth/scope tests; full portal power-console readiness remains open.
- Hardened remaining backend portal Content write surfaces: books, channels, and manual Voice DNA mutations now require explicit user/tenant scope; scoped channel add carries tenant metadata; scoped book extraction avoids global `book_knowledge` bus writes; tenant-scoped voice synthesis is blocked until the agent accepts explicit scope; legacy `/api/books` and `/api/channels` mutations now return `SCOPED_V1_REQUIRED`; unscoped portal reads are limited to platform/system seed content.
- Added normalized Content eval history persistence: migration `096_content_eval_history.sql`, `src/services/content-eval-history.ts`, and `--persist-db` support in `npm run eval:content`; latest local fixture eval persisted a 91/100, 15-case `PASS_WITH_CONDITIONS` run into `reports/content-eval/content-eval-history.sqlite`.
- Added the one-command Content local smoke wrapper `scripts/content-full-nexus-local-smoke.sh` plus `npm run smoke:content:local`; validated full local backend wrapper path through backend start, API smoke, cross-skill fixtures, Chat tenant smoke, Content focused tests, eval persistence, and cleanup.
- Re-ran Content security, tenant, provenance, memory, radar, novelty, lifecycle, cross-skill, route, evaluation, build, and typecheck gates.

## Recommended Sequence

1. Keep `content@2.3.0-rc.1` as candidate until staging smoke passes.
2. Explicitly accept or close P1 conditions above.
3. Take fresh production DB snapshot immediately before deploy.
4. Deploy exact RC to staging.
5. Run focused staging Content smoke with no production data.
6. Run bounded real-provider Content quality sample if provider quality claims are included.
7. Promote only after staging passes and conditions are accepted.
8. Run production health checks and monitor Content security/provider/source metrics.
