# Chat Model Routing Audit

Generated: 2026-04-29 01:55 WEST

## Executive Summary

Nexus Chat must remain provider-agnostic. This audit found that the codebase already has live provider-routing layers rather than a single hardcoded model:

- task-type routing: `classify`, `chat`, `tool-use`
- provider pair routing with primary/fallback providers
- domain provider routing
- per-provider model configuration
- per-domain model overrides in `model-config`
- environment and operator override surfaces
- circuit breaker and fallback metrics

This pass fixed a concrete routing bug: `TaskRoutingProvider` resolved domain-specific provider pairs but then discarded them when executing `callDomain` and `continueWithToolResults`. Domain overrides are now passed into the fallback executor.

## Runtime Architecture Observed

- `src/config.ts`: provider routing defaults and provider config.
- `src/services/provider-registry.ts`: provider instantiation, task routing provider factory, fallback event reporting.
- `src/services/provider-fallback.ts`: circuit breaker and fallback execution.
- `src/services/domain-provider-router.ts`: domain-specific provider selection.
- `src/services/model-config.ts`: model options and per-domain/provider override controls.
- `src/services/ai-provider.ts`: provider interface and model-routing helper.

## Important Constraint

Codex can use GPT-5.5-level reasoning for development, but Nexus production Chat must not be rewritten around a single provider or hardcoded GPT assumption. Release copy should describe the configurable routing architecture, not claim a fixed GPT runtime unless runtime config and logs prove that exact claim.

## Fixed Routing Bug

Before this pass:

- `resolveProviderPairForDomain(domain)` returned a domain-specific provider pair.
- `callDomain` and `continueWithToolResults` kept only `taskType`.
- `executeWithFallback` used `this.routing[taskType]`, so domain-specific provider overrides could be silently ignored.

After this pass:

- `executeWithFallback` accepts an optional `TaskProviderPair`.
- `callDomain` and `continueWithToolResults` pass the resolved domain pair.
- Regression test `__tests__/services/provider-fallback-domain-routing.test.ts` proves both initial domain calls and tool continuations use the resolved pair.

## Routing Risks Still Open

- Domain-routing comments and historical names should be cleaned up to match current provider strategy.
- Portal/operator override smoke was not run in this pass.
- Fallback routing must continue to avoid leaking tenant context in logs or provider prompts.
- Live model-call validation was not run here to avoid cost and unintended provider usage.

## Validation

- `npm test -- --run __tests__/services/provider-fallback-domain-routing.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/ai-provider-qa-validation.test.ts __tests__/services/domain-provider-router.test.ts`
- Result: 4 files passed, 95 tests passed.

