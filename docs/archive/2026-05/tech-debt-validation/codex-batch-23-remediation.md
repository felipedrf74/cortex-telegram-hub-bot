# Codex Batch 23 Remediation

Status: current
Owner: Codex
Last verified: 2026-05-06
Update policy: archive-only remediation evidence; do not edit after Batch 23
closure.

## Verdict

**CLOSED / CONDITIONAL SKIPS HONORED.** Batch 23 merged the refreshed D5/F4
ratchet stack and Batch 22 S3 closure onto local `main`, then completed the
authorized Gemini SDK migration through Phase 4. T5 did not run because the
content-lifecycle authorization checkbox stayed off. T6 did not run because
Batch 21 R3 already closed the self-hosted-runner prerequisite documentation.

## Pre-flight

- Starting local `main`: `b2b7aa90`, post-Batch-21 R8 merge.
- Backup tag: `backup/tech-debt-2026-05-batch-23-before-20260506-2301`.
- `npx tsc --noEmit`: PASS.
- `npm run verify`: PASS, 467 files / 6971 tests.
- `content-engine/.venv313/bin/python -m pytest content-engine/tests/ -q`: PASS, 135 tests.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: PASS, 23/23.
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: PASS, 23/23.
- `npm run docs:audit`: PASS, 480 issues / 422 audited.

Authorized setup merges:

| Merge | Commit | Evidence |
|---|---:|---|
| Batch 22 S1 D5/F4 stack | `ef9b5e0b` | Strict mock lint passed after merge at 827 partial mocks / baseline 827. |
| Batch 22 S3 closure | `09d35547` | Batch 22 closure and retro Batch 20 report merged for audit-trail completeness. |

## Authorizations

Honored in this batch:

- `BATCH-23-D5-F4-MERGE-AUTHORIZED`.
- `BATCH-23-S3-CLOSURE-MERGE-AUTHORIZED`.
- `BATCH-23-GENAI-ADAPTER-EXPANSION-AUTHORIZED`.
- `BATCH-23-GENAI-MIGRATION-PHASE-3-AUTHORIZED`.
- `BATCH-23-GENAI-MIGRATION-PHASE-2-RETRY-AUTHORIZED`.
- `BATCH-23-GENAI-MIGRATION-PHASE-4-AUTHORIZED`.

Skipped authorization:

- `BATCH-23-CONTENT-LIFECYCLE-PHASE-1-AUTHORIZED` stayed unchecked, so T5 did
  not run.

The applied authorizations are recorded in the workspace `OPEN_ITEMS.md`
Standing authorizations section and mirrored into `docs/_workspace-mirror`.

## Branch Inventory

| Workstream | Branch | Tip / merge |
|---|---|---:|
| D5/F4 consolidation | local `main` setup merge | `ef9b5e0b` |
| Batch 22 closure merge | local `main` setup merge | `09d35547` |
| T1 adapter expansion | `feature/tech-debt-2026-05-t1-genai-adapter-expansion` | `7211a09b` |
| T2 mock migration | `feature/tech-debt-2026-05-t2-genai-mock-migration-phase-3` | `8d735e56` |
| T3 phase-2 retry | `feature/tech-debt-2026-05-t3-genai-phase-2-retry` | `a783d4d8` |
| T4 dependency removal | `feature/tech-debt-2026-05-t4-genai-phase-4-dependency-removal` | `ac8108e0` |
| T7 closure | `feature/tech-debt-2026-05-t7-batch-23-closure` | pending commit |

## T1 - Genai Adapter Surface Audit + Expansion

Verdict: **CLOSED.**

Files:

- `src/services/gemini-adapter.ts`.
- `__tests__/services/gemini-adapter.test.ts`.
- `docs/engineering/genai-migration-plan.md`.

Implemented:

- Added old-SDK-compatible aliases and types used by the provider:
  `GoogleGenerativeAI`, `Content`, `Part`, `FunctionDeclaration`,
  `FunctionCallingMode`, `SchemaType`, and `GenerateContentResult`.
- Preserved old response helpers over the `@google/genai` result:
  `response.text()`, `response.functionCall()`, `response.functionCalls()`,
  `response.candidates`, and `response.usageMetadata`.
- Kept the adapter thin: delegation remains
  `new GoogleGenAI({ apiKey }).models.generateContent(...)`.

Evidence:

- `npx vitest run __tests__/services/gemini-adapter.test.ts`: PASS, 5/5.
- `npx tsc --noEmit`: PASS.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: PASS, 23/23.

## T2 - Genai Mock Migration Phase 3

Verdict: **CLOSED.**

Files:

- `__tests__/services/gemini-provider.test.ts`.

Implemented:

- Moved provider tests from old SDK mocking to a `@google/genai` boundary mock
  at `GoogleGenAI.models.generateContent`.
- Preserved test behavior and assertions; no production files changed in T2.

Evidence:

- `npx vitest run __tests__/services/gemini-provider.test.ts`: PASS, 39/39.
- `node scripts/vi-mock-completeness-lint.mjs --strict`: PASS, 827 partial mocks / baseline 827.
- `npm run verify`: PASS, 467 files / 6973 tests.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: PASS, 23/23.

## T3 - Genai Migration Phase 2 Retry

Verdict: **CLOSED.**

Files:

- `src/services/gemini-provider.ts`.
- `__tests__/services/gemini-provider.test.ts`.
- `docs/engineering/genai-migration-plan.md`.

Implemented:

- Switched `src/services/gemini-provider.ts` from the old SDK import to
  `./gemini-adapter`.
- Kept provider behavior unchanged; assertions now inspect the
  `@google/genai` request boundary.
- Marked Phase 2 closed in the migration plan.

Evidence:

- `npx vitest run __tests__/services/gemini-provider.test.ts __tests__/services/gemini-adapter.test.ts`: PASS, 44/44.
- `npx tsc --noEmit`: PASS.
- Production-source import check: no `from '@google/generative-ai'` imports
  remain under `src/`.
- `npm run verify`: PASS, 467 files / 6973 tests.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: PASS, 23/23.

## T4 - Genai Migration Phase 4

Verdict: **CLOSED.**

Files:

- `package.json`.
- `package-lock.json`.
- `src/services/gemini-adapter.ts`.
- `scripts/test-gemini-ptbr.ts`.
- `__tests__/services/gemini-provider.test.ts`.
- `docs/engineering/genai-migration-plan.md`.

Decision: keep `src/services/gemini-adapter.ts`. It is not just import-path
indirection; it preserves the stable Nexus response-helper surface
(`text()`, `functionCalls()`, candidates, usage metadata) over Google's current
SDK boundary.

Implemented:

- Removed `@google/generative-ai` from `package.json` and `package-lock.json`.
- Removed the transitional old-SDK mock alias from `gemini-provider.test.ts`.
- Switched `scripts/test-gemini-ptbr.ts` to the adapter.
- Marked Phases 3 and 4 closed in `docs/engineering/genai-migration-plan.md`.

Evidence:

- `npm run verify`: PASS, 467 files / 6973 tests.
- `npx tsc --noEmit`: PASS.
- `npx vitest run __tests__/services/gemini-provider.test.ts __tests__/services/gemini-adapter.test.ts`: PASS, 44/44.
- TS/JS/package grep: zero `@google/generative-ai` hits outside
  `node_modules` and docs/history.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: PASS, 23/23.

## T5 - Content Lifecycle Phase 1

Verdict: **SKIPPED BY AUTHORIZATION CHECKBOX.**

The prompt's `BATCH-23-CONTENT-LIFECYCLE-PHASE-1-AUTHORIZED` marker remained
unchecked. No content lifecycle audit or source change was made.

## T6 - Self-hosted Runner Prereq Finalization

Verdict: **SKIPPED BY CONDITION.**

`docs/release/self-hosted-runner-prereqs.md` exists and Batch 21 R3 already
closed the documentation surface. No new provisioning or runner work was
performed.

## Final Verification

Final gates on T7 branch:

- `npx tsc --noEmit`: PASS.
- `npm run verify`: PASS, 467 files / 6973 tests.
- `content-engine/.venv313/bin/python -m pytest content-engine/tests/ -q`: PASS, 135 tests.
- `node scripts/vi-mock-completeness-lint.mjs --strict`: PASS, 827 partial mocks / baseline 827.
- `npm run docs:audit`: PASS, 480 issues / 423 audited.
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: PASS, 23/23.
- `bash scripts/workspace-docs-mirror.sh --check`: PASS, in sync.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: PASS, 23/23.

## Open Follow-ups

- Content lifecycle unification remains authorization-gated.
- Self-hosted runner provisioning remains operator-gated.
- iOS fastlane/TestFlight automation remains operator-gated.
- Operator-only items remain: signed TestFlight, APNs validation, OAuth
  credentials, Garmin MFA session, and Content portal smoke.
