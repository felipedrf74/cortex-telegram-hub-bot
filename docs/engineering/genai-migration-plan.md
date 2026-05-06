# @google/genai Migration Plan

Status: canonical
Owner: backend architecture lead (Felipe)
Last verified: 2026-05-06 against `@google/genai` 1.52.0
Update policy: update when a migration phase lands or when Google's SDK API
surface changes.

## Scope

Nexus currently uses `@google/generative-ai` through
`src/services/gemini-provider.ts`. Batch 21 authorizes phase 1 only: add
`@google/genai`, create a compatibility adapter, and verify the adapter can
represent the current call patterns without changing production call sites.

## Phase 1 — Dependency And Shim

Status: in source branch.

- Add `@google/genai` pinned to the latest stable npm version verified on
  2026-05-06.
- Add `src/services/gemini-adapter.ts`.
- Preserve the old call shape:
  `new GoogleGenerativeAI(apiKey).getGenerativeModel(...).generateContent(...)`.
- Cover the top three Nexus call patterns: basic completion, JSON mode, and
  tool declarations.
- Do not switch `src/services/gemini-provider.ts` yet.

## Adapter Surface

Batch 23 T1 expands the shim to cover the old SDK surface that blocked the
first phase-2 probe:

- `GoogleGenerativeAI` remains available as an alias of the adapter class.
- `Content`, `Part`, `FunctionDeclaration`, `FunctionCallingMode`,
  `SchemaType`, and `GenerateContentResult` are exported with the old
  `@google/generative-ai` shapes used by `src/services/gemini-provider.ts`.
- Response helpers preserve the old method surface:
  `response.text()`, `response.functionCall()`, `response.functionCalls()`,
  `response.candidates`, and `response.usageMetadata`.

The adapter still delegates through `new GoogleGenAI({ apiKey })` and
`client.models.generateContent(...)`; the compatibility layer is limited to
type exports and the old response helper wrapper.

## Phase 2 — Provider Import Switch

Status: closed in Batch 23 T3 source branch.

- Switch `src/services/gemini-provider.ts` from `@google/generative-ai` to the
  compatibility adapter.
- Run the full provider fallback suite and model-routing regression suite.
- Keep the old dependency installed during this phase so rollback is one import
  change.

## Phase 3 — Mock Migration

Requires explicit authorization.

- Move Gemini tests from mocking `@google/generative-ai` to mocking
  `@google/genai`.
- Keep adapter-level tests as the boundary contract.
- Confirm mock completeness lint does not regress.

## Phase 4 — Old SDK Removal

Requires explicit authorization.

- Remove `@google/generative-ai`.
- Remove any adapter code that only exists for the old import surface.
- Re-run provider fallback, model routing, and live configurable routing gates.
