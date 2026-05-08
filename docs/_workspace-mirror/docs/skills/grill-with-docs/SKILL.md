---
name: grill-with-docs
description: Grilling session that challenges Felipe's plan against the existing Nexus Hub domain model, sharpens terminology, and writes ADRs in docs/adr/ inline as hard-to-reverse decisions crystallise. Use when Felipe wants to stress-test a plan against documented decisions, or says "grill me and capture the decisions", "update the glossary as we go".
---

# Grill With Docs

Same loop as [grill-me](../grill-me/SKILL.md): interview Felipe relentlessly,
one question at a time, each with a recommended answer. **Add** an inline
documentation discipline so that decisions don't evaporate after the
conversation.

## What the conversation can produce

1. **Glossary updates** to `docs/agent/AGENT_TECHNICAL_MASTERY.md` when the
   conversation surfaces a domain term that's ambiguous, missing, or
   conflicts with existing usage.
2. **ADRs under `docs/adr/`** when a hard-to-reverse decision is made (see
   ADR criteria below).
3. **OPEN_ITEMS rows** for follow-up work that doesn't belong in this plan
   but mustn't be lost.

## During the session

### Challenge against the existing language

When Felipe uses a term that conflicts with `AGENT_TECHNICAL_MASTERY.md` or
an existing ADR, call it out immediately:

> "AGENT_TECHNICAL_MASTERY uses `working-set` to mean the union of active
> tasks across providers. You seem to mean the iOS-side cached snapshot —
> different concept. Should we sharpen one or both?"

### Sharpen fuzzy language

When Felipe uses vague or overloaded terms ("the user", "the cache", "the
plan endpoint"), propose a precise canonical term and lock it in.

### Discuss concrete scenarios

When boundaries are being discussed, stress-test with specific scenarios
that probe edges. "What if user 25's Microsoft refresh token mutates while a
working-set fetch is in flight?" forces precision.

### Cross-reference with code

When Felipe states how something works, check whether the code agrees. If
you find a contradiction, surface it: "You said the cache invalidates on
disconnect, but `oauth-store.ts:371` only calls
`invalidateMicrosoftAccessTokenCacheForUser` after `disconnectProvider` —
not after `updateAccessToken`. Which is right?"

### Update AGENT_TECHNICAL_MASTERY.md inline

When a term is resolved, update the file right there. Don't batch.

## ADR criteria — offer sparingly

Only offer to write an ADR when **all three** are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
   (schema, public API, security boundary, deploy topology).
2. **Surprising without context** — a future reader will wonder "why did
   they do it this way?".
3. **The result of a real trade-off** — there were genuine alternatives and
   a specific reason for the pick.

If any of the three is missing, skip the ADR. Use
[docs/adr/0000-template.md](../../adr/0000-template.md) as the format.

Examples that warrant an ADR:

- Token-zero rule (REST not chat for data reads).
- SQLite over Postgres for the engine.
- Single-user MSAL public-client flow for personal Microsoft accounts.

Examples that do NOT warrant an ADR:

- "Use SWR cache for `/plan/today`" — this is a routine perf fix, easily
  reversible.
- "Default Express compression threshold = 2KB" — easily reversible config.

## Output discipline

- ADRs created during the session are listed at the end of the conversation
  with their numbers.
- New / updated glossary terms are summarised at the end.
- A short "Decisions" block goes into the closeout doc if the work is large
  enough to need one.
