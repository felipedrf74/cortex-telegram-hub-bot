# ADR-0004: Engine domain folder authority

Status: accepted
Decision date: 2026-05-11
Decided by: workspace lead (Felipe) + Codex
Last verified: 2026-05-11

## Context

The engine currently has three domain-shaped homes: `src/services/`,
`src/skills/`, and `src/domains/`. The AI-agent-friendly codebase review
confirmed this makes ownership unclear: some `domains/` files are tiny stubs,
`skills/` is cleanly foldered around prompts and toggles, and most real domain
behavior lives in the flat `services/` directory.

## Decision

`engine/src/services/<domain>/` is the authoritative bounded-context home for
engine domain code. `engine/src/skills/<domain>/` is the prompt-and-toggle home.
`engine/src/domains/` is dispatch-only and should contain only tiny stubs, or be
removed if a future grep proves it has no remaining dispatch role.

## Alternatives considered

- **Make `src/domains/` the full domain home**: Rejected because most real code
  and tests already depend on service modules; moving everything there would be
  a broad rewrite before the codebase has dependency-direction lint.
- **Keep the current three-headed model**: Rejected because it leaves agents
  unable to infer ownership or test scope from file location.
- **Make `src/skills/<domain>/` own all domain code**: Rejected because skills
  are runtime toggles, prompt metadata, and sub-skill configuration, not the
  deterministic business-logic layer.

## Consequences

- **Positive**: Future moves have a single destination and can be staged
  domain-by-domain without relitigating folder ownership.
- **Negative**: Existing imports will remain mixed until the approved
  move-only plan is executed in separate PRs.
- **Operational**: Dependency-direction lint should protect the new convention:
  utilities do not import services, services do not import API routes, and API
  route modules are not imported from outside the API layer.

## Links

- Related code paths: `engine/src/services/`, `engine/src/skills/`,
  `engine/src/domains/`
- Architecture review:
  `docs/archive/2026-05/ai-agent-friendly-codebase-review/report.md`
- Codex validation addendum:
  `docs/archive/2026-05/ai-agent-friendly-codebase-review/codex-validation.md`
