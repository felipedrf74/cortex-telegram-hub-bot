# Missing High-Value Release Checks

Date: 2026-05-01

| Priority | Missing check | Value | Proposed implementation |
| --- | --- | --- | --- |
| P0 | Changed-file risk classifier | Prevents over-testing docs and under-testing risky source changes. | Script maps changed paths to required gates. |
| P0 | Release identity artifact | Stops stale SHA/test-count drift. | `scripts/release-identity.sh` now provides first version; later persist JSON artifact. |
| P0 | Simulator hygiene wrapper | Prevents clone/focus invalid test evidence. | `scripts/ios-single-simulator-test.sh` in iOS repo. |
| P0 | Local service cleanup checker | Reduces flaky smoke reruns. | Script verifies ports, DB files, and process names before/after smoke. |
| P0 | Staging smoke artifact writer | Lets QA verify evidence without rerunning expensive smokes. | All smoke scripts write JSON under `docs/release/smoke-evidence/`. |
| P1 | Tenant-forged request smoke template | Standardizes security probes across skills. | Shared test helper/script for tenant A vs tenant B. |
| P1 | Calendar no-duplicate provider template | Standardizes create/retry/update/cancel cleanup. | Extend Training/Secretary provider smoke runner. |
| P1 | Provider-call escape checker | Ensures local fixture mode never calls real providers. | Test/CLI that fails if provider clients are invoked under `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0`. |
| P1 | Model-routing fallback report | Validates configurable routing rather than fixed provider assumptions. | Focused routing tests and metadata report. |
| P2 | Current release index | Separates active blockers from historical docs. | `docs/release/current-release-index.md` generated per RC. |
