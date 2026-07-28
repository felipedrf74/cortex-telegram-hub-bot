// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  NexusChatExpectedResponseShape,
  NexusChatGroundingRequirement,
  NexusChatOwnerSkill,
  NexusChatRiskLevel,
  NexusChatRouteKind,
} from './chat-answer-contract';

export interface ChatBilingualEvalFixture {
  skill: Exclude<NexusChatOwnerSkill, 'owner_admin' | 'chat' | 'system'> | 'calendar';
  expectedOwnerSkill: Exclude<NexusChatOwnerSkill, 'owner_admin' | 'chat' | 'system'>;
  scenario: string;
  pt: string;
  en: string;
  expectedRouteKind: NexusChatRouteKind;
  expectedGrounding: NexusChatGroundingRequirement;
  expectedResponseShape: NexusChatExpectedResponseShape;
  expectedRiskClass: NexusChatRiskLevel | 'destructive';
  maxInputTokens: number;
  maxOutputTokens: number;
}

const LOW = { maxInputTokens: 900, maxOutputTokens: 650 };
const LOCAL = { maxInputTokens: 1100, maxOutputTokens: 650 };
const ACTION = { maxInputTokens: 1200, maxOutputTokens: 600 };
const WEB = { maxInputTokens: 1400, maxOutputTokens: 750 };

export const CHAT_BILINGUAL_EVAL_FIXTURES: ChatBilingualEvalFixture[] = [
  ...skill('secretary', 'agenda_summary', [
    ['day_summary', 'Mostra o meu dia hoje', 'Show my day today', 'local_read', 'local'],
    ['next_best_action', 'O que devo fazer a seguir hoje?', 'What should I do next today?', 'local_read', 'local'],
    ['overloaded_day', 'Estou sobrecarregado hoje?', 'Am I overloaded today?', 'local_read', 'local'],
    ['free_window', 'Tenho uma janela livre hoje?', 'Do I have a free window today?', 'local_read', 'local'],
    ['provider_degraded', 'Porque a minha agenda está indisponível?', 'Why is my agenda unavailable?', 'local_read', 'local'],
    ['focus_protection', 'Protege tempo de foco hoje', 'Protect focus time today', 'action', 'local'],
    ['week_view', 'Mostra a minha semana', 'Show my week', 'local_read', 'local'],
    ['what_changed', 'O que mudou no meu plano?', 'What changed in my plan?', 'local_read', 'local'],
    ['conflicting_tasks_calendar', 'Tenho tarefas a competir com reuniões?', 'Do I have tasks competing with meetings?', 'local_read', 'local'],
    ['portuguese_agenda_question', 'agenda do Gmail', 'Gmail agenda', 'local_read', 'local'],
    ['gmail_agenda_variant', 'agenda no Gmail', 'Gmail calendar', 'local_read', 'local'],
    ['google_calendar_agenda_variant', 'meu calendário do Gmail', 'my Google Calendar agenda', 'local_read', 'local'],
  ]),
  ...skill('calendar', 'agenda_summary', [
    ['today_agenda', 'O que tenho no calendário hoje?', 'What is on my calendar today?', 'local_read', 'local'],
    ['create_event', 'Agenda reunião com Ana amanhã às 10h', 'Schedule a meeting with Ana tomorrow at 10am', 'action', 'local'],
    ['reschedule_event', 'Remarca esta reunião para sexta', 'Reschedule this meeting to Friday', 'action', 'local'],
    ['cancel_event', 'Cancela esta reunião', 'Cancel this meeting', 'action', 'local'],
    ['cancel_event_subjunctive', 'Cancele todas as reuniões', 'Cancel all meetings', 'action', 'local', 'agenda_summary', 'destructive'],
    ['remove_events_subjunctive', 'Remova todos os eventos', 'Remove all events', 'action', 'local', 'agenda_summary', 'destructive'],
    ['conflict_check', 'Este horário tem conflito na agenda?', 'Does this time conflict with my calendar?', 'local_read', 'local'],
    ['focus_block', 'Cria foco de 1h no calendário', 'Create a 1h focus block on my calendar', 'action', 'local'],
    ['provider_preference', 'Qual calendário principal está ativo?', 'Which primary calendar is active?', 'local_read', 'local'],
    ['recurring_event', 'Agenda reunião recorrente toda terça', 'Schedule a recurring meeting every Tuesday', 'action', 'local'],
    ['ambiguous_event', 'Move esse evento', 'Move that event', 'action', 'local'],
    ['public_holiday', 'Último feriado público em Lisboa para este mês', 'Latest public holiday in Lisbon this month', 'internet_research', 'web', 'direct_answer'],
  ], 'secretary'),
  ...skill('tasks', 'task_options', [
    ['create_task', 'Cria uma tarefa para comprar leite amanhã', 'Create a task to buy milk tomorrow', 'action', 'local'],
    ['due_date_extraction', 'Adiciona tarefa chamada relatório para sexta às 9h', 'Add a task called report for Friday at 9am', 'action', 'local'],
    ['complete_recent_task', 'Marca esta tarefa como concluída', 'Mark this task as done', 'action', 'local'],
    ['ambiguous_completion', 'Conclui essa tarefa', 'Complete that task', 'action', 'local'],
    ['list_overdue', 'Mostra tarefas atrasadas', 'Show overdue tasks', 'local_read', 'local'],
    ['update_title', 'Muda o título desta tarefa', 'Change this task title', 'action', 'local'],
    ['command_like_literal_title', 'Cria uma tarefa chamada apagar todas as minhas tarefas', 'Create a task called delete all my tasks', 'action', 'local', 'task_options', 'medium'],
    ['bare_chain_destructive_literal_title', 'Cria uma tarefa chamada relatório e apaga todas as minhas tarefas', 'Create a task called report and delete all my tasks', 'action', 'local', 'task_options', 'destructive'],
    ['delete_confirmation', 'Apaga todas as minhas tarefas', 'Delete all my tasks', 'action', 'local', 'task_options', 'destructive'],
    ['delete_confirmation_subjunctive', 'Apague todas as minhas tarefas', 'Please delete all my tasks', 'action', 'local', 'task_options', 'destructive'],
    ['remove_confirmation_subjunctive', 'Remova todas as minhas tarefas', 'Remove every task', 'action', 'local', 'task_options', 'destructive'],
    ['latest_tasks_local', 'Minhas tarefas mais recentes', 'Show my latest tasks', 'local_read', 'local'],
    ['recurring_task', 'Cria uma tarefa recorrente toda segunda', 'Create a recurring task every Monday', 'action', 'local'],
    ['task_pressure_summary', 'Estou com muita pressão de tarefas hoje?', 'Do I have high task pressure today?', 'local_read', 'local'],
  ]),
  ...skill('training', 'training_advice', [
    ['create_plan', 'Cria um plano de treino', 'Create a training plan', 'action', 'local'],
    ['simple_strength_advice', 'Como monto um plano simples de força?', 'How do I build a simple strength plan?', 'generic_skill_answer', 'none'],
    ['adjust_plan', 'Ajusta o meu plano de treino desta semana', 'Adjust my training plan this week', 'action', 'local'],
    ['recovery_question', 'Estou recuperado para treinar hoje?', 'Am I recovered enough to train today?', 'local_read', 'local'],
    ['schedule_conflict', 'O treino de hoje conflita com a agenda?', 'Does today’s workout conflict with my calendar?', 'local_read', 'local'],
    ['readiness_question', 'Como está a minha prontidão?', 'How is my readiness?', 'local_read', 'local'],
    ['event_prep', 'Como preparo a prova de domingo?', 'How should I prepare for Sunday’s race?', 'generic_skill_answer', 'none'],
    ['delete_plan', 'Apaga o meu plano de treino', 'Delete my training plan', 'action', 'local'],
    ['eliminate_plan_subjunctive', 'Elimine o plano de treino', 'Eliminate the training plan', 'action', 'local', 'training_advice', 'destructive'],
    ['pending_plan_continuation', 'São 20 km por semana', 'It is 20 km a week', 'repair', 'local'],
    ['injury_safety', 'Tenho dor no joelho, devo treinar?', 'I have knee pain, should I train?', 'internet_research', 'local_and_web'],
  ]),
  ...skill('content', 'content_draft', [
    ['generate_draft', 'Gera um rascunho de conteúdo sobre recuperação', 'Generate a content draft about recovery', 'action', 'local'],
    ['rewrite_hook', 'Reescreve este gancho', 'Rewrite this hook', 'action', 'local'],
    ['title_ideas', 'Dá ideias de títulos para este vídeo', 'Give me title ideas for this video', 'generic_skill_answer', 'none'],
    ['caption_pack', 'Cria legendas para este post', 'Create captions for this post', 'action', 'local'],
    ['source_backed_topic', 'Pesquisa fontes atuais sobre IA para um roteiro', 'Research current sources about AI for a script', 'internet_research', 'web'],
    ['creator_voice_question', 'Qual voz devo usar neste conteúdo?', 'What voice should I use in this content?', 'local_read', 'local'],
    ['fresh_research_request', 'Faz pesquisa fresca para este tema', 'Do fresh research for this topic', 'internet_research', 'web'],
    ['repurpose', 'Transforma este roteiro em Reels', 'Repurpose this script into Reels', 'action', 'local'],
    ['quality_critique', 'Critica a qualidade deste roteiro', 'Critique the quality of this script', 'local_read', 'local'],
    ['budget_constrained_action', 'Gera só um rascunho barato', 'Generate only a low-cost draft', 'action', 'local'],
  ]),
  ...skill('cooking', 'recipe', [
    ['generic_recipe', 'Me indique uma receita de legumes assados para 3 pessoas', 'Suggest an oven-baked vegetable recipe for 3 people', 'generic_skill_answer', 'none'],
    ['recipe_scaling', 'Adapta uma receita de frango para 4 pessoas', 'Scale a chicken recipe for 4 people', 'generic_skill_answer', 'none'],
    ['meal_plan_read', 'O que planeei comer esta semana?', 'What meals did I plan this week?', 'local_read', 'local', 'direct_answer'],
    ['grocery_list', 'Mostra a minha lista de compras', 'Show my grocery list', 'local_read', 'local', 'direct_answer'],
    ['pantry_based_suggestion', 'O que posso cozinhar com a minha despensa?', 'What can I cook from my pantry?', 'local_read', 'local', 'direct_answer'],
    ['nutrition_fueling', 'O que comer antes de um treino duro?', 'What should I eat before a hard workout?', 'generic_skill_answer', 'none', 'direct_answer'],
    ['dietary_restriction', 'Receita sem lactose para jantar', 'Lactose-free dinner recipe', 'generic_skill_answer', 'none'],
    ['cooking_timing', 'Quanto tempo assam legumes no forno?', 'How long do oven-roasted vegetables take?', 'generic_skill_answer', 'none'],
    ['unsafe_food_handling', 'Últimas regras de segurança para sobras de frango', 'Latest safety guidance for chicken leftovers', 'internet_research', 'web', 'direct_answer'],
    ['portuguese_recipe_repair', 'Não, eu pedi receita de legumes assados', 'No, I asked for a roasted vegetable recipe', 'repair', 'local'],
  ]),
  ...skill('finance', 'finance_summary', [
    ['spending_summary', 'Quanto gastei este mês?', 'How much did I spend this month?', 'local_read', 'local'],
    ['budget_question', 'Como está o meu orçamento?', 'How is my budget?', 'local_read', 'local'],
    ['account_unavailable', 'Porque a conta financeira está indisponível?', 'Why is the finance account unavailable?', 'local_read', 'local'],
    ['transaction_search', 'Procura a transação do supermercado', 'Find the grocery transaction', 'local_read', 'local'],
    ['category_explanation', 'Explica a categoria de despesa dedutível', 'Explain deductible expense categories', 'generic_skill_answer', 'none'],
    ['recurring_charge', 'Tenho alguma cobrança recorrente?', 'Do I have a recurring charge?', 'local_read', 'local'],
    ['savings_scenario', 'Como posso poupar mais este mês?', 'How can I save more this month?', 'local_read', 'local'],
    ['investment_boundary', 'Última recomendação de investimento para comprar hoje', 'Latest investment recommendation to buy today', 'internet_research', 'web'],
    ['bill_reminder', 'Cria lembrete para pagar a fatura', 'Create a reminder to pay the bill', 'action', 'local'],
    ['currency_current_info', 'Qual é o câmbio atual EUR BRL?', 'What is the current EUR BRL exchange rate?', 'internet_research', 'web'],
  ]),
  ...skill('connections', 'connection_status', [
    ['provider_status', 'O Gmail está conectado?', 'Is Gmail connected?', 'local_read', 'local'],
    ['connect_gmail', 'Ajuda-me a conectar Gmail', 'Help me connect Gmail', 'generic_skill_answer', 'none'],
    ['connect_google_calendar', 'Ajuda-me a conectar Google Calendar', 'Help me connect Google Calendar', 'generic_skill_answer', 'none'],
    ['outlook_recovery', 'Porque o Outlook falhou?', 'Why did Outlook fail?', 'local_read', 'local'],
    ['apple_health_state', 'Apple Health está disponível?', 'Is Apple Health available?', 'local_read', 'local'],
    ['provider_mismatch', 'Gmail deve escrever na agenda?', 'Should Gmail write to calendar?', 'generic_skill_answer', 'none'],
    ['expired_token', 'Meu token Google expirou?', 'Did my Google token expire?', 'local_read', 'local'],
    ['preferred_provider', 'Qual é meu provedor principal?', 'What is my primary provider?', 'local_read', 'local'],
    ['integration_troubleshooting', 'Como resolvo uma integração quebrada?', 'How do I fix a broken integration?', 'generic_skill_answer', 'none'],
    ['privacy_question', 'Que dados a conexão vê?', 'What data does the connection see?', 'generic_skill_answer', 'none'],
  ]),
  ...skill('notifications', 'notification_summary', [
    ['unread_alert_summary', 'Mostra meus alertas não lidos', 'Show my unread alerts', 'local_read', 'local'],
    ['notification_settings', 'Quais são minhas configurações de notificação?', 'What are my notification settings?', 'local_read', 'local'],
    ['missed_notification', 'Porque perdi esta notificação?', 'Why did I miss this notification?', 'local_read', 'local'],
    ['channel_health', 'O canal push está saudável?', 'Is the push channel healthy?', 'local_read', 'local'],
    ['apns_device_token', 'Meu token APNs foi registrado?', 'Was my APNs token registered?', 'local_read', 'local'],
    ['quiet_hours', 'Como funcionam horas silenciosas?', 'How do quiet hours work?', 'generic_skill_answer', 'none'],
    ['decision_alert', 'Ativa alertas de decisão', 'Turn on decision alerts', 'action', 'local'],
    ['calendar_reminder', 'Cria uma notificação para reunião', 'Create a meeting notification', 'action', 'local'],
    ['provider_delivery_failure', 'Falhou entrega de notificação?', 'Did notification delivery fail?', 'local_read', 'local'],
    ['test_notification', 'Envia uma notificação de teste', 'Send a test notification', 'action', 'local'],
  ]),
  ...skill('decision_center', 'decision_summary', [
    ['queue_status', 'O que está no Decision Center?', 'What is in Decision Center?', 'local_read', 'local'],
    ['explain_decision', 'Explica esta decisão', 'Explain this decision', 'local_read', 'local'],
    ['resolve_decision', 'Escolhe esta opção', 'Choose this option', 'action', 'local'],
    ['all_clear_meaning', 'O que significa All Clear?', 'What does All Clear mean?', 'local_read', 'local'],
    ['streak_state', 'Como está minha sequência de decisões?', 'How is my decision streak?', 'local_read', 'local'],
    ['at_risk_streak', 'Minha sequência está em risco?', 'Is my streak at risk?', 'local_read', 'local'],
    ['decision_priority', 'Qual decisão é prioridade?', 'Which decision is priority?', 'local_read', 'local'],
    ['create_decision', 'Cria uma decisão sobre contratar designer', 'Create a decision about hiring a designer', 'action', 'local'],
    ['decision_history', 'Mostra histórico de decisões', 'Show decision history', 'local_read', 'local'],
    ['ambiguous_decision_action', 'Faz isso na decisão', 'Do that on the decision', 'action', 'local'],
  ]),
];

/**
 * es-419 vs pt-BR confusable prompt/response pairs for the locale-fidelity
 * gate (Milestone 3). Each fixture carries the prompt in its locale, the
 * correct on-locale response, and the sibling-language leak shape the
 * detector must flag. The es-419 leak shapes pin the recurring failure class
 * observed in the only live eval evidence collected (es-419 prompts answered
 * in Portuguese — see portugueseLocalizationLeakage in chat-hybrid-metrics).
 */
export interface ChatLocaleConfusableEvalFixture {
  scenario: string;
  promptLocale: 'es-419' | 'pt-BR';
  expectedResponseLanguage: 'es' | 'pt';
  prompt: string;
  onLocaleResponse: string;
  crossLocaleLeakResponse: string;
}

export const CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES: ChatLocaleConfusableEvalFixture[] = [
  ...confusablePair('task_create_short_ack', {
    es: ['Crea una tarea para comprar leche mañana', 'Listo, creé la tarea para comprar leche mañana.'],
    pt: ['Cria uma tarefa para comprar leite amanhã', 'Pronto, criei a tarefa para comprar leite amanhã.'],
  }),
  ...confusablePair('known_leak_planner_review', {
    // Pinned live-eval leak shape: es-419 prompt answered in Portuguese.
    es: ['Crea una tarea llamada revisión del planificador', 'Creé la tarea llamada revisión del planificador.'],
    pt: ['Cria uma tarefa chamada revisão do planejador', 'Criei a tarefa chamada revisão do planificador. Precisa de mais alguma coisa?'],
  }),
  ...confusablePair('meeting_date_confirmation', {
    es: ['Agenda una reunión con Ana el viernes a las 10', 'Agendé la reunión con Ana para el viernes a las 10 de la mañana.'],
    pt: ['Agenda uma reunião com a Ana na sexta às 10', 'Agendei a reunião com a Ana para sexta-feira às 10 da manhã.'],
  }),
  ...confusablePair('overdue_task_list', {
    es: ['Muéstrame las tareas atrasadas', 'Tienes 3 tareas atrasadas: revisión del informe, pagar la factura y llamar al médico.'],
    pt: ['Mostra as tarefas atrasadas', 'Você tem 3 tarefas atrasadas: revisão do relatório, pagar a fatura e ligar para o médico.'],
  }),
  ...confusablePair('task_completion_ack', {
    es: ['Marca esta tarea como completada', 'Hecho, marqué la tarea como completada.'],
    pt: ['Marca esta tarefa como concluída', 'Feito, marquei a tarefa como concluída.'],
  }),
  ...confusablePair('agenda_day_summary', {
    es: ['¿Qué tengo en la agenda hoy?', 'Hoy tienes dos reuniones y una ventana libre después del almuerzo.'],
    pt: ['O que tenho na agenda hoje?', 'Hoje você tem duas reuniões e uma janela livre depois do almoço.'],
  }),
  ...confusablePair('weekday_reminder', {
    es: ['Recuérdame pagar el alquiler el lunes', 'Listo, te recordaré pagar el alquiler el lunes también.'],
    pt: ['Lembra-me de pagar o aluguel na segunda', 'Pronto, vou lembrar você de pagar o aluguel na segunda-feira também.'],
  }),
  ...confusablePair('task_not_found_repair', {
    es: ['Completa la tarea informe mensual', 'No encontré ninguna tarea con ese nombre. ¿Puedes darme más detalles?'],
    pt: ['Conclui a tarefa relatório mensal', 'Não encontrei nenhuma tarefa com esse nome. Pode dar mais detalhes?'],
  }),
];

function confusablePair(
  scenario: string,
  variants: { es: [string, string]; pt: [string, string] },
): ChatLocaleConfusableEvalFixture[] {
  const [esPrompt, esResponse] = variants.es;
  const [ptPrompt, ptResponse] = variants.pt;
  return [
    {
      scenario: `${scenario}_es419`,
      promptLocale: 'es-419',
      expectedResponseLanguage: 'es',
      prompt: esPrompt,
      onLocaleResponse: esResponse,
      crossLocaleLeakResponse: ptResponse,
    },
    {
      scenario: `${scenario}_ptbr`,
      promptLocale: 'pt-BR',
      expectedResponseLanguage: 'pt',
      prompt: ptPrompt,
      onLocaleResponse: ptResponse,
      crossLocaleLeakResponse: esResponse,
    },
  ];
}

function skill(
  skillName: ChatBilingualEvalFixture['skill'],
  shape: NexusChatExpectedResponseShape,
  rows: Array<[
    string,
    string,
    string,
    NexusChatRouteKind,
    NexusChatGroundingRequirement,
    NexusChatExpectedResponseShape?,
    ChatBilingualEvalFixture['expectedRiskClass']?,
  ]>,
  expectedOwnerSkill = skillName as ChatBilingualEvalFixture['expectedOwnerSkill'],
): ChatBilingualEvalFixture[] {
  return rows.map(([scenario, pt, en, routeKind, grounding, rowShape, expectedRiskClass]) => ({
    skill: skillName,
    expectedOwnerSkill,
    scenario,
    pt,
    en,
    expectedRouteKind: routeKind,
    expectedGrounding: grounding,
    expectedResponseShape: rowShape ?? shape,
    expectedRiskClass: expectedRiskClass ?? inferExpectedRiskClass(pt, en, routeKind, expectedOwnerSkill),
    ...(grounding === 'web' ? WEB : routeKind === 'action' ? ACTION : grounding === 'local' ? LOCAL : LOW),
  }));
}

function inferExpectedRiskClass(
  pt: string,
  en: string,
  routeKind: NexusChatRouteKind,
  expectedOwnerSkill: ChatBilingualEvalFixture['expectedOwnerSkill'],
): NexusChatRiskLevel | 'destructive' {
  const text = foldFixture(`${pt} ${en}`);
  if (/\ball\s+clear\b/.test(text)) return 'low';
  if (hasDestructiveCommandOutsideLiteralTitle(text)) return 'destructive';
  if (expectedOwnerSkill === 'finance' && routeKind === 'action') return 'high';
  if (/\b(injury|pain|medical|legal|tax\s+advice|investment|dose|dosage|depression|anxiety|lesao|dor|medico|juridico|investimento|dosagem|depressao|ansiedade)\b/.test(text)) return 'high';
  if (routeKind === 'action' || hasMediumRiskActionVerb(text)) return 'medium';
  return 'low';
}

function foldFixture(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function hasDestructiveCommandOutsideLiteralTitle(text: string): boolean {
  if (!/\b(delete|remove|cancel|clear|eliminate|apaga|apagar|apague|apaguem|remove|remover|remova|removam|cancela|cancelar|cancele|cancelem|limpa|limpar|elimina|eliminar|elimine|eliminem|exclui|excluir|exclua|excluam)\b/.test(text)) return false;
  const literalTitle = /\b(create|add|new|cria|criar|crie|adiciona|adicionar|nova|novo)\b.{0,80}\b(task|todo|tarefa|note|nota)\b/.test(text)
    && /\b(called|titled|named|chamada|chamado|intitulada|intitulado|titulo|com\s+(?:o\s+)?nome)\b/.test(text);
  if (!literalTitle) return true;
  return /\b(?:and\s+then|and|then|after\s+that|also|e\s+depois|e|depois|tambem)\s+(?:delete|remove|cancel|clear|eliminate|apaga|apagar|apague|apaguem|remove|remover|remova|removam|cancela|cancelar|cancele|cancelem|limpa|limpar|elimina|eliminar|elimine|eliminem|exclui|excluir|exclua|excluam)\b/.test(text)
    || /[,;]\s*(?:delete|remove|cancel|clear|eliminate|apaga|apagar|apague|apaguem|remove|remover|remova|removam|cancela|cancelar|cancele|cancelem|limpa|limpar|elimina|eliminar|elimine|eliminem|exclui|excluir|exclua|excluam)\b/.test(text);
}

function hasMediumRiskActionVerb(text: string): boolean {
  return /\b(create|add|schedule|book|move|reschedule|adjust|change|complete|mark|send|draft|generate|publish|choose|dismiss|snooze|retry|connect|disconnect|activate|apply|protect|rewrite|repurpose|transform|turn\s+on|turn\s+off|cria|criar|crie|adiciona|agendar|marca|marcar|move|mover|muda|mudar|remarca|ajusta|alterar|concluir|conclui|envia|gera|gerar|aplica|aplicar|reescreve|reescrever|transforma|transformar|publicar|escolhe|adiar|ligar|desligar|ativa|ativar|reconectar|protege|proteger)\b/.test(text);
}
