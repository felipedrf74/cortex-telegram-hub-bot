# Chat Skill Routing

Status: implemented on `feature/chat-tenant-safe-context-orchestration`

Chat is the coordination surface, not the owner of every domain decision. The backend now runs a deterministic orchestration preflight before model-backed domain execution.

## Ownership Rules

- Secretary owns agenda placement, calendar scheduling, reminders, follow-ups, rescheduling, and cross-skill time arbitration.
- Training owns training content, coaching plans, workout/session meaning, and training state.
- Cooking owns meals, recipes, grocery lists, meal prep, and fueling content.
- Finance owns budgets, purchases, bills, subscriptions, taxes, and financial analysis.
- Content Creation owns content ideas, scripts, references, publishing cadence, and content workflow decisions.
- Chat coordinates context, routes the request, explains what happened, and blocks unsafe actions.

## Router Layers

1. Existing fast paths and deterministic shortcuts still run first where safe.
2. `analyzeChatSkillOrchestration` classifies intent kinds, involved skills, action risk, stale-context risk, and ownership.
3. Existing `routeMessage` still preserves the live provider-routing/classifier architecture.
4. `applyChatSkillRoutingDecision` can override a raw route only for high-confidence ownership cases such as multi-skill scheduling.
5. Domain handlers still own the actual skill logic.

## High-Confidence Overrides

Secretary is selected when the message is a scheduling/action arbitration request, especially when multiple skills are involved:

- “Plan my week around workouts and content deadlines.”
- “Find time for meal prep before heavy training days.”
- “Move tomorrow’s workout because I have a meeting.”

Content stays selected for content guidance that mentions scheduling but is not asking Chat to mutate the calendar:

- “How should I schedule filming around my week?”

## Prompt Support

`chat_reasoning_context` now includes a `chat_skill_routing` block with:

- primary domain
- involved skills
- intent kinds
- reason codes
- ownership rules
- action safety notes
- context refresh notes

This is provider-agnostic and does not hardcode Gemini, OpenAI, Anthropic, or GPT.
