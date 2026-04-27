# Codex Training Second-Opinion Plan

Date: 2026-04-27
Owner: Codex
Branch: `feature/training-engine-codex-second-opinion`

## Safety Setup

| Item | Value |
|---|---|
| Starting branch | `main` |
| Starting commit | `a3f1b78a2dc543f285a14b2bdb9e5d602938d035` |
| Rollback branch | `backup/codex-pre-training-second-opinion-20260427-2246` |
| Rollback tag | `backup-codex-pre-training-second-opinion-20260427-2246` |
| Codex work branch | `feature/training-engine-codex-second-opinion` |
| Claude feature branch reviewed | `feature/training-engine-intelligence-and-agenda-overhaul` |
| Claude branch tip reviewed | `08273a4` on origin |
| Pre-Claude anchor found | `96c61fb` via `backup-training-engine-before-orchestration-overhaul-20260427-2003` |

No deployment or production push was performed.

## Execution Strategy

1. Audit the baseline engine separately from Claude's implementation.
2. Identify root causes for the known failures instead of accepting happy-path fixes.
3. Keep Claude work only where it is generalizable and production-worthy.
4. Patch the weak points on top of current main because Claude's branch was already merged into `main`.
5. Add focused tests around the actual failure modes and rerun full backend regression.
6. Leave a clear merge recommendation and open-items list.

## Targeted Codex Fix Areas

| Area | Codex action |
|---|---|
| Volume x time coherence | Add real sparse-session repair before falling back to duration shrink. |
| Strength variety | Preserve Claude's variant foundation but mark deeper split intelligence as still open. |
| Calendar lifecycle | Ensure sync/backfill records ownership, relinks ownership rows, and retries exact orphan deletion. |
| Cancellation/replacement | Run orphan reconciliation during the pre-persist cancellation saga. |
| Tests | Add regression tests for sparse strength repair, ownership relinking, orphan queue reconciliation, and route-level mocks. |
| Docs | Separate baseline audit, Claude review, Codex changes, open items, and merge verdict. |

## Non-Goals For This Pass

- No deployment.
- No UI changes.
- No API contract break.
- No special-casing Felipe, Jaqueline, a single exercise, or a single screenshot.
- No broad rewrite of the full coach kernel.
- No sex/gender-aware prescription without explicit user-provided inputs and a product policy layer.

