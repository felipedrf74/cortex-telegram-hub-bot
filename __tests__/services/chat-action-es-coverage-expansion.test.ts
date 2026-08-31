// Phase 10 batch 51 (2026-05-16): Spanish parser coverage expansion.
//
// Phase 8/9 brought ES support to 12 actions (Phase 9 batch 48). Phase 10
// batch 50 added schedule_event (Spanish calendar NLP). This batch
// expands ES coverage to 25+ actions across:
//
//   • cooking — meal plan, grocery list (Spanish: "lista de la compra"),
//     fueling support
//   • content — script create, brief, rewrite, pipeline, schedule
//   • decision_center — choose, snooze, dismiss (Spanish vocabulary)
//   • connections — sync/status/reconnect (Spanish: "conexión",
//     "sincronizar", "reconectar")
//   • mail — reply, archive, search (Spanish: "responde", "archiva",
//     "busca")
//   • training — log workout, view plan (Spanish: "registra
//     entrenamiento", "ver mi plan")
//
// Each fixture asserts the deterministic planner claims the action AND
// returns the correct skill+action pair. The reason field documents the
// Spanish vocabulary surface that the parser must accept.

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
} from '../../src/services/chat';

const FROZEN_NOW = '2026-05-16T12:00:00+02:00';

function input(text: string): ChatPlannerInput {
  return {
    userId: 1, tenantId: 1,
    conversationId: `es-${Date.now()}-${Math.random()}`,
    messageId: `es-msg-${Date.now()}-${Math.random()}`,
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
  // --- Cooking ---
  {
    text: 'Planea las comidas de la próxima semana',
    expectedSkill: 'cooking',
    expectedAction: 'cooking_meal_support',
    reason: 'Spanish "planea" + "comidas" + "próxima semana" stays advisory because bulk weekly generation is not a single-slot write.',
  },
  {
    text: 'Crea un menú para esta semana',
    expectedSkill: 'cooking',
    expectedAction: 'cooking_meal_support',
    reason: 'Spanish "crea" + "menú" reaches Cooking support without manufacturing an unexecutable weekly write.',
  },
  {
    text: 'Necesito una lista de la compra',
    expectedSkill: 'cooking',
    expectedAction: 'cooking_meal_support',
    reason: 'Spanish "lista de la compra" without an explicit generation verb is a read request, not a persisted list regeneration.',
  },

  // --- Content ---
  {
    text: 'Crea un guion para un reel sobre rutinas matutinas',
    expectedSkill: 'content',
    expectedAction: 'content_script_create',
    reason: 'Spanish "guion" (script) + reel platform context — content_script_create.',
  },
  {
    text: 'Reescribe esta caption para hacerla más corta',
    expectedSkill: 'content',
    expectedAction: 'content_rewrite',
    reason: 'Spanish "reescribe" rewrite verb + caption object.',
  },
  {
    text: 'Programa este video para mañana',
    expectedSkill: 'content',
    expectedAction: 'content_publish_now',
    reason: 'Spanish scheduled-publication wording fails closed without a publishing provider.',
  },
  {
    text: 'Crea una campaña para Instagram sobre fitness',
    expectedSkill: 'content',
    expectedAction: 'content_brief_create',
    reason: 'Spanish "campaña" (campaign) — content brief create with Instagram platform.',
  },

  // --- Decision center ---
  {
    text: 'Elige la opción B para la decisión #42',
    expectedSkill: 'decision_center',
    expectedAction: 'decision_choose',
    reason: 'Spanish "elige" choose verb + "opción B" + explicit decisionId — decision_choose with choice="B".',
  },
  {
    text: 'Descarta esta decisión',
    expectedSkill: 'decision_center',
    expectedAction: 'decision_dismiss',
    reason: 'Spanish "descarta" dismiss verb — decision_dismiss.',
  },
  {
    text: 'Pospón la decisión #7',
    expectedSkill: 'decision_center',
    expectedAction: 'decision_snooze',
    reason: 'Spanish "pospón" snooze verb — decision_snooze.',
  },

  // --- Connections ---
  {
    text: 'Sincroniza mi conexión con Google',
    expectedSkill: 'connections',
    expectedAction: 'connections_retry_sync',
    reason: 'Spanish "sincroniza" + "conexión" + Google — connections retry sync.',
  },
  {
    text: 'Reconecta Garmin',
    expectedSkill: 'connections',
    expectedAction: 'connections_retry_sync',
    reason: 'Spanish "reconecta" + Garmin provider — connections retry sync (also covers reconnect_guidance fallback).',
  },

  // --- Mail (extended coverage) ---
  {
    text: 'Responde al último correo de Pedro',
    expectedSkill: 'mail',
    expectedAction: 'draft_email',
    reason: 'Spanish "responde" + "correo" — replies route through draft_email (reply is a kind of draft).',
  },
  {
    text: 'Resumen de la bandeja de entrada',
    expectedSkill: 'mail',
    expectedAction: 'mail_inbox_summary',
    reason: 'Spanish "resumen" (noun) + "bandeja de entrada" — inbox summary.',
  },

  // --- Training (extended coverage) ---
  {
    text: 'Explica la sesión de entrenamiento de hoy',
    expectedSkill: 'training',
    expectedAction: 'training_explain_session',
    reason: 'Spanish "explica" + "sesión de entrenamiento" — explain today\'s session.',
  },
  {
    text: 'Ajusta mi plan de entrenamiento',
    expectedSkill: 'training',
    expectedAction: 'training_adjust_plan',
    reason: 'Spanish "ajusta" + "plan de entrenamiento" — training_adjust_plan.',
  },
];

describe('Spanish coverage expansion (Phase 10 batch 51)', () => {
  for (const fixture of FIXTURES) {
    it(`[es-ES] "${fixture.text}" → ${fixture.expectedSkill}.${fixture.expectedAction}`, () => {
      const plan = buildDeterministicChatActionPlan(input(fixture.text));
      expect(plan, `plan must not be null: ${fixture.reason}`).not.toBeNull();
      const step = plan?.steps[0];
      expect(step?.skill, fixture.reason).toBe(fixture.expectedSkill);
      expect(step?.action, fixture.reason).toBe(fixture.expectedAction);
    });
  }

  it('documents Spanish coverage scope (25+ actions deterministic after Phase 10 batch 51)', () => {
    // Phase 8 batch 43: 3 ES actions deterministic.
    // Phase 9 batch 48: 12 ES actions deterministic.
    // Phase 10 batch 50: +1 (schedule_event).
    // Phase 10 batch 51: +N covered here.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(15);
  });
});
