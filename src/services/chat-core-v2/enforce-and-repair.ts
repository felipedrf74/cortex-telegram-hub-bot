// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  parseAndValidateChatTurnPlanMicroJson,
  type ChatTurnPlanMicro,
  type ChatTurnPlanMicroValidationIssue,
} from './plan-schema';
import {
  CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION,
  buildPlannerRepairPrompt,
  canAttemptPlannerRepair,
} from './planner-repair';
import {
  validateChatTurnPlanMicroAgainstContext,
  type PlanValidationContext,
  type PlanValidationIssue,
} from './plan-validator';

/**
 * Bounded validate->repair-once orchestrator for ChatTurnPlanMicro.
 *
 * This module is PURE except for the injected `repairModel` callback. It does
 * not import Ollama, does not open a network socket, does not log raw user
 * text, and does not depend on CHAT_CORE_V2_ORCHESTRATOR_MODE. The shadow /
 * live caller decides whether to invoke it. Invoking it with a stub repairModel
 * (or with valid-on-first-pass input) performs zero side effects.
 *
 * Privacy: the raw model output is only ever passed back into the injected
 * `repairModel` (which the caller owns and is responsible for keeping
 * privacy-safe) and into `buildPlannerRepairPrompt`, which truncates it. This
 * function itself never logs, traces, or persists the raw output; it returns
 * only structured plans + machine-readable issue codes.
 */

export type EnforceAndRepairOutcome = 'valid' | 'repaired' | 'unrepairable';

export interface EnforceAndRepairResult {
  outcome: EnforceAndRepairOutcome;
  /** Present only when outcome is 'valid' or 'repaired'. */
  plan?: ChatTurnPlanMicro;
  /** Machine-readable issue codes only. Never contains raw user text. */
  issues: ChatTurnPlanMicroValidationIssue[];
  /** 0 when valid on first pass; 1 once the single repair attempt is consumed. */
  attemptsUsed: number;
  repairPromptVersion: string;
}

/**
 * Async callback that takes a repair prompt and returns the model's corrected
 * raw output. Injected so this module is unit-testable with a fake and so it
 * never hard-depends on a network model. The callback owns its own privacy and
 * timeout posture; this function tolerates it throwing.
 */
export type PlannerRepairModel = (repairPrompt: string) => Promise<string>;

export interface EnforceAndRepairChatTurnPlanMicroInput {
  rawModelOutput: string;
  /**
   * Optional plan-vs-context validation. When provided, a schema-valid plan is
   * additionally checked against the tenant/user-scoped context and any
   * context issues are folded in before deciding whether a repair is needed.
   */
  context?: PlanValidationContext;
  repairModel: PlannerRepairModel;
  now?: Date;
}

const REPAIR_ATTEMPT_USED = 1;
const NO_REPAIR_ATTEMPT_USED = 0;

export async function enforceAndRepairChatTurnPlanMicro(
  input: EnforceAndRepairChatTurnPlanMicroInput,
): Promise<EnforceAndRepairResult> {
  const firstPass = validateRawAgainstSchemaAndContext(input.rawModelOutput, input.context);
  if (firstPass.ok) {
    return {
      outcome: 'valid',
      plan: firstPass.plan,
      issues: [],
      attemptsUsed: NO_REPAIR_ATTEMPT_USED,
      repairPromptVersion: CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION,
    };
  }

  // Respect the single-repair bound. canAttemptPlannerRepair(0) gates the very
  // first (and only) repair attempt. We never call it with a value that would
  // permit a 2nd attempt.
  if (!canAttemptPlannerRepair(NO_REPAIR_ATTEMPT_USED)) {
    return {
      outcome: 'unrepairable',
      issues: firstPass.issues,
      attemptsUsed: NO_REPAIR_ATTEMPT_USED,
      repairPromptVersion: CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION,
    };
  }

  const repairPrompt = buildPlannerRepairPrompt({
    rawModelOutput: input.rawModelOutput,
    issues: firstPass.issues,
  });

  let repairedRaw: string;
  try {
    repairedRaw = await input.repairModel(repairPrompt);
  } catch (err) {
    // Never throw, never block recording. A model failure becomes a structured
    // unrepairable outcome with a synthetic, text-free issue.
    return {
      outcome: 'unrepairable',
      issues: [syntheticRepairFailureIssue(err)],
      attemptsUsed: REPAIR_ATTEMPT_USED,
      repairPromptVersion: CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION,
    };
  }

  const secondPass = validateRawAgainstSchemaAndContext(repairedRaw, input.context);
  if (secondPass.ok) {
    return {
      outcome: 'repaired',
      plan: secondPass.plan,
      issues: [],
      attemptsUsed: REPAIR_ATTEMPT_USED,
      repairPromptVersion: CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION,
    };
  }

  // Repair did not produce a valid plan. We do NOT attempt a 2nd repair.
  return {
    outcome: 'unrepairable',
    issues: secondPass.issues,
    attemptsUsed: REPAIR_ATTEMPT_USED,
    repairPromptVersion: CHAT_CORE_V2_PLANNER_REPAIR_PROMPT_VERSION,
  };
}

interface SchemaAndContextPass {
  ok: boolean;
  plan?: ChatTurnPlanMicro;
  issues: ChatTurnPlanMicroValidationIssue[];
}

function validateRawAgainstSchemaAndContext(
  raw: string,
  context?: PlanValidationContext,
): SchemaAndContextPass {
  // parseAndValidateChatTurnPlanMicroJson never throws: it catches JSON parse
  // failures and returns an 'invalid_json' issue. Garbage / empty input is
  // therefore handled here without any try/catch of our own.
  const expectedContextHash = context?.contextHash;
  const schemaResult = parseAndValidateChatTurnPlanMicroJson(raw, expectedContextHash);
  if (!schemaResult.ok || !schemaResult.plan) {
    return { ok: false, issues: schemaResult.issues };
  }

  if (!context) {
    return { ok: true, plan: schemaResult.plan, issues: [] };
  }

  const contextResult = validateChatTurnPlanMicroAgainstContext(schemaResult.plan, context);
  if (contextResult.ok) {
    return { ok: true, plan: schemaResult.plan, issues: [] };
  }

  return {
    ok: false,
    issues: contextResult.issues.map(mapContextIssue),
  };
}

/**
 * Fold a context-validation issue (PlanValidationIssue) into the schema issue
 * shape (ChatTurnPlanMicroValidationIssue) so callers see a single, uniform
 * machine-readable issue list. Carries only the enum code in the message — no
 * raw user text.
 */
function mapContextIssue(issue: PlanValidationIssue): ChatTurnPlanMicroValidationIssue {
  return {
    code: CONTEXT_ISSUE_CODE_MAP[issue],
    path: '$.context',
    message: `context:${issue}`,
  };
}

// Map context-policy issues onto the closest existing schema issue code so the
// unified issue list stays within the documented enum. 'stale_context' maps to
// the dedicated 'context_hash_mismatch' code; everything else is a constraint
// violation against the validated plan, represented as 'invalid_literal'.
const CONTEXT_ISSUE_CODE_MAP: Record<PlanValidationIssue, ChatTurnPlanMicroValidationIssue['code']> = {
  unknown_capability: 'invalid_literal',
  write_not_allowed_in_current_phase: 'invalid_literal',
  cloud_fallback_not_allowed: 'invalid_literal',
  missing_grounding: 'invalid_literal',
  stale_context: 'context_hash_mismatch',
  ambiguous_reference: 'invalid_literal',
  budget_exceeded: 'invalid_literal',
};

function syntheticRepairFailureIssue(err: unknown): ChatTurnPlanMicroValidationIssue {
  // Privacy: never embed the raw error message (it could echo model output or
  // user text). Record only the error's class name.
  const errorName = err instanceof Error ? err.name : 'NonError';
  return {
    code: 'invalid_json',
    path: '$.repairModel',
    message: `repair_model_failed:${errorName}`,
  };
}
