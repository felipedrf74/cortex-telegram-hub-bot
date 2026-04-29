# Chat Reasoning Quality Model

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Quality Target

Chat should feel useful in ordinary multi-turn product usage:

- It remembers relevant scoped context.
- It knows when context is weak.
- It avoids irrelevant private data.
- It uses the right skill context.
- It explains what it is basing a suggestion on.
- It asks targeted clarifying questions when acting would be unsafe.

## Guardrails Added

The context engine now detects:

- Ambiguous follow-ups like "move that" or "cancel that one".
- Memory recall like "what did we decide yesterday".
- Memory write candidates like "remember I prefer...".
- User corrections like "actually, I changed my mind".
- Tenant-boundary mentions like "that is for my other tenant".
- Planning/action references.

These signals do not force a canned answer. They shape context selection and weak-context guidance.

## Strong Context Behavior

When scoped recent context exists, Chat gets source-attributed conversation and memory context. This helps with:

- "Move that to Friday."
- "Cancel the plan we just created."
- "Use my normal content workflow."
- "Why are you suggesting this?"

## Weak Context Behavior

When context is missing or unsafe:

- The prompt includes a weak-context signal.
- The model is instructed to ask a targeted clarification.
- Tenant-boundary mentions are treated as requiring confirmation instead of silently reusing current-tenant memory.

## Remaining Evaluation Work

The service tests cover key primitives, and the deterministic day-to-day simulation harness is now implemented and passing. Remaining work is live/runtime expansion:

- Connect the harness to seeded local full-product runtime beyond deterministic fixtures.
- Run bounded real-provider samples before making live-provider quality claims.
- Prove streaming interruption/retry only if WebSocket streaming is enabled.
