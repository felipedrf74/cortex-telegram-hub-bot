# Skill Release History Model

Date: 2026-04-29

## Goal

Skill release history should let operators, support, iOS, portal, and future agents answer:

- What skill version is active?
- What changed in this release?
- What capabilities were added?
- What bugs or security issues were fixed?
- What tests passed?
- What risks remain?
- Is this tenant/user on a scoped rollout?
- What rollback target should be used?
- Is a version draft, candidate, active, deprecated, or rolled back?

## Data Model

Primary table:

- `skill_versions`

Rollout table:

- `skill_version_rollouts`

`skill_versions` stores the release artifact. `skill_version_rollouts` stores where that artifact is active.

## Release Lifecycle

Draft:

- Work is being described or prepared.
- Not ready for release candidate decisions.

Candidate:

- Implementation and tests exist.
- Release gate may still have open conditions.

Active:

- Release metadata is active for global, tenant, user, or canary scope.
- Active does not mean "deployed by itself"; it means the registry says this is the expected live/candidate truth for that scope.

Deprecated:

- Superseded by a newer active version.
- Kept for support, audit, and rollback reference.

Rolled Back:

- Version was withdrawn.
- Release history remains available, including rollback notes and open risks.

## Rollback Semantics

Rollback data is descriptive, not destructive:

- `rollback_notes` explains how to back out the release.
- `skill_version_rollouts.rollback_target_version_id` can point to the intended target.
- Setting status to `rolled_back` does not delete release history.

Actual code/database rollback still uses normal release procedures: DB snapshot, migration rollback or restore plan, branch/tag checkout, staging smoke, production health checks.

## Release Evidence

The release record supports:

- tests added
- smoke tests passed
- evaluation results
- quality gate status
- open risks
- known limitations

Release reports for Chat, Secretary, Training, Finance, Cooking, and Content should link to the corresponding skill version record or include the version id in release notes.

## Portal/Admin Visibility

Safe portal/admin display should show:

- skill name
- current version
- status
- rollout scope
- release title/summary
- recent fixes
- known limitations
- open risks
- quality gate status
- rollback notes

Portal/admin display should not show:

- `internal_notes` by default
- raw prompt text
- provider secrets
- tenant-private content
- private user schedule, finance, training, or chat details

Mutating release metadata should remain owner/platform-admin only and audited before exposing it broadly.

## Integration With Future Release Docs

Future release docs should reference skill versions in:

- Chat final production go/no-go
- Secretary final production go/no-go
- Training release gate
- Content Creation release gate
- Finance/Cooking release gates
- Nexus Hub production burndown and deployment checklist

Recommended release-report line:

`Skill version registry: content@2.1.0 candidate, quality_gate_status=local-tests-pass, rollout_scope=global.`

