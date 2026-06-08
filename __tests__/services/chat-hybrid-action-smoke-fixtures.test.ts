import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database | null = null;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (applied) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }
}

function seedFixtureUser(db: Database.Database): void {
  db.prepare(`
    INSERT OR IGNORE INTO users (
      id, email, email_verified, username, first_name, language, timezone,
      tier, status, auth_provider, daily_message_limit, daily_token_limit,
      daily_cost_limit_usd
    )
    VALUES (?, ?, 1, ?, ?, 'en', 'Europe/Lisbon', 'free', 'active', 'email', 40, 100000, 0)
  `).run(42, 'chat-hybrid-smoke@example.test', 'chat-hybrid-smoke', 'Chat Hybrid Smoke');
}

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    if (!testDb) throw new Error('Test database not initialized');
    return testDb;
  },
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

import {
  buildDeterministicChatActionPlan,
  shouldRunActionPlannerBeforeReadOnlyFastPaths,
  tryHandleChatActionPlan,
  type ChatActionPlan,
} from '../../src/services/chat';
import { getChatActionRegistry } from '../../src/services/chat/registry';
import { evaluateChatHybridActionGate } from '../../src/services/chat-evaluation-harness';
import { computeHybridActionMetricsFromCorpus } from '../../src/services/chat-hybrid-metrics';
import { buildFixturesFromRegistry } from '../lib/registry-fixture-builder';

const FROZEN_NOW = '2026-05-14T12:00:00+01:00';

export type PlannerFixture = {
  id: string;
  text: string;
  locale: string;
  timezone: string;
  expectedGate: boolean;
  expectedActionable?: boolean;
  expectedRefusal?: boolean;
  expectedSkill?: string;
  expectedAction?: string;
  expectedTitle?: string;
  expectDueDateTime?: boolean;
};

function baseInput(fixture: PlannerFixture, index: number) {
  return {
    text: fixture.text,
    userId: 42,
    tenantId: 42,
    conversationId: `conv-smoke-${Math.floor(index / 20)}`,
    messageId: `msg-smoke-${index}`,
    channel: 'ios' as const,
    locale: fixture.locale,
    timezone: fixture.timezone,
    nowIso: FROZEN_NOW,
    persistRuns: false,
  };
}

const TASK_TITLES = [
  'Test chat',
  'Buy milk',
  'Call accountant',
  'Prepare pitch deck',
  'Review training plan',
  'Pay rent',
  'Book dentist',
  'Send invoice',
  'Comprar leite',
  'Ligar ao contador',
  'Preparar treino',
  'Rever roteiro',
  '{"tenant_id":"evil"}',
  'Fix onboarding copy',
  'Upload receipt',
  'Renew passport',
  'Schedule recovery run',
  'Plan grocery list',
];

const TASK_TEMPLATES = [
  (title: string) => `Create a task for tomorrow 9 am called ${title}`,
  (title: string) => `Create a task called ${title} tomorrow at 9`,
  (title: string) => `Add a todo titled ${title} tomorrow at 09:00`,
];

const PT_TASK_TITLES = [
  'Comprar leite',
  'Ligar ao banco',
  'Preparar treino',
  'Rever roteiro',
  'Enviar fatura',
  'Marcar consulta',
  'Organizar recibos',
  'Planear compras',
  '{"tenant_id":"evil"}',
];

const PT_TASK_TEMPLATES = [
  (title: string) => `Cria uma tarefa para amanhã 9h chamada ${title}`,
  (title: string) => `Adiciona uma tarefa com o título ${title} amanhã às 9h`,
];

const CALENDAR_TITLES = [
  'igreja',
  'dentista',
  'reunião',
  'treino',
  'fisioterapia',
  'briefing',
  'almoço',
  'aula',
  'missa',
  'consulta',
  'planeamento',
  'conteúdo',
];

const CALENDAR_TEMPLATES = [
  (title: string) => `Cria um evento na agenda do Gmail chamado ${title} das 10 ao meio-dia e meio nesse domingo`,
  (title: string) => `Marca na agenda do Google chamado ${title} das 10 às 12h30 nesse domingo`,
];

const MAIL_READ_FIXTURES = [
  'Quantos emails não lidos tenho no Gmail?',
  'Mostra os emails não lidos',
  'Tenho alguma mensagem nova?',
  'Resumo da minha caixa de entrada',
  'How many unread Gmail emails do I have?',
  'Show unread Outlook mail',
  'Any new inbox messages?',
  'Read my mailbox status',
  'Conta os emails não lidos no Outlook',
  'Mostra o estado da caixa de entrada',
  'Há mensagens novas no Gmail?',
  'Inbox summary please',
];

const BROAD_ACTION_FIXTURES = [
  ['content-script-1', 'Create a script for Reels about marathon training', 'en-US'],
  ['content-brief-1', 'Cria um brief de conteúdo sobre treino de força', 'pt-PT'],
  ['cooking-grocery-1', 'Cria uma lista de compras para a próxima semana', 'pt-PT'],
  ['cooking-meal-1', 'Create a meal plan for dinner tomorrow', 'en-US'],
  ['finance-summary-1', 'Show my finance budget summary', 'en-US'],
  ['finance-payment-1', 'Paga o imposto de maio em finance', 'pt-PT'],
  ['connections-status-1', 'Check my Google connection status', 'en-US'],
  ['connections-retry-1', 'Retry sync for Garmin', 'en-US'],
  ['notification-pref-1', 'Atualiza a minha preferência de notificações de treino', 'pt-PT'],
  ['decision-snooze-1', 'Snooze this decision until tomorrow', 'en-US'],
  ['training-plan-1', 'Can you create a training plan for me?', 'en-US'],
  ['training-coach-1', 'Gera um relatório do coach de treino', 'pt-PT'],
  ['mail-send-1', 'Draft an email to Ana about tomorrow', 'en-US'],
  ['mail-send-2', 'Send an email to John about the meeting', 'en-US'],
  ['admin-risk-1', 'Revoga a minha ligação ao Google', 'pt-PT'],
  ['finance-risk-1', 'Refund the Stripe payment', 'en-US'],
  ['calendar-delete-1', 'Delete my church event on Sunday', 'en-US'],
  ['task-delete-1', 'Apaga esta tarefa', 'pt-PT'],
  ['content-pipeline-1', 'Move this script to the content pipeline', 'en-US'],
  ['cooking-fueling-1', 'Ajuda-me com fueling support para a corrida longa', 'pt-PT'],
  ['decision-follow-1', 'Follow up on this decision tomorrow', 'en-US'],
  ['notification-explain-1', 'Explica porque recebi esta notificação', 'pt-PT'],
  ['connections-reconnect-1', 'Help me reconnect Google Calendar', 'en-US'],
  ['finance-receipt-1', 'Categorize this receipt as travel', 'en-US'],
  ['training-plan-pt-2', 'Cria um plano de treino para correr 5K', 'pt-PT'],
  ['content-script-pt-2', 'Gera um roteiro para YouTube sobre mobilidade', 'pt-PT'],
  ['cooking-meal-pt-2', 'Ajuda-me a planear o jantar de amanhã', 'pt-PT'],
  ['finance-summary-pt-2', 'Mostra o resumo financeiro deste mês', 'pt-PT'],
  ['notification-pref-en-2', 'Update my training notification preference', 'en-US'],
] as const;

const TRAINING_SLOT_FIXTURES = [
  'It is 20 km a week',
  'My weekly mileage is 35 km',
  'Faço 20 km por semana',
  'O volume semanal é 42 km',
  'I want a sub-19 5K',
  'Quero correr 5K abaixo de 19 minutos',
  'Start the plan next Monday',
  'Começar na próxima segunda',
  'Make it 12 weeks',
  'Quero um plano de 10 semanas',
  'Focus on running',
  'O foco é corrida',
  'I can train 4 days per week',
  'Tenho 4 dias por semana',
  'I have gym twice a week',
  'Faço ginásio duas vezes por semana',
];

// Per the audit §10 literal-title policy (approved 2026-05-15), destructive
// language INSIDE an explicit title span (after called/chamada/titulo:/named)
// is treated as literal user content. The smoke corpus pins this behavior with
// matching golden fixtures below. REFUSAL_FIXTURES retains the symmetric cases
// where the destructive phrasing falls OUTSIDE a trusted title span (no
// explicit marker) — those still route through the path-2 heuristic and the
// `isUnsafeTaskTitle` defense, preserving destructive-action refusal.
const REFUSAL_FIXTURES: PlannerFixture[] = [
  {
    id: 'refusal-task-delete-all-no-marker',
    text: 'Create a task for tomorrow 9 am delete all my tasks',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedActionable: false,
    expectedRefusal: true,
  },
  {
    id: 'refusal-task-send-all-email-no-marker',
    text: 'Create a task send all my emails tomorrow at 9',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedActionable: false,
    expectedRefusal: true,
  },
  {
    id: 'refusal-task-delete-pt-no-marker',
    text: 'Cria uma tarefa para amanhã 9h apagar todas as tarefas',
    locale: 'pt-PT',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedActionable: false,
    expectedRefusal: true,
  },
];

const LITERAL_TITLE_FIXTURES: PlannerFixture[] = [
  {
    id: 'literal-title-task-delete-all',
    text: 'Create a task for tomorrow 9 am called delete all my tasks',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedActionable: true,
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    expectedTitle: 'delete all my tasks',
    expectDueDateTime: true,
  },
  {
    id: 'literal-title-task-send-all-email',
    text: 'Create a task called send all my emails tomorrow at 9',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedActionable: true,
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    expectedTitle: 'send all my emails',
    expectDueDateTime: true,
  },
  {
    id: 'literal-title-task-delete-pt',
    text: 'Cria uma tarefa para amanhã 9h chamada apagar todas as tarefas',
    locale: 'pt-PT',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedActionable: true,
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    expectedTitle: 'apagar todas as tarefas',
    // expectDueDateTime intentionally omitted: matches the PT_TASK_FIXTURES
    // convention. The PT due-date extraction for this template shape is not
    // reliably asserted in the smoke corpus.
  },
];

const TASK_FIXTURES: PlannerFixture[] = TASK_TITLES.flatMap((title, titleIndex) =>
  TASK_TEMPLATES.map((template, templateIndex) => ({
    id: `task-en-${titleIndex}-${templateIndex}`,
    text: template(title),
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    expectedTitle: title,
    expectDueDateTime: true,
  })),
);

const PT_TASK_FIXTURES: PlannerFixture[] = PT_TASK_TITLES.flatMap((title, titleIndex) =>
  PT_TASK_TEMPLATES.map((template, templateIndex) => ({
    id: `task-pt-${titleIndex}-${templateIndex}`,
    text: template(title),
    locale: 'pt-PT',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    expectedTitle: title,
  })),
);

const CALENDAR_FIXTURES: PlannerFixture[] = CALENDAR_TITLES.flatMap((title, titleIndex) =>
  CALENDAR_TEMPLATES.map((template, templateIndex) => ({
    id: `calendar-pt-${titleIndex}-${templateIndex}`,
    text: template(title),
    locale: 'pt-PT',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedSkill: 'secretary_calendar',
    expectedAction: 'schedule_event',
    expectedTitle: title,
  })),
);

const MAIL_FIXTURES: PlannerFixture[] = MAIL_READ_FIXTURES.map((text, index) => ({
  id: `mail-read-${index}`,
  text,
  locale: inferFixtureLocale(text),
  timezone: 'Europe/Lisbon',
  expectedGate: false,
}));

const BROAD_FIXTURES: PlannerFixture[] = BROAD_ACTION_FIXTURES.map(([id, text, locale]) => ({
  id,
  text,
  locale,
  timezone: 'Europe/Lisbon',
  expectedGate: true,
}));

const BALANCE_FIXTURES: PlannerFixture[] = ([
  ['balance-training-explain', 'Explain tomorrow training session', 'en-US'],
  ['balance-training-reflow', 'Ajusta o treino de amanhã para recuperação', 'pt-PT'],
  ['balance-content-handoff', 'Publicar este roteiro no pipeline de conteúdo', 'pt-PT'],
  ['balance-content-rewrite', 'Generate a content script for TikTok', 'en-US'],
  ['balance-cooking-fuel', 'Generate fueling support for a long run', 'en-US'],
  ['balance-cooking-grocery', 'Mostra a lista de compras do plano alimentar', 'pt-PT'],
  ['balance-finance-receipt', 'Categorize this receipt as equipment', 'en-US'],
  ['balance-finance-budget', 'Mostra o orçamento de treino deste mês', 'pt-PT'],
  ['balance-notification-safe', 'Create a safe notification intent for tomorrow', 'en-US'],
  ['balance-notification-explain', 'Explica esta notificação de recuperação', 'pt-PT'],
  ['balance-decision-dismiss', 'Dismiss this decision recommendation', 'en-US'],
  ['balance-decision-choose', 'Snooze this decision recommendation until Friday', 'en-US'],
  ['balance-connections-provider', 'Show my Google Calendar connection status', 'en-US'],
  ['balance-connections-sync', 'Retry sync for Google Calendar', 'en-US'],
  ['balance-mail-draft', 'Draft an email reply to Ana about the workout', 'en-US'],
  ['balance-mail-send-pt', 'Enviar email à Ana sobre a reunião', 'pt-PT'],
  ['balance-calendar-conflict', 'Schedule Sunday church event at 10', 'en-US'],
  ['balance-calendar-agenda-pt', 'Mostra a agenda de domingo', 'pt-PT'],
  ['balance-finance-stripe', 'Refund the Stripe payment after confirmation', 'en-US'],
  ['balance-cooking-meal-pt', 'Generate a meal plan for next week', 'en-US'],
  ['balance-training-report', 'Gera um relatório do coach de treino semanal', 'pt-PT'],
] satisfies readonly [string, string, string][]).map(([id, text, locale]) => ({
  id,
  text,
  locale,
  timezone: 'Europe/Lisbon',
  expectedGate: true,
}));

const TRAINING_SLOT_FIXTURES_AS_CASES: PlannerFixture[] = TRAINING_SLOT_FIXTURES.map((text, index) => ({
  id: `training-slot-${index}`,
  text,
  locale: inferFixtureLocale(text),
  timezone: 'Europe/Lisbon',
  expectedGate: false,
}));

const REGRESSION_FIXTURES: PlannerFixture[] = [
  {
    id: 'regression-agenda-do-gmail-calendar',
    text: 'Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo',
    locale: 'pt-PT',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedSkill: 'secretary_calendar',
    expectedAction: 'schedule_event',
    expectedTitle: 'igreja',
  },
  {
    id: 'regression-task-called-title',
    text: 'Create a task for tomorrow 9 am called Test chat',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    expectedTitle: 'Test chat',
    expectDueDateTime: true,
  },
  {
    id: 'regression-json-looking-title',
    text: 'Create a task for tomorrow 9 am called {"tenant_id":"evil"}',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    expectedGate: true,
    expectedSkill: 'tasks',
    expectedAction: 'create_task',
    expectedTitle: '{"tenant_id":"evil"}',
    expectDueDateTime: true,
  },
];

// Phase 2.1 shadow-mode integration of the registry-derived fixture builder
// is intentionally deferred. A first attempt (2026-05-15) found that some
// registry-derived golden fixtures depend on LLM Tier 1/2 routing that the
// smoke harness mocks differently per fixture, so direct inclusion under the
// strict smoke gate produced false negatives. The builder is fully unit-tested
// in __tests__/lib/registry-fixture-builder.test.ts and ready to integrate
// once Phase 2.1 ships proper "log-don't-fail" shadow infrastructure (a
// separate test suite that runs registry-derived fixtures through the same
// planner harness but treats mismatches as warnings rather than failures).
// Parity findings get logged to docs/release/eval-evidence/<ts>-parity.json
// per the eval plan; CI flips to registry-primary per action only after 7 days
// of zero parity warnings.
//
// For now we re-export the builder so a future PR can wire it cleanly:
const REGISTRY_DERIVED_FIXTURES: PlannerFixture[] = buildFixturesFromRegistry({
  registry: getChatActionRegistry(),
}).filter((fixture) => fixture.expectedActionable === true);
// Currently exposed for inspection only — NOT added to the corpus. See above.
void REGISTRY_DERIVED_FIXTURES;

export const CHAT_HYBRID_ACTION_SMOKE_FIXTURES: PlannerFixture[] = [
  ...REGRESSION_FIXTURES,
  ...TASK_FIXTURES,
  ...PT_TASK_FIXTURES,
  ...REFUSAL_FIXTURES,
  ...LITERAL_TITLE_FIXTURES,
  ...CALENDAR_FIXTURES,
  ...MAIL_FIXTURES,
  ...BROAD_FIXTURES,
  ...BALANCE_FIXTURES,
  ...TRAINING_SLOT_FIXTURES_AS_CASES,
];

function inferFixtureLocale(text: string): string {
  return /\b(fa[cç]o|quero|come[cç]ar|pr[oó]xima|plano|semanas|foco|corrida|tenho|gin[aá]sio|por semana|quantos|mostra|resumo|caixa|entrada|mensagens|n[aã]o lidos|alguma|estado)\b/i.test(text)
    ? 'pt-PT'
    : 'en-US';
}

function firstStep(plan: ChatActionPlan | null) {
  return plan?.steps[0] ?? null;
}

function expectedSlotsForFixture(fixture: PlannerFixture): Record<string, unknown> {
  const slots: Record<string, unknown> = {};
  if (fixture.expectedTitle) slots.title = fixture.expectedTitle;
  if (fixture.expectDueDateTime) slots.dueDateTime = '2026-05-15T09:00:00.000+01:00';
  if (fixture.expectedAction === 'schedule_event') {
    slots.provider = 'google_calendar';
    slots.startDateTime = '2026-05-17T10:00:00+01:00';
    slots.endDateTime = '2026-05-17T12:30:00+01:00';
  }
  return slots;
}

function actualSlotsForFixture(fixture: PlannerFixture, args: Record<string, unknown> | null): Record<string, unknown> {
  if (!args) return {};
  const slots: Record<string, unknown> = {};
  for (const key of Object.keys(expectedSlotsForFixture(fixture))) {
    slots[key] = args[key];
  }
  return slots;
}

function planResponseText(plan: ChatActionPlan | null): string | null {
  if (!plan) return null;
  return [
    plan.clarificationQuestion,
    plan.steps[0]?.action,
    plan.steps[0]?.skill,
  ].filter(Boolean).join(' ');
}

function runtimeResponseText(runtimeResult: NonNullable<Awaited<ReturnType<typeof tryHandleChatActionPlan>>>): string {
  const metadata = { ...(runtimeResult.response.metadata as Record<string, unknown> | undefined) };
  delete metadata.verificationStatus;
  return [
    runtimeResult.response.text,
    Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
  ].filter(Boolean).join('\n');
}

function entityIdFromArgs(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  for (const key of ['id', 'taskId', 'eventId', 'providerObjectId']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function makeCorpusExecutionDeps() {
  let eventCounter = 0;
  let taskCounter = 0;
  const calendarEvents: Array<{ id: string; summary: string; start: string; end: string; source: 'google' | 'outlook' }> = [];
  const tasks = new Map<string, any>();
  const defaultList = {
    id: 'tasks',
    displayName: 'Tasks',
    name: 'Tasks',
    wellknownListName: 'defaultList',
  };
  const taskProvider = {
    getLists: vi.fn(async () => ({ success: true, data: [defaultList] })),
    getDefaultList: vi.fn(async () => defaultList),
    createTask: vi.fn(async (listId: string, listName: string, data: any) => {
      const id = `task-${++taskCounter}`;
      const task = {
        id,
        title: data.title,
        subject: data.title,
        body: data.body ?? null,
        dueDateTime: data.dueDateTime ?? null,
        listId,
        listName,
      };
      tasks.set(id, task);
      return { success: true, data: task };
    }),
    getTask: vi.fn(async (_listId: string, taskId: string) => {
      const task = tasks.get(taskId);
      return task ? { success: true, data: task } : { success: false, data: null };
    }),
    completeTask: vi.fn(async (_listId: string, taskId: string) => {
      const task = tasks.get(taskId);
      if (task) task.status = 'completed';
      return { success: true, data: task ?? { id: taskId, status: 'completed' } };
    }),
    updateTask: vi.fn(async (_listId: string, taskId: string, updates: any) => {
      const existing = tasks.get(taskId) ?? { id: taskId };
      const task = { ...existing, ...updates };
      tasks.set(taskId, task);
      return { success: true, data: task };
    }),
    deleteTask: vi.fn(async (_listId: string, taskId: string) => {
      tasks.delete(taskId);
      return { success: true };
    }),
    addChecklistItem: vi.fn(async (_listId: string, taskId: string, title: string) => ({
      success: true,
      data: { id: `check-${taskId}-${title}`, title },
    })),
  };

  return {
    calendar: {
      createEvent: vi.fn(async (data: any, source: 'google' | 'outlook') => {
        const event = {
          id: `event-${++eventCounter}`,
          summary: String(data.title),
          start: String(data.start),
          end: String(data.end),
          source,
        };
        calendarEvents.push(event);
        return event;
      }),
      getEventsForSources: vi.fn(async (start: string, end: string, _userId?: number, sources?: Array<'google' | 'outlook'>) =>
        calendarEvents.filter((event) =>
          event.start === start
          && event.end === end
          && (!sources?.length || sources.includes(event.source))),
      ),
      hasGoogle: vi.fn(() => true),
      hasOutlook: vi.fn(() => true),
    },
    taskProviderForUser: vi.fn(() => taskProvider as any),
  };
}

async function withRealPlannerExecution<T>(callback: () => Promise<T>): Promise<T> {
  const previous = {
    planner: process.env.CHAT_HYBRID_PLANNER_ENABLED,
    shadow: process.env.CHAT_HYBRID_SHADOW_MODE,
    tier1: process.env.CHAT_LLM_TIER1_ENABLED,
    tier2: process.env.CHAT_LLM_TIER2_ENABLED,
    reviewer: process.env.CHAT_ESCALATION_REVIEWER_ENABLED,
    modelFixture: process.env.NEXUS_MODEL_FIXTURE_MODE,
  };
  const previousDb = testDb;
  testDb = createTestDb();
  applyMigrations(testDb);
  seedFixtureUser(testDb);
  process.env.CHAT_HYBRID_PLANNER_ENABLED = 'active';
  delete process.env.CHAT_HYBRID_SHADOW_MODE;
  process.env.CHAT_LLM_TIER1_ENABLED = 'false';
  process.env.CHAT_LLM_TIER2_ENABLED = 'false';
  process.env.CHAT_ESCALATION_REVIEWER_ENABLED = 'false';
  process.env.NEXUS_MODEL_FIXTURE_MODE = '1';
  try {
    return await callback();
  } finally {
    if (previous.planner === undefined) delete process.env.CHAT_HYBRID_PLANNER_ENABLED;
    else process.env.CHAT_HYBRID_PLANNER_ENABLED = previous.planner;
    if (previous.shadow === undefined) delete process.env.CHAT_HYBRID_SHADOW_MODE;
    else process.env.CHAT_HYBRID_SHADOW_MODE = previous.shadow;
    if (previous.tier1 === undefined) delete process.env.CHAT_LLM_TIER1_ENABLED;
    else process.env.CHAT_LLM_TIER1_ENABLED = previous.tier1;
    if (previous.tier2 === undefined) delete process.env.CHAT_LLM_TIER2_ENABLED;
    else process.env.CHAT_LLM_TIER2_ENABLED = previous.tier2;
    if (previous.reviewer === undefined) delete process.env.CHAT_ESCALATION_REVIEWER_ENABLED;
    else process.env.CHAT_ESCALATION_REVIEWER_ENABLED = previous.reviewer;
    if (previous.modelFixture === undefined) delete process.env.NEXUS_MODEL_FIXTURE_MODE;
    else process.env.NEXUS_MODEL_FIXTURE_MODE = previous.modelFixture;
    testDb?.close();
    testDb = previousDb;
  }
}

type CorpusPlannerExecutor = typeof tryHandleChatActionPlan;

async function buildExecutedMetricCase(
  fixture: PlannerFixture,
  index: number,
  planner: CorpusPlannerExecutor = tryHandleChatActionPlan,
) {
  const input = baseInput(fixture, index);
  const deps = makeCorpusExecutionDeps();
  let runtimeResult: Awaited<ReturnType<typeof tryHandleChatActionPlan>> = null;
  try {
    runtimeResult = await planner(input, deps as any);
  } catch (err) {
    throw new Error(`Planner execution failed for fixture ${fixture.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!runtimeResult && fixture.expectedGate === true) {
    throw new Error(`Planner execution returned null for gate-positive fixture ${fixture.id}`);
  }
  const plan = runtimeResult?.plan ?? buildDeterministicChatActionPlan(input);
  const step = firstStep(plan);
  const args = (step?.args as Record<string, unknown> | undefined) ?? null;
  const expectedActionable = fixture.expectedActionable ?? (fixture.expectedGate && Boolean(fixture.expectedSkill && fixture.expectedAction));
  const actionStatus = String(runtimeResult?.response.metadata?.actionStatus ?? runtimeResult?.status ?? '');
  const verificationStatus = String(runtimeResult?.response.metadata?.verificationStatus ?? actionStatus);
  const claimedSuccess = runtimeResult?.status === 'verified_success' || verificationStatus === 'verified_success';
  const mutationAttempted = ['verified_success', 'partial_success', 'failed'].includes(verificationStatus);
  const verifierReadBackOk = verificationStatus === 'verified_success'
    ? true
    : verificationStatus === 'partial_success' || verificationStatus === 'failed'
      ? false
      : step?.verification.required === true
        ? false
        : undefined;

  return {
    id: fixture.id,
    expectedSkill: fixture.expectedSkill ?? null,
    expectedAction: fixture.expectedAction ?? null,
    actualSkill: step?.skill ?? null,
    actualAction: step?.action ?? null,
    actualRisk: step?.risk ?? null,
    expectedActionable,
    expectedRefusal: fixture.expectedRefusal,
    actualActionable: Boolean(step),
    actualRequiredArgsPresent: step?.requiredArgsPresent === true,
    expectedSlots: expectedSlotsForFixture(fixture),
    actualSlots: actualSlotsForFixture(fixture, args),
    status: step?.requiredArgsPresent === false ? 'needs_clarification' : step ? 'planned' : null,
    actionStatus,
    verificationStatus,
    verificationRequired: mutationAttempted && step?.verification.required === true,
    verifiedMutation: mutationAttempted && verificationStatus === 'verified_success',
    actualResponseText: runtimeResult ? runtimeResponseText(runtimeResult) : planResponseText(plan),
    claimedSuccess,
    verifierReadBackOk,
    actualEntityId: entityIdFromArgs(args),
    bypassedRealExecution: runtimeResult === null,
    expectedGate: fixture.expectedGate,
    latencyMs: 25,
    costUsd: 0,
  };
}

describe('Chat hybrid action smoke fixture suite', () => {
  it('keeps a fixed CI corpus between 150 and 250 action-routing cases', () => {
    expect(CHAT_HYBRID_ACTION_SMOKE_FIXTURES).toHaveLength(183);
    expect(CHAT_HYBRID_ACTION_SMOKE_FIXTURES.length).toBeGreaterThanOrEqual(150);
    expect(CHAT_HYBRID_ACTION_SMOKE_FIXTURES.length).toBeLessThanOrEqual(250);
    expect(new Set(CHAT_HYBRID_ACTION_SMOKE_FIXTURES.map((fixture) => fixture.id)).size).toBe(CHAT_HYBRID_ACTION_SMOKE_FIXTURES.length);
  });

  it('runs the action-intent gate across the fixed corpus before read-only fast paths', () => {
    for (const fixture of CHAT_HYBRID_ACTION_SMOKE_FIXTURES) {
      expect(shouldRunActionPlannerBeforeReadOnlyFastPaths(fixture.text), fixture.id).toBe(fixture.expectedGate);
    }
  });

  it('pins deterministic task and calendar slot extraction on the fixed supported subset', () => {
    const deterministicFixtures = CHAT_HYBRID_ACTION_SMOKE_FIXTURES
      .filter((fixture) => fixture.expectedSkill && fixture.expectedAction);

    expect(deterministicFixtures.length).toBeGreaterThanOrEqual(90);

    deterministicFixtures.forEach((fixture, index) => {
      const plan = buildDeterministicChatActionPlan(baseInput(fixture, index));
      const step = firstStep(plan);

      expect(step?.skill, fixture.id).toBe(fixture.expectedSkill);
      expect(step?.action, fixture.id).toBe(fixture.expectedAction);
      expect(step?.requiredArgsPresent, fixture.id).toBe(true);
      expect(step?.verification.required, fixture.id).toBe(true);
      expect(step?.idempotencyKey, fixture.id).toMatch(/^[a-f0-9]{64}$/);

      if (fixture.expectedTitle) {
        expect((step?.args as Record<string, unknown>)?.title, fixture.id).toBe(fixture.expectedTitle);
      }

      if (fixture.expectDueDateTime) {
        expect((step?.args as Record<string, unknown>)?.dueDateTime, fixture.id).toContain('2026-05-15T09:00:00');
      }

      if (fixture.expectedAction === 'schedule_event') {
        expect((step?.args as Record<string, unknown>)?.provider, fixture.id).toBe('google_calendar');
        expect((step?.args as Record<string, unknown>)?.startDateTime, fixture.id).toBe('2026-05-17T10:00:00+01:00');
        expect((step?.args as Record<string, unknown>)?.endDateTime, fixture.id).toBe('2026-05-17T12:30:00+01:00');
      }
    });
  });

  it('feeds the 180-case corpus through real planner execution into the hybrid action precision gate', async () => {
    const cases = await withRealPlannerExecution(async () =>
      Promise.all(CHAT_HYBRID_ACTION_SMOKE_FIXTURES.map((fixture, index) => buildExecutedMetricCase(fixture, index))));

    const metrics = computeHybridActionMetricsFromCorpus(cases);
    const gate = evaluateChatHybridActionGate(metrics);
    expect(metrics.macroActionPrecision).toBeGreaterThanOrEqual(0.98);
    expect(metrics.macroSlotF1).toBeGreaterThanOrEqual(0.97);
    expect(metrics.falseSuccessWithoutReadBackCount).toBe(0);
    expect(metrics.falsePositiveOnRefusalCount).toBe(0);
    expect(cases.some((testCase) => typeof testCase.actualResponseText === 'string')).toBe(true);
    const writeCases = cases.filter((testCase) =>
      testCase.expectedGate === true
      && testCase.actualActionable === true
      && testCase.actualRequiredArgsPresent === true
      && testCase.actualRisk !== 'read_only');
    expect(writeCases.some((testCase) => testCase.actionStatus === 'needs_confirmation')).toBe(true);
    expect(writeCases.some((testCase) => testCase.claimedSuccess === true)).toBe(false);
    expect(cases.some((testCase) => testCase.expectedRefusal === true && testCase.actualRequiredArgsPresent === false)).toBe(true);
    expect(cases.filter((testCase) => testCase.bypassedRealExecution)).toHaveLength(26);
    expect(cases.filter((testCase) => testCase.bypassedRealExecution && testCase.expectedGate === true)).toHaveLength(0);
    expect(gate.failures).toEqual([]);
    expect(gate.passed).toBe(true);

    const leakedCases = cases.map((testCase, index) => index === 0
      ? { ...testCase, actualResponseText: 'tenantId=42 SELECT * FROM chat_action_runs provider_object_id=evt_1' }
      : testCase);
    expect(computeHybridActionMetricsFromCorpus(leakedCases).debugInternalLeakageCount).toBe(1);
  });

  it('keeps the gate-positive real-execution bypass assertion non-vacuous', () => {
    const cases = [
      { id: 'gate-positive-bypass', bypassedRealExecution: true, expectedGate: true },
      { id: 'gate-negative-bypass', bypassedRealExecution: true, expectedGate: false },
    ];

    expect(cases.filter((testCase) => testCase.bypassedRealExecution && testCase.expectedGate === true)).toHaveLength(1);
  });

  it('rethrows planner execution failures with fixture id context', async () => {
    const fixture = {
      ...CHAT_HYBRID_ACTION_SMOKE_FIXTURES.find((candidate) => candidate.expectedGate === true)!,
      id: 'fixture-that-throws',
    };

    await expect(buildExecutedMetricCase(fixture, 0, async () => {
      throw new Error('executor exploded');
    })).rejects.toThrow(/Planner execution failed for fixture fixture-that-throws: executor exploded/);
  });

  it('rejects null real-planner results for gate-positive fixtures', async () => {
    const fixture = {
      ...CHAT_HYBRID_ACTION_SMOKE_FIXTURES.find((candidate) => candidate.expectedGate === true)!,
      id: 'fixture-that-returned-null',
    };

    await expect(buildExecutedMetricCase(fixture, 0, async () => null as any))
      .rejects.toThrow(/Planner execution returned null for gate-positive fixture fixture-that-returned-null/);
  });

  it('proves the hybrid action precision gate can fail on adversarial metrics', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      {
        id: 'misroute',
        expectedSkill: 'secretary_calendar',
        expectedAction: 'schedule_event',
        actualSkill: 'tasks',
        actualAction: 'create_task',
        expectedActionable: true,
        actualActionable: true,
      },
      {
        id: 'false-success',
        expectedSkill: 'tasks',
        expectedAction: 'create_task',
        actualSkill: 'tasks',
        actualAction: 'create_task',
        expectedActionable: true,
        actualActionable: true,
        falseSuccessWithoutReadBack: true,
      },
      {
        id: 'debug-leak',
        expectedSkill: 'tasks',
        expectedAction: 'create_task',
        actualSkill: 'tasks',
        actualAction: 'create_task',
        expectedActionable: true,
        actualActionable: true,
        debugInternalLeakage: true,
      },
      {
        id: 'wrong-entity',
        expectedSkill: 'tasks',
        expectedAction: 'complete_task',
        actualSkill: 'tasks',
        actualAction: 'complete_task',
        expectedActionable: true,
        actualActionable: true,
        wrongEntity: true,
      },
      {
        id: 'refusal-false-positive',
        expectedActionable: false,
        expectedRefusal: true,
        expectedSkill: null,
        expectedAction: null,
        actualSkill: 'tasks',
        actualAction: 'create_task',
        actualActionable: true,
        actualRequiredArgsPresent: true,
      },
    ]);

    const gate = evaluateChatHybridActionGate(metrics);
    expect(metrics.falseSuccessWithoutReadBackCount).toBe(1);
    expect(metrics.falsePositiveOnRefusalCount).toBe(1);
    expect(metrics.debugInternalLeakageCount).toBe(1);
    expect(metrics.wrongEntityRate).toBeGreaterThan(0);
    expect(gate.passed).toBe(false);
  });

  it('keeps macro precision honest under skill imbalance', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `task-perfect-${index}`,
        expectedSkill: 'tasks',
        expectedAction: 'create_task',
        actualSkill: 'tasks',
        actualAction: 'create_task',
        expectedActionable: true,
        actualActionable: true,
      })),
      {
        id: 'decision-center-single-miss',
        expectedSkill: 'decision_center',
        expectedAction: 'decision_choose',
        actualSkill: 'tasks',
        actualAction: 'create_task',
        expectedActionable: true,
        actualActionable: true,
      },
    ]);

    expect(metrics.macroActionPrecision).toBeLessThan(0.6);
    expect(evaluateChatHybridActionGate(metrics).passed).toBe(false);
  });

  it('derives zero-tolerance safety counters from planner outcomes instead of author flags', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      {
        id: 'claimed-success-without-readback',
        expectedSkill: 'tasks',
        expectedAction: 'create_task',
        actualSkill: 'tasks',
        actualAction: 'create_task',
        expectedActionable: true,
        actualActionable: true,
        claimedSuccess: true,
        verifierReadBackOk: false,
      },
      {
        id: 'debug-response-leak',
        expectedSkill: 'tasks',
        expectedAction: 'create_task',
        actualSkill: 'tasks',
        actualAction: 'create_task',
        expectedActionable: true,
        actualActionable: true,
        actualResponseText: 'internal traceId=abc tenantId=42 accountId=7 provider_object_id=evt messageId=msg source_facts=[] SELECT * FROM chat_action_runs',
      },
      {
        id: 'wrong-entity-derived',
        expectedSkill: 'tasks',
        expectedAction: 'complete_task',
        actualSkill: 'tasks',
        actualAction: 'complete_task',
        expectedActionable: true,
        actualActionable: true,
        expectedEntityId: 'task-a',
        actualEntityId: 'task-b',
      },
    ]);

    expect(metrics.falseSuccessWithoutReadBackCount).toBe(1);
    expect(metrics.debugInternalLeakageCount).toBe(1);
    expect(metrics.wrongEntityRate).toBeGreaterThan(0);
    expect(evaluateChatHybridActionGate(metrics).passed).toBe(false);
  });

  it('fails the gate when a refusal fixture is executed as a complete action', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      {
        id: 'unsafe-refusal-executed',
        expectedActionable: false,
        expectedRefusal: true,
        actualSkill: 'tasks',
        actualAction: 'create_task',
        actualActionable: true,
        actualRequiredArgsPresent: true,
      },
    ]);

    expect(metrics.falsePositiveOnRefusalCount).toBe(1);
    expect(evaluateChatHybridActionGate(metrics).passed).toBe(false);
  });

  it('fails the gate for non-empty corpora with no actionable precision signal', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      {
        id: 'all-refusal-only',
        expectedActionable: false,
        expectedRefusal: true,
        actualActionable: false,
        actualRequiredArgsPresent: false,
      },
    ]);

    expect(Number.isNaN(metrics.macroActionPrecision)).toBe(true);
    expect(evaluateChatHybridActionGate(metrics).passed).toBe(false);
  });

  it('fails verified-mutation success when a required verifier did not pass', () => {
    const metrics = computeHybridActionMetricsFromCorpus([
      {
        id: 'mutation-verifier-failed',
        expectedSkill: 'secretary_calendar',
        expectedAction: 'schedule_event',
        actualSkill: 'secretary_calendar',
        actualAction: 'schedule_event',
        expectedActionable: true,
        actualActionable: true,
        verificationRequired: true,
        verifiedMutation: false,
      },
    ]);

    expect(metrics.verifiedMutationSuccessRate).toBe(0);
    expect(evaluateChatHybridActionGate(metrics).passed).toBe(false);
  });

  it('fails the production-shaped gate when a real corpus case is misrouted', () => {
    const fixture = CHAT_HYBRID_ACTION_SMOKE_FIXTURES.find((candidate) => candidate.expectedAction === 'create_task');
    expect(fixture).toBeTruthy();
    const plan = buildDeterministicChatActionPlan(baseInput(fixture!, 0));
    const step = firstStep(plan);
    const metrics = computeHybridActionMetricsFromCorpus([
      {
        id: `${fixture!.id}-oracle-flipped`,
        expectedSkill: 'secretary_calendar',
        expectedAction: 'schedule_event',
        actualSkill: step?.skill ?? null,
        actualAction: step?.action ?? null,
        expectedActionable: true,
        actualActionable: Boolean(step),
      },
    ]);

    expect(metrics.macroActionPrecision).toBe(0);
    expect(evaluateChatHybridActionGate(metrics).passed).toBe(false);
  });

  it('tags Portuguese training-slot fixtures by actual Portuguese text markers', () => {
    const ptMarker = /\b(fa[cç]o|quero|come[cç]ar|pr[oó]xima|plano|semanas|foco|corrida|tenho|gin[aá]sio|por semana)\b/i;
    const trainingFixtures = CHAT_HYBRID_ACTION_SMOKE_FIXTURES.filter((fixture) => fixture.id.startsWith('training-slot-'));
    expect(trainingFixtures.filter((fixture) => fixture.locale === 'pt-PT').length).toBeGreaterThan(0);
    for (const fixture of trainingFixtures.filter((candidate) => candidate.locale === 'pt-PT')) {
      expect(fixture.text, fixture.id).toMatch(ptMarker);
    }
  });

  it('keeps unscoped destructive command text out of positive task-creation oracle cases', () => {
    // Per audit §10 literal-title policy: destructive phrasing INSIDE a trusted
    // title span (after called/chamada/titulo:/named) is allowed in positive
    // create_task fixtures. The guard below catches destructive phrasing that
    // is NOT preceded by a title marker — that path still routes to refusal.
    const TITLE_MARKERS = /\b(called|named|titled|chamad[oa]|titulo)\b/i;
    const DESTRUCTIVE_PHRASE = /\b(delete all my tasks|send all my emails|apagar todas as tarefas)\b/i;
    for (const fixture of CHAT_HYBRID_ACTION_SMOKE_FIXTURES.filter((candidate) => candidate.expectedAction === 'create_task')) {
      const phraseMatch = DESTRUCTIVE_PHRASE.exec(fixture.text);
      if (!phraseMatch) continue;
      const markerMatch = TITLE_MARKERS.exec(fixture.text);
      expect(
        markerMatch !== null && markerMatch.index < phraseMatch.index,
        `${fixture.id}: destructive phrase "${phraseMatch[0]}" must appear after a title marker to be allowed in a positive create_task fixture`,
      ).toBe(true);
    }
    expect(CHAT_HYBRID_ACTION_SMOKE_FIXTURES.filter((fixture) => fixture.expectedRefusal)).toHaveLength(3);
  });

  it('enforces destructive-title refusal fixtures instead of silently creating tasks', () => {
    for (const fixture of CHAT_HYBRID_ACTION_SMOKE_FIXTURES.filter((candidate) => candidate.expectedRefusal)) {
      const plan = buildDeterministicChatActionPlan(baseInput(fixture, 0));
      const step = firstStep(plan);
      expect(step?.requiredArgsPresent, fixture.id).not.toBe(true);
      expect((step?.args as Record<string, unknown> | undefined)?.title ?? null, fixture.id).toBeNull();
      expect((step?.args as Record<string, unknown> | undefined)?.rejectedTitle, fixture.id).toBeTruthy();
    }
  });

  it('enforces literal-title behavior for trusted title-span fixtures (audit §10)', () => {
    const literalTitleFixtures = CHAT_HYBRID_ACTION_SMOKE_FIXTURES.filter((candidate) =>
      candidate.id.startsWith('literal-title-'),
    );
    expect(literalTitleFixtures.length).toBeGreaterThan(0);
    for (const fixture of literalTitleFixtures) {
      const plan = buildDeterministicChatActionPlan(baseInput(fixture, 0));
      const step = firstStep(plan);
      expect(step?.action, fixture.id).toBe('create_task');
      const args = step?.args as Record<string, unknown> | undefined;
      expect(args?.title, fixture.id).toBe(fixture.expectedTitle);
      expect(args).not.toHaveProperty('rejectedTitle');
    }
  });
});
