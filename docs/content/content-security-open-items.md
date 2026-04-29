# Content Creation Security Open Items

Updated: 2026-04-29

## P0 Production Blockers

None found in the implemented backend reference/prompt path after this pass.

## P1 Must Fix Before Broad Tenant Rollout

1. Tenant admin/support visibility policy is not fully implemented.
   - Current implementation prevents casual exposure by default.
   - A future portal support workflow must add explicit role checks and audit events before private drafts or Voice DNA are inspectable.

2. Content vector/embedding namespace proof remains pending.
   - No first-class Content vector table was found in this pass.
   - If Content references move to embeddings/vector search, namespaces must include `tenant_id`, private/user scope, and permission filtering before retrieval.

3. Global Reaction Radar needs a full tenant-aware design.
   - This pass prevents the global radar from scanning user-private reference channels.
   - A future version should run per tenant/user or produce only explicitly public/platform signals.

## P2 Should Fix

1. Convert more Content worker paths to accept explicit `tenantId`.
   - Most current runtime paths map tenant to user.
   - More explicit parameters will make future multi-tenant workspace support less fragile.

2. Add admin/support audit tests once the portal surface exists.
   - Backend scope fields are ready for audit metadata.
   - Role-aware portal behavior is not complete.

3. Add a cleanup tool for reviewing quarantined legacy rows.
   - Migration safely quarantines ambiguous `user_id=0` rows.
   - Operators may eventually want a review/promote/delete workflow for old curated rows.

## P3 Deferrable

1. Richer lifecycle states for drafts/scripts beyond `active`.
2. Scope-aware export UI copy for public/published content.
3. More granular source-reference confidence scoring.
