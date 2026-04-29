# Training Release Gate

Gate date: 2026-04-29
Evidence source: [training-release-smoke-results.md](/Users/felipedominguez/Desktop/Custom%20Connectors/Cortex/cortex-telegram-hub-bot/docs/local/training-release-smoke-results.md)

## Verdict

**PASS WITH CONDITIONS**

Training is acceptable for the local release gate. The local Nexus product engine validated the app-facing Training flow, rich payload contract, cancellation cleanup, regeneration duplicate prevention, feedback submission, cross-skill fixture behavior, tenant isolation, and focused iOS rendering support.

## Passed Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Chat asks Training question | PASS | `/api/v1/chat/message` with `/training plan` returned `domain=triathlon`, route `keyword`, no model spend. |
| Training creates plan | PASS | `/api/v1/training/plan/generate` returned `201`, `planId=1`, `totalSessions=5`. |
| Secretary/local schedule placement | PASS WITH NOTE | Generated sessions persisted active rich schedule state `scheduled`; cross-skill Secretary conflict fixture passed. |
| Constrained week reflows correctly | PASS | `coach-kernel-constrained-week-capacity.test.ts` passed; cross-skill fixture showed Secretary pressure produces reflow/modular guidance. |
| Canceled plan cleans agenda | PASS | Cancellation hard-deleted sessions and moved synthetic agenda ownership out of `active`. |
| Regenerated plan does not duplicate events | PASS | Regeneration left one active plan and zero duplicate active ownership rows in local no-provider mode. |
| iOS renders rich payloads locally | PASS | Focused iOS simulator tests succeeded for rich payloads, lifecycle states, feedback payloads, and local smoke fixtures. |
| Feedback can be submitted | PASS | `/api/v1/training/complete` persisted a completion row with notes/RPE. |
| Cooking/Fueling context is not duplicated | PASS | Cross-skill fixture verified a single specific fueling gap, not repeated generic warnings. |
| Tenant scoping holds | PASS WITH CONDITIONS | Chat tenant smoke passed 12 checks with no leakage; Training DB rows stayed user-scoped. Same-user multi-tenant workspace switching remains unsupported by current iOS ingress and is tracked outside this Training gate. |

## Conditions Before Production Promotion

- Real Google/Outlook provider lifecycle proof remains a staging gate. This local smoke intentionally used no production calendars and no real provider writes.
- If release notes claim free-form Chat reasoning quality for Training, run a bounded live-provider Chat scenario. This local gate validated the token-zero Chat-to-Training path and deterministic fixtures.
- If product acceptance requires a manual iOS walkthrough, run the app against the local backend with a minted local auth token. The focused iOS test suite already proves rich Training payload decoding/rendering contracts.

## Non-Blocking Notes

- Detached `scripts/full-nexus-local-engine.sh start` initially lost its listener after the first health probe. Attached `up` mode stayed stable and is the recommended local Codex/CI shell mode.
- Local no-provider mode reports `eventsCreated=0` during plan generation. Agenda cleanup was proven using a synthetic local ownership row so no real Google/Outlook event was created or deleted.
- The Chat tenant smoke required a fixture-marker cleanup because the memory safety guard rejected values that looked like secrets/card numbers. The product guard behaved correctly; the smoke script now uses harmless markers.

## Release Recommendation

Proceed with Training release work **only under the conditions above**. There is no local Training P0 blocker from this smoke. Keep provider staging and any live-model Chat claims separate from this local release gate.
