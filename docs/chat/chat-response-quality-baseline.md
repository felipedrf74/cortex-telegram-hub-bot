# Chat Response Quality Baseline

Date: 2026-04-29

## Baseline Interpretation

The current baseline is deterministic fixture evidence. It proves:

- the persona bank exists
- the scenario bank exists
- red-team scenarios are represented
- scoring dimensions are explicit
- fixture expectations can be run repeatedly
- live-only scenarios are marked partial instead of falsely passed

It does not yet prove:

- live provider wording quality
- production model routing behavior
- real streaming reconnect behavior
- real local-engine tool execution across every scenario
- real iOS rendering for every scenario transcript

## Quality Standards

A Chat response is sufficient when it:

- answers the actual request
- uses the right tenant/user context
- routes to the correct skill owner
- avoids guessing when context is weak
- asks a targeted clarification when needed
- requires confirmation before destructive actions
- reports action status and unresolved items
- explains important constraints or tradeoffs
- avoids stale memory as fact
- avoids leaking hidden/system/tool/provider context
- returns an iOS-compatible envelope

## Current Baseline Status

Fixture baseline: pass with partial live-only gates.

Partial scenarios:

- streaming interruption
- provider fallback
- operator-pinned model

These are not failures of the harness. They are honest evidence boundaries requiring `local_engine` or `real_provider` runs.

## Next Quality Gates

1. Run the fixture harness in CI.
2. Add local full-product engine evaluation mode.
3. Add bounded real-provider sample runs for fallback/operator-pin scenarios.
4. Feed redacted simulation transcripts into portal diagnostics.
5. Add iOS rendering smoke for scenario transcript payloads.
