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

Pantry now has a persistent tenant-scoped backend foundation in
`cooking_pantry_items`.

Rows include:

- `id`
- `tenant_id`
- `user_id`
- `owner_user_id`
- `visibility_scope`
- `scope_status`
- `lifecycle_state`
- `name`
- `normalized_name`
- `quantity`
- `unit`
- `category`
- `expires_at`
- `freshness_status`
- `availability_status`
- `source`
- `confidence`
- `notes`
- audit/update metadata

Current APIs:

- `GET /api/v1/cooking/pantry`
- `POST /api/v1/cooking/pantry/items`
- `GET /api/v1/cooking/pantry/items/:id`
- `PATCH /api/v1/cooking/pantry/items/:id`
- `DELETE /api/v1/cooking/pantry/items/:id`

Shopping-list generation marks matching ingredients as
`pantry_available`, `pantry_expired`, or `needed`. Expired pantry items
are never treated as safely usable.

## Open Items

- iOS simulator smoke for pantry rendering and correction capture.
- Portal browser runtime smoke for pantry management; backend portal contracts
  and static UI wiring tests are implemented.
- Grocery budget estimation backed by Finance.
- Store/unavailable item fallback.
