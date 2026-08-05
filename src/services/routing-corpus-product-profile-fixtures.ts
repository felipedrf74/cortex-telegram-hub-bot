// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Deterministic, synthetic English and Portuguese prompts that complete the
 * owner-reviewable product-profile routing corpus. These are labeling
 * suggestions only: the corpus builder keeps every row pending until the
 * owner-gated labeling step records the golden label.
 */
export type RoutingCorpusProductProfileLocale = 'en' | 'pt';

export type RoutingCorpusProductProfileLabelDomain =
  | 'secretary'
  | 'triathlon'
  | 'content'
  | 'finance'
  | 'cooking'
  | 'connections'
  | 'notifications'
  | 'decision_center'
  | 'clarify'
  | 'none';

export type RoutingCorpusProductProfileLabelSkill =
  | 'secretary_calendar'
  | 'secretary_reminders'
  | 'mail'
  | 'tasks'
  | 'training'
  | 'content'
  | 'finance'
  | 'cooking'
  | 'connections'
  | 'notifications'
  | 'decision_center';

export interface RoutingCorpusProductProfileFixture {
  locale: RoutingCorpusProductProfileLocale;
  prompt: string;
  labelDomain: RoutingCorpusProductProfileLabelDomain;
  labelSkill: RoutingCorpusProductProfileLabelSkill | null;
}

/**
 * Context-free routing projections for bilingual chat fixtures whose original
 * turn intentionally depends on prior conversation state. The shared chat
 * evaluation fixtures stay unchanged; only the standalone routing corpus gets
 * enough product context to carry a defensible gold label.
 */
const ROUTING_CORPUS_BILINGUAL_PROMPT_OVERRIDES: Record<
  string,
  { en: string; pt: string }
> = {
  pending_plan_continuation: {
    en: 'Use 4 sessions per week for my new 12-week running 10K training plan starting next week.',
    pt: 'Use 4 treinos por semana no meu novo plano de corrida de 10K por 12 semanas começando na próxima semana.',
  },
  fresh_research_request: {
    en: 'Do fresh research on recovery trends for a new content script.',
    pt: 'Faça uma pesquisa atual sobre tendências de recuperação para um novo roteiro de conteúdo.',
  },
  budget_constrained_action: {
    en: 'Generate only a low-cost content draft about post-race recovery.',
    pt: 'Gere apenas um rascunho de conteúdo de baixo custo sobre recuperação pós-prova.',
  },
  resolve_decision: {
    en: 'Choose option A for the pending decision about hiring a designer.',
    pt: 'Escolha a opção A para a decisão pendente sobre contratar um designer.',
  },
  what_changed: {
    en: 'What changed in today’s agenda and task plan?',
    pt: 'O que mudou na agenda e no plano de tarefas de hoje?',
  },
};

const ROUTING_CORPUS_SECRETARY_CALENDAR_SCENARIOS = new Set([
  'free_window',
  'provider_degraded',
  'focus_protection',
  'portuguese_agenda_question',
  'gmail_agenda_variant',
  'google_calendar_agenda_variant',
]);

export function projectBilingualFixturePromptForRoutingCorpus(
  scenario: string,
  locale: RoutingCorpusProductProfileLocale,
  original: string,
): string {
  return ROUTING_CORPUS_BILINGUAL_PROMPT_OVERRIDES[scenario]?.[locale] ?? original;
}

export function isRoutingCorpusSecretaryCalendarScenario(scenario: string): boolean {
  return ROUTING_CORPUS_SECRETARY_CALENDAR_SCENARIOS.has(scenario);
}

export const ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES = [
  {
    locale: 'en',
    prompt: 'Remind me tomorrow at 3 PM to call the dentist.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'Amanhã às 15h, me lembre de ligar para o dentista.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: 'Set a weekly reminder every Monday at 8 AM to review my budget.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'Crie um lembrete semanal toda segunda-feira às 8h para revisar meu orçamento.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: 'Remind me on July 31 at 6 PM to water the plants.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'No dia 31 de julho às 18h, me lembre de regar as plantas.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: 'Set a reminder for Friday at noon to submit the expense report.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'Crie um lembrete para sexta-feira ao meio-dia para enviar o relatório de despesas.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: 'Remind me in two hours to take the laundry out of the washer.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'Daqui a duas horas, me lembre de tirar a roupa da máquina.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: 'Set a monthly reminder on the first day at 9 AM to check my subscriptions.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'Crie um lembrete mensal no primeiro dia de cada mês às 9h para conferir minhas assinaturas.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: 'Remind me tomorrow at 7:30 AM to pack my running shoes.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'Amanhã às 7h30, me lembre de colocar o tênis de corrida na mochila.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: 'Set a reminder for next Tuesday at 4 PM to call the accountant.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'Crie um lembrete para a próxima terça-feira às 16h para ligar para o contador.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: "Remind me every evening at 9 PM to prepare tomorrow's plan.",
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'Todas as noites às 21h, me lembre de preparar o plano do dia seguinte.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: 'Set a reminder for September 5 at 10 AM to renew my passport.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'pt',
    prompt: 'Crie um lembrete para 5 de setembro às 10h para renovar meu passaporte.',
    labelDomain: 'secretary',
    labelSkill: 'secretary_reminders',
  },
  {
    locale: 'en',
    prompt: 'How many unread emails are in my Outlook inbox?',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Quantos e-mails não lidos há na minha caixa de entrada do Outlook?',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: 'Show me the unread message count in Gmail.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Mostre a quantidade de mensagens não lidas no Gmail.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: 'Summarize the five newest emails in my inbox.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Resuma os cinco e-mails mais recentes da minha caixa de entrada.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: 'Give me a summary of the emails Ana sent this week.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Faça um resumo dos e-mails que a Ana enviou esta semana.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: "Draft an email to Pedro about Friday's project review.",
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Rascunhe um e-mail para o Pedro sobre a revisão do projeto de sexta-feira.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: 'Compose an email to my manager with subject Vacation dates and body I will be away from August 12 to August 16.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Escreva um e-mail para meu gerente com o assunto Datas de férias e o texto Estarei ausente de 12 a 16 de agosto.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: 'Draft an email to the accountant asking for the missing receipt.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Rascunhe um e-mail para o contador pedindo o recibo que está faltando.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: 'Send an email to ana@example.com with subject Lunch and body Can we meet at noon?',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Envie um e-mail para ana@example.com com o assunto Almoço e o texto Podemos nos encontrar ao meio-dia?',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: 'Send an Outlook email to Pedro saying the meeting moved to Monday.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Envie um e-mail pelo Outlook para o Pedro dizendo que a reunião foi transferida para segunda-feira.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: 'Draft a polite follow-up email about the pending proposal.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'pt',
    prompt: 'Rascunhe um e-mail educado de acompanhamento sobre a proposta pendente.',
    labelDomain: 'secretary',
    labelSkill: 'mail',
  },
  {
    locale: 'en',
    prompt: 'Move it to Friday.',
    labelDomain: 'clarify',
    labelSkill: null,
  },
  {
    locale: 'pt',
    prompt: 'Mova isso para sexta-feira.',
    labelDomain: 'clarify',
    labelSkill: null,
  },
  {
    locale: 'en',
    prompt: 'Cancel that.',
    labelDomain: 'clarify',
    labelSkill: null,
  },
  {
    locale: 'pt',
    prompt: 'Cancele isso.',
    labelDomain: 'clarify',
    labelSkill: null,
  },
  {
    locale: 'en',
    prompt: 'Send it now.',
    labelDomain: 'clarify',
    labelSkill: null,
  },
  {
    locale: 'pt',
    prompt: 'Envie isso agora.',
    labelDomain: 'clarify',
    labelSkill: null,
  },
  {
    locale: 'en',
    prompt: 'Create one for tomorrow morning.',
    labelDomain: 'clarify',
    labelSkill: null,
  },
  {
    locale: 'pt',
    prompt: 'Crie um para amanhã de manhã.',
    labelDomain: 'clarify',
    labelSkill: null,
  },
  {
    locale: 'en',
    prompt: 'Thanks for your help.',
    labelDomain: 'none',
    labelSkill: null,
  },
  {
    locale: 'pt',
    prompt: 'Obrigado pela ajuda.',
    labelDomain: 'none',
    labelSkill: null,
  },
  {
    locale: 'en',
    prompt: 'Good morning!',
    labelDomain: 'none',
    labelSkill: null,
  },
  {
    locale: 'pt',
    prompt: 'Bom dia!',
    labelDomain: 'none',
    labelSkill: null,
  },
  {
    locale: 'en',
    prompt: 'Tell me a short joke.',
    labelDomain: 'none',
    labelSkill: null,
  },
  {
    locale: 'pt',
    prompt: 'Conte uma piada curta.',
    labelDomain: 'none',
    labelSkill: null,
  },
  {
    locale: 'en',
    prompt: 'What does serendipity mean?',
    labelDomain: 'none',
    labelSkill: null,
  },
  {
    locale: 'pt',
    prompt: 'O que significa serendipidade?',
    labelDomain: 'none',
    labelSkill: null,
  },
  {
    locale: 'en',
    prompt: 'Build me a four-week cycling endurance plan.',
    labelDomain: 'triathlon',
    labelSkill: 'training',
  },
  {
    locale: 'pt',
    prompt: 'Crie para mim um plano de quatro semanas para melhorar a resistência no ciclismo.',
    labelDomain: 'triathlon',
    labelSkill: 'training',
  },
  {
    locale: 'en',
    prompt: 'Generate three video hooks about recovery after a race.',
    labelDomain: 'content',
    labelSkill: 'content',
  },
  {
    locale: 'pt',
    prompt: 'Gere três ganchos de vídeo sobre recuperação depois de uma prova.',
    labelDomain: 'content',
    labelSkill: 'content',
  },
  {
    locale: 'en',
    prompt: 'Turn these notes into a short newsletter draft.',
    labelDomain: 'content',
    labelSkill: 'content',
  },
  {
    locale: 'pt',
    prompt: 'Transforme estas anotações em um rascunho curto de newsletter.',
    labelDomain: 'content',
    labelSkill: 'content',
  },
  {
    locale: 'en',
    prompt: 'Show my total subscription spending for the last three months.',
    labelDomain: 'finance',
    labelSkill: 'finance',
  },
  {
    locale: 'pt',
    prompt: 'Mostre meu gasto total com assinaturas nos últimos três meses.',
    labelDomain: 'finance',
    labelSkill: 'finance',
  },
  {
    locale: 'en',
    prompt: 'Categorize my coffee shop receipt as a business expense.',
    labelDomain: 'finance',
    labelSkill: 'finance',
  },
  {
    locale: 'pt',
    prompt: 'Classifique meu recibo da cafeteria como despesa profissional.',
    labelDomain: 'finance',
    labelSkill: 'finance',
  },
  {
    locale: 'en',
    prompt: 'Create a vegetarian dinner plan for four nights.',
    labelDomain: 'cooking',
    labelSkill: 'cooking',
  },
  {
    locale: 'pt',
    prompt: 'Crie um plano de jantares vegetarianos para quatro noites.',
    labelDomain: 'cooking',
    labelSkill: 'cooking',
  },
  {
    locale: 'en',
    prompt: 'Build a grocery list for chickpea curry and rice.',
    labelDomain: 'cooking',
    labelSkill: 'cooking',
  },
  {
    locale: 'pt',
    prompt: 'Monte uma lista de compras para curry de grão-de-bico com arroz.',
    labelDomain: 'cooking',
    labelSkill: 'cooking',
  },
  {
    locale: 'en',
    prompt: 'Retry the failed Garmin connection sync.',
    labelDomain: 'connections',
    labelSkill: 'connections',
  },
  {
    locale: 'pt',
    prompt: 'Tente novamente a sincronização da conexão com o Garmin que falhou.',
    labelDomain: 'connections',
    labelSkill: 'connections',
  },
  {
    locale: 'en',
    prompt: 'Snooze all non-urgent notifications for one hour.',
    labelDomain: 'notifications',
    labelSkill: 'notifications',
  },
  {
    locale: 'pt',
    prompt: 'Adie todas as notificações não urgentes por uma hora.',
    labelDomain: 'notifications',
    labelSkill: 'notifications',
  },
  {
    locale: 'en',
    prompt: 'Snooze this decision until next Monday.',
    labelDomain: 'decision_center',
    labelSkill: 'decision_center',
  },
  {
    locale: 'pt',
    prompt: 'Adie esta decisão até a próxima segunda-feira.',
    labelDomain: 'decision_center',
    labelSkill: 'decision_center',
  },
] as const satisfies readonly RoutingCorpusProductProfileFixture[];
