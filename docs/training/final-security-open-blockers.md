# Training Final Security Open Blockers

Date: 2026-04-28

## Summary

No P0 or P1 security/tenancy blockers remain open after this pass.

A P1 privacy issue was found and fixed: logs could still expose sensitive provider SDK error shapes or raw Training/calendar free text. The fix added global logger redaction and removed raw objective/title/body logging from the reviewed Training/calendar paths.

## Open Blockers By Severity

| Severity | Status | Area | Blocker | Decision |
| --- | --- | --- | --- | --- |
| P0 | None open | Security/tenancy | No unauthenticated Training mutation, cross-user plan cancellation, cross-user session feedback, or cross-tenant calendar mapping blocker was found. | No P0 action required from this pass. |
| P1 | Fixed | Logs/privacy | Provider SDK errors and some Training/calendar logs could include auth headers, tokens, objectives, event titles, or raw create request body. | Fixed through Pino redaction and log minimization. |
| P1 | None open | Calendar ownership | No cross-user calendar ownership hijack or broad Training calendar deletion path was found in audited cancellation/sync code. | Covered by focused tests; real provider staging proof remains separate. |
| P1 | None open | iOS feedback privacy | No iOS Training feedback debug logging was found. | Covered by focused feedback payload tests. |

## Non-Blocking Release Risks

| Priority | Area | Risk | Why Not P0/P1 | Required Follow-Up |
| --- | --- | --- | --- | --- |
| P2 | Google/Outlook staging proof | Real provider lifecycle must still pass read-back and cleanup gates if not already completed. | This is a release trust gate, not a newly found auth/tenancy defect in code. | Run `scripts/training-calendar-staging-smoke.sh` with staging credentials and record results. |
| P2 | Cross-skill staging proof | Training/Secretary/Cooking/Finance/Content staging flows depend on staging prerequisites. | Local contract harness exists; no cross-tenant leak was found in code review. | Run `scripts/training-cross-skill-staging-smoke.sh` with staging tenant/user data. |
| P2 | Rich skip feedback persistence | iOS can send rich skip feedback, but backend `/training/skip` currently persists the skip state only. | Not a privacy leak or unauthorized access path; it is an adaptation-quality gap. | Add backend storage for skip reason/fatigue/soreness/discomfort where product wants those signals retained. |
| P3 | Whole-product log minimization | Non-Training areas still have logs with emails/titles/business strings. | Outside this Training security pass; token/secret redaction now applies globally. | Schedule a product-wide privacy logging pass. |
| P3 | Provider SDK future fields | New SDKs may introduce credential-bearing error shapes outside current redaction paths. | No current failing path found; tests pin current critical shapes. | Expand `LOGGER_REDACTION_PATHS` when adding provider clients. |

## Do Not Merge Conditions

Do not merge or release Training if any of these reappear:

- Training plan/session mutation accepts another user's plan or session id.
- Calendar event ownership can be marked deleted or updated without matching the authenticated user.
- Staging smoke uses production calendars or broad date-range deletion.
- Logs include OAuth access tokens, refresh tokens, auth headers, raw injury/discomfort notes, or raw calendar request bodies.
- Cross-skill context reads user-scoped signals without a valid `userId`.

## Current Status

Security release gate status: pass for code-level review and focused tests.

Production readiness still depends on the non-security trust gates listed above.
