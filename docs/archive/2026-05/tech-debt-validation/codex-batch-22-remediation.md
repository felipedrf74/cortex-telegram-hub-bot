# Codex Batch 22 Remediation

Status: current
Owner: Codex
Last verified: 2026-05-06
Update policy: archive-only remediation evidence; do not edit after Batch 22
closure.

## Verdict

**PARTIAL.** S1 closed the D5/F4 ratchet refresh using the authorized secondary
source and target-reset rules. S2 stopped correctly: switching
`gemini-provider.ts` to the Batch 21 adapter exposes adapter type-surface gaps
and makes the existing provider tests call the real `@google/genai` client
because Phase 3 mock migration is not authorized. S3 closes the audit trail with
this report and a retroactive Batch 20 report.

## Pre-flight

- Starting local `main`: `b2b7aa90`, post-Batch-21 R8 merge.
- Backup tag: `backup/tech-debt-2026-05-batch-22-before-20260506-2226`.
- `npx tsc --noEmit`: PASS.
- `npm run verify`: PASS, 467 files / 6971 tests.
- `content-engine/.venv313/bin/python -m pytest content-engine/tests/ -v`: PASS, 135 tests.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: PASS, 23/23.
- `bash scripts/cannot-skip-gate-dashboard.sh --json --no-evidence`: PASS, 23/23.
- `npm run docs:audit`: 483 issues / 420 audited.

Note: the prompt's Python command used `tests/` from the engine root. The
correct project-relative path is `content-engine/tests/`; the root `.pytest_cache`
created by the mistaken command was removed before docs audit.

## Authorizations

Honored in this batch:

- `BATCH-22-Q3-DIAGNOSIS-AUTHORIZED`.
- `BATCH-22-GENAI-MIGRATION-PHASE-2-AUTHORIZED`.
- `BATCH-22-Q3-SECONDARY-SOURCE-AUTHORIZED`.
- `BATCH-22-RETRO-BATCH-20-REPORT-AUTHORIZED`.

The authorizations are recorded in the workspace `OPEN_ITEMS.md` Standing
authorizations section and mirrored into `docs/_workspace-mirror`.

## S1 - D5/F4 Ratchet Resolution

Verdict: **CLOSED.**

Diagnosis branch: **A - rebase conflicts beyond the original allowed set**.
The Batch 20 Q3 source-of-truth was reconstructed from secondary references.
The documented stop reason was: D5 rebase conflicts in workspace mirror /
release identity docs.

Refined conflict handling:

- `docs/_workspace-mirror/docs/agent/AGENT_PROCESS_STANDARD.md`: resolved with current-main values.
- `docs/_workspace-mirror/docs/release/release-identity.json`: resolved with current-main values.
- `docs/_workspace-mirror/docs/release/release-identity.md`: resolved with current-main values.
- No `src/**` source conflicts occurred.

Branch results:

| Branch | Tip | Result |
|---|---:|---|
| `feature/tech-debt-2026-05-d5-mock-factories` | `16d05f1b` | Rebased onto Batch 22 main and refreshed strict baseline to the measured post-Batch-21 count. |
| `feature/tech-debt-2026-05-f4-mock-ratchet-stack` | `5d1a722b` | Rebased onto refreshed D5 and reset the ratchet target with `max(600, 842 - 15) = 827`. |

Mock baseline:

- D5 measured baseline after refresh: 842 partial mocks.
- F4 target after authorized reset: 827 partial mocks.
- F4 actual after ratchet: 827 partial mocks.
- Tags: `refreshed/d5-mock-factories-20260506`,
  `refreshed/f4-mock-ratchet-stack-20260506`.

Evidence:

- `node scripts/vi-mock-completeness-lint.mjs --strict --top`: PASS, 827 partial mocks against baseline 827.
- `npx tsc --noEmit`: PASS.
- `npx vitest run __tests__/security/p0-chat-identity-isolation.test.ts`: PASS, 23/23.
- `npm run verify`: PASS, 467 files / 6971 tests.

## S2 - Genai Migration Phase 2

Verdict: **BLOCKED.**

Attempted change: switch `src/services/gemini-provider.ts` from
`@google/generative-ai` to `src/services/gemini-adapter.ts`, keeping call sites
otherwise unchanged.

Stop rules triggered:

- S2 stop rule 11: tests failed after migration.
- S2 stop rule 12: TypeScript compilation failed after migration.

Observed failures:

- `npx tsc --noEmit`: failed with adapter type-surface mismatches:
  `usageMetadata` inferred as `{}`, `functionCalls()` returns `unknown[]`,
  local `Content` role typing did not match, and `candidates` indexing lost the
  old SDK shape.
- Focused provider suite:
  `npx vitest run __tests__/services/gemini-provider.test.ts __tests__/services/gemini-adapter.test.ts __tests__/services/provider-fallback.test.ts __tests__/services/model-routing-local-smoke.test.ts`
  failed because `__tests__/services/gemini-provider.test.ts` still mocks
  `@google/generative-ai`. After the provider import switch, the test path uses
  the real `@google/genai` adapter and attempts a live call with the fake test
  key. Result: 34 failed / 39 tests in `gemini-provider.test.ts`; the other
  three focused files passed.

No S2 commit was created. The failed probe was reverted before S3 so the
closure branch remains documentation-only.

Recommended Batch 23 scope:

1. Authorize Genai Phase 3 before retrying Phase 2, or explicitly broaden Phase
   2 to include provider-test mock migration.
2. Update `__tests__/services/gemini-provider.test.ts` to mock the adapter or
   `@google/genai` boundary.
3. Either widen `gemini-adapter.ts` to export old-SDK-compatible types/enums or
   create a local compatibility type module used by the provider.
4. Re-run Phase 2 after the mock/type boundary is explicit.

## Retroactive Batch 20 Closure Report

Batch 22 wrote
`docs/archive/2026-05/tech-debt-validation/codex-batch-20-remediation.md`
under `BATCH-22-RETRO-BATCH-20-REPORT-AUTHORIZED`.

Source references:

- `docs/archive/2026-05/tech-debt-validation/codex-batch-21-remediation.md`.
- `docs/_workspace-mirror/docs/release/OPEN_ITEMS.md`.

Reconstruction limits:

- Q1, Q2, and Q4 branch SHAs were recoverable from branch tips and merge
  history.
- Q3's specific commit SHA was not recoverable from secondary sources; it is
  recorded as unknown.

## Audit Trail Discrepancy

The original Batch 20 prompt required a closure report at
`docs/archive/2026-05/tech-debt-validation/codex-batch-20-remediation.md`.
The Q4 branch did not contain it. Batch 22 documents this as a process gap
rather than fabricating the original artifact. Future closure branches should
stage and commit the remediation report before being considered done.

## Branch Inventory

| Workstream | Branch | Tip / status |
|---|---|---:|
| S1 D5 refresh | `feature/tech-debt-2026-05-d5-mock-factories` | `16d05f1b` |
| S1 F4 refresh | `feature/tech-debt-2026-05-f4-mock-ratchet-stack` | `5d1a722b` |
| S2 Genai phase 2 | `feature/tech-debt-2026-05-s2-genai-migration-phase-2` | BLOCKED, no commit |
| S3 closure | `feature/tech-debt-2026-05-s3-batch-22-closure` | this report branch |

## Open Follow-ups

- Batch 23: Genai Phase 3 / provider-test mock migration, then retry Phase 2.
- Batch 23 or 24: Genai Phase 4 after Phase 2 and Phase 3 are green.
- Content lifecycle unification phase 1 remains authorization-gated.
- Self-hosted runner remains operator/infra-gated.
- iOS fastlane remains operator-gated.

