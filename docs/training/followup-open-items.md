# Training Follow-Up Prompt Open Items

Date: 2026-04-28  
Branch: `feature/training-weak-profile-followup-prompts`

## High Priority

1. Render structured `profileQuality` in iOS.

   The backend now exposes completeness, confidence, planning-risk flags, missing data, and follow-up prompts on the app-facing coordinated plan. iOS should render this as a concise coach-quality limitation surface instead of parsing plan notes.

2. Persist follow-up prompt resolution.

   The engine accepts `resolvedFollowUpIds` and `recentlyAskedFollowUpIds`, but durable prompt history should live in the user profile or a profile-follow-up table. That prevents repeated prompts across devices and plan generations.

3. Add direct profile answer write routes if they do not already exist.

   Follow-up prompts should resolve into structured profile fields, not free-form notes that must be re-inferred every generation.

## Medium Priority

1. Add route-level API tests for `profileQuality`.

   Current tests validate service and planner behavior. Add route tests when the app contract is finalized so regressions cannot drop `profileQuality` from API responses.

2. Add localized prompt copy.

   Engine prompts are currently English source strings. The app or API mapper should provide Portuguese and English variants before a localized beta.

3. Expand equipment and environment vocabulary.

   The model should distinguish full gym, hotel gym, dumbbells, machines, cable stations, home bands, bike trainer, and outdoor constraints more precisely.

4. Improve answer-to-profile persistence for preferences.

   Preference/dislike prompts exist, but the profile schema should make preferred movements, disliked movements, and unavailable movements explicit.

## Low Priority

1. Add confidence trend reporting.

   It would be useful for operators to see profile confidence improve after follow-up answers over multiple generations.

2. Add portal/admin visibility.

   Admin diagnostics should show why a plan was marked lower-confidence without exposing private health details unnecessarily.

## Residual Risk

Weak profiles are now detected and surfaced, but the full product loop is not complete until iOS can answer and persist these prompts cleanly. Backend planning no longer silently relies on broad assumptions, but repeated prompting across devices remains a storage/product concern.

