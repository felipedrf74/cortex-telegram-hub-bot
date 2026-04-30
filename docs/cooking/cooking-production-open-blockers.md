# Cooking Production Open Blockers

Date: 2026-04-30

## P0

None known.

## P1

- Portal Cooking browser UI/deep editor not implemented. Backend portal
  management routes for preferences and pantry are implemented and tested.
- iOS substitution/review prompts remain open after the rich assessment/warning
  card landed on `feature/cooking-rich-state-ui` (`f4f1053`). Pantry freshness
  rendering is implemented at `cfe5df4`; preference correction capture is
  implemented at `e8cdc80`.

## Release Gate

Current gate: GO WITH CONDITIONS for backend candidate, not GO for production deployment.
