// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText, hasCalendarWriteIntent, hasMailReadIntent } from './calendar-natural-language-parser';

export type ChatActionSkill =
  | 'secretary_calendar'
  | 'mail'
  | 'tasks'
  | 'training'
  | 'content'
  | 'cooking'
  | 'finance'
  | 'connections'
  | 'notifications'
  | 'decision_center';

export type ChatActionRisk =
  | 'read_only'
  | 'safe_write'
  | 'external_side_effect'
  | 'destructive'
  | 'financial'
  | 'admin_security'
  | 'ambiguous';

export type ChatActionRiskClass = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export type ChatActionName =
  | 'schedule_event'
  | 'update_event'
  | 'move_event'
  | 'delete_event'
  | 'check_calendar_conflicts'
  | 'summarize_agenda'
  | 'mail_unread_count'
  | 'mail_inbox_summary'
  | 'draft_email'
  | 'send_email'
  | 'create_task'
  | 'update_task'
  | 'complete_task'
  | 'delete_task'
  | 'create_checklist'
  | 'set_task_reminder'
  | 'training_explain_session'
  | 'training_coach_report'
  | 'training_plan_create'
  | 'training_reflow_preview'
  | 'training_reflow_confirm'
  | 'training_adjust_plan'
  | 'content_brief_create'
  | 'content_script_create'
  | 'content_rewrite'
  | 'content_schedule_work'
  | 'content_pipeline_handoff'
  | 'cooking_meal_support'
  | 'cooking_grocery_list'
  | 'cooking_meal_plan'
  | 'cooking_fueling_support'
  | 'finance_summary'
  | 'finance_create_reminder'
  | 'finance_categorize_receipt'
  | 'finance_payment_action'
  | 'connections_status'
  | 'connections_retry_sync'
  | 'connections_reconnect_guidance'
  | 'notification_explain'
  | 'notification_update_preference'
  | 'notification_create_intent'
  | 'decision_choose'
  | 'decision_dismiss'
  | 'decision_snooze'
  | 'decision_follow_up';

export type ChatProvider =
  | 'google_calendar'
  | 'outlook_calendar'
  | 'gmail'
  | 'outlook_mail'
  | 'nexus'
  | 'stripe'
  | 'telegram'
  | 'none';

export interface ChatActionDefinition {
  skill: ChatActionSkill;
  action: ChatActionName;
  version?: string;
  readableIntents: string[];
  requiredFields: string[];
  optionalFields: string[];
  slotExtractors?: string[];
  slotValidators?: string[];
  providerDependencies: ChatProvider[];
  risk: ChatActionRisk;
  riskClass?: ChatActionRiskClass;
  confirmationPolicy: 'none' | 'clarify' | 'confirm' | 'strong_confirm';
  executionPolicy?: 'read_only' | 'idempotent_write' | 'preview_then_confirm' | 'blocked';
  executor: string;
  verifier: 'provider_read_back' | 'local_read_back' | 'none';
  verificationPolicy?: 'provider_readback_required' | 'local_readback_required' | 'not_required';
  uiSurfaces?: string[];
  examples?: Array<{ text: string; expectedSlots?: Record<string, unknown> }>;
  supportedCards: string[];
}

const STATUS_CARDS = [
  'understood_action',
  'checking_provider',
  'needs_input',
  'needs_confirmation',
  'executing',
  'verified_success',
  'verified_pending',
  'partial_success',
  'failed',
  'blocked',
  'retry',
  'undo',
  'connect_provider',
  'open_skill',
  'open_surface',
];

export const CHAT_ACTION_REGISTRY: ChatActionDefinition[] = [
  {
    skill: 'secretary_calendar',
    action: 'schedule_event',
    readableIntents: ['create calendar event', 'schedule meeting', 'marca na agenda', 'agenda do gmail'],
    requiredFields: ['title', 'startDateTime', 'endDateTime', 'timezone', 'provider'],
    optionalFields: ['calendarId', 'attendees', 'location', 'notes', 'recurrence'],
    providerDependencies: ['google_calendar', 'outlook_calendar'],
    risk: 'safe_write',
    confirmationPolicy: 'none',
    executor: 'unified_calendar.createEvent',
    verifier: 'provider_read_back',
    supportedCards: STATUS_CARDS,
    examples: [
      {
        text: 'Cria um evento na agenda do Gmail chamado igreja das 10 ao meio-dia e meio nesse domingo',
        expectedSlots: { title: 'igreja', provider: 'google_calendar' },
      },
    ],
  },
  {
    skill: 'secretary_calendar',
    action: 'update_event',
    readableIntents: ['change event', 'update calendar event'],
    requiredFields: ['eventId', 'changedFields'],
    optionalFields: ['provider', 'calendarId'],
    providerDependencies: ['google_calendar', 'outlook_calendar'],
    risk: 'safe_write',
    confirmationPolicy: 'confirm',
    executor: 'unified_calendar.updateEvent',
    verifier: 'provider_read_back',
    supportedCards: STATUS_CARDS,
  },
  {
    skill: 'secretary_calendar',
    action: 'move_event',
    readableIntents: ['move event', 'reschedule event'],
    requiredFields: ['eventId', 'startDateTime', 'endDateTime'],
    optionalFields: ['provider', 'calendarId'],
    providerDependencies: ['google_calendar', 'outlook_calendar'],
    risk: 'safe_write',
    confirmationPolicy: 'confirm',
    executor: 'unified_calendar.updateEvent',
    verifier: 'provider_read_back',
    supportedCards: STATUS_CARDS,
  },
  {
    skill: 'secretary_calendar',
    action: 'delete_event',
    readableIntents: ['delete event', 'cancel event', 'apaga o evento'],
    requiredFields: ['eventId'],
    optionalFields: ['provider', 'calendarId'],
    providerDependencies: ['google_calendar', 'outlook_calendar'],
    risk: 'destructive',
    confirmationPolicy: 'confirm',
    executor: 'unified_calendar.deleteEvent',
    verifier: 'provider_read_back',
    supportedCards: STATUS_CARDS,
  },
  {
    skill: 'secretary_calendar',
    action: 'check_calendar_conflicts',
    readableIntents: ['check conflicts', 'am I free'],
    requiredFields: ['startDateTime', 'endDateTime'],
    optionalFields: ['provider'],
    providerDependencies: ['google_calendar', 'outlook_calendar'],
    risk: 'read_only',
    confirmationPolicy: 'none',
    executor: 'unified_calendar.getEventsForSources',
    verifier: 'none',
    supportedCards: STATUS_CARDS,
  },
  {
    skill: 'secretary_calendar',
    action: 'summarize_agenda',
    readableIntents: ['agenda today', 'calendar summary'],
    requiredFields: ['date'],
    optionalFields: ['provider'],
    providerDependencies: ['google_calendar', 'outlook_calendar'],
    risk: 'read_only',
    confirmationPolicy: 'none',
    executor: 'daily_brief_orchestrator.composeDailyBrief',
    verifier: 'none',
    supportedCards: STATUS_CARDS,
  },
  {
    skill: 'mail',
    action: 'mail_unread_count',
    readableIntents: ['unread mail', 'unread gmail', 'inbox count'],
    requiredFields: ['provider'],
    optionalFields: [],
    providerDependencies: ['gmail', 'outlook_mail'],
    risk: 'read_only',
    confirmationPolicy: 'none',
    executor: 'unified_mail.getUnreadMailSummaryForUser',
    verifier: 'none',
    supportedCards: STATUS_CARDS,
  },
  {
    skill: 'mail',
    action: 'mail_inbox_summary',
    readableIntents: ['inbox summary', 'summarize email'],
    requiredFields: ['provider'],
    optionalFields: ['limit', 'query'],
    providerDependencies: ['gmail', 'outlook_mail'],
    risk: 'read_only',
    confirmationPolicy: 'none',
    executor: 'mail.summary',
    verifier: 'none',
    supportedCards: STATUS_CARDS,
  },
  {
    skill: 'mail',
    action: 'draft_email',
    readableIntents: ['draft email'],
    requiredFields: ['recipient', 'subject', 'body'],
    optionalFields: ['provider'],
    providerDependencies: ['gmail', 'outlook_mail'],
    risk: 'safe_write',
    confirmationPolicy: 'confirm',
    executor: 'mail.draft',
    verifier: 'provider_read_back',
    supportedCards: STATUS_CARDS,
  },
  {
    skill: 'mail',
    action: 'send_email',
    readableIntents: ['send email'],
    requiredFields: ['recipient', 'subject', 'body'],
    optionalFields: ['provider', 'attachments'],
    providerDependencies: ['gmail', 'outlook_mail'],
    risk: 'external_side_effect',
    confirmationPolicy: 'confirm',
    executor: 'mail.send',
    verifier: 'provider_read_back',
    supportedCards: STATUS_CARDS,
  },
  ...([
    ['tasks', 'create_task', 'safe_write', 'none', 'task_store.createTask', 'local_read_back', ['title']],
    ['tasks', 'update_task', 'safe_write', 'confirm', 'task_store.updateTask', 'local_read_back', ['taskId', 'changedFields']],
    ['tasks', 'complete_task', 'safe_write', 'none', 'task_store.updateTask', 'local_read_back', ['taskId']],
    ['tasks', 'delete_task', 'destructive', 'confirm', 'task_store.deleteTask', 'local_read_back', ['taskId']],
    ['tasks', 'create_checklist', 'safe_write', 'none', 'task_store.createTaskWithChecklist', 'local_read_back', ['title', 'items']],
    ['tasks', 'set_task_reminder', 'safe_write', 'confirm', 'task_store.updateTask', 'local_read_back', ['taskId', 'reminderAt']],
    ['training', 'training_explain_session', 'read_only', 'none', 'training.sessionExplain', 'none', ['sessionId']],
    ['training', 'training_coach_report', 'read_only', 'none', 'training.coachReport', 'none', ['dateRange']],
    ['training', 'training_plan_create', 'safe_write', 'clarify', 'training.planBuilderHandoff', 'none', ['sport', 'goal', 'durationWeeks', 'startDate', 'weeklyVolumeKm']],
    ['training', 'training_reflow_preview', 'safe_write', 'confirm', 'training.reflowPreview', 'local_read_back', ['sessionId']],
    ['training', 'training_reflow_confirm', 'safe_write', 'confirm', 'training.reflowConfirm', 'local_read_back', ['sessionId']],
    ['training', 'training_adjust_plan', 'safe_write', 'confirm', 'training.adjustPlan', 'local_read_back', ['planId', 'changeRequest']],
    ['content', 'content_brief_create', 'safe_write', 'none', 'content.agencyBrief', 'local_read_back', ['objective', 'platform']],
    ['content', 'content_script_create', 'safe_write', 'none', 'content.scriptCreate', 'local_read_back', ['topic', 'platform']],
    ['content', 'content_rewrite', 'safe_write', 'none', 'content.rewrite', 'local_read_back', ['sourceText', 'objective']],
    ['content', 'content_schedule_work', 'safe_write', 'none', 'content.scheduleWork', 'local_read_back', ['title', 'dateTime']],
    ['content', 'content_pipeline_handoff', 'safe_write', 'confirm', 'content.pipelineHandoff', 'local_read_back', ['packageId']],
    ['cooking', 'cooking_meal_support', 'read_only', 'none', 'cooking.mealSupport', 'none', ['mealContext']],
    ['cooking', 'cooking_grocery_list', 'safe_write', 'none', 'cooking.groceryList', 'local_read_back', ['weekStart']],
    ['cooking', 'cooking_meal_plan', 'safe_write', 'none', 'cooking.mealPlan', 'local_read_back', ['date', 'mealType', 'title']],
    ['cooking', 'cooking_fueling_support', 'read_only', 'none', 'cooking.fuelingSupport', 'none', ['trainingContext']],
    ['finance', 'finance_summary', 'read_only', 'none', 'finance.summary', 'none', ['month']],
    ['finance', 'finance_create_reminder', 'safe_write', 'confirm', 'finance.createReminder', 'local_read_back', ['title', 'dueDate']],
    ['finance', 'finance_categorize_receipt', 'safe_write', 'confirm', 'finance.categorizeReceipt', 'local_read_back', ['receiptId', 'category']],
    ['finance', 'finance_payment_action', 'financial', 'strong_confirm', 'stripe.safeMutation', 'provider_read_back', ['action', 'amount']],
    ['connections', 'connections_status', 'read_only', 'none', 'connections.status', 'none', []],
    ['connections', 'connections_retry_sync', 'safe_write', 'confirm', 'connections.retrySync', 'local_read_back', ['provider']],
    ['connections', 'connections_reconnect_guidance', 'read_only', 'none', 'connections.reconnectGuidance', 'none', ['provider']],
    ['notifications', 'notification_explain', 'read_only', 'none', 'notifications.explain', 'none', ['topic']],
    ['notifications', 'notification_update_preference', 'safe_write', 'confirm', 'notifications.updatePreference', 'local_read_back', ['preference']],
    ['notifications', 'notification_create_intent', 'safe_write', 'confirm', 'notifications.createIntent', 'local_read_back', ['title', 'trigger']],
    ['decision_center', 'decision_choose', 'safe_write', 'confirm', 'decisionCenter.choose', 'local_read_back', ['decisionId', 'choice']],
    ['decision_center', 'decision_dismiss', 'safe_write', 'confirm', 'decisionCenter.dismiss', 'local_read_back', ['decisionId']],
    ['decision_center', 'decision_snooze', 'safe_write', 'confirm', 'decisionCenter.snooze', 'local_read_back', ['decisionId', 'until']],
    ['decision_center', 'decision_follow_up', 'safe_write', 'none', 'decisionCenter.followUp', 'local_read_back', ['decisionId']],
  ] as const).map(([skill, action, risk, confirmationPolicy, executor, verifier, requiredFields]) => ({
    skill: skill as ChatActionSkill,
    action: action as ChatActionName,
    readableIntents: [String(action).replace(/_/g, ' ')],
    requiredFields: requiredFields as unknown as string[],
    optionalFields: [],
    providerDependencies: ['nexus'] as ChatProvider[],
    risk: risk as ChatActionRisk,
    confirmationPolicy: confirmationPolicy as ChatActionDefinition['confirmationPolicy'],
    executor,
    verifier: verifier as ChatActionDefinition['verifier'],
    supportedCards: STATUS_CARDS,
  })),
];

export function getChatActionRegistry(): ChatActionDefinition[] {
  return CHAT_ACTION_REGISTRY.map((entry) => ({
    ...entry,
    version: entry.version ?? '2026-05-14',
    riskClass: entry.riskClass ?? riskClassForRisk(entry.risk),
    slotExtractors: entry.slotExtractors ?? ['deterministic_patterns', 'llm_allowed'],
    slotValidators: entry.slotValidators ?? entry.requiredFields.map((field) => `${field}_required`),
    executionPolicy: entry.executionPolicy ?? (entry.risk === 'read_only' ? 'read_only' : entry.risk === 'ambiguous' ? 'blocked' : 'idempotent_write'),
    verificationPolicy: entry.verificationPolicy ?? (
      entry.verifier === 'provider_read_back'
        ? 'provider_readback_required'
        : entry.verifier === 'local_read_back'
          ? 'local_readback_required'
          : 'not_required'
    ),
    uiSurfaces: entry.uiSurfaces ?? defaultUiSurfaces(entry.skill, entry.action),
    supportedCards: [...entry.supportedCards],
    examples: entry.examples ? [...entry.examples] : [],
  }));
}

export function findChatActionDefinition(skill: ChatActionSkill, action: ChatActionName): ChatActionDefinition | null {
  return CHAT_ACTION_REGISTRY.find((entry) => entry.skill === skill && entry.action === action) ?? null;
}

export function selectRegistrySubsetForMessage(text: string): ChatActionDefinition[] {
  const folded = foldCalendarText(text);
  const selected = new Set<ChatActionSkill>();
  if (hasCalendarWriteIntent(text) || /\b(calendar|calendario|agenda|evento|event)\b/.test(folded)) selected.add('secretary_calendar');
  if (hasMailReadIntent(text) || /\b(email|mail|gmail|outlook mail|inbox|caixa de entrada)\b/.test(folded)) selected.add('mail');
  if (/\b(task|todo|tarefa|subtarefa|checklist|lembrete|reminder)\b/.test(folded)) selected.add('tasks');
  if (/\b(treino|training|plan[o]? de treino|corrida|gym|ginasio)\b/.test(folded)) selected.add('training');
  if (/\b(content|conteudo|conteudo|script|roteiro|reel|tiktok|youtube|brief)\b/.test(folded)) selected.add('content');
  if (/\b(cozinha|meal|refeicao|jantar|almoco|ceia|lanche|comida|grocery|compras|fueling)\b/.test(folded)) selected.add('cooking');
  if (/\b(finance|financas|financeiro|financeira|pagamento|stripe|invoice|fatura|recibo|receipt)\b/.test(folded)) selected.add('finance');
  if (/\b(connection|conexao|ligacao|google|outlook|garmin|health)\b/.test(folded)) selected.add('connections');
  if (/\b(notification|notificacao|notificacoes|alerta|push)\b/.test(folded)) selected.add('notifications');
  if (/\b(decision|decisao|escolha|snooze|adiar)\b/.test(folded)) selected.add('decision_center');
  if (selected.size === 0) return [];
  return getChatActionRegistry().filter((entry) => selected.has(entry.skill));
}

export function messageHasActionCandidate(text: string): boolean {
  const subset = selectRegistrySubsetForMessage(text);
  if (subset.length === 0) return false;
  const folded = foldCalendarText(text);
  return /\b(cria|criar|gera|gerar|marca|marcar|agenda|agendar|adiciona|adicionar|coloca|mete|poe|faz|apaga|apagar|remove|delete|move|mover|send|enviar|draft|create|add|generate|schedule|complete|concluir|reflow|ajusta|ajustar|atualiza|atualizar|adjust|update|publish|publicar|paga|pay|refund|categorize|rotate|revoke|revoga|revogar|mostra|mostrar|show|list|listar|resume|summary|relatorio|relatório|explain|explica|help|ajuda|check|retry|reconnect|snooze|dismiss|follow)\b/.test(folded);
}

function riskClassForRisk(risk: ChatActionRisk): ChatActionRiskClass {
  if (risk === 'read_only') return 'R0';
  if (risk === 'safe_write') return 'R1';
  if (risk === 'external_side_effect') return 'R2';
  if (risk === 'destructive' || risk === 'financial' || risk === 'admin_security') return 'R3';
  return 'R4';
}

function defaultUiSurfaces(skill: ChatActionSkill, action: ChatActionName): string[] {
  if (skill === 'training' && action === 'training_plan_create') return ['training_plan_builder'];
  if (skill === 'content') return ['script_studio', 'content_pipeline'];
  if (skill === 'tasks') return ['task_detail'];
  if (skill === 'secretary_calendar') return ['calendar_event'];
  if (skill === 'finance') return ['finance_review'];
  if (skill === 'cooking') return ['cooking_meal_plan'];
  return [skill];
}
