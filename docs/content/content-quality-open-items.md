# Content Quality Open Items

## P0 Production Blockers

None found in the deterministic fixture harness. The baseline has no tenant-reference leakage and no hallucinated-reference failures.

## P1 Must Fix Before Claiming Full Production Quality

- Full local Nexus engine run is still required. The current harness validates fixture semantics, not live Chat -> Content -> Secretary -> storage -> iOS/portal round trips.
- Limited real-provider quality sampling is still required before claiming model output quality across routed providers.
- Portal and iOS rendering are not validated by this harness; source attribution, approval state, novelty warnings, and workflow status still need frontend smoke.
- Secretary scheduling is now end-to-end proven for the backend ledger and live `schedule_content` action path via `requestContentScheduleThroughSecretary()`, `POST /workflow/:id/actions`, and focused tests, but not for provider-backed staging calendar sync or rich frontend schedule-state rendering.

## P2 Should Fix

- Add persisted eval run history tied to skill version registry.
- Add representative real-provider sampling with strict provider-call caps and redacted prompt logging.
- Add generated transcript artifacts for product review, separate from rubric JSON.
- Add regression checks for broken-link ingestion and source extraction failures.
- Add analytics feedback scenarios after real published-content metrics exist.

## P3 Deferrable

- Add platform-specific rubric extensions for podcast, carousel, and newsletter depth.
- Add reviewer calibration workflow so human QA can compare rubric scores across releases.
- Add portal dashboard for aggregate Content eval trends.

## Current Release-Gate Verdict

`PASS_WITH_CONDITIONS`

Reason: fixture harness passes with score 91/100 and zero critical failures, but local full-product smoke, limited real-provider sampling, and frontend rendering validation remain open.
