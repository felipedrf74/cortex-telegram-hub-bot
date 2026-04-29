# Full Nexus Local Open Blockers

| Priority | Blocker | Impact | Required closure |
| --- | --- | --- | --- |
| P1 | Cross-skill persona seed scripts are incomplete | Full local Training + Secretary/Cooking/Finance/Content orchestration cannot be marked automated. | Add deterministic local seed tool for conflict, fueling, budget, workload, weak-profile, recovery, and travel personas. |
| P1 | Local multi-tenant access-denial smoke is not automated | Tenant isolation is covered by tests, but local product smoke cannot yet prove two tenant sessions. | Extend runner with second sandbox user and forbidden-access checks. |
| P1 | Real Google/Outlook lifecycle is staging-only | Local mock can prove identity/idempotency, not provider read-back. | Keep staging provider gate as production release blocker. |
| P2 | ~~iOS full-auth local simulator smoke has not yet been rerun with this runner token~~ **CLOSED 2026-04-28** | Previous iOS smoke was Training fixture-fed; backend auth now works locally 13/13 through curl. | ~~Add a DEBUG-only iOS token import/bootstrap step, then launch iOS with local base URL and the runner-created sandbox session.~~ Done: `Nexus Hub/Core/DebugAuthTokenImporter.swift` (DEBUG+simulator-only, dual launch-arg gate, env-var path with shape checks, 16 KB cap) wired from `AuthManager.init()`. Pinned by 15/15 policy tests. Validated by a cold simulator launch that produced 43 authenticated REST calls across 19 endpoints with `userId: 2`. See `full-nexus-local-smoke-results.md`. |
| P2 | Content engine sidecar is optional and not part of default smoke | Deep content research behavior is not covered by default local run. | Enable `NEXUS_LOCAL_START_CONTENT_ENGINE=1` when validating Content sidecar behavior. |
| P2 | Real GPT-5.5 quality smoke is explicit opt-in | Default smoke proves contracts/state, not reasoning quality. | Run one bounded model-enabled scenario and record usage when release candidate is frozen. |
