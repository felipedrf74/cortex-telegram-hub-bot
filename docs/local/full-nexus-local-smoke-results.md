# Full Nexus Local Smoke Results

Date: 2026-04-29
Run ID: `full-nexus-local-smoke-20260429T1115`
Backend branch: `feature/chat-p0-tenant-security-audit`
Backend version: `4.14.104`
Local base URL: `http://127.0.0.1:8212`
Local DB: `data/full-nexus-local-smoke-20260429T1115.db`
State dir: `.local/full-nexus-local-smoke-20260429T1115`

## Final Verdict

`PASS WITH CONDITIONS`

The full local Nexus product engine ran successfully in fixture/degraded mode.
Backend health, auth/session, tenant context, permissions, core iOS API
surfaces, Chat, Secretary, Training, Cooking, Finance, Content Creation, shared
context, workers, local calendar/agenda ownership, tenant isolation, and iOS
local connectivity were validated without production data, production
deployment, real provider calendar writes, or real model calls.

Conditions:

- Real Gemini/OpenAI/Anthropic provider calls were intentionally disabled.
- Real Google/Outlook provider read-back was not run; this remains a staging
  provider gate.
- Chat WebSocket/stream reconnect was not run.
- True same-user multi-workspace switching is still partial; local smoke uses
  separate local users/tenants for tenant isolation.
- Fixture mode currently logs provider-routing initialization errors when all
  provider keys are blank, then falls back to heuristic/degraded handling. The
  smoke passed, but local fixture-provider initialization should be made cleaner.

## Runtime Setup

Initial cleanup:

```bash
FULL_NEXUS_STATE_DIR=.local/full-nexus-local-smoke-20260429T1115 \
PORTAL_PORT=8212 \
FULL_NEXUS_BASE_URL=http://127.0.0.1:8212 \
DATABASE_PATH="$PWD/data/full-nexus-local-smoke-20260429T1115.db" \
FULL_NEXUS_RESET_DB=1 \
scripts/full-nexus-local-engine.sh cleanup
```

Backend start:

```bash
FULL_NEXUS_STATE_DIR=.local/full-nexus-local-smoke-20260429T1115 \
PORTAL_PORT=8212 \
FULL_NEXUS_BASE_URL=http://127.0.0.1:8212 \
DATABASE_PATH="$PWD/data/full-nexus-local-smoke-20260429T1115.db" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
PORTAL_ADMIN_TOKEN=local-full-smoke-admin \
IOS_INVITE_CODE=local-full-smoke \
scripts/full-nexus-local-engine.sh up
```

Key startup evidence:

- SQLite DB opened at the isolated local path.
- Migrations applied through `086_chat_callback_scope.sql`.
- Default skills seeded: Secretary, Triathlon/Training, Content, Finance, Cooking.
- Scheduler/workers started inside the backend process.
- iOS API mounted at `/api/v1`.
- Backend served on `127.0.0.1:8212`.
- Provider keys were blanked by fixture mode.

Startup warning status:

- Superseded by later fix: with model keys blanked and `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`,
  provider routing now initializes a deterministic local `fixture` provider instead of
  logging a provider-init error.

## Full-Smoke Command

```bash
FULL_NEXUS_STATE_DIR=.local/full-nexus-local-smoke-20260429T1115 \
PORTAL_PORT=8212 \
FULL_NEXUS_BASE_URL=http://127.0.0.1:8212 \
DATABASE_PATH="$PWD/data/full-nexus-local-smoke-20260429T1115.db" \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
PORTAL_ADMIN_TOKEN=local-full-smoke-admin \
IOS_INVITE_CODE=local-full-smoke \
scripts/full-nexus-local-engine.sh full-smoke
```

## Product Health

| Scenario | Expected | Actual | Result |
| --- | --- | --- | --- |
| Backend health | `/api/v1/` reachable | `{ name: "Nexus Hub iOS API", version: "v1", status: "online" }` | PASS |
| Auth/session | Local sandbox auth token minted | `userId=2`, `expiresIn=604800`, auth JSON written | PASS |
| Tenant context | Authenticated routes scoped to local user | API logs show `userId=2`; Chat tenant smoke created isolated users `3` and `4` | PASS |
| Permissions | Unauthorized cross-tenant access denied | Portal diagnostics mismatch returned `403`; foreign callback returned `410` | PASS |
| Workers | Scheduler started in backend process | Startup log listed reminders, daily/weekly jobs, invoice queue, channel relearn, pipeline, backups disabled by local env | PASS |
| Model/provider fixture mode | No real model calls | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` blanked; `ANTHROPIC_ENABLED=false` | PASS WITH CONDITION |

## Authenticated API Smoke

Command:

```bash
scripts/authenticated-api-smoke.sh \
  --base-url http://127.0.0.1:8212 \
  --token-file .local/full-nexus-local-smoke-20260429T1115/local-ios-auth.json
```

Result: `13/13 PASS`.

| Endpoint | Result |
| --- | --- |
| Dashboard | PASS |
| Plan today | PASS |
| Plan week | PASS |
| Task lists | PASS |
| Today tasks | PASS |
| Training summary | PASS |
| Training today | PASS |
| Content pipeline | PASS |
| Content intelligence summary | PASS |
| Current meal plan | PASS |
| Finance monthly summary | PASS |
| Connections | PASS |
| Inbox | PASS |

## Chat Tenant-Isolation Smoke

Command:

```bash
scripts/full-nexus-local-engine.sh chat-tenant-smoke
```

Result: `PASS WITH CONDITIONS`, `12 pass`, `2 partial`, `0 fail`.

| Scenario | Actual | Result |
| --- | --- | --- |
| Seed local test tenants | Tenant A/User A `3`; Tenant B/User B `4` | PASS |
| User A cannot see Tenant B conversations | Tenant B marker absent from User A history | PASS |
| User B cannot see Tenant A conversations | Tenant A marker absent from User B history | PASS |
| User A cannot retrieve Tenant B memory | Active Tenant A memory excluded Tenant B rows | PASS |
| Prompt construction scope | Tenant B memory excluded before provider call | PASS |
| Vague follow-up after tenant switch | `tenant_boundary_requires_confirmation` weak signal emitted without leak | PASS |
| Prompt injection | No Tenant B marker disclosed | PASS |
| Attachment path | No Tenant B marker disclosed | PASS |
| Foreign callback/tool | Denied with `410` | PASS |
| Admin/support diagnostics | Cross-tenant user diagnostics denied with `403` | PASS |
| Same-user multi-workspace | Not supported by current iOS Chat ingress | PARTIAL |
| Live provider fallback | Unit-covered, no real provider call in local smoke | PARTIAL |

## Cross-Skill Fixture Smoke

Command:

```bash
scripts/full-nexus-local-engine.sh cross-skill-fixtures
```

Result: local fixture contract checks passed. The staging runtime section is
blocked by design in dry-run mode and is not counted as local failure.

| Flow | Evidence | Result |
| --- | --- | --- |
| Local fixture contracts | Secretary, Cooking, Finance, Content, and signal-prompt plumbing present | PASS |
| Secretary conflict | Calendar/admin pressure creates reflow/modular Training guidance | PASS |
| Cooking fueling gap | One specific fueling gap appears and is deduped | PASS |
| Finance budget constraint | Budget posture reduces paid gear/supplement pressure | PASS |
| Content workload | Filming/content workload influences schedule friction | PASS |
| Training content milestone | Training emits content-capture opportunity | PASS |

## Chat Day-To-Day Evaluation

Command:

```bash
scripts/full-nexus-local-engine.sh chat-eval
```

Results:

- Chat evaluation baseline: `PASS`
- Scenario count: `24`
- Average score: `1.99 / 2.00`
- Status counts: `21 pass`, `3 partial`, `0 fail`
- Day-to-day simulation: `PASS`
- Day-to-day scenarios: `10`
- Day-to-day average score: `1.93 / 2.00`

Partial scenarios:

- streaming interruption and retry: fixture baseline only
- provider fallback case: fixture baseline only
- operator-pinned model case: fixture baseline only

## Persisted Product Scenario Smoke

A focused local probe seeded and validated persisted local data against the
same running backend and DB.

Command type: local Node probe using the local auth token, app-facing APIs,
and local service seeds. No production data or real provider calls.

Run ID: `full-local-1777461393325`

Result: `14/14 PASS`.

| Scenario | Actual | Result |
| --- | --- | --- |
| Auth/session + tenant context | `/api/v1/auth/me` returned local user `2` | PASS |
| Secretary schedules Training | Created local Training plan `1`, session `1`, and active `training_agenda_event_ownership` row | PASS |
| Local calendar/agenda mock | Active ownership row existed before cancellation | PASS |
| Secretary agenda/task create | `POST /api/v1/tasks` returned `201` | PASS |
| Finance constraints | Two finance transactions returned `201,201` | PASS |
| Content references | Book/channel/radar preferences wrote and read back | PASS |
| Cooking reacts to Training context | Meal plan returned seeded recovery bowl | PASS |
| Training local plan visible | `/api/v1/training/today` returned `200` before cancellation | PASS |
| Chat routes to Secretary | `POST /api/v1/chat/message` returned `200` | PASS |
| Chat routes to Training | `POST /api/v1/chat/message` returned `200` | PASS |
| Chat routes to Cooking | `POST /api/v1/chat/message` returned `200` | PASS |
| Chat routes to Finance | `POST /api/v1/chat/message` returned `200` | PASS |
| Chat routes to Content Creation | `POST /api/v1/chat/message` returned `200` | PASS |
| Training cancellation cleans agenda state | Active plan/session removed; active ownership `0`; orphan audit row `1` because no Google provider was connected locally | PASS WITH PROVIDER-MOCK NOTE |

Provider-mock note:

The Training cancellation path attempted to delete a dummy Google event, found
Google not connected for local user `2`, marked the ownership row `orphaned`,
and still hard-deleted local plan/session rows. This validates local stale-state
cleanup/audit behavior, not real Google deletion. Real provider delete/read-back
belongs to staging.

## iOS Local Connectivity Smoke

iOS project:

```text
/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub/Nexus Hub.xcodeproj
```

Simulator:

```text
iPhone 17 Pro (A0B13967-B5DE-4E6F-897D-F1E409093F94), iOS 26.4
```

Build:

```text
✅ iOS Simulator Build succeeded for scheme Nexus Hub.
```

Launch args:

```text
-nexus_debug_local_auth_import YES
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8212
```

Launch env:

```text
NEXUS_LOCAL_AUTH_IMPORT_PATH=/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot/.local/full-nexus-local-smoke-20260429T1115/local-ios-auth.json
```

Result: `PASS`.

Evidence:

- App launched successfully.
- Accessibility tree showed authenticated Home, not login.
- Backend logs showed authenticated iOS requests for user `2`.
- Home rendered local seeded data:
  - Secretary: `Local Secretary agenda smoke full-local-1777461393325`
  - Cooking: `Local smoke recovery bowl full-local-1777461393325`
  - Finance: `€ 1450 spent: € 350 net`
- Calendar/connection degraded state was honest: partial briefing for calendar
  connection because no real calendar provider was connected locally.
- Screenshot captured at:
  `/var/folders/ys/pphsc0rn6m7246r817g6r1pr0000gn/T/screenshot_optimized_c2830afc-9804-4b40-93d7-01a560516356.jpg`

iOS caveat:

The Home Training card showed "Training unavailable" after the smoke because
the local Training cancellation scenario intentionally removed the active plan
before the simulator launch. Backend Training routes had already passed before
the cancellation.

## Coverage Against Requested Scenarios

| Requested scenario | Result | Evidence |
| --- | --- | --- |
| backend health | PASS | `/api/v1/` online |
| auth/session | PASS | local auth token, `/auth/me` |
| tenant context | PASS | `userId=2`; isolated users `3`/`4` |
| permissions | PASS | cross-tenant diagnostics/callback denied |
| Chat | PASS | Chat API routes and evaluation passed |
| Secretary | PASS | plan/today, tasks, local agenda item |
| Training | PASS | summary/today route; local plan seed; cancellation cleanup |
| Cooking | PASS | meal plan route and seeded recovery bowl |
| Finance | PASS | monthly summary route and seeded budget constraints |
| Content Creation | PASS | pipeline/intelligence route and tenant-scoped references |
| shared context | PASS | cross-skill fixture contracts and Chat context builder |
| local calendar/agenda mock | PASS WITH NOTE | active ownership row then orphan audit on local provider miss |
| workers | PASS | scheduler/workers started in backend process |
| model/provider fixture mode | PASS | no real calls; superseded by later deterministic `routing(fixture)` provider path |
| iOS local connectivity | PASS | build/install/launch/snapshot against local backend |
| Chat routes to Secretary | PASS | HTTP `200`; backend routing logs |
| Chat routes to Training | PASS | HTTP `200`; backend routing logs |
| Chat routes to Cooking | PASS | HTTP `200`; backend routing logs |
| Chat routes to Finance | PASS | HTTP `200`; backend routing logs |
| Chat routes to Content Creation | PASS | HTTP `200`; backend routing logs |
| Secretary schedules Training | PASS | local plan/session/ownership row |
| Training cancellation cleans agenda | PASS WITH NOTE | active rows removed; orphan audit recorded because provider absent |
| Cooking reacts to Training context | PASS | meal/fueling data visible after Training signal seed |
| Finance constraint influences decision | PASS | cross-skill fixture budget constraint + local finance data |
| Content uses tenant-scoped references | PASS | local user book/channel/radar read-back |
| tenant isolation holds | PASS WITH CONDITIONS | no cross-tenant leak; same-user workspaces partial |

## Open Follow-Ups

| Priority | Item | Why it remains open |
| --- | --- | --- |
| P1 | Add local streaming/reconnect smoke | Chat streaming interruption is fixture-only in this run. |
| P1 | Keep real Google/Outlook as staging gates | Local smoke cannot prove provider read-back or external mutation. |
| P2 | Automate iOS launch inside runner | iOS smoke still uses XcodeBuildMCP/manual launch args. |
| P2 | Improve same-user multi-workspace local seed | Current tenant isolation uses separate local users/tenants. |

## Cleanup

Cleanup completed. See:

```text
docs/local/full-nexus-local-cleanup-confirmation.md
```

---

## Full Local Product Smoke Addendum — 2026-04-29 22:54

Run ID: `full-nexus-local-smoke-20260429-2254`
Local base URL: `http://127.0.0.1:8298`
Backend branch: `feature/content-editorial-mutation-contracts`
Backend commit: `21a27ff8a7f350244105fe189de677367bbd665d`
iOS branch: `feature/ios-content-creation-intelligence-upgrade`
iOS commit: `ca99f11a40855882b3690192bb9e17d90bb38c55`

Rollback protection created before this smoke:

- Backend branch/tag: `backup/full-local-smoke-before-run-20260429-2254`, `backup-full-local-smoke-before-run-20260429-2254`
- iOS branch/tag: `backup/full-local-smoke-before-run-20260429-2254`, `backup-full-local-smoke-before-run-20260429-2254`

### Runtime Configuration

| Setting | Value |
| --- | --- |
| Backend mode | Attached `scripts/full-nexus-local-engine.sh up` |
| Database | `/tmp/nexus-full-smoke-20260429-2254.db` |
| Auth token file | `/tmp/nexus-full-smoke-20260429-2254-auth.json` |
| Model/provider mode | `NEXUS_MODEL_FIXTURE_MODE=1`, `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0` |
| Calendar/provider mode | Local degraded/mock state, no real Google/Outlook credentials |
| Workers/cache | Scheduler/workers started inside backend process; SQLite/KV cache initialized |
| Optional content sidecar | Not started |

The detached runner `start` path was briefly attempted first, but the shell reaped the background backend after startup. The smoke was rerun successfully with the runner's attached `up` mode, which is the documented mode for Codex/CI shells.

### Backend, Skills, Workers, Cache

Command:

```bash
FULL_NEXUS_STATE_DIR=/tmp/nexus-full-smoke-20260429-2254 \
PORTAL_PORT=8298 \
FULL_NEXUS_BASE_URL=http://127.0.0.1:8298 \
DATABASE_PATH=/tmp/nexus-full-smoke-20260429-2254.db \
FULL_NEXUS_AUTH_FILE=/tmp/nexus-full-smoke-20260429-2254-auth.json \
NEXUS_MODEL_FIXTURE_MODE=1 \
NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 \
IOS_INVITE_CODE=local-full-nexus-smoke \
PORTAL_ADMIN_TOKEN=local-chat-tenant-admin \
scripts/full-nexus-local-engine.sh full-smoke
```

Result: `PASS WITH CONDITIONS`.

| Area | Result | Evidence |
| --- | --- | --- |
| Product health | PASS | `/api/v1/` returned `{ name: "Nexus Hub iOS API", version: "v1", status: "online" }` |
| Auth/session | PASS | Local sandbox iOS user registered; auth token written to `/tmp/nexus-full-smoke-20260429-2254-auth.json` |
| Authenticated iOS API smoke | PASS | 13/13 checks passed: Dashboard, plan today/week, task lists, today tasks, Training summary/today, Content pipeline/intelligence, Cooking, Finance, Connections, Inbox |
| Chat tenant isolation | PASS WITH CONDITIONS | 15 pass / 1 partial / 0 fail; partial is provider fallback because no real fallback provider call was made |
| Same-user tenant switch | PASS WITH CONDITIONS | Unsupported active-tenant override fails closed with `403`; true same-user workspace switching is still not claimed |
| Cross-skill fixtures | PASS WITH LOCAL-FIXTURE NOTE | Secretary, Training, Cooking, Finance, Content and prompt plumbing checks passed; staging runtime section intentionally blocked in dry-run mode |
| Chat evaluation harness | PASS WITH CONDITIONS | 24 scenarios, average 1.99/2.00; streaming/fallback/operator pin remain fixture-only partials |
| Chat day-to-day simulation | PASS | 12 scenarios, average 1.94/2.00 |
| Workers/cache | PASS | Backend logs show scheduler/workers started and SQLite/KV migrations initialized |
| Provider-call controls | PASS | Provider routing initialized as `fixture→none`; no real provider calls enabled |

Backend startup notes:

- The runner applied migrations through `096_content_eval_history.sql`.
- Skill registry seeded `secretary@2.0.0`, `triathlon@3.0.0`, `content@2.0.0`, `finance@1.0.0`, and `cooking@1.0.0`.
- Default content book indexing logged expected local `ECONNREFUSED` failures because the optional content-engine sidecar was not started. This did not block app-facing content API smoke or iOS Content rendering.

### iOS Local Smoke

Focused iOS tests:

```text
NexusConfigTests
DebugAuthTokenImporterPolicyTests
ChatRepositoryTests
ChatRichStateDecodingTests
ContentHomeContractDecodingTests
ContentReferenceLocalStoreTests
SecretaryDayPlanPresentationTests
TrainingPresentationTests
```

Result: `PASS` — 77 tests passed, 0 failed.

Simulator:

```text
iPhone 17 Pro (A0B13967-B5DE-4E6F-897D-F1E409093F94), iOS Simulator 26.4.1
```

Launch args:

```text
-nexus_allow_local_backend YES
-nexus_base_url http://127.0.0.1:8298
-nexus_debug_local_auth_import YES
```

Launch env:

```text
NEXUS_LOCAL_AUTH_IMPORT_PATH=/tmp/nexus-full-smoke-20260429-2254-auth.json
```

iOS simulator result: `PASS`.

Evidence:

- App built, installed, and launched successfully against the local backend.
- Home rendered authenticated app state and did **not** show "Couldn't reach Nexus Hub".
- Home showed honest degraded local provider states: partial briefing for calendar connection and unavailable Body Battery/health data.
- Chat opened successfully.
- Chat shortcut "What's on my schedule today?" routed to Secretary and rendered a Secretary response with source evidence.
- Skills tab opened and listed Training, Content, Cooking, Finance.
- Content skill opened and rendered rich workflow state: next move, confidence, radar, schedule, content flow, workbench, Voice DNA, and backstage details.
- Training skill opened and rendered the expected clean-fixture state: profile setup, no active plan, readiness, and honest Apple Health permission degradation.
- Screenshot captured during the iOS smoke at `/var/folders/ys/pphsc0rn6m7246r817g6r1pr0000gn/T/screenshot_optimized_da107c93-aa20-4567-8278-22eac5e9a829.jpg`.

### Release Gate Verdict

`PASS WITH CONDITIONS`

The full local product smoke validates backend APIs, auth/session, tenant scoping, Chat, Secretary, Training, Cooking, Finance, Content Creation, shared context fixtures, workers/cache startup, fixture-mode model routing, and iOS local connectivity.

Conditions that remain outside this local smoke:

| Priority | Condition | Reason |
| --- | --- | --- |
| P1 | WebSocket/stream interruption proof | This run uses fixture evaluation and normal Chat HTTP/shortcut flow, not a full reconnect stream drill |
| P1 | True same-user workspace switching | Unsupported active-tenant overrides fail closed; membership-backed multi-workspace switching remains unimplemented |
| P1 | Provider-backed calendar lifecycle | Local run used degraded/mock calendar state; Google/Outlook read-back belongs to staging |
| P2 | Optional content-engine sidecar smoke | App-facing Content paths passed, but live extraction/indexing sidecar was not started |
| P2 | Automate iOS leg in the runner | iOS smoke still requires XcodeBuildMCP/manual launch args |
