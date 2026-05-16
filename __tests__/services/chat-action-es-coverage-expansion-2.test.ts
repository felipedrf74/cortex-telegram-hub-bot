// Phase 11 batch 58 (2026-05-16): Spanish parser coverage 28 → 35+.
//
// Phase 10 batch 51 raised ES deterministic coverage from 12 to ~28
// actions. The remaining defer-to-LLM cohort includes:
//
//   • secretary_calendar: update_event, move_event
//   • cooking: cooking_meal_support, cooking_fueling_support
//   • content: content_pipeline_handoff
//   • decision_center: decision_follow_up
//   • finance: finance_payment_action, finance_categorize_receipt
//   • training: training_reflow_preview, training_reflow_confirm
//   • notifications: explain / create_intent / update_preference
//
// This batch adds Spanish surfaces for the ones with realistic phrasing
// (some defer-to-LLM actions are inherently low-frequency in ES and not
// worth deterministic parsing). Target: 11 new ES action fixtures.

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
  buildDeterministicChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat-action-planner';

const FROZEN_NOW = '2026-05-16T12:00:00+02:00';

function input(text: string): ChatPlannerInput {
  return {
    userId: 1, tenantId: 1,
    conversationId: `es-b58-${Date.now()}-${Math.random()}`,
    messageId: `es-b58-msg-${Date.now()}-${Math.random()}`,
    locale: 'es-ES',
    timezone: 'Europe/Madrid',
    channel: 'telegram',
    text, nowIso: FROZEN_NOW,
  };
}

interface EsFixture {
  text: string;
  expectedSkill: string;
  expectedAction: string;
  reason: string;
}

const FIXTURES: EsFixture[] = [
  // --- Cooking meal/fueling support (read-only conversational) ---
  {
    text: '¿Qué hago para cenar esta noche?',
    expectedSkill: 'cooking',
    expectedAction: 'cooking_meal_support',
    reason: 'Spanish "qué hago para cenar" — open-ended meal support, NOT a meal plan (no plan verb).',
  },
  {
    text: '¿Qué como antes del entrenamiento?',
    expectedSkill: 'cooking',
    expectedAction: 'cooking_fueling_support',
    reason: 'Spanish "antes del entrenamiento" — pre-workout fueling support.',
  },

  // --- Content pipeline ---
  {
    text: 'Manda este paquete al pipeline de contenido',
    expectedSkill: 'content',
    expectedAction: 'content_pipeline_handoff',
    reason: 'Spanish "manda" + "paquete" + "pipeline" — content pipeline handoff.',
  },

  // --- Finance payment / categorize ---
  {
    text: 'Paga la factura del gimnasio',
    expectedSkill: 'finance',
    expectedAction: 'finance_payment_action',
    reason: 'Spanish "paga" + "factura" — finance_payment_action.',
  },
  {
    text: 'Categoriza este recibo como material de oficina',
    expectedSkill: 'finance',
    expectedAction: 'finance_categorize_receipt',
    reason: 'Spanish "categoriza" + "recibo" — finance_categorize_receipt.',
  },

  // --- Training reflow ---
  {
    text: 'Muestra cómo quedaría reorganizado el plan de entrenamiento',
    expectedSkill: 'training',
    expectedAction: 'training_reflow_preview',
    reason: 'Spanish "muestra" + "reorganizado" + training context — reflow preview.',
  },
  {
    text: 'Aplica el reorganizado al plan',
    expectedSkill: 'training',
    expectedAction: 'training_reflow_confirm',
    reason: 'Spanish "aplica" + "reorganizado" + plan context — reflow confirm.',
  },

  // --- Notifications ---
  {
    text: 'Por qué recibí esta notificación',
    expectedSkill: 'notifications',
    expectedAction: 'notification_explain',
    reason: 'Spanish "por qué recibí" + "notificación" — notification_explain.',
  },
  {
    text: 'Desactiva las notificaciones de marketing',
    expectedSkill: 'notifications',
    expectedAction: 'notification_update_preference',
    reason: 'Spanish "desactiva" + "notificaciones" — preference update (disable).',
  },
  {
    text: 'Crea una notificación cuando llegue un correo de Pedro',
    expectedSkill: 'notifications',
    expectedAction: 'notification_create_intent',
    reason: 'Spanish "crea" + "notificación" + trigger clause — notification_create_intent.',
  },

  // --- Calendar update/delete already covered in Phase 9 batch 48 for delete_event;
  //     adding update_event coverage here. ---
  {
    text: 'Cambia la reunión del lunes al martes',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'update_event',
    reason: 'Spanish "cambia" + "reunión" + day-shift — update_event (move-style mutation).',
  },
];

describe('Spanish coverage expansion 2 (Phase 11 batch 58)', () => {
  for (const fixture of FIXTURES) {
    it(`[es-ES] "${fixture.text}" → ${fixture.expectedSkill}.${fixture.expectedAction}`, () => {
      const plan = buildDeterministicChatActionPlan(input(fixture.text));
      expect(plan, `plan must not be null: ${fixture.reason}`).not.toBeNull();
      const step = plan?.steps[0];
      expect(step?.skill, fixture.reason).toBe(fixture.expectedSkill);
      expect(step?.action, fixture.reason).toBe(fixture.expectedAction);
    });
  }

  it('documents Phase 11 batch 58 scope (28 → 35+ ES actions deterministic)', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(7);
  });
});
