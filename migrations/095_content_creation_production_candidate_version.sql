-- Migration 095: Content Creation production candidate registry record
--
-- Registers the Content Creation release candidate produced by the
-- content intelligence hardening workstream. This is release metadata only:
-- it does not deploy, activate, pin a model provider, change skill
-- entitlement, or alter runtime routing.

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
  'content',
  'Content Creation',
  '2.3.0-rc.1',
  'minor',
  'Content Creation intelligence production candidate',
  'Adds tenant-safe Content reference handling, provenance review, editorial lifecycle, radar scoring, creative memory, novelty/reuse controls, cross-skill content signals, and deterministic quality evaluation evidence.',
  '["tenant-safe reference registry","reference provenance and claim review","editorial lifecycle and approval gates","Content Radar scoring and conversion","creative memory and voice profile context","duplicate/novelty/reuse controls","cross-skill content opportunity contracts","deterministic content evaluation harness"]',
  '["Generation/refinement contracts are platform-aware, source-aware, voice-aware, and workflow-aware","Retrieved source material is labeled as untrusted evidence before provider calls","Secretary scheduling handoff is represented as an intent contract instead of Content owning calendar placement","Content quality is measured with multi-turn day-to-day fixtures"]',
  '["Scoped Content routes and state paths by tenant/user where implemented","Dedup/provider paths preserve live model routing and user scope","Prompt construction excludes unauthorized references before provider calls","Unsupported/fake claims are flagged for review"]',
  '["Cross-tenant reference leakage blocked in focused tests","Cross-tenant voice profile leakage blocked in focused tests","Prompt-injection source content labeled as untrusted evidence","Publishing/scheduling/deleting/voice-change/sensitive-signal approval gates covered","Model-routing metadata excludes raw prompts and provider-token-like content where testable"]',
  '["Content references, radar, memory, workflow, provenance, and generation context carry tenant/user scope in backend foundations","Ambiguous legacy Content records are quarantined by scope migration where applicable","Same-user multi-tenant runtime proof remains a release condition"]',
  '["Content creative memory uses skill memory schema with tenant/user/private/shared scopes","User-private memory is omitted from tenant-shared output by default","Voice corrections and stale memory handling are covered by tests","Skill version registry now records Content candidate version and memory schema"]',
  '["No fixed provider introduced","Live routing and operator overrides are preserved","Content generation/evaluation metadata records category/domain without forcing Gemini, OpenAI, Anthropic, or any single provider"]',
  '["skill_versions candidate record for content@2.3.0-rc.1","content tenant/privacy scope migrations","content domain ontology/provenance/lifecycle/radar/novelty foundations","skill memory foundation"]',
  '["iOS and portal require additional rich-state work before claiming full upgraded Content UI readiness","Backend docs define DTO requirements for provenance, lifecycle, approval, novelty, and Secretary schedule decisions"]',
  '["content-security-red-team.test.ts","content-tenant-scope.test.ts","content-reference-provenance.test.ts","content-editorial-workflow.test.ts","content-generation-quality.test.ts","content-memory-profile.test.ts","content-radar-engine.test.ts","content-novelty-reuse.test.ts","content-day-to-day-evaluation.test.ts","content-cross-skill-orchestration.test.ts","skill-version-registry.test.ts"]',
  '["Focused Content service/regression tests passed","Content local full-product smoke documented PASS WITH CONDITIONS","Content quality eval baseline 91/100 with 0 critical failures","Security red-team focused tests passed"]',
  '{"content_eval_score":91,"content_eval_cases":15,"critical_failures":0,"release_gate":"PASS_WITH_CONDITIONS","mode":"fixture","production_data_used":false}',
  '["Real routed-provider quality sampling not run","Deep iOS Content workflow smoke remains open","Tenant-safe portal management writes remain open","Same-user tenant switching proof remains partial","Content-engine sidecar extraction/generation smoke remains open","Content-to-Secretary agenda lifecycle is contract-level rather than full agenda proof"]',
  '["Do not claim full rich iOS/portal Content readiness","Do not claim live provider output quality across all routed providers","External publishing remains disabled or approval-gated until end-to-end tests exist","Full same-user multi-tenant Content workspace switching is not proven"]',
  'Keep content@2.0.0 active. If the candidate regresses before activation, mark content@2.3.0-rc.1 rolled_back and do not apply rollout. If activated later and rollback is needed, restore the predeploy DB snapshot, revert the release branch, and keep external publishing disabled.',
  'Candidate registered by production hardening pass; contains no raw prompt, tenant strategy, provider secret, or private reference data.',
  'codex-content-production-hardening',
  'candidate',
  'global',
  'api-v1',
  'content-creative-memory-v1',
  'pass_with_conditions'
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
  'codex-content-production-hardening',
  'Candidate metadata only. Do not promote without staging smoke and explicit release approval.'
FROM skill_versions
WHERE skill_id = 'content'
  AND version = '2.3.0-rc.1';
