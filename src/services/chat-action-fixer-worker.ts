// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { config } from '../config';
import { trackedCreate } from '../portal/anthropic-hook';
import { logger } from '../utils/logger';
import { enqueueJob, processPendingJobs, type JobHandler, type JobRecord } from './background-job-queue';
import { createLazyAnthropicClient } from './anthropic-lazy-client';
import { createDecisionIntent } from './decision-center';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep, ChatStepExecutionResult } from './chat/types';
import {
  recordAiAutomationEligibilitySkip,
  resolveAiAutomationEligibility,
} from './ai-automation-policy';
import { AiBudgetError, withAiBudgetReservation } from './cost-guardrail';
import { assertAgentQueuedJobHandlerRuntimeParity } from './agent-job-manifest';

export const CHAT_ACTION_FIXER_JOB_TYPE = 'chat_action_fixer_review';

export interface ChatActionFixerPayload extends Record<string, unknown> {
  userId: number;
  tenantId: number;
  conversationId: string;
  messageId: string;
  planner: string;
  redactedText: string;
  originalStep: Record<string, unknown>;
  errorReason: string;
  providerReadBack: Record<string, unknown> | null;
  riskClass: string | null;
  sourceSkill: string;
  action: string;
}

export interface ChatActionFixerProposal {
  proposed_step: ChatPlanStep | null;
  reasoning: string;
}

export interface EnqueueChatActionFixerReviewInput {
  input: ChatPlannerInput;
  plan: ChatActionPlan;
  step: ChatPlanStep;
  result: ChatStepExecutionResult;
}

const client = createLazyAnthropicClient({ maxRetries: 0 });

export function enqueueChatActionFixerReview(
  review: EnqueueChatActionFixerReviewInput,
  db?: Database.Database,
): JobRecord {
  const payload = buildFixerPayload(review);
  return enqueueJob({
    tenantId: review.input.tenantId,
    userId: review.input.userId,
    jobType: CHAT_ACTION_FIXER_JOB_TYPE,
    payload,
    priority: 35,
    maxAttempts: 3,
    idempotencyKey: [
      review.input.conversationId,
      review.input.messageId,
      review.step.stepId,
      review.result.error ?? 'unknown_error',
    ].join(':'),
    correlationId: review.input.messageId,
  }, db);
}

export function buildChatActionFixerJobHandler(options: {
  proposeCorrection?: (payload: ChatActionFixerPayload) => Promise<ChatActionFixerProposal> | ChatActionFixerProposal;
  db?: Database.Database;
} = {}): JobHandler {
  return {
    jobType: CHAT_ACTION_FIXER_JOB_TYPE,
    idempotent: true,
    async handle(job: JobRecord) {
      const payload = normalizeFixerPayload(job.payload, job);
      const proposal = isFreshConfirmationRequired(payload)
        ? {
          proposed_step: null,
          reasoning: 'This action is destructive or high risk, so Nexus requires a fresh user confirmation before any retry.',
        }
        : await (options.proposeCorrection ?? callAnthropicChatActionFixer)(payload);
      const safeProposal = sanitizeFixerProposal(payload, proposal);
      if (!safeProposal.proposed_step) {
        logger.info({
          jobId: job.jobId,
          tenantId: job.tenantId,
          userId: job.userId,
          sourceSkill: payload.sourceSkill,
          action: payload.action,
          reason: safeProposal.reasoning.slice(0, 180),
        }, 'Chat action fixer declined to propose an executable correction');
        return;
      }
      await createChatFixerDecision(job, payload, safeProposal);
    },
  };
}

export async function processChatActionFixerJobs(options: {
  limit?: number;
  lockOwner?: string;
  db?: Database.Database;
  disabled?: boolean;
  proposeCorrection?: (payload: ChatActionFixerPayload) => Promise<ChatActionFixerProposal> | ChatActionFixerProposal;
} = {}): Promise<{ completed: number; failed: number; deadLetter: number; skipped: number }> {
  const handlers = [buildChatActionFixerJobHandler({
    proposeCorrection: options.proposeCorrection,
    db: options.db,
  })];
  assertAgentQueuedJobHandlerRuntimeParity(handlers, 'chat-action-fixer');
  return processPendingJobs(handlers, {
    limit: options.limit ?? 5,
    lockOwner: options.lockOwner ?? `chat-action-fixer:${process.pid}`,
    db: options.db,
    disabled: options.disabled || process.env.CHAT_ACTION_FIXER_WORKER_DISABLED === '1',
  });
}

export function buildFixerPayload(review: EnqueueChatActionFixerReviewInput): ChatActionFixerPayload {
  return {
    userId: review.input.userId,
    tenantId: review.input.tenantId,
    conversationId: review.input.conversationId,
    messageId: review.input.messageId,
    planner: review.plan.planner,
    redactedText: redactFixerText(review.input.text ?? ''),
    originalStep: sanitizeStepForFixer(review.step),
    errorReason: sanitizeScalar(review.result.error ?? 'unknown_error', 200),
    providerReadBack: sanitizeProviderReadBack(review.result.result),
    riskClass: review.step.riskClass ?? review.step.risk ?? null,
    sourceSkill: review.step.skill,
    action: review.step.action,
  };
}

export async function callAnthropicChatActionFixer(payload: ChatActionFixerPayload): Promise<ChatActionFixerProposal> {
  const eligibility = resolveAiAutomationEligibility(payload.userId, payload.sourceSkill);
  if (!eligibility.allowed) {
    recordAiAutomationEligibilitySkip(payload.userId, eligibility, {
      jobName: 'chat_action_fixer',
      baseCategory: 'chat_action_fixer',
    });
    logger.info(
      {
        userId: payload.userId,
        tenantId: payload.tenantId,
        sourceSkill: payload.sourceSkill,
        reason: eligibility.reason,
        entitlementSource: eligibility.entitlement.source,
      },
      'Chat action fixer skipped before provider work: automation is not eligible',
    );
    return {
      proposed_step: null,
      reasoning: 'The model-backed background review is not available for this account.',
    };
  }

  const prompt = buildChatActionFixerPrompt(payload);
  let response;
  try {
    response = await withAiBudgetReservation({
      userId: payload.userId,
      requestSource: 'automation',
      baseCategory: 'chat_action_fixer',
      jobName: 'chat_action_fixer',
      automationPriority: 'other',
    }, () => trackedCreate(client.get(), {
      model: process.env.CHAT_ACTION_FIXER_MODEL || config.anthropic.model,
      max_tokens: 900,
      temperature: 0,
      system: 'You are a Nexus Hub reliability reviewer. Return strict JSON only and never execute actions.',
      messages: [{ role: 'user', content: prompt }],
    }, 'chat_action_fixer', {
      userId: payload.userId,
      tenantId: payload.tenantId,
      timeoutMs: 30_000,
    }));
  } catch (err) {
    if (!(err instanceof AiBudgetError)) throw err;
    logger.info(
      {
        userId: payload.userId,
        tenantId: payload.tenantId,
        code: err.decision.code,
        window: err.decision.window,
      },
      'Chat action fixer deferred by the automation AI budget',
    );
    return {
      proposed_step: null,
      reasoning: 'The background review was deferred until the AI allowance resets.',
    };
  }
  return parseChatActionFixerResponse(response.content
    .filter((block) => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n'));
}

export function buildChatActionFixerPrompt(payload: ChatActionFixerPayload): string {
  const templatePath = path.join(process.cwd(), 'prompts', 'chat-action-fixer.md');
  const template = readFileSync(templatePath, 'utf8');
  return template
    .replace('{{redactedText}}', payload.redactedText)
    .replace('{{originalStep}}', JSON.stringify(payload.originalStep))
    .replace('{{errorReason}}', payload.errorReason)
    .replace('{{providerReadBack}}', JSON.stringify(payload.providerReadBack ?? {}));
}

export function parseChatActionFixerResponse(text: string): ChatActionFixerProposal {
  const trimmed = text.trim();
  const jsonText = trimmed.startsWith('{')
    ? trimmed
    : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
    ? sanitizeScalar(parsed.reasoning, 500)
    : 'Fixer returned a proposal without reasoning.';
  const proposed = parsed.proposed_step && typeof parsed.proposed_step === 'object' && !Array.isArray(parsed.proposed_step)
    ? parsed.proposed_step as Record<string, unknown>
    : null;
  return {
    proposed_step: proposed ? normalizeProposedStep(proposed) : null,
    reasoning,
  };
}

function normalizeProposedStep(record: Record<string, unknown>): ChatPlanStep | null {
  const skill = typeof record.skill === 'string' ? record.skill : null;
  const action = typeof record.action === 'string' ? record.action : null;
  const stepId = typeof record.stepId === 'string' ? record.stepId : 'fixer_step_1';
  const risk = typeof record.risk === 'string' ? record.risk : 'safe_write';
  const args = record.args && typeof record.args === 'object' && !Array.isArray(record.args)
    ? sanitizeRecord(record.args as Record<string, unknown>, 4)
    : {};
  if (!skill || !action) return null;
  const type = record.type === 'answer' || record.type === 'clarification'
    ? record.type
    : action;
  return {
    stepId,
    skill: skill as ChatPlanStep['skill'],
    type: type as ChatPlanStep['type'],
    action: action as ChatPlanStep['action'],
    risk: risk as ChatPlanStep['risk'],
    riskClass: typeof record.riskClass === 'string' ? record.riskClass as ChatPlanStep['riskClass'] : undefined,
    provider: typeof record.provider === 'string' ? record.provider as ChatPlanStep['provider'] : undefined,
    args,
    requiredArgsPresent: record.requiredArgsPresent === false ? false : true,
    idempotencyKey: typeof record.idempotencyKey === 'string' ? record.idempotencyKey : `fixer:${hashJson({ skill, action, args })}`,
    dependsOnStepIds: Array.isArray(record.dependsOnStepIds)
      ? record.dependsOnStepIds.filter((value): value is string => typeof value === 'string').slice(0, 5)
      : undefined,
    verification: record.verification && typeof record.verification === 'object' && !Array.isArray(record.verification)
      ? {
        required: (record.verification as Record<string, unknown>).required !== false,
        method: ((record.verification as Record<string, unknown>).method === 'local_read_back'
          || (record.verification as Record<string, unknown>).method === 'none')
          ? (record.verification as Record<string, 'local_read_back' | 'none'>).method
          : 'provider_read_back',
        expectedFields: (record.verification as Record<string, unknown>).expectedFields && typeof (record.verification as Record<string, unknown>).expectedFields === 'object'
          ? sanitizeRecord((record.verification as Record<string, unknown>).expectedFields as Record<string, unknown>, 3)
          : undefined,
      }
      : { required: true, method: 'provider_read_back' },
  };
}

function sanitizeFixerProposal(payload: ChatActionFixerPayload, proposal: ChatActionFixerProposal): ChatActionFixerProposal {
  if (!proposal.proposed_step) return { proposed_step: null, reasoning: sanitizeScalar(proposal.reasoning, 500) };
  if (isFreshConfirmationRequired(payload) || stepRequiresFreshConfirmation(proposal.proposed_step)) {
    return {
      proposed_step: null,
      reasoning: 'Fixer refused to propose an executable step because the correction is destructive or high risk and needs fresh user confirmation.',
    };
  }
  if (hasInventedIdentifier(payload, proposal.proposed_step)) {
    return {
      proposed_step: null,
      reasoning: 'Fixer refused the proposal because it introduced an identifier that was not present in the failed action or provider read-back.',
    };
  }
  return {
    proposed_step: proposal.proposed_step,
    reasoning: sanitizeScalar(proposal.reasoning, 500),
  };
}

async function createChatFixerDecision(
  job: JobRecord,
  payload: ChatActionFixerPayload,
  proposal: ChatActionFixerProposal,
): Promise<void> {
  const title = `Review a safer ${humanize(payload.action)} retry`;
  const body = `Nexus found why the ${humanize(payload.action)} action did not verify and prepared a safer correction for you to review.`;
  await createDecisionIntent({
    userId: payload.userId,
    tenantId: payload.tenantId,
    sourceSkill: 'chat',
    type: 'decision_required',
    priority: 'active',
    relatedEntityId: job.jobId,
    relatedEntityType: CHAT_ACTION_FIXER_JOB_TYPE,
    title,
    body,
    actionButtons: [
      { id: 'accept_chat_action_fix', label: 'Accept correction', style: 'primary', mutating: true },
      { id: 'dismiss', label: 'Not now', style: 'secondary', mutating: true },
    ],
    deeplink: `nexus://decision-center/${encodeURIComponent(job.jobId)}`,
    dedupeKey: `chat-action-fixer:${payload.tenantId}:${payload.userId}:${payload.messageId}:${payload.sourceSkill}:${payload.action}`,
    requiresUserAction: true,
    deliveryPolicy: 'in_app_only',
    privacyPolicy: 'private_content',
    decisionContext: {
      entityTitle: `${humanize(payload.sourceSkill)} ${humanize(payload.action)}`,
      sourceState: 'requires_fixer_review',
      reasonCodes: ['requires_fixer_review', 'fresh_confirmation_required'],
    },
    visibilityScope: 'user_private',
  });
}

function normalizeFixerPayload(payload: Record<string, unknown>, job: JobRecord): ChatActionFixerPayload {
  return {
    userId: typeof payload.userId === 'number' ? payload.userId : job.userId ?? 0,
    tenantId: typeof payload.tenantId === 'number' ? payload.tenantId : job.tenantId,
    conversationId: typeof payload.conversationId === 'string' ? payload.conversationId : '',
    messageId: typeof payload.messageId === 'string' ? payload.messageId : job.jobId,
    planner: typeof payload.planner === 'string' ? payload.planner : 'unknown',
    redactedText: typeof payload.redactedText === 'string' ? payload.redactedText : '',
    originalStep: payload.originalStep && typeof payload.originalStep === 'object' && !Array.isArray(payload.originalStep)
      ? payload.originalStep as Record<string, unknown>
      : {},
    errorReason: typeof payload.errorReason === 'string' ? payload.errorReason : 'unknown_error',
    providerReadBack: payload.providerReadBack && typeof payload.providerReadBack === 'object' && !Array.isArray(payload.providerReadBack)
      ? payload.providerReadBack as Record<string, unknown>
      : null,
    riskClass: typeof payload.riskClass === 'string' ? payload.riskClass : null,
    sourceSkill: typeof payload.sourceSkill === 'string' ? payload.sourceSkill : 'chat',
    action: typeof payload.action === 'string' ? payload.action : 'unknown_action',
  };
}

function isFreshConfirmationRequired(payload: ChatActionFixerPayload): boolean {
  const risk = String(payload.riskClass ?? '').toLowerCase();
  const attemptedRisk = String(payload.originalStep.risk ?? '').toLowerCase();
  return risk === 'r3'
    || risk === 'r4'
    || attemptedRisk === 'destructive'
    || attemptedRisk === 'financial'
    || attemptedRisk === 'admin_security';
}

function stepRequiresFreshConfirmation(step: ChatPlanStep): boolean {
  const risk = String(step.risk ?? '').toLowerCase();
  const riskClass = String(step.riskClass ?? '').toLowerCase();
  return riskClass === 'r3' || riskClass === 'r4' || risk === 'destructive' || risk === 'financial' || risk === 'admin_security';
}

function hasInventedIdentifier(payload: ChatActionFixerPayload, step: ChatPlanStep): boolean {
  const allowed = new Set<string>();
  collectIdentifierValues(payload.originalStep, allowed);
  collectIdentifierValues(payload.providerReadBack ?? {}, allowed);
  const proposed = new Set<string>();
  collectIdentifierValues(step.args, proposed);
  for (const value of proposed) {
    if (!allowed.has(value)) return true;
  }
  return false;
}

function collectIdentifierValues(value: unknown, output: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(^id$|id$|_id$|Id$|providerObjectId|transactionId|eventId|taskId)$/i.test(key) && typeof nested === 'string' && nested.trim()) {
      output.add(nested.trim());
    }
    if (nested && typeof nested === 'object') collectIdentifierValues(nested, output);
  }
}

function sanitizeStepForFixer(step: ChatPlanStep | null): Record<string, unknown> {
  if (!step) return {};
  return {
    stepId: step.stepId,
    skill: step.skill,
    type: step.type,
    action: step.action,
    risk: step.risk,
    riskClass: step.riskClass ?? null,
    provider: step.provider ?? null,
    args: sanitizeRecord(step.args, 4),
    requiredArgsPresent: step.requiredArgsPresent,
    idempotencyKeyHash: hashJson(step.idempotencyKey),
    verification: {
      required: step.verification.required,
      method: step.verification.method,
      expectedFields: sanitizeRecord(step.verification.expectedFields ?? {}, 3),
    },
  };
}

function sanitizeProviderReadBack(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  return sanitizeRecord(result as Record<string, unknown>, 4);
}

function sanitizeRecord(record: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth <= 0) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record).slice(0, 60)) {
    if (/token|secret|password|authorization|cookie|credential/i.test(key)) {
      safe[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      safe[key] = sanitizeScalar(value, 300);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      safe[key] = value.slice(0, 20).map((item) => typeof item === 'string'
        ? sanitizeScalar(item, 200)
        : item && typeof item === 'object'
          ? sanitizeRecord(item as Record<string, unknown>, depth - 1)
          : item);
    } else if (typeof value === 'object') {
      safe[key] = sanitizeRecord(value as Record<string, unknown>, depth - 1);
    }
  }
  return safe;
}

function redactFixerText(text: string): string {
  return sanitizeScalar(text, 500)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:sk|pk|xox|ya29|ghp|github_pat|Bearer)[A-Za-z0-9._:-]{12,}\b/g, '[token]')
    .replace(/\b\d{12,19}\b/g, '[number]');
}

function sanitizeScalar(value: string, maxLength: number): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 16);
}
