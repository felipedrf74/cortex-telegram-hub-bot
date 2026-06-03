// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

import type { ChatActionRunStatus } from '../../chat-action-run-store';
import { formatCurrencyAmount } from '../../finance-tracker';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../types';

export function successCopy(
  input: ChatPlannerInput,
  results: Array<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown }>,
): string {
  const first = results[0];
  if (results.length > 1) {
    const labels = results
      .map((result, index) => `${index + 1}. ${friendlyActionLabel(result.step, input)}`)
      .join('\n');
    return input.locale?.startsWith('pt')
      ? `Feito — completei ${results.length} passos e verifiquei o resultado:\n${labels}`
      : `Done — I completed ${results.length} steps and verified the result:\n${labels}`;
  }
  if (first?.step.type === 'answer') {
    return String((first.result as any)?.text || (first.step.args as any).text || '');
  }
  if ((first?.result as any)?.replayed === true) {
    return input.locale?.startsWith('pt')
      ? 'Esse pedido já foi tratado, por isso não criei uma duplicação.'
      : 'I already handled that request, so I did not create a duplicate.';
  }
  if (first?.step.action === 'schedule_event') {
    const args = first.step.args as any;
    const provider = args.provider === 'outlook_calendar' ? 'Outlook Calendar' : 'Google Calendar';
    const start = DateTime.fromISO(String(args.startDateTime)).setZone(input.timezone);
    const end = DateTime.fromISO(String(args.endDateTime)).setZone(input.timezone);
    if (input.locale?.startsWith('pt')) {
      return `Feito — criei “${args.title}” no ${provider} para ${start.setLocale('pt').toFormat("cccc, d 'de' LLLL")}, das ${start.toFormat('HH:mm')} às ${end.toFormat('HH:mm')}.`;
    }
    return `Done — I created “${args.title}” in ${provider} for ${start.toFormat('cccc, LLL d')}, ${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}.`;
  }
  if (first?.step.action === 'check_calendar_conflicts') {
    const count = Number((first.result as any)?.conflictCount ?? 0);
    return input.locale?.startsWith('pt')
      ? count > 0 ? `Encontrei ${count} evento(s) nesse horário.` : 'Não encontrei conflitos nesse horário.'
      : count > 0 ? `I found ${count} event(s) in that window.` : 'I did not find conflicts in that window.';
  }
  if (first?.step.action === 'summarize_agenda') {
    const count = Array.isArray((first.result as any)?.events) ? (first.result as any).events.length : 0;
    return input.locale?.startsWith('pt')
      ? `A tua agenda tem ${count} evento(s) nesse período.`
      : `Your agenda has ${count} event(s) in that window.`;
  }
  if (first?.step.action === 'update_event' || first?.step.action === 'move_event') {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei o evento e verifiquei no calendário.' : 'Done — I updated the event and verified it in the calendar.';
  }
  if (first?.step.action === 'delete_event') {
    return input.locale?.startsWith('pt') ? 'Feito — apaguei o evento e confirmei que já não aparece nesse período.' : 'Done — I deleted the event and confirmed it no longer appears in that window.';
  }
  if (first?.step.action === 'mail_unread_count') {
    const total = Number((first.result as any)?.totalUnread ?? 0);
    return input.locale?.startsWith('pt') ? `Tens ${total} e-mail(s) não lidos.` : `You have ${total} unread email(s).`;
  }
  if (first?.step.action === 'mail_inbox_summary') {
    const messages = Array.isArray((first.result as any)?.messages) ? (first.result as any).messages : [];
    return input.locale?.startsWith('pt')
      ? `Encontrei ${messages.length} mensagem(ns) relevantes na caixa de entrada.`
      : `I found ${messages.length} relevant inbox message(s).`;
  }
  if (first?.step.action === 'create_task') {
    const title = String((first.step.args as any).title);
    return input.locale?.startsWith('pt') ? `Feito — criei a tarefa “${title}”.` : `Done — I created the task “${title}”.`;
  }
  if (first?.step.action === 'create_task_with_subtasks' || first?.step.action === 'add_subtasks_to_task') {
    const result = first.result as any;
    const title = String(result?.title || (first.step.args as any).title || 'Task');
    const subtasks = Array.isArray(result?.subtasks) ? result.subtasks : [];
    const names: string[] = subtasks
      .map((item: any) => String(item?.title || item?.displayName || '').trim())
      .filter(Boolean);
    const bullets = names.map((name) => `• ${name}`).join('\n');
    const failed = Array.isArray(result?.failedSubtasks) && result.failedSubtasks.length > 0
      ? `\n\n${input.locale?.startsWith('pt') ? 'Não consegui adicionar' : 'I could not add'}: ${result.failedSubtasks.join(', ')}.`
      : '';
    if (first.step.action === 'add_subtasks_to_task') {
      return input.locale?.startsWith('pt')
        ? `✅ Adicionei ${names.length} subtarefa(s) a “${title}”:\n${bullets}${failed}`
        : `✅ Added ${names.length} subtasks to “${title}”:\n${bullets}${failed}`;
    }
    return input.locale?.startsWith('pt')
      ? `✅ Criei a tarefa “${title}” com ${names.length} subtarefa(s):\n${bullets}${failed}`
      : `✅ Created task “${title}” with ${names.length} subtasks:\n${bullets}${failed}`;
  }
  if (first?.step.action === 'update_task' || first?.step.action === 'complete_task' || first?.step.action === 'delete_task' || first?.step.action === 'create_checklist' || first?.step.action === 'set_task_reminder') {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei a tarefa e verifiquei a alteração.' : 'Done — I updated the task and verified the change.';
  }
  if (first?.step.action === 'content_script_create' || first?.step.action === 'content_brief_create') {
    const result = first.result as any;
    const script = result?.firstScript;
    const label = first.step.action === 'content_script_create'
      ? (input.locale?.startsWith('pt') ? 'roteiro' : 'script')
      : (input.locale?.startsWith('pt') ? 'brief de conteúdo' : 'content brief');
    if (input.locale?.startsWith('pt')) {
      return script?.coldOpen
        ? `Feito — criei um ${label} e guardei o pacote no Content. Primeiro hook: “${script.coldOpen}”`
        : `Feito — criei um ${label} e guardei o pacote no Content.`;
    }
    return script?.coldOpen
      ? `Done — I created a ${label} and saved the package in Content. First hook: “${script.coldOpen}”`
      : `Done — I created a ${label} and saved the package in Content.`;
  }
  if (first?.step.action === 'content_schedule_work') {
    const title = String((first.step.args as any).title || 'content work');
    return input.locale?.startsWith('pt') ? `Feito — agendei “${title}” no Content e verifiquei a gravação.` : `Done — I scheduled “${title}” in Content and verified it was saved.`;
  }
  if (first?.step.action === 'content_pipeline_handoff') {
    return input.locale?.startsWith('pt') ? 'Feito — movi o pacote para o pipeline de Content e verifiquei o read-back.' : 'Done — I moved the package into the Content pipeline and verified the read-back.';
  }
  if (first?.step.action === 'content_pipeline_stage_transition') {
    const result = first.result as any;
    const title = String(result?.topicTitle || (first.step.args as any).topicTitle || 'content item');
    const stage = String(result?.stage || (first.step.args as any).targetStage || 'the requested stage');
    return input.locale?.startsWith('pt')
      ? `Feito — movi “${title}” para ${localizePipelineStage(stage, true)} e verifiquei no pipeline.`
      : `Done — I moved “${title}” to ${localizePipelineStage(stage, false)} and verified it in the pipeline.`;
  }
  if (first?.step.action === 'cooking_grocery_list') {
    const itemCount = Number((first.result as any)?.itemCount ?? 0);
    return input.locale?.startsWith('pt')
      ? `Feito — gerei a lista de compras desta semana com ${itemCount} item(ns) e verifiquei a gravação.`
      : `Done — I generated this week's grocery list with ${itemCount} item(s) and verified it was saved.`;
  }
  if (first?.step.action === 'cooking_meal_plan') {
    const args = first.step.args as any;
    return input.locale?.startsWith('pt')
      ? `Feito — guardei “${args.title}” para ${args.mealType} em ${args.date} e verifiquei o plano.`
      : `Done — I saved “${args.title}” for ${args.mealType} on ${args.date} and verified the plan.`;
  }
  if (first?.step.action === 'cooking_substitute_ingredient') {
    const result = first.result as any;
    const substitution = result?.substitution ?? {};
    const original = String(substitution.originalIngredient || (first.step.args as any).originalIngredient || 'ingredient');
    const suggested = String(substitution.suggestedIngredient || (first.step.args as any).suggestedIngredient || 'replacement');
    return input.locale?.startsWith('pt')
      ? `Feito — troquei ${original} por ${suggested} nessa refeição e verifiquei a receita.`
      : `Done — I replaced ${original} with ${suggested} in that meal and verified the recipe.`;
  }
  if (first?.step.action === 'cooking_meal_support' || first?.step.action === 'cooking_fueling_support') {
    const result = first.result as any;
    return input.locale?.startsWith('pt')
      ? `Cozinha: há ${result?.plannedMeals ?? 0} refeição(ões) planeadas e ${result?.shoppingItemCount ?? 0} item(ns) na lista de compras desta semana.`
      : `Cooking: there are ${result?.plannedMeals ?? 0} planned meal(s) and ${result?.shoppingItemCount ?? 0} shopping item(s) this week.`;
  }
  if (first?.step.action === 'finance_summary') {
    const result = first.result as any;
    const summary = result?.summary;
    if (summary && input.locale?.startsWith('pt')) {
      return `Resumo financeiro de ${result.month}: receitas ${formatCurrencyAmount(result.currency, summary.totalIncome)}, despesas ${formatCurrencyAmount(result.currency, summary.totalExpenses)}.`;
    }
    if (summary) {
      return `Finance summary for ${result.month}: income ${formatCurrencyAmount(result.currency, summary.totalIncome)}, expenses ${formatCurrencyAmount(result.currency, summary.totalExpenses)}.`;
    }
  }
  if (first?.step.action === 'finance_categorize_receipt') {
    const result = first.result as any;
    return input.locale?.startsWith('pt')
      ? `Feito — categorizei o recibo/transação como ${result?.category ?? 'categoria indicada'} e verifiquei a alteração.`
      : `Done — I categorized the receipt/transaction as ${result?.category ?? 'the requested category'} and verified the change.`;
  }
  if (first?.step.action === 'finance_payment_action') {
    const result = first.result as any;
    return input.locale?.startsWith('pt')
      ? `Feito — marquei o evento financeiro de ${result?.month ?? 'esse mês'} como pago e verifiquei o estado.`
      : `Done — I marked the finance event for ${result?.month ?? 'that month'} as paid and verified the status.`;
  }
  if (first?.step.action === 'connections_status') {
    const count = Array.isArray((first.result as any)?.providers) ? (first.result as any).providers.length : 0;
    return input.locale?.startsWith('pt')
      ? `Verifiquei as conexões: encontrei ${count} provedor(es) no estado atual.`
      : `I checked connections: ${count} provider(s) are in the current status view.`;
  }
  if (first?.step.action === 'connections_reconnect_guidance') {
    return input.locale?.startsWith('pt')
      ? 'Verifiquei o estado da conexão e preparei a orientação de reconexão.'
      : 'I checked the connection state and prepared reconnect guidance.';
  }
  if (first?.step.action === 'training_coach_report') {
    const summary = String((first.result as any)?.summary || '');
    return input.locale?.startsWith('pt')
      ? `Resumo de treino: ${summary.slice(0, 220)}`
      : `Training summary: ${summary.slice(0, 220)}`;
  }
  if (first?.step.action === 'training_explain_session') {
    const result = first.result as any;
    return input.locale?.startsWith('pt')
      ? `Sessão de treino: ${result?.title ?? 'sessão'} (${result?.durationMinutes ?? '?'} min), estado ${result?.status ?? 'atual'}.`
      : `Training session: ${result?.title ?? 'session'} (${result?.durationMinutes ?? '?'} min), status ${result?.status ?? 'current'}.`;
  }
  if (first?.step.action === 'training_reflow_preview') {
    return input.locale?.startsWith('pt') ? 'Pré-visualização pronta — encontrei uma janela segura antes de alterar o plano.' : 'Preview ready — I found a safe window before changing the plan.';
  }
  if (first?.step.action === 'training_reflow_confirm') {
    return input.locale?.startsWith('pt') ? 'Feito — reagendei a sessão de treino e verifiquei a alteração.' : 'Done — I reflowed the training session and verified the change.';
  }
  if (first?.step.action === 'training_plan_create') {
    return input.locale?.startsWith('pt')
      ? 'Rascunho pronto — já tenho os dados essenciais para abrir o Training Plan Builder.'
      : 'Draft ready — I have the essential details for the Training Plan Builder.';
  }
  if (first?.step.action?.startsWith('notification_')) {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei e verifiquei a área de notificações.' : 'Done — I updated and verified Notifications.';
  }
  if (first?.step.action?.startsWith('decision_')) {
    return input.locale?.startsWith('pt') ? 'Feito — atualizei a decisão e verifiquei o estado.' : 'Done — I updated the decision and verified its state.';
  }
  return input.locale?.startsWith('pt') ? 'Feito — concluí e verifiquei a ação.' : 'Done — I completed and verified the action.';
}

export function verifiedPendingCopy(
  input: ChatPlannerInput,
  result: { step: ChatPlanStep; result?: unknown; error?: string },
): string {
  if (result.error === 'action_run_reconciliation_pending') {
    return input.locale?.startsWith('pt')
      ? 'Tentei criar isto no teu fornecedor, mas não consegui confirmar. Verifica manualmente para garantir.'
      : "I tried to create this on your provider, but I couldn't confirm it landed. Please verify manually.";
  }
  if (result.step.action === 'training_plan_create') {
    const missing = Array.isArray((result.result as any)?.missingSlots) ? (result.result as any).missingSlots : [];
    if (missing.length > 0) {
      return input.locale?.startsWith('pt')
        ? 'Guardei o rascunho do plano de treino e ainda preciso de mais alguns detalhes.'
        : 'I saved the training plan draft and still need a few details.';
    }
    return input.locale?.startsWith('pt')
      ? 'Rascunho pronto — posso abrir o Training Plan Builder com estes dados.'
      : 'Draft ready — I can open the Training Plan Builder with these details.';
  }
  return input.locale?.startsWith('pt')
    ? 'Guardei o estado e deixei pronto para continuar.'
    : 'I saved the state and it is ready to continue.';
}

export function failureCopy(input: ChatPlannerInput, reason?: string): string {
  if (input.locale?.startsWith('pt')) {
    if (reason?.includes('google_calendar_not_connected')) return 'Não consigo criar o evento ainda porque a tua conta Google Calendar não está ligada com permissão de escrita.';
    if (reason?.includes('outlook_calendar_not_connected')) return 'Não consigo criar o evento ainda porque a tua conta Outlook Calendar não está ligada com permissão de escrita.';
    if (reason?.includes('not_connected')) return 'Não consigo fazer isso ainda porque o provedor necessário não está ligado com permissão de escrita.';
    if (reason?.includes('conflict')) return 'Encontrei um conflito no calendário. Queres que eu marque mesmo assim?';
    if (reason?.includes('executor_not_enabled') || reason?.includes('execution_policy_blocked') || reason?.includes('requires_provider') || reason?.includes('requires_preview_contract') || reason?.includes('requires_outbound_confirmation') || reason?.includes('requires_provider_specific')) return 'Ainda não consigo executar essa ação por chat com segurança. Nada foi alterado.';
    if (reason?.includes('read_back')) return 'A ação foi tentada, mas não consegui verificar o resultado. Não vou afirmar sucesso completo.';
    if (reason?.includes('required')) return 'Preciso de mais um detalhe específico antes de executar isto com segurança.';
    return 'Não consegui concluir a ação agora. Nada foi confirmado como feito.';
  }
  if (reason?.includes('google_calendar_not_connected')) return 'I cannot create the event yet because Google Calendar is not connected with write permission.';
  if (reason?.includes('outlook_calendar_not_connected')) return 'I cannot create the event yet because Outlook Calendar is not connected with write permission.';
  if (reason?.includes('not_connected')) return 'I cannot do that yet because the required provider is not connected with write permission.';
  if (reason?.includes('conflict')) return 'I found a calendar conflict. Do you want me to schedule it anyway?';
  if (reason?.includes('executor_not_enabled') || reason?.includes('execution_policy_blocked') || reason?.includes('requires_provider') || reason?.includes('requires_preview_contract') || reason?.includes('requires_outbound_confirmation') || reason?.includes('requires_provider_specific')) return 'I cannot safely run that action from chat yet. Nothing was changed.';
  if (reason?.includes('read_back')) return 'The action was attempted, but I could not verify the result. I will not claim full success.';
  if (reason?.includes('required')) return 'I need one more specific detail before I can do this safely.';
  return 'I could not complete the action right now. Nothing was confirmed as done.';
}

export function partialCopy(input: ChatPlannerInput): string {
  return input.locale?.startsWith('pt')
    ? 'Fiz parte do pedido, mas não consegui verificar tudo. Não vou afirmar sucesso completo.'
    : 'I completed part of the request, but could not verify everything. I will not claim full success.';
}

export function unsupportedChatExecutorReason(step: ChatPlanStep): string {
  switch (step.action) {
    case 'draft_email':
      return 'email_draft_requires_provider_draft_read_back_contract';
    case 'send_email':
      return 'email_send_requires_outbound_confirmation_and_provider_read_back_contract';
    case 'training_adjust_plan':
      return 'training_plan_adjust_requires_preview_contract_before_chat_execution';
    case 'connections_retry_sync':
      return 'connections_retry_sync_requires_provider_specific_sync_contract';
    default:
      return 'executor_not_enabled_for_chat_yet';
  }
}

export function confirmationCopy(plan: ChatActionPlan, input: ChatPlannerInput): string {
  const first = plan.steps[0];
  if (first?.action === 'schedule_event') {
    const args = first.args as any;
    const provider = args.provider === 'outlook_calendar' ? 'Outlook Calendar' : 'Google Calendar';
    const start = DateTime.fromISO(String(args.startDateTime)).setZone(input.timezone);
    const end = DateTime.fromISO(String(args.endDateTime)).setZone(input.timezone);
    const title = typeof args.title === 'string' ? args.title : input.text;
    const attendeeCount = Array.isArray(args.attendees) ? args.attendees.length : 0;
    if (input.locale?.startsWith('pt')) {
      const inviteNote = attendeeCount > 0
        ? ` Isto pode enviar convite para ${attendeeCount} participante(s).`
        : '';
      return `Confirma que queres criar “${title}” no ${provider} em ${start.setLocale('pt').toFormat("cccc, d 'de' LLLL")}, das ${start.toFormat('HH:mm')} às ${end.toFormat('HH:mm')}.${inviteNote}`;
    }
    const inviteNote = attendeeCount > 0
      ? ` This may send an invite to ${attendeeCount} attendee(s).`
      : '';
    return `Confirm that you want to create “${title}” in ${provider} on ${start.toFormat('cccc, LLL d')}, ${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}.${inviteNote}`;
  }
  if (first?.action === 'create_task' || first?.action === 'delete_task' || first?.action === 'complete_task' || first?.action === 'update_task') {
    const title = typeof (first.args as any).title === 'string' ? (first.args as any).title : typeof (first.args as any).taskId === 'string' ? (first.args as any).taskId : input.text;
    if (input.locale?.startsWith('pt')) {
      return `Confirma que queres ${first.action === 'delete_task' ? 'apagar' : first.action === 'complete_task' ? 'concluir' : 'alterar'} a tarefa “${title}”?`;
    }
    return `Confirm that you want to ${first.action === 'delete_task' ? 'delete' : first.action === 'complete_task' ? 'complete' : 'change'} the task “${title}”?`;
  }
  if (first?.action === 'cooking_substitute_ingredient') {
    const args = first.args as any;
    const original = String(args.originalIngredient || 'ingredient');
    const suggested = String(args.suggestedIngredient || 'replacement');
    const mealType = String(args.mealType || 'meal');
    const date = String(args.date || 'the selected day');
    if (input.locale?.startsWith('pt')) {
      return `Confirma que queres trocar ${original} por ${suggested} no ${mealType} de ${date}? Vou criar uma cópia da receita para esta refeição e atualizar a lista de compras.`;
    }
    return `Confirm replacing ${original} with ${suggested} in ${mealType} on ${date}? I’ll create a meal-specific recipe copy and update the shopping list.`;
  }
  if (input.locale?.startsWith('pt')) {
    return `Preciso da tua confirmação antes de ${first?.action === 'send_email' ? 'enviar' : 'executar'} esta ação.`;
  }
  return `I need your confirmation before I ${first?.action === 'send_email' ? 'send' : 'run'} this action.`;
}

export function defaultClarification(input: ChatPlannerInput): string {
  return input.locale?.startsWith('pt') ? 'Preciso só de mais um detalhe para continuar.' : 'I need one more detail before I continue.';
}

export function refusalReasonForPlan(plan: ChatActionPlan): string | null {
  for (const step of plan.steps) {
    const reason = (step.args as { rejectionReason?: unknown })?.rejectionReason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  return null;
}

export function refusalCopyForReason(reason: string, input: ChatPlannerInput): string {
  const locale = input.locale ?? 'en-US';
  const isPt = locale.startsWith('pt');
  const isEs = locale.startsWith('es');
  if (reason === 'prompt_injection_marker_detected') {
    if (isPt) return 'Não vou seguir instruções embutidas em mensagens. Reformule o pedido sem usar comandos como "ignore o anterior".';
    if (isEs) return 'No voy a seguir instrucciones embebidas en mensajes. Reformula la solicitud sin comandos como "ignora lo anterior".';
    return "I won't follow embedded instructions in messages. Try rephrasing without commands like \"ignore previous\".";
  }
  if (reason === 'sensitive_data_exfiltration_detected') {
    if (isPt) return 'Não posso compartilhar esse tipo de detalhe. Posso ajudar com algo mais específico?';
    if (isEs) return 'No puedo compartir ese tipo de detalle. ¿Puedo ayudarte con algo más específico?';
    return "I can't share that kind of detail. Can I help with something more specific?";
  }
  if (reason === 'bulk_destructive_request_detected') {
    if (isPt) return 'Não vou executar isso — afeta itens demais. Tente um escopo menor ou nomeie o item específico.';
    if (isEs) return 'No voy a ejecutarlo — afecta demasiados elementos. Prueba con un alcance más pequeño o nombra el elemento específico.';
    return "I won't run that — it would affect too many items. Try a smaller scope or name the specific item.";
  }
  if (isPt) return 'Não posso seguir com esse pedido.';
  if (isEs) return 'No puedo seguir con esa solicitud.';
  return "I can't proceed with that request.";
}

function friendlyActionLabel(step: ChatPlanStep, input: ChatPlannerInput): string {
  switch (step.action) {
    case 'create_task':
      return input.locale?.startsWith('pt') ? `Criei a tarefa “${String((step.args as any).title || 'tarefa')}”` : `Created task “${String((step.args as any).title || 'task')}”`;
    case 'schedule_event':
      return input.locale?.startsWith('pt') ? `Agendei “${String((step.args as any).title || 'evento')}”` : `Scheduled “${String((step.args as any).title || 'event')}”`;
    case 'content_pipeline_stage_transition':
      return input.locale?.startsWith('pt') ? 'Atualizei o estado no pipeline de Content' : 'Updated the Content pipeline stage';
    case 'cooking_substitute_ingredient':
      return input.locale?.startsWith('pt') ? 'Atualizei a substituição na refeição' : 'Updated the meal substitution';
    default:
      return `${step.skill}.${step.action}`;
  }
}

function localizePipelineStage(stage: string, portuguese: boolean): string {
  switch (stage) {
    case 'scripted':
      return portuguese ? 'roteiro pronto' : 'scripted';
    case 'filmed':
      return portuguese ? 'filmado' : 'filmed';
    case 'editing':
      return portuguese ? 'edição' : 'editing';
    case 'published':
      return portuguese ? 'publicado' : 'published';
    default:
      return stage;
  }
}
