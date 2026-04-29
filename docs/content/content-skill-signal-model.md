# Content Skill Signal Model

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Inbound Signal Contract

Content Creation consumes cross-skill signals through `consumeContentCrossSkillSignal()`.

Required fields:

- `userId`
- `tenantId`
- `sourceSkill`
- `signalType`
- `topic`

Recommended fields:

- `sourceTenantId`
- `sourceEntityId`
- `summary`
- `confidence`
- `freshness`
- `permission`
- `sensitivity`
- `evidence`
- `platform`
- `format`
- `productionFeasibility`

## Source Skills

Supported source skills:

- `training`
- `cooking`
- `finance`
- `secretary`
- `chat`

`triathlon` is normalized to `training` where relevant.

## Signal Results

The result includes:

- `status`: `consumed`, `requires_review`, or `rejected`
- `policy`: the sensitive-signal policy applied
- `radarSignal`: the Content Radar signal when accepted
- `convertedObjectId`: the Content workflow object when converted to an idea
- `reasonCodes`
- `downstreamImplications`

## Deduplication

Each signal uses a stable source reference:

```text
{sourceSkill}:{signalType}:{sourceEntityId or normalized topic}
```

The Content Radar upsert key prevents repeated cross-skill warnings from creating duplicate rows for the same tenant/user/source signal.

## Outbound Signal Contract

Content emits to Secretary through `buildContentSecretarySignals()`.

Supported signal types:

- `writing_block`
- `editing_block`
- `publishing_deadline`
- `review_task`
- `radar_review_block`

Each outbound Secretary signal includes:

- tenant/user scope
- signal type
- summary
- payload
- `SecretarySchedulingIntent`

Content emits to Chat through `buildContentChatStatusSignal()`.

Supported signal types:

- `content_ideas_available`
- `content_plan_status`
- `source_limitations`
- `pending_approvals`

## Ownership Rules

- Content owns ideas, references, voice, radar, editorial state, and publishing workflow.
- Secretary owns schedule placement and agenda feasibility.
- Chat coordinates user interaction and explains status.
- Training, Cooking, and Finance own their domain truth; Content receives summaries/signals, not raw authority over those skills.

## Open Items

- Add durable event hooks in each source skill.
- Add route-level APIs for reviewing, approving, or dismissing sensitive cross-skill signals.
- Add observability for accepted/rejected signal counts.
