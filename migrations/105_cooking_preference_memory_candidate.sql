-- Migration 105: Cooking candidate preference-memory evidence update
--
-- Metadata only. This does not activate the Cooking release, deploy a model,
-- or alter live model/provider routing.

UPDATE skill_versions
SET
  capabilities_added_json = '["tenant-scoped recipes, meal plans, and shopping lists","tenant-scoped pantry persistence and freshness/availability metadata","user-private Cooking preference memory and corrections","meal-plan practicality assessment","allergy and dietary restriction blockers","grocery and pantry coherence checks","training-day fueling coverage warnings","schedule and budget fit warnings","Cooking evaluation and smoke documentation"]',
  memory_context_changes_json = '["Cooking preference memory writes and corrections use skill_memories with schema cooking-memory-v1","GET /api/v1/cooking/preferences and POST /api/v1/cooking/preferences expose tenant-scoped user-private memory contracts","cooking_set_preference and cooking_get_preferences tools preserve backend authorization before memory access","meal-plan assessment reads active Cooking preference memory before response composition"]',
  ios_portal_contract_changes_json = '["iOS receives additive assessment fields and preference summary fields but still needs rich-state rendering work for pantry, substitutions, warnings, and correction capture","Backend preference and pantry APIs are available for future portal Cooking setup surfaces; portal UI remains open"]',
  tests_added_json = '["cooking-chef.test.ts tenant-scope cases","cooking-intelligence.test.ts practicality/allergy/grocery/schedule/budget/training cases","cooking-preferences.test.ts user-private memory, corrections, tenant isolation, and allergy assessment","cooking-routes.test.ts pantry and preference API coverage","tool-executor.test.ts tenant-scoped Cooking tool coverage"]',
  smoke_tests_passed_json = '["Focused Cooking service tests passed in candidate branch","Pantry-focused Vitest passed in candidate branch","Preference-memory focused Vitest plus app-facing smoke passed in candidate branch","Full backend verify passed in candidate branch","Local full-product smoke documented with blockers where runtime services are unavailable"]',
  open_risks_json = '["Same-user multi-tenant runtime remains blocked by auth/session model even though Cooking service scope is ready","Finance budget context is represented by deterministic input, not a full Finance read path","iOS/portal rich Cooking UI is not implemented in this backend-only pass","Full local product smoke with workers/cache/iOS still required before production promotion"]',
  internal_notes = 'Candidate metadata updated by Cooking preference-memory workstream; contains no raw private meal plans, allergies, prompts, provider secrets, or tenant data.'
WHERE skill_id = 'cooking'
  AND version = '1.1.0-rc.1'
  AND status = 'candidate';
