---
name: grill-me
description: Interview Felipe relentlessly about a plan, design, or proposed change until every branch of the decision tree is resolved. One question at a time, each with a recommended answer. Use when Felipe says "grill me", "stress-test this plan", "challenge this design", or before producing a plan for a non-trivial change.
---

# Grill Me

Interview Felipe relentlessly about every aspect of this plan until we reach a
shared understanding. Walk down each branch of the design tree, resolving
dependencies between decisions one-by-one. For each question, **provide your
recommended answer** so Felipe can react to a concrete proposal rather than a
blank prompt.

## Rules

1. **One question at a time.** Wait for Felipe's answer before asking the
   next. Multi-question dumps collapse the decision tree.
2. **If a question can be answered by exploring the codebase, explore the
   codebase instead.** Don't ask Felipe what `engine/src/services/scheduler.ts`
   does — read it.
3. **Resolve dependencies first.** If question B's answer depends on
   question A, ask A. Don't surface B until A is settled.
4. **Recommend before asking.** "I'd default to X because Y. Confirm or
   override?" beats "What do you want?".

## Why this is the default before non-trivial planning

Misalignment is the most common failure mode. The longer it survives, the
more rework it triggers. Grilling at planning time costs one conversation;
grilling after a deploy costs a hostile re-QA round and possibly a rollback.

## When NOT to grill

- Trivial fixes (typo, single-line config flip).
- Operational tasks Felipe has already specified end-to-end (e.g. "deploy the
  branch you just verified to production").
- Information lookups that don't require a plan ("what's our APNs key ID?").

## Example

> User: "Add gzip middleware to the engine."
>
> Q1: "Mount on `/api/v1/*` only, or globally on the Express app? I'd default
> to `/api/v1/*` because the portal HTML routes are already small. Confirm?"
>
> [User: "/api/v1/*"]
>
> Q2: "Compression threshold — `compression()` defaults to 1KB. I'd raise to
> 2KB so we don't compress tiny health-check responses. Confirm?"

## Companion: grill-with-docs

If the grilling needs to update the project glossary or capture
hard-to-reverse decisions, use
[grill-with-docs](../grill-with-docs/SKILL.md) instead. It runs the same
loop but writes ADRs and updates `AGENT_TECHNICAL_MASTERY.md` inline.
