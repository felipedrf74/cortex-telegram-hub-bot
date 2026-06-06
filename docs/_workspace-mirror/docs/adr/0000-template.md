# ADR-0000: <Title>

Status: proposed | accepted | superseded by ADR-NNNN | deprecated
Decision date: YYYY-MM-DD
Decided by: workspace lead (Felipe) + <other agents involved>
Last verified: YYYY-MM-DD

## Context

What problem is this decision responding to? What is the situation,
constraint, or recurring friction that made a decision necessary?

Keep this short. A future reader should be able to read this paragraph and
understand why anyone bothered to write down a decision.

## Decision

The decision itself, in one or two sentences. Active voice. Concrete.

> Example: "Microsoft refresh tokens issued by the iOS Sign-In with
> Microsoft public-client flow are retried with `PublicClientApplication`
> after a single AADSTS90023 failure on the confidential-client path. The
> client-type is then memoised per cache key for the lifetime of the
> process."

## Alternatives considered

Genuine alternatives that were on the table, and why each was rejected.

If there were no real alternatives, this isn't an ADR — it's a
description.

- **Alternative A**: …. Rejected because….
- **Alternative B**: …. Rejected because….

## Consequences

What changes as a result of this decision?

- **Positive**: …
- **Negative**: …
- **Operational**: …

What does a future reader need to know to avoid relitigating this?

## Links

- Related code paths: `engine/src/services/microsoft-auth.ts:152`, …
- Closeout dossier (if any): `docs/archive/YYYY-MM/<workstream>/closeout.md`
- Superseded ADRs (if any): ADR-NNNN
- Superseding ADRs (if any): ADR-NNNN
