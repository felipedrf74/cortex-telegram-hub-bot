# GPT-5.5 Smoke Test Usage Notes

Date: 2026-04-28

No real GPT/model calls have been run by this local full-product runner yet.

Default validation mode uses deterministic fixtures, local seeded context, and
blank provider keys. Add an entry here for every intentional model-enabled
local smoke.

| Date | Branch | Commit | Scenario | Provider/model | Calls | Result | Cleanup |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-28 | `feature/local-full-nexus-product-engine-smoke-environment` | `b8f9be7` | Full local API health + authenticated iOS API smoke | None | 0 | Passed health, local auth token, 13/13 script endpoints, and 43 authenticated simulator REST calls across 19 endpoints | Backend stopped; no `8200` listener remained. |
