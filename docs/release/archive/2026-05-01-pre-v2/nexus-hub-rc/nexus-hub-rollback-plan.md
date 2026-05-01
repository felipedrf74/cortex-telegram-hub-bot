# Nexus Hub Release Candidate Rollback Plan

Generated: 2026-04-29

## Scope

This plan covers rollback for the `release/nexus-hub-production-candidate` backend and iOS release candidate. No staging or production deployment was executed during RC validation.

## Current Branches

| Repo | Release branch | Current commit at validation |
|---|---|---:|
| Backend | `release/nexus-hub-production-candidate` | `34add9aa8b05c100b28a116fa12b920e118e4d15` |
| iOS | `release/nexus-hub-production-candidate` | `dd7e3e0163e5e3ee37360d3f0ffbaca54fdfb7a2` |

Both worktrees contain uncommitted release work from earlier batches. Do not use destructive git commands unless the work is intentionally backed up.

## Pre-Deployment Rollback

If this release candidate is rejected before staging or production deploy:

1. Preserve diffs:

```bash
git status --short
git diff > /tmp/nexus-backend-rc.diff
```

and, in the iOS repo:

```bash
git status --short
git diff > /tmp/nexus-ios-rc.diff
```

2. Switch back to the prior work branches only after preserving the work:

```bash
git switch feature/secretary-scheduling-arbitrator-batch4
```

Backend prior branch observed before RC creation: `feature/secretary-scheduling-arbitrator-batch4`.

```bash
git switch feature/chat-p0-tenant-safe-ios-cache
```

iOS prior branch observed before RC creation: `feature/chat-p0-tenant-safe-ios-cache`.

3. Do not delete the RC branches until the diff is either committed, intentionally abandoned, or moved to another branch.

## Required Pre-Production Snapshot

Immediately before any production deployment:

1. Take a fresh production DB snapshot.
2. Record snapshot path, size, checksum if available, and timestamp.
3. Verify the snapshot can be read.
4. Do not promote if the snapshot fails verification.

This is a hard production gate.

## Backend Runtime Rollback

If backend production promotion happens later and must be rolled back:

1. Identify the previous production commit and currently running process:

```bash
git rev-parse HEAD
pm2 status
```

2. Stop or reload using the standard deployment tooling for the service.
3. Restore the previous backend commit/build.
4. Restart the service.
5. Run production health checks:

```bash
curl -fsS https://nexushub.me/api/v1/health
```

and run the established authenticated smoke checks for dashboard, Chat history, plan today/week, tasks, skills, and provider-safe calendar status.

6. Only restore the production DB snapshot if a migration or data-write defect is confirmed. Prefer code rollback first for purely behavioral defects.

## Database Rollback Notes

- Do not run broad calendar/event cleanup during rollback.
- Do not delete calendar events by date range or title.
- Use provider event IDs, agenda ownership rows, source intent IDs, and lifecycle state whenever cleanup is required.
- If ambiguous chat rows or tenant-scoped rows are involved, quarantine rather than broad-expose.

## iOS Rollback

If an iOS release is shipped later and must be rolled back:

1. Stop further rollout in App Store Connect / TestFlight.
2. Promote the last known-good build if available.
3. Confirm the app does not retain stale local backend overrides:

```bash
xcrun simctl spawn booted defaults delete me.nexushub.app nexus_base_url || true
xcrun simctl spawn booted defaults delete me.nexushub.app nexus_allow_local_backend || true
```

4. Validate Home, Chat, Tasks, Skills, and Training against production after rollback.

## Feature / Config Rollback Levers

Preserve live model-routing behavior. Do not hardcode a provider as a rollback shortcut.

Operational levers to inspect during rollback:

- Chat feature flags and local fixture flags.
- Anthropic emergency gate, if present (`ANTHROPIC_ENABLED`).
- Provider/domain/tier/operator overrides.
- Calendar provider sync flags and staging/prod credentials.
- Secretary local/mock agenda flags must not be enabled in production.

## Post-Rollback Verification

Minimum verification after any rollback:

- Backend health passes.
- Auth/session works.
- Dashboard/Home loads.
- Chat history is tenant/user scoped.
- A Chat message can be sent or fails safely with a clear error.
- Calendar status does not show stale synced events as active.
- Tasks list loads.
- iOS app can reach the intended production backend.
- Logs show no raw prompts, provider tokens, or cross-tenant access attempts.

## Rollback Verdict

Rollback readiness is **adequate for RC staging**, but production rollback requires the fresh DB snapshot and exact deployed commit metadata at deployment time.
