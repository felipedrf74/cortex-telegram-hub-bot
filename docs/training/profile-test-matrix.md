# Training Profile Test Matrix

## Automated Tests Added

| Test File | Coverage |
| --- | --- |
| `__tests__/services/training-profile-model.test.ts` | Normalized profile extraction, quality scores, confidence bands, material plan differences, missing-data follow-ups, weekly plan follow-up notes, conservative duration fallback, prompt dedupe, sex/gender non-stereotyping, explicit "none" limitation handling. |

## Regression Coverage

| Risk | Coverage |
| --- | --- |
| Raw questionnaire JSON masquerades as personalization | Asserts structured normalized profile fields for goals, experience, duration, equipment, and recovery baseline. |
| Different profiles only change labels | Builds beginner/bodyweight/30-min and advanced/full-gym/60-min athletes and asserts different windows, durations, session volume, and exercise IDs. |
| Missing critical data remains silent | Missing objective, duration, equipment, injury status, and modality priority trigger high-priority follow-ups. |
| Follow-up needs never reach planning | Weekly plan notes include high-priority `Profile follow-up:` entries while still producing sessions. |
| Weak profile receives overconfident duration assumptions | Missing duration plus low confidence uses conservative fallback windows. |
| Same prompt repeats after being asked | `recentlyAskedFollowUpIds` suppresses repeated prompt IDs while preserving missing-data risk. |
| Follow-up answers do not improve planning | Adding goal, duration, equipment, schedule, and limitation answers improves confidence and changes the plan shape. |
| Sex/gender stereotypes alter plans | Male/female labels with no explicit relevant context produce identical session signatures and no sex/gender notes. |
| Explicit "none" limitation answer is treated as data | `injuries: "none"` avoids unnecessary injury follow-up. |

## Validation Commands

```bash
npm run typecheck
npx vitest run __tests__/services/training-profile-model.test.ts __tests__/services/training-coach-kernel-plan-generator.test.ts
```

## Expected Follow-Up Suites

Future tests should cover:

- route/API exposure of profile quality once iOS is ready to render it
- user-profile storage migrations if normalized profile snapshots become persisted
- cycle/postpartum-aware planning only after explicit supported fields exist
- adaptive plan regeneration based on captured feedback answers
