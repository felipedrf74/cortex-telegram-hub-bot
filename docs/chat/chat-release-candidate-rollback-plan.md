# Chat Release Candidate Rollback Plan

Date: 2026-04-29  
Release branch: `release/chat-tenant-safe-production-candidate`

## Rollback Principle

Prefer code rollback for behavioral issues and database snapshot restore only for migration/data issues. Migrations `084` and `085` are additive but materially change Chat persistence assumptions, so production deployment must take a predeploy DB snapshot and prove restore on a clone before promotion.

## Predeploy Requirements

Before production deployment:

1. Record source commit and release commit.
2. Take a production DB snapshot using the approved online/safe backup method.
3. Rehearse `084_chat_tenant_scope.sql` and `085_chat_message_lifecycle.sql` on a disposable clone.
4. Verify:
   - integrity check passes
   - `messages`, `conversations`, `shared_memory`, `daily_context_cache`, `api_usage`, and `audit_trail` have expected columns/indexes
   - ambiguous/system rows are quarantined
   - focused Chat tests pass against migrated clone where practical
   - restore from snapshot returns clone to pre-migration state

## Code Rollback

If Chat behavior regresses but DB remains healthy:

1. Disable any newly enabled Chat runtime flags first.
2. Confirm `IOS_WS_ENABLED=false`.
3. Revert deployment to the previous known-good commit.
4. Restart the service.
5. Run production health and focused Chat smoke:
   - `/api/v1/auth/me`
   - `/api/v1/chat/history`
   - safe deterministic `/api/v1/chat/message`
   - dashboard/home health
6. Watch logs for tool authorization failures, provider errors, and idempotency conflicts.

## Database Rollback

If migration or backfill corrupts production Chat state:

1. Stop production service writers.
2. Preserve the failed DB for forensic analysis.
3. Restore the predeploy snapshot.
4. Start the previous known-good code version.
5. Run integrity check and focused auth/Chat smoke.
6. Do not re-run migrations until the failure is reproduced on a clone and fixed.

## Runtime Kill Switches And Guards

| Concern | Guard |
| --- | --- |
| WebSocket streaming | Keep `IOS_WS_ENABLED=false`. |
| Anthropic emergency fallback | Requires `ANTHROPIC_ENABLED=true`; keep off unless intentionally activated. |
| Provider spend | Remove local/staging provider keys from smoke env or set bounded smoke limits. |
| Portal raw Chat content | No raw-content route exists in this RC. |
| Operator bad model pin | `/api/model-config` rejects models outside provider role-tier options. |
| Destructive Chat action | Requires explicit confirmation. |

## Data Repair Helpers

Use tenant-scoped repair helpers for messages stuck in non-final lifecycle states before considering broad data edits. Do not repair by global message title/text matching. Any manual repair must include tenant ID, user ID, conversation/message ID, and an audit note.

## Rollback Verification Checklist

- Previous code commit running.
- DB integrity check passes.
- Chat history loads for the owner/founder test user.
- A safe deterministic Chat turn returns 200.
- Cross-user history access remains denied.
- No backend listeners, workers, or provider loops remain from failed release attempts.
- Portal diagnostics remain metadata-only.
