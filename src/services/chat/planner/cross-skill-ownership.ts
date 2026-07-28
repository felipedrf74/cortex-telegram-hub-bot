// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M19 — plan-level cross-skill execution + ownership.
 *
 * Deterministic plan transform driven by the CapabilityManifest's
 * `runtimeRouting.chatActionOwnership` rows: when a plan step ORIGINATES from
 * another skill but its segment text matches an ownership row's evidence
 * (e.g. "add it to my calendar" — agenda placement belongs to Secretary),
 * the step is REWRITTEN in place to the owner skill's action. Never
 * duplicated: the misrouted step is replaced, its slots re-extracted from the
 * segment text through the owner action's registry-typed slot extractors.
 *
 * This is explicitly NOT a handoff_to_domain model tool and NOT agent
 * orchestration — it is a pure, synchronous transform over an already-built
 * plan, running after per-segment plan build and before DAG construction.
 *
 * Everything here is generic: the rows come from the manifest (a synthetic
 * manifest entry exercises the same code path in tests), the rewrite goes
 * through the shared registry definition + makeStep, and no skill, action,
 * user, or phrasing is special-cased in code.
 *
 * Flag: AI_CROSS_SKILL_EXECUTION (default OFF → every helper is a no-op and
 * current behavior is byte-identical). The manifest-routing master kill
 * (AI_ROUTING_MANIFEST_KILL) wins over the enable, mirroring the M12
 * precedence rule: a kill can only ever ADD an off, never remove one.
 *
 * The flag retires the legacy cross_skill_bridge prompt block only for
 * actionable turns covered by the plan path or its deterministic declined
 * terminal. Pure multi-skill reads keep the bridge until a multi-owner read
 * executor exists, because their primary owner cannot represent every skill.
 */

import { loadCapabilityManifest } from '../../capability-manifest';
import { foldCalendarText } from '../../calendar-natural-language-parser';
import { MANIFEST_ROUTING_MASTER_KILL_ENV_VAR } from '../../intent-resolution/manifest-routing-flags';
import { makeStep } from '../../skills/step-builder';
import {
  findChatActionDefinition,
  getSlotExtractors,
  type ChatActionName,
  type ChatActionSkill,
  type ChatProvider,
} from '../registry';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../types';
import { logger } from '../../../utils/logger';

export const CROSS_SKILL_EXECUTION_ENV_VAR = 'AI_CROSS_SKILL_EXECUTION';

type EnvLike = Record<string, string | undefined>;

function parseBoolean(raw: string | undefined): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Whether plan-level cross-skill execution (ownership rewrite, grouped
 * preview, bridge retirement) is active. Default OFF; the manifest-routing
 * master kill always wins.
 */
export function isCrossSkillExecutionEnabled(env: EnvLike = process.env): boolean {
  if (parseBoolean(env[MANIFEST_ROUTING_MASTER_KILL_ENV_VAR])) return false;
  return parseBoolean(env[CROSS_SKILL_EXECUTION_ENV_VAR]);
}

/** One manifest-declared ownership row, compiled for matching. */
export interface CompiledChatActionOwnershipRow {
  /** Owning capability id (manifest entry the row came from). */
  capabilityId: string;
  /** Stable category label (telemetry only — never matched in code). */
  category: string;
  ownerSkill: ChatActionSkill;
  ownerAction: ChatActionName;
  /** Evidence regexes, matched against the folded segment text. */
  evidence: RegExp[];
}

let cachedRows: CompiledChatActionOwnershipRow[] | null = null;

/** Test hook: drop the compiled ownership-row cache. */
export function _resetCrossSkillOwnershipForTests(): void {
  cachedRows = null;
}

/**
 * Compile the manifest's `runtimeRouting.chatActionOwnership` rows. Rows that
 * fail to compile (bad regex, unknown owner action) are skipped with a log —
 * a broken manifest row must degrade to current behavior, never throw on the
 * chat path.
 */
export function getChatActionOwnershipRows(): CompiledChatActionOwnershipRow[] {
  if (cachedRows) return cachedRows;
  const rows: CompiledChatActionOwnershipRow[] = [];
  for (const entry of loadCapabilityManifest().capabilities) {
    for (const raw of entry.runtimeRouting.chatActionOwnership ?? []) {
      const compiled = compileOwnershipRow(entry.id, raw);
      if (compiled) rows.push(compiled);
    }
  }
  cachedRows = rows;
  return rows;
}

export interface RawChatActionOwnershipRow {
  category: string;
  ownerSkill: string;
  ownerAction: string;
  evidence: string[];
}

function compileOwnershipRow(
  capabilityId: string,
  raw: RawChatActionOwnershipRow,
): CompiledChatActionOwnershipRow | null {
  const definition = findChatActionDefinition(
    raw.ownerSkill as ChatActionSkill,
    raw.ownerAction as ChatActionName,
  );
  if (!definition) {
    logger.warn(
      { capabilityId, category: raw.category, ownerSkill: raw.ownerSkill, ownerAction: raw.ownerAction },
      'chatActionOwnership row references an unknown registry action; skipping',
    );
    return null;
  }
  const evidence: RegExp[] = [];
  for (const source of raw.evidence) {
    try {
      evidence.push(new RegExp(source, 'i'));
    } catch (err) {
      logger.warn({ capabilityId, category: raw.category, source, err }, 'chatActionOwnership evidence regex failed to compile; skipping pattern');
    }
  }
  if (evidence.length === 0) return null;
  return {
    capabilityId,
    category: raw.category,
    ownerSkill: raw.ownerSkill as ChatActionSkill,
    ownerAction: raw.ownerAction as ChatActionName,
    evidence,
  };
}

export interface CrossSkillOwnershipRewrite {
  fromSkill: ChatActionSkill;
  fromAction: ChatActionName;
  toSkill: ChatActionSkill;
  toAction: ChatActionName;
  category: string;
}

export interface ApplyCrossSkillOwnershipResult {
  steps: ChatPlanStep[];
  rewrites: CrossSkillOwnershipRewrite[];
}

/**
 * M19 remediation (2026-07-21): per-step relevance guard. The ownership
 * evidence is matched against the SEGMENT text, so before rewriting a step
 * we check whether the segment also corroborates the step's OWN planned
 * action (any of its registry readableIntents appears in the segment). When
 * it does — "remind me to add the offsite to my calendar" corroborates the
 * reminder action — the calendar mention is the step's BODY, not a
 * placement misroute, and the rewrite must be skipped. Registry-driven: no
 * skill, action, or phrasing is special-cased here.
 */
function segmentCorroboratesStepAction(
  step: ChatPlanStep,
  segmentText: string,
  foldedSegment: string,
): boolean {
  const definition = findChatActionDefinition(step.skill, step.action);
  if (!definition) return false;
  const lowerSegment = segmentText.toLowerCase();
  return definition.readableIntents.some((intent) => {
    const trimmed = intent.trim().toLowerCase();
    if (!trimmed) return false;
    return lowerSegment.includes(trimmed) || foldedSegment.includes(foldCalendarText(intent));
  });
}

/**
 * Rewrite the FIRST step whose originating segment text matches an ownership
 * row's evidence but whose planned skill is not the owner. The rewritten
 * step is rebuilt from the owner action's registry definition: slots
 * re-extracted from the segment text (typed slot extractors), required
 * fields defaulted to null, readiness re-derived. Steps already on the owner
 * action, answer/clarification steps, refusal steps, and steps whose own
 * action the segment corroborates (see segmentCorroboratesStepAction) are
 * left untouched.
 *
 * At most ONE step per segment is rewritten (M19 remediation): the evidence
 * is segment-level, so one detected placement intent must map to one owned
 * step — rewriting every non-owner step would fan a single intent out into
 * duplicated owner actions.
 *
 * Callers gate on isCrossSkillExecutionEnabled(); this function itself is
 * flag-agnostic so the synthetic-row test seam stays trivial.
 */
export function applyCrossSkillOwnershipToSteps(
  steps: ChatPlanStep[],
  segmentText: string,
  input: ChatPlannerInput,
  rows: CompiledChatActionOwnershipRow[] = getChatActionOwnershipRows(),
): ApplyCrossSkillOwnershipResult {
  if (rows.length === 0 || steps.length === 0) return { steps, rewrites: [] };
  const folded = foldCalendarText(segmentText);
  const rewrites: CrossSkillOwnershipRewrite[] = [];
  const out = steps.map((step) => {
    if (rewrites.length > 0) return step; // at most one rewrite per segment
    if (step.type === 'answer' || step.type === 'clarification') return step;
    if (typeof (step.args as Record<string, unknown> | undefined)?.rejectionReason === 'string') return step;
    const row = rows.find((candidate) => candidate.ownerSkill !== step.skill
      && candidate.evidence.some((pattern) => pattern.test(segmentText) || pattern.test(folded)));
    if (!row) return step;
    if (segmentCorroboratesStepAction(step, segmentText, folded)) return step;
    const rewritten = buildOwnerStep(row, segmentText, input);
    if (!rewritten) return step;
    rewrites.push({
      fromSkill: step.skill,
      fromAction: step.action,
      toSkill: row.ownerSkill,
      toAction: row.ownerAction,
      category: row.category,
    });
    return rewritten;
  });
  return { steps: out, rewrites };
}

function buildOwnerStep(
  row: CompiledChatActionOwnershipRow,
  segmentText: string,
  input: ChatPlannerInput,
): ChatPlanStep | null {
  const definition = findChatActionDefinition(row.ownerSkill, row.ownerAction);
  if (!definition) return null;
  const args: Record<string, unknown> = {};
  for (const field of definition.requiredFields) args[field] = null;
  const slotContext = { locale: input.locale, timezone: input.timezone, nowIso: input.nowIso };
  for (const extractor of getSlotExtractors(definition)) {
    try {
      const extracted = extractor.extract(segmentText, slotContext);
      for (const [slot, value] of Object.entries(extracted.slots ?? {})) {
        if (value === null || value === undefined || value === '') continue;
        args[slot] = value;
      }
    } catch (err) {
      logger.debug({ err, ownerSkill: row.ownerSkill, ownerAction: row.ownerAction, extractor: extractor.name }, 'cross-skill ownership slot extractor failed');
    }
  }
  const requiredArgsPresent = definition.requiredFields.every(
    (field) => args[field] !== null && args[field] !== undefined && args[field] !== '',
  );
  return makeStep(input, {
    skill: row.ownerSkill,
    action: row.ownerAction,
    risk: definition.risk,
    provider: (typeof args.provider === 'string' ? args.provider : 'nexus') as ChatProvider,
    args,
    requiredArgsPresent,
  });
}

/** Distinct executable (non-answer, non-clarification) skills in a plan. */
export function executableSkillsForPlan(steps: ChatPlanStep[]): ChatActionSkill[] {
  const skills = new Set<ChatActionSkill>();
  for (const step of steps) {
    if (step.type === 'answer' || step.type === 'clarification') continue;
    skills.add(step.skill);
  }
  return [...skills];
}

/**
 * M19 confirmation policy: any plan spanning >=2 skills is preview-first.
 * The multi-step DAG already forces confirmation for >=2 steps; this guard
 * makes the cross-skill case explicit so a future single-step collapse (or a
 * non-splitter multi-skill plan) cannot bypass the preview. No-op when the
 * plan does not span skills.
 */
export function enforceCrossSkillPreview(plan: ChatActionPlan): ChatActionPlan {
  if (plan.requiresConfirmation) return plan;
  if (executableSkillsForPlan(plan.steps).length < 2) return plan;
  return { ...plan, requiresConfirmation: true };
}
