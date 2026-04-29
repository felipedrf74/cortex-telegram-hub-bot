# Full Nexus Local Smoke Results

Date: 2026-04-28  
Branch: `feature/local-full-nexus-product-engine-smoke-environment`

| Smoke | Command | Result | Notes |
| --- | --- | --- | --- |
| Script syntax | `bash -n scripts/full-nexus-local-engine.sh` | Pass | Runner parses successfully. |
| Doctor | `scripts/full-nexus-local-engine.sh doctor` | Pass | Confirmed branch `feature/local-full-nexus-product-engine-smoke-environment`, packaged backend candidate commit `b8f9be7`, Node `v25.7.0`, npm `11.10.1`, local DB path, model calls disabled. |
| Detached start | `scripts/full-nexus-local-engine.sh start` | Partial in Codex shell | Backend built and answered public `/api/v1/`, but detached child was reaped after command completion by the Codex shell. Added `up` attached mode for this environment. |
| Attached start/health | `scripts/full-nexus-local-engine.sh up` plus `scripts/full-nexus-local-engine.sh health` | Pass | Backend stayed alive attached, listened on `127.0.0.1:8200`, and `/api/v1/` returned `status=online`. |
| Local auth token | `scripts/full-nexus-local-engine.sh auth-token` | Pass | Created local sandbox user `2` and normalized `.local/full-nexus/local-ios-auth.json` with top-level `accessToken`. |
| Authenticated API smoke | `scripts/full-nexus-local-engine.sh smoke` | Pass | All 13 authenticated iOS API endpoints passed. |
| iOS importer policy tests | `xcodebuild test -only-testing:"Nexus HubTests/DebugAuthTokenImporterPolicyTests"` | Pass | 15/15 pin tests on the new `DebugAuthTokenImporter` (path shape, traversal rejection, JSON-extension requirement, file-size cap, key constants, decode roundtrip, no-launch-args no-op). |
| Full authenticated iOS simulator journey (NEW) | `xcrun simctl install` + `simctl launch` with `-nexus_debug_local_auth_import YES`, `-nexus_allow_local_backend YES`, `-nexus_base_url http://127.0.0.1:8200`, and `SIMCTL_CHILD_NEXUS_LOCAL_AUTH_IMPORT_PATH=.../local-ios-auth.json` | Pass | Cold simulator boot produced **43 authenticated REST calls across 19 distinct endpoints**, all with `userId: 2`, all `status: 200`. Endpoints exercised: dashboard (×4), dashboard/home (×3), tasks/filtered (×4), tasks/lists, tasks/list/2, plan/today, plan/week, content/home, content/intelligence, content/intelligence/detail, content/pipeline, cooking/meal-plan, finance/monthly-summary, calendar/events, billing/status, billing/usage, notifications/inbox, notifications/unread-count, skills/catalog. Closes the previously-pending iOS simulator harness step. |
| Cross-skill local smoke | Partial | Requires seed personas | Basic endpoints can be smoked; rich Secretary/Cooking/Finance/Content context seed scripts are still open. |
| Resource cleanup | `xcrun simctl terminate` + `scripts/full-nexus-local-engine.sh cleanup` + `lsof -nP -iTCP:8200 -sTCP:LISTEN` | Pass | Simulator app terminated; backend stopped; cleanup removed local auth token; no `8200` listener remained after the run. |

## Model Usage

Default runner mode blanks model keys. No GPT/model calls are expected unless
`NEXUS_LOCAL_ALLOW_MODEL_CALLS=1` is set explicitly.

This run used no real GPT/model calls. Startup logged that provider routing had
no available providers, which is expected in fixture/contract smoke mode.
