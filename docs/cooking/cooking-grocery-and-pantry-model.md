# Cooking Grocery And Pantry Model

Date: 2026-04-30

## Current Grocery Model

Shopping lists are generated from linked meal-plan recipes.

Current strengths:

- ingredient dedupe
- compatible unit aggregation
- aisle classification
- checked-state persistence
- tenant/user scoped storage

## Current Pantry Model

Pantry is not yet persisted. The new assessment service accepts pantry fixture input and handles:

- available pantry items
- expired pantry blockers
- missing ingredient detection

## Proposed Pantry Table

Future pantry rows should include:

- `pantry_item_id`
- `tenant_id`
- `owner_user_id`
- `visibility_scope`
- `name`
- `quantity`
- `unit`
- `status`
- `expires_at`
- `freshness_confidence`
- `last_updated_at`
- `source`

## Open Items

- Pantry APIs.
- iOS pantry rendering and correction.
- Portal pantry management.
- Grocery budget estimation backed by Finance.
- Store/unavailable item fallback.

