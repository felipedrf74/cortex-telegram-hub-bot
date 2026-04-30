# Cooking Evaluation Harness

Date: 2026-04-30

## Purpose

Cooking quality must be measured beyond "did a route return 200?" The evaluation harness should score realistic multi-turn workflows for practicality, safety, context use, and tenant isolation.

## Current Implementation

This branch adds deterministic backend tests for:

- allergy blocker
- pantry expiration blocker
- grocery coherence
- schedule capacity
- budget pressure
- Training-day meal coverage

## Proposed Harness Shape

Inputs:

- persona
- tenant/user fixture
- meal plan fixture
- recipes
- pantry
- preferences/memory
- Training schedule
- Secretary availability
- Finance budget
- prompt or Chat turn

Outputs:

- transcript
- skill calls
- context used
- assessment issues
- provider/model/tier/category metadata where a provider is used
- rubric scores
- failure taxonomy

## Deterministic First

Use fixture mode for contract, safety, and tenant tests. Limited real provider calls should be reserved for qualitative generation once tenant, allergy, and prompt-context boundaries are already enforced.

