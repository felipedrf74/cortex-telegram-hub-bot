-- Migration 106: Cooking candidate cross-skill planning-context evidence update
--
-- Metadata only. This keeps the Cooking release candidate traceable without
-- activating the version or changing live model/provider routing.

UPDATE skill_versions
SET
  capabilities_added_json = '["tenant-scoped recipes, meal plans, and shopping lists","tenant-scoped pantry persistence and freshness/availability metadata","user-private Cooking preference memory and corrections","Finance budget context read-through for meal-plan assessment","Secretary agenda availability read-through for meal-plan assessment","meal-plan practicality assessment","allergy and dietary restriction blockers","grocery and pantry coherence checks","training-day fueling coverage warnings","schedule and budget fit warnings","Cooking evaluation and smoke documentation"]',
  logic_improvements_json = '["Meal-plan read-back now incorporates Finance monthly budget headroom and Secretary default cooking-window pressure before response composition","Optional Finance/Secretary context degrades safely instead of failing the meal-plan API","Cooking assessment warns on tight Finance budget context without inventing item-level grocery prices"]',
  ios_portal_contract_changes_json = '["GET /api/v1/cooking/meal-plan returns additive planningContext.financeBudget and planningContext.secretaryAvailability blocks","Existing meal-plan response fields remain backward compatible","iOS and portal still need rich rendering for warnings, pantry/preference state, and correction capture"]',
  tests_added_json = '["cooking-planning-context.test.ts Finance budget headroom and Secretary agenda pressure","cooking-intelligence.test.ts Finance tight-budget warning","cooking-routes.test.ts route-level Finance/Secretary context assessment","app-facing-happy-path-smoke.test.ts auth-admitted tenant scope fixture"]',
  open_risks_json = '["Same-user multi-tenant runtime remains blocked by auth/session model even though Cooking service scope is ready","Finance context is budget-headroom read-through, not item-price grocery optimization","Secretary context estimates pressure in a default cooking window; alternate-window proposal generation remains open","iOS/portal rich Cooking UI is not implemented in this backend-only pass","Full local product smoke with workers/cache/iOS still required before production promotion"]',
  internal_notes = 'Candidate metadata updated by Cooking cross-skill planning-context workstream; contains no raw finance transactions, private agenda details, prompts, provider secrets, or tenant data.'
WHERE skill_id = 'cooking'
  AND version = '1.1.0-rc.1'
  AND status = 'candidate';
