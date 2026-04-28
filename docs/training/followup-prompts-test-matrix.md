# Training Follow-Up Prompts Test Matrix

Date: 2026-04-28  
Branch: `feature/training-weak-profile-followup-prompts`

## Automated Coverage

| Test File | Coverage |
| --- | --- |
| `__tests__/services/training-profile-model.test.ts` | Profile extraction, confidence scoring, follow-up prompt generation, prompt dedupe, conservative planning, and material plan changes after answers are provided. |
| `__tests__/services/training-coach-kernel-plan-generator.test.ts` | Regression coverage for plan generation integration with profile-derived athlete state. |
| `__tests__/services/coach-kernel-planner.test.ts` | Planner compatibility with enriched athlete/profile state. |
| `__tests__/services/coach-kernel-decision-trail.test.ts` | Decision trail compatibility with profile and warning notes. |

## Required Regression Cases

| Scenario | Expected Behavior | Coverage |
| --- | --- | --- |
| Missing equipment | Emits `equipment_clarification`, planning risk, and `equipment_unknown`. | Covered. |
| Missing available duration | Emits `session_duration_clarification`, `duration_unknown`, and conservative fallback windows. | Covered. |
| Unclear goal | Emits a high-priority goal clarification prompt. | Covered through weak-profile prompt suite. |
| Hybrid with no modality priority | Emits `modality_priority_clarification` and avoids overconfident hybrid assumptions. | Covered through missing critical data detection. |
| Discomfort hinted but not clarified | Emits `injury_limitation_clarification` and keeps plan lower-confidence. | Covered. |
| Explicit "none" limitation | Does not emit unnecessary injury/discomfort prompt. | Covered. |
| Weak profile produces conservative plan | Uses shorter fallback windows and profile-confidence notes. | Covered. |
| Follow-up answers are provided | Confidence improves, plan-quality limitation clears, and resulting plan shape changes materially. | Covered. |
| Recently asked unresolved prompt | Does not repeat the same prompt, while missing risk remains visible. | Covered. |
| Sex/gender label only | Does not change training signature or add stereotype-based notes. | Covered by existing profile suite. |

## Validation Commands

```bash
npm run typecheck
npx vitest run '__tests__/services/training-profile-model.test.ts'
npx vitest run '__tests__/services/training-profile-model.test.ts' '__tests__/services/training-coach-kernel-plan-generator.test.ts' '__tests__/services/coach-kernel-planner.test.ts' '__tests__/services/coach-kernel-decision-trail.test.ts'
```

## Manual Review Checklist

| Check | Expected Result |
| --- | --- |
| Weak onboarding profile generates plan | Plan still exists; it is marked lower-confidence. |
| Profile card/API payload inspected | `profileQuality` includes scores, band, risk flags, missing data, and prompts. |
| Prompt copy reviewed | Prompts are concise and tied to a concrete planning risk. |
| Repeated generation with `recentlyAskedFollowUpIds` | Same unresolved prompt is suppressed. |
| Generation after adding answers | Confidence improves and plan becomes less conservative. |

## Known Gaps

- API route-level contract tests should be added once the iOS app renders structured `profileQuality`.
- Prompt localization is not covered in this backend slice.
- Persisted prompt-resolution state depends on profile storage or client state; this slice accepts IDs but does not own long-term storage.

