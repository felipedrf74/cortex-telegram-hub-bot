# Training profile and questionnaire review

## Profile fields rechecked

- Experience level: previous commit `627d4fe` expanded English and Portuguese vocabulary and numeric year parsing.
- Equipment access: previous commit `627d4fe` expanded commercial gym, CrossFit, academia/ginasio, and related phrases to imply barbell and dumbbell access.
- Strength frequency: this pass ensures route and engine layers can preserve explicit five-day strength requests.
- Running/marathon goal: this pass marks missing race date as critical for marathon plans.
- Long-run day: deterministic fallback and existing scheduler utilities preserve canonical day strings; no new bug was reproduced.

## Fix applied

`src/services/training-profile-model.ts` now appends a critical missing field:

- key: `race_date`
- category: `goals`
- severity: `critical`
- reason: marathon progression, long-run build, and taper require a target date.

## Tests

- `__tests__/services/training-profile-model.test.ts` pins marathon-without-date and marathon-with-date behavior.
- Prior equipment and experience vocabulary suites were rerun and passed.

## Remaining risk

The default local smoke seed lacks a completed fitness profile, so local plan generation returns the honest profile-completion gate instead of producing a personalized plan. That is correct behavior, but richer local Training fixture data would make end-to-end plan smoke stronger.
