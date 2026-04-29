# Chat Multi-Skill Orchestration

Status: foundation implemented

Chat now has an explicit orchestration preflight that detects cross-skill requests and routes schedule ownership to Secretary while preserving each skill’s content boundaries.

## Supported Routing Behaviors

| Request Type | Primary Owner | Involved Skills |
|---|---|---|
| Plan week around workouts/content/deadlines | Secretary | Training, Content, Finance/Cooking as detected |
| Find time for meal prep before training | Secretary | Cooking, Training |
| Content ideas based on training progress | Content | Training |
| Budget/equipment purchase plus scheduling | Secretary for schedule arbitration; Finance context required | Finance, Training |
| Training coaching/content questions without scheduling | Training | optional peer context |
| Finance analysis without scheduling | Finance | optional peer context |

## Response Composition Expectations

Domain handlers receive a scoped prompt block that tells them:

- which skills were detected
- why the route was chosen
- who owns schedule placement
- whether context should be refreshed
- whether destructive action confirmation is required

Responses should include:

- action taken or not taken
- skills involved
- unresolved items
- constraint/explanation
- targeted follow-up when context is weak

## What Chat Must Not Do

- Mutate another skill’s state directly just because a model suggested it.
- Use stale context when a skill-owned lookup/tool is required.
- Delete, send, or clear anything without explicit confirmation.
- Route multi-skill scheduling to Training/Cooking/Finance/Content just because their nouns appear.
- Assume a tenant/workspace from memory.

## Current Limitation

The production backend is still fundamentally single-domain per turn after routing. The orchestration layer improves ownership and context, but a true multi-step planner that calls multiple skill services in sequence remains a future phase.
