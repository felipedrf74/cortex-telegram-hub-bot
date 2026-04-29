# Full Nexus Local Engine Open Blockers

Date: 2026-04-29
Batch: 2 - local full-engine audit
Backend branch audited: `feature/chat-p0-tenant-security-audit`

## Verdict

`PASS WITH CONDITIONS`

The local full Nexus product engine can be started and used for backend health,
auth/session, iOS API smoke, core skill route smoke, Chat tenant-safety smoke,
and iOS simulator connection. There is no P0 blocker preventing a developer
from running the local engine in fixture/degraded mode.

The environment is not yet a complete automated local proof of every
cross-skill, provider, streaming, portal, and rich day-to-day scenario. Those
gaps are tracked below and should remain open until they are automated or
explicitly accepted for a release.

## P0 Production Blockers

None found for local engine startup/shutdown in fixture mode.

## P1 Must Fix Before Treating Local Engine As Full Release Gate

| ID | Blocker | Impact | Required closure |
| --- | --- | --- | --- |
| LOCAL-P1-01 | Rich cross-skill seed personas are still incomplete | Default smoke can prove route contracts, but not a realistic Secretary + Training + Cooking + Finance + Content Creation day-in-the-life. | Add deterministic local seed tooling for schedule conflicts, fueling dependency, budget constraint, content workload, travel/low-capacity, weak-profile, and multi-skill heavy personas. |
| LOCAL-P1-02 | `full-smoke` exists but does not yet run the whole cross-skill scenario bank | Operators no longer need to compose the basic backend smoke, Chat tenant smoke, cross-skill fixture smoke, and Chat eval by hand, but rich persisted Secretary/Training/Cooking/Finance/Content personas and iOS launch are still separate. | Extend `full-smoke` with persisted rich persona seeds, local calendar mock scenarios, iOS launch/screenshot evidence, and one consolidated report artifact. |
| LOCAL-P1-03 | True same-user multi-tenant switching is not fully represented by default local seeds | Chat tenant isolation can be checked with separate local users/tenants, but the local engine cannot yet prove a single multi-tenant user switching workspaces end to end. | Add a supported multi-tenant user seed and run tenant-switch conversation/iOS cache smoke against it. |
| LOCAL-P1-04 | Real model-provider routing and fallback smoke remains explicit opt-in | Default fixture/degraded mode is correct for safety and cost, but it does not prove provider fallback, operator pins, or live routing metadata. | Add a bounded provider smoke that records provider/model/tier/category/fallback/cost metadata and uses local non-production data only. |
| LOCAL-P1-05 | Real Google/Outlook provider lifecycle remains staging-only | Local mock state cannot prove provider read-back, external deletion, or provider retry behavior. | Keep Google/Outlook staging calendar smoke as a separate production release gate; never mark local-only mock proof as provider proof. |
| LOCAL-P1-06 | Streaming/reconnect/local WebSocket behavior is not part of the default full-engine smoke | Chat streaming interruptions, reconnect idempotency, and stale stream repair can regress without a local scenario. | Add local streaming/reconnect smoke with tenant-scope assertions and duplicate-message prevention checks. |

## P2 Should Fix

| ID | Blocker | Impact | Required closure |
| --- | --- | --- | --- |
| LOCAL-P2-01 | Detached `start` can be unreliable in Codex/CI shells | Detached child processes may be reaped, making the app appear offline even though the command returned. | Prefer `up` attached mode in Codex/CI or add a supervised dev-server wrapper with explicit readiness and shutdown. |
| LOCAL-P2-02 | Python content-engine sidecar is optional and environment-dependent | Content Creation API smoke can pass while deeper Python content-engine behavior is not running. | Document/install sidecar venv prerequisites and add sidecar health to full smoke when `NEXUS_LOCAL_START_CONTENT_ENGINE=1`. |
| LOCAL-P2-03 | Calendar/agenda mock fixture flags are not standardized as a runner contract | Some Secretary/Chat docs reference local agenda fixtures, but the runner does not expose them as an obvious first-class option. | Add explicit runner flags or commands for Secretary local agenda fixtures and calendar mock scenarios. |
| LOCAL-P2-04 | Portal/web smoke is not automated through a browser | Backend portal routes exist, but local full-engine proof is mostly API-level. | Add a portal smoke for login/bypass, tenant-safe diagnostics, aggregate model/provider metrics, and no raw chat-content exposure. |
| LOCAL-P2-05 | iOS simulator launch remains a manual/XcodeBuildMCP step | The backend runner mints auth, but it does not install/launch iOS with the correct DEBUG args itself. | Add an iOS launch helper or document a single XcodeBuildMCP profile command that passes base URL and auth import env. |
| LOCAL-P2-06 | iOS can still show a local connectivity banner when the app is pointed at a stopped local backend | This is expected if a DEBUG local base URL is active and no server is running, but it can be misread as a production outage. | Add a local/prod connection status indicator in debug builds or a reset helper for local base URL state. |
| LOCAL-P2-07 | Vector/embedding namespace smoke is fixture-level only where vector storage is absent/disabled | Future retrieval/vector work could introduce tenant leaks if not covered by the full local runner. | Add namespace/isolation smoke when vector storage is enabled locally. |
| LOCAL-P2-08 | Cleanup verification is split across docs and scripts | Operators can stop the backend but forget simulators, content sidecars, or model-call loops. | Add a `cleanup --verify` mode that checks backend/content ports, simulator state, model loops, tunnels, and local auth files. |

## P3 Deferrable Improvements

| ID | Improvement | Why deferrable |
| --- | --- | --- |
| LOCAL-P3-01 | Generate `.env.local-full-nexus` from a template | Runner already supplies defaults; generated env improves discoverability. |
| LOCAL-P3-02 | Archive smoke outputs under `.local/full-nexus/reports/` | Current docs capture results manually; artifacts would improve regression comparison. |
| LOCAL-P3-03 | Add local dashboard for smoke status | Useful operator experience, not required for correctness. |
| LOCAL-P3-04 | Add richer local personas for APNs/HealthKit placeholders | Real APNs and HealthKit still require device/TestFlight validation. |

## Not Blockers For Local Startup

These are intentionally outside default local fixture smoke:

- production database access
- production provider credentials
- production calendars
- real APNs delivery
- real Apple Health / Apple Watch data
- unrestricted model-provider calls
- production portal/admin tokens

## Closure Sequence

Recommended next work:

1. Add deterministic full-product seed script for local users, tenants, and rich skill state.
2. Extend `scripts/full-nexus-local-engine.sh smoke` into a broader full-engine smoke report.
3. Add a same-user multi-tenant switch scenario.
4. Add Chat streaming/reconnect local smoke.
5. Add a bounded live-provider routing smoke with explicit cost and fallback metadata.
6. Add an iOS launch helper using the existing DEBUG local auth importer.
7. Add portal/web browser smoke for diagnostics and tenant-safe admin views.
8. Promote cleanup verification to a single required runner command.

## Release-Gate Interpretation

Use the current local engine as the first validation gate before staging and
production. It is strong enough for local backend/auth/iOS route validation,
local Chat tenant-safety checks, fixture/degraded skill checks, and simulator
connection proof.

Do not use it as the sole production release gate until the P1 blockers above
are closed or explicitly accepted. Staging provider smoke, signed-device
validation, and production health checks remain separate gates.
