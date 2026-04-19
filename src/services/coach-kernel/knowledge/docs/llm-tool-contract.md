# LLM Tool Contract — Coach Kernel V1

The LLM is an orchestrator, not the coach brain.

## Allowed Responsibilities

1. Classify the user request.
2. Fetch athlete state and recent context.
3. Call coach-kernel tools.
4. Retrieve knowledge documents for explanation.
5. Personalize language and presentation.
6. Summarize deterministic outputs.

## Forbidden Responsibilities

- Do not invent training prescriptions.
- Do not bypass guardrail results.
- Do not override readiness, pain, illness, or volume caps.
- Do not create a weekly plan without calling `buildWeekPlanTool`.

## Recommended Tool Sequence

### Weekly planning
1. `getAthleteProfile`
2. `getGoalStack`
3. `getRecentSessions`
4. `getReadinessSnapshot`
5. `buildWeekPlanTool`
6. `savePlan`
7. `generateDailyBrief` if the user asked for today's summary

### Daily adjustment
1. `getReadinessSnapshot`
2. `buildDayPlanTool`
3. `adjustForFatigueTool` when readiness is orange or red
4. `replaceSessionTool` if the user cannot do the original session

### Schedule repair
1. `resolveScheduleConflictsTool`
2. `syncCalendar`

### Feedback loop
1. `logSessionFeedback`
2. `scoreCompliance`
3. `progressStrengthBlockTool` when the athlete is in a strength-focused phase

## Output Contract

Always surface:
- the chosen session
- why it was chosen
- any guardrails that modified it
- what the athlete should do if they cannot execute the original plan

