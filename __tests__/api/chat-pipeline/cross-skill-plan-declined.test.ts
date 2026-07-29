// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M19 bridge-retirement safety terminal.
 *
 * Both action-planner passes precede this stage in the canonical runner. If
 * they decline a flag-on cross-skill turn, this deterministic terminal must
 * disclose that no action ran and ask for separated steps. It must never
 * acquire another model budget or fall through to the legacy prompt bridge.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const hoisted = vi.hoisted(() => ({
  persistExchange: vi.fn(),
  syncConversationStateForShortcut: vi.fn(),
  rememberChatActiveDomain: vi.fn(),
  recordChatStage: vi.fn(),
}));

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../../src/api/routes/chat-persistence', async () => ({
  ...(await vi.importActual('../../../src/api/routes/chat-persistence')),
  persistExchange: (...args: unknown[]) => hoisted.persistExchange(...args),
  syncConversationStateForShortcut: (...args: unknown[]) => hoisted.syncConversationStateForShortcut(...args),
}));

vi.mock('../../../src/api/routes/chat-message-context', async () => ({
  ...(await vi.importActual('../../../src/api/routes/chat-message-context')),
  rememberChatActiveDomain: (...args: unknown[]) => hoisted.rememberChatActiveDomain(...args),
}));

vi.mock('../../../src/services/chat-stage-trace', async () => ({
  ...(await vi.importActual('../../../src/services/chat-stage-trace')),
  recordChatStage: (...args: unknown[]) => hoisted.recordChatStage(...args),
}));

import { runChatMessagePipeline } from '../../../src/api/routes/chat-pipeline/runner';
import { crossSkillPlanDeclinedStage } from '../../../src/api/routes/chat-pipeline/stages/cross-skill-plan-declined';
import type { ChatStage, ChatTurnCtx } from '../../../src/api/routes/chat-pipeline/types';

const crossSkillDecision = {
  primaryDomain: 'finance',
  involvedSkills: ['finance', 'secretary'],
  intentKinds: ['action', 'cross_skill'],
  confidence: 0.94,
  reasonCodes: ['cross_skill_request'],
  explanation: 'Finance owns the receipt and Secretary owns the reminder.',
  ownership: {
    scheduleOwner: 'secretary',
    contentOwners: ['finance', 'secretary'],
    chatRole: 'coordinate_and_explain',
  },
  safety: {
    destructive: false,
    requiresConfirmation: false,
    explicitConfirmation: false,
    confirmationReasonCodes: [],
  },
  context: {
    shouldRefreshBeforeAnswer: false,
    staleContextRisk: false,
    ambiguousReference: false,
    tenantBoundaryMention: false,
  },
  clarify: null,
} as const;

const tail = (called: ReturnType<typeof vi.fn>): ChatStage => ({
  name: 'tail_sentinel',
  traceStages: [],
  canHandle: () => true,
  handle: async (ctx) => {
    called();
    ctx.res.json({ text: 'TAIL' });
    return { kind: 'respond' };
  },
});

function makeCtx(locale = 'en-US'): {
  ctx: ChatTurnCtx;
  json: ReturnType<typeof vi.fn>;
  ensureModelBudget: ReturnType<typeof vi.fn>;
  fallbackSample: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const ensureModelBudget = vi.fn(async () => true);
  const fallbackSample = vi.fn();
  const ctx = {
    req: { header: () => undefined, body: {} } as unknown as Request,
    res: { json } as unknown as Response,
    userId: 91,
    tenantId: 91,
    normalizedText: 'Log this receipt for 45 EUR and remind me Friday',
    normalizedTextLower: 'log this receipt for 45 eur and remind me friday',
    normalizedAttachments: [],
    scopedClientMessageId: 'conv-m19',
    userMessageId: 'user-m19',
    requestStartedAt: Date.now(),
    chatRequestId: 'req-m19',
    latency: {
      mark: vi.fn(),
      snapshot: vi.fn(() => ({ tier: 'tier1_fast_read', totalMs: 1, budgetMs: 100, withinBudget: true })),
    },
    ensureModelBudget,
    isNewUserFlow: false,
    recordDeterministicReadEvidence: vi.fn(),
    recordChatV2CompletionEvidenceForImmediateResponse: vi.fn(),
    bypassReadFastPathsForWriteIntent: false,
    chatCoreV2RouteLocale: locale,
    recordLegacyFallbackSample: fallbackSample,
    bypassNaturalLanguageTokenZeroForChatCoreV2: false,
    activeContext: null,
    preRoutingDecision: crossSkillDecision,
    turnContractEnabled: false,
    preTurnContract: null,
  } as unknown as ChatTurnCtx;
  return { ctx, json, ensureModelBudget, fallbackSample };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('cross_skill_plan_declined stage', () => {
  it('flag ON returns an honest deterministic terminal without another model budget or tail call', async () => {
    vi.stubEnv('AI_CROSS_SKILL_EXECUTION', 'true');
    const { ctx, json, ensureModelBudget, fallbackSample } = makeCtx();
    const tailCalled = vi.fn();

    const responded = await runChatMessagePipeline(ctx, [crossSkillPlanDeclinedStage, tail(tailCalled)]);

    expect(responded).toBe('cross_skill_plan_declined');
    expect(tailCalled).not.toHaveBeenCalled();
    expect(ensureModelBudget).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0]).toMatchObject({
      domain: 'finance',
      routeMethod: 'cross-skill-plan-declined',
      metadata: {
        type: 'chat_cross_skill_plan_declined',
        actionStatus: 'needs_clarification',
        involvedSkills: ['finance', 'secretary'],
        executedActions: 0,
        legacyBridgeRetired: true,
      },
    });
    expect(String(json.mock.calls[0][0].text)).toContain('I did not run any action');
    expect(fallbackSample).toHaveBeenCalledWith(false, {
      domain: 'finance',
      routeOwner: 'cross_skill_plan_declined',
      routeMethod: 'cross-skill-plan-declined',
    });
  });

  it.each([
    ['pt-BR', 'não executei nenhuma das ações'],
    ['es-419', 'I did not run any action'],
  ])('renders deterministic %s disclosure copy', async (locale, expected) => {
    vi.stubEnv('AI_CROSS_SKILL_EXECUTION', 'true');
    const { ctx, json } = makeCtx(locale);
    await crossSkillPlanDeclinedStage.handle(ctx);
    expect(String(json.mock.calls[0][0].text)).toContain(expected);
  });

  it('flag OFF is inert and preserves the existing tail path byte-for-byte', async () => {
    vi.stubEnv('AI_CROSS_SKILL_EXECUTION', 'false');
    const { ctx, json } = makeCtx();
    const tailCalled = vi.fn();
    const responded = await runChatMessagePipeline(ctx, [crossSkillPlanDeclinedStage, tail(tailCalled)]);
    expect(responded).toBe('tail_sentinel');
    expect(tailCalled).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({ text: 'TAIL' });
  });

  it('master kill restores the existing tail path even when the feature flag is set', () => {
    vi.stubEnv('AI_CROSS_SKILL_EXECUTION', 'true');
    vi.stubEnv('AI_ROUTING_MANIFEST_KILL', 'true');
    const { ctx } = makeCtx();
    expect(crossSkillPlanDeclinedStage.canHandle(ctx)).toBe(false);
  });

  it('does not intercept pseudo-cross-skill context with only one actionable owner', () => {
    vi.stubEnv('AI_CROSS_SKILL_EXECUTION', 'true');
    const { ctx } = makeCtx();
    ctx.preRoutingDecision = {
      ...crossSkillDecision,
      involvedSkills: ['finance', 'shared_context'],
    } as never;
    expect(crossSkillPlanDeclinedStage.canHandle(ctx)).toBe(false);
  });

  it('lets a pure cross-skill comparison continue to the safe primary read owner', async () => {
    vi.stubEnv('AI_CROSS_SKILL_EXECUTION', 'true');
    const { ctx } = makeCtx();
    ctx.normalizedText = 'Compare my training spend with meal costs';
    ctx.normalizedTextLower = ctx.normalizedText.toLowerCase();
    ctx.preRoutingDecision = {
      ...crossSkillDecision,
      involvedSkills: ['finance', 'training', 'cooking'],
      intentKinds: ['information', 'analysis', 'cross_skill'],
    } as never;
    expect(crossSkillPlanDeclinedStage.canHandle(ctx)).toBe(false);
  });
});
