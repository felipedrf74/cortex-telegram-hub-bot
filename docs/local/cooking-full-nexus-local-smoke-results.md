# Cooking Full Nexus Local Smoke Results

Date: 2026-04-30

## Result

PASS WITH CONDITIONS.

## Completed

- Focused backend Cooking tests passed, including persistent pantry route/service/tool coverage and Cooking preference-memory correction coverage.
- Pantry-focused Vitest passed: 4 files / 175 tests.
- Preference-memory focused Vitest plus app-facing smoke passed: 7 files / 208 tests.
- Planning-context focused Vitest passed: 3 files / 29 tests.
- Substitution-candidate focused Vitest passed: 3 files / 34 tests.
- Typecheck passed.
- Full backend verify passed: 427 files / 6398 tests.
- Full local backend product runtime smoke ran on `127.0.0.1:8326` with a fresh SQLite DB and fixture model mode.
- Authenticated API smoke passed 13/13 endpoints, including Dashboard, Plan, Training, Content, Cooking meal plan, Finance, Connections, and Inbox.
- Chat tenant-isolation smoke passed with conditions: 15 pass, 1 partial, 0 fail. The partial is live provider fallback quality, not tenant leakage.
- Cross-skill fixtures passed for Secretary, Training, Cooking, Finance, Content, and shared signal prompt plumbing.
- Chat evaluation and day-to-day simulation fixtures passed.
- Authenticated Cooking read-back smoke proved `planningContext.financeBudget` and `planningContext.secretaryAvailability` are returned by the live local API before response composition.
- Portal Cooking management contract tests passed for scoped preferences and pantry routes with audit coverage.
- Portal Cooking browser UI wiring tests passed for the new preference/pantry
  manager.
- Portal Cooking browser runtime smoke passed on the local portal at
  `127.0.0.1:8200`: authenticated with the local portal token, selected
  user/tenant `2`, loaded scoped Cooking preferences, rendered the allergy
  preference summary, and reported no Playwright page or console errors.
- iOS focused rich Cooking DTO/rendering tests passed on branch
  `feature/cooking-rich-state-ui` at `f4f1053`, `cfe5df4`, `e8cdc80`,
  `d7eb9f4`, and `7be4b6f`; 13 Cooking presentation tests passed, including
  compact substitution suggestion rendering.
- iOS rich Cooking simulator smoke passed against the full local backend on
  `127.0.0.1:8200`: the app built, installed, authenticated through local auth
  import, opened the Cooking skill, rendered the seeded dinner, rendered
  blocked Cooking signals, rendered two backend-provided substitution
  candidates, exposed preference/schedule actions, and produced no app error
  logs.
- No production data or calendars used.
- No real provider calls used.

## Not Completed

- No real provider quality sampling was run.

## Remaining Conditions

- Do not claim live provider quality from this smoke; it intentionally used fixture/degraded routing.
- Do not claim production calendar/provider behavior from this smoke; it used
  local fixtures and no production data.
