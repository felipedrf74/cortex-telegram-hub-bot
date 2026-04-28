# Training Engine Release Candidate Config Checklist

Date: 2026-04-28

## Release Status

Candidate branch: `release/training-engine-production-candidate`

Current status: not production-ready. This checklist must be completed before deployment.

## Migration Checklist

| Item | Required state | Status |
| --- | --- | --- |
| Migration 082 reviewed | `migrations/082_training_session_identity_shape_hash.sql` reviewed for additive-only behavior | Pending |
| Staging DB snapshot | Snapshot exists before applying migration 082 | Pending |
| Staging clone rehearsal | Migration applied to staging clone and route/tests run against it | Pending |
| Rollback rehearsal | DB snapshot restore or additive-column rollback behavior verified | Pending |
| Old-code compatibility | Commit `a3f1b78` verified to ignore added columns/indexes | Pending |
| Index impact | Index creation timing and DB size impact understood | Pending |

## Required Runtime Environment

Verify these exist in staging and production before release:

| Variable/config | Purpose | Status |
| --- | --- | --- |
| `DATABASE_PATH` | SQLite database path | Required |
| `OAUTH_ENCRYPTION_KEY` | OAuth token encryption/decryption | Required |
| `INTERNAL_API_SECRET` | Internal route protection | Required |
| `PORTAL_TOKEN` | Operator/status portal auth where applicable | Required |
| `AI_CALL_TIMEOUT_MS` | Model call timeout guard | Required |
| `GEMINI_API_KEY` or `OPENAI_API_KEY` | Model provider access | Required |
| Provider routing config | Must match intended model/provider behavior | Pending review |

Optional emergency controls, default enabled:

| Variable/config | Purpose | Status |
| --- | --- | --- |
| `TRAINING_ENGINE_DISABLED=1` / `TRAINING_ENGINE_ENABLED=false` | Global Training write-surface disable. | Implemented, use only for incident response. |
| `TRAINING_PLAN_GENERATION_DISABLED=1` / `TRAINING_PLAN_GENERATION_ENABLED=false` | Disable new Training plan generation. | Implemented. |
| `TRAINING_CALENDAR_WRITES_DISABLED=1` / `TRAINING_CALENDAR_WRITES_ENABLED=false` | Disable Training provider calendar writes. | Implemented. |
| `TRAINING_CALENDAR_SYNC_DISABLED=1` / `TRAINING_CALENDAR_SYNC_ENABLED=false` | Disable explicit Training calendar sync route. | Implemented. |
| `TRAINING_CROSS_SKILL_SIGNALS_DISABLED=1` / `TRAINING_CROSS_SKILL_SIGNALS_ENABLED=false` | Disable Training-originated cross-skill signal publishing. | Implemented. |

Do not claim GPT-5.5 execution in release notes unless provider/model config and logs prove it. The architecture should preserve high-intelligence reasoning, but release claims must match configured runtime.

## Calendar Staging Smoke Configuration

Required for the calendar staging gate:

| Variable | Notes | Status |
| --- | --- | --- |
| `TRAINING_CALENDAR_STAGING_ENV_FILE` | Points to staging-only env file | Pending |
| `TRAINING_CALENDAR_STAGING_SMOKE=1` | Enables smoke harness | Pending |
| `TRAINING_CALENDAR_STAGING_ALLOW_LIVE_WRITES=1` | Explicit live-write consent for staging calendars only | Pending |
| `TRAINING_CALENDAR_STAGING_USER_ID` | Test/staging user with Google/Outlook integrations | Pending |
| `TRAINING_CALENDAR_STAGING_PROVIDERS=google,outlook` | Provider list | Pending |
| `TRAINING_CALENDAR_STAGING_RESULTS_PATH` | Results output path | Optional but recommended |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google staging OAuth app | Pending |
| `OUTLOOK_CLIENT_ID` / `OUTLOOK_CLIENT_SECRET` | Outlook staging OAuth app | Pending |

Safety rules:

- Do not set `TRAINING_CALENDAR_STAGING_ALLOW_NON_STAGING_DB=1` for production or real user data.
- Test events must include staging title prefixes and ownership metadata.
- Cleanup must use provider event IDs/ownership rows, not date/title sweeps.

## Cross-Skill Staging Smoke Configuration

Required for the cross-skill staging gate:

| Variable | Notes | Status |
| --- | --- | --- |
| `TRAINING_CROSS_SKILL_STAGING_ENV_FILE` | Points to staging-only env file | Pending |
| `TRAINING_CROSS_SKILL_STAGING_SMOKE=1` | Enables harness | Pending |
| `TRAINING_CROSS_SKILL_STAGING_USER_ID` | Test/staging user | Pending |
| `TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH` | Results output path | Optional but recommended |
| Staging Secretary data | Conflicting meeting/task windows | Pending |
| Staging Cooking data | Fueling gap / meal coverage scenario | Pending |
| Staging Finance data | Equipment or budget constraint scenario | Pending |
| Staging Content data | Workload or milestone signal scenario | Pending |

Safety rules:

- Do not set `TRAINING_CROSS_SKILL_ALLOW_NON_STAGING_DB=1` for production data.
- Use test tenants/users only.
- Cleanup any test shared-context rows by tenant/user/source.

## Calendar Sync Runtime Checklist

| Item | Required state | Status |
| --- | --- | --- |
| Ownership metadata | Event writes include plan ID, plan version, session identity, shape hash where supported | Pending review |
| Provider markers | Google and Outlook events include Nexus Training identity markers | Pending staging proof |
| Read-back | Create/update/delete verified by provider read-back | Pending |
| Retry idempotency | Retry does not duplicate provider events | Pending staging proof |
| Cancellation cleanup | Cancels only candidate-owned events | Pending staging proof |
| Replacement cleanup | Superseded plan events removed precisely | Pending staging proof |
| Failure reporting | Provider failures surface clear state and logs without sensitive data | Pending |

## Tenant and Security Checklist

| Item | Required state | Status |
| --- | --- | --- |
| Plan ownership | Plan create/read/update/cancel scoped by user/tenant | Tests required before release |
| Session ownership | Feedback and session reads cannot cross user/tenant | Tests required before release |
| Calendar ownership | Provider event mappings cannot be hijacked cross-user | Tests required before release |
| Cross-skill context | Shared context is tenant/user scoped | Tests required before release |
| Sensitive logging | Discomfort, recovery, sex/gender, notes, and calendar detail are redacted or avoided | Tests/docs required |
| Staging artifacts | No staging test data or event IDs leak into production configs | Pending |

## iOS Contract Compatibility

Backend RC fields should be additive. Verify current and companion iOS builds tolerate:

- `planVersion`
- session identity key / stable session IDs
- `sessionShapeHash`
- lifecycle states such as scheduled, capped, reflowed, deferred, unscheduled, canceled, superseded
- `calendarSyncState`
- `decisionReasons`
- `profileQuality`
- follow-up prompts
- richer warnings/guidance
- richer feedback payload responses

Current iOS status from latest local smoke:

- Rich fixture rendering passed locally.
- Authenticated local end-to-end smoke is not a release blocker for backend but remains an iOS follow-up.
- iOS repository changes are not included in the backend RC branch.

## Model/Reasoning Configuration

The Training architecture is intended to preserve high-intelligence coach reasoning, but deterministic safety remains in code:

- validators
- session coherence checks
- capacity reconciliation
- calendar ownership mapping
- profile confidence/follow-up logic
- evaluation harness

Before release, confirm:

- which model/provider serves Training generation in staging and production
- timeout and retry behavior
- whether degraded/no-model fallback is acceptable for Training
- no release notes overstate GPT-5.5 runtime use without evidence

## Artifact Hygiene

Exclude from production commits unless explicitly reviewed:

- `reports/**` generated outputs
- local smoke screenshots/logs unless curated
- staging env files
- local databases
- provider tokens
- temporary scripts not guarded for staging/test mode

## Final Config Gate

This RC can move to staging only after:

1. Candidate branch has clean reviewable commits.
2. Migration 082 has a staging clone rehearsal.
3. Calendar staging credentials and test users are configured.
4. Cross-skill staging test data is configured.
5. Security/tenant tests pass.
6. iOS compatibility status is documented.
7. Operational-switch values are left unset/enabled for normal release, or explicit incident-response use is documented.
