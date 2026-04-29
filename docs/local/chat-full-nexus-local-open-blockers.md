# Chat Full Nexus Local Open Blockers

Date: 2026-04-29
Branch: `feature/chat-tenant-safe-context-orchestration`

## P0

None found in this local smoke.

## P1

| ID | Blocker | Why It Matters | Current Evidence | Next Step |
| --- | --- | --- | --- | --- |
| CHAT-LOCAL-P1-01 | Bounded real-provider routing smoke not run. | Fixture pass proves harness and safety rules, but not live provider quality, fallback behavior, latency, or cost metadata. | Provider keys were intentionally blanked. `npm run chat:eval` marked provider fallback and operator-pinned model scenarios as PARTIAL. | Run a bounded staging/local provider smoke with explicit budget, max calls, provider trace, and no production data. |
| CHAT-LOCAL-P1-02 | Streaming/reconnect smoke not run. | Chat reliability under stream interruption, retry, and reconnect remains unproven locally. | iOS WebSocket/streaming transport was not enabled; eval marked streaming interruption as PARTIAL. | Enable explicit local streaming config and run stream completion/interruption/retry smoke, then disable it and verify no sessions remain. |

## P2

| ID | Blocker | Why It Matters | Current Evidence | Next Step |
| --- | --- | --- | --- | --- |
| CHAT-LOCAL-P2-01 | Full local Chat smoke is still a documented command sequence, not a single runner. | Repeatability depends on operators copying the env command correctly. | This smoke used manual env setup and one-off curl/Node checks. | Add a `scripts/chat-full-nexus-local-smoke.sh` or package script that starts, seeds, tests, and shuts down deterministically. |
| CHAT-LOCAL-P2-02 | Chat + Cooking and Chat + Content live natural-language orchestration were fixture-covered, not provider-backed. | Day-to-day quality across these domains needs either deterministic local shortcuts or bounded provider validation. | REST surfaces passed and fixture harness covered scenarios; no live provider calls were made. | Add deterministic local smoke shortcuts where appropriate, or run a bounded provider smoke with fixtures. |
| CHAT-LOCAL-P2-03 | iOS debug auth import has a short unauthenticated launch window. | Backend logs showed initial 401s before subsequent local-authenticated calls returned 200. This is noisy and could confuse smoke evidence. | iOS later authenticated as local `userId=6` and all core surfaces returned 200. | Consider delaying first warmup fetch until debug auth import finishes in DEBUG simulator builds. |
| CHAT-LOCAL-P2-04 | Vector/embedding retrieval namespace smoke was fixture-level only. | If vector retrieval is enabled later, namespace filtering must be proven against the real store. | Current harness tests retrieval safety expectations, but no live vector backend was exercised. | Add live local vector fixture when the retrieval store is configured locally. |
| CHAT-LOCAL-P2-05 | Portal local bypass is disabled under `STAGING=true`, requiring a local admin token for diagnostics. | This is secure but easy to forget during local smoke. | Initial portal calls returned 401; restart with `PORTAL_ADMIN_TOKEN=local-chat-smoke-admin` returned 200. | Keep explicit local admin token in runbook and future runner. |

## P3

| ID | Item | Rationale |
| --- | --- | --- |
| CHAT-LOCAL-P3-01 | The keyboard transformed `/status` to `-status` in the simulator. | It still exercised degraded no-provider rendering. Shortcut buttons exercised deterministic callbacks. |
| CHAT-LOCAL-P3-02 | Local smoke DB was deleted after run, so post-run DB inspection is not available. | Cleanup was required; command output and docs preserve evidence. Future runner can optionally archive redacted smoke JSON before deleting DB. |

## Release Interpretation

This smoke removes local-environment blockers for deterministic Chat, tenant history isolation, iOS local connection, and fixture evaluation. It does not close live provider, streaming, or operator-pinned model release claims.

