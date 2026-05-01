# Nexus Hub Release Process Audit

Date: 2026-05-01

## Executive Summary

Nexus Hub releases are slowing down because the release process is evidence-rich but not risk-based. The system repeatedly reruns broad checks after small changes, rereads large historical report sets, manually copies SHAs/test counts across multiple docs, and treats merge readiness and production readiness as one long gate.

The safety gates themselves are mostly appropriate. The problem is placement, duplication, and lack of automation. The new process should keep tenant/security/calendar/model-routing/iOS-interaction gates, but run them only when the changed area creates that risk.

Recommended final direction: `ADOPT_RISK_BASED_RELEASE_PROCESS`.

## Current Release Process Map

Current process is documented in `docs/release/release-process-current-state.md`.

High-signal observations:

- Backend release-relevant docs now number around 400 Markdown reports across release, QA, local, training, cooking, content, chat, calendar, AI, context, memory, and skills.
- iOS has around 80 Markdown reports/checklists.
- Backend CI runs full tests/coverage for PRs to main/develop, but does not classify changed risk.
- iOS CI currently validates release hardening config, not the full app or changed UI paths.
- Staging deploy/smoke scripts exist and are valuable.
- The broadest current release prompts manually recreate the whole process, which makes every release feel like a full program audit.

## Bottlenecks

| Bottleneck | Cause | Recommended fix |
| --- | --- | --- |
| Full verification repeated after tiny docs fixes | No docs-only risk class | Docs-only gate skips product test suites. |
| Doc drift | Manual SHA/test-count copying | Use generated release identity and active release index. |
| Repeated iOS simulator work | No changed-area iOS selection and prior clone issues | UDID-only wrapper plus focused test selection. |
| Provider smoke late and broad | Calendar/provider condition not formalized | Run only when provider/calendar candidate changed, and run earlier. |
| Historical report rereads | Old docs remain active evidence | Current-release index separates active vs historical. |
| Serial CI | Typecheck/test/build ordering is conservative | Parallelize independent jobs. |

## Redundant/Stale Checks

See `docs/release/redundant-and-stale-checks.md` and `docs/release/checks-to-retire-or-condition.md`.

Key changes:

- Condition full backend verify after docs-only commits.
- Condition full iOS tests for backend-only changes.
- Condition provider calendar smoke on changed calendar/provider candidate.
- Retire name-only simulator destinations for UI evidence.
- Retire historical QA docs from active blocker status unless linked by current-release index.

## Checks That Must Stay

Do not remove these; make them risk-based and better automated:

- tenant isolation;
- security and prompt-injection;
- calendar/agenda lifecycle and no-duplicate behavior;
- iOS interaction validation when frontend changed;
- provider/model-routing fallback safety;
- staging smoke for changed app-facing behavior;
- DB snapshot decision for migrations/data changes;
- explicit owner approval before production.

## Missing High-Value Checks

See `docs/release/missing-high-value-release-checks.md`.

Highest priority:

1. changed-file risk classifier;
2. release identity artifact;
3. simulator hygiene wrapper;
4. local service cleanup checker;
5. smoke artifact writer;
6. tenant-forged request template;
7. provider-call escape checker.

## Risk-Based Release Gate Matrix

The matrix lives in `docs/release/risk-based-release-gate-matrix.md`.

Core rule: changed files decide required checks. A skipped check must be documented with a risk-matrix reason. High-risk skips require owner acceptance.

## Optimized Pipeline Recommendation

| Stage | What runs |
| --- | --- |
| Pre-commit | Focused tests for changed area, `git diff --check`, source typecheck when applicable. |
| PR | Risk-based CI matrix. |
| Nightly | Full backend verify, full iOS suite, eval harnesses, static sweeps. |
| RC | Full verify once, full iOS once if iOS included, release identity lock. |
| Staging | Exact artifact deploy, generic health, focused domain smoke. |
| Production | Snapshot decision, owner approval, promote, health. |
| Postdeploy | Safe test tenant smoke and monitoring. |

## Parallelization Plan

Safe:

- backend typecheck, focused tests, migration check, Python compile, static docs;
- iOS and backend tests in separate repos;
- pure unit-test shards with isolated DBs.

Unsafe:

- multiple iOS UI destinations on one simulator host;
- provider calendar smokes using one account;
- staging deploy/promote;
- smoke scripts sharing DB paths or PM2 services.

## Documentation Drift Prevention

Implemented small quick win:

```bash
scripts/release-identity.sh markdown
scripts/release-identity.sh json
```

Next:

- generate `docs/release/current-release-index.md`;
- add stale-doc checker for active release docs;
- write smoke results as JSON artifacts;
- stop copying verdicts into multiple files.

## Proposed Release Process V2

See `docs/release/streamlined-release-process-v2.md`.

The new process:

1. classify change risk;
2. run focused local validation;
3. run risk-based CI;
4. lock RC identity;
5. deploy exact RC to staging;
6. run focused staging smoke;
7. complete production preflight;
8. get owner approval;
9. deploy;
10. run postdeploy health and monitoring.

## Implementation Roadmap

See `docs/release/release-process-priority-roadmap.md`.

One-day changes should be done first: identity generation, current-release index, docs-only skip rule, UDID simulator standard, skipped-check reason field.

## Final Recommendation

`ADOPT_RISK_BASED_RELEASE_PROCESS`

Rationale: the current process is safe but too repetitive. A major pipeline rewrite is not required before the next release, but the release system needs a risk classifier, generated identity, structured smoke artifacts, and clearer gate separation to prevent every small release from becoming a full cross-product audit.
