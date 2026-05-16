// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Shared step-construction helpers — extracted from chat-action-planner.ts
// to unlock per-skill parser extraction (the planner-split foundation, audit
// implementation plan Phase 0). The helpers here are pure utility:
// idempotent step construction, idempotency-key derivation, expected-field
// projection, and the step-type label.
//
// Type-only imports from `chat-action-planner.ts` (ChatPlanStep,
// ChatPlanStepType) are erased at compile time, so importing this module
// from the planner does not create a runtime cycle. Per-skill parsers that
// move out of the planner in subsequent PRs will call `makeStep` from here
// and import the planner's types as type-only references.

import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';

import {
  findChatActionDefinition,
  riskClassForRisk,
  runSlotValidators,
  type ChatActionName,
  type ChatActionRisk,
  type ChatActionSkill,
  type ChatProvider,
} from '../chat-action-registry';
import { buildNormalizedActionHash } from '../chat-action-run-store';
import { sanitizeLlmPromptValue } from '../llm-prompt-safety';
import type { ChatSlotProvenance } from '../chat-action-state';
import type { ChatPlanStep, ChatPlanStepType } from '../chat-action-planner';

/** Minimal identifying surface a step-builder needs from a chat planner input. */
export type StepKeyInputs = {
  userId: number;
  tenantId: number;
};

export interface MakeStepOptions {
  skill: ChatActionSkill;
  action: ChatActionName;
  risk: ChatActionRisk;
  provider?: ChatProvider;
  args: Record<string, unknown>;
  slotProvenance?: Record<string, ChatSlotProvenance>;
  requiredArgsPresent: boolean;
}

export function makeStep(input: StepKeyInputs, opts: MakeStepOptions): ChatPlanStep {
  const definition = findChatActionDefinition(opts.skill, opts.action);
  const args = sanitizeLlmPromptValue(opts.args) as Record<string, unknown>;
  // Phase 16 batch 81 (2026-05-17): Tier-0 validation parity. Before this,
  // deterministic parsers' hand-rolled `requiredArgsPresent` flag was the
  // sole source of truth at construction time, and typed validators only
  // ran in the LLM-structured path (chat-action-planner.ts:2106). Now
  // makeStep also runs validators and AND-combines: a step claims its
  // slots are present only when both the parser AND the typed validator
  // agree. Two carve-outs to preserve parser-as-source-of-truth where
  // intentional:
  //   1. Refusal plans (rejectionReason in args) keep their deliberate
  //      false; validators must not flip that.
  //   2. Parsers that deliberately set a required field to `null` use
  //      that as an executor-stage placeholder (e.g. decision_snooze
  //      uses `until: null` so the executor can confirm or default).
  //      Treat that as the parser's known-intent and trust their flag.
  let requiredArgsPresent = opts.requiredArgsPresent;
  if (definition && requiredArgsPresent && !args.rejectionReason) {
    const hasIntentionalNullPlaceholder = (definition.requiredFields ?? []).some(
      (f) => f in args && args[f] === null,
    );
    if (!hasIntentionalNullPlaceholder) {
      const validatorResult = runSlotValidators(definition, args);
      if (!validatorResult.ok) requiredArgsPresent = false;
    }
  }
  return {
    stepId: `step-${randomUUID()}`,
    skill: opts.skill,
    type: actionToStepType(opts.action),
    action: opts.action,
    risk: opts.risk,
    riskClass: riskClassForRisk(opts.risk),
    provider: opts.provider ?? definition?.providerDependencies[0] ?? 'nexus',
    args,
    slotProvenance: opts.slotProvenance,
    requiredArgsPresent,
    idempotencyKey: buildStepIdempotencyKey(input, opts.action, args),
    verification: {
      required: definition?.verifier !== 'none',
      method: definition?.verifier ?? 'none',
      expectedFields: pickExpectedFields(args, definition?.requiredFields ?? []),
    },
  };
}

export function actionToStepType(action: ChatActionName): ChatPlanStepType {
  return action;
}

export function buildStepIdempotencyKey(
  input: StepKeyInputs,
  action: string,
  args: Record<string, unknown>,
): string {
  return buildNormalizedActionHash({
    userId: input.userId,
    tenantId: input.tenantId,
    action,
    args: normalizeHashArgs(args),
  });
}

export function pickExpectedFields(args: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const expected: Record<string, unknown> = {};
  for (const field of fields) {
    if (args[field] != null && args[field] !== '') expected[field] = args[field];
  }
  return expected;
}

function normalizeHashArgs(value: unknown, keyHint?: string): unknown {
  if (typeof value === 'string' && keyHint && isHashDateTimeKey(keyHint)) {
    const parsed = DateTime.fromISO(value, { setZone: true });
    if (parsed.isValid) return parsed.toUTC().toISO({ suppressMilliseconds: true });
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeHashArgs(entry, keyHint));
  if (value && typeof value === 'object') {
    const normalized = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) normalized[key] = normalizeHashArgs(entry, key);
    }
    return normalized;
  }
  return value;
}

const HASH_DATETIME_KEY_SET = new Set([
  'date',
  'time',
  'datetime',
  'due',
  'dueat',
  'duedate',
  'duedatetime',
  'startat',
  'startdate',
  'starttime',
  'startdatetime',
  'endat',
  'enddate',
  'endtime',
  'enddatetime',
  'scheduledat',
  'scheduleddate',
  'scheduleddatetime',
  'remindat',
  'reminderat',
  'deadline',
  'createdat',
  'updatedat',
  'expiresat',
  'racedate',
]);

function isHashDateTimeKey(keyHint: string): boolean {
  const normalized = keyHint.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return HASH_DATETIME_KEY_SET.has(normalized);
}
