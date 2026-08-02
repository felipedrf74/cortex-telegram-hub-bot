// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * i18n — Message system with Portuguese variants (pt-BR / pt-PT) + EN.
 *
 * Simple key-based translations for bot messages. Not a full i18n framework —
 * just enough for user-facing strings in two languages.
 *
 * Usage:
 *   t('welcome', 'pt-BR')                      → '🎉 Bem-vindo ao Nexus Hub!'
 *   t('rate_limited', 'en-US', { limit: '40' }) → 'You've reached your daily limit of 40 messages.'
 */

export type Lang = 'pt-BR' | 'pt-PT' | 'en-US';

type MessageEntry = {
  'pt-BR': string;
  'pt-PT'?: string;
  'en-US': string;
};

const MESSAGES: Record<string, MessageEntry> = {
  // ── Lock-screen notification copy ───────────────────────────────────────
  //
  // These are the ONLY strings the server puts on a locked phone. They are
  // fixed, non-sensitive, and never contain producer text — `buildPrivacySafeBody`
  // exists to guarantee that. Until now they were hardcoded English, while
  // `users.language` defaults to pt-BR, so the product was trilingual in-app
  // and monolingual on the lock screen.
  //
  // The keys are deliberately shaped as iOS Localizable.strings keys. When the
  // client can carry `aps.alert.loc-key`/`loc-args`, the SAME key ships in the
  // payload and the strings move into the app bundle — where they follow the
  // DEVICE language rather than the account language, and no prose crosses the
  // wire at all. Keeping the key as the unit of copy now makes that a
  // payload-layer change instead of a producer rewrite.
  'notif.title.secretary': {
    'pt-BR': 'Decisão pendente',
    'pt-PT': 'Decisão pendente',
    'en-US': 'Secretary decision',
  },
  'notif.title.secretary.schedule': {
    'pt-BR': 'Decisão de agenda',
    'pt-PT': 'Decisão de agenda',
    'en-US': 'Schedule decision',
  },
  'notif.title.training': {
    'pt-BR': 'Atualização de treino',
    'pt-PT': 'Atualização de treino',
    'en-US': 'Training update',
  },
  'notif.title.content': {
    'pt-BR': 'Revisão de conteúdo',
    'pt-PT': 'Revisão de conteúdo',
    'en-US': 'Content review',
  },
  'notif.title.cooking': {
    'pt-BR': 'Lembrete de cozinha',
    'pt-PT': 'Lembrete de cozinha',
    'en-US': 'Cooking reminder',
  },
  'notif.title.finance': {
    'pt-BR': 'Lembrete financeiro',
    'pt-PT': 'Lembrete financeiro',
    'en-US': 'Finance reminder',
  },
  'notif.title.chat': {
    'pt-BR': 'O Nexus precisa da sua escolha',
    'pt-PT': 'O Nexus precisa da tua escolha',
    'en-US': 'Nexus needs your choice',
  },
  'notif.title.system': {
    'pt-BR': 'Notificação do sistema',
    'pt-PT': 'Notificação do sistema',
    'en-US': 'System notification',
  },
  'notif.title.security': {
    'pt-BR': 'Atividade da conta',
    'pt-PT': 'Atividade da conta',
    'en-US': 'Account activity',
  },
  'notif.body.finance': {
    'pt-BR': 'Um lembrete financeiro precisa de revisão.',
    'pt-PT': 'Um lembrete financeiro precisa de revisão.',
    'en-US': 'Finance reminder needs review.',
  },
  'notif.body.training': {
    'pt-BR': 'Check-in de treino necessário. Revise o ajuste de hoje.',
    'pt-PT': 'Check-in de treino necessário. Revê o ajuste de hoje.',
    'en-US': 'Training check-in needed. Review today’s adjustment.',
  },
  'notif.body.content': {
    'pt-BR': 'Um item de conteúdo está pronto para revisão.',
    'pt-PT': 'Um item de conteúdo está pronto para revisão.',
    'en-US': 'Content item is ready for review.',
  },
  'notif.body.review': {
    'pt-BR': '{title} — abra o Nexus para revisar.',
    'pt-PT': '{title} — abre o Nexus para rever.',
    'en-US': '{title} — open Nexus to review the recommendation.',
  },
  'notif.digest.title': {
    'pt-BR': 'O seu resumo',
    'pt-PT': 'O teu resumo',
    'en-US': 'Your brief',
  },
  'notif.digest.empty': {
    'pt-BR': 'Nada precisa de você agora.',
    'pt-PT': 'Nada precisa de ti agora.',
    'en-US': 'Nothing needs you right now.',
  },
  // Digest slot labels. Separate singular/plural entries because Portuguese and
  // Portuguese inflects the noun, so "{count} decision(s)" cannot be assembled by
  // concatenation the way the English version was.
  'notif.digest.slot.security_account.one':   { 'pt-BR': '1 alerta de conta', 'en-US': '1 account alert' },
  'notif.digest.slot.security_account.other': { 'pt-BR': '{count} alertas de conta', 'en-US': '{count} account alerts' },
  'notif.digest.slot.approval_required.one':   { 'pt-BR': '1 aprovação pendente', 'en-US': '1 approval waiting' },
  'notif.digest.slot.approval_required.other': { 'pt-BR': '{count} aprovações pendentes', 'en-US': '{count} approvals waiting' },
  'notif.digest.slot.conflict_detected.one':   { 'pt-BR': '1 conflito de agenda', 'en-US': '1 schedule conflict' },
  'notif.digest.slot.conflict_detected.other': { 'pt-BR': '{count} conflitos de agenda', 'en-US': '{count} schedule conflicts' },
  'notif.digest.slot.decision_required.one':   { 'pt-BR': '1 decisão pendente', 'en-US': '1 decision waiting' },
  'notif.digest.slot.decision_required.other': { 'pt-BR': '{count} decisões pendentes', 'en-US': '{count} decisions waiting' },
  'notif.digest.slot.reflow_suggestion.one':   { 'pt-BR': '1 proposta de reagendamento', 'en-US': '1 reschedule proposal' },
  'notif.digest.slot.reflow_suggestion.other': { 'pt-BR': '{count} propostas de reagendamento', 'en-US': '{count} reschedule proposals' },
  'notif.digest.slot.risk_warning.one':   { 'pt-BR': '1 check-in necessário', 'en-US': '1 check-in needed' },
  'notif.digest.slot.risk_warning.other': { 'pt-BR': '{count} check-ins necessários', 'en-US': '{count} check-ins needed' },
  'notif.digest.slot.sync_failure.one':   { 'pt-BR': '1 conexão precisa de atenção', 'pt-PT': '1 ligação precisa de atenção', 'en-US': '1 connection needs attention' },
  'notif.digest.slot.sync_failure.other': { 'pt-BR': '{count} conexões precisam de atenção', 'pt-PT': '{count} ligações precisam de atenção', 'en-US': '{count} connections need attention' },
  'notif.digest.slot.reminder.one':   { 'pt-BR': '1 lembrete', 'en-US': '1 reminder' },
  'notif.digest.slot.reminder.other': { 'pt-BR': '{count} lembretes', 'en-US': '{count} reminders' },
  'notif.digest.slot.missed_item.one':   { 'pt-BR': '1 item perdido', 'en-US': '1 missed item' },
  'notif.digest.slot.missed_item.other': { 'pt-BR': '{count} itens perdidos', 'en-US': '{count} missed items' },
  'notif.digest.slot.schedule_changed.one':   { 'pt-BR': '1 alteração de agenda', 'en-US': '1 schedule update' },
  'notif.digest.slot.schedule_changed.other': { 'pt-BR': '{count} alterações de agenda', 'en-US': '{count} schedule updates' },
  'notif.digest.slot.default.one':   { 'pt-BR': '1 atualização', 'en-US': '1 update' },
  'notif.digest.slot.default.other': { 'pt-BR': '{count} atualizações', 'en-US': '{count} updates' },

  'welcome': {
    'pt-BR': '🎉 Bem-vindo ao Nexus Hub!\n\nSou seu assistente pessoal com IA. Use /help para ver os comandos disponíveis.',
    'pt-PT': '🎉 Bem-vindo ao Nexus Hub!\n\nSou o teu assistente pessoal com IA. Usa /help para veres os comandos disponíveis.',
    'en-US': '🎉 Welcome to Nexus Hub!\n\nI\'m your AI-powered personal assistant. Use /help to see available commands.',
  },
  'welcome_back': {
    'pt-BR': '👋 Olá de novo! Seu assistente está online. Use /help para comandos.',
    'pt-PT': '👋 Olá outra vez! O teu assistente está online. Usa /help para veres os comandos.',
    'en-US': '👋 Welcome back! Your assistant is online. Use /help for commands.',
  },
  'need_invite': {
    'pt-BR': '🔐 Nexus Hub está em beta privado.\n\nPara participar, use um código de convite:\n/start SEU_CODIGO',
    'en-US': '🔐 Nexus Hub is in private beta.\n\nTo join, use an invite code:\n/start YOUR_CODE',
  },
  'invalid_invite': {
    'pt-BR': '❌ Código de convite inválido ou expirado.',
    'pt-PT': '❌ Código de convite inválido ou expirado.',
    'en-US': '❌ Invalid or expired invite code.',
  },
  'rate_limited': {
    'pt-BR': '⚠️ Você atingiu seu limite diário de {limit} mensagens.\n\nSeu limite reseta à meia-noite ({timezone}).',
    'pt-PT': '⚠️ Atingiste o teu limite diário de {limit} mensagens.\n\nO limite é reposto à meia-noite ({timezone}).',
    'en-US': '⚠️ You\'ve reached your daily limit of {limit} messages.\n\nYour limit resets at midnight ({timezone}).',
  },
  'suspended': {
    'pt-BR': '⚠️ Sua conta está suspensa. Entre em contato com o suporte.',
    'pt-PT': '⚠️ A tua conta está suspensa. Contacta o suporte.',
    'en-US': '⚠️ Your account is suspended. Contact support.',
  },
  'choose_language': {
    'pt-BR': '🌐 Escolha seu idioma / Choose your language:',
    'pt-PT': '🌐 Escolhe o teu idioma / Choose your language:',
    'en-US': '🌐 Choose your language / Escolha seu idioma:',
  },
  'language_set': {
    'pt-BR': '✅ Idioma definido para Português. Bem-vindo ao Nexus Hub! 🇧🇷\n\nUse /help para ver os comandos.',
    'pt-PT': '✅ Idioma definido para Português. Bem-vindo ao Nexus Hub! 🇵🇹\n\nUsa /help para veres os comandos.',
    'en-US': '✅ Language set to English. Welcome to Nexus Hub! 🇬🇧\n\nUse /help to see commands.',
  },
  'skill_disabled': {
    'pt-BR': '🔒 Esta funcionalidade não está habilitada para sua conta.',
    'pt-PT': '🔒 Esta funcionalidade não está ativa para a tua conta.',
    'en-US': '🔒 This feature is not enabled for your account.',
  },
  'skill_tier_required': {
    'pt-BR': '🔒 Esta funcionalidade requer o plano <b>{tier}</b>. Seu plano atual: <b>{current}</b>. Peça ao administrador para atualizar seu acesso.',
    'pt-PT': '🔒 Esta funcionalidade requer o plano <b>{tier}</b>. O teu plano atual: <b>{current}</b>. Pede ao administrador para atualizar o teu acesso.',
    'en-US': '🔒 This feature requires the <b>{tier}</b> tier. Your current tier: <b>{current}</b>. Ask the admin to upgrade your access.',
  },
  'registration_closed': {
    'pt-BR': '🔐 O registro está fechado no momento. Peça um código de convite ao administrador.',
    'pt-PT': '🔐 O registo está fechado neste momento. Pede um código de convite ao administrador.',
    'en-US': '🔐 Registration is currently closed. Ask an admin for an invite code.',
  },
  'connect_help': {
    'pt-BR': '🔗 <b>Conectar suas contas:</b>\n\n<b>📅 Calendário e email</b>\n/connect google — Google Calendar, Drive, Gmail\n/connect outlook — Outlook Calendar, Email, To Do\n\n<b>✅ Tarefas</b>\n/connect todoist — Todoist (sincronização em tempo real)\n/connect notion — Notion (banco de dados como lista de tarefas)\n\n<b>⌚ Wearables</b>\n/connect strava — Strava\n/connect whoop — Whoop\n/connect fitbit — Fitbit',
    'pt-PT': '🔗 <b>Ligar as tuas contas:</b>\n\n<b>📅 Calendário e email</b>\n/connect google — Google Calendar, Drive, Gmail\n/connect outlook — Outlook Calendar, Email, To Do\n\n<b>✅ Tarefas</b>\n/connect todoist — Todoist (sincronização em tempo real)\n/connect notion — Notion (base de dados como lista de tarefas)\n\n<b>⌚ Wearables</b>\n/connect strava — Strava\n/connect whoop — Whoop\n/connect fitbit — Fitbit',
    'en-US': '🔗 <b>Connect your accounts:</b>\n\n<b>📅 Calendar &amp; email</b>\n/connect google — Google Calendar, Drive, Gmail\n/connect outlook — Outlook Calendar, Email, To Do\n\n<b>✅ Tasks</b>\n/connect todoist — Todoist (real-time webhook sync)\n/connect notion — Notion (database as task list)\n\n<b>⌚ Wearables</b>\n/connect strava — Strava\n/connect whoop — Whoop\n/connect fitbit — Fitbit',
  },
  'connect_prompt': {
    'pt-BR': '🔗 Clique no botão abaixo para autorizar o acesso ao {provider}:',
    'pt-PT': '🔗 Clica no botão abaixo para autorizares o acesso ao {provider}:',
    'en-US': '🔗 Click the button below to authorize {provider} access:',
  },
  'oauth_connected': {
    'pt-BR': '✅ {provider} conectado com sucesso! Suas integrações estão prontas.',
    'pt-PT': '✅ {provider} ligado com sucesso! As tuas integrações estão prontas.',
    'en-US': '✅ {provider} connected successfully! Your integrations are ready.',
  },
  'oauth_failed': {
    'pt-BR': '❌ Falha ao conectar {provider}. Tente novamente com /connect {provider}.',
    'pt-PT': '❌ Falha ao ligar {provider}. Tenta novamente com /connect {provider}.',
    'en-US': '❌ Failed to connect {provider}. Try again with /connect {provider}.',
  },
  'connections_none': {
    'pt-BR': '📡 Nenhuma conta conectada.\n\nUse /connect para ver as opções disponíveis.',
    'pt-PT': '📡 Nenhuma conta ligada.\n\nUsa /connect para veres as opções disponíveis.',
    'en-US': '📡 No accounts connected.\n\nUse /connect to see available options.',
  },
  'connections_header': {
    'pt-BR': '📡 <b>Contas conectadas:</b>\n',
    'pt-PT': '📡 <b>Contas ligadas:</b>\n',
    'en-US': '📡 <b>Connected accounts:</b>\n',
  },
  'provider_not_connected': {
    'pt-BR': '⚠️ {provider} não está conectado. Use /connect {provider} para configurar.',
    'pt-PT': '⚠️ {provider} não está ligado. Usa /connect {provider} para configurar.',
    'en-US': '⚠️ {provider} is not connected. Use /connect {provider} to set up.',
  },
  'subskill_disabled': {
    'pt-BR': '🔒 A funcionalidade <b>{skill}</b> não está habilitada para sua conta.',
    'en-US': '🔒 The <b>{skill}</b> feature is not enabled for your account.',
  },
  'export_starting': {
    'pt-BR': '📦 Preparando seu export de dados...',
    'en-US': '📦 Preparing your data export...',
  },
  'export_complete': {
    'pt-BR': '✅ Aqui estão todos os seus dados do Nexus Hub em formato JSON.',
    'en-US': '✅ Here\'s all your Nexus Hub data in JSON format.',
  },
  'export_failed': {
    'pt-BR': '❌ Falha ao exportar dados. Tente novamente mais tarde.',
    'pt-PT': '❌ Falha ao exportar dados. Tenta novamente mais tarde.',
    'en-US': '❌ Failed to export data. Please try again later.',
  },
  'delete_usage': {
    'pt-BR': '⚠️ Para deletar todos os seus dados, envie:\n<code>/delete meus-dados</code>\n\nIsso é irreversível.',
    'pt-PT': '⚠️ Para eliminares todos os teus dados, envia:\n<code>/delete meus-dados</code>\n\nIsto é irreversível.',
    'en-US': '⚠️ To delete all your data, send:\n<code>/delete my-data</code>\n\nThis is irreversible.',
  },
  'delete_confirm': {
    'pt-BR': '🚨 <b>ATENÇÃO:</b> Isso vai deletar permanentemente TODOS os seus dados:\n\n• Conversas\n• Tarefas\n• Lembretes\n• Notas\n• Dados financeiros\n• Configurações\n• Conexões OAuth\n\nUm export final será enviado antes da exclusão.\n\nTem certeza?',
    'en-US': '🚨 <b>WARNING:</b> This will permanently delete ALL your data:\n\n• Conversations\n• Tasks\n• Reminders\n• Notes\n• Financial data\n• Settings\n• OAuth connections\n\nA final export will be sent before deletion.\n\nAre you sure?',
  },
  'delete_yes': { 'pt-BR': 'Sim, deletar tudo', 'en-US': 'Yes, delete everything' },
  'delete_cancel': { 'pt-BR': 'Cancelar', 'en-US': 'Cancel' },
  'delete_processing': { 'pt-BR': '🗑️ Deletando seus dados...', 'en-US': '🗑️ Deleting your data...' },
  'delete_export_before': {
    'pt-BR': '📦 Aqui está uma cópia dos seus dados antes da exclusão.',
    'en-US': '📦 Here\'s a copy of your data before deletion.',
  },
  'delete_complete': {
    'pt-BR': '✅ Dados deletados. {records} registros removidos. Sua conta foi encerrada.\n\nVocê pode criar uma nova conta a qualquer momento com /start.',
    'pt-PT': '✅ Dados eliminados. {records} registos removidos. A tua conta foi encerrada.\n\nPodes criar uma nova conta a qualquer momento com /start.',
    'en-US': '✅ Data deleted. {records} records removed. Your account has been closed.\n\nYou can create a new account anytime with /start.',
  },
  'delete_cancelled': {
    'pt-BR': '✅ Exclusão cancelada. Seus dados estão seguros.',
    'en-US': '✅ Deletion cancelled. Your data is safe.',
  },
  'delete_failed': {
    'pt-BR': '❌ Falha ao deletar dados. Contate o administrador.',
    'en-US': '❌ Failed to delete data. Contact the administrator.',
  },
  // ── Training Commands ──
  'training_help': {
    'pt-BR': '🏋️ <b>Comandos de treino:</b>\n\n/training plan — Plano da semana\n/training today — Treino de hoje\n/training done — Marcar como feito\n/training readiness — Score de prontidão\n/training compare — Planejado vs Realizado\n/training history — Últimas 4 semanas\n/training feedback easy|perfect|hard — Avaliar treino',
    'en-US': '🏋️ <b>Training commands:</b>\n\n/training plan — This week\'s plan\n/training today — Today\'s workout\n/training done — Mark as complete\n/training readiness — Readiness score\n/training compare — Planned vs Actual\n/training history — Last 4 weeks\n/training feedback easy|perfect|hard — Rate session',
  },
  'training_no_plan': {
    'pt-BR': '❌ Nenhum plano ativo. Peça para eu criar um com linguagem natural.',
    'en-US': '❌ No active plan. Ask me to create one in natural language.',
  },
  'training_no_week': {
    'pt-BR': '❌ Nenhuma semana ativa no plano atual.',
    'en-US': '❌ No active week in current plan.',
  },
  'training_rest_day': {
    'pt-BR': 'Hoje é dia de descanso. Aproveite a recuperação!',
    'en-US': 'Today is a rest day. Enjoy the recovery!',
  },
  'training_already_done': {
    'pt-BR': 'Treino de hoje já feito',
    'en-US': 'Today\'s session already done',
  },
  'training_done_hint': {
    'pt-BR': 'Quando terminar, marque',
    'en-US': 'When done, mark with',
  },
  'training_low_readiness': {
    'pt-BR': 'Readiness baixo ({score}/100): considere {rec}',
    'en-US': 'Low readiness ({score}/100): consider {rec}',
  },
  'training_marked_done': {
    'pt-BR': '✅ Treino marcado como feito: <b>{title}</b>\nComo foi?',
    'en-US': '✅ Session marked complete: <b>{title}</b>\nHow was it?',
  },
  'training_no_session_today': {
    'pt-BR': '❌ Nenhuma sessão pendente hoje.',
    'en-US': '❌ No pending session for today.',
  },
  'training_feedback_saved': {
    'pt-BR': '💪 Feedback salvo: {rating}. Isso ajusta o próximo treino.',
    'en-US': '💪 Feedback saved: {rating}. This helps adjust your next session.',
  },
  'too_easy': { 'pt-BR': 'Fácil', 'en-US': 'Too easy' },
  'perfect': { 'pt-BR': 'Perfeito', 'en-US': 'Perfect' },
  'too_hard': { 'pt-BR': 'Difícil', 'en-US': 'Too hard' },
  'week': { 'pt-BR': 'Semana', 'en-US': 'Week' },
  'completed': { 'pt-BR': 'concluídos', 'en-US': 'completed' },
  'readiness_score': { 'pt-BR': 'Score de Prontidão', 'en-US': 'Readiness Score' },
  'sleep': { 'pt-BR': 'Sono', 'en-US': 'Sleep' },
  'recommendation': { 'pt-BR': 'Recomendação', 'en-US': 'Recommendation' },
  'readiness_full_intensity': { 'pt-BR': 'Pode ir com tudo!', 'en-US': 'Go full intensity!' },
  'readiness_reduce_10pct': { 'pt-BR': 'Reduza 10% — dia ok', 'en-US': 'Reduce 10% — decent day' },
  'readiness_reduce_25pct': { 'pt-BR': 'Reduza 25% — corpo cansado', 'en-US': 'Reduce 25% — body is tired' },
  'readiness_active_recovery': { 'pt-BR': 'Só recuperação ativa', 'en-US': 'Active recovery only' },
  'readiness_rest_day': { 'pt-BR': 'Dia de descanso total', 'en-US': 'Full rest day' },
  // ── Skill-Gated Onboarding ──
  'onboard_prompt': {
    'pt-BR': '🎯 Para personalizar sua experiência, preciso fazer algumas perguntas sobre: <b>{skills}</b>\n\nVamos começar?',
    'en-US': '🎯 To personalize your experience, I need to ask a few questions about: <b>{skills}</b>\n\nShall we begin?',
  },
  'start_onboarding': { 'pt-BR': 'Vamos lá!', 'en-US': 'Let\'s go!' },
  'skip_onboarding': { 'pt-BR': 'Depois', 'en-US': 'Later' },
  'onboard_next': {
    'pt-BR': '✅ Perfil salvo!\n\nPróximo: <b>{name}</b>. Continuar?',
    'en-US': '✅ Profile saved!\n\nNext: <b>{name}</b>. Continue?',
  },
  'onboard_complete': {
    'pt-BR': '🎉 Tudo pronto! Seus perfis estão configurados.\n\nDigite /help para ver todos os comandos disponíveis.',
    'en-US': '🎉 All set! Your profiles are configured.\n\nType /help to see all available commands.',
  },
  'onboard_no_skills': {
    'pt-BR': '❌ Nenhum questionário disponível para suas habilidades ativas.',
    'en-US': '❌ No questionnaires available for your enabled skills.',
  },
  'onboard_skipped': {
    'pt-BR': '⏭️ Sem problema! Use /onboard a qualquer momento para configurar seus perfis.',
    'en-US': '⏭️ No problem! Use /onboard anytime to set up your profiles.',
  },
  'later': { 'pt-BR': 'Depois', 'en-US': 'Later' },
  'continue': { 'pt-BR': 'Continuar', 'en-US': 'Continue' },
  // ── Cost Guardrail ──
  'cost_limit_reached': {
    'pt-BR': '⚠️ O sistema atingiu o limite diário de custos. Tente novamente amanhã ou contate o administrador.',
    'pt-PT': '⚠️ O sistema atingiu o limite diário de custos. Tenta novamente amanhã ou contacta o administrador.',
    'en-US': '⚠️ The system has reached its daily cost limit. Try again tomorrow or contact the administrator.',
  },
  'ms_todo_not_connected': {
    'pt-BR': '⚠️ Microsoft To Do não está conectado.\n\nUse /connect outlook para vincular sua conta.',
    'en-US': '⚠️ Microsoft To Do is not connected.\n\nUse /connect outlook to link your account.',
  },
  'generic_error': {
    'pt-BR': '⚠️ Algo deu errado. Tente novamente em alguns instantes.',
    'pt-PT': '⚠️ Algo correu mal. Tenta novamente dentro de instantes.',
    'en-US': '⚠️ Something went wrong. Please try again in a moment.',
  },
  'garmin_not_connected': {
    'pt-BR': '⚠️ Garmin não está conectado nesta instalação.\n\nFale com o administrador para configurar.',
    'en-US': '⚠️ Garmin is not connected on this installation.\n\nContact the administrator to configure.',
  },
  'invalid_invite_with_help': {
    'pt-BR': '❌ Código de convite inválido ou expirado.\n\nVerifique o código e tente novamente:\n/start SEU_CODIGO',
    'en-US': '❌ Invalid or expired invite code.\n\nCheck the code and try again:\n/start YOUR_CODE',
  },
  'welcome_back_with_onboarding': {
    'pt-BR': '👋 Olá de novo! Parece que você tem perfis para configurar.',
    'pt-PT': '👋 Olá outra vez! Parece que tens perfis para configurar.',
    'en-US': '👋 Welcome back! Looks like you have profiles to set up.',
  },
  'setup_profile': {
    'pt-BR': 'Configurar perfis',
    'en-US': 'Set up profiles',
  },
  'registration_error': {
    'pt-BR': '❌ Erro ao criar sua conta. Tente novamente em alguns instantes.',
    'pt-PT': '❌ Erro ao criar a tua conta. Tenta novamente dentro de instantes.',
    'en-US': '❌ Error creating your account. Please try again in a moment.',
  },
  'apply': { 'pt-BR': 'Aplicar', 'en-US': 'Apply' },
  'skip': { 'pt-BR': 'Pular', 'en-US': 'Skip' },
  'apply_all': { 'pt-BR': 'Aplicar todas', 'en-US': 'Apply all' },
  'keep_all': { 'pt-BR': 'Manter tudo', 'en-US': 'Keep all' },
  'coach_applied': { 'pt-BR': '✅ Alteração aplicada!', 'en-US': '✅ Change applied!' },
  'coach_dismissed': { 'pt-BR': '👍 Mantido como está.', 'en-US': '👍 Kept as is.' },
  'coach_good_training': { 'pt-BR': '💪 Bom treino amanhã!', 'en-US': '💪 Good training tomorrow!' },
};

/**
 * Get a translated message. Falls back to English, then to the raw key.
 * Supports {variable} substitution.
 */
/**
 * Is there a translation for this key in this EXACT language, with no fallback?
 *
 * `t()` deliberately falls back (pt-PT -> pt-BR -> en-US -> key). That is right
 * at runtime, but it makes coverage guards impossible to write against: a key
 * present only in en-US resolves to English for every language and never
 * returns the key, so `expect(t(key, lang)).not.toBe(key)` passes for a
 * translation that does not exist.
 */
export function hasTranslation(key: string, lang: Lang): boolean {
  const value = MESSAGES[key]?.[lang];
  return typeof value === 'string' && value.length > 0;
}

/**
 * Every message key under a prefix. Lets a coverage guard sweep a whole
 * namespace instead of a hand-maintained list that silently misses new keys.
 */
export function messageKeysWithPrefix(prefix: string): string[] {
  return Object.keys(MESSAGES).filter((key) => key.startsWith(prefix)).sort();
}

export function t(key: string, lang: Lang, vars?: Record<string, string>): string {
  let msg =
    MESSAGES[key]?.[lang]
    ?? (lang === 'pt-PT' ? MESSAGES[key]?.['pt-BR'] : undefined)
    ?? MESSAGES[key]?.['en-US']
    ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      msg = msg.replace(`{${k}}`, v);
    }
  }
  return msg;
}

/**
 * Detect language from Telegram's language_code field.
 * Falls back to PT-BR (primary audience).
 *
 * Spanish was retired as a product locale in July 2026. Legacy `es-*`
 * clients remain compatible but receive the English fallback.
 */
export function detectLanguageFromTelegram(langCode?: string): Lang {
  if (!langCode) return 'pt-BR';
  return normalizeSupportedLang(langCode, 'en-US');
}

/** True for legacy locale labels that must resolve to English without persistence. */
export function isRetiredSpanishLocaleSignal(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  const comparable = normalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return normalized.split(/[-_]/)[0] === 'es'
    || comparable === 'spanish'
    || comparable === 'espanol'
    || comparable === 'castellano';
}

/** Coerce stored or request locale values into the supported product set. */
export function normalizeSupportedLang(
  value: unknown,
  fallback: Lang = 'en-US',
): Lang {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  const comparable = normalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (
    /^pt[-_]pt(?:[-_]|$)/.test(normalized)
    || comparable.includes('portugues de portugal')
    || comparable.includes('portugues europeu')
    || comparable.includes('european portuguese')
  ) return 'pt-PT';
  if (
    /^pt(?:[-_]|$)/.test(normalized)
    || comparable.includes('portugues brasileiro')
    || comparable.includes('brazilian portuguese')
  ) return 'pt-BR';
  if (/^en(?:[-_]|$)/.test(normalized) || comparable === 'english') return 'en-US';
  if (isRetiredSpanishLocaleSignal(value)) return 'en-US';
  return fallback;
}
