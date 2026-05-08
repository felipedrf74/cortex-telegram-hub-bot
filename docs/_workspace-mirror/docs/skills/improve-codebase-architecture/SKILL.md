---
name: improve-codebase-architecture
description: Find deepening opportunities in the Nexus Hub codebase, informed by docs/agent/AGENT_TECHNICAL_MASTERY.md and ADRs in docs/adr/. Surface modules that are shallow, leaky, or hard to test, and propose refactors that turn them into deep modules. Use when Felipe wants to improve architecture, find refactor opportunities, consolidate tightly-coupled modules, or rescue a "ball of mud".
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** —
refactors that turn shallow modules into deep ones. The aim is testability
and AI-navigability.

## Glossary (use these terms exactly)

- **Module** — anything with an interface and an implementation (function,
  class, package, slice, route, repository).
- **Interface** — everything a caller must know to use the module: types,
  invariants, error modes, ordering, config. Not just the type signature.
- **Implementation** — the code inside.
- **Depth** — leverage at the interface: a lot of behaviour behind a small
  interface. **Deep** = high leverage. **Shallow** = interface nearly as
  complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered
  without editing in place. (Use this, not "boundary".)
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, knowledge
  concentrated in one place.

Key principles:

- **Deletion test**: imagine deleting the module. If complexity vanishes,
  it was a pass-through. If complexity reappears across N callers, it was
  earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

## Process

### 1. Explore

Read `docs/agent/AGENT_TECHNICAL_MASTERY.md` and any ADRs under
`docs/adr/` in the area you're touching first.

Then walk the codebase. Don't follow rigid heuristics — explore organically
and note where you experience friction:

- Where does understanding one concept require bouncing between many small
  modules?
- Where are modules **shallow** — interface nearly as complex as the
  implementation?
- Where have pure functions been extracted just for testability, but the
  real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts are untested, or hard to test through their current
  interface?

Apply the **deletion test** to anything you suspect is shallow. A "yes,
concentrates" is the signal you want.

### 2. Present candidates

A numbered list of deepening opportunities. For each:

- **Files** — which files/modules.
- **Problem** — why the current architecture is causing friction.
- **Solution** — plain English description of what would change.
- **Benefits** — explained in terms of locality, leverage, and how tests
  would improve.

Use `AGENT_TECHNICAL_MASTERY.md` vocabulary for the domain. If a candidate
contradicts an existing ADR, only surface it when the friction is real
enough to warrant revisiting the ADR. Mark it clearly: _"contradicts
ADR-0007 — but worth reopening because…"_. Don't list every theoretical
refactor an ADR forbids.

Do NOT propose interfaces yet. Ask Felipe: "Which of these would you like
to explore?"

### 3. Grilling loop

Once Felipe picks a candidate, drop into a
[grill-with-docs](../grill-with-docs/SKILL.md) conversation. Walk the
design tree — constraints, dependencies, the shape of the deepened module,
what sits behind the seam, what tests survive.

Side effects happen inline:

- Naming a deepened module after a concept not in
  `AGENT_TECHNICAL_MASTERY.md`? Add the term there.
- Sharpening a fuzzy term during the conversation? Update the glossary
  right there.
- Felipe rejects the candidate with a load-bearing reason? Offer an ADR if
  it's hard-to-reverse and surprising-without-context — otherwise don't.
- Want to explore alternative interfaces? Sketch them on paper / in chat
  before committing.

## Nexus examples of past architectural friction

- **Working-set duplicate Microsoft To Do reads** (closed in
  `perf-outlook-token-cache` round) — a route called
  `getAllPendingTasks()` which itself fetched all lists, then re-fetched
  the default list. The route already had list metadata. Fix: deepen the
  list-aware path so callers don't have to know about the inner refetch.
- **Microsoft auth token acquisition** — was a shallow "fetch on every
  call" path. Deepening into a cache + single-flight + client-type-memo
  module took ~120 LoC and removed ~13–23s of latency per call.

## Cadence

Run periodically — every few weeks or when:

- A round of perf or stability work surfaces "the test seam doesn't exist
  here" repeatedly.
- A bug fix requires editing more than ~5 files for what feels like a
  single concept.
- Felipe says "this code is hard to follow" or "I keep forgetting how this
  works".
