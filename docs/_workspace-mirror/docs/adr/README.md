# Architecture Decision Records (ADRs)

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-05-08
Update policy: never delete or edit history of an ADR. Supersede with a
new one and link both directions.

## What an ADR is

An ADR captures a single hard-to-reverse architectural decision and the
trade-off behind it, so a future reader (Claude / Codex / Felipe in 6
months) understands **why** the system looks the way it does.

## When to write one

Only when **all three** are true:

1. **Hard to reverse.** Schema, public API, security boundary, deploy
   topology, provider routing rule, tenant-isolation invariant.
2. **Surprising without context.** A future reader will wonder "why did
   they do it this way?".
3. **The result of a real trade-off.** Genuine alternatives existed and a
   specific reason drove the pick.

If any of the three is missing, **don't write an ADR**. Capture the
decision in the closeout doc, an OPEN_ITEMS row, or a comment in the
relevant skill / standard instead.

## Examples that warrant an ADR

- Token-zero rule (REST not chat for data reads).
- Single-user MSAL public-client flow for personal Microsoft accounts.
- SQLite over Postgres for the engine.
- iOS `aps-environment = production` for TestFlight builds.

## Examples that do NOT warrant an ADR

- "Use SWR cache for `/plan/today`" — routine perf fix, easily reversible.
- "Default Express compression threshold = 2KB" — easily reversible
  config.
- "Bumped vitest to 1.6.x" — dependency upgrade, not an architectural
  decision.

## Format

See [0000-template.md](0000-template.md). Copy it for each new ADR. Number
sequentially, lowercase-kebab-case the title:

```
docs/adr/0001-token-zero-rule.md
docs/adr/0002-msal-public-client-fallback.md
docs/adr/0003-...
```

## Lifecycle

ADRs have one of four statuses (set in the file's header):

- `proposed` — under discussion, not yet decided.
- `accepted` — decided and in force.
- `superseded by ADR-NNNN` — replaced; the replacement links back.
- `deprecated` — no longer in force, but kept for history.

**Never delete an ADR.** Supersede with a new one that explains why the
prior decision is no longer right, and link in both directions.

## Where ADRs interact with skills

- [grill-with-docs](../skills/grill-with-docs/SKILL.md) writes ADRs
  inline as decisions crystallise.
- [improve-codebase-architecture](../skills/improve-codebase-architecture/SKILL.md)
  checks ADRs before suggesting refactors and can supersede an ADR if
  friction has changed.
- [diagnose](../skills/diagnose/SKILL.md) cross-references ADRs in
  Phase 1 to avoid relitigating decisions during a bug hunt.
