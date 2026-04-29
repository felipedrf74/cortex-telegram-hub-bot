# Chat Portal Open Items

Date: 2026-04-29

## P0

None introduced by this pass.

Raw Chat content remains unavailable through portal support tooling, which is the safe default.

## P1

| Item | Why it matters | Status | Next step |
| --- | --- | --- | --- |
| No explicit raw-content support workflow | Support cannot inspect semantic answer quality from real private chats without user-provided excerpts. | Open by design. | Define `chat_content_review` permission, tenant policy, consent/support-case requirements, redaction, and audit before exposing raw content. |
| No tenant Chat policy UI | Tenants cannot configure retention, memory, sharing, or admin visibility policies. | Open. | Add policy storage and UI after tenant membership/role model is stable. |
| No portal user Chat history UI | Users cannot review/archive/delete Chat history from portal. | Open. | Build only after conversation-list and archive/delete contracts are stable and tenant-safe. |
| Attachment/file diagnostics are not represented | Chat attachments may need separate support diagnostics and retention controls. | Open. | Extend diagnostics after attachment tenant-scope model is finalized. |

## P2

| Item | Why it matters | Status | Next step |
| --- | --- | --- | --- |
| Simulation/evaluation results are not surfaced in portal | Operators cannot inspect day-to-day quality regressions from the portal. | Open. | Add aggregate eval results, failure taxonomy counts, and links to redacted transcripts. |
| Diagnostics are API-only | The portal HTML has no visual Chat diagnostics panel yet. | Open. | Add UI once the diagnostics schema has survived backend review. |
| Provider fallback details are aggregate only | Useful for privacy but less helpful when debugging a single failed turn. | Accepted for now. | Add per-message provider trace IDs only if they remain content-free and audited. |
| Admin audit is mutation-focused | Read access to diagnostics is admin-protected but not currently logged as a support-read event. | Open. | Add audited read events for future sensitive diagnostics and raw-content workflows. |

## P3

| Item | Why it matters | Status | Next step |
| --- | --- | --- | --- |
| Copy and naming polish | Operator UX can improve after the first review cycle. | Open. | Review field names with support/operator workflows. |
| Tenant-level aggregate suppression threshold | Very small tenants could be identifiable from aggregate counts. | Open. | Consider minimum-count suppression before broad multi-tenant operator access. |

## Release Interpretation

The portal is safer and more useful for Chat diagnostics after this pass, but it should not be marketed as a full Chat support console. The current implementation is deliberately conservative: metadata-only first, raw content later only with explicit permission, policy, audit, and redaction.
