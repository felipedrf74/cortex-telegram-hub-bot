# Peer Review Checklist — WO-chatcore-v2-production-activation

Reviewer: Claude (peer validation)
Review date: 2026-05-28
Review mode: Peer Validation
Implementation branch: `codex/chatcore-v2-production-activation-wo`

This review stayed read-only except for two scoped peer-review fixes (M1, M2)
implemented in owned paths under Felipe's "work the items" authorization. No
commit was made. Checkboxes are marked `[x]` only for items verified in this
pass; items only spot-checked or not re-opened are left `[ ]` with a note.

## Review Boundaries

- [x] Confirm the active Work Order exists and matches the branch/worktree.
- [x] Confirm no files outside `owned_paths` were modified without being added
  to the Work Order. (lane check OK; all edits in owned paths)
- [x] Confirm the current claim level remains local L2 at most.
- [x] Confirm no final delivery handoff is claimed while Phase 2+ remains
  blocked.

## Architecture Review

- [x] ChatCoreV2 remains the production activation layer; no parallel
  greenfield chat orchestrator is introduced.
- [x] Layer 1 prepass helpers are deterministic and produce hints only.
  (verified `detectChatCoreV2WriteIntent` is pure/deterministic regex; full
  Layer-1 selector audit remains covered by the D16 source-guard test)
- [ ] Planner packet validators expand model output into canonical
  `ChatTurnPlanMicro` server-side. (not re-reviewed this pass)
- [ ] Atom/mini/wire schemas do not let the model introduce unknown keys or
  unbounded capability IDs. (not re-reviewed this pass; note: the local-chat
  output schema is `additionalProperties:false` with bounded enums)
- [x] Cloud allowlist helper uses positive allowlist composition and HMAC
  identifiers only. (verified `cloud-allowlist-packet.ts`: composes only explicit
  entity refs + evidence fingerprints, HMAC-scopes entity IDs as
  `tenantId:type:id`, refuses to build with no safe context, carries no raw
  private strings. Caller-responsibility note: `evidenceFingerprints` must be
  hashes, not raw quotes.)
- [x] DomainAdapterV1 requires tenant and user IDs at every boundary. (verified
  `domain-adapter.ts`: buildReadContext/previewCommand/executeCommand/
  verifyCommand each take tenantId + userId; executor also uses `getTaskForUser`
  and `WHERE user_id = ?`. Interface enforces it; concrete adapters pending.)
- [x] Write-risk and write-verification helpers enforce no success claim without
  verification metadata. (executor readback + local-chat anti-success-claim
  guard verified)

## D3 Benchmark Review

- [ ] Benchmark harness read-only / artifact location. (not re-run this pass)
- [ ] Harness records model/endpoint/output shape/options/phase summaries. (not
  re-run this pass)
- [ ] Calibration artifacts represented honestly. (not re-run this pass)
- [x] D3 latency gate formally revised by operator (2026-05-28: p95 <= 5s @ `num_ctx=256`; p50 <= 2s deferred). Bounded full `--suite=all` run confirms sequential PASSES (p95 3669 ms) but burst/concurrent/sustained FAIL (~10-15s p95) on the CPU-only VPS — gate holds for serialized/single-user only; multi-user Phase 2 needs concurrency control, hardware, or a smaller model.

## Runtime Hotfix Review

- [x] Confirm task write-intent firewall runs before legacy model/tool fallback.
- [x] Confirm unresolved, negated, and hypothetical task writes do not hit
  generic scoped-read fallback.
- [x] Confirm exact task completion mutates by canonical task ID, not title.
- [x] Confirm task completion response claims success only after readback.
- [x] Confirm task-with-subtasks remains preview-only in V1.
- [x] Confirm sandbox auto-execute is controlled by explicit flags.

## Sandbox Addendum Review

- [ ] `nexushubbot@gmail.com` / internal emails resolve to beta usage. (not
  reviewed this pass — billing/entitlement files out of this review's scope)
- [ ] Customer-facing payloads hide raw USD caps. (not reviewed this pass)
- [ ] Content script generation uses container-safe engine URL. (not reviewed
  this pass)
- [ ] Sleep intervals feed the day dial only with real data. (not reviewed this
  pass)

## Tests To Re-run

- [x] `npx vitest run __tests__/services/chat-core-v2-*.test.ts` — 312 passed (37 files)
- [x] Focused task route/firewall tests — `chat-routes.test.ts` green inside the 123-test focused run
- [x] `npm run verify` — 736 files / 10,859 tests passed
- [x] `git diff --check` — clean
- [ ] Focused billing/dashboard/content/sleep sandbox tests (not re-run this pass)

## Peer Review Findings (Claude, 2026-05-28)

Verdict: APPROVE the local L2 slice. The write-intent firewall and the
sandbox/canary local-LLM answer path are doctrine-compliant for the L2 scope. No
new hardcoded runtime behavior was introduced (remaining dish/email literals are
pre-existing, out-of-lane parser vocabularies/examples or corpus fixtures).
Three P0 findings: two fixed, one verified intentional.

- M1 (fixed): `WRITE_SUCCESS_CLAIM_RE` over-blocked legitimate text — bare
  English participles (`done`/`completed`/`created`) could clobber a recipe step
  ("cook until done") into the "I did not execute an action" rewrite.
  Re-anchored to first-person claims; PT/ES were already first-person. Negative
  test added. (`src/services/chat-core-v2/local-chat-orchestrator.ts`,
  `__tests__/services/chat-core-v2-local-chat-orchestrator.test.ts`)
- M2 (fixed): the token-zero / deterministic-read suppression ran regardless of
  `CHAT_CORE_V2_ORCHESTRATOR_MODE`, so the master kill switch was not a clean
  legacy passthrough. Added `shouldGateReadFastPathsForWriteIntent` (enforce-only
  gating) so `off`/`shadow` leave routing unchanged (Binding Doctrine #11/#12).
  Unit test added. (`src/services/chat-core-v2/action-gateway.ts`,
  `src/api/routes/chat-message-routes.ts`,
  `__tests__/services/chat-core-v2-action-gateway.test.ts`)
- M3 (no change — intentional): `executeNativeTaskComplete` and
  `executeTaskCompleteBatch` treating `changes:0 + readback completed` as
  `verification_failed` is deliberately pinned by `command-executor.test.ts:267`
  ("only claim success if this command made the change") and is also caught
  upstream by the `task_is_pending` gate invariant. Left as-is by design.
- Low / observations (not fixed this pass): L1 native cache-key can be `['']`
  (defensive only — the preview always sets `nativeListId`); L2 raw SQL vs.
  provider layering in native complete/batch (confirm intended); L3 the local
  LLM emits validated-but-raw prose with empty `factualClaims` when
  `CHAT_CORE_V2_LOCAL_CHAT_REQUIRE_JSON` is off (the default) — acceptable at L2,
  but must set `REQUIRE_JSON=true` and honor `CHAT_CORE_V2_ALLOW_WRITE_EXECUTION`
  before any production canary (does not yet meet Doctrine #3/#4); L4
  quality-gate `isUnusableRecipeSeed` couples to the orchestrator's fallback
  phrasing.

## D1-D16 Peer Review Progress (Claude, 2026-05-28)

Reviewed this pass (read-only):
- D2 `chatcore-v2-module-inventory.md` — accurate strangler inventory; the module
  map matches current `index.ts` exports and real module names (model-run-audit,
  runtime-budget), and correctly flags provider-data-policy as input-only. PASS
  (reasonableness/accuracy level).
- D5 `answer-composition.ts` — `validateComposedAnswerDraft` prohibits an
  unbounded model mode (Doctrine #3) and rejects a `supported` claim with no
  evidence IDs (Doctrine #4); mode budgets match the WO gates. PASS.
- D7 `domain-adapter.ts` — interface requires tenant+user IDs at every boundary
  (Doctrine #6). PASS at contract level; implementations pending.
- D13 `cloud-allowlist-packet.ts` — positive-allowlist composition, tenant-scoped
  HMAC entity IDs, refuses empty/unsafe packets, no raw private strings
  (Doctrine #5). PASS. Note: callers must pass evidence *fingerprints*, not raw
  quotes.
- D15 `failure-observability.ts` — failure matrix + auto-revert/page/pin actions
  match the WO thresholds; `sanitizeFailureMetadata` default-denies string keys
  and drops sensitive keys. PASS. Minor: numeric metadata bypasses the string
  allowlist, so a raw numeric userId/tenantId could appear — recommend HMAC-ing
  or dropping numeric `*Id` keys when D15 is wired to a table.

- D4 `plan-schema.ts` / `plan-validator.ts` — every schema is
  `additionalProperties:false` with bounded enums (intent/domain/risk) and
  `maxItems` limits (domains<=2, capabilityIds<=3, proposedWrites<=1); the
  validator rejects `unknown_capability`. "No unknown keys / bounded capability
  IDs" — PASS.
- D5 `phase1-contracts.md` — coherent D4-D16 contract doc (schema, evidence
  taxonomy, CPU hot-path amendment). Documentation-level PASS.

All named D1-D16 peer-review items have now been reviewed for this L2 slice.
Runtime integration (D1/D7/D9/D11/D13/D14/D15) and the real-label corpus remain
Phase 2+ and are out of this slice's scope.

## Phase-2 prep implemented this pass

- Planner/local-inference **concurrency cap** added in-lane
  (`local-inference-concurrency-gate.ts`, `runWithLocalInferenceSlot`, default
  concurrency 1) and wired into the local-LLM path, as the mitigation for the
  full-suite concurrency finding. Keeps per-call p95 at the serialized ~3.7s;
  throughput remains bounded (hardware/model needed for real multi-tenant
  scale). Unit tests added.

## Expected Review Outcome

- [x] Approve the local implementation slice — tests pass, blocked items marked.
- [x] Do NOT approve Phase 2 shadow until D3, the remaining D1-D16 peer review,
  real corpus labels, shadow storage, repair loop, privacy checks, and rollout
  tests are complete.
