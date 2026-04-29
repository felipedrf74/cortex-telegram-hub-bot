# Content Full Nexus Local Smoke Results

Date: 2026-04-29
Verdict: `PASS WITH CONDITIONS`

## Summary

| Area | Result | Evidence |
| --- | --- | --- |
| Product health | PASS | `/api/v1/` returned `Nexus Hub iOS API`, `v1`, `online`. |
| Auth/session | PASS | Local sandbox iOS user registered, token issued for user `2`. |
| Authenticated iOS API smoke | PASS | 13/13 authenticated smoke checks passed. |
| Content REST core | PASS | Content home, pipeline, ideas, topics, references, radar preferences, and voice DNA routes returned expected local responses. |
| Content service suite | PASS | 15 files / 124 tests passed, including scoped portal backend routes and dashboard read scoping. |
| Content quality eval | PASS WITH CONDITIONS | Fixture baseline 91/100, 15 cases, 0 critical failures. |
| Content eval-history persistence | PASS | Latest normalized local DB run has 15 cases, score 91/100, `PASS_WITH_CONDITIONS`, provider `fixture`, and no production data or real provider calls. |
| Content one-command smoke wrapper | PASS WITH CONDITIONS | `scripts/content-full-nexus-local-smoke.sh run` passed full local backend wrapper path and cleaned up listeners. |
| Cross-skill fixture smoke | PASS WITH CONDITIONS | Local fixture contracts passed; staging runtime section intentionally blocked in dry-run mode. |
| Tenant/security smoke | PASS WITH CONDITIONS | 12 pass, 2 partial, 0 fail. No cross-tenant leak. |
| Model-routing tests | PASS | 4 files / 33 tests passed. |
| Portal read/write backend surfaces | PASS WITH CONDITIONS | Unscoped portal reads are platform/system-seed only; scoped admin write routes for links/books/channels/manual Voice DNA passed focused tests; browser UI workflows not smoke-tested. |
| Content-engine sidecar fixture script | PASS WITH CONDITIONS | Sidecar started on `127.0.0.1:18102`; `/api/v1/script` returned a degraded, topic-grounded fixture script with mock sources and no AI proxy/provider call. |
| iOS simulator local rendering | PASS WITH CONDITIONS | App built, launched with local auth/base URL, Home loaded, Content workspace rendered. |
| Real provider calls | NOT RUN | Disabled by `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`. |
| Cleanup | PASS | Backend and iOS app stopped; local smoke DB removed. See cleanup confirmation. |

## Per-Smoke Matrix

| Smoke | Command | Expected | Actual | Pass/Fail | Provider Mode | Issue / Fix / Blocker |
| --- | --- | --- | --- | --- | --- | --- |
| Runtime cleanup | `scripts/full-nexus-local-engine.sh cleanup` | Stop prior services and clear DB | Backend/content not running; DB removed | PASS | Fixture | No issue. |
| Doctor | `scripts/full-nexus-local-engine.sh doctor` | Print local prerequisites | Node `v25.7.0`, npm `11.10.1`, model calls `0`, DB path set | PASS | Fixture | No issue. |
| Backend start | `scripts/full-nexus-local-engine.sh up` | Local engine on loopback | Backend started on `127.0.0.1:8200` | PASS WITH CONDITIONS | Fixture | Superseded by later fix: provider routing now initializes `routing(fixture)` when local model calls are disabled, avoiding false direct-Anthropic fallback wording. |
| Product health | `scripts/full-nexus-local-engine.sh health` | API online | API returned online | PASS | Fixture | No issue. |
| Auth/session | `scripts/full-nexus-local-engine.sh auth-token` | Local auth token | User `2`, token issued | PASS | Fixture | Runner status still had stale detached PID from first start attempt; service listener was healthy. |
| Authenticated app API | `scripts/full-nexus-local-engine.sh smoke` | Core iOS API endpoints pass | 13/13 passed | PASS | Fixture | No issue. |
| Content core REST | local Node fetch script | Create/list/update Content local objects | 17/17 probes passed | PASS | Fixture | Content home returned partial/degraded because calendar/source integrations are intentionally unavailable locally. |
| References | local Node fetch script | Add/list book/channel, source visible | Book/channel add and retrieval passed | PASS | Fixture | Book extraction stayed pending; no content-engine sidecar/provider call was run. |
| Voice/memory | local Node fetch script | Voice correction writes and reads | Voice DNA write/read passed | PASS | Fixture | Deeper skill-memory profile tested in unit suite. |
| Workflow/lifecycle | local Node fetch script | Topic create/update/cancel works | `planned -> drafting -> ready -> cancelled` passed | PASS | Fixture | External publishing not tested. |
| Tenant/security | local two-user probe | User A cannot use/read Tenant B Content data | Book list/delete isolation and voice isolation passed | PASS | Fixture | True same-user tenant switching remains broader product condition. |
| Content services | `npm test -- --run ...content...` | Backend Content foundations pass | 15 files / 124 tests passed, including scoped portal write/read backend coverage | PASS | Fixture | No issue. |
| Cross-skill | `scripts/full-nexus-local-engine.sh cross-skill-fixtures` | Secretary/Training/Cooking/Finance/Content contract fixtures pass | Local fixtures passed; staging runtime blocked by dry-run | PASS WITH CONDITIONS | Fixture | Not staging proof. |
| Chat tenant smoke | `scripts/full-nexus-local-engine.sh chat-tenant-smoke` | No cross-tenant Chat/context leak | 12 pass, 2 partial, 0 fail | PASS WITH CONDITIONS | Fixture | Same-user tenant switch and real provider fallback not proven. |
| Model routing | `npm test -- --run model-routing...` | Routing/override/fallback tests pass | 4 files / 33 tests passed | PASS | Fixture | Startup no-provider behavior still noisy/blocking for resource-control clarity. |
| Content eval | `npm run eval:content -- --fail-under 85` | Quality score >= 85, no critical failures | 91/100, 0 critical failures | PASS WITH CONDITIONS | Fixture | Real-provider quality sampling not run. |
| Eval history | `npm run eval:content -- --persist-db reports/content-eval/content-eval-history.sqlite` and DB read-back | Normalized score/case/provider metadata persisted without raw prompt/content | Latest run persisted 15 cases, score 91/100, provider `fixture`, no production data | PASS | Fixture | DB artifact is local/reporting only; live provider quality remains unproven. |
| Content smoke wrapper | `scripts/content-full-nexus-local-smoke.sh run` | One command starts local backend, runs API smoke, fixtures, Chat tenant smoke, Content tests/eval/persist, and cleanup | Backend build/start passed; authenticated API smoke 13/13; cross-skill fixtures passed; Chat tenant smoke 12 pass / 2 partial / 0 fail; 15 files / 124 tests passed; eval persisted; cleanup found no listeners | PASS WITH CONDITIONS | Fixture | Rich iOS workflow smoke remains separate. |
| Portal backend scope | `content-admin-write-auth`, `content-dashboard-service`, `content-dashboard` | Portal Content backend routes enforce scope or platform-only reads | 44 focused tests passed | PASS WITH CONDITIONS | Fixture | Browser UI workflows and tenant content-agent settings remain open. |
| Content-engine sidecar | `CONTENT_ENGINE_FIXTURE_MODE=1 NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 CONTENT_ENGINE_PORT=18102 ENV=production content-engine/.venv313/bin/python content-engine/main.py` and `curl -fsS -X POST http://127.0.0.1:18102/api/v1/script ...` | Sidecar starts and script path returns fixture-safe output without provider calls | HTTP 200, `degraded=true`, mock sources, and warning that AI generation was unavailable in fixture mode | PASS WITH CONDITIONS | Fixture | Live web/source extraction and routed-provider quality not run. |
| iOS simulator | XcodeBuildMCP build/run/launch/snapshot | Local backend reachable and Content UI renders | Build/run passed; Content workspace rendered | PASS WITH CONDITIONS | Fixture/local API | Did not complete deep iOS workflow or tenant-switch cache smoke. |

## Content Core Details

Local REST probes passed:

- Content home loaded in degraded/partial mode with expected unavailable source reasons.
- Content pipeline and ideas returned valid empty local state.
- Book reference `Local Fixture Book` was added and retrieved.
- Channel reference `https://www.youtube.com/@localcontentsmoke` was added and retrieved.
- Voice DNA correction `Direct, concrete, no hype. Local smoke correction.` was written and read.
- Radar preferences were updated.
- Content topic `Local smoke idea from fixture book` was created, moved to `drafting`, moved to `ready`, then cancelled.
- Portal read surfaces showed local book and voice knowledge.

## Content Quality Details

`npm run eval:content` result:

- Overall score: 91/100.
- Cases: 15 multi-turn workflows.
- Critical failures: 0.
- Release gate: `PASS_WITH_CONDITIONS`.
- Production data used: false.
- Real provider calls: false.
- Normalized eval-history DB: `reports/content-eval/content-eval-history.sqlite`.
- Latest persisted run: 15 cases, score 91/100, provider `fixture`, model `deterministic-content-fixture`, no production data, no real provider calls.

## Security Details

Content-specific two-user probe:

- User A could not list Tenant B private book: PASS.
- User A could not delete Tenant B private book: PASS, HTTP 404.
- User A could not read Tenant B voice memory: PASS.

Chat tenant smoke:

- User A cannot see Tenant B conversations: PASS.
- Prompt construction excludes Tenant B memory: PASS.
- Prompt injection cannot reveal another tenant: PASS.
- User A cannot trigger tools on Tenant B resources: PASS.
- Same-user tenant switching: PARTIAL.
- Real provider fallback tenant safety: PARTIAL.

## iOS Details

The iOS simulator was launched with local auth import and local backend URL. The app rendered:

- Home screen with local backend state.
- Content card.
- Content workspace.
- Content flow.
- Open radar / Open schedule actions.
- Script generator entry.
- Topic scheduler entry.
- Voice DNA / backstage entry.

No server-unreachable banner was present during the local launch.

## Release-Gate Interpretation

This is a valid local fixture/full-engine smoke for Content Creation basics. It is not a full production-quality proof because real provider calls, live source extraction, true same-user tenant switching, deep iOS Content actions, portal browser workflows/content-agent settings, and staging/provider integrations remain open.
