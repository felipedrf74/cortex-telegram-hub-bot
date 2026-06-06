// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * R4 P2 fix — centralized reflow response serializer.
 *
 * Codex caught (R4 P2 #7) that the C6 reflow endpoint built its
 * response shape in two separate spots:
 *
 *   1. Happy path:
 *        sendSuccess(res, { ...result, scenario, perActionResults });
 *
 *   2. Idempotency-conflict replay (the deduped second apply):
 *        sendSuccess(res, {
 *          mode: 'apply',
 *          adaptationId: existing.id,
 *          adaptationRevision: existing.adaptation_revision,
 *          alreadyExisted: true,
 *          mutated: false,
 *          mutatedRows: 0,
 *        });
 *
 * The conflict-replay branch silently dropped `scenario`, `perActionResults`,
 * `mode` semantics, and `sciencePolicyVersion`. iOS consuming the apply
 * response got a half-payload on retry, which is undebuggable.
 *
 * The fix routes both branches through `serializeReflowResponse`. The
 * conflict-replay branch hands in a synthetic `result` shape built from
 * the recovered ledger row + an empty actions/perActionResults set (the
 * canonical actions list lives in the ledger's `after_patch_json` — we
 * could re-hydrate, but the contract is "you already applied this; here
 * is the receipt." iOS retries are idempotent and don't re-render UI).
 */

import type { ReflowResult } from '../../services/training-week-reflow';
import type {
  CoachAction,
  ScenarioAssessment,
} from '../../services/coach-kernel/scenario-classifier';
import type { ExecuteCoachActionsResult } from '../../services/coach-kernel/coach-action-executor';

export interface ReflowResponseSerializerInput {
  /** Result from executeWeekReflow OR a synthetic one (idempotency replay). */
  result: ReflowResult;
  /** Classifier output used for this reflow. May be omitted on replay. */
  scenario?: ScenarioAssessment;
  /** Per-action executor breakdown — empty on replay or preview. */
  perActionResults?: ExecuteCoachActionsResult['perActionResults'];
  /** Science-policy version stamped on this reflow. Required for audit. */
  sciencePolicyVersion: string;
}

/**
 * Canonical response shape. iOS keys off `mode` + `mutated` to decide
 * how to refresh local state. `alreadyExisted` distinguishes
 * "we just applied this" from "you hit this same idempotency key
 * within 24h and got the original receipt back."
 */
export interface ReflowResponseBody {
  mode: ReflowResult['mode'];
  adaptationId: ReflowResult['adaptationId'];
  adaptationRevision: ReflowResult['adaptationRevision'];
  alreadyExisted: ReflowResult['alreadyExisted'];
  mutated: ReflowResult['mutated'];
  mutatedRows: ReflowResult['mutatedRows'];
  /**
   * `actions[]` returned by the classifier — present on both fresh
   * apply and preview. Empty on replay (the canonical actions live in
   * the ledger's after_patch_json; if iOS needs them it can read the
   * ledger via /coach-analysis).
   */
  actions: readonly CoachAction[];
  /**
   * Per-action mutation outcome from `executeCoachActions`. Present
   * only on fresh apply. Preview + replay yield empty arrays.
   */
  perActionResults: ExecuteCoachActionsResult['perActionResults'];
  /**
   * Full classifier assessment — surfaced so iOS can render the
   * coach-explanation alongside the action list without a second
   * request. Omitted only on idempotency-replay where the original
   * scenario is in the ledger.
   */
  scenario: ScenarioAssessment | null;
  /** Reproducibility stamp. iOS shows it in support flows. */
  sciencePolicyVersion: string;
}

export function serializeReflowResponse(
  input: ReflowResponseSerializerInput,
): ReflowResponseBody {
  return {
    mode: input.result.mode,
    adaptationId: input.result.adaptationId,
    adaptationRevision: input.result.adaptationRevision,
    alreadyExisted: input.result.alreadyExisted,
    mutated: input.result.mutated,
    mutatedRows: input.result.mutatedRows,
    actions: input.scenario?.actions ?? [],
    perActionResults: input.perActionResults ?? [],
    scenario: input.scenario ?? null,
    sciencePolicyVersion: input.sciencePolicyVersion,
  };
}

/**
 * Build a synthetic ReflowResult that represents the
 * "idempotency-replay" outcome — the apply has already happened, the
 * caller is asking again with the same key, and we want to surface the
 * receipt without re-running the classifier or mutating anything.
 */
export function buildReplayReflowResult(args: {
  adaptationId: number;
  adaptationRevision: number | null;
}): ReflowResult {
  return {
    mode: 'apply',
    adaptationId: args.adaptationId,
    adaptationRevision: args.adaptationRevision,
    alreadyExisted: true,
    mutated: false,
    mutatedRows: 0,
  };
}
