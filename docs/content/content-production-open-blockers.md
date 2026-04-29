# Content Creation Production Open Blockers

Date: 2026-04-29  
Candidate version: `content@2.3.0-rc.1`

## P0

None currently unresolved for the backend Content release candidate.

## P1

| ID | Blocker | Why It Matters | Current Evidence | Required Closure Or Acceptance |
| --- | --- | --- | --- | --- |
| CONTENT-P1-02 | Real routed-provider quality sampling not run | Fixture tests prove contracts, not Gemini/OpenAI/Anthropic routed output quality under live config | `npm run eval:content` passed in fixture mode only. Local credential check on 2026-04-29 showed `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` missing, with `ANTHROPIC_ENABLED` unset. | Run bounded provider sample with staging/local provider keys, or accept a no-live-provider-quality release claim |
| CONTENT-P1-03 | Deep iOS Content workflows not complete | iOS currently does not render full provenance/lifecycle/approval/novelty state | `docs/ios/content-ios-readiness.md` says NO-GO for rich upgraded readiness; local smoke rendered Content workspace only | Implement and smoke rich iOS flow, or scope release to backend foundation/current UI compatibility |
| CONTENT-P1-04 | Tenant-facing portal Content console not complete | Portal is not yet a tenant Content power console | Backend risk reduced: tenant/user-scoped admin write APIs now cover links, books, channels, manual Voice DNA mutations, provenance review packs, reuse lineage, and historical comparison; legacy `/api/books` and `/api/channels` write routes now return `SCOPED_V1_REQUIRED`; unscoped portal reads are limited to platform/system seed content. Browser UI smoke, agent-settings UX, and tenant console workflows remain incomplete. | Finish portal UI/workflow smoke and agent settings before claiming tenant-facing portal readiness, or keep portal release out of scope |
| CONTENT-P1-05 | Same-user tenant switching proof partial | True multi-brand/workspace switching must not leak references/voice/cache | Backend same-user tenant scoping covered in tests; iOS/portal end-to-end not proven | Run same-user multi-tenant full local smoke before claiming this capability |

## Closed Since RC

| ID | Blocker | Closure Evidence | Remaining Caveat |
| --- | --- | --- | --- |
| CONTENT-P1-06 | Content-engine sidecar not smoked | Closed for fixture-mode sidecar script generation. Added explicit Content Engine fixture mode controls that blank external search/provider keys, block AI proxy calls, and force Reddit to deterministic mock results; then started the sidecar on `127.0.0.1:18102` and verified `/api/v1/script` returned a degraded, topic-grounded fixture response with mock sources and no provider call. `python-engine-hardening.test.ts` passed 51/51. | This does not prove live provider quality, real web/source extraction, or staging sidecar deployment. |
| CONTENT-P1-07 | Secretary agenda lifecycle not end-to-end proven for Content work blocks | Closed for backend ledger handoff and live action smoke. `requestContentScheduleThroughSecretary()` submits the Content scheduling intent to Secretary, persists `secretary_agenda_item_id`, writes workflow event metadata, and `POST /api/v1/content/workflow/:id/actions` with `schedule_content` now returns Secretary scheduling/agenda/feedback. Focused route/service tests passed 28/28. | This does not replace full staging/provider calendar smoke or rich iOS/portal schedule-state rendering claims. |
| CONTENT-P1-08 | Process-wide sensitive-log redaction not fully proven | Closed for the audited backend and Content sidecar paths. Added a shared `log-sanitizer`, wired it into `error_log`, `client_errors`, categorized agent errors, Sentry/operator-alert forwarding, telemetry summaries, and client-error ingestion; removed raw model/provider response previews from Python Content Engine, Content workflow, Training plan parsing, and finance vision parse failure logs. Focused regression passed: `log-sanitizer`, logger redaction, error monitor, error categorizer, client error route, Python hardening, and sensitive log sinks (7 files / 110 tests). | This does not claim every future service/log sink is automatically safe; new sensitive sinks still need sanitizer coverage and tests. |
| CONTENT-P2-01 | Local fixture mode logs confusing fallback text when providers are blank | Closed. Provider registry now installs a deterministic local `fixture` provider whenever `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0` or `NEXUS_MODEL_FIXTURE_MODE=1`, so startup initializes as `routing(fixture)` instead of logging direct-Anthropic fallback language. Regression passed: `provider-registry-fixture-mode.test.ts` plus Python/log-sink focused tests (4 files / 62 tests). | This is a local fixture/control path only; it does not prove live provider quality or fallback behavior. |
| CONTENT-P1-04A | Portal tenant-scoped link writes missing | Closed for backend API. `GET/POST/DELETE /api/v1/admin/content/links` now requires explicit user/tenant scope, uses tenant/user predicates for reads/deletes, and writes `tenant_id`, `owner_user_id`, `visibility_scope`, `scope_status`, and audit metadata for link references. `content-admin-write-auth.test.ts` passed 9/9. | This does not close books/channels/content-agent settings or portal UI/browser smoke. |
| CONTENT-P1-04B | Portal book/channel/Voice DNA writes were global/id-only | Closed for backend API. `/api/v1/admin/content/books`, `/channels`, and `/voice-dna` mutations now require explicit user/tenant scope and use scoped predicates before add/retry/delete/reanalyze/update. Tenant-scoped voice synthesis is blocked until the agent accepts explicit tenant scope. Legacy `/api/books` and `/api/channels` mutations now return `SCOPED_V1_REQUIRED`; unscoped dashboard reads return only platform/system seed rows. Focused tests passed: `content-admin-write-auth`, `content-dashboard-service`, `content-dashboard`. | Portal UI/browser smoke and full tenant console settings remain open. Same-user non-default tenant channel synthesis remains deliberately skipped/documented. |
| CONTENT-P1-04C | Portal lacked deep provenance/reuse/historical comparison contracts | Closed for backend API. Added `GET /api/v1/admin/content/provenance`, `GET /api/v1/admin/content/provenance/review-pack`, `GET /api/v1/admin/content/reuse-history`, and `POST /api/v1/admin/content/historical-comparison`. These endpoints require explicit tenant/user scope and reuse the provenance, source-output link, novelty, and reuse ledgers. | Portal UI/browser smoke and legacy artifact backfill remain open before claiming a complete tenant-facing portal console. |

## P2

| ID | Blocker | Required Closure |
| --- | --- | --- |
| CONTENT-P2-04 | Source snippet claim mapping is lightweight | Add evidence span IDs for high-confidence sourced outputs |
| CONTENT-P2-05 | Rich iOS/portal screenshot artifacts are not archived | Save smoke screenshots under a stable local reports path |

## Closed P2 Since RC

| ID | Blocker | Closure Evidence | Remaining Caveat |
| --- | --- | --- | --- |
| CONTENT-P2-02 | Content eval history was not persisted as a normalized DB artifact | Closed. Added migration `096_content_eval_history.sql`, `src/services/content-eval-history.ts`, and `--persist-db` support in `npm run eval:content`. The latest fixture eval persisted normalized runs into `reports/content-eval/content-eval-history.sqlite`; latest run has 15 cases, score 91/100, `PASS_WITH_CONDITIONS`, provider `fixture`, and no production data or real provider calls. `content-eval-history.test.ts` passed 3/3 and the latest Content smoke wrapper passed 15 files / 124 tests plus persisted eval. | Local/reporting artifact only; live provider quality still requires bounded provider sampling. |
| CONTENT-P2-03 | No one-command Content full local smoke runner | Closed. Added `scripts/content-full-nexus-local-smoke.sh` and package script `npm run smoke:content:local`. The runner starts the local full Nexus engine, runs Content service tests, cross-skill fixtures, Chat tenant smoke, fixture eval, persists eval history, and cleans up services by default. Full local backend run passed build/start, authenticated API smoke 13/13, cross-skill fixtures, Chat tenant smoke 12 pass / 2 partial / 0 fail, Content focused tests 15 files / 124 tests, persisted eval, and cleanup. | Rich iOS Content workflow smoke remains separate. |

## P3

- Add portal trend dashboard for Content quality metrics.
- Add reviewer calibration for Content rubric scoring.
- Add dynamic skill release metadata generation for future plugin skills.

## Current Gate

`GO WITH CONDITIONS` for a backend Content Creation release candidate.  
`NO-GO` for a full rich Content Creation product launch that claims live provider quality, rich iOS/portal readiness, true same-user tenant switching, provider-backed calendar staging proof, or live sidecar source extraction.
