---
name: write-a-skill
description: Create new Nexus Hub skills under docs/skills/<name>/SKILL.md with proper frontmatter, triggers, and progressive disclosure. Use when Felipe wants to add a new callable working pattern to the catalogue, says "write a skill for…", or wants to formalise something we keep doing ad-hoc.
---

# Writing a Skill

## Process

1. **Gather requirements.** Ask Felipe:
   - What task / pattern does the skill cover?
   - What specific situations should trigger it?
   - Does it need executable scripts or just instructions?
   - Any reference material to bundle?

2. **Draft the skill.**
   - `docs/skills/<name>/SKILL.md` — the main file.
   - Sibling reference files if SKILL.md exceeds ~100 lines.
   - Utility scripts under `docs/skills/<name>/scripts/` only when a
     deterministic operation is needed.

3. **Review with Felipe.** Present the draft and ask:
   - Does this cover your use cases?
   - Anything missing or unclear?
   - Should any section be more / less detailed?

4. **Register in the catalogue.** Add a row to
   [docs/skills/SKILLS_INDEX.md](../SKILLS_INDEX.md):
   - "When to reach for a skill" trigger row.
   - Catalogue entry (productivity vs engineering bucket).

## Skill structure

```
docs/skills/<name>/
├── SKILL.md           # Main instructions (required)
├── REFERENCE.md       # Detailed docs (only if needed)
├── EXAMPLES.md        # Usage examples (only if needed)
└── scripts/           # Utility scripts (only if needed)
```

## SKILL.md template

```md
---
name: <skill-name>
description: <what it does>. Use when Felipe says "<trigger 1>", "<trigger 2>", or <situational trigger>.
---

# <Skill Name>

## Quick start

[Minimal working example — what to actually do when triggered]

## Workflow

[Step-by-step process with checklists for complex tasks]

## When NOT to use

[Negative-space — situations that look like a fit but aren't]

## Nexus-specific notes

[References to AGENT_PROCESS_STANDARD §X, ADRs, file paths if applicable]
```

## Description requirements

The description is **the only thing the agent sees** when deciding which
skill to load. It's surfaced in the system prompt alongside all other
installed skills.

**Format**:

- Max ~1024 chars.
- First sentence: what the skill does.
- Second sentence: "Use when Felipe says…" with concrete trigger phrases.
- Third (optional): situational triggers (e.g. "or before producing a
  plan for a non-trivial change").

**Good**: "Disciplined diagnosis loop for hard bugs and performance
regressions on Nexus Hub backend, iOS, or content engine. Reproduce →
minimise → hypothesise → instrument → fix → regression-test. Use when
Felipe says 'diagnose this' / 'debug this', reports a bug, says something
is broken/throwing/failing, or describes a performance regression."

**Bad**: "Helps with bugs."

## When to add scripts

Add utility scripts only when:

- The operation is deterministic (validation, formatting, env probe).
- The same code would be generated repeatedly otherwise.
- Errors need explicit handling.

Scripts save tokens and improve reliability vs generated code.

## When to split files

Split into separate files when:

- SKILL.md exceeds ~100 lines.
- Content has distinct domains (logic-prototype vs UI-prototype).
- Advanced features are rarely needed — push them to a sibling
  `REFERENCE.md`.

## Review checklist

After drafting:

- [ ] Description includes "Use when…" with concrete triggers.
- [ ] SKILL.md under ~100 lines (split if longer).
- [ ] No time-sensitive info (model versions, current commits — those go
      in `docs/release/CURRENT_RELEASE_STATE.md`).
- [ ] Consistent terminology with `AGENT_TECHNICAL_MASTERY.md`.
- [ ] Concrete Nexus-flavored examples.
- [ ] References go one level deep (don't deep-link into other skills'
      sub-files).
- [ ] Catalogue updated in `docs/skills/SKILLS_INDEX.md`.
