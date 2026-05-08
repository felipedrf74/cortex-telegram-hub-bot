---
name: prototype
description: Build a throwaway prototype to flush out a design before committing to it. Logic branch (terminal app) for state/business-logic questions; UI branch (variant routes / SwiftUI previews) for "what should this look like". Use when Felipe says "prototype this", "let me play with it", "try a few designs", "throwaway", or wants to sanity-check a state machine before spec'ing it.
---

# Prototype

A prototype is **throwaway code that answers a question**. The question
decides the shape.

## Pick a branch

Identify which question is being answered:

- **"Does this logic / state model feel right?"** → Logic branch. Build a
  tiny interactive Node script or terminal app that pushes the state
  machine through cases that are hard to reason about on paper.
- **"What should this look like?"** → UI branch. Several SwiftUI variants
  on a single feature-flagged route, switchable from the iOS Settings →
  Developer screen, or a `?variant=` query param on a portal HTML page.

The two branches produce very different artifacts — getting this wrong
wastes the whole prototype. If genuinely ambiguous, default to whichever
matches the surrounding code (a backend module → logic; a screen →
UI) and state the assumption at the top.

## Rules that apply to both

1. **Throwaway from day one, and clearly marked.** Locate the prototype
   close to where it'll actually live (next to the module or screen it's
   prototyping for) so context is obvious — but name it so a casual reader
   sees it's a prototype:
   - Backend: `engine/scripts/proto-<question>.mjs`.
   - iOS: a `_Prototype` suffix on the SwiftUI view, behind a debug
     feature flag, never linked from production navigation.
2. **One command to run.** `node engine/scripts/proto-<name>.mjs` for the
   logic branch; toggle a debug flag and re-run the iOS app for UI.
3. **No persistence by default.** State lives in memory or a clearly-named
   throwaway file (`./data/proto-<name>.json` — wipe me).
4. **Skip the polish.** No tests, no error handling beyond what makes it
   runnable, no abstractions. The point is to learn fast.
5. **Surface the state.** After every action (logic) or on every variant
   switch (UI), print or render the full relevant state so the question
   you're answering is visible.
6. **Delete or absorb when done.** Either delete the prototype or fold the
   validated decision into the real code. Never leave it rotting.

## When done

The **answer** is the only thing worth keeping. Capture it somewhere
durable:

- An ADR under `docs/adr/` if the decision is hard-to-reverse (use
  [grill-with-docs](../grill-with-docs/SKILL.md) ADR criteria).
- A line in the closeout doc otherwise.
- An OPEN_ITEMS row if the prototype surfaced a follow-up.

Then delete the prototype.

## Nexus examples

**Logic branch — "does the working-set merging logic correctly de-dupe
across providers?"**

```
engine/scripts/proto-working-set-merge.mjs
```

A 50-line script that synthesizes Google + Microsoft + native task lists
with overlapping IDs, runs the merge function, and prints the result.
Faster than spinning up the full server.

**UI branch — "should the Tasks tab show working-set or only the active
list by default?"**

Three SwiftUI variants behind `Debug.featureFlag(.tasksDefaultVariant)` —
switch via Settings → Developer, walk Felipe through each one. Decision
goes into an ADR or closeout note, then the dead variants are deleted.
