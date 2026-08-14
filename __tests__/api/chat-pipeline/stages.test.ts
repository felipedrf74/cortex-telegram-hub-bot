/**
 * M10: per-stage unit tests — canHandle predicates (synthetic ctx, real
 * predicate implementations with controlled env) plus handle outcomes for
 * the pure context stages (turn_context patch fields, completion-evidence
 * res.json wrapper). Terminal handle outcomes for the response families are
 * covered end-to-end by the byte-parity replay net
 * (__tests__/api/chat-message-replay.test.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const hoisted = vi.hoisted(() => ({
  shouldGateReadFastPaths: vi.fn(() => false),
  completionEvidence: vi.fn(),
  deterministicReadEvidence: vi.fn(),
  legacyFallback: vi.fn(),
  legacyFallbackAttribution: vi.fn(),
  getUserLanguage: vi.fn(() => 'en-US'),
  setUserLanguage: vi.fn(),
  deterministicReadRoute: vi.fn(() => null),
}));

vi.mock('../../../src/services/chat-core-v2', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    shouldGateReadFastPathsForWriteIntent: (...args: unknown[]) => hoisted.shouldGateReadFastPaths(...args as []),
    incrementLegacyFallback: (...args: unknown[]) => hoisted.legacyFallback(...args as []),
    incrementLegacyFallbackAttribution: (...args: unknown[]) => hoisted.legacyFallbackAttribution(...args as []),
    tryBuildChatCoreV2DeterministicReadRoute: (...args: unknown[]) => hoisted.deterministicReadRoute(...args as []),
  };
});

vi.mock('../../../src/services/chat-v2-completion-evidence', async () => ({
  ...(await vi.importActual('../../../src/services/chat-v2-completion-evidence')),
  safeRecordChatV2CompletionEvidence: (...args: unknown[]) => hoisted.completionEvidence(...args as []),
}));

vi.mock('../../../src/services/chat-deterministic-read-evidence', async () => ({
  ...(await vi.importActual('../../../src/services/chat-deterministic-read-evidence')),
  safeRecordChatV2DeterministicReadEvidence: (...args: unknown[]) => hoisted.deterministicReadEvidence(...args as []),
}));

vi.mock('../../../src/services/user-service', async () => ({
  ...(await vi.importActual('../../../src/services/user-service')),
  getUserLanguageById: (...args: unknown[]) => hoisted.getUserLanguage(...args as []),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
  setUserLanguage: (...args: unknown[]) => hoisted.setUserLanguage(...args as []),
}));

vi.mock('../../../src/services/database', async () => ({
  ...(await vi.importActual('../../../src/services/database')),
  getDb: vi.fn(() => { throw new Error('db not needed in canHandle tests'); }),
}));

import { tokenZeroShortcutStage } from '../../../src/api/routes/chat-pipeline/stages/token-zero-shortcut';
import { createChatCoreV2DeterministicReadStage } from '../../../src/api/routes/chat-pipeline/stages/deterministic-read';
import { shadowRouteStage } from '../../../src/api/routes/chat-pipeline/stages/shadow-route';
import { completionEvidenceStage } from '../../../src/api/routes/chat-pipeline/stages/completion-evidence';
import { pendingWorkCancelStage } from '../../../src/api/routes/chat-pipeline/stages/pending-work-cancel';
import { actionGatewayStage } from '../../../src/api/routes/chat-pipeline/stages/action-gateway';
import { cachedCommandStage } from '../../../src/api/routes/chat-pipeline/stages/cached-command';
import { createActionPlannerStage } from '../../../src/api/routes/chat-pipeline/stages/action-planner';
import { attachmentStage } from '../../../src/api/routes/chat-pipeline/stages/attachment';
import { authenticatedIdentityStage } from '../../../src/api/routes/chat-pipeline/stages/authenticated-identity';
import { fastPathStage } from '../../../src/api/routes/chat-pipeline/stages/fast-path';
import { trainingPlanShortcutStage } from '../../../src/api/routes/chat-pipeline/stages/training-plan-shortcut';
import { preRoutingStage } from '../../../src/api/routes/chat-pipeline/stages/pre-routing';
import { internetResearchStage } from '../../../src/api/routes/chat-pipeline/stages/internet-research';
import { decisionShortcutStage } from '../../../src/api/routes/chat-pipeline/stages/decision-shortcut';
import { destructiveConfirmationHoldStage } from '../../../src/api/routes/chat-pipeline/stages/destructive-confirmation-hold';
import { v2LocalAnswerStage } from '../../../src/api/routes/chat-pipeline/stages/v2-local-answer';
import { unsupportedFallbackStage } from '../../../src/api/routes/chat-pipeline/stages/unsupported-fallback';
import { legacyTailStage } from '../../../src/api/routes/chat-pipeline/stages/legacy-tail';
import { idempotentReplayStage } from '../../../src/api/routes/chat-pipeline/stages/idempotent-replay';
import { idempotencyClaimStage } from '../../../src/api/routes/chat-pipeline/stages/idempotency-claim';
import { turnContextStage } from '../../../src/api/routes/chat-pipeline/stages/turn-context';
import type { ChatTurnCtx } from '../../../src/api/routes/chat-pipeline/types';

function ctxWith(overrides: Partial<ChatTurnCtx> & Record<string, unknown> = {}): ChatTurnCtx {
  return {
    req: {
      header: () => undefined,
      body: {},
    } as unknown as Request,
    res: {} as Response,
    userId: 42,
    tenantId: 42,
    normalizedText: 'hello there',
    normalizedTextLower: 'hello there',
    normalizedAttachments: [],
    scopedClientMessageId: null,
    userMessageId: 'msg-user-1',
    requestStartedAt: 1_752_000_000_000,
    chatRequestId: 'req-test',
    latency: { mark: vi.fn(), snapshot: vi.fn(() => ({})) } as unknown as ChatTurnCtx['latency'],
    ensureModelBudget: vi.fn(async () => true),
    bypassReadFastPathsForWriteIntent: false,
    bypassNaturalLanguageTokenZeroForChatCoreV2: false,
    chatCoreV2RouteLocale: 'en-US',
    ...overrides,
  } as ChatTurnCtx;
}

afterEach(() => {
  vi.clearAllMocks();
  hoisted.getUserLanguage.mockReturnValue('en-US');
  hoisted.deterministicReadRoute.mockReturnValue(null);
  delete process.env.CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED;
  delete process.env.CHAT_RESEARCH_ROUTER_ENABLED;
});

describe('canHandle predicates', () => {
  it('always-probing stages return true', () => {
    expect(idempotentReplayStage.canHandle(ctxWith())).toBe(true);
    expect(idempotencyClaimStage.canHandle(ctxWith())).toBe(true);
    expect(turnContextStage.canHandle(ctxWith())).toBe(true);
    expect(completionEvidenceStage.canHandle(ctxWith())).toBe(true);
    expect(authenticatedIdentityStage.canHandle(ctxWith())).toBe(true);
    expect(trainingPlanShortcutStage.canHandle(ctxWith())).toBe(true);
    expect(preRoutingStage.canHandle(ctxWith())).toBe(true);
    expect(unsupportedFallbackStage.canHandle(ctxWith())).toBe(true);
    expect(legacyTailStage.canHandle(ctxWith())).toBe(true);
  });

  it('token_zero_shortcut requires text, no attachments, and no bypass flags', () => {
    expect(tokenZeroShortcutStage.canHandle(ctxWith())).toBe(true);
    expect(tokenZeroShortcutStage.canHandle(ctxWith({ normalizedText: '' }))).toBe(false);
    expect(tokenZeroShortcutStage.canHandle(ctxWith({ normalizedAttachments: [{} as never] }))).toBe(false);
    expect(tokenZeroShortcutStage.canHandle(ctxWith({ bypassReadFastPathsForWriteIntent: true }))).toBe(false);
    expect(tokenZeroShortcutStage.canHandle(ctxWith({ bypassNaturalLanguageTokenZeroForChatCoreV2: true }))).toBe(false);
  });

  it('deterministic-read variants share the base guard; only gated honors the write-intent bypass', () => {
    const early = createChatCoreV2DeterministicReadStage('early');
    const gated = createChatCoreV2DeterministicReadStage('gated');
    expect(early.canHandle(ctxWith())).toBe(true);
    expect(gated.canHandle(ctxWith())).toBe(true);
    expect(early.canHandle(ctxWith({ normalizedText: '/day', normalizedTextLower: '/day' }))).toBe(false);
    expect(gated.canHandle(ctxWith({ normalizedText: '/day', normalizedTextLower: '/day' }))).toBe(false);
    expect(early.canHandle(ctxWith({ bypassReadFastPathsForWriteIntent: true }))).toBe(true);
    expect(gated.canHandle(ctxWith({ bypassReadFastPathsForWriteIntent: true }))).toBe(false);
    expect(early.canHandle(ctxWith({ normalizedAttachments: [{} as never] }))).toBe(false);
  });

  it('uses the resolved English response locale for the early read after a retired Spanish override', async () => {
    hoisted.getUserLanguage.mockReturnValue('pt-BR');
    const early = createChatCoreV2DeterministicReadStage('early');

    const result = await early.handle(ctxWith({
      normalizedText: 'Muestra mis tareas de hoy',
      normalizedTextLower: 'muestra mis tareas de hoy',
      chatCoreV2RouteLocale: 'en-US',
    }));

    expect(result).toEqual({ kind: 'continue' });
    expect(hoisted.deterministicReadRoute).toHaveBeenCalledWith(expect.objectContaining({
      normalizedText: 'Muestra mis tareas de hoy',
      locale: 'en-US',
    }));
    expect(hoisted.getUserLanguage).not.toHaveBeenCalled();
  });

  it('shadow_route_recording follows the runtime flag (default off)', () => {
    expect(shadowRouteStage.canHandle(ctxWith())).toBe(false);
    process.env.CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED = 'true';
    expect(shadowRouteStage.canHandle(ctxWith())).toBe(true);
  });

  it('pending_work_cancel requires a cancellation turn without attachments', () => {
    expect(pendingWorkCancelStage.canHandle(ctxWith({ normalizedText: 'cancel', normalizedTextLower: 'cancel' }))).toBe(true);
    expect(pendingWorkCancelStage.canHandle(ctxWith())).toBe(false);
    expect(pendingWorkCancelStage.canHandle(ctxWith({
      normalizedText: 'cancel',
      normalizedTextLower: 'cancel',
      normalizedAttachments: [{} as never],
    }))).toBe(false);
  });

  it('action_gateway and planner passes skip content-script shortcuts and attachments', () => {
    const planner = createActionPlannerStage('deterministic');
    const model = createActionPlannerStage('model');
    for (const stage of [actionGatewayStage, planner, model]) {
      expect(stage.canHandle(ctxWith())).toBe(true);
      expect(stage.canHandle(ctxWith({ normalizedText: '' }))).toBe(false);
      expect(stage.canHandle(ctxWith({ normalizedAttachments: [{} as never] }))).toBe(false);
      expect(stage.canHandle(ctxWith({
        normalizedText: 'write a script about morning routines',
        normalizedTextLower: 'write a script about morning routines',
      }))).toBe(false);
    }
  });

  it('cached_command requires text without attachments', () => {
    expect(cachedCommandStage.canHandle(ctxWith())).toBe(true);
    expect(cachedCommandStage.canHandle(ctxWith({ normalizedText: '' }))).toBe(false);
    expect(cachedCommandStage.canHandle(ctxWith({ normalizedAttachments: [{} as never] }))).toBe(false);
  });

  it('attachment stage requires at least one attachment', () => {
    expect(attachmentStage.canHandle(ctxWith())).toBe(false);
    expect(attachmentStage.canHandle(ctxWith({ normalizedAttachments: [{} as never] }))).toBe(true);
  });

  it('fast_path honors the write-intent read bypass', () => {
    expect(fastPathStage.canHandle(ctxWith())).toBe(true);
    expect(fastPathStage.canHandle(ctxWith({ bypassReadFastPathsForWriteIntent: true }))).toBe(false);
  });

  it('internet_research requires the flag (default on) plus a web-grounded research contract', () => {
    const contractCtx = ctxWith({
      preTurnContract: {
        routeKind: 'internet_research',
        groundingRequired: 'web',
      } as never,
    });
    expect(internetResearchStage.canHandle(contractCtx)).toBe(true);
    process.env.CHAT_RESEARCH_ROUTER_ENABLED = 'false';
    expect(internetResearchStage.canHandle(contractCtx)).toBe(false);
    delete process.env.CHAT_RESEARCH_ROUTER_ENABLED;
    expect(internetResearchStage.canHandle(ctxWith({ preTurnContract: null }))).toBe(false);
    expect(internetResearchStage.canHandle(ctxWith({
      preTurnContract: { routeKind: 'internet_research', groundingRequired: 'local_only' } as never,
    }))).toBe(false);
  });

  it('decision_confirmation_shortcut matches explicit acceptance text only', () => {
    expect(decisionShortcutStage.canHandle(ctxWith({ normalizedTextLower: 'confirm this decision' }))).toBe(true);
    expect(decisionShortcutStage.canHandle(ctxWith({ normalizedTextLower: 'hello there' }))).toBe(false);
  });

  it('destructive_confirmation_hold requires confirmation-needed without explicit confirmation', () => {
    const holdCtx = (requiresConfirmation: boolean, explicitConfirmation: boolean) => ctxWith({
      preRoutingDecision: {
        safety: { requiresConfirmation, explicitConfirmation },
      } as never,
    });
    expect(destructiveConfirmationHoldStage.canHandle(holdCtx(true, false))).toBe(true);
    expect(destructiveConfirmationHoldStage.canHandle(holdCtx(true, true))).toBe(false);
    expect(destructiveConfirmationHoldStage.canHandle(holdCtx(false, false))).toBe(false);
  });

  it('chat_core_v2_local_answer skips slash commands, attachments, and high-risk turns', () => {
    expect(v2LocalAnswerStage.canHandle(ctxWith())).toBe(true);
    expect(v2LocalAnswerStage.canHandle(ctxWith({ normalizedText: '/day', normalizedTextLower: '/day' }))).toBe(false);
    expect(v2LocalAnswerStage.canHandle(ctxWith({ normalizedAttachments: [{} as never] }))).toBe(false);
    expect(v2LocalAnswerStage.canHandle(ctxWith({ normalizedText: '' }))).toBe(false);
    expect(v2LocalAnswerStage.canHandle(ctxWith({
      preTurnContract: { riskClass: 'high' } as never,
    }))).toBe(false);
    expect(v2LocalAnswerStage.canHandle(ctxWith({
      preTurnContract: { riskClass: 'destructive' } as never,
    }))).toBe(false);
  });
});

describe('turn_context handle', () => {
  it('patches the prepared context fields in monolith order', async () => {
    const result = await turnContextStage.handle(ctxWith());
    expect(result.kind).toBe('continue');
    const patch = (result as { kind: 'continue'; patch: Partial<ChatTurnCtx> }).patch;
    expect(typeof patch.recordDeterministicReadEvidence).toBe('function');
    expect(typeof patch.recordChatV2CompletionEvidenceForImmediateResponse).toBe('function');
    expect(typeof patch.recordLegacyFallbackSample).toBe('function');
    expect(patch.bypassReadFastPathsForWriteIntent).toBe(false);
    expect(patch.bypassNaturalLanguageTokenZeroForChatCoreV2).toBe(false);
    expect(patch.chatCoreV2RouteLocale).toBe('en');
    expect(hoisted.shouldGateReadFastPaths).toHaveBeenCalledTimes(1);
  });

  it('skips the write-intent gate probe for attachment turns', async () => {
    const result = await turnContextStage.handle(ctxWith({ normalizedAttachments: [{} as never] }));
    const patch = (result as { kind: 'continue'; patch: Partial<ChatTurnCtx> }).patch;
    expect(patch.bypassReadFastPathsForWriteIntent).toBe(false);
    expect(hoisted.shouldGateReadFastPaths).not.toHaveBeenCalled();
  });

  it('attributes a retired Spanish override to the resolved English response locale without rewriting the profile', async () => {
    hoisted.getUserLanguage.mockReturnValue('pt-BR');
    const req = {
      header: (name: string) => name.toLowerCase() === 'x-language' ? 'es-419' : undefined,
      body: {},
    } as unknown as Request;
    const result = await turnContextStage.handle(ctxWith({
      req,
      normalizedText: 'Muestra mis tareas de hoy',
      normalizedTextLower: 'muestra mis tareas de hoy',
    }));
    const patch = (result as { kind: 'continue'; patch: Partial<ChatTurnCtx> }).patch;

    expect(patch.chatCoreV2RouteLocale).toBe('en');
    patch.recordChatV2CompletionEvidenceForImmediateResponse?.({ text: 'Here are your tasks.' });
    expect(hoisted.completionEvidence).toHaveBeenCalledWith(expect.objectContaining({
      userLanguage: 'en',
      responseLocale: 'en',
    }));
    expect(hoisted.setUserLanguage).not.toHaveBeenCalled();
  });

  it.each([
    'Crea una tarea llamada comprar leche',
    'Cancela la tarea comprar leche',
    'Elimina la tarea comprar leche',
  ])(
    'maps a headerless retired-Spanish command to English instead of inheriting the Portuguese profile: %s',
    async (message) => {
      hoisted.getUserLanguage.mockReturnValue('pt-BR');
      const req = {
        header: () => undefined,
        body: {},
      } as unknown as Request;

      const result = await turnContextStage.handle(ctxWith({
        req,
        normalizedText: message,
        normalizedTextLower: message.toLowerCase(),
      }));
      const patch = (result as { kind: 'continue'; patch: Partial<ChatTurnCtx> }).patch;

      expect(patch.chatCoreV2RouteLocale).toBe('en');
      expect(hoisted.setUserLanguage).not.toHaveBeenCalled();
    },
  );

  it.each(['Spanish', 'Español', 'Castellano'])(
    'maps the named retired %s header to English even for neutral text and a Portuguese profile',
    async (headerValue) => {
      hoisted.getUserLanguage.mockReturnValue('pt-BR');
      const req = {
        header: (name: string) => name.toLowerCase() === 'x-language' ? headerValue : undefined,
        body: {},
      } as unknown as Request;

      const result = await turnContextStage.handle(ctxWith({
        req,
        normalizedText: '12345',
        normalizedTextLower: '12345',
      }));
      const patch = (result as { kind: 'continue'; patch: Partial<ChatTurnCtx> }).patch;

      expect(patch.chatCoreV2RouteLocale).toBe('en');
      expect(hoisted.setUserLanguage).not.toHaveBeenCalled();
    },
  );
});

describe('completion_evidence handle', () => {
  it('wraps res.json to record completion evidence and continues', async () => {
    const json = vi.fn().mockReturnValue('sent');
    const res = { json } as unknown as Response;
    const ctx = ctxWith({ res });
    const result = await completionEvidenceStage.handle(ctx);
    expect(result.kind).toBe('continue');
    expect(ctx.res.json).not.toBe(json);
    const out = (ctx.res.json as (body: unknown) => unknown)({ text: 'hi' });
    expect(out).toBe('sent');
    expect(json).toHaveBeenCalledWith({ text: 'hi' });
    expect(hoisted.completionEvidence).toHaveBeenCalledTimes(1);
    expect(hoisted.completionEvidence.mock.calls[0][0]).toMatchObject({
      tenantId: 42,
      userId: 42,
      requestId: 'req-test',
      responseLocale: 'en-US',
      response: { text: 'hi' },
    });
  });
});
