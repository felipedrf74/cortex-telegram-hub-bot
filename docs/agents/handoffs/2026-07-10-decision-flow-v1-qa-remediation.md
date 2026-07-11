# Agent Handoff - Decision Flow v1 QA Remediation

> [!CAUTION]
> **Production regression requiring Felipe's decision:** production remains on 4.14.216 and does **not** contain the Microsoft To Do partial-list-sync hotfix marker. The 2026-07-08 dirty-tree hotfix was overwritten by the 4.14.215/4.14.216 promotes, so the user-facing partial-list-sync bug is presumed live again. This branch now preserves and merges the hotfix in commit `54a2bdc1`, but this session did not push or deploy. Felipe must choose either an expedited staging-to-production promote of this green branch or a repeat scoped hotfix. Operational lesson: a dirty hotfix deploy must be committed to a branch the same day or the next promote can silently revert it.

## Session summary

- **Started:** 2026-07-10
- **Completed:** 2026-07-11 (Europe/Lisbon)
- **Backend branch/worktree:** `main`, `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot`
- **iOS branch/worktree:** `main`, `/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub`
- **Agent:** Codex
- **Scope:** post-hostile-QA remediation for Secretary reasoning, Decision Center lifecycle/execution, deterministic conflict policy, and aligned iOS presentation/recovery.
- **Release posture:** local implementation and verification only. No push, staging deploy, production deploy, flag enablement, TestFlight, or App Store action occurred.

## Preservation protocol and upstream reconciliation

Before any remediation edit, the dirty backend tree was preserved exactly as requested:

| Commit | Purpose | Preserved files |
| --- | --- | --- |
| `54a2bdc1` | `wip(task-store): preserve MS To Do partial-list-sync hotfix (prod-deployed 2026-07-08, overwritten by 4.14.215/216)` | task-store adapter/interface/sync engine, two task-store suites, 2026-07-08 handoff |
| `0487d090` | `wip(garmin): preserve in-flight coach metering work (partially superseded upstream; 2 metering suites red)` | Garmin coach source/test and registry-shadow evidence |

- Both preservation commits used Felipe's one-time `--no-verify` authorization because the inherited Decision Flow parse error made the tree known-red.
- `backup/dirty-tree-2026-07-10` points to `0487d090`, pinning both WIP commits.
- `git show --stat 54a2bdc1` reports 6 files, 258 insertions, 17 deletions.
- `git show --stat 0487d090` reports 3 files, 360 insertions, 89 deletions.
- Backend remediation commit: `1a4438d2`.
- Backend upstream merge commit: `e46a447e`, merging `origin/main` at 4.14.216.
- iOS remediation commits: `a46fb60` and `422517d`; upstream merge commit: `7439a73`.
- Upstream migration `226_paid_ai_cost_controls.sql` is followed by local additive `227_decision_flow_v1.sql`; the prior `expected_226:got_227` gap is closed.
- Task-store files were not changed upstream, so the preserved MS To Do fix remains on current `main`.
- Garmin used upstream 4.14.216 as the production-truth base. Only the explicit, test-pinned `{ maxTokens: 2500, userId: meteringUserId, tenantId: meteringTenantId }` local delta was reapplied. Both metering contract suites are green.
- **MANUAL_REQUIRED - Garmin product intent:** the rest of the original in-flight Garmin WIP was deliberately not guessed back onto upstream. Its exact state remains available at `backup/dirty-tree-2026-07-10` / `0487d090` for Felipe to review independently.

## What was implemented

### Secretary reasoning

- Corrected the operational-context parse blocker and made snapshot TTL cover candidate generation plus one repair attempt.
- Added evidence-bound, source-health-aware Secretary snapshots, strict candidate validation, capability gating, deterministic behavior selection, and control-character stripping.
- Fixed low-confidence/high-impact selection, commitment conflict escalation, prompt-injection hard blocks, stable candidate IDs, and honest degraded behavior.
- Kept model output non-authoritative: permissions, policy, conflicts, lifecycle, and execution remain deterministic.
- Reconciled the runtime prompt, Secretary skill prompt, manifest, and actual read-only model tool surface.

### Decision Center and execution safety

- Corrected summary `openCount`, scoped list reads, lifecycle transitions, review-only Secretary previews, terminal-state replay denial, context-version rejection, and authoritative-state-change error shapes.
- Added/finished record-version CAS, stable transport attempt identity, logical-action exclusivity, source/context pre-execution revalidation, successful replay ordering, uncertain-outcome reconciliation, rollback verification, and partial-effect recovery.
- Hidden or ownership-ineligible records retain legacy executor behavior rather than surfacing Command Bus-only errors.
- Failed decisions return to `ready_for_review`; actioned partial failures expose refresh/reconciliation; unresolved partial executions retain exclusivity and block new claims.
- Decision Center table self-healing is memoized per database and no longer performs its backfill scan on every call.
- Strong-confirmation legacy bypass remains possible only while the enforcement flag is off and is now explicitly lifecycle-audited as `strong_confirmation_legacy_bypass`.

### Conflict policy, ranking, and scheduling

- Fixed complete interval-overlap detection, per-user cron fault isolation, Secretary ownership aggregation, deduplication, and scoped opaque calendar references using a dedicated HMAC secret.
- Made normalized hashes locale-independent and fail closed instead of truncating protected collections.
- Corrected deterministic precedence, no-winner handling, data-integrity auto-resolution exclusion, semantic exclusivity across disjoint windows, and fresh-over-persisted comparison identity.
- Known producers fail closed when an authoritative source-state contract cannot be derived.
- Auto-resolution requires explicit runtime opt-in, scoped user consent, active conflict-policy mode, current state, low risk, reversibility, and a derived undo contract.

### iOS Decision Center

- Added the versioned Decision Center DTO/API surface, single-observer ViewModel, stable retry keys, 409 refresh, review/edit/defer/recovery states, parsed-date history ordering, queue expiry/scope/channel handling, and notification cleanup on scope changes.
- Added allowlist validation before REST path interpolation and refused queued notification mutations while signed out.
- Reverted the low-risk auto-reflow toggle to the server-confirmed value on save failure.
- Preserved inline failure and retry state after authoritative refresh.
- Fixed handled-section accessibility identifier propagation so handled cards retain their own identifiers.
- Updated the UI stub to serve the canonical `/api/v1/decisions/overview` contract and made the iOS 27 alert assertion tolerate XCTest's duplicate proxy node without weakening the action-contract assertions.
- Reconciled upstream's new `NexusError.aiRequest` case as a definite non-mutation error, so it does not retain a Decision Center attempt key.

## Files changed

The authoritative changed-file lists are:

```bash
git show --stat 1a4438d2
git show --stat e46a447e
git -C "/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub" show --stat a46fb60
git -C "/Users/felipedominguez/Developer/Nexus Hub IOS/Nexus Hub" show --stat 422517d
```

Primary new backend modules:

- `src/services/chat-core-v2/secretary-{candidate-schema,context-snapshot,decision-preview,operational-context,reasoning-coordinator}.ts`
- `src/services/decision-{action-contract,conflict-context,conflict-evaluator,domain-commitment-adapters,domain-state-revision,preexecution-revalidator}.ts`
- `src/services/decision-command-effects.ts`
- `src/services/calendar-conflict-analysis.ts`
- `src/services/secretary-agenda-state-revision.ts`
- `migrations/227_decision_flow_v1.sql`

Primary modified owners:

- Backend: `src/services/decision-center.ts`, `decision-center-logic-v2.ts`, `decision-command-adapter.ts`, `scheduler.ts`, `runtime-flags.ts`, `chat-context-engine.ts`, `chat-core-v2/command-executor.ts`, `src/domains/secretary.ts`, `src/api/routes/decisions.ts`, `.env.example`, Secretary prompts/manifest, and the corresponding API/service/migration/security suites.
- iOS: `ReportService.swift`, `DecisionCenterViewModel.swift`, `NotificationDecisionCenterView.swift`, `DeepLinkRouter.swift`, `AppDelegate.swift`, `AppState.swift`, `NotificationSettingsView.swift`, and the focused unit/UI suites and stub server.

## QA finding dispositions

### Compile blockers and focused-suite reconciliation

| Finding | Disposition | Evidence |
| --- | --- | --- |
| P0-1 Secretary operational-context parenthesis | fixed | TypeScript clean; all imported Secretary/API cascades pass full suite. |
| P0-2 iOS `snoozeDecision` missing return | fixed | Final simulator build succeeds. |
| P0-3 undefined `openCount` | fixed | Summary calculation is passed deterministically; streak/home suites pass. |
| Decision Center 50 failures | fixed | Context mismatch rejects before execution; terminal replays deny; review-only previews expose no approval; agenda schema converges; auto-resolve/actions/rollback/error/version/uncertainty paths pass. |
| Secretary coordinator/corpus failures | fixed | Candidate selection, guard codes, IDs, commitment conflict, and untrusted execution fixtures pass. |
| Routes/scheduler/Command Bus/context retention | fixed | Scoped lists, owned-overlap aggregation, legacy fallback, and critical-context budget coverage pass. |
| Full-suite security/manifest/mock extras | fixed | Prompt-injection, status read, model-tool manifest, onboarding mock, read-back, and stale agenda coverage pass. |
| Snooze NaN to NULL claim | refuted | Existing finite-positive validation prevents unsafe persistence; no code change made. |
| Expiry update missing status predicate claim | refuted | Existing selection/update contract is already scoped safely; no code change made. |

### P1/P2 findings

| Finding | Disposition | Evidence |
| --- | --- | --- |
| P1-4 undefined-ID self-exclusion | fixed | Self-exclusion now requires an actual input decision ID; fail-closed reason-code suite added. |
| P1-5 uncertain rollback/chat confirmation verification | fixed | Agenda rollback hashes and cleared pending confirmations reconcile and release exclusivity. |
| P1-6 / P2-16 Command Bus ownership/hidden-item fallback | fixed | Bus-ineligible and read-model-hidden items return to exact legacy behavior. |
| P2-8 low-confidence/high-impact escalation | fixed | `conflict_review` requires action draft and capability; otherwise deterministic defer. |
| P2-9 locale-sensitive ordering | fixed | Code-unit comparator used by hashes and tie-breaks. |
| P2-10 protected-collection truncation | fixed | Preconditions, exclusivity, and authorization overflow reject fail-closed. |
| P2-11 data-integrity auto-resolution | fixed | Data-integrity authority disqualifies automatic resolution. |
| P2-12 unrelated winner | fixed | No comparison reference produces no winner. |
| P2-13 missing producer source contract | fixed | Known producer/action fails closed under active policy. |
| P2-14 failed decision state | fixed | Failure resets decision state to `ready_for_review`. |
| P2-15 post-commit Command Bus error | fixed | Ledger records uncertain/partial and enters reconciliation, never definite failure. |
| P2-17 permission snapshot tautology | fixed | Execute-time snapshot derives from authoritative grant state; legacy permission gate remains explicit. |
| P2-18 malformed route limits | fixed | Positive integer parser returns 400 before SQL. |
| P2-19 shared cohort arming | fixed | Enforcement and auto-resolution accept explicit opt-in only. |
| P2-20 mixed-format history ordering | fixed | iOS sorts parsed dates. |
| P2-21 queued quick-action expiry | fixed | Scoped queued actions carry timestamps and clear on expiry or absent target. |
| P2-22 nonexistent ledger suite | fixed | Ledger references real capability/command coverage only. |

### P3 findings

| Finding | Disposition | Evidence |
| --- | --- | --- |
| 23 preview capability gate | fixed | Preview consults Chat Core v2 capability enablement. |
| 24 control characters | fixed | Candidate text sanitizer strips controls. |
| 25 snapshot TTL | fixed | TTL covers call plus bounded repair. |
| 26 hard-block coordinator tests | fixed | Prompt injection and tenant-boundary cases added. |
| 27 cron user isolation | fixed | Per-user failures cannot abort remaining users. |
| 28 calendar-ref hashing | fixed | Dedicated keyed HMAC matches preview contract. |
| 29 external `requiresUserAction` downgrade | refuted/intentional | Unowned external events remain informational and cannot receive mutating actions. |
| 30 semantic exclusivity/windows | fixed | Matching semantic exclusivity is evaluated even for disjoint windows. |
| 31 domain-specific copy | fixed | Conflict explanation is domain-neutral. |
| 32 fresh/persisted identity collision | fixed | Fresh comparison wins. |
| 33 fail-closed revalidator coverage | fixed | All four requested reason codes covered. |
| 34 post-undo replay | fixed | Fresh-key replay terminal-rejects instead of replaying pre-undo success. |
| 35 actioned partial recovery | fixed | Refresh/reconciliation exposed. |
| 36 retry same key | fixed | Advertised only after successful reconciliation. |
| 37 keyless unresolved partial claim | fixed | Mutating claim blocked until reconciliation. |
| 38 adapter expectation format | fixed | Tests and implementation use capability IDs. |
| 39 dismiss NULL read-back | fixed | Successful CAS with absent row is verified terminal dismissal. |
| 40 enforcement-off strong confirmation | fixed/documented | Bypass is explicit, privacy-safe lifecycle audit; enforcement stays default off. |
| 42 unused `attempt_count` | fixed | Dropped from migration/runtime contract. |
| 43 repeated table ensure scan | fixed | WeakSet memoization plus schema readiness guard. |
| 44 unused decision-state index | fixed | Dropped from migration. |
| 45 migration runner coverage | fixed | Real-runner, self-heal-then-migrate, and out-of-order cases pass. |
| 46 auto-resolve inactive policy | fixed | Requires active policy or deterministic recomputation. |
| 47 hardcoded undo | fixed | Derived from current agenda/rollback contract. |
| 48 mode aliases | fixed/documented | `off|shadow|active` modes reject boolean-like aliases; `.env.example` states this. |
| 49 tenant predicates | fixed | New-path queries bind user and tenant. |
| 50 toast dismissal race | fixed | Generation token prevents stale dismissal. |
| 51 signed-out queue/scope | fixed | Mutations do not queue signed out; nil scope cannot consume. |
| 52 REST ID interpolation | fixed | Deep-link/notification IDs are allowlist validated. |
| 53 queued APNs channel | fixed | Fallback leg preserves `channel: apns`. |
| 54 sign-out notification cleanup | fixed | Delivered and pending notifications clear on scope reset. |
| 55 Secretary read-only prompt claim | fixed | Prompt now describes serving model tools versus legacy deterministic registry accurately. |
| 56 unversioned specs directory | documented | `/Users/felipedominguez/Developer/Nexus Hub IOS/specs` is outside git; no repository was initialized and no version-control claim is made. |
| 57 failed preference save | fixed | Toggle reverts to server-confirmed value. |

No remediation finding is deferred. The only manual product-intent item is the deliberately unreapplied Garmin WIP described above; rollout/deploy actions remain authorization-gated, not implementation defects.

## Verification evidence

### Baseline supplied by hostile QA

- Backend typecheck/verify/risk gate: exit 2 on P0-1.
- Focused: 24 files, 12 failed; 415 tests, 72 failed.
- Full: 878 files, 33 failed; 12,775 tests, 97 failed.
- Migration safety: exit 1, `migration_sequence_gap:expected_226:got_227`.
- iOS build/unit: exit 65; UI scheme mismatch then compile-blocked.
- Reward: FAIL 49, hard failure `env-file-touched`.

### Final commands and results

| Command | Exit/result |
| --- | --- |
| `npm run typecheck` | 0 |
| focused Decision Flow Vitest selection (26 files) | 0; 26/26 files, 673/673 tests |
| `scripts/risk-gate.sh` | 0; 885/885 files, 13,081/13,081 tests; migration safety 218 migrations |
| `npm run docs:audit` before final handoff | 0; 1,364 markdown files, pre-existing 1,585-warning baseline |
| `npm run verify` | 0; typecheck/science-policy/full Vitest, 885/885 files and 13,081/13,081 tests |
| `node scripts/migration-safety-check.mjs --base origin/main --changed-only` | 0; sequence gap closed |
| `content-engine/.venv/bin/python -m pytest content-engine/tests` through pre-commit/risk gate | 0; 194/194 tests |
| `xcodebuild -project 'Nexus Hub.xcodeproj' -scheme 'Nexus Hub' -sdk iphonesimulator build` | 0; `BUILD SUCCEEDED` |
| `xcodebuild -project 'Nexus Hub.xcodeproj' -scheme 'Nexus Hub' -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test -only-testing:'Nexus HubTests/NotificationDecisionCenterTests' -only-testing:'Nexus HubTests/DeepLinkRouterTests' -only-testing:'Nexus HubTests/AppDelegateNotificationScopeTests' -only-testing:'Nexus HubTests/HomeTrainingPolishTests' -only-testing:'Nexus HubTests/NavigationPerformanceSourcePinsTests'` | 0; 145/145 tests |
| `xcodebuild -project 'Nexus Hub.xcodeproj' -scheme 'Nexus Hub Debug UI Smoke' -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test -only-testing:'Nexus HubUITests/NotificationDecisionCenterUITests'` | 0; 14 executed, 1 intentionally skipped, 0 failures |

The focused set grew from the QA's 24 files to 26 because the remediation added dedicated conflict/revalidation coverage. Full-suite delta: 33 failed files / 97 failed tests to 885/885 files and 13,081/13,081 passing tests.

### Environment note

The ignored `content-engine/.venv` used Python 3.14 and could not install the pinned Pydantic 2.10.4 stack. It was preserved as ignored `content-engine/.venv-py314-20260710`, and an ignored Python 3.12 environment was rebuilt from pinned requirements. No tracked dependency file changed for this repair.

## Feature flags and expected behavior

- `SECRETARY_REASONING_V1_MODE=off|shadow|active`; default `off`, aliases rejected.
- `DECISION_CONFLICT_POLICY_V1_ENABLED=off|shadow|active`; default `off`, aliases rejected.
- `DECISION_FLOW_V1_ENFORCE_ENABLED=false`; explicit opt-in only.
- `DECISION_LOW_RISK_AUTO_RESOLUTION_ENABLED=false`; explicit opt-in plus persisted user consent and active policy.
- No flag was enabled in this session.
- Decision Center reads remain token-zero REST operations.
- High-impact, irreversible, financial, security-sensitive, external-send, stale, unauthorized, or low-confidence actions cannot silently auto-resolve.
- Raw chain-of-thought, private event/mail/task text, and sensitive values are not persisted in conflict/lifecycle audit records.

## Known risks and assumptions

### Claim and limits

- **Maximum claim: L2.** The implementation is committed locally and supported by static checks, migration tests, full backend tests, iOS simulator build/unit/UI tests, and the evidence above.
- This is not an L3+ claim because no independent post-fix reviewer has validated the final commits yet.
- This is not a release/runtime claim: staging smoke, production health, live provider writes, physical-device proof, push, and deployment were outside the authorization for this session.

- The new flow is locally verified but has no staging or production runtime evidence; all new flags remain off.
- Old iOS clients may omit expected versions until enforcement is explicitly enabled for a supported cohort.
- Strong-confirmation bypass auditing protects observability while enforcement is off; production activation must not occur before upgraded-client adoption and product approval.
- The specs directory is unversioned and therefore cannot serve as committed evidence.
- The MS To Do production regression remains live until Felipe authorizes restoration.
- Remaining Garmin WIP intent is preserved but intentionally not merged into production-truth code.

## Verifiable Reward Summary

- **Verdict:** MANUAL_REQUIRED
- **Score:** 88
- **Area:** release (auto-classified from the migration/config/release-ledger surface)
- **Hard failures:** none
- **Mandatory checks:** PASS 4; release-verification evidence skipped with manual review required.
- **Skipped checks and reason:** staging smoke and production health are absent because push/deploy/runtime actions were not authorized. The maximum claim remains L2; TestFlight, physical-device, APNs, and live provider writes were also not performed or claimed.
- **Evidence artifacts:** raw reward JSON remains under ignored `.local/reward-runs/`.
- **Export eligibility:** manual human review required.
- **Prompt/process improvement:** preservation commits before remediation prevented another dirty-hotfix loss; future hotfix procedure should require a same-day branch commit.

## Felipe decisions / next actions

1. Choose how to restore the currently missing MS To Do hotfix: expedited staging-to-production promote of this green branch, or a repeat scoped production hotfix.
2. Independently review the preserved Garmin WIP at `backup/dirty-tree-2026-07-10` before deciding whether any non-metering delta should be revived.
3. Run hostile independent QA against backend `1a4438d2` + merge `e46a447e` and iOS `a46fb60` + `422517d`.
4. Only after QA approval, decide whether to push branches and begin an off-to-shadow rollout. No active/enforcement/auto-resolution flag should be enabled directly.
