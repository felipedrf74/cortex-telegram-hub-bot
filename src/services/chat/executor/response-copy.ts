// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

import type { ChatActionRunStatus } from '../../chat-action-run-store';
import { formatCurrencyAmount } from '../../finance-tracker';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../types';
import {
  executableSkillsForPlan,
  isCrossSkillExecutionEnabled,
} from '../planner/cross-skill-ownership';

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
  if (first?.step.action === 'set_reminder') {
    const args = first.step.args as any;
    const remindAt = DateTime.fromISO(String(args.remindAt)).setZone(input.timezone);
    return input.locale?.startsWith('pt')
      ? `Feito — criei o lembrete “${String(args.message)}” para ${remindAt.toFormat('dd/LL HH:mm')}.`
      : `Done — I created the reminder “${String(args.message)}” for ${remindAt.toFormat('LLL d, HH:mm')}.`;
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
    if (input.locale?.startsWith('pt')) return `Feito — guardei “${title}” como alvo local de trabalho no Content. Não criei um evento de calendário nem executei publicação.`;
    if (input.locale?.startsWith('es')) return `Listo: guardé “${title}” como objetivo local de trabajo en Content. No creé un evento de calendario ni ejecuté una publicación.`;
    return `Done — I saved “${title}” as a local Content work target. I did not create a calendar event or execute publication.`;
  }
  if (first?.step.action === 'content_pipeline_handoff') {
    return input.locale?.startsWith('pt')
      ? 'Feito — guardei o pacote como item versionado no workspace de Content e confirmei o read-back.'
      : 'Done — I saved the package as a versioned Content workspace item and verified the read-back.';
  }
  if (first?.step.action === 'content_pipeline_stage_transition') {
    const result = first.result as any;
    const title = String(result?.topicTitle || (first.step.args as any).topicTitle || 'content item');
    const stage = String(result?.stage || (first.step.args as any).targetStage || 'the requested stage');
    return input.locale?.startsWith('pt')
      ? `Feito — confirmei que “${title}” tem ${localizePipelineStage(stage, true)} guardado e versionado no workspace de Content.`
      : `Done — I verified that “${title}” has a saved, versioned ${localizePipelineStage(stage, false)} artifact in the Content workspace.`;
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
  if (result.step.action === 'content_schedule_work') {
    if (input.locale?.startsWith('pt')) {
      return 'Preparei uma proposta de horário no Content. Abre o item para rever e confirmar o bloco privado; ainda não marquei nada no calendário nem publiquei conteúdo.';
    }
    if (input.locale?.startsWith('es')) {
      return 'Preparé una propuesta de horario en Content. Abre el elemento para revisarla y confirmar el bloque privado; todavía no programé nada ni publiqué contenido.';
    }
    return 'I prepared a time proposal in Content. Open the item to review and confirm the private work block; nothing has been scheduled or published yet.';
  }
  return input.locale?.startsWith('pt')
    ? 'Guardei o estado e deixei pronto para continuar.'
    : 'I saved the state and it is ready to continue.';
}

export function failureCopy(input: ChatPlannerInput, reason?: string): string {
  if (reason?.includes('content_publication_')) return contentPublicationUnsupportedCopy(input);
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

// ─── M16: multi-step honest composition ────────────────────────────

/**
 * Overflow disclosure — the splitter caps a request at 5 actionable
 * segments; segments beyond the cap are disclosed, never silently dropped.
 */
export function overflowDisclosureCopy(plan: ChatActionPlan, input: ChatPlannerInput): string | null {
  const overflow = plan.multiStepOverflowCount ?? 0;
  if (overflow <= 0) return null;
  const total = plan.steps.length + overflow;
  if (input.locale?.startsWith('pt')) {
    return `Encontrei ${total} pedidos; vou tratar apenas dos primeiros ${plan.steps.length} — pede-me os restantes depois.`;
  }
  if (input.locale?.startsWith('es')) {
    return `Encontré ${total} solicitudes; solo voy a tratar las primeras ${plan.steps.length} — pídeme el resto después.`;
  }
  return `I found ${total} requests; I'm only handling the first ${plan.steps.length} — ask me for the rest afterwards.`;
}

/**
 * Confirmation preview for multi-step plans: enumerates the INTERPRETED
 * step list so a low-confidence split is visible to the user before
 * anything executes.
 */
export function multiStepPreviewCopy(plan: ChatActionPlan, input: ChatPlannerInput): string {
  // M19 (flag AI_CROSS_SKILL_EXECUTION, default OFF → byte-identical copy):
  // a plan spanning >=2 skills renders its preview GROUPED by skill so the
  // one confirmation shows which skill runs which step.
  if (isCrossSkillExecutionEnabled()) {
    const grouped = crossSkillGroupedPreviewLines(plan, input);
    if (grouped) return renderMultiStepPreview(plan, input, grouped);
  }
  const lines = plan.steps.map((step, index) => `${index + 1}. ${plannedActionLabel(step, input)}`);
  return renderMultiStepPreview(plan, input, lines);
}

function crossSkillGroupedPreviewLines(plan: ChatActionPlan, input: ChatPlannerInput): string[] | null {
  const skills = executableSkillsForPlan(plan.steps);
  if (skills.length < 2) return null;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const skill of plan.steps.map((step) => step.skill)) {
    if (seen.has(skill)) continue;
    seen.add(skill);
    lines.push(`${skillGroupLabel(skill, input)}:`);
    plan.steps.forEach((step, index) => {
      if (step.skill !== skill) return;
      lines.push(`${index + 1}. ${plannedActionLabel(step, input)}`);
    });
  }
  return lines;
}

function skillGroupLabel(skill: string, input: ChatPlannerInput): string {
  const isPt = input.locale?.startsWith('pt');
  const isEs = input.locale?.startsWith('es');
  const labels: Record<string, { en: string; pt: string; es: string }> = {
    secretary_calendar: { en: 'Secretary — Calendar', pt: 'Secretária — Agenda', es: 'Secretaría — Agenda' },
    secretary_reminders: { en: 'Secretary — Reminders', pt: 'Secretária — Lembretes', es: 'Secretaría — Recordatorios' },
    mail: { en: 'Secretary — Mail', pt: 'Secretária — Email', es: 'Secretaría — Correo' },
    tasks: { en: 'Secretary — Tasks', pt: 'Secretária — Tarefas', es: 'Secretaría — Tareas' },
    training: { en: 'Training', pt: 'Treino', es: 'Entrenamiento' },
    content: { en: 'Content', pt: 'Conteúdo', es: 'Contenido' },
    cooking: { en: 'Cooking', pt: 'Cozinha', es: 'Cocina' },
    finance: { en: 'Finance', pt: 'Finanças', es: 'Finanzas' },
    connections: { en: 'Connections', pt: 'Ligações', es: 'Conexiones' },
    notifications: { en: 'Notifications', pt: 'Notificações', es: 'Notificaciones' },
    decision_center: { en: 'Decision Center', pt: 'Central de Decisões', es: 'Centro de Decisiones' },
  };
  const entry = labels[skill];
  if (!entry) return skill;
  return isPt ? entry.pt : isEs ? entry.es : entry.en;
}

function renderMultiStepPreview(plan: ChatActionPlan, input: ChatPlannerInput, lines: string[]): string {
  const overflow = overflowDisclosureCopy(plan, input);
  if (input.locale?.startsWith('pt')) {
    return [
      `Interpretei ${plan.steps.length} passos:`,
      ...lines,
      '',
      ...(overflow ? [overflow] : []),
      'Confirmas que queres que eu execute estes passos?',
    ].join('\n');
  }
  if (input.locale?.startsWith('es')) {
    return [
      `Interpreté ${plan.steps.length} pasos:`,
      ...lines,
      '',
      ...(overflow ? [overflow] : []),
      '¿Confirmas que quieres que ejecute estos pasos?',
    ].join('\n');
  }
  return [
    `I understood ${plan.steps.length} steps:`,
    ...lines,
    '',
    ...(overflow ? [overflow] : []),
    'Confirm that you want me to run these steps?',
  ].join('\n');
}

/**
 * Honest partial composition: enumerate done / failed / blocked with
 * per-branch reasons. Never claims success for a failed or blocked step.
 */
export function multiStepOutcomeCopy(
  input: ChatPlannerInput,
  plan: ChatActionPlan,
  results: Array<{ step: ChatPlanStep; status: ChatActionRunStatus; error?: string }>,
): string {
  const isPt = input.locale?.startsWith('pt');
  const isEs = input.locale?.startsWith('es');
  const byStepId = new Map(results.map((result) => [result.step.stepId, result]));
  const succeeded = results.filter((result) => result.status === 'verified_success').length;
  const lines = plan.steps.map((step, index) => {
    const result = byStepId.get(step.stepId);
    const label = plannedActionLabel(step, input);
    return `${index + 1}. ${label} — ${stepOutcomeLabel(result, input)}`;
  });
  const firstError = results.find((result) => result.status === 'failed' || result.status === 'blocked')?.error;
  // Wording note: the header deliberately avoids first-person completion
  // claims ("I completed...") — a partial outcome must not read as a full
  // success claim to the success-claim heuristics (chat-success-claim-policy)
  // while still being specific about what was verified.
  const header = isPt
    ? `Resultado — ${succeeded} de ${plan.steps.length} passos verificados:`
    : isEs
      ? `Resultado — ${succeeded} de ${plan.steps.length} pasos verificados:`
      : `Here's the outcome — ${succeeded} of ${plan.steps.length} steps verified:`;
  const overflow = overflowDisclosureCopy(plan, input);
  return [
    header,
    ...lines,
    '',
    failureCopy(input, firstError),
    ...(overflow ? [overflow] : []),
  ].join('\n');
}

function stepOutcomeLabel(
  result: { status: ChatActionRunStatus; error?: string } | undefined,
  input: ChatPlannerInput,
): string {
  const isPt = input.locale?.startsWith('pt');
  const isEs = input.locale?.startsWith('es');
  const status = result?.status ?? 'pending';
  if (status === 'verified_success') {
    return isPt ? 'feito e verificado' : isEs ? 'hecho y verificado' : 'done and verified';
  }
  if (status === 'blocked') {
    if (result?.error === 'dependency_failed') {
      return isPt
        ? 'não executado (dependia de um passo que falhou)'
        : isEs
          ? 'no ejecutado (dependía de un paso que falló)'
          : 'not run (it depended on a step that failed)';
    }
    return isPt ? 'bloqueado' : isEs ? 'bloqueado' : 'blocked';
  }
  if (status === 'failed') {
    return isPt ? 'falhou' : isEs ? 'falló' : 'failed';
  }
  if (status === 'partial_success' || status === 'verified_pending') {
    return isPt
      ? 'tentado, mas sem verificação completa'
      : isEs
        ? 'intentado, pero sin verificación completa'
        : 'attempted, but not fully verified';
  }
  return isPt ? 'não executado' : isEs ? 'no ejecutado' : 'not run';
}

/**
 * Future-tense per-step label for previews and outcome enumerations.
 * Compact by design — the full arg detail lives in actionResults metadata.
 */
export function plannedActionLabel(step: ChatPlanStep, input: ChatPlannerInput): string {
  const isPt = input.locale?.startsWith('pt');
  const isEs = input.locale?.startsWith('es');
  const args = step.args as Record<string, unknown>;
  const quoted = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? `“${value.trim()}”` : null;
  const chained = (value: unknown): boolean =>
    !!value && typeof value === 'object' && typeof (value as { $ref?: unknown }).$ref === 'string';
  switch (step.action) {
    case 'create_task':
    case 'create_task_with_subtasks':
    case 'create_checklist': {
      const title = quoted(args.title);
      if (isPt) return title ? `Criar a tarefa ${title}` : 'Criar uma tarefa';
      if (isEs) return title ? `Crear la tarea ${title}` : 'Crear una tarea';
      return title ? `Create task ${title}` : 'Create a task';
    }
    case 'complete_task': {
      const ref = chained(args.taskId);
      if (isPt) return ref ? 'Concluir a tarefa criada no passo anterior' : `Concluir a tarefa ${quoted(args.taskId) ?? ''}`.trim();
      if (isEs) return ref ? 'Completar la tarea creada en el paso anterior' : `Completar la tarea ${quoted(args.taskId) ?? ''}`.trim();
      return ref ? 'Complete the task created in the earlier step' : `Complete task ${quoted(args.taskId) ?? ''}`.trim();
    }
    case 'delete_task': {
      const ref = chained(args.taskId);
      if (isPt) return ref ? 'Apagar a tarefa criada no passo anterior' : `Apagar a tarefa ${quoted(args.taskId) ?? ''}`.trim();
      if (isEs) return ref ? 'Eliminar la tarea creada en el paso anterior' : `Eliminar la tarea ${quoted(args.taskId) ?? ''}`.trim();
      return ref ? 'Delete the task created in the earlier step' : `Delete task ${quoted(args.taskId) ?? ''}`.trim();
    }
    case 'schedule_event': {
      const title = quoted(args.title) ?? (chained(args.title)
        ? (isPt ? 'o item do passo anterior' : isEs ? 'el elemento del paso anterior' : 'the item from the earlier step')
        : null);
      if (isPt) return title ? `Agendar ${title} no calendário` : 'Agendar um evento';
      if (isEs) return title ? `Agendar ${title} en el calendario` : 'Agendar un evento';
      return title ? `Schedule ${title} on the calendar` : 'Schedule an event';
    }
    case 'delete_event':
      return isPt ? 'Apagar o evento' : isEs ? 'Eliminar el evento' : 'Delete the event';
    case 'move_event':
    case 'update_event':
      return isPt ? 'Atualizar o evento' : isEs ? 'Actualizar el evento' : 'Update the event';
    case 'set_reminder': {
      const message = quoted(args.message);
      if (isPt) return message ? `Criar o lembrete ${message}` : 'Criar um lembrete';
      if (isEs) return message ? `Crear el recordatorio ${message}` : 'Crear un recordatorio';
      return message ? `Set reminder ${message}` : 'Set a reminder';
    }
    default:
      return `${step.skill}.${step.action}`;
  }
}

export function unsupportedChatExecutorReason(step: ChatPlanStep): string {
  switch (step.action) {
    case 'training_adjust_plan':
      return 'training_plan_adjust_requires_preview_contract_before_chat_execution';
    default:
      return 'executor_not_enabled_for_chat_yet';
  }
}

export function confirmationCopy(plan: ChatActionPlan, input: ChatPlannerInput): string {
  // M16: multi-step plans preview the full interpreted step list (plus any
  // overflow disclosure) instead of describing only the first step.
  if (plan.steps.length > 1) return multiStepPreviewCopy(plan, input);
  const first = plan.steps[0];
  if (first?.action === 'content_schedule_work') {
    const args = first.args as any;
    const start = DateTime.fromISO(String(args.dateTime), { zone: input.timezone }).setZone(input.timezone);
    const title = typeof args.title === 'string' ? args.title : 'content work';
    if (input.locale?.startsWith('pt')) {
      return `Confirma que queres preparar uma proposta de horário para “${title}” em ${start.setLocale('pt').toFormat("cccc, d 'de' LLLL 'às' HH:mm")}? Ainda vais rever e confirmar o bloco exato no Content antes de qualquer marcação.`;
    }
    if (input.locale?.startsWith('es')) {
      return `¿Confirmas que quieres preparar una propuesta de horario para “${title}” el ${start.setLocale('es').toFormat("cccc, d 'de' LLLL 'a las' HH:mm")}? Revisarás y confirmarás el bloque exacto en Content antes de programarlo.`;
    }
    return `Confirm that you want to prepare a time proposal for “${title}” on ${start.toFormat('cccc, LLL d')} at ${start.toFormat('HH:mm')}? You will still review and confirm the exact block in Content before anything is scheduled.`;
  }
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
  if (first?.action === 'set_reminder') {
    const args = first.args as any;
    const remindAt = DateTime.fromISO(String(args.remindAt)).setZone(input.timezone);
    if (input.locale?.startsWith('pt')) {
      return `Confirma que queres criar o lembrete “${String(args.message || input.text)}” para ${remindAt.toFormat('dd/LL HH:mm')}?`;
    }
    return `Confirm that you want to create the reminder “${String(args.message || input.text)}” for ${remindAt.toFormat('LLL d, HH:mm')}?`;
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
  if (reason === 'content_publication_execution_not_supported' || reason === 'content_publication_tracking_not_supported') {
    return contentPublicationUnsupportedCopy(input);
  }
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

function contentPublicationUnsupportedCopy(input: ChatPlannerInput): string {
  if (input.locale?.startsWith('pt')) {
    return 'Não consigo publicar, carregar, colocar conteúdo numa fila externa ou confirmar publicação pelo chat. Não fiz alterações. Posso guardar um alvo de trabalho no Content.';
  }
  if (input.locale?.startsWith('es')) {
    return 'No puedo publicar, subir, poner contenido en una cola externa ni confirmar una publicación desde el chat. No hice cambios. Puedo guardar un objetivo de trabajo en Content.';
  }
  return 'I cannot publish, upload, queue content externally, or confirm publication from chat. I made no changes. I can save a Content work target instead.';
}

function friendlyActionLabel(step: ChatPlanStep, input: ChatPlannerInput): string {
  switch (step.action) {
    case 'create_task':
      return input.locale?.startsWith('pt') ? `Criei a tarefa “${String((step.args as any).title || 'tarefa')}”` : `Created task “${String((step.args as any).title || 'task')}”`;
    case 'schedule_event':
      return input.locale?.startsWith('pt') ? `Agendei “${String((step.args as any).title || 'evento')}”` : `Scheduled “${String((step.args as any).title || 'event')}”`;
    case 'set_reminder':
      return input.locale?.startsWith('pt') ? `Criei o lembrete “${String((step.args as any).message || 'lembrete')}”` : `Created reminder “${String((step.args as any).message || 'reminder')}”`;
    case 'content_pipeline_stage_transition':
      return input.locale?.startsWith('pt') ? 'Confirmei o estado no workspace de Content' : 'Verified the Content workspace state';
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
