# Content Creation Privacy Review

Updated: 2026-04-29

## Sensitive Data

Content Creation can handle:

- Tenant content strategy and brand positioning.
- Private drafts, scripts, outlines, hooks, captions, and notes.
- Books, links, channels, source summaries, and extracted snippets.
- Voice/brand memory and rejected patterns.
- Performance-informed creative memory.
- Cross-skill signals from Training, Finance, Cooking, Secretary, and Chat.

## Privacy Controls Verified

- Backend scope filters are applied before reference and creative memory context are built.
- User-private creative memory is omitted from tenant-shared output by default.
- Unauthorized references are excluded before model prompt construction.
- Model-routing metadata remains provider-agnostic and contains tenant/user/category/domain metadata without raw prompt text.
- Human approval gates exist for publishing, tenant-shared scheduling, draft deletion, brand voice changes, and sensitive cross-skill signals.

## Logging And Observability

The focused red-team test verifies that `modelRoutingMetadata` does not include:

- Raw prompt blocks.
- Private strategy text.
- Provider-token-like strings.
- Raw reference titles.

This does not prove every process-level logger is redacted. Wider logging review remains a separate release-gate condition.

## Model Context Minimization

Content prompts should include only:

- Active tenant/user scope.
- Relevant platform/format contract.
- Applicable voice/brand memory.
- Selected authorized references.
- Source confidence and review warnings.
- Workflow state and next step.

Content prompts should not include:

- References from another tenant/user.
- User-private memory in tenant-shared output unless explicitly permitted.
- Raw provider tokens or secrets.
- Unrelated skill context.
- Sensitive cross-skill signals without review.

## Open Items

- Add file-upload extraction red-team once attachments are wired into Content references.
- Add broader log-sink redaction assertions for Content route handlers and background workers.
- Add end-to-end iOS/portal tenant-switch smoke for Content references and drafts.
