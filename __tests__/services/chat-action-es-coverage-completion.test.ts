// Phase 13 batch 70 (2026-05-16): Spanish parser 40 → 45 close-out.
//
// Final batch of ES parser coverage. Targets the last actions whose
// Spanish surface didn't yet route deterministically:
//
//   • training_coach_report — "Dame un informe del coach"
//   • connections_reconnect_guidance — "Cómo me reconecto a Garmin"
//   • cooking_fueling_support — "Qué desayuno antes del entrenamiento"
//   • content_schedule_work alt — "Publica este reel mañana"
//   • mail.send_email alt — "Manda un correo a Pedro con asunto Update"

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
    conversationId: `es-b70-${Date.now()}-${Math.random()}`,
    messageId: `es-b70-msg-${Date.now()}-${Math.random()}`,
    locale: 'es-ES',
    timezone: 'Europe/Madrid',
    channel: 'telegram',
    text, nowIso: FROZEN_NOW,
  };
}

const FIXTURES = [
  {
    text: 'Dame un informe del coach',
    expectedSkill: 'training',
    expectedAction: 'training_coach_report',
    reason: 'Spanish "informe del coach" — training_coach_report.',
  },
  {
    text: 'Cómo me reconecto a Garmin',
    expectedSkill: 'connections',
    expectedAction: 'connections_reconnect_guidance',
    reason: 'Spanish "cómo me reconecto" — reconnect guidance branch.',
  },
  {
    text: 'Qué desayuno antes del entrenamiento',
    expectedSkill: 'cooking',
    expectedAction: 'cooking_fueling_support',
    reason: 'Spanish "qué desayuno + antes del entrenamiento" — pre-workout fueling.',
  },
  {
    text: 'Publica este reel mañana',
    expectedSkill: 'content',
    expectedAction: 'content_schedule_work',
    reason: 'Spanish "publica este reel mañana" — content schedule work.',
  },
  {
    text: 'Manda un correo a Pedro con asunto Update',
    expectedSkill: 'mail',
    expectedAction: 'send_email',
    reason: 'Spanish "manda un correo + asunto" — send_email with subject marker.',
  },
];

describe('Spanish coverage completion (Phase 13 batch 70)', () => {
  for (const fixture of FIXTURES) {
    it(`[es-ES] "${fixture.text}" → ${fixture.expectedSkill}.${fixture.expectedAction}`, () => {
      const plan = buildDeterministicChatActionPlan(input(fixture.text));
      expect(plan, `plan must not be null: ${fixture.reason}`).not.toBeNull();
      const step = plan?.steps[0];
      expect(step?.skill, fixture.reason).toBe(fixture.expectedSkill);
      expect(step?.action, fixture.reason).toBe(fixture.expectedAction);
    });
  }
});
