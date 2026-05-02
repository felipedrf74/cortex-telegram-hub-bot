# Backend Current Release State

Last updated: 2026-05-02

## Active Release Candidate

- Source branch: `feature/p0-readiness-integration-task-isolation`
- Local fix commit: `6549934 fix(p0): scope Garmin readiness and task list cache`
- Base deploy branch before fix: `main` / `4.14.118`

## Scope

P0 user-data isolation and read-back fix:

- readiness/body battery reads must be scoped to the requested user
- Garmin connection state must require user-scoped usable session material
- passive Garmin reads must not import legacy owner tokens into other users
- task list detail must not trust stale empty cache when list metadata says
  tasks exist

## Validation Before Promotion

- `npx tsc --noEmit`: passed
- Focused P0 suite: 7 files / 117 tests passed
- Full backend vitest: 432 files / 6546 tests passed
- Pre-commit full backend vitest: 432 files / 6546 tests passed

## Required Post-Promotion Checks

Production-safe validation with Felipe, Jaqueline, and nexushubbot:

- readiness/body battery values do not cross users
- Garmin shows connected only for users with real scoped Garmin session material
- Jaqueline's `Entrada` list opens with the same task truth as its list count

