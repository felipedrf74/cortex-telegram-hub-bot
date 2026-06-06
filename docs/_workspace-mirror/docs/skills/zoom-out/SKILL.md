---
name: zoom-out
description: When unfamiliar with a section of code, give a higher-level map of the relevant modules and callers using the Nexus Hub domain glossary. Use when Felipe says "zoom out", "give me the bigger picture", "I don't know this code", or before diving into a refactor in an unfamiliar area.
---

# Zoom Out

When dropped into an unfamiliar area, don't grep deeper — go up a layer.

## What to produce

A short map of:

1. **Where this module sits** in the engine (e.g. "service-layer cache
   between OAuth store and Microsoft Graph").
2. **Who calls it** — direct callers and the user-visible surface area
   (`GET /api/v1/tasks/working-set` → `tasks-svc` → `microsoft-todo-adapter`
   → `microsoft-auth`).
3. **What it owns** vs. **what it delegates** — invariants that live here
   vs. invariants enforced upstream/downstream.
4. **Recent decisions** — relevant ADRs in `docs/adr/`, relevant entries in
   `docs/agent/AGENT_TECHNICAL_MASTERY.md`, last few `docs/archive/`
   closeouts that touched this area.

Use the project's domain glossary vocabulary. If the area uses a term that
isn't in `AGENT_TECHNICAL_MASTERY.md`, that's a finding — flag it for
[grill-with-docs](../grill-with-docs/SKILL.md) to capture.

## Tools to reach for

- `Explore` subagent for module-level traversal (read-only).
- `grep -rn "<symbol>" engine/src ios` for caller-direction queries.
- `git log --oneline -- <path>` for recent decision history.
- `docs/release/CURRENT_RELEASE_STATE.md` for current production truth.

## When to skip

You already know the area cold (recent closeout in your context, recent
hostile QA round on the same files). Don't perform zoom-out theatrically —
either you already have the map or you don't.
