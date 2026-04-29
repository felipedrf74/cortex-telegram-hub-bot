# Content Refinement Workflow

Date: 2026-04-29  
Branch: `feature/content-creation-intelligence-upgrade`

## Goal

Refinement should preserve provenance, voice, format rules, and workflow state. It should not blindly rewrite content and lose the source truth.

## Backend Support

`buildContentRefinementPlan()` classifies refinement requests and returns:

- refinement intent
- target format
- target platform
- action list
- references preserved
- review warnings
- next workflow step
- prompt/context block

## Supported Intent Classes

- shorten
- make more direct
- use voice/profile memory
- remove unsupported claims
- adapt platform
- generate hooks
- improve/refine intro
- simplify
- educational
- story-driven

## Safety Rules

- Preserve authorized source provenance.
- Do not add unsupported factual claims.
- Carry tenant/user scope into the refinement contract.
- Use target-platform structure when adapting.
- Keep review warnings when low-confidence sources or missing profile data are involved.

## Current Limits

- The refinement planner is backend service foundation.
- A dedicated app-facing refinement route is not complete yet.
- iOS/portal confirmation and review UX still need wiring.
