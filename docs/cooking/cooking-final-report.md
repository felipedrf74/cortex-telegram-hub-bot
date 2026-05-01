# Cooking Final Report

Date: 2026-04-30, updated 2026-05-01
Branch: `feature/cooking-intelligence-upgrade`
Verdict: backend candidate PASS WITH CONDITIONS — do not promote to production from this workstream

## What Changed

- Added explicit tenant/owner/visibility/lifecycle metadata for Cooking recipes, meal plans, and shopping lists.
- Added persistent tenant-scoped pantry items with freshness/availability metadata and REST/Chat tool access.
- Added user-private Cooking preference memory writer with correction handling, REST APIs, Chat tools, and meal-plan assessment read-through.
- Added Finance budget and Secretary availability context read-through for meal-plan assessment, with safe degradation when optional context is unavailable.
- Hardened Cooking service queries to filter by tenant and owner.
- Passed tenant scope through Cooking REST routes, Chat tools, and Cooking mesh reads.
- Shopping-list generation now marks items as pantry available, expired, or still needed.
- Added deterministic Cooking intelligence assessment for allergy, dietary restriction, grocery coherence, pantry freshness, schedule capacity, budget, Training coverage, repetition, and complexity.
- Added deterministic, reviewable substitution candidates to Cooking assessment issues and the top-level `assessment.substitutionSuggestions` array.
- Added scoped substitution application contract so accepted replacements update
  the linked recipe, matching meal/recipe copy, and regenerated weekly shopping
  list without crossing tenant boundaries.
- Added additive `assessment` read-back to `GET /api/v1/cooking/meal-plan`.
- Added audited portal admin/operator routes for scoped Cooking preference and pantry management.
- Added portal browser UI for scoped Cooking preference review, preference
  correction writes, pantry editing, and confirmed pantry deletion.
- Added audited portal substitution acceptance route and UI panel for applying
  reviewed allergy/dietary/disliked/expired-pantry replacements through the
  scoped backend mutation contract.
- Updated Cooking prompt guardrails to avoid tenant leakage, pantry invention, unsafe medical advice, and allergy/restriction casualness.
- Removed provider-specific required API key from Cooking manifest.
- Registered `cooking@1.1.0-rc.1` as a candidate skill version.

## Evidence

- Focused Vitest: 5 files / 126 tests PASS.
- Pantry-focused Vitest: 4 files / 175 tests PASS.
- Preference-memory focused Vitest plus app-facing smoke: 7 files / 208 tests PASS.
- Planning-context focused Vitest: 3 files / 29 tests PASS.
- Substitution-candidate focused Vitest: 3 files / 48 tests PASS.
- Substitution application focused Vitest: 2 files / 45 tests PASS.
- Typecheck: PASS.
- Full `NEXUS_LOCAL_ALLOW_MODEL_CALLS=0 npm run verify`: PASS, 429 files / 6434 tests after the portal substitution-acceptance addition.
- Full local backend product smoke: PASS WITH CONDITIONS on `127.0.0.1:8326`; authenticated API smoke 13/13, Chat tenant smoke 15 pass / 1 partial / 0 fail, cross-skill fixtures PASS, Chat eval/day-to-day fixtures PASS.
- Live local Cooking planning-context API read-back: PASS; Finance tight-budget context and Secretary cooking-window pressure were returned by `GET /api/v1/cooking/meal-plan`.
- iOS rich Cooking DTO/rendering slice: PASS on branch `feature/cooking-rich-state-ui` at `f4f1053`, `cfe5df4`, `e8cdc80`, `d7eb9f4`, `7be4b6f`, and `8a5bdad`; 15 focused Cooking presentation tests passed, including rich and legacy meal-plan payload decoding, pantry freshness DTO rendering, direct preference-correction POST body validation, assessment review-prompt routing, compact substitution suggestion rendering, future adaptation-kind fallback, and unknown substitution metadata fallback.
- iOS rich Cooking simulator smoke: PASS on local backend
  `127.0.0.1:8200` with fixture model mode and local auth import; the
  simulator rendered the seeded dinner, blocked Cooking signals,
  backend-provided substitution candidates, preference summary, and action
  affordances without app error logs.
- Portal Cooking management: PASS; `npx vitest run __tests__/portal/portal-cooking-routes.test.ts __tests__/portal/portal-cooking-ui.test.ts __tests__/api/cooking-routes.test.ts` passed 52 tests for guarded backend contracts, browser UI wiring, substitution application, cross-tenant rejection, destructive confirmation, and stale-data clearing after a scoped load failure.
- Portal Cooking browser runtime: PASS on `127.0.0.1:8200/portal`; authenticated
  local portal loaded user/tenant `2`, rendered the scoped preference/pantry
  manager, saved a scoped allergy preference, saved pantry state, then verified
  forged tenant `9002` fails closed with `Load failed`, no stale Cooking
  tables, no unexpected HTTP failures, and `providerCallsAllowed:false`.
- Hardened portal auth browser runtime: PASS with `PORTAL_REQUIRE_SESSION_AUTH=true`,
  `PORTAL_ALLOW_LOCAL_BYPASS=false`, and a signed `ps_` admin session. The
  invalid-auth probe submitted an invalid `ps_` token through the real portal
  login form, observed `/api/snapshot` return `401`, kept the login overlay
  visible with `Invalid token`, then signed in with the valid session and
  repeated the scoped Cooking/forged-tenant smoke with `providerCallsAllowed:false`.
- No production data used.
- No production calendar used.
- No deployment performed.
- No fixed model/provider introduced.

## Remaining Conditions Before Production

- Add recipe library, meal-plan, and grocery-settings portal deep editors once
  backend management contracts exist.
- Add iOS direct-accept affordances for the backend substitution application
  contract if product wants one-tap replacement actions in the mobile app.
- Preserve the condition that this smoke used fixture routing, not real provider
  quality sampling.

## Release Recommendation

Do not deploy from this workstream without the normal staging gate. Treat this
as a strong backend+iOS+portal candidate foundation with no known P0/P1 Cooking
blockers; remaining work is product polish, deeper portal editors, and live
provider-quality sampling.
