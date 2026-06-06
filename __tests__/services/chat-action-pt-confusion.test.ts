// Phase 6 batch 34 (2026-05-15): locale-aware (PT-PT + PT-BR) confusion
// fixtures. Phase 4 batch 21 covered cross-skill confusion in EN; this file
// covers the same axes in Portuguese. Each fixture documents:
//
//   • The PT phrasing
//   • The winner skill+action
//   • The runner-up
//   • The reason the winner wins
//
// Locale-header-independent — both pt-PT and pt-BR locales should resolve
// to the same priority winner.

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

function input(text: string, locale: string = 'pt-PT'): ChatPlannerInput {
  return {
    userId: 1, tenantId: 1,
    conversationId: `pt-conf-${Date.now()}-${Math.random()}`,
    messageId: `pt-conf-msg-${Date.now()}-${Math.random()}`,
    locale, timezone: 'Europe/Lisbon', channel: 'telegram',
    text, nowIso: FROZEN_NOW,
  };
}

interface PtConfusionFixture {
  text: string;
  locale: 'pt-PT' | 'pt-BR';
  expectedSkill: string;
  expectedAction: string;
  runnerUp: string;
  reason: string;
}

const FIXTURES: PtConfusionFixture[] = [
  {
    text: 'Lembra-me de pagar a fatura sexta',
    locale: 'pt-PT',
    expectedSkill: 'finance',
    expectedAction: 'finance_create_reminder',
    runnerUp: 'tasks.create_task',
    reason:
      '"fatura" anchors finance; reminder-before-payment precedence (Phase 1 batch 2 fix).',
  },
  {
    text: 'Cria uma tarefa pra ligar pra Maria às 5',
    locale: 'pt-BR',
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    runnerUp: 'finance.finance_create_reminder',
    reason:
      'Explicit "Cria uma tarefa" matches parseSimpleTaskStep; the "ligar pra Maria" tail becomes the task title (heuristic fallback when no explicit title-marker).',
  },
  {
    text: 'Marca uma reunião para sexta às 14h com o Pedro',
    locale: 'pt-PT',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'schedule_event',
    runnerUp: 'tasks.complete_task (because "marca")',
    reason:
      'Calendar parser claims at top-of-planner; "reunião" is the dominant noun. complete_task short-circuit needs "tarefa".',
  },
  {
    text: 'Cancela a reunião com o Pedro',
    locale: 'pt-PT',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'delete_event',
    runnerUp: 'decision_center.decision_dismiss',
    reason:
      'Calendar mutation parser claims via "cancela" + "reunião"; decisions need explicit "decisão" noun.',
  },
  {
    text: 'Cria uma tarefa chamada apresentação para terça',
    locale: 'pt-PT',
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    runnerUp: 'secretary_calendar.schedule_event',
    reason:
      'Explicit "tarefa chamada X" with title-marker; literal-title policy preserves "apresentação". Calendar parser fails because no event noun.',
  },
  {
    text: 'Bota um lembrete pra ligar pro Pedro às 5',
    locale: 'pt-BR',
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    runnerUp: 'finance.finance_create_reminder',
    reason:
      'PT-BR "Bota um lembrete" reads as task creation (the message uses lembrete as a noun for the task); no finance object.',
  },
  {
    text: 'Como está minha agenda hoje',
    locale: 'pt-PT',
    expectedSkill: 'secretary_calendar',
    expectedAction: 'summarize_agenda',
    runnerUp: 'connections.connections_status (because "como está" matches connections check)',
    reason:
      'Calendar read-intent short-circuit at top-of-planner fires on "minha agenda"; connections parser misses because no connection object referenced.',
  },
  {
    text: 'Apaga essa tarefa da apresentação',
    locale: 'pt-PT',
    expectedSkill: 'tasks',
    expectedAction: 'delete_task',
    runnerUp: 'secretary_calendar.delete_event',
    reason:
      'Task mutation parser claims "apaga" + "tarefa"; calendar mutation needs "evento|reunião|appointment".',
  },
  {
    text: 'Faz um cardápio pra semana que vem',
    locale: 'pt-BR',
    expectedSkill: 'cooking',
    expectedAction: 'cooking_meal_plan',
    runnerUp: 'content.content_brief_create',
    reason:
      'Cooking gate matches "cardápio" (PT-BR variant); meal-plan branch claims via "faz" verb.',
  },
  {
    text: 'Resume a caixa de entrada do Outlook',
    locale: 'pt-PT',
    expectedSkill: 'mail',
    expectedAction: 'mail_inbox_summary',
    runnerUp: 'connections.connections_status',
    reason:
      'Mail parser claims "resume a caixa" + "outlook"; the "outlook" word alone would route to connections without the mail-anchor.',
  },
  {
    text: 'Desliga as notificações de treino aos fins de semana',
    locale: 'pt-BR',
    expectedSkill: 'notifications',
    expectedAction: 'notification_update_preference',
    runnerUp: 'training.training_explain_session (because "treino")',
    reason:
      'Notifications parser runs before training in parseBroadSkillActionIntent (Phase 2 batch 6 reorder); "desliga" matches preference-update.',
  },
  {
    text: 'Adia essa decisão pra sexta',
    locale: 'pt-BR',
    expectedSkill: 'decision_center',
    expectedAction: 'decision_snooze',
    runnerUp: 'decision_center.decision_dismiss',
    reason:
      'Decision parser claims "adiar" as snooze verb; dismiss would need "ignora|dispens|descart".',
  },
  // Phase 7 close-out (2026-05-15): 8 additional PT confusion axes to reach 20 total.
  {
    text: 'Envia o relatório do coach pra sexta',
    locale: 'pt-BR',
    expectedSkill: 'training',
    expectedAction: 'training_coach_report',
    runnerUp: 'mail.send_email (because "envia"), content.content_brief_create',
    reason:
      '"relatório do coach" anchors training_coach_report; the coach-report regex claims before mail/content. Training parser checks coach|report|relatorio keywords.',
  },
  {
    text: 'Mostra o reflow proposto',
    locale: 'pt-PT',
    expectedSkill: 'training',
    expectedAction: 'training_reflow_preview',
    runnerUp: 'training.training_reflow_confirm',
    reason:
      'Reflow preview branch claims via "mostra" + "reflow"; confirm requires apply/confirma verb.',
  },
  {
    text: 'Confirma e aplica o reflow',
    locale: 'pt-PT',
    expectedSkill: 'training',
    expectedAction: 'training_reflow_confirm',
    runnerUp: 'training.training_reflow_preview',
    reason:
      'Reflow confirm branch claims via "confirma|aplica" + "reflow"; preview requires mostra/show verb.',
  },
  {
    text: 'Escolhe a opção A da decisão da carga',
    locale: 'pt-PT',
    expectedSkill: 'decision_center',
    expectedAction: 'decision_choose',
    runnerUp: 'decision_center.decision_follow_up',
    reason:
      'Decision choose branch fires on "escolhe + opção"; follow_up is the default fallback for the decision skill.',
  },
  {
    text: 'Quanto gastei em jantares esse mês',
    locale: 'pt-BR',
    expectedSkill: 'finance',
    expectedAction: 'finance_summary',
    runnerUp: 'cooking.cooking_meal_support (because "jantares")',
    reason:
      'Finance parser claims via "gastei" past-tense; cooking would need "sugestão de jantar" or planning verb. The forward "quanto gastei" pattern reads as a summary query in current/recent period.',
  },
  {
    text: 'Sincroniza o Google Calendar novamente',
    locale: 'pt-PT',
    expectedSkill: 'connections',
    expectedAction: 'connections_retry_sync',
    runnerUp: 'secretary_calendar.summarize_agenda',
    reason:
      'Connections parser claims "sincroniza + Google" via the sync-with-provider pattern (Phase 7 close-out extended the prefix list to accept article "o"). Calendar parser fails because no explicit event verb.',
  },
  {
    text: 'Cria uma notificação quando passar de 5 mil',
    locale: 'pt-BR',
    expectedSkill: 'notifications',
    expectedAction: 'notification_create_intent',
    runnerUp: 'tasks.create_task (because "cria")',
    reason:
      'Notifications parser runs BEFORE task parser in parseBroadSkillActionIntent; "notificação" anchors the notification skill.',
  },
  {
    text: 'Reescreve a legenda pra ficar mais curta',
    locale: 'pt-BR',
    expectedSkill: 'content',
    expectedAction: 'content_rewrite',
    runnerUp: 'content.content_brief_create',
    reason:
      'Content rewrite branch claims via "reescreve" + "legenda" (PT word for caption). Brief-create requires "brief|campanha|ideia" keyword.',
  },
];

describe('PT-PT/PT-BR cross-skill confusion (Phase 6 batch 34)', () => {
  for (const fixture of FIXTURES) {
    it(`[${fixture.locale}] "${fixture.text}" → ${fixture.expectedSkill}.${fixture.expectedAction}`, () => {
      const plan = buildDeterministicChatActionPlan(input(fixture.text, fixture.locale));
      expect(plan, `plan must not be null: ${fixture.reason}`).not.toBeNull();
      const step = plan?.steps[0];
      expect(step?.skill, fixture.reason).toBe(fixture.expectedSkill);
      expect(step?.action, fixture.reason).toBe(fixture.expectedAction);
    });
  }

  it('every PT confusion fixture has a non-empty reason', () => {
    for (const fixture of FIXTURES) {
      expect(fixture.reason.length).toBeGreaterThan(30);
    }
  });

  it('covers at least 6 distinct skills in PT', () => {
    const skills = new Set(FIXTURES.map((f) => f.expectedSkill));
    expect(skills.size).toBeGreaterThanOrEqual(6);
  });

  it('routing is locale-header-independent: PT-PT phrasings work under pt-BR locale and vice versa', () => {
    for (const fixture of FIXTURES) {
      const otherLocale = fixture.locale === 'pt-PT' ? 'pt-BR' : 'pt-PT';
      const plan = buildDeterministicChatActionPlan(input(fixture.text, otherLocale));
      expect(plan?.steps[0]?.skill, `${fixture.text} should claim ${fixture.expectedSkill} under ${otherLocale}`).toBe(fixture.expectedSkill);
      expect(plan?.steps[0]?.action, `${fixture.text} should claim ${fixture.expectedAction} under ${otherLocale}`).toBe(fixture.expectedAction);
    }
  });
});
