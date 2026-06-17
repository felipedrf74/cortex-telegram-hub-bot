# Nexus Hub Skills Catalogue

Status: canonical
Owner: workspace lead (Felipe)
Last verified: 2026-05-08
Update policy: update when a skill is added, retired, or renamed. Each skill
file under `docs/skills/<name>/SKILL.md` is the source of truth for its own
behavior — this index is the routing map.

A **skill** is a named, callable working pattern. Both Claude Code and Codex
should recognise the trigger phrases and follow the linked SKILL.md when the
user invokes one. Adapted from
[mattpocock/skills](https://github.com/mattpocock/skills) on 2026-05-08; kept
small and Nexus-flavored on purpose.

## When to reach for a skill

| You / Felipe says… | Reach for |
| --- | --- |
| "grill me", "stress-test this plan", "challenge my design" | [grill-me](grill-me/SKILL.md) |
| "grill me and capture the decisions", "update the glossary as we go" | [grill-with-docs](grill-with-docs/SKILL.md) |
| "diagnose this", "debug this", "why is X slow / failing / regressing?" | [diagnose](diagnose/SKILL.md) |
| "caveman", "be brief", "less tokens", any long-running handoff | [caveman](caveman/SKILL.md) |
| "zoom out", "give me the bigger picture", "I don't know this code" | [zoom-out](zoom-out/SKILL.md) |
| "prototype this", "throwaway", "let me play with it" | [prototype](prototype/SKILL.md) |
| "tdd", "red-green-refactor", "test-first" | [tdd](tdd/SKILL.md) |
| "improve architecture", "ball of mud", "deepen this module" | [improve-codebase-architecture](improve-codebase-architecture/SKILL.md) |
| "reward check", "RLVR", "verifiable rewards", "calibrate the loop", "handoff quality" | [verifiable-reward-check](verifiable-reward-check/SKILL.md) |
| "write a new skill", "add a skill for…" | [write-a-skill](write-a-skill/SKILL.md) |

## Defaults baked into our way of working

1. **Before producing a plan for a non-trivial change**, default to
   [grill-me](grill-me/SKILL.md). Misalignment caught at planning time costs
   one conversation; misalignment caught after implementation costs the whole
   round trip.
2. **Before debugging anything described as flaky / lag / regression**, follow
   [diagnose](diagnose/SKILL.md) Phase 1 (build a feedback loop) before
   speculating.
3. **For long Claude→Codex hand-off prompts**, prefer
   [caveman](caveman/SKILL.md) once context is established.
4. **When a hard-to-reverse decision crystallises** during grilling or
   architecture review, capture an ADR in `docs/adr/` (see
   [docs/adr/README.md](../adr/README.md)). Don't ADR ephemeral decisions.
5. **Before ending non-trivial Claude Code or Codex work**, run
   [verifiable-reward-check](verifiable-reward-check/SKILL.md) and summarize
   the verdict in the handoff/final answer. Score is secondary to hard
   failures and mandatory evidence.

## Catalogue

### Productivity

- **[grill-me](grill-me/SKILL.md)** — Relentless interview about a plan or
  design until every branch of the decision tree is resolved. One question at
  a time, with a recommended answer. Felipe's primary alignment tool.
- **[caveman](caveman/SKILL.md)** — Ultra-compressed communication mode. Cuts
  token usage ~75% by dropping filler. Auto-clarity exception for destructive
  ops and security warnings.
- **[write-a-skill](write-a-skill/SKILL.md)** — Create new skills with proper
  frontmatter, triggers, and progressive disclosure. Use when adding to this
  catalogue.

### Engineering

- **[grill-with-docs](grill-with-docs/SKILL.md)** — Grilling session that
  challenges the plan against `AGENT_TECHNICAL_MASTERY.md`, sharpens
  terminology, and writes ADRs in `docs/adr/` for hard-to-reverse decisions.
- **[diagnose](diagnose/SKILL.md)** — Disciplined diagnosis loop:
  reproduce → minimise → hypothesise → instrument → fix → regression-test.
  Phase 1 (build a feedback loop) is the actual skill.
- **[zoom-out](zoom-out/SKILL.md)** — Map of the relevant modules and callers
  at a higher abstraction level, using the project's domain glossary.
- **[prototype](prototype/SKILL.md)** — Throwaway code that answers a
  question. Logic branch (terminal app) for state/business-logic; UI branch
  (variant routes) for "what should this look like".
- **[tdd](tdd/SKILL.md)** — Vertical-slice red-green-refactor. Tests verify
  observable behavior through public interfaces, not implementation details.
  Mirrors the Nexus `__tests__/` rule: external APIs always mocked.
- **[improve-codebase-architecture](improve-codebase-architecture/SKILL.md)**
  — Find deepening opportunities. Surface modules that are shallow, leaky, or
  hard to test. Drives toward fewer, deeper modules with cleaner seams.
- **[verifiable-reward-check](verifiable-reward-check/SKILL.md)** — Apply the
  Nexus Verifiable Reward Loop before handoff. Orchestrates existing verifier
  evidence, classifies hard failures, records skipped checks, and decides
  whether a deliverable is `PASS`, `WARN`, `FAIL`, `MANUAL_REQUIRED`, or
  `NOT_APPLICABLE`.

## Skill format

Each skill lives at `docs/skills/<name>/SKILL.md` with YAML frontmatter
(`name`, `description` containing "Use when…" trigger phrases) followed by
the body. Skill bodies are kept under ~100 lines — additional reference
material splits into sibling files under the same directory. See
[write-a-skill](write-a-skill/SKILL.md) for the template.

## Relationship to AGENT_PROCESS_STANDARD

Skills are **callable patterns** — small, optional behaviors invoked on
demand. The
[Agent Process Standard](../agent/AGENT_PROCESS_STANDARD.md) is a
**non-optional governance baseline** — read-first list, evidence levels,
cleanup contract, hard non-negotiables. Skills sit on top of the standard,
not in place of it. Section 19 of the standard registers this catalogue.
