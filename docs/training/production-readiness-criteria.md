# Training Production Readiness Criteria

Generated: 2026-04-28

Latest calendar staging gate: `training-calendar-smoke-20260428094430-r9cyiu` on 2026-04-28. Result: **blocked / no-go** because staging env, staging user, database, OAuth encryption key, and Google/Outlook client credentials were not available in the execution environment.

Latest release-candidate regression pass: 2026-04-28. Backend `npm run verify` passed on the packaged local candidate; Training eval passed at 99/100 across 156 cases; iOS local rich-fixture simulator smoke, authenticated local API journey, DebugAuthTokenImporter policy tests, and the full iOS scheme passed. Google/Outlook staging calendar proof and runtime cross-skill staging proof are still missing, so release status remains **NO-GO**.

This is the release gate checklist for the Training / Coach engine. A criterion is complete only when there is concrete evidence, not an intention, harness, or mock-only result.

## 1. Branch And Merge Hygiene

Training is merge-ready only when:

- [x] backend production candidate is a clean branch locally, not a dirty worktree;
- [x] iOS production candidate is a clean branch locally if iOS Training changes are included;
- [x] all new Training services/tests/scripts/docs/migrations are tracked intentionally in local candidate commits;
- [x] branch names, commit hashes, and backup tags are recorded;
- [x] `git status --short` is clean before release tagging locally;
- [x] generated artifacts are either ignored or committed by policy.

## 2. Backend Test Gates

Required commands on the clean backend candidate:

```bash
npm run typecheck
npm test
npm run verify
npm run eval:training -- --week-start 2026-04-27 --fail-under 95 --out-dir reports/training-eval/production-burndown
```

Pass criteria:

- [x] typecheck passes;
- [x] full test suite passes;
- [x] Training eval passes threshold;
- [x] output logs/reports are documented; generated `reports/` artifacts are excluded from commits;
- [ ] any skipped tests are documented and justified.

## 3. Calendar Lifecycle Gates

Real provider staging proof is mandatory before production calendar claims.

### Google Calendar

- [ ] staging user has connected Google Calendar through real OAuth;
- [ ] smoke creates Training events with test ownership markers;
- [ ] smoke reads events back from Google after creation;
- [ ] same-shape regenerate/update does not duplicate events;
- [ ] changed-shape regenerate replaces or updates according to identity rules;
- [ ] cancel removes only owned Training events;
- [ ] retry remains idempotent;
- [ ] precise cleanup succeeds;
- [ ] report includes event IDs and cleanup status.

### Outlook Calendar

- [ ] staging user has connected Outlook Calendar through real OAuth;
- [ ] smoke creates Training events with test ownership markers;
- [ ] smoke reads events back from Outlook after creation;
- [ ] provider-specific full-body/marker read-back is available if `bodyPreview` is insufficient;
- [ ] update/regenerate/cancel/retry scenarios pass;
- [ ] precise cleanup succeeds;
- [ ] report includes event IDs and cleanup status.

## 4. Training Identity And Lifecycle Gates

Plan/session identity is production-ready only when:

- [ ] every plan has stable plan ID and version;
- [ ] sessions expose stable session identity, plan ID, plan version, day/session role, modality, schedule state, and shape hash;
- [ ] shape hash changes on material coaching-structure changes but not cosmetic copy changes;
- [ ] replacement plans supersede old plans cleanly;
- [ ] cancellation removes only owned events;
- [ ] retries do not duplicate events;
- [ ] stale older plan versions cannot appear active;
- [ ] migration applies on staging clone;
- [ ] rollback/snapshot restore path is documented and rehearsed.

## 5. Constrained-Week And Scheduling Gates

Constrained-week planning is production-ready only when:

- [ ] travel weeks cap volume to real capacity;
- [ ] low-time weeks do not show impossible active sessions;
- [ ] sessions without valid slots are explicit `unscheduled`, `deferred`, or equivalent, not silently forced;
- [ ] Secretary/calendar busy windows are direct inputs to the capacity model;
- [ ] scheduled sessions are the only sessions that create calendar events;
- [ ] reflowed sessions update existing event identity correctly;
- [ ] inactive/deferred states survive reload/read-model reconstruction;
- [ ] users receive structured, deduped explanations for compression/reflow/capping.

## 6. Feedback And Adaptation Gates

Rich feedback is production-ready only when:

- [ ] iOS can submit completed, partially completed, and skipped states;
- [ ] actual duration persists;
- [ ] RPE/RIR where relevant persists;
- [ ] soreness/fatigue/discomfort/substitution/notes persist;
- [ ] backend validates and stores the payload without dropping adaptive fields;
- [ ] future session/week decisions change in response to feedback scenarios;
- [ ] errors are visible and retryable;
- [ ] local UI state refreshes after submit.

## 7. Profile And Follow-Up Gates

Profile intelligence is production-ready only when:

- [ ] backend returns profile completeness and confidence;
- [ ] missing critical fields are structured;
- [ ] follow-up prompts are targeted and deduped;
- [ ] weak profiles produce conservative plans, not risky assumptions;
- [ ] answered prompts improve confidence and materially change plans;
- [ ] iOS can decode and render follow-up prompts safely;
- [ ] API docs cover the fields.

## 8. Explanation And Decision Trail Gates

Explainability is production-ready only when:

- [ ] decision reasons are generated from actual planning decisions;
- [ ] compression, capping, reflow, unscheduled state, recovery reduction, travel changes, and priority tradeoffs have reason codes;
- [ ] explanations include affected entity and source constraint where possible;
- [ ] duplicate warnings/guidance are deduped across refresh/regeneration;
- [ ] iOS can render explanations without overwhelming the session UI.

## 9. iOS Local Simulator Gates

Before production, the iOS app must prove it can handle rich Training output without production deployment.

Required setup:

- [x] local backend can start with iOS API enabled;
- [ ] simulator points to `http://127.0.0.1:8200` using:
  - `nexus_allow_local_backend = true`
  - `nexus_base_url = http://127.0.0.1:8200`
- [x] local test account/session is available without production calendars through the DEBUG-only simulator auth importer;
- [x] deterministic rich Training payloads are available through local backend or debug-only fixture injection.

Required simulator coverage:

- [x] plan overview;
- [x] weekly view;
- [x] session detail;
- [x] gym multi-block session;
- [x] running session;
- [x] cycling session;
- [x] hybrid week;
- [x] capped state;
- [x] reflowed state;
- [x] unscheduled state;
- [x] canceled/superseded state;
- [x] rich guidance/decision trail;
- [x] feedback submit flow;
- [x] cancel/regenerate state;
- [x] no first-exercise-only rendering bug;
- [x] no content clipping in long sessions.

## 10. Cross-Skill Gates

Cross-skill Training orchestration is production-ready only when either it is fully validated or explicitly scoped out of the release.

Required validation:

- [ ] staging Secretary conflict causes reflow/compression/unscheduled state;
- [ ] Cooking fueling gap produces one useful warning, not repeated noise;
- [ ] Finance budget/equipment constraints affect training choices when supported;
- [ ] Content workload/milestone signals are consumed/emitted where supported;
- [ ] tenant/user scoping is verified;
- [ ] stale context does not drive new plans;
- [ ] source of each cross-skill signal is visible in diagnostics.

## 11. GPT-5.5 Intelligence-Readiness Gate

The release can claim GPT-5.5 Extra High Intelligence-level coaching only when:

- [ ] Training generation route/provider is explicitly configured for the intended high-intelligence model class;
- [ ] staging health or logs confirm the selected model class without exposing secrets;
- [ ] fallback behavior is documented when the model/provider is unavailable;
- [ ] deterministic validators still enforce safety, scheduling, identity, and lifecycle rules after model generation;
- [ ] contracts expose rich engine output instead of flattening it to legacy templates.

If these are not true, release copy must avoid claiming GPT-5.5 execution and should describe the release as deterministic engine hardening plus richer coaching architecture.

## 12. Security, Tenant, And Privacy Gates

- [ ] no cross-tenant Training plan/event/session leakage tests fail;
- [ ] calendar smoke uses test tenants only;
- [ ] staging smokes do not touch production calendars;
- [ ] Training logs do not leak health, schedule, OAuth, or feedback PII;
- [x] iOS debug auth shortcuts are gated to debug/simulator/local smoke only;
- [ ] Health/training telemetry is redacted according to existing app policy.

## 13. Rollback Gates

- [ ] backend backup branch/tag exists;
- [ ] database migration rollback or snapshot restore is rehearsed;
- [ ] calendar cleanup strategy for test and production rollback is precise and ownership-based;
- [x] feature flags or config kill switches are identified for Training plan generation/calendar sync if available;
- [ ] rollback owner and command sequence are documented.

## 14. Go / No-Go Rule

Go only if all P0 gates are complete and all P1 gates are either complete or explicitly scoped out with owner approval.

Current status as of this report: **NO-GO**.

## 15. Release-Candidate Evidence Added On 2026-04-28

- Backend full verify passed: 382 test files / 5,994 tests.
- Training eval harness passed: 99/100 across 156 persona/scenario cases.
- iOS focused Training suites passed through `xcodebuild test`.
- iOS `scripts/beta-smoke-local.sh` passed.
- DEBUG-only iOS local auth importer policy tests passed 15/15.
- Authenticated local simulator journey produced 43 authenticated REST calls across 19 endpoints, all with the local runner's user ID and HTTP 200 responses.
- Full iOS scheme passed after dashboard hero presentation tests were aligned with the localized calendar display contract.
- Local iOS simulator smoke rendered rich Training payloads against a local backend listener with deterministic fixtures.
- Local backend and simulator app were shut down after smoke; no listener remained on port `8200`.
- Google/Outlook staging calendar lifecycle remains blocked by missing staging provider prerequisites.
- Runtime cross-skill staging remains blocked by missing staging tenant/database prerequisites.
