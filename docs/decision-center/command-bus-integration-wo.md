# WO-UNBLOCK — Decision Center → Chat Core v2 Command Bus adapter (flag-gated, OFF by default)

Status: coordination Work Order (unblocks plan Phases 3–5). Owner: Decision Center (Claude); requires Codex sign-off on the API assumptions before any flag flip.

## Why this exists
The plan's Command Bus convergence (Phases 3–5) was "blocked" only because `src/services/chat-core-v2/**` is owned by Codex's in-flight activation WO. It is **not** actually blocked: the Command Bus is committed on `main` and already exposes a first-class Decision Center seam. The unblock is a Decision-Center-side **adapter** that *calls* the committed bus API (never edits it), behind a default-OFF feature flag. Cutover (flag flip + deleting legacy executors) is a separate, gated step after Codex confirms the assumptions below.

## Confirmed committed seam (read at chat-core-v2 base `6ee83074`)
- `command-bus.ts`: `findCommandCapability(envelope)`, `evaluateChatCoreV2CommandBusGate(envelope, snapshot, 'preview'|'execute')`, `CHAT_CORE_V2_COMMAND_BUS_GATE_VERSION`, gate snapshot/verdict types.
- `command-executor.ts`: `executeChatCoreV2Command({command, capabilityId, userId, tenantId, locale?, now?})` — re-evaluates the EXECUTE gate internally, records `chat_v2_command_events`, and for `decision_center.dismiss` **already calls back into `../decision-center` (`dismissDecision`, `getDecisionItem`)**. This proves the import direction adapter→executor→decision-center is live and acyclic-safe.
- `capability-registry.ts`: `decision_center.dismiss` is **already registered** (execute=supported, requiredPermissions `['decision_center:read','decision_center:write']`, undo `decision_center.restore`). Plus `getChatCoreV2Capability`, `isChatCoreV2CapabilityEnabled`.

## Owned paths (this WO may edit)
- `src/services/decision-command-adapter.ts` (NEW — sole new owner)
- `src/services/runtime-flags.ts` (ADD one reader `isDecisionCenterCommandBusEnabled`; no chat-core fns touched)
- `src/services/decision-center.ts` (ADD lazy adapter call inside `executeDecisionAction` + optional `DecisionActionResult.choiceRequired`)
- `src/api/routes/decisions.ts` (expected no change — passthrough)
- `src/portal/decision-center-routes.ts` (optional 1-line `choiceRequired` passthrough — confirm with Felipe)
- `__tests__/services/decision-command-adapter.test.ts`, `__tests__/services/decision-center-command-bus-equivalence.test.ts` (NEW)

**Explicitly NOT owned (read/call only, must remain byte-identical):** all of `src/services/chat-core-v2/**`.

## Implementation outline (flag-gated OFF)
1. **S1** — `isDecisionCenterCommandBusEnabled(env, scope)` (flag `DECISION_CENTER_COMMAND_BUS_ENABLED`, default OFF, scoped per user/tenant). New `decision-command-adapter.ts`: `ADAPTER_VERSION`, `DECISION_ACTION_TO_CAPABILITY` (`dismiss`/`not_now`/`reject_reflow` → `decision_center.dismiss`), `isDecisionActionBusEligible`, `buildDecisionCommandEnvelope` (origin `decision_center`). Pure, unit-testable.
2. **S2** — in `executeDecisionAction`, guard at top: if flag-enabled && eligible → `runDecisionActionViaCommandBus(...)` (build envelope → `executeChatCoreV2Command` → `getDecisionItem` read-back → translate to the legacy 4-field `{readBackOk, expectedEffect, actualEffect, message}`); else legacy path **byte-identical**. Map bus rejections to existing `DecisionActionError` codes (`expired`→DECISION_ACTION_EXPIRED, `stale_entity_version`/`decision_version_changed`→DECISION_SUPERSEDED, `invariant_failed`/`missing_delegated_scope`→DECISION_ACTION_NOT_ALLOWED, else→DECISION_ACTION_FAILED; `verification_failed`→DECISION_READBACK_MISMATCH).
3. **S3** — `choose_priority` is a choice flow: first POST returns `choiceRequired{commandId, expiresAt, options}` **without mutating**; the chosen option triggers a fresh preview+execute (no stale-envelope reuse).
4. **S4** — retry/reconnect via the bus pending-commands map (idempotency key == the decision action idempotency key); double-submit → single mutation + idempotent result.
5. **S5** — verify gate: `tsc` + `vitest` green; `git diff --name-only` shows ZERO `chat-core-v2/**` edits; equivalence suite (flag ON==OFF for dismiss).

**Cycle mitigation:** `decision-center.ts` imports the adapter **lazily** (function-level `require`) so the adapter→executor→decision-center chain never forms an eager top-level cycle.

## API assumptions — CONFIRM WITH CODEX BEFORE ANY FLAG FLIP
1. `evaluateChatCoreV2CommandBusGate`/`executeChatCoreV2Command` do **not** enforce `actingSurface`; `origin:'decision_center'` stays accepted on execute.
2. The executor's executable-command set (incl. `decision_center.dismiss`) stays the source of truth (preview-route's private `EXECUTABLE_CAPABILITIES` gates only preview).
3. `decision_center.dismiss` keeps its capabilityId/commandType, `support.execute='supported'`, and required permissions.
4. `decisionDismissVersionForItem` hash inputs stay stable (else spurious `decision_version_changed` rejections).
5. The `CommandStatus` values the mapping table consumes (`verified`/`verification_failed`/`failed`/`rejected_by_policy`/`expired`/`stale`) aren't removed/renamed.
6. `chat_v2_command_events` keeps accepting domain/origin `decision_center` and the executor keeps emitting for that origin.

## Cutover checklist (only after assumptions 1–6 confirmed; flag flips are config, not code deploys)
- [ ] Land this WO with the flag unset everywhere (verify default OFF in staging + prod).
- [ ] `tsc` clean; `vitest` green; `git diff --name-only 6ee83074..HEAD -- src/services/chat-core-v2` EMPTY (hard gate).
- [ ] Equivalence suite green (flag ON==OFF for dismiss).
- [ ] Codex confirms assumptions 1–6 in writing on the PR.
- [ ] Enable flag for Felipe's tenant only, in staging; `staging-smoke.sh` 17/17 + manual dismiss + `choose_priority` preview.
- [ ] Soak 24h; verify `chat_v2_command_events` rows have origin `decision_center` + verified status; no orphaned `started` rows in DC `action_executions`.
- [ ] Promote to prod, flag still tenant-scoped to Felipe; watch `error_log`/`decision_quality_gate_events` 48h.
- [ ] Widen flag scope only after clean soak (config change, not code deploy).
- [ ] Rollback = unset `DECISION_CENTER_COMMAND_BUS_ENABLED` (instant fall-back to legacy executors; no schema rollback — no migration added).

## Sequencing
Independent of Foundation/API-v2/Intelligence: this only changes the mutate path behind a default-OFF flag and adds no columns/migrations. The single shared file is `decision-center.ts` (`executeDecisionAction`) — coordinate that edit with the Foundation track if both touch it in the same window.
