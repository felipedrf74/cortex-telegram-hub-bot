# Release Process Current State

Date: 2026-05-01

Status: deprecated historical snapshot

This file is retained as May 1 process evidence only. It is not the current
release process. Use `docs/release/README.md`,
`docs/release/current-release-index.md`, `docs/release/CURRENT_RELEASE_STATE.md`,
and `docs/release/release-evidence-contract.md` for active release decisions.
The observed branch/version/migration counts below are intentionally stale.

## Repositories Reviewed

| Area | Path | Current observed state |
| --- | --- | --- |
| Backend | `/Users/felipedominguez/Desktop/Custom Connectors/Cortex/cortex-telegram-hub-bot` | Branch `feature/cooking-intelligence-upgrade`, package `4.14.108`, 111 migrations, release docs and deploy scripts live here. |
| iOS | `/Users/felipedominguez/Desktop/Nexus Hub IOS/Nexus Hub` | Branch `main`, latest pushed commit `4c5746a`, iOS release hardening workflow only checks config. |

Use `scripts/release-identity.sh markdown` before release docs are written so SHA/version fields are generated instead of hand-copied.

## Current Phases

| Phase | Current checks/commands | Validates | Runs where | Evidence | Blocks |
| --- | --- | --- | --- | --- | --- |
| Feature branch setup | Manual branch/tag/worktree flow in prompts | Rollback branch/tag and non-main work | Local | E1 | Feature work |
| Focused backend validation | `npx tsc --noEmit`, `npx vitest run <files>` | Changed service/API behavior | Local and sometimes CI | E2/E3 | Merge when relevant |
| Full backend verify | `npm run verify` | Typecheck plus full Vitest suite | Local, backend CI | E2/E3 | Often merge/release |
| Backend CI | `.github/workflows/ci.yml` | Typecheck, full tests with coverage, build, Python compile, migration sequence | GitHub Actions on PR/push to main/develop | E2/E3 | PR/main |
| Local full-product smoke | `scripts/full-nexus-local-engine.sh`, domain wrappers | Local backend runtime, auth/session, app-facing APIs, fixture provider safety | Local | E4 | Release confidence |
| Portal smoke | `npm run smoke:cooking:portal` and manual browser claims | Portal rendering and interaction for changed portal paths | Local browser/headless | E5 | Conditional |
| iOS focused tests | `xcodebuild test ... -only-testing:<slice>` | Changed iOS decoding/view-model/presentation slice | Local simulator | E2/E5 when UI tests interact | Merge when iOS changed |
| iOS full suite | `xcodebuild test ... Nexus HubTests` | Broad iOS regression | Local simulator | E2 | Used frequently even for focused work |
| iOS simulator smoke | Manual/XCUITest flows with explicit UDID when done correctly | Frontend interaction and rich fixture rendering | Local simulator | E5 | iOS release confidence |
| TestFlight/device smoke | Manual TestFlight matrix | Apple Sign In, APNs, HealthKit, real account switching | Physical device/TestFlight | E5/E7-adjacent | Public beta/prod iOS |
| Staging deploy | `./scripts/deploy-staging.sh` | Build, staging env keys, rsync, PM2 restart, staging health | Server staging | E6 | Promotion |
| Generic staging smoke | `./scripts/staging-smoke.sh` | Health, snapshot, cost/provider stats, iOS unauth 401 contracts | Server staging | E6 | Promotion |
| Domain staging smoke | `training-calendar-staging-smoke.sh`, `training-cross-skill-staging-smoke.sh`, Cooking/Content scripts | Provider/calendar/cross-skill behavior | Server staging | E6 | Production when domain changed |
| Production promotion | `./scripts/promote-to-prod.sh` then `deploy.sh` | Staging smoke gate, dist hash comparison, prod deploy/health | Local + server prod | E7 | Production |
| Release docs | Many docs under `docs/release`, `docs/training`, `docs/cooking`, `docs/local`, `docs/qa` | Human-readable evidence and verdicts | Local | E1 unless backed by artifacts | Decisions |

## Documentation Footprint

Observed Markdown report volume in release-relevant backend areas:

| Area | Approx files |
| --- | ---: |
| `docs/training` | 115 |
| `docs/content` | 71 |
| `docs/chat` | 71 |
| `docs/local` | 40 |
| `docs/cooking` | 24 |
| `docs/release` | 21 |
| `docs/qa` | 17 |

iOS has about 80 Markdown docs, mostly under `docs/ios` and `docs/beta`.

This volume is now a release bottleneck: every new QA/fix pass creates more decision records, and the current process asks later agents to reread large historical sets before small releases.

## Evidence Gaps In The Current Process

- Backend CI is not changed-file aware and does not run domain-specific staging smoke.
- iOS GitHub Actions only runs release hardening config; local iOS tests remain the real gate.
- Staging smoke is strong for generic health but not enough for domain behavior unless a focused domain smoke is explicitly run.
- Production promotion requires owner approval operationally, but scripts cannot encode that outside interactive confirmation.
- Release docs manually type SHAs and test counts, causing stale evidence after small follow-up commits.
