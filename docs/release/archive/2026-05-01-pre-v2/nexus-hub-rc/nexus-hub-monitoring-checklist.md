# Nexus Hub Production Monitoring Checklist

Generated: 2026-04-29

## Purpose

Use this checklist during and after production promotion of the Nexus Hub release candidate. Monitoring must be tenant-safe: no raw prompt, raw private message, provider token, private calendar body, finance details, or tenant-private content strategy should appear in logs or dashboards.

## Chat

- [ ] Chat creation failures.
- [ ] Message send failures.
- [ ] Chat history fetch failures.
- [ ] Stuck messages in sent/streaming/failed states.
- [ ] Duplicate user messages.
- [ ] Duplicate assistant messages.
- [ ] Retry conflicts or repeated retries.
- [ ] Tool-call failures.
- [ ] Skill-routing failures.
- [ ] Pending confirmation loss.
- [ ] Vague follow-up unresolved rate.
- [ ] Clarification rate.
- [ ] User correction rate.
- [ ] Response insufficiency rate if measured.
- [ ] Day-to-day simulation regressions in scheduled evaluations.

## Tenant, Security, And Privacy

- [ ] Tenant authorization failures.
- [ ] Cross-tenant access attempts.
- [ ] Unusual cross-tenant denial spikes.
- [ ] Retrieval/memory scope failures.
- [ ] Attachment access denials.
- [ ] Unauthorized tool-call attempts.
- [ ] Prompt-injection/security events.
- [ ] Admin/support diagnostic access audit entries.
- [ ] Any raw private content in logs.
- [ ] Any raw prompt/context leakage in logs.
- [ ] Provider token exposure signals.
- [ ] Sensitive finance/calendar/training/content details in error logs.

## Model Routing And Provider Use

- [ ] Provider selected per request.
- [ ] Model selected per request.
- [ ] Task tier selected: classify/chat/toolUse/tool-continuation/vision where applicable.
- [ ] Category tag.
- [ ] Domain/skill tag.
- [ ] Operator override applied or not.
- [ ] Fallback used or not.
- [ ] Fallback reason.
- [ ] Provider failure rate.
- [ ] Provider/model latency.
- [ ] Token/cost estimate where available.
- [ ] Runaway provider-call loops.
- [ ] Repeated retries.
- [ ] Unusually high classification volume.
- [ ] Unusually high tool-continuation volume.
- [ ] Anthropic emergency fallback activation if enabled.
- [ ] Invalid operator model pin attempts.
- [ ] Missing tenant/user scope metadata on model calls.

## Secretary And Agenda

- [ ] Secretary scheduling intent failures.
- [ ] Agenda item creation failures.
- [ ] Agenda update/move failures.
- [ ] Reflow failures.
- [ ] Compression failures.
- [ ] Unscheduled/no-valid-slot spikes.
- [ ] Reminder/follow-up creation failures.
- [ ] Source-skill feedback failures.
- [ ] Provider sync failures.
- [ ] Failed read-back verification.
- [ ] Duplicate agenda items.
- [ ] Stale canceled/superseded agenda items.
- [ ] Calendar cleanup attempts without exact provider IDs.

## Calendar Providers

- [ ] Google create/update/delete failures.
- [ ] Outlook create/update/delete failures.
- [ ] Provider auth/token refresh failures.
- [ ] Duplicate provider events.
- [ ] Stale provider events after cancellation.
- [ ] Provider event deleted externally but local state still active.
- [ ] Local item canceled but provider event still active.
- [ ] Cleanup left `[NEXUS SECRETARY STAGING]` or other test markers behind.
- [ ] Any broad date/title cleanup invocation.

## Training

- [ ] Training plan generation failures.
- [ ] Constrained/travel-week validation failures.
- [ ] Plan cancellation cleanup failures.
- [ ] Regeneration duplicate sessions/events.
- [ ] Missing scheduled/reflowed/unscheduled state.
- [ ] Feedback submission failures.
- [ ] Poor-recovery/weak-profile follow-up prompt errors.
- [ ] iOS Training rich payload decode/render errors.

## Shared Context

- [ ] Shared-context build failures.
- [ ] Stale context detection rate.
- [ ] Stale signal exclusion count.
- [ ] Duplicate warning suppression count.
- [ ] Cross-skill invalidation failures.
- [ ] Non-canonical tenant fail-closed counts.
- [ ] Unexpected empty shared-context blocks.
- [ ] Context source/freshness/confidence missing.
- [ ] Chat prompt context includes unauthorized or irrelevant context.
- [ ] Secretary shared-context inclusion failures.

## iOS

- [ ] iOS decode errors.
- [ ] iOS render errors.
- [ ] Chat list load failures.
- [ ] Message send/display failures.
- [ ] Retry/error UI regressions.
- [ ] Unknown message/block fallback regressions.
- [ ] Stale tenant cache after tenant/session change.
- [ ] Local backend override accidentally active in production smoke.
- [ ] "Could not reach Nexus Hub" reports correlated with backend health.
- [ ] Home/dashboard unavailable banner rate.
- [ ] Training/Secretary/Cooking/Finance/Content card render failures.

## Portal / Support

- [ ] Portal diagnostic access failures.
- [ ] Cross-tenant portal access attempts.
- [ ] Support/admin diagnostic reads without audit.
- [ ] Aggregate analytics exposing raw private content.
- [ ] Provider/model observability exposing prompt text.
- [ ] Quality diagnostics exposing raw message content unnecessarily.

## Infrastructure And Cleanup

- [ ] Backend service online.
- [ ] Worker queues online and not looping.
- [ ] Content engine online if required.
- [ ] Database migration errors.
- [ ] SQLite/Postgres lock or corruption warnings.
- [ ] Memory/CPU spikes.
- [ ] Port/tunnel leaks after smoke/deploy.
- [ ] Local fixture flags absent in production.
- [ ] Production provider keys not used in local smoke accidentally.

## Escalation Thresholds

Escalate immediately if:

- any cross-tenant data leak is confirmed,
- prompt/provider receives unauthorized tenant context,
- duplicate calendar events are created in production,
- Chat message send fails broadly,
- auth/session failures spike,
- provider-call loop or cost spike is detected,
- raw prompts/private content/provider tokens appear in logs.
