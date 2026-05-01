# Nexus Hub Production Support Runbook

Generated: 2026-04-29

## Safety Rules

- Do not inspect raw private Chat content unless an explicit support policy, role, tenant permission, and audit path allow it.
- Do not copy provider tokens, raw prompts, private messages, calendar bodies, finance details, or tenant-private content into tickets or logs.
- Do not delete calendar events by date range or title.
- Do not bypass backend authorization with frontend filters.
- Preserve live model routing; do not hardcode a provider/model during support.

## Inspect Deployment State

1. Confirm running backend commit.
2. Confirm iOS release/build version.
3. Confirm production DB snapshot exists for the deploy.
4. Confirm migrations applied cleanly.
5. Confirm production health endpoint passes.

Suggested checks:

```bash
git rev-parse HEAD
pm2 status
curl -fsS https://nexushub.me/api/v1/health
```

## Diagnose "Could Not Reach Nexus Hub" On iOS

1. Check production health.
2. Check whether the simulator/device has stale local override settings.
3. For simulator/debug builds, clear local override keys:

```bash
xcrun simctl spawn booted defaults delete me.nexushub.app nexus_base_url || true
xcrun simctl spawn booted defaults delete me.nexushub.app nexus_allow_local_backend || true
xcrun simctl terminate booted me.nexushub.app || true
```

4. Relaunch against the intended backend.
5. If using local smoke, `scripts/full-nexus-local-engine.sh start` now launches the built Node server directly and verifies the backend PID after readiness. If a shell or CI environment still reaps detached jobs, use attached local runner mode (`scripts/full-nexus-local-engine.sh up`) while driving the simulator.

## Inspect A Chat Conversation

Use metadata first:

- conversation/message IDs
- user ID
- tenant ID
- lifecycle state
- created/updated timestamps
- provider/model metadata
- tool/skill call IDs
- error codes

Do not dump raw message text unless explicitly permitted and audited.

Support questions:

- Does the requesting user own or have permission for this conversation?
- Does the active tenant match the conversation tenant?
- Is the message stuck, failed, canceled, retried, or completed?
- Was a tool call pending confirmation?
- Was a fallback provider used?

## Inspect Tenant/User Ownership

For any Chat, memory, attachment, callback, tool, or agenda issue, verify:

- `tenant_id`
- `user_id` or owner user
- active authenticated user
- tenant membership/role
- source skill
- source entity
- lifecycle state

If ownership is ambiguous, fail closed and quarantine rather than broad-expose.

## Diagnose Chat Context Or Memory Issues

Check:

- context source
- freshness
- confidence
- scope: user-private, tenant-shared, admin, system/internal
- source skill/domain
- expiration/staleness metadata
- recent user corrections
- pending confirmations

Expected behavior:

- stale context should be marked stale or excluded,
- weak context should trigger clarification,
- tenant A memory must not appear in tenant B,
- provider fallback must receive the same scoped/safe context.

## Diagnose Tool Or Skill Calls

Before rerunning or retrying a tool:

1. Confirm authenticated user.
2. Confirm active tenant.
3. Confirm required permission.
4. Confirm resource ownership.
5. Confirm whether the action is destructive.
6. Confirm whether explicit user confirmation exists.
7. Check idempotency/client request IDs to avoid duplicate side effects.

For destructive actions, do not proceed from model output alone.

## Diagnose Secretary / Agenda Issues

Inspect:

- scheduling intent ID
- agenda item ID
- source skill
- source entity ID
- tenant/user owner
- lifecycle state
- scheduled start/end
- decision reason
- provider sync state
- external provider event ID
- version/supersession/cancellation metadata

Common cases:

- `unscheduled`: no valid slot or missing/low-confidence context.
- `reflowed`: item moved due to conflict/capacity change.
- `compressed`: item shortened to fit available capacity.
- `superseded`: old version replaced by a newer source intent.
- `failed_sync`: provider write/read-back failed.

## Diagnose Calendar Provider Issues

Never use broad date-range cleanup.

Check:

- provider type: Google or Outlook
- provider event ID
- Secretary agenda marker
- source intent ID
- latest provider sync attempt
- read-back result
- duplicate provider IDs for the same agenda item

If an event is stale:

1. Verify local agenda lifecycle state.
2. Verify exact provider event ID.
3. Delete/update only by exact event ID.
4. Record cleanup.
5. Run read-back verification.

## Diagnose Training Plan Issues

Check:

- active plan ID
- plan version
- session IDs
- session lifecycle states
- session shape hash if present
- agenda ownership rows
- cancellation/regeneration history
- rich payload fields returned to iOS

For cancellation/regeneration bugs:

- verify old sessions are inactive or removed from active views,
- verify no duplicate active agenda rows remain,
- verify provider events were cleaned by ownership mapping, not title/date.

## Diagnose Model Routing

For any AI response issue, inspect metadata rather than raw prompts:

- task tier: classify/chat/toolUse/tool-continuation/vision
- provider
- model
- category tag
- domain/skill
- operator override applied or not
- fallback used or not
- fallback reason
- latency
- token/cost estimate if available
- tenant/user scope metadata present

Do not force a single provider as a support workaround. Fix routing config or operator pinning through the intended model-config surfaces.

## Diagnose Response Insufficiency

Classify failure:

- wrong skill routing
- missing clarification
- hallucinated context
- stale memory
- insufficient action status
- missing confirmation
- unauthorized tool call attempt
- poor recovery after tool failure
- tenant-boundary confusion
- iOS rendering incompatibility
- provider fallback issue

Compare against:

- `docs/chat/day-to-day-simulation-results.md`
- `docs/chat/response-sufficiency-rubric.md`
- `docs/chat/chat-response-quality-baseline.md` if present

## Diagnose iOS Rendering Issues

Check:

- DTO decoding fallback for unknown enum/block/message type.
- Chat cache scope key.
- active user/tenant state.
- local backend override defaults.
- failed/retry/streaming state rendering.
- Secretary agenda state rendering.
- Training rich payload rendering.

If the app shows old data after tenant/session changes, invalidate local Chat cache for the scope and verify backend authorization still denies cross-tenant access.

## Rollback Procedure

Use `docs/release/nexus-hub-rollback-plan.md`.

Fast path:

1. Stop promotion if still in staging.
2. If production is live, roll back code first.
3. Restore DB snapshot only for confirmed migration/data corruption.
4. Verify health, auth, Chat history, safe Chat send, Home, tasks, Training, and calendar status.
5. Confirm no provider-call loop remains.
6. Confirm no raw private content appears in logs.

## Post-Incident Notes

After any incident, update:

- `docs/release/nexus-hub-risk-register.md`
- `docs/release/nexus-hub-open-blockers.md`
- relevant Chat/Secretary/Calendar/iOS runbook or test matrix
- monitoring thresholds if alerting was too noisy or too quiet
