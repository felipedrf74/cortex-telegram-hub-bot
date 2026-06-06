# Editorial Workflow

Updated: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Workflow Principle

Content Creation owns creative artifacts, references, drafts, scripts, and brand/voice quality. Secretary owns calendar placement. Chat can coordinate the request, but it should not bypass Content ownership or Secretary scheduling arbitration.

## Supported Actions

| Action | From | To | Notes |
| --- | --- | --- | --- |
| `convert_radar_to_idea` | radar `shortlisted` | content `idea` | Creates a tenant-scoped editorial object with radar lineage. |
| `convert_idea_to_outline` | `idea` | `outlined` | Creates explicit structure before drafting. |
| `convert_outline_to_script` | `outlined` | `drafted` | Moves into draft/script production. |
| `refine_script` | `drafted`/`reviewed`/`scheduled` | `revised` | Keeps draft lineage instead of overwriting silently. |
| `approve_draft` | `drafted`/`reviewed`/`revised` | `approved` | Records approval metadata when applicable. |
| `schedule_content` | `approved`/`selected`/`repurposed` | `scheduled` | Produces a Secretary scheduling intent; tenant-shared scheduling requires approval. |
| `mark_published` | `approved`/`scheduled`/`repurposed` | `published` | Requires human approval. |
| `archive` | active states | `archived` | Draft/archive from draft states requires confirmation. |
| `reject` | planning/draft states | `rejected` | Explicitly closes the idea/draft. |
| `repurpose_content` | `approved`/`published` | `repurposed` | Preserves reuse lineage. |
| `delete_draft` | `drafted`/`reviewed`/`revised` | `archived` | Requires confirmation; rows are not silently deleted. |
| `mark_stale` | active states | `stale` | Prevents stale facts/sources from being reused as current. |

## Inspectability

Every transition writes a `content_workflow_events` row containing:

- Tenant and owner user
- Object type and object ID
- Action
- From/to state
- Approval state
- Review flag
- Reason codes
- Actor
- Secretary intent ID when applicable
- Metadata

Approval gates write `content_approval_records` keyed by tenant, owner, object, and approval type.

## Secretary Integration

`buildContentSecretarySchedulingIntent()` creates a typed intent with:

- `sourceSkill: "content"`
- `sourceAction: "schedule_content_block"`
- `sourceEntityType: "content_domain_object"`
- Tenant and owner user scope
- Duration, preferred windows, deadline, priority, and reason

Secretary decides placement. Content does not directly own calendar slots.

## Backward Compatibility

This pass does not remove existing topic/script/pipeline states. It layers canonical workflow metadata on top so existing consumers can keep functioning while richer clients move to the new fields.
