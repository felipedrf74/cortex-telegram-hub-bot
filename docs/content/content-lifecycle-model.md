# Content Lifecycle Model

Updated: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Purpose

Content Creation now has a canonical editorial workflow layer for tenant-scoped creative artifacts. The goal is to prevent disconnected generated outputs by representing each artifact as an inspectable object with lifecycle state, approval state, review reasons, source ownership, and optional Secretary scheduling intent metadata.

This is additive. Existing `content_topics`, `content_scripts`, `content_pipeline`, and radar flows remain backward compatible while richer lifecycle fields are introduced.

## Canonical Editorial States

| State | Meaning |
| --- | --- |
| `idea` | Captured creative possibility. Not yet validated for production. |
| `researched` | Idea has enough source/context review to be considered. |
| `selected` | Chosen for production or planning. |
| `outlined` | Structure exists, but not a full draft. |
| `drafted` | Draft/script/caption exists and needs review. |
| `reviewed` | Human or policy review happened, but changes may remain. |
| `revised` | Draft has been changed after review. |
| `approved` | Safe to schedule or prepare for publish, subject to action-specific approvals. |
| `scheduled` | Secretary has or should have an intent for production/calendar placement. |
| `published` | Marked externally published or completed. |
| `archived` | Preserved but inactive. |
| `repurposed` | Derived from prior content and may be scheduled/published separately. |
| `rejected` | Explicitly not pursuing. |
| `stale` | Needs refresh before further use. |

## Radar Lifecycle

Radar signals use a separate lifecycle:

- `detected`
- `scored`
- `shortlisted`
- `dismissed`
- `converted_to_idea`
- `converted_to_script`
- `scheduled`
- `expired`

Radar conversion records `converted_to_object_id`, `converted_to_object_type`, and `converted_at`, preserving lineage from opportunity signal to editorial object.

## Reference Lifecycle

References use source-health states:

- `added`
- `indexed`
- `pending_review`
- `active`
- `stale`
- `broken`
- `archived`

Broken, stale, failed, quarantined, deprecated, or low-confidence sources should not silently influence generation. Low-confidence or unsupported sourcing requires review.

## Storage

Migration `092_content_lifecycle_editorial_workflow.sql` adds:

- Editorial state and approval fields to `content_domain_objects`
- Compatibility lifecycle fields to `content_topics`, `content_scripts`, and `content_pipeline`
- Radar conversion fields to `content_topic_feedback`
- `content_workflow_events` for inspectable transitions
- `content_approval_records` for review/approval gates

## Service Contract

Primary service: `src/services/content-editorial-workflow.ts`

Key functions:

- `createContentWorkflowObject()`
- `transitionContentWorkflow()`
- `convertRadarSignalToIdea()`
- `buildContentSecretarySchedulingIntent()`
- `requestContentScheduleThroughSecretary()`
- `listContentWorkflowEvents()`
- `listContentApprovalRecords()`

## Release Gate

PASS WITH CONDITIONS for the backend lifecycle foundation.

Open conditions:

- Existing generation/refinement routes still need broader runtime wiring into this lifecycle service.
- iOS and portal approval/review UI are not implemented in this pass.
- External publishing is not implemented and remains approval-gated by design.
