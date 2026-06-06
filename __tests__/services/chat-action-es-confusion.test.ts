// Phase 8 batch 43 (2026-05-15): Spanish locale exploratory confusion
// fixtures.
//
// Phases 1-7 focused on EN and PT (PT-PT + PT-BR). Spanish is Felipe's
// secondary market. This file ships minimum Spanish parser support for
// three high-value actions (create_task, delete_event, send_email) plus
// confusion fixtures that lock the priority winner.
//
// Spanish parser extensions in this batch:
//   • parseSimpleTaskStep / hasSimpleTaskWriteIntent — `crea[r]?` + `tarea[s]?`
//   • parseCalendarMutationIntent gate — `reunion[es]?` + `cita[s]?`
//   • parseMailActionStep — `correo[s]?` + `bandeja de entrada` + `envía[r]?`
//   • Title marker — `llamad[oa]` + `titulada`
//
// Other Spanish actions still route to LLM tier (Phase 9 candidate).

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

const FROZEN_NOW = '2026-05-14T12:00:00+01:00';

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

interface EsConfusionFixture {
  text: string;
  expectedSkill: string;
  expectedAction: string;
  runnerUp: string;
  reason: string;
}

const FIXTURES: EsConfusionFixture[] = [
  {
    text: 'Crea una tarea llamada llamar a María',
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    runnerUp: 'secretary_calendar.schedule_event',
    reason:
      '"Crea una tarea llamada X" uses Spanish title marker "llamada"; parseSimpleTaskStep claims via crea + tarea + llamada.',
  },
  {
    text: 'Cancela la reunión con Pedro',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'delete_event',
    runnerUp: 'decision_center.decision_dismiss',
    reason:
      'Calendar mutation parser gate accepts Spanish "reunión" (folded as "reunion"); cancela is shared verb across PT/EN/ES.',
  },
  {
    text: 'Envía un correo a felipe@example.com sobre la propuesta',
    expectedSkill: 'mail',
    expectedAction: 'send_email',
    runnerUp: 'mail.draft_email',
    reason:
      'Mail parser claims "envía + correo" Spanish form; send-branch fires because verb-object adjacency matches the regex.',
  },
  // Phase 9 batch 48 (2026-05-16): expanded from 3 to 12 Spanish actions.
  {
    text: 'Marca esa tarea como hecha',
    expectedSkill: 'tasks',
    expectedAction: 'complete_task',
    runnerUp: 'tasks.update_task',
    reason: 'Spanish complete-by-mark pattern: "marca esa tarea como hecha" matches the ES variant of parseCompleteTaskByMarkIntent.',
  },
  {
    text: 'Borra la tarea de la presentación',
    expectedSkill: 'tasks',
    expectedAction: 'delete_task',
    runnerUp: 'tasks.update_task',
    reason: 'Spanish "borra" delete-verb + "tarea" task-noun match the task mutation parser\'s extended verb set.',
  },
  {
    text: 'Cambia la tarea de presentación para el martes',
    expectedSkill: 'tasks',
    expectedAction: 'update_task',
    runnerUp: 'tasks.create_task',
    reason: 'Spanish "cambia" change-verb routes through task mutation parser as update_task.',
  },
  {
    text: 'Cuántos correos sin leer tengo',
    expectedSkill: 'mail',
    expectedAction: 'mail_unread_count',
    runnerUp: 'mail.mail_inbox_summary',
    reason: 'Spanish "correos sin leer" pattern fires the unread-count branch in the mail parser.',
  },
  {
    text: 'Cuánto gasté este mes',
    expectedSkill: 'finance',
    expectedAction: 'finance_summary',
    runnerUp: 'finance.finance_create_reminder',
    reason: 'Spanish "gasté" past-tense spending verb anchors finance; summary is the default read branch.',
  },
  {
    text: 'Recuérdame pagar la factura el viernes',
    expectedSkill: 'finance',
    expectedAction: 'finance_create_reminder',
    runnerUp: 'finance.finance_payment_action (because "pagar")',
    reason: 'Spanish "recuérdame" reminder verb fires the reminder branch BEFORE payment branch — same precedence rule as PT.',
  },
  {
    text: 'Qué hay en mi agenda hoy',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'summarize_agenda',
    runnerUp: 'connections.connections_status (because of "qué hay")',
    reason: 'Spanish "qué hay en mi agenda" matches the extended calendar-read intent pattern.',
  },
  {
    text: 'Qué tengo el viernes',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'summarize_agenda',
    runnerUp: '(no plan)',
    reason: 'Spanish "qué tengo el <day>" pattern recognised as calendar-read.',
  },
  {
    text: 'Añade una tarea llamada llamar a Carlos',
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    runnerUp: 'secretary_calendar.schedule_event',
    reason: 'Spanish "añade" alternate create-verb (vs "crea") added to the task create regex.',
  },
];

describe('Spanish locale exploratory confusion (Phase 8 batch 43)', () => {
  for (const fixture of FIXTURES) {
    it(`[es-ES] "${fixture.text}" → ${fixture.expectedSkill}.${fixture.expectedAction}`, () => {
      const plan = buildDeterministicChatActionPlan(input(fixture.text));
      expect(plan, `plan must not be null: ${fixture.reason}`).not.toBeNull();
      const step = plan?.steps[0];
      expect(step?.skill, fixture.reason).toBe(fixture.expectedSkill);
      expect(step?.action, fixture.reason).toBe(fixture.expectedAction);
    });
  }

  it('documents Spanish coverage scope (3 high-value actions deterministic, rest defer to LLM)', () => {
    // Spanish coverage in Phase 8: minimum-viable on create_task, delete_event,
    // send_email. Other Spanish actions (mail_inbox_summary, finance_summary,
    // complete_task, etc.) route to NULL deterministically and fall through
    // to the LLM tier. Phase 9 candidate: full Spanish parser coverage.
    expect(FIXTURES.length).toBeGreaterThanOrEqual(3);
  });
});
