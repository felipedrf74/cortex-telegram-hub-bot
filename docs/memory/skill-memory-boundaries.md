# Skill Memory Boundaries

Date: 2026-04-29

## Boundary Principle

Each skill may store and consume only memory types that match its domain. Cross-skill sharing must be explicit via `cross_skill_signal` or a tenant-shared memory that the target skill is allowed to consume.

The service enforces these boundaries before writing memory.

## Content Creation

Can store:

- `user_preference`
- `tenant_preference`
- `skill_specific_memory`
- `cross_skill_signal`
- `action_history`
- `content_creative_preference`
- `source_reference_preference`
- `voice_brand_preference`
- `correction_override`
- `stale_uncertain_memory`

Examples:

- voice profile
- content pillars
- reference preferences
- disliked formats
- platform preferences
- successful content patterns
- rejected idea patterns
- source trust preferences

## Secretary

Can store:

- `user_preference`
- `tenant_preference`
- `skill_specific_memory`
- `cross_skill_signal`
- `action_history`
- `unresolved_commitment`
- `schedule_preference`
- `correction_override`
- `stale_uncertain_memory`

Examples:

- working hours
- buffer preferences
- focus windows
- reminder preferences
- planning style
- unresolved commitments

## Training

Can store:

- `user_preference`
- `skill_specific_memory`
- `cross_skill_signal`
- `action_history`
- `training_preference`
- `correction_override`
- `stale_uncertain_memory`

Examples:

- training preferences
- equipment
- recovery tendencies
- adherence patterns
- exercise dislikes and limitations

## Cooking

Can store:

- `user_preference`
- `tenant_preference`
- `skill_specific_memory`
- `cross_skill_signal`
- `action_history`
- `cooking_preference`
- `correction_override`
- `stale_uncertain_memory`

Examples:

- dietary preferences
- prep-time preferences
- ingredient dislikes
- budget/time constraints
- allergies and dietary restrictions
- equipment and cooking skill level
- batch-cooking and leftovers preferences
- training-day fueling preferences

Cooking memory must not store medical diagnoses, treatment plans, raw private grocery receipts, or tenant-shared dietary restrictions without explicit scope. Allergy/restriction memory should be treated as safety-critical and should override weaker recipe/style preferences.

## Finance

Can store:

- `user_preference`
- `tenant_preference`
- `skill_specific_memory`
- `cross_skill_signal`
- `action_history`
- `unresolved_commitment`
- `finance_preference`
- `correction_override`
- `stale_uncertain_memory`

Examples:

- budget preferences
- recurring review preferences
- category preferences
- risk/priority preferences

## Chat

Can store:

- `user_preference`
- `tenant_preference`
- `skill_specific_memory`
- `cross_skill_signal`
- `action_history`
- `unresolved_commitment`
- `correction_override`
- `stale_uncertain_memory`

Examples:

- safe multi-turn context
- user corrections
- unresolved actions
- active tenant/context state

Chat should not store raw private content, raw tool outputs, full prompts, secrets, or broad tenant data dumps.

## Retrieval Defaults

Default retrieval:

- same tenant only
- same user for `user_private`
- same tenant for `tenant_shared`
- same skill only
- active and non-stale memories only

Optional retrieval:

- `includeCrossSkillSignals` can include explicit cross-skill signals
- `includeStale` can include stale/expired memory for audit or repair
- `includePlatformInternal` is reserved and should not be used in user-facing prompt construction

---

## May 2026 P0 chat-identity audit — addendum

Cross-checked during the P0 audit (May 2, 2026):

- All memory tables in `src/state/` and `src/services/` listed above were verified to filter by both `tenant_id` AND `user_id` on EVERY read site (the only single-key tables, e.g., `report_documents` and `unified_tasks`, do not have a `tenant_id` column today; their reads still scope by `user_id`, which equals `tenant_id` in the current 1:1 tenant model).
- Two minor leaks were closed during the audit:
  1. `src/services/context-engine.ts:207` previously used `WHERE user_id IN (0, ?)` to mix system seeds (`user_id = 0`) with per-user `saved_ideas` rows. Tightened to strict `WHERE user_id = ?`.
  2. `src/state/saved-ideas.ts` `getIdeasBySource` had no `userId` parameter. Now requires it.
- A new `authenticated-user` `ChatContextItem` was added at priority 98 (`critical: true`) by `src/services/chat-context-engine.ts:208-227` carrying the JWT-derived display name and the explicit instruction "do not use owner, founder, default, or prior-user names unless they appear in authorized context for this same user and tenant." This is BELT to the SUSPENDERS of the deterministic identity fast-path in `src/api/routes/chat-message-local-responses.ts`.
- New regression test: `__tests__/security/p0-chat-identity-isolation.test.ts` — pins the audit's fixes against future regressions.

Reference: `docs/security/p0-chat-identity-final-report.md` and `docs/security/p0-chat-identity-tenant-isolation-audit.md`.
