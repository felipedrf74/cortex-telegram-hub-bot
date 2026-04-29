# Weak-Profile Follow-Up Prompts

Date: 2026-04-28  
Branch: `feature/training-weak-profile-followup-prompts`  
Rollback branch: `backup/training-weak-profile-followup-prompts-pre-20260428-0747`  
Rollback tag: `backup-training-weak-profile-followup-prompts-pre-20260428-0747`

## Executive Summary

The Training engine already had a normalized profile layer, but weak-profile follow-ups were too easy to lose in the final plan narrative. This pass promotes profile confidence into a first-class planning signal and returns UI-ready follow-up prompts with planning-risk metadata.

The coach still produces a plan. It does not block the user with a long questionnaire. When data is weak, the plan becomes conservative and the engine surfaces targeted questions that would materially improve the next plan.

## Problem Fixed

Before this pass:

- profile completeness existed, but the final weekly notes only surfaced up to two high-priority questions
- profile confidence did not expose a confidence band or plan-quality-limited flag
- weak profiles could still receive broad default duration windows
- app-facing `CoordinatedTrainingPlan` did not include structured profile quality
- unresolved prompts could not be suppressed after being recently asked

## What Changed

### Profile Quality

`TrainingProfileQuality` now includes:

- `confidenceBand`
- `planQualityLimited`
- `planningRiskFlags`
- `missingCriticalData`
- `followUpQuestions`

### Follow-Up Prompts

Follow-up prompts now include:

- `planningRisk`
- `resolvesMissingKeys`

This lets iOS or a portal show a concise explanation like "this matters because equipment affects exercise selection" instead of a generic questionnaire prompt.

### Planning Behavior

When profile quality is limited, missing duration no longer implies broad windows. The planner uses conservative fallback windows:

- cardio/endurance: 45 minutes
- strength: 35 minutes

This avoids silently planning long or dense sessions when the user never confirmed available time.

### App-Facing Payload

`CoordinatedTrainingPlan` now exposes:

- `profileQuality.completenessScore`
- `profileQuality.confidenceScore`
- `profileQuality.confidenceBand`
- `profileQuality.planQualityLimited`
- `profileQuality.planningRiskFlags`
- `profileQuality.missingCriticalData`
- `profileQuality.followUpPrompts`

This is additive and backward-compatible for existing clients.

## Prompt Examples

| Missing Data | Prompt | Planning Risk |
| --- | --- | --- |
| Equipment | What equipment can you reliably use for strength sessions? | Exercise selection and substitutions can be wrong when equipment access is unknown. |
| Duration | How long can your normal training sessions realistically be? | Session density and weekly volume can be unrealistic when duration is unknown. |
| Limitations | Any current pain, injury, or movement limitation the coach must respect? | Movement selection can be unsafe when limitations are not explicitly answered. |
| Hybrid priority | For this block, which modality should win when the week gets crowded? | Hybrid plans can over-compete when modality priority is unclear. |
| Experience | How long have you trained consistently in this main modality? | Progression and exercise complexity stay conservative until experience is clear. |

## Files Changed

- `src/services/coach-kernel/types.ts`
- `src/services/training-profile-model.ts`
- `src/services/training-plan-coordination.ts`
- `src/services/training-coach-kernel-plan-generator.ts`
- `__tests__/services/training-profile-model.test.ts`

## Validation

```bash
npx vitest run '__tests__/services/training-profile-model.test.ts'
npx vitest run '__tests__/services/training-profile-model.test.ts' '__tests__/services/training-coach-kernel-plan-generator.test.ts' '__tests__/services/coach-kernel-planner.test.ts' '__tests__/services/coach-kernel-decision-trail.test.ts'
npm run typecheck
```

Results:

- 10 profile tests passed
- 33 focused profile/planner tests passed
- TypeScript passed
