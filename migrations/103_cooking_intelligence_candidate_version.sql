-- Migration 103: Cooking intelligence candidate registry record
--
-- Release metadata only. This does not deploy, activate, pin a model provider,
-- change skill entitlement, or alter live provider routing.

INSERT OR IGNORE INTO skill_versions (
  skill_id,
  skill_name,
  version,
  release_type,
  release_title,
  release_summary,
  capabilities_added_json,
  logic_improvements_json,
  bug_fixes_json,
  security_fixes_json,
  tenant_scope_changes_json,
  memory_context_changes_json,
  model_routing_changes_json,
  data_schema_changes_json,
  ios_portal_contract_changes_json,
  tests_added_json,
  smoke_tests_passed_json,
  evaluation_results_json,
  open_risks_json,
  known_limitations_json,
  rollback_notes,
  internal_notes,
  created_by,
  status,
  rollout_scope,
  compatible_api_version,
  memory_schema_version,
  quality_gate_status
) VALUES (
  'cooking',
  'Cooking',
  '1.1.0-rc.1',
  'minor',
  'Cooking intelligence upgrade candidate',
  'Adds explicit Cooking tenant scope metadata, deterministic meal-plan practicality assessment, grocery/pantry coherence checks, allergy/restriction blockers, schedule/budget/training-fit warnings, and Cooking release evidence docs.',
  '["tenant-scoped recipes, meal plans, and shopping lists","meal-plan practicality assessment","allergy and dietary restriction blockers","grocery and pantry coherence checks","training-day fueling coverage warnings","schedule and budget fit warnings","Cooking evaluation and smoke documentation"]',
  '["Cooking REST read-back now includes an additive assessment block","Cooking tools pass the authenticated tenant scope into Cooking persistence","Cross-skill Cooking mesh can read tenant-scoped meal and shopping context","Cooking intelligence is deterministic and provider-agnostic"]',
  '["Cooking data access no longer depends only on user_id when tenant_id is available","Same-user cross-tenant reads and writes are denied at the service layer","Same-slot tenant overwrite is rejected until a membership-backed multi-tenant Cooking unique model exists"]',
  '["Legacy Cooking rows are backfilled to tenant_id=user_id and user_private visibility","Ambiguous userless Cooking rows are quarantined by runtime backfill","No unauthorized Cooking context is sent to model providers by this change"]',
  '["recipes, meal_plans, and shopping_lists now carry tenant_id, owner_user_id, visibility_scope, lifecycle_state, scope_status, created_by, updated_by, and audit metadata","Cooking service queries filter by tenant and owner before returning data"]',
  '["Cooking preference memory model is documented for allergies, dislikes, prep-time, budget sensitivity, equipment, and training-day fueling preferences","Runtime skill_memories schema remains cooking-memory-v1 until a dedicated Cooking memory writer is promoted"]',
  '["No fixed provider introduced","Live routing and operator overrides are preserved","Cooking intelligence assessment runs before response composition and does not force Gemini, OpenAI, Anthropic, or any single model"]',
  '["migrations/102_cooking_tenant_scope_and_intelligence.sql","migrations/103_cooking_intelligence_candidate_version.sql"]',
  '["iOS receives additive assessment fields but still needs rich-state rendering work for pantry, substitutions, warnings, and correction capture","Portal Cooking preferences/pantry management remains a documented gap"]',
  '["cooking-chef.test.ts tenant-scope cases","cooking-intelligence.test.ts practicality/allergy/grocery/schedule/budget/training cases","cooking-routes.test.ts existing route regression coverage"]',
  '["Focused Cooking service tests pending in candidate branch","Local full-product smoke documented with blockers where runtime services are unavailable"]',
  '{"mode":"fixture","production_data_used":false,"release_gate":"PENDING_LOCAL_SMOKE"}',
  '["Same-user multi-tenant runtime remains blocked by auth/session model even though Cooking service scope is ready","Dedicated pantry persistence is not yet production-backed","Finance budget context is represented by deterministic input, not a full Finance read path","iOS/portal rich Cooking UI is not implemented in this backend-only pass"]',
  '["No medical diagnosis or treatment advice","Pantry quantities and expiration remain optional metadata","Budget estimates are advisory until Finance-backed grocery spend models are promoted","External grocery/provider integrations are not included"]',
  'Keep cooking@1.0.0 active. If candidate scope migration causes issues, restore the predeploy DB snapshot and revert the release branch; no model-routing rollback is required.',
  'Candidate registered by Cooking intelligence workstream; contains no raw private meal plans, allergies, prompts, provider secrets, or tenant data.',
  'codex-cooking-intelligence-upgrade',
  'candidate',
  'global',
  'api-v1',
  'cooking-memory-v1',
  'pending'
);

INSERT OR IGNORE INTO skill_version_rollouts (
  skill_version_id,
  scope_type,
  status,
  created_by,
  rollout_notes
)
SELECT
  id,
  'global',
  'candidate',
  'codex-cooking-intelligence-upgrade',
  'Candidate metadata only. Do not promote without full local smoke, staging smoke, and explicit release approval.'
FROM skill_versions
WHERE skill_id = 'cooking'
  AND version = '1.1.0-rc.1';
