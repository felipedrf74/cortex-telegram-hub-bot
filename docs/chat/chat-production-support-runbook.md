# Chat Production Support Runbook

Date: 2026-04-29
Release branch: `release/chat-tenant-safe-production-candidate`

## Safety Rules

- Do not expose raw Chat messages, prompts, memory values, tool output, provider bodies, or attachments through support tooling unless a future audited support-access workflow exists.
- Prefer metadata diagnostics: IDs, tenant/user scope, lifecycle states, provider/model metadata, error codes, and timestamps.
- Treat any cross-tenant Chat access report as P0.
- Keep `IOS_WS_ENABLED=false` unless a future streaming release completes auth/tenant/reconnect parity.

## Inspect A Conversation

1. Identify `conversation_id`, `user_id`, and `tenant_id`.
2. Verify the requester is the same user or has an explicitly audited support/admin role.
3. Inspect metadata only by default:
   - conversation state
   - message count
   - last activity
   - tenant/user scope
   - lifecycle-state distribution
   - error codes
4. Do not copy raw content into tickets unless the user explicitly provided it.

## Inspect Message Lifecycle State

Check:

- `message_id`
- `conversation_id`
- `tenant_id`
- `user_id`
- `client_message_id`
- `lifecycle_state`
- `failure_code`
- `canceled_at`
- `retried_from_message_id`
- `completed_at`

If an assistant message is stuck in `sent` or `streaming`, use the repair helper/runbook step documented in the rollback plan or wait for the repair job if enabled.

## Inspect Tenant/User Ownership

1. Confirm `tenant_id` equals the active canonical tenant for the current release scope.
2. Confirm `user_id` matches the authenticated caller.
3. Confirm `scope_status='active'` for visible rows.
4. Quarantined or ambiguous rows must not be surfaced broadly.

## Inspect Context Used

Use Chat diagnostics metadata only:

- context item count
- sources
- freshness/confidence bands
- relevance bands
- domains/skills involved
- weak-context flags
- prompt-injection flags

Do not expose raw prompt/context text by default.

## Inspect Memory Or Summaries Used

1. Confirm memory/summary row has `tenant_id` and `user_id` or explicit visibility scope.
2. Confirm it is active and not stale/quarantined.
3. Review metadata first: source, freshness, confidence, updated time.
4. Do not expose private memory text through support tooling without future policy/audit.

## Inspect Tool/Skill Calls

Check:

- tool name
- source skill/domain
- authorization decision
- confirmation status
- tenant/user scope
- result status
- failure code
- idempotency/client message key

If a destructive action was attempted without confirmation, treat as a P0/P1 depending on whether anything executed.

## Diagnose Streaming Failures

For this release:

1. Confirm `IOS_WS_ENABLED` is unset/false.
2. If streaming traffic appears, identify source and disable it.
3. Verify stuck message repair marks stale `streaming` assistant rows as failed.
4. Do not promote streaming until auth, tenant, reconnect, idempotency, and fallback tests pass.

## Diagnose Stale Chat Cache

1. Confirm app sign-out/sign-in or tenant-scope change happened.
2. Confirm iOS repository cache key changed by user/tenant.
3. Ask user to force refresh only after backend scope is verified.
4. If stale cross-user data appears, treat as P0.

## Diagnose Retrieval Scope Issues

1. Confirm active user and tenant.
2. Confirm retrieval query includes tenant/user scope before results are returned.
3. Confirm retrieved content is labeled data-only in prompt context.
4. If vector retrieval is enabled later, confirm namespace filtering happens before result exposure.

## Inspect Provider/Model Routing Used

Use provider metadata:

- task type
- provider
- model
- tier
- category
- domain/skill
- fallback used
- fallback reason
- operator override applied
- latency
- cost estimate where available

Do not use raw prompt logs as the first diagnostic path.

## Diagnose Fallback Behavior

1. Confirm fallback received the same scoped context object/string as the primary path.
2. Confirm fallback did not rebuild broader context.
3. Confirm Anthropic was only used when `ANTHROPIC_ENABLED=true`.
4. Confirm no product copy claims fallback quality unless bounded provider smoke has been run.

## Audit Admin/Support Access

Current release supports metadata-only diagnostics. If any support workflow needs raw content:

1. Stop and confirm policy/consent/role/audit exists.
2. Do not add ad hoc SQL or portal routes for raw content.
3. Record access in audit logs if a future approved tool exists.

## Diagnose Response Insufficiency

Use:

- day-to-day simulation failure taxonomy
- response sufficiency rubric
- skill routing metadata
- context freshness/confidence metadata
- provider/model metadata
- user correction rate

Classify the issue as wrong routing, missing clarification, stale context, weak context, tool failure, provider failure, or product limitation.

## Review Day-To-Day Simulation Failures

1. Run `npm run chat:eval`.
2. Run `node dist/tools/chat-day-to-day-simulation.js`.
3. Review scenario, persona, turn ID, score, and failure taxonomy.
4. Fix deterministic safety/contract failures before sampling live provider wording.

## Rollback

1. Keep `IOS_WS_ENABLED=false`.
2. Roll back code using the standard script.
3. Restore the fresh predeploy DB snapshot if migration rollback is needed.
4. Verify auth, Chat history, deterministic Chat message, cross-user denial, and portal metadata diagnostics.
