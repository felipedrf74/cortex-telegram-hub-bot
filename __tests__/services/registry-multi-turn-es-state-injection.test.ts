// Phase 10 batch 52 (2026-05-16): Spanish multi-turn pending continuations.
//
// Phase 9 batch 49 (2026-05-16) pinned turn-2 state-injection scenarios in
// EN/PT for the 6 pending continuation functions. This batch covers the
// Spanish vocabulary surface for each one:
//
//   • cooking — "Alta en proteína, vegetariana" → constraints filled
//   • finance — "Suministros de oficina" → category filled
//   • decision — "Opción B" / "elijo C" → choice filled
//   • mail — "Más corto y amistoso" → refinements filled
//   • content — "Audiencia: creadores fitness, tono directo, menos de 30 segundos"
//   • training — "4 sesiones por semana" → sessionsPerWeek filled
//
// Each fixture mocks the pending-action store to claim a turn-2 plan and
// verifies the step args contain the filled slot.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/chat-action-state', () => ({
  cancelPendingChatActions: vi.fn(() => 0),
  getActivePendingChatAction: vi.fn(() => null),
  markPendingChatActionNeedsUserFollowup: vi.fn(() => false),
  recordChatActionTelemetry: vi.fn(),
  rememberRecentChatEntity: vi.fn(),
  resolveRecentChatEntity: vi.fn(() => ({ status: 'none', candidates: [] })),
  upsertPendingChatAction: vi.fn(),
  makeSlotProvenance: vi.fn((input: any) => ({
    slot: input.slot, value: input.value, rawText: input.rawText ?? null,
    turnId: input.turnId, spanStart: input.spanStart ?? null, spanEnd: input.spanEnd ?? null,
    sourceType: input.sourceType ?? 'user_message', normalizer: input.normalizer,
    confidence: input.confidence, validation: input.validation ?? 'passed',
  })),
}));

import {
  getActivePendingChatAction,
} from '../../src/services/chat-action-state';
import {
  buildChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat';

const FROZEN_NOW = '2026-05-16T12:00:00+02:00';

function input(text: string, conversationId = `mt-es-${Date.now()}-${Math.random()}`): ChatPlannerInput {
  return {
    userId: 1, tenantId: 1,
    conversationId,
    messageId: `mt-es-msg-${Date.now()}-${Math.random()}`,
    locale: 'es-ES',
    timezone: 'Europe/Madrid',
    channel: 'telegram',
    text, nowIso: FROZEN_NOW,
  };
}

const mockedGetActivePending = vi.mocked(getActivePendingChatAction);

describe('Spanish multi-turn pending continuations (Phase 10 batch 52)', () => {
  describe('cooking_meal_plan turn-2 (Spanish dietary constraint)', () => {
    it('turn 2 fills constraints in Spanish ("vegetariana", "alta en proteína")', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'cooking') {
          return {
            pendingActionId: 'pending-cooking-es-1', skill: 'cooking',
            action: 'cooking_meal_plan', userId: 1, tenantId: 1,
            conversationId: 'mt-es-cooking',
            collectedSlots: { dateRange: 'next_week' },
            missingSlots: ['constraints'],
            ttlExpiresAt: '2026-05-16T13:00:00+02:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('Alta en proteína, vegetariana', 'mt-es-cooking'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('cooking');
      const args = step?.args as Record<string, unknown> | undefined;
      const constraints = (args?.constraints ?? []) as string[];
      expect(constraints.length).toBeGreaterThan(0);
    });
  });

  describe('finance_categorize_receipt turn-2 (Spanish category)', () => {
    it('turn 2 fills category in Spanish ("comida", "transporte", "publicidad")', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'finance') {
          return {
            pendingActionId: 'pending-finance-es-1', skill: 'finance',
            action: 'finance_categorize_receipt', userId: 1, tenantId: 1,
            conversationId: 'mt-es-finance',
            collectedSlots: { receiptId: 'receipt-es-1' },
            missingSlots: ['category'],
            ttlExpiresAt: '2026-05-16T13:00:00+02:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('Material de oficina', 'mt-es-finance'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('finance');
      expect(step?.action).toBe('finance_categorize_receipt');
    });
  });

  describe('decision_choose turn-2 (Spanish option letter)', () => {
    it('turn 2 fills choice in Spanish ("Opción B")', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'decision_center') {
          return {
            pendingActionId: 'pending-decision-es-1', skill: 'decision_center',
            action: 'decision_choose', userId: 1, tenantId: 1,
            conversationId: 'mt-es-decision',
            collectedSlots: { decisionId: 'decision-es-1' },
            missingSlots: ['choice'],
            ttlExpiresAt: '2026-05-16T13:00:00+02:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('Opción B', 'mt-es-decision'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('decision_center');
      expect(step?.action).toBe('decision_choose');
      const args = step?.args as Record<string, unknown> | undefined;
      expect(args?.choice).toBe('B');
    });

    it('turn 2 fills choice via Spanish "elijo C"', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'decision_center') {
          return {
            pendingActionId: 'pending-decision-es-2', skill: 'decision_center',
            action: 'decision_choose', userId: 1, tenantId: 1,
            conversationId: 'mt-es-decision-2',
            collectedSlots: { decisionId: 'decision-es-2' },
            missingSlots: ['choice'],
            ttlExpiresAt: '2026-05-16T13:00:00+02:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('elijo C', 'mt-es-decision-2'));
      const step = turn2?.steps[0];
      expect(step?.action).toBe('decision_choose');
      const args = step?.args as Record<string, unknown> | undefined;
      expect(args?.choice).toBe('C');
    });
  });

  describe('mail_draft turn-2 (Spanish refinement)', () => {
    it('turn 2 applies refinements in Spanish ("más corto y amistoso")', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'mail') {
          return {
            pendingActionId: 'pending-mail-es-1', skill: 'mail',
            action: 'draft_email', userId: 1, tenantId: 1,
            conversationId: 'mt-es-mail',
            collectedSlots: { recipient: 'pedro@example.com', subject: 'Actualización', body: 'Borrador inicial' },
            missingSlots: ['refinements'],
            ttlExpiresAt: '2026-05-16T13:00:00+02:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('Más corto y amistoso', 'mt-es-mail'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('mail');
      expect(step?.action).toBe('draft_email');
    });
  });

  describe('content_brief_create turn-2 (Spanish specs)', () => {
    it('turn 2 fills specs in Spanish ("audiencia creadores, tono directo, menos de 30 segundos")', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'content') {
          return {
            pendingActionId: 'pending-content-es-1', skill: 'content',
            action: 'content_brief_create', userId: 1, tenantId: 1,
            conversationId: 'mt-es-content',
            collectedSlots: { objective: 'reel sobre rutinas matutinas' },
            missingSlots: ['specs'],
            ttlExpiresAt: '2026-05-16T13:00:00+02:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('Audiencia creadores fitness, tono directo, menos de 30 segundos', 'mt-es-content'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('content');
      expect(step?.action).toBe('content_brief_create');
    });
  });

  describe('training_plan_create turn-2 (Spanish weekly frequency)', () => {
    it('turn 2 fills sessionsPerWeek via Spanish "4 sesiones por semana"', async () => {
      mockedGetActivePending.mockImplementation((opts: any) => {
        if (opts?.skill === 'training') {
          return {
            pendingActionId: 'pending-training-es-1', skill: 'training',
            action: 'training_plan_create', userId: 1, tenantId: 1,
            conversationId: 'mt-es-training',
            collectedSlots: { objective: '10k', durationWeeks: 12, startPolicy: 'next_full_week' },
            missingSlots: ['sessionsPerWeek'],
            ttlExpiresAt: '2026-05-16T13:00:00+02:00',
          } as any;
        }
        return null;
      });
      const turn2 = await buildChatActionPlan(input('4 sesiones por semana', 'mt-es-training'));
      const step = turn2?.steps[0];
      expect(step?.skill).toBe('training');
      expect(step?.action).toBe('training_plan_create');
      const args = step?.args as Record<string, unknown> | undefined;
      expect(args?.sessionsPerWeek).toBe(4);
    });
  });
});
