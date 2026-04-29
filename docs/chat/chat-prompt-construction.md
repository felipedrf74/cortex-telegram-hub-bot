# Chat Prompt Construction

Generated: 2026-04-29  
Branch: `feature/chat-tenant-safe-context-orchestration`

## Prompt Shape

Domain handlers continue to supply provider prompts through the existing provider-routing architecture. The new addition is a structured prompt block:

```xml
<chat_reasoning_context tenant_id="..." user_id="..." domain="..." budget_chars="...">
  <context_policy>...</context_policy>
  <intent ... />
  <context_item ...>...</context_item>
  <weak_context>...</weak_context>
</chat_reasoning_context>
```

## Policy Included In Prompt

The policy explicitly tells the model:

- Use only authorized context items and the separately supplied scoped conversation history.
- Never infer or reuse data from another tenant/workspace.
- Prefer fresh, high-confidence, source-attributed context.
- Treat stale or low-confidence facts as uncertain.
- Ask a focused question or call a tool when required context is missing.

## Budget Behavior

The prompt context engine uses a character budget and preserves critical context first:

- Current turn metadata.
- Ambiguous-follow-up conversation context.
- Explicit preferences relevant to the current request.
- Daily/shared-decision context when planning or multi-skill tradeoffs are involved.

Large items are truncated with a marker instead of silently overflowing.

## Provider Safety

Provider fallback receives the same `stateContext` string. This is covered by `provider-fallback-domain-routing.test.ts`, which verifies fallback provider calls receive the same scoped context block as primary provider calls.

## Tenant Metadata In Provider Calls

`CallDomainOptions` now carries optional `userId` and `tenantId`. The routing layer forwards them to concrete providers, and Gemini/OpenAI/Anthropic usage logging can persist tenant scope when the migration column exists.

## Non-Goals

- The prompt builder does not hardcode one model/provider.
- It does not create new memory facts automatically.
- It does not rely on frontend filtering for safety.
