# Cooking Open Items

Date: 2026-04-30

## P0

None currently known after focused backend tenant-scope and allergy-blocker tests.

## P1

- Add portal Cooking browser UI/deep editor. Backend portal preference/pantry
  management routes are implemented and tested.
- Add iOS substitution/review prompts. Core assessment/warning/context
  rendering is implemented on `feature/cooking-rich-state-ui` at `f4f1053`;
  pantry freshness rendering is implemented at `cfe5df4`; preference
  correction capture is implemented at `e8cdc80`.

## P2

- Add iOS simulator smoke for rich Cooking result rendering against the local
  backend bundle.
- Pantry quantity normalization and low-stock suggestions beyond CRUD/status.
- Advanced substitution engine.
- Leftover/waste optimizer.
- Store/unavailable item fallback.
- Item-price grocery budget optimizer and Secretary-driven alternate cooking-window proposals.
- Cooking-to-Content opportunity handoff with approval.
- Food-safety note library and tests for common storage/handling risks.

## P3

- Cuisine/style ontology.
- Performance-informed favorite/rejected meal analytics.
