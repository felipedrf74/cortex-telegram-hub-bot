# Training Coach deep audit

Date: 2026-05-02

Scope: backend Training engine, app-facing Training routes, deterministic fallback, profile/questionnaire normalization, calendar/Secretary handoff, iOS Training contract, runtime smoke, tenant/context safety, and focused release tests.

## Current state

- Backend audit worktree: `/tmp/nexus-training-hardening-backend`
- Branch: `feature/training-coach-deep-audit-and-hardening`
- Base commit: `627d4fe`
- Backup tag/branch in source repo: `backup/training-coach-before-deep-audit-20260502-1808`
- iOS audit worktree: `/tmp/nexus-training-hardening-ios`
- iOS base commit: `18678a3`

## Highest priority findings

1. P1: five-day strength support was incomplete after the previous fix. Route normalization, volume enforcement, marathon strength engine behavior, and fallback templates still constrained or degraded explicit five-session strength requests.
2. P1: marathon objective without a race date did not reliably surface race date as critical missing context, even though progression, long-run build, and taper require it.
3. P2: physical-device Training interaction and real provider calendar lifecycle validation remain unverified in this pass.
4. P2: broader tenant-aware mesh reader redesign remains a follow-up; no direct Training P0 leak was reproduced, and local chat tenant smoke passed.

## Evidence

- Route-level Training generation now preserves explicit `sessionsPerWeek: 6` and `strengthSessionsPerWeek: 5` through app-facing plan generation.
- Coach kernel now builds five distinct strength sessions for an advanced marathon athlete outside peak/taper/race-close windows.
- Volume enforcement now treats running sessions plus explicit strength sessions as the total active weekly target instead of trimming the combined plan to the run count.
- Deterministic fallback now supports explicit five- and six-day strength without changing the legacy four-day default.
- Local full Nexus API smoke passed 13/13 in fixture mode.
- Local chat tenant smoke passed 15 checks with 1 partial provider fallback check and 0 failures.
- iOS focused Training contract tests passed 40/40 on one explicitly selected iPhone 17 Pro simulator.

## Open validation

- Physical iPhone was not available to Xcode in this worktree, so real-device Training interaction/performance remains unverified.
- Non-production Google/Outlook provider lifecycle smoke was not run; only local calendar/agenda tests and smoke were exercised.
