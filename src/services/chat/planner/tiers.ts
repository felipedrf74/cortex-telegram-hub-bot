// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';
import { foldCalendarText } from '../../calendar-natural-language-parser';
import { buildLlmSafePromptSlice } from '../../build-llm-safe-prompt-slice';
import { redactSensitivePromptText } from '../../llm-prompt-safety';
import { completeOneShot, isGeminiProviderConfigured } from '../../gemini-provider';
import { computeModelUsageCostUsd } from '../../model-pricing';
import {
  findChatActionDefinition,
  getChatActionRegistry,
  riskClassForRisk,
  runSlotValidators,
  selectRegistrySubsetForMessage,
  type SlotValidationResult,
  type ChatActionName,
  type ChatActionDefinition,
  type ChatActionSkill,
} from '../registry';
import {
  makeSlotProvenance,
  type ChatActionTelemetry,
  type ChatSlotProvenance,
} from '../../chat-action-state';
import { actionToStepType, buildStepIdempotencyKey, pickExpectedFields } from '../../skills/step-builder';
import { isChatEscalationReviewerEnabled, isChatLlmTier1Enabled, isChatLlmTier2Enabled } from '../../runtime-flags';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../types';
import { logger } from '../../../utils/logger';
import { sanitizePlannerArgs } from './arg-sanitizer';
import { rethrowAiUsageFailClosedError } from '../../api-usage-fallback';
import { buildTargetedClarificationQuestion } from './clarification';
import {
  calibratePlanConfidence,
  clampConfidence,
  normalizeProvider,
  shouldRequireSafeWriteConfirmation,
  stepRequiresConfirmation,
  thresholdForSteps,
} from './plan-utils';

const CHAT_LLM_TIER2_GEMINI_MODEL = 'gemini-2.5-flash';
const CHAT_LLM_TIER2_OPENAI_FALLBACK_MODEL = 'gpt-5.4-nano';
const CHAT_LLM_TIER1_GEMINI_MODEL = 'gemini-2.5-flash-lite';
const CHAT_LLM_TIER3_GEMINI_MODEL = 'gemini-2.5-flash';
const CHAT_LLM_TIER3_OPENAI_FALLBACK_MODEL = 'gpt-5.4-mini';

export function buildLlmPlannerPrompt(input: ChatPlannerInput): { systemPrompt: string; userPrompt: string } {
  const subset = selectRegistrySubsetForMessage(input.text);
  const candidateRegistry = subset.length > 0 ? subset : getChatActionRegistry().filter((entry) => entry.skill === 'tasks' || entry.skill === 'secretary_calendar' || entry.skill === 'secretary_reminders');
  const registry = limitLlmPlannerRegistryForPrompt(input.text, candidateRegistry);
  const examples = retrievePlannerExamples(input, registry).slice(0, 6);
  // SECURITY: registry entries are filtered through buildLlmSafePromptSlice so
  // executor/verifier dispatch keys, raw R0-R4 risk codes, uiSurfaces, version,
  // status, owner, priority, slotExtractors, slotValidators, responseCardType,
  // privacyPolicy, latencyBudgetMs, fallbackPolicy, supportedCards, and any
  // prompt_injection/adversarial examples never reach LLM context. See
  // `__tests__/services/chat-action-prompt-safety.test.ts` for the contract.
  const safeRegistryView = registry.map(buildLlmSafePromptSlice);
  return {
    systemPrompt: [
      'You convert Nexus chat messages into a compact JSON action plan proposal.',
      'Return JSON only. Do not execute anything. Do not invent userId, tenantId, provider objects, or success.',
      'Allowed output types: action_plan, needs_input, needs_confirmation, open_surface, ambiguous_reference, unsupported, blocked_by_policy, no_action_chat_response.',
      'Use only these actions and required fields. Mark missing fields explicitly.',
      JSON.stringify(safeRegistryView),
      examples.length > 0 ? `Relevant examples: ${JSON.stringify(examples)}` : '',
    ].join('\n'),
    userPrompt: JSON.stringify({
      text: redactSensitivePromptText(input.text),
      locale: input.locale || 'pt-BR',
      timezone: input.timezone,
      now: input.nowIso ?? new Date().toISOString(),
      expectedShape: {
        outputType: 'action_plan',
        steps: [{ skill: 'tasks', action: 'create_task', args: {}, missingFields: [], confidence: 0.0 }],
        confidence: 0.0,
      },
    }),
  };
}

const MAX_LLM_PLANNER_REGISTRY_ACTIONS = 11;

function limitLlmPlannerRegistryForPrompt(
  text: string,
  registry: ChatActionDefinition[],
): ChatActionDefinition[] {
  if (registry.length <= MAX_LLM_PLANNER_REGISTRY_ACTIONS) return registry;
  const folded = foldCalendarText(text);
  const ranked = registry
    .map((entry, index) => ({
      entry,
      index,
      key: `${entry.skill}.${entry.action}`,
      score: scoreRegistryEntryForPrompt(folded, entry),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = new Map<string, ChatActionDefinition>();
  const bySkill = new Map<ChatActionSkill, typeof ranked>();
  for (const item of ranked) {
    const bucket = bySkill.get(item.entry.skill) ?? [];
    bucket.push(item);
    bySkill.set(item.entry.skill, bucket);
  }
  for (const items of bySkill.values()) {
    if (selected.size >= MAX_LLM_PLANNER_REGISTRY_ACTIONS) break;
    selected.set(items[0].key, items[0].entry);
  }
  for (const item of ranked) {
    if (selected.size >= MAX_LLM_PLANNER_REGISTRY_ACTIONS) break;
    selected.set(item.key, item.entry);
  }
  return [...selected.values()];
}

function scoreRegistryEntryForPrompt(foldedText: string, entry: ChatActionDefinition): number {
  let score = 0;
  const actionTokens = entry.action.split('_').filter((token) => token.length >= 3);
  const skillTokens = entry.skill.split('_').filter((token) => token.length >= 3);
  for (const token of [...actionTokens, ...skillTokens]) {
    if (foldedText.includes(token)) score += 2;
  }
  for (const intent of entry.readableIntents) {
    const foldedIntent = foldCalendarText(intent);
    if (foldedText.includes(foldedIntent)) score += 4;
    for (const token of foldedIntent.split(/\s+/).filter((part) => part.length >= 4)) {
      if (foldedText.includes(token)) score += 1;
    }
  }
  for (const field of [...entry.requiredFields, ...entry.optionalFields]) {
    const foldedField = field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    if (foldedText.includes(foldedField)) score += 1;
  }
  return score;
}

export function buildTier1ClassifierPrompt(input: ChatPlannerInput): { systemPrompt: string; userPrompt: string } {
  const subset = selectRegistrySubsetForMessage(input.text);
  // Tier 1 deliberately suppresses high-risk actions (destructive/financial/
  // admin_security) — that filter runs on the raw `risk` field BEFORE mapping
  // to the safe view, since the safe view exposes only a coarse riskLabel.
  const registry = (subset.length > 0 ? subset : getChatActionRegistry())
    .filter((entry) => entry.risk !== 'destructive' && entry.risk !== 'financial' && entry.risk !== 'admin_security')
    .slice(0, 8);
  const examples = retrievePlannerExamples(input, registry).slice(0, 4);
  const safeRegistryView = registry.map(buildLlmSafePromptSlice);
  return {
    systemPrompt: [
      'Classify a Nexus chat message into the smallest likely skill/action candidate set.',
      'Return JSON only. Do not execute anything. Do not invent trusted IDs or claim success.',
      'Use Tier 1 only for simple routing and slot hints. Complex/multistep messages may return needsTier2=true.',
      JSON.stringify(safeRegistryView),
      examples.length > 0 ? `Relevant examples: ${JSON.stringify(examples)}` : '',
    ].join('\n'),
    userPrompt: JSON.stringify({
      text: redactSensitivePromptText(input.text),
      locale: input.locale || 'pt-BR',
      timezone: input.timezone,
      now: input.nowIso ?? new Date().toISOString(),
      expectedShape: {
        candidates: [{ skill: 'tasks', action: 'create_task', score: 0.0, args: {}, missingFields: [] }],
        needsTier2: false,
      },
    }),
  };
}

function parsePlannerJsonObject(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (!fence) return null;
    try { return JSON.parse(fence[1]); } catch { return null; }
  }
}

type PlannerJsonParseOptions = {
  routeTier?: ChatActionTelemetry['routeTier'];
  routingSignal?: string;
};

export function parseLlmPlannerJson(raw: string, input: ChatPlannerInput, options: PlannerJsonParseOptions = {}): ChatActionPlan | null {
  const parsed = parsePlannerJsonObject(raw);
  if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
  const steps: ChatPlanStep[] = [];
  for (const candidate of parsed.steps.slice(0, 5)) {
    const skill = candidate.skill as ChatActionSkill;
    const action = candidate.action as ChatActionName;
    const definition = findChatActionDefinition(skill, action);
    if (!definition) return null;
    const args = sanitizePlannerArgs(typeof candidate.args === 'object' && candidate.args ? candidate.args as Record<string, unknown> : {});
    const modelMissing = Array.isArray(candidate.missingFields)
      ? candidate.missingFields.filter((field: unknown): field is string => typeof field === 'string')
      : [];
    const validation = runSlotValidators(definition, args, {
      locale: input.locale,
      timezone: input.timezone,
      nowIso: input.nowIso,
    });
    const invalidFields = Object.keys(validation.errors ?? {});
    const missing = [...new Set([
      ...modelMissing,
      ...(validation.missing ?? []),
      ...invalidFields,
    ])];
    const risk = definition.risk;
    const slotProvenance = buildLlmSlotProvenance(input, args, definition.requiredFields, provenanceSourceForRouteTier(options.routeTier), validation);
    steps.push({
      stepId: `step-${randomUUID()}`,
      skill,
      type: actionToStepType(action),
      action,
      risk,
      riskClass: riskClassForRisk(risk),
      provider: normalizeProvider(args.provider),
      args,
      slotProvenance,
      requiredArgsPresent: missing.length === 0 && validation.ok,
      idempotencyKey: buildStepIdempotencyKey(input, action, args),
      verification: {
        required: definition.verifier !== 'none',
        method: definition.verifier,
        expectedFields: pickExpectedFields(args, definition.requiredFields),
      },
    });
  }
  const requiresConfirmation = steps.some((step) => stepRequiresConfirmation(step, {
    requireSafeWrites: shouldRequireSafeWriteConfirmation(input),
  }));
  const confidence = clampConfidence(Number(parsed.confidence ?? Math.min(...steps.map((step) => step.requiredArgsPresent ? 0.72 : 0.45))));
  const effectiveConfidence = calibratePlanConfidence(steps, confidence);
  const threshold = thresholdForSteps(steps);
  const belowCalibratedThreshold = effectiveConfidence < threshold;
  const needsClarification = steps.some((step) => !step.requiredArgsPresent) || belowCalibratedThreshold;
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale || 'pt-BR',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'llm_structured',
    steps,
    requiresConfirmation,
    clarificationQuestion: needsClarification ? buildTargetedClarificationQuestion(input, steps) : undefined,
    confidence,
    effectiveConfidence,
    telemetry: {
      routeTier: options.routeTier ?? 'tier2_structured_planner',
      candidates: steps.map((step) => ({ skill: step.skill, action: step.action, score: effectiveConfidence })),
      calibratedScore: effectiveConfidence,
      threshold,
      verifierStatus: steps.some((step) => step.verification.required) ? 'pending' : 'not_required',
      failureReason: belowCalibratedThreshold ? 'below_calibrated_threshold' : undefined,
    },
    debug: {
      routingSignals: [options.routingSignal ?? 'llm_structured_planner'],
      rejectedFastPaths: [],
      parser: 'model_assisted',
    },
  };
}

export function parseTier1ClassifierJson(raw: string, input: ChatPlannerInput): ChatActionPlan | null {
  const parsed = parsePlannerJsonObject(raw);
  if (!parsed || parsed.needsTier2 === true || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0) return null;
  const sorted = parsed.candidates
    .filter((candidate: any) => candidate && typeof candidate.skill === 'string' && typeof candidate.action === 'string')
    .sort((a: any, b: any) => Number(b.score ?? 0) - Number(a.score ?? 0));
  const top = sorted[0];
  if (!top || Number(top.score ?? 0) < 0.72) return null;
  const draft = {
    confidence: Number(top.score ?? parsed.confidence ?? 0.72),
    steps: [{
      skill: top.skill,
      action: top.action,
      args: typeof top.args === 'object' && top.args ? top.args : {},
      missingFields: Array.isArray(top.missingFields) ? top.missingFields : undefined,
    }],
  };
  const plan = parseLlmPlannerJson(JSON.stringify(draft), input, {
    routeTier: 'tier1_classifier',
    routingSignal: 'tier1_classifier_slot_helper',
  });
  if (!plan) return null;
  const threshold = plan.telemetry?.threshold ?? thresholdForSteps(plan.steps);
  if (plan.steps.every((step) => step.requiredArgsPresent) && (plan.effectiveConfidence ?? plan.confidence) < threshold) {
    return null;
  }
  if (plan.telemetry) {
    plan.telemetry.candidates = sorted.slice(0, 3).map((candidate: any) => ({
      skill: candidate.skill,
      action: candidate.action,
      score: clampConfidence(Number(candidate.score ?? 0)),
    })).filter((candidate: any) => Boolean(findChatActionDefinition(candidate.skill, candidate.action)));
  }
  return plan;
}

export async function tryBuildLlmStructuredPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  if (!isChatLlmTier2Enabled(process.env, { userId: input.userId, tenantId: input.tenantId })) return null;
  const prompt = buildLlmPlannerPrompt(input);
  try {
    const result = await completeStructuredPlannerWithCascade(prompt, input);
    const plan = parseLlmPlannerJson(result.text, input);
    if (plan?.debug) plan.debug.modelProvider = result.provider;
    if (plan?.telemetry) {
      plan.telemetry.modelProvider = result.provider;
      plan.telemetry.model = result.model;
      plan.telemetry.estimatedTokenCostUsd = estimatePlannerCallCostUsd(result.provider, result.model, prompt.systemPrompt, prompt.userPrompt, result.text);
    }
    return plan;
  } catch (err) {
    rethrowAiUsageFailClosedError(err);
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'chat action llm structured planner unavailable');
    return null;
  }
}

export async function tryBuildTier1ClassifierPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  if (!isChatLlmTier1Enabled(process.env, { userId: input.userId, tenantId: input.tenantId })) return null;
  const prompt = buildTier1ClassifierPrompt(input);
  try {
    if (!isGeminiProviderConfigured()) return null;
    const text = await completeOneShot(
      prompt.systemPrompt,
      prompt.userPrompt,
      'chat_action_tier1_classifier',
      {
        model: CHAT_LLM_TIER1_GEMINI_MODEL,
        temperature: 0,
        maxTokens: 450,
        jsonMode: true,
        userId: input.userId,
        tenantId: input.tenantId,
        timeoutMs: 1800,
      },
    );
    const plan = parseTier1ClassifierJson(text, input);
    if (plan?.debug) plan.debug.modelProvider = 'gemini';
    if (plan?.telemetry) {
      plan.telemetry.modelProvider = 'gemini';
      plan.telemetry.model = CHAT_LLM_TIER1_GEMINI_MODEL;
      plan.telemetry.estimatedTokenCostUsd = estimatePlannerCallCostUsd('gemini', CHAT_LLM_TIER1_GEMINI_MODEL, prompt.systemPrompt, prompt.userPrompt, text);
    }
    return plan;
  } catch (err) {
    rethrowAiUsageFailClosedError(err);
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'chat action tier1 classifier unavailable');
    return null;
  }
}

export async function tryBuildEscalationReviewerPlan(input: ChatPlannerInput): Promise<ChatActionPlan | null> {
  if (!isChatEscalationReviewerEnabled(process.env, { userId: input.userId, tenantId: input.tenantId })) return null;
  const basePrompt = buildLlmPlannerPrompt(input);
  const prompt = {
    systemPrompt: [
      basePrompt.systemPrompt,
      'Escalation reviewer mode: only return a plan when the request is supported, semantically clear, and safer than asking a clarification. Otherwise return unsupported or needs_input.',
      'Never approve destructive, financial, admin, or external-side-effect execution without confirmation.',
    ].join('\n'),
    userPrompt: basePrompt.userPrompt,
  };
  try {
    const result = await completeEscalationReviewerWithCascade(prompt, input);
    const plan = parseLlmPlannerJson(result.text, input, {
      routeTier: 'tier3_reviewer',
      routingSignal: 'tier3_escalation_reviewer',
    });
    if (plan?.debug) plan.debug.modelProvider = result.provider;
    if (plan?.telemetry) {
      plan.telemetry.modelProvider = result.provider;
      plan.telemetry.model = result.model;
      plan.telemetry.estimatedTokenCostUsd = estimatePlannerCallCostUsd(result.provider, result.model, prompt.systemPrompt, prompt.userPrompt, result.text);
    }
    return plan;
  } catch (err) {
    rethrowAiUsageFailClosedError(err);
    logger.debug({ err, userId: input.userId, tenantId: input.tenantId }, 'chat action escalation reviewer unavailable');
    return null;
  }
}

async function completeStructuredPlannerWithCascade(
  prompt: { systemPrompt: string; userPrompt: string },
  input: ChatPlannerInput,
): Promise<{ text: string; provider: 'gemini' | 'openai'; model: string }> {
  if (isGeminiProviderConfigured()) {
    try {
      const text = await completeOneShot(
        prompt.systemPrompt,
        prompt.userPrompt,
        'chat_action_planner',
        {
          model: CHAT_LLM_TIER2_GEMINI_MODEL,
          temperature: 0,
          maxTokens: 900,
          jsonMode: true,
          userId: input.userId,
          tenantId: input.tenantId,
          timeoutMs: 3500,
        },
      );
      return { text, provider: 'gemini', model: CHAT_LLM_TIER2_GEMINI_MODEL };
    } catch (err) {
      rethrowAiUsageFailClosedError(err);
      logger.warn({ err, userId: input.userId, tenantId: input.tenantId }, 'Gemini chat action planner failed, trying OpenAI nano fallback');
    }
  }

  const openai = require('../../openai-provider') as typeof import('../../openai-provider');
  if (!openai.isOpenAIConfigured()) {
    throw new Error('chat action planner OpenAI fallback not configured');
  }
  const text = await openai.completeOneShot(
    prompt.systemPrompt,
    prompt.userPrompt,
    'chat_action_planner_openai_fallback',
    {
      model: CHAT_LLM_TIER2_OPENAI_FALLBACK_MODEL,
      temperature: 0,
      maxTokens: 900,
      jsonMode: true,
      userId: input.userId,
      tenantId: input.tenantId,
      timeoutMs: 3500,
    },
  );
  return { text, provider: 'openai', model: CHAT_LLM_TIER2_OPENAI_FALLBACK_MODEL };
}

async function completeEscalationReviewerWithCascade(
  prompt: { systemPrompt: string; userPrompt: string },
  input: ChatPlannerInput,
): Promise<{ text: string; provider: 'gemini' | 'openai'; model: string }> {
  if (isGeminiProviderConfigured()) {
    try {
      const text = await completeOneShot(
        prompt.systemPrompt,
        prompt.userPrompt,
        'chat_action_escalation_reviewer',
        {
          model: CHAT_LLM_TIER3_GEMINI_MODEL,
          temperature: 0,
          maxTokens: 900,
          jsonMode: true,
          userId: input.userId,
          tenantId: input.tenantId,
          timeoutMs: 4500,
        },
      );
      return { text, provider: 'gemini', model: CHAT_LLM_TIER3_GEMINI_MODEL };
    } catch (err) {
      rethrowAiUsageFailClosedError(err);
      logger.warn({ err, userId: input.userId, tenantId: input.tenantId }, 'Gemini chat action reviewer failed, trying OpenAI mini fallback');
    }
  }

  const openai = require('../../openai-provider') as typeof import('../../openai-provider');
  if (!openai.isOpenAIConfigured()) {
    throw new Error('chat action escalation reviewer OpenAI fallback not configured');
  }
  const text = await openai.completeOneShot(
    prompt.systemPrompt,
    prompt.userPrompt,
    'chat_action_escalation_openai_fallback',
    {
      model: CHAT_LLM_TIER3_OPENAI_FALLBACK_MODEL,
      temperature: 0,
      maxTokens: 900,
      jsonMode: true,
      userId: input.userId,
      tenantId: input.tenantId,
      timeoutMs: 4500,
    },
  );
  return { text, provider: 'openai', model: CHAT_LLM_TIER3_OPENAI_FALLBACK_MODEL };
}


function estimatePlannerCallCostUsd(provider: 'gemini' | 'openai', model: string, systemPrompt: string, userPrompt: string, outputText: string): number {
  const inputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
  const outputTokens = estimateTokens(outputText);
  const priced = computeModelUsageCostUsd(model, { inputTokens, outputTokens }, provider);
  if (!priced.pricingResolved) {
    logger.warn({ model, inputTokens, outputTokens }, 'Chat action planner cost estimate has unresolved model pricing');
  }
  return Number(priced.costUsd.toFixed(8));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}


function buildLlmSlotProvenance(
  input: ChatPlannerInput,
  args: Record<string, unknown>,
  requiredFields: string[],
  sourceType: ChatSlotProvenance['sourceType'] = 'planner',
  validation?: SlotValidationResult,
): Record<string, ChatSlotProvenance> {
  const provenance: Record<string, ChatSlotProvenance> = {};
  const failedSlots = new Set(Object.keys(validation?.errors ?? {}));
  const missingSlots = new Set(validation?.missing ?? []);
  for (const field of [...new Set([...requiredFields, ...Object.keys(args)])]) {
    if (args[field] == null || args[field] === '') continue;
    provenance[field] = makeSlotProvenance({
      slot: field,
      value: args[field],
      rawText: input.text,
      turnId: input.messageId,
      sourceType,
      normalizer: 'llm_structured_planner_v1',
      confidence: 0.72,
      validation: failedSlots.has(field) || missingSlots.has(field) ? 'failed' : 'passed',
    });
  }
  return provenance;
}

function provenanceSourceForRouteTier(routeTier?: ChatActionTelemetry['routeTier']): ChatSlotProvenance['sourceType'] {
  if (routeTier === 'tier1_classifier') return 'classifier';
  if (routeTier === 'tier3_reviewer') return 'reviewer';
  return 'planner';
}

// inferContentPlatform, inferProviderName, and extractTopic moved to
// skills/text-extractors.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0).

function retrievePlannerExamples(input: ChatPlannerInput, registry: ReturnType<typeof getChatActionRegistry>): Array<Record<string, unknown>> {
  const folded = foldCalendarText(input.text);
  const examples: Array<Record<string, unknown>> = [];
  for (const entry of registry) {
    const safe = buildLlmSafePromptSlice(entry);
    for (const example of safe.examples) {
      examples.push({
        skill: safe.skill,
        action: safe.action,
        text: example.text,
        locale: example.locale,
        expectedSlots: example.expectedSlots,
      });
    }
  }
  if (/\b(called|named|titled|chamado|t[ií]tulo)\b/.test(folded)) {
    examples.push({
      text: 'Create a task for tomorrow 9 am called Test chat',
      expected: { skill: 'tasks', action: 'create_task', title: 'Test chat', dueDateTime: 'tomorrow 09:00' },
    });
  }
  if (/\b(agenda do gmail|gmail agenda)\b/.test(folded)) {
    examples.push({
      text: 'Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo',
      expected: { skill: 'secretary_calendar', action: 'schedule_event', provider: 'google_calendar', title: 'igreja' },
    });
  }
  if (/\b[3-7]\s*(?:sessions?|workouts?|days?|treinos?|sessoes|sesiones|vezes)\b/.test(folded)
    && /\b(week|semana)\b/.test(folded)) {
    examples.push({
      text: 'Make it 4 sessions per week',
      expected: { skill: 'training', action: 'training_plan_create', slot: 'sessionsPerWeek', value: 4, requiresPendingAction: true },
    });
  }
  const seen = new Set<string>();
  return examples.filter((example) => {
    const key = JSON.stringify(example);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}
