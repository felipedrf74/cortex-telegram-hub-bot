# Human Approval Rules

Updated: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Policy

Content Creation must not automatically publish, externally send, or schedule risky tenant-shared content without explicit approval. The backend now evaluates approval requirements before sensitive workflow transitions.

## Approval Required

| Reason Code | Trigger | Protection |
| --- | --- | --- |
| `publish_requires_human_approval` | `mark_published`, direct publish, or external send/publish | Prevents accidental external publication. |
| `tenant_shared_scheduling_requires_approval` | Scheduling `tenant_shared` content | Prevents tenant-visible work from being placed without permission. |
| `draft_removal_requires_confirmation` | `delete_draft` or archiving draft/review/revision states | Prevents silent draft loss. |
| `low_confidence_source_requires_review` | Source review flag or weak quality/confidence | Prevents weak references from silently shaping output. |
| `unsupported_claim_requires_review` | Claims lack matching source support | Prevents unsupported claims from being treated as grounded. |
| `brand_voice_change_requires_approval` | Brand/voice profile mutation | Protects brand consistency. |
| `sensitive_cross_skill_signal_requires_review` | Sensitive signals from other skills influence content | Protects privacy and context boundaries. |

## Approval Records

Approval rows include:

- `approval_type`
- `approval_state`
- `required_reason_codes_json`
- `requested_by`
- `approved_by`
- `approved_at`
- Optional rejection metadata

Approval is action-specific. Approving a draft does not automatically approve publishing or tenant-shared scheduling.

## Data Safety Notes

- Draft deletion is implemented as an approval-gated archive transition, not a hard delete.
- Publishing remains a state marker only in this pass; no external publishing integration is added.
- Tenant/user scope is enforced before workflow mutation or schedule-request construction.
- Low-confidence and unsupported provenance are treated as review blockers, not prompt hints.
