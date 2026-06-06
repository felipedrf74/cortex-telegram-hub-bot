# Main, Staging, And Production Gate Model

Date: 2026-05-01

## Gate 1: Merge To Main

Purpose: prove the code is safe to merge, not safe to deploy broadly.

Required:

- clean worktree;
- current branch/commit recorded;
- focused tests for changed area;
- typecheck/build when source changed;
- no unresolved P0/P1 correctness/security/tenant/build blockers;
- rollback notes for risky changes.

Not required for merge by default:

- production DB snapshot;
- provider calendar smoke if calendar/provider code did not change;
- signed TestFlight device smoke unless the iOS release candidate is being cut.

## Gate 2: Staging Release Candidate

Purpose: prove the exact candidate deploys and behaves in the staging environment.

Required:

- exact RC identity;
- staging deploy of that exact artifact;
- staging health;
- focused staging smoke by changed area;
- tenant/security smoke when relevant;
- cleanup evidence.

## Gate 3: Production Readiness

Purpose: decide whether owner can approve production.

Required:

- staging smoke passed;
- migration/DB snapshot decision;
- provider/calendar smoke if required by changes;
- iOS TestFlight/device validation if native/auth/Health/APNs/account-switching is in scope;
- monitoring and rollback plan;
- explicit owner approval.

## Gate 4: Postdeploy Validation

Purpose: verify production-safe health after deploy.

Required:

- service health;
- safe test tenant/user smoke where possible;
- tenant-denial/security logs monitored;
- provider/calendar/model fallback errors watched;
- rollback remains ready until confidence window passes.
