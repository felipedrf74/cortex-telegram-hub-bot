# Content Full Nexus Local Open Blockers

Date: 2026-04-29
Verdict: `PASS WITH CONDITIONS`

## P0 Blockers

None found in this local fixture smoke. No cross-tenant Content leak was observed.

## P1 Must Fix Before Claiming Full Production Readiness

| ID | Blocker | Why It Matters | Required Closure |
| --- | --- | --- | --- |
| CONTENT-LOCAL-P1-02 | Real routed-provider quality sampling not run | Fixture quality does not prove Gemini/OpenAI/Anthropic routed output quality. | Run bounded real-provider Content quality sampling with synthetic data, provider-call limits, and provider/model/tier/category/cost logging. |
| CONTENT-LOCAL-P1-03 | Portal Content browser workflows not locally smoke-tested | Backend write routes for links/books/channels/manual Voice DNA are now scoped or blocked where unsafe, but the portal UI has not been browser-smoked as a tenant console and content-agent settings remain incomplete. | Add tenant-safe portal fixture mode and smoke portal books/links/channels/agent settings without production data or provider calls. |
| CONTENT-LOCAL-P1-04 | Deep iOS Content workflows not completed | iOS rendered Content, but create/edit/reference/approval flows were not fully driven in the simulator. | Add XCUITest or simulator smoke for Content reference management, radar, topic creation, source/provenance rendering, and tenant-switch cache behavior. |
| CONTENT-LOCAL-P1-05 | Same-user tenant switching remains partial | Two-user tenant isolation passed, but same-user brand/workspace switching is still not end-to-end local proof. | Add same-user multi-tenant seed and smoke across Chat, Content references, voice profile, and iOS cache. |

## Closed After Initial Smoke

| ID | Blocker | Closure Evidence | Remaining Caveat |
| --- | --- | --- | --- |
| CONTENT-LOCAL-P1-01 | Local fixture mode logged direct Anthropic fallback when provider keys were blank | Closed. Provider registry now initializes a deterministic local `fixture` provider under `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0` / `NEXUS_MODEL_FIXTURE_MODE=1`. `provider-registry-fixture-mode.test.ts` proves startup as `routing(fixture)` and deterministic classify/domain/continuation responses without provider calls. | Live provider quality/fallback smoke remains separate. |
| CONTENT-LOCAL-P1-06 | Content-engine sidecar was not started | Closed for fixture-mode script generation. Fixture mode now blanks external keys, blocks AI proxy calls, mocks Reddit, and `/api/v1/script` returned HTTP 200 with a degraded topic-grounded script and mock sources. | Live source extraction and routed-provider quality remain open. |
| CONTENT-LOCAL-P1-07 | Secretary scheduling is contract-level, not end-to-end agenda proof | Closed for backend ledger proof and focused live action smoke. Content schedule requests now write through `secretary_agenda_items`, store `secretary_agenda_item_id`, and route-level `schedule_content` proves scheduled/reflowed/approval-gated paths. | iOS schedule-state rendering and provider-backed calendar staging remain open. |
| CONTENT-LOCAL-P1-08 | Portal Content backend write routes were global/id-only | Closed for backend scope. Scoped links/books/channels/manual Voice DNA routes now require explicit `userId`/`tenantId`, legacy `/api/books` and `/api/channels` writes return `SCOPED_V1_REQUIRED`, and unscoped dashboard reads are platform/system-seed only. The latest Content smoke wrapper passed 15 files / 124 tests including portal scope coverage. | Browser UI smoke and content-agent settings remain open. |

## P2 Should Fix

| ID | Blocker | Required Closure |
| --- | --- | --- |
| CONTENT-LOCAL-P2-01 | Content home is partial/degraded locally because calendar/source integrations are unavailable | Seed local calendar/source mocks so Content home can render a non-degraded happy path. |
| CONTENT-LOCAL-P2-02 | Portal read surfaces are still loopback/operator oriented | Add tenant/user scoped portal Content console surfaces before treating portal as production-ready for tenant content. |
| CONTENT-LOCAL-P2-04 | No screenshot is checked into a stable reports directory | Save simulator screenshots under `.local/content-full-nexus-smoke/reports/` for repeatable QA artifacts. |

## Closed P2 Since Initial Smoke

| ID | Blocker | Closure Evidence | Remaining Caveat |
| --- | --- | --- | --- |
| CONTENT-LOCAL-P2-03 | Local smoke output was manually assembled | Closed. Added `scripts/content-full-nexus-local-smoke.sh` and `npm run smoke:content:local`. The wrapper controls fixture mode, starts the full local runner, runs Content-focused tests, cross-skill fixtures, Chat tenant smoke, Content eval, normalized eval persistence, and cleanup. Latest full local backend wrapper run passed backend build/start, authenticated API smoke 13/13, cross-skill fixtures, Chat tenant smoke 12 pass / 2 partial / 0 fail, 15 files / 124 Content tests, eval persistence, and cleanup. | Rich iOS workflow smoke remains separate. |

## P3 Deferrable

- Add browser automation for portal Content diagnostics.
- Add content-performance analytics fixtures.
- Add unsupported-claim UI smoke once the rich provenance DTO is fully exposed to frontend surfaces.

## Release-Gate Verdict

`PASS WITH CONDITIONS`

This local smoke is strong enough to prove that Content Creation can run in the local product engine with local auth, local DB, REST APIs, tenant isolation, fixture quality checks, cross-skill contract fixtures, model-routing tests, and iOS local rendering.

It is not enough to claim production-ready Content Creation until P1 blockers are closed or explicitly accepted.
