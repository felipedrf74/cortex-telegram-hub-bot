# Training Engine Final Production Go / No-Go

Date: 2026-04-28
Backend RC branch reviewed: `release/training-engine-production-candidate` at `2f14acb` (code payload `b8f9be7`)
Backend hardening branch evidence: `release/training-engine-production-hardening` at `2f14acb` (code payload `b8f9be7`)
iOS local-smoke branch evidence: `release/ios-training-engine-local-smoke-candidate` at `b1aad7f` (code payload `537abf6`)
Deployment: not run

## 1. Final Verdict

**NO-GO for production deployment.**

The Training engine is substantially improved and locally validated, but production release is not supportable yet because critical release trust gates remain open:

1. Google Calendar staging lifecycle read-back has not run.
2. Outlook Calendar staging lifecycle read-back has not run.
3. Cross-skill staging runtime smoke has not run against seeded staging data.
4. Migration 082 rollback has not been rehearsed on a staging clone.
5. GPT-5.5 runtime/provider proof and release-copy restraint still need final staging evidence.

Post-review update: the release work has been packaged into clean backend/iOS candidate commits and pushed to review branches, the local-auth iOS harness gap has been closed, and dedicated Training operational kill switches have been added/tested for generation, calendar writes/sync, and cross-skill signal publishing. These reduce operational risk but do not override the remaining provider staging, migration rollback, cross-skill staging, and runtime-model proof gates.

Local iOS simulator proof is valid as pre-release compatibility evidence because it ran against a local backend listener and upgraded-engine-shaped fixtures, and resource shutdown was confirmed. It is not production iOS proof and must be followed by production-safe post-deploy validation if/when the backend ships.

## 2. Evidence Summary

| Area | Evidence | Status | Production interpretation |
| --- | --- | --- | --- |
| Backend automated tests | `npm run verify` passed: 382 test files / 5,994 tests in `docs/training/production-test-results.md`; commit hook also ran `npm run typecheck` and `npm test` on `b8f9be7` | Pass | Strong local code confidence on the packaged RC |
| Training evaluation harness | 99/100 across 156 cases in `docs/training/release-candidate-test-run.md` and `docs/training/production-readiness-criteria.md` | Pass | Strong coach-quality regression confidence |
| Functional hardening | Constrained-week, inactive state, marker refresh, profile quality, decision reasons, dry-run smoke safety, and operational switches documented in `docs/training/production-fixes-applied.md` | Pass locally | Backend behavior improved, still needs staging/provider proof |
| Google Calendar staging | `docs/training/final-calendar-staging-results.md` shows prerequisite block; providers run: none | Fail / blocked | Production blocker unless explicitly waived |
| Outlook Calendar staging | Same final calendar staging result; providers run: none | Fail / blocked | Production blocker unless explicitly waived |
| Internal agenda staging | Not run because staging DB/user missing | Fail / blocked | Production blocker |
| Cross-skill staging | `docs/training/final-cross-skill-staging-results.md` local fixtures passed; staging runtime blocked | Fail / blocked | Production blocker unless explicitly waived |
| Security / tenancy | `docs/training/final-security-tenancy-review.md` reports no open P0/P1 auth or tenancy blockers after log redaction fixes | Pass at code/test level | Does not replace provider/cross-skill staging proof |
| iOS local simulator | `docs/ios/release-candidate-local-ios-smoke-results.md`, `docs/ios/final-training-ios-smoke-results.md`, and `docs/local/full-nexus-local-smoke-results.md` show rich fixture smoke plus authenticated local API journey passed | Pass as local pre-release compatibility proof | Requires post-deploy production-safe validation |
| Local resource shutdown | `docs/ios/release-candidate-local-engine-shutdown-confirmation.md` confirms backend/app stopped and port 8200 clear | Pass | Local smoke complete, no resource burn |
| Rollback | `docs/training/release-candidate-rollback-plan.md` documents rollback path | Partial | Migration rollback rehearsal still missing |
| RC merge hygiene | Backend candidate branch `2f14acb` and iOS candidate branch `b1aad7f` were pushed with clean worktrees after validation | Pass for review packaging | Human review still pending; no longer the release-blocking defect |

## 3. Functional Readiness

| Capability | Assessment | Evidence | Remaining risk |
| --- | --- | --- | --- |
| Training plans | Improved and locally tested | Full verify, eval harness, production fixes docs | Must be staging-validated before production |
| Constrained/travel weeks | Improved | Fully booked days now become explicit `unscheduled` instead of fake times | Needs staging calendar proof with real conflicts |
| Recovery variation | Improved | Poor-recovery tests/eval included in local suite | Beta telemetry should calibrate thresholds |
| Profile follow-ups | Backend route fixed | `profileQuality` and follow-up prompts serialized | iOS production display and answer loop still needs product proof |
| Schedule compression explanations | Backend route fixed | `decisionReasons` serialized and tested | iOS grouping/display is local-smoke proven only |
| Catalog depth | Improved | Eval 99/100 and catalog tests in packaged candidate | Continue reviewing catalog additions for unused template bloat |
| Feedback handling | Backend analysis tests pass; iOS feedback payload tests pass | Local fixture feedback flow passed | End-to-end persistence causing future plan adaptation remains a P2/P1 product-claim gate |
| GPT-5.5 intelligence quality | Architecture supports richer reasoning; deterministic validators/eval exist | Docs and eval harness | Runtime model/provider proof is missing; do not claim GPT-5.5 execution in release copy |
| Avoidance of hardcoded outputs | Stronger than prior engine | Scenario-based eval and tests | Continue reviewing catalog additions for unused template bloat |

Functional verdict: **locally strong, not production-cleared**.

## 4. Calendar Readiness

Calendar readiness is the largest release blocker.

| Provider/layer | Create | Sync/update | Cancel/delete | Regenerate/replace | Retry/idempotency | Stale cleanup | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Google Calendar staging | Not run | Not run | Not run | Not run | Not run | Not run | Blocked |
| Outlook Calendar staging | Not run | Not run | Not run | Not run | Not run | Not run | Blocked |
| Internal agenda staging | Not run | Not run | Not run | Not run | Not run | Not run | Blocked |
| Automated local tests | Covered | Covered | Covered | Covered | Covered | Covered | Pass locally |

Blocking evidence:

- `docs/training/final-calendar-staging-results.md` reports providers run: `none`.
- Missing prerequisites include staging mode, smoke/live-write flags, staging user ID, OAuth encryption key, staging database path, and Google/Outlook client credentials.
- No event IDs were created, read back, updated, or cleaned.

Calendar release decision: **NO-GO unless both providers are explicitly waived by the owner.** If a provider is waived, the waiver must state user impact, rollback plan, and whether calendar sync is disabled or shipped as beta-risk.

## 5. iOS Readiness

Local iOS proof is valid for pre-release compatibility, with clear boundaries.

| Item | Value |
| --- | --- |
| iOS branch | `release/ios-training-engine-local-smoke-candidate` |
| iOS commit | `b1aad7f` branch head; code payload `537abf6` |
| Backend branch used | `release/training-engine-production-hardening` |
| Backend commit used | `2f14acb` branch head; code payload `b8f9be7` |
| Local API | `http://127.0.0.1:8200` |
| Simulator | `iPhone 17 Pro`, iOS Simulator 26.4.1 |
| Rich fixture launch args | `-NEXUSQATrainingFixture rich-v1 -nexus_allow_local_backend YES -nexus_base_url http://127.0.0.1:8200` |
| Authenticated local launch args | `-nexus_debug_local_auth_import YES -nexus_allow_local_backend YES -nexus_base_url http://127.0.0.1:8200` |
| Auth import env | `NEXUS_LOCAL_AUTH_IMPORT_PATH=<runner-produced local-ios-auth.json>` |
| Shutdown | Confirmed; no listener remained on port `8200` |

Payloads/states tested:

- capped session;
- reflowed session;
- unscheduled session;
- canceled session;
- superseded session;
- regenerated plan/version metadata;
- gym multi-block session with multiple exercises;
- running threshold session;
- cycling threshold/recovery sessions;
- hybrid week;
- substitutions;
- schedule-compression explanations;
- warnings/decision trail;
- unknown future block fallback;
- rich feedback submission in fixture mode.

Evidence:

- `docs/ios/final-training-ios-local-engine-smoke.md`
- `docs/ios/final-training-ios-smoke-results.md`
- `docs/ios/release-candidate-local-ios-smoke-results.md`
- `docs/ios/release-candidate-local-engine-shutdown-confirmation.md`
- `docs/local/full-nexus-local-smoke-results.md` records the authenticated simulator journey: 43 authenticated REST calls across 19 endpoints with the local runner's user ID, all HTTP 200.
- Full iOS scheme passed on `iPhone 17 Pro` after aligning dashboard hero presentation tests with the localized calendar display contract.

Remaining frontend risks:

- Rich Training rendering still uses deterministic fixtures for coverage breadth; the authenticated journey proves full local auth/session plumbing and major iOS-facing REST surfaces.
- Signed TestFlight/device validation, real provider auth, APNs, Apple Health, and post-deploy production-safe Training validation remain outside this proof.

iOS release decision: **acceptable as pre-release compatibility proof, not sufficient as production proof**.

## 6. Cross-Skill Readiness

| Flow | Local fixture result | Staging result | Production decision |
| --- | --- | --- | --- |
| Training + Secretary conflicts | Pass in fixture contracts | Blocked; no staging user/database | Not production-cleared |
| Training + Cooking fueling gaps | Pass in fixture contracts | Blocked; no staging user/database | Not production-cleared |
| Training + Finance constraints | Pass in fixture contracts | Blocked; no staging user/database | Not production-cleared |
| Training + Content workload/milestones | Pass in fixture contracts | Blocked; no staging user/database | Not production-cleared |
| Shared context integrity | Fixture checks passed | Staging not run | Not production-cleared |

Cross-skill verdict: **NO-GO for claiming full multi-skill staging readiness**. The local fixture harness is useful and should remain, but it is not staging evidence.

## 7. Security And Tenant Readiness

Security/tenancy code-level verdict: **pass with remaining staging dependencies**.

Evidence from `docs/training/final-security-tenancy-review.md`:

- Training routes are mounted behind auth middleware.
- Plan cancellation checks plan ownership.
- Session mutations resolve session -> plan -> user ownership.
- Calendar ownership records include plan/session/user/provider event identity.
- Cross-skill signal reads/writes are user-scoped.
- Logger redaction was strengthened for auth/token/provider SDK error shapes.
- Raw Training objective/title/body logging was reduced to shape metadata.

Remaining security/privacy risks:

- Real provider calendar staging still must prove precise ownership cleanup.
- Cross-skill staging still must prove tenant/user scoping against real staged context.
- `/training/skip` does not persist every rich feedback field; not a security blocker, but it limits adaptive learning fidelity.
- Whole-product log minimization outside Training remains future work.

## 8. Operational Readiness

| Area | Status | Notes |
| --- | --- | --- |
| Logs/observability | Improved | Redaction and safer shape logging added. |
| Debuggability | Improved | Decision reasons, identity markers, eval harness, staging harnesses. |
| Rollback plan | Documented, partial | Commands and calendar cleanup strategy documented; migration rehearsal missing. |
| Feature flags / kill switches | Improved | Dedicated env switches now exist for Training generation, calendar writes/sync, and Training cross-skill signal publishing. |
| Monitoring | Needs final setup | Must monitor calendar sync failures, duplicate events, generation failures, feedback errors, and provider auth expiration. |
| Resource control | Local smoke clean | Port 8200 shutdown confirmed after iOS smoke. |
| Staging resource control | Not proven | Provider/cross-skill staging not run. |
| Release packaging | Improved | Clean backend and iOS candidate branches are pushed for review; production merge/deploy has not been performed. |

Operational verdict: **improved, but not production-ready yet**.

## 9. Remaining Blockers

### P0 Blockers

| ID | Blocker | Required closure |
| --- | --- | --- |
| P0-1 | Google Calendar staging lifecycle not run | Real staging create/update/regenerate/cancel/retry read-back and cleanup, or explicit owner waiver |
| P0-2 | Outlook Calendar staging lifecycle not run | Same as Google, or explicit owner waiver |
| P0-3 | Calendar safety not proven against real providers | Provider event IDs, identity markers, stale cleanup, and retry idempotency verified by read-back |

Resolved local P0: clean backend/iOS candidate packaging is closed and pushed for review (`2f14acb` / `b1aad7f`) with clean worktrees and post-packaging validation evidence. It still requires human review before any release process.

### P1 Blockers / Must-Fix Or Explicitly Accept

| ID | Blocker | Required closure |
| --- | --- | --- |
| P1-1 | Migration 082 rollback not rehearsed | Staging clone migration + snapshot restore/old-code compatibility proof |
| P1-2 | Cross-skill staging runtime not run | Seeded staging tenant smoke or explicit scoped release decision |
| P1-3 | GPT-5.5 runtime not proven | Verify model/provider routing or avoid runtime claims |
| P1-4 | Feature flag / operational kill switch unclear | **Fixed in code**: use `TRAINING_ENGINE_DISABLED=1`, `TRAINING_PLAN_GENERATION_DISABLED=1`, `TRAINING_CALENDAR_WRITES_DISABLED=1`/`TRAINING_CALENDAR_SYNC_DISABLED=1`, or `TRAINING_CROSS_SKILL_SIGNALS_DISABLED=1` as scoped disable paths. Keep as operational checklist item, not a code blocker. |

## 10. Deferrable Open Items

These can defer if recorded in release notes:

- Production-safe iOS E2E after backend deployment.
- End-to-end proof that rich iOS feedback changes future plan generation.
- Legacy orphaned calendar event reconciliation dry run.
- Outlook full-body marker read-back helper if body preview is insufficient.
- Recovery-threshold calibration using beta telemetry.
- Continued catalog expansion and performance profiling.
- Whole-product non-Training log minimization.

## 11. Production Risks

| Risk | Severity | Why it matters |
| --- | --- | --- |
| Provider calendar lifecycle unproven | Critical | A Training calendar bug directly breaks user trust and can create stale/duplicate events. |
| Dirty RC packaging | Critical | Uncommitted work can be lost, over-included, or shipped with test artifacts. |
| Migration rollback unproven | High | Identity/hash schema changes are additive but no down migration exists. |
| Cross-skill staging unproven | High | Real Secretary/Cooking/Finance/Content interactions may differ from fixture contracts. |
| GPT-5.5 runtime claim unproven | High | Release messaging could overstate deployed intelligence. |
| Missing operational kill switch | Lowered | Env switches now exist; production ops still need to include the exact switches in the deployment checklist. |
| iOS proof is local/pre-release | Medium | Rich Training fixture coverage and authenticated local API coverage are good compatibility signals, but production auth/provider state still needs post-deploy validation. |

## 12. Rollback Readiness

Rollback documentation exists in `docs/training/release-candidate-rollback-plan.md`.

Rollback baseline:

- `origin/main` at `a3f1b78`
- backup tag: `backup-codex-pre-training-second-opinion-20260427-2246`

Documented rollback path:

```bash
git fetch origin
git switch main
git reset --hard a3f1b78
npm run verify
# then use the normal staging deploy, staging smoke, production promote, and production health process
```

Production release command path, documented but not executed:

```bash
./scripts/deploy-staging.sh
./scripts/staging-smoke.sh
./scripts/promote-to-prod.sh
```

Rollback readiness caveats:

- Migration 082 snapshot/restore rehearsal is still missing.
- Calendar cleanup rollback must use ownership metadata/provider event IDs only.
- Dedicated Training kill switches now exist in code; production ops still need final environment/runbook confirmation.

Rollback verdict: **documented but not fully verified**.

## 13. Monitoring Checklist

Before and after production deployment, monitor:

- Training plan generation failures and latency.
- Calendar sync create/update/delete counts by provider.
- Calendar sync failure rates and provider error codes.
- Duplicate event detection by plan/session identity.
- Stale ownership rows and orphaned provider event mappings.
- Cancellation/regeneration outcomes.
- Sessions marked `unscheduled`, `capped`, `reflowed`, `superseded`, or `cancelled`.
- Cross-skill warning counts and duplicate warning suppression.
- Feedback submission failure rates.
- Auth/tenant denial rates for Training mutations.
- Model/provider timeout/degraded fallback rates.
- iOS decode/render errors for Training payloads.

Post-deploy production-safe checks:

1. Verify backend health.
2. Verify Training plan read endpoint for test/founder account.
3. Create a small test Training plan only for a controlled test account.
4. Confirm internal agenda rows and identity markers.
5. If calendar sync is enabled, create/read/delete one controlled provider event and clean it precisely.
6. Confirm iOS Home and Training open without decode errors.
7. Confirm no local/staging smoke process remains active.

## 14. Exact Release Recommendation

Do not deploy this Training RC to production today.

Recommended next action:

1. Review and push the packaged local backend/iOS candidate commits only after human approval:
   - backend branch head `2f14acb` (code payload `b8f9be7`)
   - iOS branch head `b1aad7f` (code payload `537abf6`)
2. Rehearse migration 082 on a staging DB clone.
3. Run real Google/Outlook staging calendar lifecycle smokes:

```bash
TRAINING_CALENDAR_STAGING_RESULTS_PATH=docs/training/final-calendar-staging-results.md \
npm run smoke:training-calendar:staging
```

4. Run real cross-skill staging smoke:

```bash
TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH=docs/training/final-cross-skill-staging-results.md \
npm run smoke:training-cross-skill:staging
```

5. Confirm GPT-5.5 runtime/provider configuration or remove runtime-model claims from release copy.
6. If all gates pass, deploy to staging only:

```bash
./scripts/deploy-staging.sh
./scripts/staging-smoke.sh
```

7. Promote to production only after staging soaks and final owner approval:

```bash
./scripts/promote-to-prod.sh
```

These commands are release path documentation only. They were not executed in this review.

## 15. Exact Conditions Required Before Production Deployment

Production can move from NO-GO to GO only when all of the following are true:

- [x] `release/training-engine-production-candidate` is clean and reviewable locally.
- [x] All intended source, test, migration, script, and documentation changes are committed intentionally in local candidate commits.
- [x] Generated artifacts/secrets/local DBs are excluded from local candidate commits.
- [x] `npm run verify` passes on the clean candidate commit.
- [x] Training eval harness passes on the clean candidate commit.
- [ ] Migration 082 has been rehearsed on a staging clone with rollback proof.
- [ ] Google staging lifecycle passes with event read-back and cleanup.
- [ ] Outlook staging lifecycle passes with event read-back and cleanup.
- [ ] Internal agenda lifecycle passes on staging data.
- [ ] Cross-skill staging smoke passes or is explicitly scoped out with owner approval.
- [ ] Security/tenant tests pass on the clean candidate.
- [ ] iOS local smoke remains green against the final candidate backend shape.
- [ ] Post-deploy iOS validation plan is acknowledged as required.
- [ ] Runtime model/provider claims match actual staging/prod config.
- [ ] Training calendar sync rollback/disable path is confirmed.
- [ ] Owner explicitly approves any remaining P1 waivers.

Until then, the correct final verdict is **NO-GO**.
