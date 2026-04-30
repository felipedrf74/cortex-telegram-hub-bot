# Cooking iOS Readiness

Date: 2026-04-30

## Current Readiness

Existing iOS contracts can consume recipes, meal plans, shopping lists,
Training adaptations, and prep-event scheduling responses.

Additional iOS branch evidence:

- Branch: `feature/cooking-rich-state-ui`
- Commits: `f4f1053`, `cfe5df4`, `e8cdc80`, `d7eb9f4`, `7be4b6f`
- Scope: additive DTOs for meal-plan assessment/planning context, repository state
  retention/reset, a compact Cooking signals card, shopping-list pantry
  available/expired rendering, pantry notes, accessibility labels, and
  first-class preference correction capture through `POST /api/v1/cooking/preferences`,
  deterministic review prompts that route assessment issues to the meal plan
  or shopping list without inventing substitution suggestions, and compact
  rendering for backend-provided `assessment.substitutionSuggestions`.
- Focused test:
  `xcodebuild test -project "Nexus Hub.xcodeproj" -scheme "Nexus Hub" -sdk iphonesimulator -destination "platform=iOS Simulator,name=iPhone 17 Pro" "-only-testing:Nexus HubTests/CookingPresentationTests"`:
  PASS, 13 Cooking presentation tests.

## New Backend Field

`GET /api/v1/cooking/meal-plan` now includes an additive `assessment` block:

- status
- confidence
- issues
- groceryCoherence
- scheduleFit
- budgetFit
- trainingFit
- substitutionSuggestions

Each `assessment.issues[]` entry may also include additive
`substitutionSuggestions`.

Existing clients should ignore it safely if not decoded.

Pantry now also has additive backend routes:

- `GET /api/v1/cooking/pantry`
- `POST /api/v1/cooking/pantry/items`
- `GET /api/v1/cooking/pantry/items/:id`
- `PATCH /api/v1/cooking/pantry/items/:id`
- `DELETE /api/v1/cooking/pantry/items/:id`

Shopping-list items may now include `pantry_status`,
`pantry_item_id`, `pantry_freshness_status`, and `pantry_note`.

Cooking preference memory now has additive backend routes:

- `GET /api/v1/cooking/preferences`
- `POST /api/v1/cooking/preferences`

`GET /api/v1/cooking/meal-plan` may also include
`preferences.summary` so iOS can show what memory influenced warnings without
rendering raw prompt context.

## Gaps

- Render allergy/restriction warning with a stronger distinct visual treatment.
- Re-run iOS simulator smoke against the local backend bundle with rich Cooking
  payload fixtures.
- Add a dedicated in-place substitution acceptance/replacement workflow if
  direct apply actions become part of the Cooking UX.
- Unknown enum/state fallback tests.

Verdict: PASS WITH CONDITIONS. The primary iOS rich assessment rendering gap is
closed in code on the iOS branch, including compact substitution suggestions;
simulator smoke remains a release condition.
