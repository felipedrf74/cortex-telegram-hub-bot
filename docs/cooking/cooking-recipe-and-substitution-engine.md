# Cooking Recipe And Substitution Engine

Date: 2026-04-30

## Current Recipe Support

Cooking supports recipe CRUD with:

- structured ingredients
- instructions
- prep/cook time
- servings
- tags/source
- protein/fat/carbs/calories
- tenant/user scope

## Current Substitution Support

This branch adds the validation foundation that substitutions should obey:

- allergy blockers
- dietary restriction blockers
- disliked ingredient warnings
- pantry expired blockers
- time/budget warnings
- deterministic substitution candidates in meal-plan assessment issues and the
  top-level `assessment.substitutionSuggestions` array

Substitution suggestions include:

- original ingredient
- reason for substitution
- suggested ingredient
- cooking role preserved
- allergy/restriction/preference validation before emitting a candidate
- candidate impact
- confidence
- review warning when uncertain

The first implementation is intentionally conservative and deterministic. It is
designed for iOS/portal rendering and review workflows, not automatic recipe
mutation.

## Required Next Implementation

Add a deeper substitution engine that considers:

- item price and grocery budget
- equipment constraints
- cuisine/style preservation
- texture/flavor role
- unavailable store items
- pantry quantity and low-stock status

## Safety Rule

Cooking must never suggest unsafe allergy substitutions or medical diet treatment. It should flag uncertainty and recommend professional guidance for clinical conditions.
