# Content Creation Release Candidate Rollback Plan

Date: 2026-04-29  
Candidate version: `content@2.3.0-rc.1`

## Rollback Targets

- Current active registry version remains `content@2.0.0`.
- Candidate registry record: `content@2.3.0-rc.1`.
- Backup branch/tag for this pass: `backup/content-before-production-hardening-*`.

## Before Deployment

If the candidate is rejected before deployment:

1. Mark `content@2.3.0-rc.1` as `rolled_back` or leave it as non-active candidate with release notes explaining rejection.
2. Do not activate a rollout.
3. Keep `content@2.0.0` active.
4. Do not run schema rollout in production.

## Staging Rollback

If staging smoke fails:

1. Stop staging process.
2. Restore staging DB snapshot or rerun staging from the previous release branch.
3. Revert to the previous deployed backend branch/commit.
4. Mark candidate as failed in release docs.
5. Keep external publishing disabled.

## Production Rollback

If production is later approved and then regresses:

1. Stop promotion immediately.
2. Capture incident timestamp, release commit, tenant/user impact, and failing route/job.
3. Roll back process code to previous production commit.
4. Restore the fresh predeploy production DB snapshot if migrations caused data/schema impact.
5. Mark `content@2.3.0-rc.1` as `rolled_back` in `skill_versions`.
6. Confirm `content@2.0.0` active metadata remains readable.
7. Run production health checks.
8. Keep external publishing disabled until a new candidate passes staging.

## Data Safety

- Migration `095` is metadata-only. It does not activate the candidate.
- Candidate metadata contains no raw prompts, provider secrets, tenant strategy, private drafts, or raw references.
- Earlier Content schema migrations are additive foundations; rollback should prefer DB snapshot restore over destructive manual column/table edits.

## Verification After Rollback

- `/api/v1/skills/versions/content` returns active `content@2.0.0`.
- Content home, references, scripts, and topics return previous production behavior.
- No provider-call loops remain.
- No new external publishing jobs are running.
