# Cooking Production Burndown Plan

Date: 2026-04-30

## P0

No known unresolved P0 after focused backend tests.

## P1 Before Production

1. Add rich Cooking simulator smoke. Assessment warning/context/preference rendering is implemented on `feature/cooking-rich-state-ui` at `f4f1053`; pantry freshness rendering is implemented at `cfe5df4`; preference correction capture is implemented at `e8cdc80`.
2. Add portal browser UI/deep editor. Backend portal preference/pantry
   management contracts are implemented and tested.

## P2

- Add iOS simulator smoke for rich Cooking result rendering against the local backend bundle.
- Advanced substitution engine.
- Finance-backed grocery budget optimizer.
- Secretary-driven alternate cooking-window proposals.
- Leftover/waste planner.
- Food-safety prompt-injection tests.
