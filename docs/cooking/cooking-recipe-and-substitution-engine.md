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

## Required Next Implementation

Add a substitution contract that produces:

- original ingredient
- reason for substitution
- safe substitute
- cooking role preserved
- allergy/restriction validation
- budget/time/equipment impact
- confidence
- review warning when uncertain

## Safety Rule

Cooking must never suggest unsafe allergy substitutions or medical diet treatment. It should flag uncertainty and recommend professional guidance for clinical conditions.

