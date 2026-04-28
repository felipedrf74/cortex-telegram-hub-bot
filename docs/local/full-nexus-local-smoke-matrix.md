# Full Nexus Local Smoke Matrix

| Group | Command | Pass criteria | Model calls |
| --- | --- | --- | --- |
| Doctor | `scripts/full-nexus-local-engine.sh doctor` | Prints branch, commit, ports, DB, and model-call mode. | None |
| Start | `scripts/full-nexus-local-engine.sh start` | Backend listens on loopback and public `/api/v1/` responds. | None by default |
| Attached start | `scripts/full-nexus-local-engine.sh up` | Backend remains alive in shells that reap background jobs. | None by default |
| Auth token | `scripts/full-nexus-local-engine.sh auth-token` | Local sandbox user token written to `.local/full-nexus/local-ios-auth.json`. | None |
| API smoke | `scripts/full-nexus-local-engine.sh smoke` | Curated iOS API routes return 2xx `{ ok: true }` envelopes or blockers are documented. | None by default |
| Training eval | `npm run eval:training` | Evaluation harness completes and writes results. | Depends on config |
| iOS fixture tests | `xcodebuild test ... TrainingLocalSmokeFixtureTests` | Rich Training states decode/render via fixture path. | None |
| iOS simulator | XcodeBuildMCP launch with local base URL | App points at local backend and fixture/live local payloads render. | None unless explicitly enabled |
| Calendar staging | `npm run smoke:training-calendar:staging` | Google/Outlook read-back lifecycle passes. | None unless generation included |
| Cross-skill staging | `npm run smoke:training-cross-skill:staging` | Staging Secretary/Cooking/Finance/Content flows pass. | Depends on scenario |
| Stop | `scripts/full-nexus-local-engine.sh stop` | No runner-owned backend/content PID remains. | None |
