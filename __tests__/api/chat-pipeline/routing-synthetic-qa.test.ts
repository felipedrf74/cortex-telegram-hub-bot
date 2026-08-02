// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const hoisted = vi.hoisted(() => ({
  runShadowHook: vi.fn(),
  recordStage: vi.fn(),
}));

vi.mock('../../../src/services/chat-core-v2', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runChatCoreV2ShadowRouteHook: (...args: unknown[]) => hoisted.runShadowHook(...args),
}));

vi.mock('../../../src/services/chat-stage-trace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordChatStage: (...args: unknown[]) => hoisted.recordStage(...args),
}));

vi.mock('../../../src/services/user-service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUserTimezoneById: vi.fn(() => 'Europe/Lisbon'),
}));

import { routingSyntheticQaStage } from '../../../src/api/routes/chat-pipeline/stages/routing-synthetic-qa';
import { idempotencyClaimStage } from '../../../src/api/routes/chat-pipeline/stages/idempotency-claim';
import type { ChatTurnCtx } from '../../../src/api/routes/chat-pipeline/types';

const PROVENANCE = {
  contractVersion: 'routing-synthetic-qa-v1' as const,
  trafficClass: 'owner_authorized_synthetic_staging_qa' as const,
  manifestSha256: `sha256:${'a'.repeat(64)}`,
  surface: 'classifierKeyword' as const,
  ordinal: 1,
  plannedTurns: 200 as const,
  turnId: `routing-synthetic-qa-v1:${'a'.repeat(64)}:classifierKeyword:001`,
  locale: 'en-US',
};

function buildCtx(overrides: Partial<ChatTurnCtx> = {}) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const ensureModelBudget = vi.fn(async () => true);
  const ctx = {
    req: { header: vi.fn(), body: {} } as unknown as Request,
    res: { json, status } as unknown as Response,
    userId: 1_000_050,
    tenantId: 1_000_050,
    normalizedText: 'what should I focus on before my next product launch?',
    normalizedTextLower: 'what should i focus on before my next product launch?',
    normalizedAttachments: [],
    scopedClientMessageId: PROVENANCE.turnId,
    userMessageId: `msg-user-${PROVENANCE.turnId}`,
    requestStartedAt: Date.parse('2026-08-02T17:00:00.000Z'),
    chatRequestId: 'routing-synthetic-qa-request-1',
    latency: { mark: vi.fn(), snapshot: vi.fn(() => ({})) } as unknown as ChatTurnCtx['latency'],
    ensureModelBudget,
    // Chat Core canonicalizes the transport locale en-US to the runtime
    // response locale en; the provenance retains the manifested en-US value.
    chatCoreV2RouteLocale: 'en',
    routingSyntheticQa: PROVENANCE,
    ...overrides,
  } as ChatTurnCtx;
  return { ctx, json, status, ensureModelBudget };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('routing synthetic QA terminal stage', () => {
  it('is gated only by validated routing synthetic QA context', () => {
    expect(routingSyntheticQaStage.canHandle(buildCtx().ctx)).toBe(true);
    expect(routingSyntheticQaStage.canHandle(buildCtx({ routingSyntheticQa: null }).ctx)).toBe(false);
  });

  it('skips the normal chat idempotency claim so QA leaves no abandoned lifecycle rows', () => {
    expect(idempotencyClaimStage.canHandle(buildCtx().ctx)).toBe(false);
    expect(idempotencyClaimStage.canHandle(buildCtx({ routingSyntheticQa: null }).ctx)).toBe(true);
  });

  it('fails closed before recording when resolved locale or attachments differ from the manifest request', async () => {
    for (const overrides of [
      { chatCoreV2RouteLocale: 'pt-BR' },
      { normalizedAttachments: [{ id: 'unexpected' }] as unknown as ChatTurnCtx['normalizedAttachments'] },
    ]) {
      const { ctx, status, json, ensureModelBudget } = buildCtx(overrides);
      await expect(routingSyntheticQaStage.handle(ctx)).resolves.toEqual({ kind: 'respond' });
      expect(status).toHaveBeenLastCalledWith(400);
      expect(json).toHaveBeenLastCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'ROUTING_SYNTHETIC_QA_INVALID' }),
      }));
      expect(hoisted.runShadowHook).not.toHaveBeenCalled();
      expect(ensureModelBudget).not.toHaveBeenCalled();
    }
  });

  it('records exactly one provenance-bound shadow bundle then returns a deterministic provider-free response', async () => {
    hoisted.runShadowHook.mockReturnValue({
      enabled: true,
      recorded: true,
      trafficProvenanceRecorded: true,
      replayBundleId: 'chatv2-shadow-replay:synthetic-qa-1',
    });
    const { ctx, json, ensureModelBudget } = buildCtx({
      // This deliberately looks like an earlier token-zero shortcut. Stage
      // ordering must still force the dedicated QA terminal first.
      normalizedText: 'show my tasks today',
      normalizedTextLower: 'show my tasks today',
    });

    await expect(routingSyntheticQaStage.handle(ctx)).resolves.toEqual({ kind: 'respond' });

    expect(hoisted.runShadowHook).toHaveBeenCalledTimes(1);
    expect(hoisted.runShadowHook).toHaveBeenCalledWith(expect.objectContaining({
      normalizedText: 'show my tasks today',
      clientMessageId: PROVENANCE.turnId,
      trafficProvenance: PROVENANCE,
    }));
    expect(ensureModelBudget).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      routeMethod: 'routing-synthetic-qa',
      metadata: expect.objectContaining({
        type: 'routing_synthetic_qa_recorded',
        providerCalled: false,
        externalCallPerformed: false,
        domainMutationPerformed: false,
        trafficProvenance: PROVENANCE,
      }),
    }));
  });

  it('fails closed without entering a provider path when the shadow bundle was not recorded', async () => {
    hoisted.runShadowHook.mockReturnValue({ enabled: true, recorded: false, errorCode: 'shadow_route_hook_failed' });
    const { ctx, status, json, ensureModelBudget } = buildCtx();

    await expect(routingSyntheticQaStage.handle(ctx)).resolves.toEqual({ kind: 'respond' });

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'ROUTING_SYNTHETIC_QA_RECORDING_FAILED',
        message: 'Synthetic routing QA evidence could not be recorded. No provider or domain action was run.',
      },
    });
    expect(ensureModelBudget).not.toHaveBeenCalled();
  });

  it('fails closed when the replay exists but lacks the exact provenance binding', async () => {
    hoisted.runShadowHook.mockReturnValue({
      enabled: true,
      recorded: true,
      trafficProvenanceRecorded: false,
      replayBundleId: 'chatv2-shadow-replay:unbound',
    });
    const { ctx, status, json, ensureModelBudget } = buildCtx();

    await expect(routingSyntheticQaStage.handle(ctx)).resolves.toEqual({ kind: 'respond' });

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'ROUTING_SYNTHETIC_QA_RECORDING_FAILED' }),
    }));
    expect(ensureModelBudget).not.toHaveBeenCalled();
  });
});
