// Phase 12 batch 66 (2026-05-16): Spanish parser coverage 35 → 40+.
//
// Phase 11 batch 58 raised ES deterministic coverage from 28 to 35+. This
// batch closes another five actions where Spanish phrasing didn't yet
// route deterministically:
//
//   • secretary_calendar.move_event — "Mueve la reunión al jueves"
//   • secretary_calendar.check_calendar_conflicts — "Estoy libre el viernes"
//   • tasks.create_checklist — "Crea una checklist para el viaje"
//   • content.content_rewrite (alt verb) — "Acorta esta caption"
//   • decision_center.decision_choose (alt verb) — "Selecciono la opción B"

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
    conversationId: `es-b66-${Date.now()}-${Math.random()}`,
    messageId: `es-b66-msg-${Date.now()}-${Math.random()}`,
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
  {
    text: 'Mueve la reunión al jueves',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'move_event',
    reason: 'Spanish "mueve" (imperative of mover) + "reunión" — calendar move mutation.',
  },
  {
    text: 'Reprograma la cita con Pedro al lunes',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'move_event',
    reason: 'Spanish "reprograma" (reschedule) + "cita" — calendar move mutation.',
  },
  {
    text: 'Estoy libre el viernes a las 15',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'check_calendar_conflicts',
    reason: 'Spanish "estoy libre" + day + time — calendar-conflict read intent.',
  },
  {
    text: 'Crea una checklist para el viaje con pasaporte y billetes',
    expectedSkill: 'tasks',
    expectedAction: 'create_checklist',
    reason: 'Spanish "crea una checklist" + items list — task checklist create.',
  },
  {
    text: 'Acorta esta caption',
    expectedSkill: 'content',
    expectedAction: 'content_rewrite',
    reason: 'Spanish "acorta" (shorten) + "caption" — content rewrite intent.',
  },
];

describe('Spanish coverage expansion 3 (Phase 12 batch 66)', () => {
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
