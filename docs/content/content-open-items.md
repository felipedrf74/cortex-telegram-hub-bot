# Content Open Items

Date: 2026-04-29
Branch: `feature/content-creation-intelligence-upgrade`

## Current Release-Gate Verdict

Verdict: GO WITH CONDITIONS for a scoped backend Content intelligence foundation candidate.

Reason: foundational route/routing hardening, tenant-safe reference/provenance foundations, backend artifact lifecycle foundations, app-facing editorial mutation contracts, Content memory/voice foundations, quality evaluation, local fixture smoke, Content-to-Secretary backend ledger handoff, fixture sidecar smoke, sensitive-log hardening, local fixture provider routing, eval-history persistence, and a one-command local Content smoke runner now exist. Remaining production conditions are mostly release-claim boundaries: live routed-provider quality sampling, rich iOS Content workflow proof, fuller tenant portal console work, and same-user multi-tenant switching proof.

## P0 Production Blockers

| Item | Status | Closure Requirement |
|---|---|---|
| Prove Content references, memory, artifacts, and prompt context cannot leak across tenants | Closed for tested backend paths | Keep P1 condition for same-user tenant-switching and rich frontend/local cache proof |
| Prevent unauthorized Content context from entering model prompts | Closed for generation package and focused tests | Keep future provider paths behind scoped context builder and tests |
| Portal/admin raw Content visibility policy | Partially open | Operator/readiness portal is acceptable; tenant-facing Content console still needs explicit permission/audit policy |

## P1 Must Fix Before Release

| Item | Status | Closure Requirement |
|---|---|---|
| Unified source/provenance model for books, links, channels, snippets, and learned patterns | Partially closed | Source registry, provenance ledger, source-review mutation contract, tenant-safe route tests exist; full UI/source extraction workflows remain |
| First-class link references | Open | Link model, extraction state, prompt-injection labels, scope tests |
| Content artifact lifecycle | Partially closed | Backend lifecycle service, workflow events, approval records, app-facing mutation routes, and tests exist; iOS/portal clients still need full wiring |
| Content-to-Secretary scheduling intents | Closed for backend live action path | `schedule_content` now submits through Secretary from the app-facing route, stores agenda identity, returns feedback, and has route-level reflow/approval-gate smoke; provider calendar staging and frontend rendering remain separate claims |
| Content discovery provider fallback consistency | Open | Central routing abstraction or documented provider-specific path with tests |
| Tenant metadata in all Content model-call paths | Partially open | Active tenant id carried where available, tenant-safe metadata tests |
| Id-only helper mutation hardening | Partially open | Ownership parameters or caller guards for channel/admin helper mutations |
| Quality evaluation harness | Closed | Scenario bank, rubric, baseline results, and normalized eval-history persistence exist; live-provider sampling remains a separate P1 condition |
| Skill memory/version tracking | Partially closed | Shared skill memory/version ledger and Content memory facade exist; route/UI/full-product usage remains open |
| iOS support for provenance/lifecycle/novelty/generation quality | Partially closed | DTO decoding/rendering improved in iOS branch; mutation-route wiring and local iOS smoke remain |

## P2 Should Fix

| Item | Status | Closure Requirement |
|---|---|---|
| Static creator assumptions | Partially closed | Content memory/profile context and generation-quality contract now feed script generation; remaining static discovery/profile paths need follow-up |
| Artifact-level novelty/reuse controls | Partially closed | Tenant-safe novelty/reuse ledger, deterministic duplicate scoring, repurpose history, app-facing repurpose route, generation-context constraints, focused tests, and local backend smoke exist; route-wide write-through, legacy backfill, and iOS/portal rendering remain |
| Cross-skill opportunity detection | Partially closed | Content cross-skill signal service, sensitive-signal policy, inbound Radar conversion, outbound Secretary/Chat contracts, focused tests, and local fixture smoke exist; runtime hooks from Training/Cooking/Finance/Secretary/Chat and approval UX remain |
| Content notification deep-link resolver | Partially closed | Backend resolver `GET /api/v1/content/notifications/:id` exists with scoped tests; iOS/portal routing remains |
| Portal tenant controls | Open | Retention/export/delete/visibility policy if portal scope includes Content |
| Observability for source usage and quality decisions | Open | Artifact-level metadata and dashboards/log events without raw prompt leakage |

## P3 Deferrable

| Item | Status | Closure Requirement |
|---|---|---|
| Advanced trend/radar scoring | Partially closed | Deterministic source/freshness/confidence/novelty/brand/capacity scoring exists; real external trend ingestion and UI workflows remain |
| Rich portal editorial workbench | Deferred | Add after tenant/admin policy and lifecycle model |
| Advanced platform packaging variants | Partially closed | Backend format contracts cover YouTube, Shorts/Reels/TikTok, LinkedIn, X thread, newsletter, blog, podcast outline, carousel, caption; app-facing routes/iOS/portal support remain |

## Closed Or Partially Closed In Current Branch

- `/content/discover` now uses the shared Content route guard.
- Reference and learning routes now use the shared guard.
- Content dedup no longer directly calls Anthropic; it uses live routing with category `content_dedup`.
- Dedup cache includes user scope.
- Internal AI proxy accepts optional user and tenant metadata.
- Python script generation forwards user scope to the TypeScript proxy.
- Workflow feedback/topic helper functions support user-scoped operations where used.
- Content ontology and source/provenance foundations are implemented with focused tests.
- Content lifecycle/editorial workflow foundation is implemented with workflow events, approval records, radar conversion, Secretary intent construction, and focused tests.
- App-facing Content editorial mutation contracts are implemented for workflow actions, source review, approval decisions, and repurpose lineage with focused API tests.
- Content memory/voice profile foundation is implemented with tenant-safe creative profile context, correction handling, platform-specific voice, performance-informed suggestion scoring, and focused tests.
- Content Radar opportunity engine foundation is implemented with a tenant-safe signal ledger, deterministic scoring, duplicate/stale handling, source provenance, cross-skill Training signal support, Secretary capacity prioritization, review-required state, and conversion to workflow ideas.
- Content generation-quality foundation is implemented with platform/format contracts, scoped voice/reference context, source-confidence review warnings, refinement planning, generation quality evaluation, and script-route context/response integration.
- Content duplicate/novelty/reuse foundation is implemented with a tenant-safe artifact ledger, near-duplicate detection, intentional repurpose rules, reuse provenance, overused-reference warnings, generation-context novelty constraints, and focused tests.
- Content cross-skill orchestration foundation is implemented with tenant-safe inbound signal consumption, sensitive-signal review/anonymization rules, duplicate cross-skill signal prevention, permitted Training milestone idea conversion, Secretary cadence/Finance constraint handling, and outbound Secretary/Chat contracts.
- Content-to-Secretary scheduling backend ledger handoff and live `schedule_content` action path are implemented and tested; Content objects store returned Secretary agenda identity and route responses include Secretary feedback.
- Content notification deep-link backend resolver is implemented and tested for script, approval, source-review, fallback, and cross-user denial paths.
- Content eval-history persistence is implemented with migration `096_content_eval_history.sql` and the `--persist-db` eval CLI option.
- `scripts/content-full-nexus-local-smoke.sh` / `npm run smoke:content:local` provides the one-command local Content smoke wrapper and passed the full local backend path.
- Focused tests and typecheck passed after those hardening edits.

## Validation Still Required

- Real routed-provider Content quality sampling with bounded synthetic data.
- Rich iOS Content workflow smoke for references, provenance, lifecycle, approvals, novelty/reuse, and tenant switch cache behavior.
- iOS adoption of `GET /api/v1/content/notifications/:id` for exact Content notification targets.
- iOS/portal rendering of Content `schedule_content` route feedback, reflow, compression, deferred, and unscheduled states.
- Tenant-facing portal UI/browser smoke and content-agent settings. Backend write routes for links/books/channels/manual Voice DNA are now scoped or blocked where unsafe.
- Same-user multi-tenant Content switching proof across Chat, Content references, voice profile, and client cache.
- Full Content unit/integration suite remains useful before a deployment branch, but current focused Content suites and wrapper smoke are passing.
- Content Radar API/iOS/portal wiring, runtime cross-skill signal hooks, sensitive-signal approval UX, and full cross-skill signal ingestion.
- Dedicated app-facing routes for non-video generation formats and refinements.
- Route-wide write-through into `content_novelty_candidates` for every created/refined artifact and legacy artifact backfill into the novelty ledger.
- End-to-end Content script generation smoke proving scoped creative memory is included and cross-tenant/stale memory is excluded.
- Model-routing tests for discovery/dedup/script/fallback paths.
- Local full-product smoke.
- iOS simulator smoke against local backend.
- Portal/admin smoke if portal Content surfaces are in scope.
