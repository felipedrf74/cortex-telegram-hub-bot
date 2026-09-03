// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { config } from '../config';
import { secretaryTodayLabels, secretaryTodayText } from './secretary-today-copy';
import type { WeeklyPlanSourceHealth } from './secretary-planning-context';
import {
  hasConfirmedPrivateContentBlock,
  isCurrentConfirmedPrivateContentBlock,
  type WeeklyPlanDay,
  type WeeklyPlanResponse,
} from './weekly-plan-orchestrator';

export type SecretarySkillId = 'secretary' | 'training' | 'content' | 'cooking' | 'finance';
export type PlanConfidence = 'low' | 'medium' | 'high';
export type BlockerSeverity = 'low' | 'medium' | 'high';
export type BlockerUrgency = 'today' | 'this_week' | 'monitor';
export type TimeWindowQuality =
  | 'deep_focus'
  | 'creative'
  | 'admin_light'
  | 'recovery_compatible'
  | 'portable'
  | 'fragmented'
  | 'not_worth_scheduling';
export type SecretaryExecutionMode =
  | 'deep_work_day'
  | 'reactive_day'
  | 'recovery_protected_day'
  | 'meeting_salvage_day'
  | 'admin_consolidation_day'
  | 'high_output_day'
  | 'stable_day';
export type SecretaryWeeklyMode =
  | 'consistency'
  | 'output'
  | 'recovery'
  | 'deadline_pressure'
  | 'travel_logistics'
  | 'stable';
export type BlockerKind =
  | 'calendar_overload'
  | 'travel_constraint'
  | 'task_pressure'
  | 'focus_gap'
  | 'energy_constraint'
  | 'deadline_collision'
  | 'dependency_gap';
export type ResolutionAction = 'protect' | 'move' | 'defer' | 'compress' | 'split' | 'batch' | 'salvage';
export type ProtectedBlockType = 'focus' | 'training' | 'content' | 'admin' | 'recovery' | 'meal' | 'travel';
export type NextBestActionKind =
  | 'protect_focus'
  | 'salvage_day'
  | 'batch_overdue'
  | 'lighten_day'
  | 'work_content'
  | 'protect_training'
  | 'finance_first'
  | 'portable_day'
  | 'follow_plan';

export interface DayOrchestrationCardModel {
  posture: SecretaryExecutionMode;
  title: string;
  summary: string;
  confidence: PlanConfidence;
  mainThing: string | null;
  reasons: string[];
  affectedSkills: SecretarySkillId[];
}

export interface WeekOrchestrationCardModel {
  posture: SecretaryWeeklyMode;
  title: string;
  summary: string;
  confidence: PlanConfidence;
  reasons: string[];
  affectedSkills: SecretarySkillId[];
}

export interface BlockerCardModel {
  id: string;
  kind: BlockerKind;
  severity: BlockerSeverity;
  urgency: BlockerUrgency;
  confidence: PlanConfidence;
  title: string;
  summary: string;
  affectedArea: 'calendar' | 'tasks' | 'focus' | 'energy' | 'content' | 'finance' | 'travel';
  affectedSkills: SecretarySkillId[];
  recommendedAction: string;
}

export interface BlockerResolutionModel {
  id: string;
  blockerId: string;
  action: ResolutionAction;
  title: string;
  summary: string;
  targetWindow: string | null;
  affectedSkills: SecretarySkillId[];
}

export interface ProtectedBlockModel {
  id: string;
  type: ProtectedBlockType;
  title: string;
  summary: string;
  windowLabel: string | null;
  quality: TimeWindowQuality;
  affectedSkills: SecretarySkillId[];
}

export interface RiskAlertModel {
  id: string;
  level: BlockerSeverity;
  title: string;
  summary: string;
}

export interface CrossSkillImpactModel {
  id: string;
  skillId: SecretarySkillId;
  skillLabel: string;
  summary: string;
}

export interface NextBestActionModel {
  kind: NextBestActionKind;
  title: string;
  summary: string;
  whyNow: string | null;
  targetWindow: string | null;
  urgency: BlockerUrgency;
  confidence: PlanConfidence;
  affectedSkills: SecretarySkillId[];
}

export type SecretaryTodayEntryStatus = 'checked' | 'handled' | 'needs_user' | 'waiting_on_source';

export interface SecretaryTodayEntryModel {
  id: string;
  label: string;
  detail: string;
  status: SecretaryTodayEntryStatus;
  source: 'agenda_sync' | 'conflict_scan' | 'reminders' | 'source_health' | 'decision_center' | 'coordination';
}

export interface SecretaryTodaySummaryModel {
  title: string;
  summary: string;
  checked: SecretaryTodayEntryModel[];
  handled: SecretaryTodayEntryModel[];
  needsUser: SecretaryTodayEntryModel[];
  waitingOnSource: SecretaryTodayEntryModel[];
  nextBestMove: string | null;
  counts: {
    checked: number;
    handled: number;
    needsUser: number;
    waitingOnSource: number;
  };
}

export interface SecretaryTodayDecisionSignals {
  handledCount?: number;
  handledTitles?: string[];
  needsUserCount?: number;
  needsUserTitles?: string[];
  staleCount?: number;
  topUserAction?: string | null;
}

export interface SecretaryCoordinationModel {
  topPriority: string | null;
  executionOrder: string[];
  watchouts: string[];
  handoffs: string[];
  confidence: PlanConfidence;
  secretaryToday: SecretaryTodaySummaryModel;
  dayOrchestration: DayOrchestrationCardModel;
  weekOrchestration: WeekOrchestrationCardModel;
  nextBestAction: NextBestActionModel | null;
  blockers: BlockerCardModel[];
  suggestedMoves: BlockerResolutionModel[];
  protectedBlocks: ProtectedBlockModel[];
  risks: RiskAlertModel[];
  crossSkillImpacts: CrossSkillImpactModel[];
}

export interface SecretaryOrchestrationInput {
  date: string;
  day: WeeklyPlanDay;
  weekPlan: Pick<WeeklyPlanResponse, 'days' | 'conflicts' | 'variant'>;
  conflicts: WeeklyPlanResponse['conflicts'];
  language?: string;
  secretaryTodaySignals?: SecretaryTodayDecisionSignals;
  sourceHealth?: Pick<WeeklyPlanSourceHealth, 'calendar' | 'tasks' | 'mail'>;
}

interface DerivedDaySignals {
  availableSkills: SecretarySkillId[];
  activeSkills: SecretarySkillId[];
  isTravelDay: boolean;
  isCalendarOverloaded: boolean;
  isFragmentedDay: boolean;
  needsRecoveryProtection: boolean;
  hasFocusBlock: boolean;
  hasContentWindow: boolean;
  hasBlockedContent: boolean;
  hasFinancePressure: boolean;
  hasHighTaskPressure: boolean;
  hasOverduePressure: boolean;
  hasWritableCalendar: boolean;
  hasTrainingCommitment: boolean;
  hasMeaningfulCoordination: boolean;
  eventCount: number;
  criticalMeetingCount: number;
  taskCountForDate: number;
  overdueCount: number;
  mailUnreadTotal: number;
  movableTaskCount: number;
  fixedTaskCount: number;
  portableTaskRatio: number;
}

export function buildSecretaryCoordination(input: SecretaryOrchestrationInput): SecretaryCoordinationModel {
  const language = normalizeLanguage(input.language);
  const signals = deriveSignals(input.day);
  const dayOrchestration = buildDayOrchestration(input, signals, language);
  const weekOrchestration = buildWeekOrchestration(input, signals, language);
  const blockers = buildBlockers(input, signals, language).slice(0, 3);
  const protectedBlocks = buildProtectedBlocks(input, signals, language).slice(0, 3);
  const crossSkillImpacts = buildCrossSkillImpacts(input.day, signals, language).slice(0, 3);
  const suggestedMoves = buildResolutions({
    input,
    signals,
    blockers,
    protectedBlocks,
    language,
  }).slice(0, 2);
  const nextBestAction = chooseNextBestAction({
    input,
    signals,
    blockers,
    suggestedMoves,
    protectedBlocks,
    language,
  });
  const risks = buildRisks({
    input,
    signals,
    blockers,
    nextBestAction,
    language,
  }).slice(0, 2);
  const confidence = resolveConfidence({
    signals,
    blockers,
    nextBestAction,
  });
  const secretaryToday = buildSecretaryTodaySummary({
    input,
    signals,
    blockers,
    nextBestAction,
    language,
  });

  const executionOrder = dedupeStrings([
    nextBestAction?.title ?? null,
    ...suggestedMoves.map((move) => move.title),
    ...input.day.secretary.sequence,
  ]).slice(0, 3);

  const handoffs = dedupeStrings([
    ...crossSkillImpacts.map((impact) => impact.summary),
    ...protectedBlocks.map((block) => block.summary),
  ]).slice(0, 4);

  const watchouts = dedupeStrings([
    ...blockers.map((blocker) => blocker.summary),
    ...risks.map((risk) => risk.summary),
    input.day.secretary.tradeoffNote,
  ]).slice(0, 4);

  return {
    topPriority: nextBestAction?.title
      ?? dayOrchestration.mainThing
      ?? input.day.secretary.priorityNote
      ?? null,
    executionOrder,
    watchouts,
    handoffs,
    confidence,
    secretaryToday,
    dayOrchestration,
    weekOrchestration,
    nextBestAction,
    blockers,
    suggestedMoves,
    protectedBlocks,
    risks,
    crossSkillImpacts,
  };
}

function buildSecretaryTodaySummary(opts: {
  input: SecretaryOrchestrationInput;
  signals: DerivedDaySignals;
  blockers: BlockerCardModel[];
  nextBestAction: NextBestActionModel | null;
  language: string;
}): SecretaryTodaySummaryModel {
  const { input, signals, blockers, nextBestAction, language } = opts;
  const decisionSignals = input.secretaryTodaySignals ?? {};
  const copy = secretaryTodayLabels(language);
  const calendarReady = input.sourceHealth?.calendar.status === 'ready';
  const operationalSourcesReady = input.sourceHealth?.tasks.status === 'ready'
    && input.sourceHealth?.mail.status === 'ready';
  const checked = compactEntries([
    calendarReady ? entry({
      id: 'agenda-sync',
      label: secretaryTodayText(language, 'Agenda verificada', 'Agenda verificada', 'Agenda checked'),
      detail: signals.hasWritableCalendar
        ? secretaryTodayText(language, 'A Secretary verificou a agenda e pode sincronizar mudanças determinísticas.', 'A Secretary verificou a agenda e pode sincronizar mudanças determinísticas.', 'Secretary checked the agenda and can sync deterministic changes.')
        : secretaryTodayText(language, 'A agenda foi lida, mas a escrita no calendário ainda não está disponível.', 'A agenda foi lida, mas a escrita no calendário ainda não está disponível.', 'Agenda was read, but calendar write access is not available yet.'),
      status: 'checked',
      source: 'agenda_sync',
    }) : null,
    calendarReady ? entry({
      id: 'conflict-scan',
      label: secretaryTodayText(language, 'Conflitos verificados', 'Conflitos verificados', 'Conflicts checked'),
      detail: input.conflicts.length > 0
        ? secretaryTodayText(language, `${input.conflicts.length} conflito(s) entram na fila de decisão.`, `${input.conflicts.length} conflito(s) entram na fila de decisão.`, `${input.conflicts.length} conflict(s) are in the decision queue.`)
        : secretaryTodayText(language, 'Nenhum conflito de agenda crítico foi encontrado para este dia.', 'Nenhum conflito de agenda crítico foi encontrado para este dia.', 'No critical schedule conflict was found for this day.'),
      status: 'checked',
      source: 'conflict_scan',
    }) : null,
    operationalSourcesReady ? entry({
      id: 'reminder-pressure',
      label: secretaryTodayText(language, 'Pressão operacional lida', 'Pressão operacional lida', 'Operational pressure read'),
      detail: secretaryTodayText(
        language,
        `${signals.taskCountForDate} tarefa(s) para hoje, ${signals.overdueCount} atrasada(s), ${signals.mailUnreadTotal} email(s) por ler.`,
        `${signals.taskCountForDate} tarefa(s) para hoje, ${signals.overdueCount} atrasada(s), ${signals.mailUnreadTotal} email(s) por ler.`,
        `${signals.taskCountForDate} task(s) due today, ${signals.overdueCount} overdue, ${signals.mailUnreadTotal} unread email(s).`,
      ),
      status: 'checked',
      source: 'reminders',
    }) : null,
    entry({
      id: 'coordination-sequence',
      label: text(language, 'Sequência preparada', 'Sequência preparada', 'Sequence prepared'),
      detail: input.day.secretary.sequence[0] ?? nextBestAction?.summary ?? input.day.secretary.priorityNote ?? null,
      status: 'checked',
      source: 'coordination',
    }),
  ]);
  const handled = compactEntries([
    ...(decisionSignals.handledTitles ?? []).slice(0, 3).map((title, index) => entry({
      id: `handled-decision-${index}`,
      label: copy.handledByNexus,
      detail: title,
      status: 'handled',
      source: 'decision_center',
    })),
  ]);
  const needsUser = compactEntries([
    ...(decisionSignals.needsUserTitles ?? []).slice(0, 3).map((title, index) => entry({
      id: `needs-user-decision-${index}`,
      label: copy.needsYou,
      detail: title,
      status: 'needs_user',
      source: 'decision_center',
    })),
    ...(((decisionSignals.needsUserCount ?? 0) === 0 && blockers.length > 0) ? [entry({
      id: 'blocker-choice',
      label: text(language, 'Escolha recomendada', 'Escolha recomendada', 'Recommended choice'),
      detail: blockers[0].recommendedAction,
      status: 'needs_user',
      source: 'decision_center',
    })] : []),
  ]);
  const waitingOnSource = compactEntries([
    !calendarReady ? entry({
      id: 'source-health-calendar',
      label: secretaryTodayText(language, 'Agenda a confirmar', 'Agenda a confirmar', 'Agenda needs confirmation'),
      detail: secretaryTodayText(language, 'A fonte canónica da agenda não está pronta, por isso conflitos e tempo livre não estão confirmados.', 'A fonte canónica da agenda não está pronta, por isso conflitos e tempo livre não estão confirmados.', 'The canonical agenda source is not ready, so conflicts and free time are not confirmed.'),
      status: 'waiting_on_source',
      source: 'source_health',
    }) : null,
    input.sourceHealth?.tasks.status !== 'ready' ? entry({
      id: 'source-health-tasks',
      label: secretaryTodayText(language, 'Tarefas a confirmar', 'Tarefas a confirmar', 'Tasks need confirmation'),
      detail: secretaryTodayText(language, 'A fonte de tarefas ainda não está pronta; contagens zero não são tratadas como estado limpo.', 'A fonte de tarefas ainda não está pronta; contagens zero não são tratadas como estado limpo.', 'The task source is not ready; zero counts are not treated as an all-clear.'),
      status: 'waiting_on_source',
      source: 'source_health',
    }) : null,
    input.sourceHealth?.mail.status !== 'ready' ? entry({
      id: 'source-health-mail',
      label: secretaryTodayText(language, 'Email a confirmar', 'Email a confirmar', 'Mail needs confirmation'),
      detail: secretaryTodayText(language, 'A fonte de email ainda não está pronta; contagens zero não são tratadas como estado limpo.', 'A fonte de email ainda não está pronta; contagens zero não são tratadas como estado limpo.', 'The mail source is not ready; zero counts are not treated as an all-clear.'),
      status: 'waiting_on_source',
      source: 'source_health',
    }) : null,
    (decisionSignals.staleCount ?? 0) > 0 ? entry({
      id: 'stale-decision-source',
      label: secretaryTodayText(language, 'Fonte a confirmar', 'Fonte a confirmar', 'Source needs confirmation'),
      detail: secretaryTodayText(language, `${decisionSignals.staleCount} decisão(ões) dependem de estado em cache ou atrasado.`, `${decisionSignals.staleCount} decisão(ões) dependem de estado em cache ou atrasado.`, `${decisionSignals.staleCount} decision(s) depend on cached or delayed source state.`),
      status: 'waiting_on_source',
      source: 'source_health',
    }) : null,
  ]);
  const nextBestMove = decisionSignals.topUserAction ?? nextBestAction?.title ?? input.day.secretary.priorityNote ?? null;
  const title = copy.title;
  const summary = summarizeSecretaryToday(language, {
    handledCount: Math.max(decisionSignals.handledCount ?? 0, handled.length),
    needsUserCount: Math.max(decisionSignals.needsUserCount ?? 0, needsUser.length),
    waitingCount: waitingOnSource.length,
    nextBestMove,
  });

  return {
    title,
    summary,
    checked,
    handled,
    needsUser,
    waitingOnSource,
    nextBestMove,
    counts: {
      checked: checked.length,
      handled: handled.length,
      needsUser: needsUser.length,
      waitingOnSource: waitingOnSource.length,
    },
  };
}

function summarizeSecretaryToday(language: string, input: {
  handledCount: number;
  needsUserCount: number;
  waitingCount: number;
  nextBestMove: string | null;
}): string {
  if (input.needsUserCount > 0) {
    return text(
      language,
      `Há ${input.needsUserCount} escolha(s) que precisam do teu julgamento antes da Secretary reorganizar algo.`,
      `Há ${input.needsUserCount} escolha(s) que precisam do seu julgamento antes da Secretary reorganizar algo.`,
      `${input.needsUserCount} choice(s) need your judgment before Secretary reorganizes anything.`,
    );
  }
  if (input.waitingCount > 0) {
    return text(
      language,
      'A Secretary montou o melhor estado possível, mas uma fonte ainda precisa confirmar dados.',
      'A Secretary montou o melhor estado possível, mas uma fonte ainda precisa confirmar dados.',
      'Secretary built the best available state, but one source still needs to confirm data.',
    );
  }
  if (input.handledCount > 0) {
    return text(
      language,
      `Nexus já tratou ${input.handledCount} item(s) e deixou o próximo movimento claro.`,
      `Nexus já tratou ${input.handledCount} item(s) e deixou o próximo movimento claro.`,
      `Nexus has already handled ${input.handledCount} item(s) and made the next move clear.`,
    );
  }
  return input.nextBestMove
    ? text(language, `Próximo movimento: ${input.nextBestMove}.`, `Próximo movimento: ${input.nextBestMove}.`, `Next move: ${input.nextBestMove}.`)
    : text(language, 'Agenda verificada; nada urgente precisa da tua ação agora.', 'Agenda verificada; nada urgente precisa da sua ação agora.', 'Agenda checked; nothing urgent needs your action right now.');
}

function entry(input: {
  id: string;
  label: string;
  detail: string | null | undefined;
  status: SecretaryTodayEntryStatus;
  source: SecretaryTodayEntryModel['source'];
}): SecretaryTodayEntryModel | null {
  const detail = input.detail?.trim();
  if (!detail) return null;
  return {
    id: input.id,
    label: input.label,
    detail,
    status: input.status,
    source: input.source,
  };
}

function compactEntries(values: Array<SecretaryTodayEntryModel | null | undefined>): SecretaryTodayEntryModel[] {
  return values.filter((value): value is SecretaryTodayEntryModel => Boolean(value));
}

function isConfirmedPrivateContentBlock(content: WeeklyPlanDay['content']): boolean {
  return hasConfirmedPrivateContentBlock(content);
}

function deriveSignals(day: WeeklyPlanDay): DerivedDaySignals {
  const availableSkills = resolveAvailableSkills(day);
  const eventCount = day.secretary.calendarEventCount ?? (day.secretary.busy ? 4 : 0);
  const criticalMeetingCount = day.secretary.criticalMeetingCount ?? 0;
  const taskCountForDate = day.secretary.tasksDueOnDate ?? 0;
  const overdueCount = day.secretary.overdueTasks ?? 0;
  const mailUnreadTotal = day.secretary.mailUnreadTotal ?? 0;
  const movableTaskCount = day.secretary.movableTaskCount ?? Math.max(0, day.secretary.pendingTasks - taskCountForDate);
  const fixedTaskCount = day.secretary.fixedTaskCount ?? Math.max(0, taskCountForDate + overdueCount);
  const portableTaskRatio = day.secretary.portableTaskRatio ?? (day.secretary.pendingTasks > 0
    ? Math.max(0, movableTaskCount) / Math.max(day.secretary.pendingTasks, 1)
    : 0);

  const isCalendarOverloaded = day.secretary.busy || eventCount >= 4 || criticalMeetingCount >= 2;
  const isFragmentedDay = day.secretary.fragmented ?? (eventCount >= 4 && criticalMeetingCount >= 1);
  const hasContentWindow = isConfirmedPrivateContentBlock(day.content);
  const hasBlockedContent = day.content?.status === 'blocked';
  const hasFinancePressure = hasMeaningfulFinancePressure(day.finance);
  const needsRecoveryProtection = trainingNeedsRecovery(day);
  const hasHighTaskPressure = overdueCount > 0 || taskCountForDate >= 3 || day.secretary.pendingTasks >= 6 || mailUnreadTotal >= 12;
  const hasOverduePressure = overdueCount > 0;
  const hasFocusBlock = Boolean(day.secretary.focusBlock);
  // Read health and write authorization are separate. Older snapshots may not
  // carry this optional capability bit; absence must never authorize reflow.
  const hasWritableCalendar = day.secretary.writableCalendar === true;
  const hasTrainingCommitment = day.training.status !== 'gated' && (hasText(day.training.title) || hasText(day.training.reason));

  const activeSkills = dedupeSkills([
    hasTrainingCommitment ? 'training' : null,
    day.content ? 'content' : null,
    day.meals.length > 0 ? 'cooking' : null,
    day.finance ? 'finance' : null,
    'secretary',
  ]);

  return {
    availableSkills,
    activeSkills,
    isTravelDay: day.secretary.travel,
    isCalendarOverloaded,
    isFragmentedDay,
    needsRecoveryProtection,
    hasFocusBlock,
    hasContentWindow,
    hasBlockedContent,
    hasFinancePressure,
    hasHighTaskPressure,
    hasOverduePressure,
    hasWritableCalendar,
    hasTrainingCommitment,
    hasMeaningfulCoordination: activeSkills.length > 1 || isCalendarOverloaded || hasHighTaskPressure || needsRecoveryProtection,
    eventCount,
    criticalMeetingCount,
    taskCountForDate,
    overdueCount,
    mailUnreadTotal,
    movableTaskCount,
    fixedTaskCount,
    portableTaskRatio,
  };
}

function buildDayOrchestration(
  input: SecretaryOrchestrationInput,
  signals: DerivedDaySignals,
  language: string,
): DayOrchestrationCardModel {
  const posture = selectDayPosture(signals);
  const reasons = dayReasons(input, signals, language);

  switch (posture) {
    case 'meeting_salvage_day':
      return {
        posture,
        title: text(language, 'Hoje pede modo de salvamento.', 'Hoje pede modo de salvamento.', 'Today needs salvage mode.'),
        summary: text(
          language,
          'Congela o que já é fixo e salva apenas os blocos que ainda fazem diferença.',
          'Congele o que já é fixo e salve apenas os blocos que ainda fazem diferença.',
          'Freeze what is already fixed and save only the blocks that still matter.',
        ),
        confidence: signals.hasFocusBlock || signals.hasOverduePressure ? 'high' : 'medium',
        mainThing: input.day.secretary.priorityNote,
        reasons,
        affectedSkills: signals.activeSkills,
      };
    case 'recovery_protected_day':
      return {
        posture,
        title: text(language, 'Hoje protege recuperação primeiro.', 'Hoje protege recuperação primeiro.', 'Today protects recovery first.'),
        summary: text(
          language,
          'Baixa a pressão para o resto da semana continuar executável.',
          'Baixe a pressão para o resto da semana continuar executável.',
          'Lower the pressure so the rest of the week stays executable.',
        ),
        confidence: 'high',
        mainThing: input.day.training.title || input.day.secretary.priorityNote,
        reasons,
        affectedSkills: signals.activeSkills,
      };
    case 'admin_consolidation_day':
      return {
        posture,
        title: text(language, 'Hoje deve limpar pressão operacional.', 'Hoje deve limpar pressão operacional.', 'Today should clear operational pressure.'),
        summary: text(
          language,
          'Fecha o bloco administrativo numa passagem curta antes de espalhar contexto pelo dia.',
          'Feche o bloco administrativo numa passagem curta antes de espalhar contexto pelo dia.',
          'Clear the admin block in one short pass before context spreads across the day.',
        ),
        confidence: 'medium',
        mainThing: input.day.finance?.taxNote ?? input.day.finance?.budgetNote ?? input.day.secretary.priorityNote,
        reasons,
        affectedSkills: signals.activeSkills,
      };
    case 'high_output_day':
      return {
        posture,
        title: text(language, 'Hoje tem um bloco privado de trabalho confirmado.', 'Hoje tem um bloco privado de trabalho confirmado.', 'Today has a confirmed private work block.'),
        summary: text(
          language,
          'Usa o bloco para o objetivo de trabalho registado; agendar trabalho não agenda publicação.',
          'Use o bloco para o objetivo de trabalho registrado; agendar trabalho não agenda publicação.',
          'Use the block for its recorded work purpose; scheduling work does not schedule publication.',
        ),
        confidence: 'high',
        mainThing: input.day.content?.title ?? input.day.secretary.priorityNote,
        reasons,
        affectedSkills: signals.activeSkills,
      };
    case 'deep_work_day':
      return {
        posture,
        title: text(language, 'Hoje favorece foco profundo.', 'Hoje favorece foco profundo.', 'Today favors deep work.'),
        summary: text(
          language,
          'Protege a melhor janela e empurra o trabalho leve para depois.',
          'Proteja a melhor janela e empurre o trabalho leve para depois.',
          'Protect the best window and push lighter work later.',
        ),
        confidence: 'high',
        mainThing: input.day.secretary.focusBlock?.note ?? input.day.secretary.priorityNote,
        reasons,
        affectedSkills: signals.activeSkills,
      };
    case 'reactive_day':
      return {
        posture,
        title: text(language, 'Hoje é reativo, não expansivo.', 'Hoje é reativo, não expansivo.', 'Today is reactive, not expansive.'),
        summary: text(
          language,
          'Mantém a prioridade estreita, corta troca de contexto e executa em blocos curtos.',
          'Mantenha a prioridade estreita, corte troca de contexto e execute em blocos curtos.',
          'Keep priorities narrow, cut context switching, and execute in short blocks.',
        ),
        confidence: 'medium',
        mainThing: input.day.secretary.priorityNote,
        reasons,
        affectedSkills: signals.activeSkills,
      };
    case 'stable_day':
    default:
      return {
        posture: 'stable_day',
        title: text(language, 'Hoje está executável.', 'Hoje está executável.', 'Today is executable.'),
        summary: text(
          language,
          'Não é preciso uma grande remodelação se mantiveres a ordem certa.',
          'Não é preciso uma grande remodelação se você mantiver a ordem certa.',
          'No major reshaping is needed if you keep the right order.',
        ),
        confidence: signals.hasMeaningfulCoordination ? 'medium' : 'low',
        mainThing: input.day.secretary.priorityNote,
        reasons,
        affectedSkills: signals.activeSkills,
      };
  }
}

function buildWeekOrchestration(
  input: SecretaryOrchestrationInput,
  signals: DerivedDaySignals,
  language: string,
): WeekOrchestrationCardModel {
  const posture = selectWeekPosture(input, signals);
  const reasons = weekReasons(input, signals, language);

  switch (posture) {
    case 'travel_logistics':
      return {
        posture,
        title: text(language, 'A semana está a girar em torno de logística.', 'A semana está girando em torno de logística.', 'This week is being shaped by logistics.'),
        summary: text(
          language,
          'Mantém blocos portáteis perto da viagem e evita compromissos frágeis demais.',
          'Mantenha blocos portáteis perto da viagem e evite compromissos frágeis demais.',
          'Keep portable work around the travel days and avoid fragile commitments.',
        ),
        confidence: 'high',
        reasons,
        affectedSkills: signals.availableSkills,
      };
    case 'recovery':
      return {
        posture,
        title: text(language, 'A semana está a proteger recuperação.', 'A semana está protegendo recuperação.', 'This week is protecting recovery.'),
        summary: text(
          language,
          'Consistência ganha à expansão enquanto treino e agenda recuperam margem.',
          'Consistência vence expansão enquanto treino e agenda recuperam margem.',
          'Consistency wins over expansion while training and schedule regain margin.',
        ),
        confidence: 'high',
        reasons,
        affectedSkills: signals.availableSkills,
      };
    case 'deadline_pressure':
      return {
        posture,
        title: text(language, 'A semana precisa de sequência mais afiada.', 'A semana precisa de sequência mais afiada.', 'This week needs sharper sequencing.'),
        summary: text(
          language,
          'Há prazos e blocos fixos a competir pelas mesmas janelas limitadas.',
          'Há prazos e blocos fixos competindo pelas mesmas janelas limitadas.',
          'Deadlines and fixed commitments are competing for the same limited windows.',
        ),
        confidence: 'medium',
        reasons,
        affectedSkills: signals.availableSkills,
      };
    case 'output':
      return {
        posture,
        title: text(language, 'A semana tem blocos confirmados para trabalho focado.', 'A semana tem blocos confirmados para trabalho focado.', 'This week has confirmed blocks for focused work.'),
        summary: text(
          language,
          'Vale usar cada sessão para o objetivo registado sem inferir publicação ou entrega.',
          'Vale usar cada sessão para o objetivo registrado sem inferir publicação ou entrega.',
          'Use each session for its recorded purpose without inferring publication or delivery.',
        ),
        confidence: 'medium',
        reasons,
        affectedSkills: signals.availableSkills,
      };
    case 'consistency':
      return {
        posture,
        title: text(language, 'A semana pede consistência antes de aceleração.', 'A semana pede consistência antes de aceleração.', 'This week favors consistency before acceleration.'),
        summary: text(
          language,
          'Mantém o sistema estável e evita decisões que roubem margem aos blocos importantes.',
          'Mantenha o sistema estável e evite decisões que roubem margem dos blocos importantes.',
          'Keep the system stable and avoid choices that steal margin from the important blocks.',
        ),
        confidence: 'high',
        reasons,
        affectedSkills: signals.availableSkills,
      };
    case 'stable':
    default:
      return {
        posture: 'stable',
        title: text(language, 'A semana está estável.', 'A semana está estável.', 'The week is stable.'),
        summary: text(
          language,
          'Não foram precisos grandes ajustes entre skills por agora.',
          'Não foram precisos grandes ajustes entre skills por agora.',
          'No major cross-skill reshaping is needed right now.',
        ),
        confidence: 'low',
        reasons,
        affectedSkills: signals.availableSkills,
      };
  }
}

function buildBlockers(
  input: SecretaryOrchestrationInput,
  signals: DerivedDaySignals,
  language: string,
): BlockerCardModel[] {
  const blockers: Array<BlockerCardModel & { score: number }> = [];

  if (signals.isCalendarOverloaded || signals.isFragmentedDay) {
    const severity: BlockerSeverity = signals.isCalendarOverloaded && (signals.hasHighTaskPressure || signals.hasContentWindow || signals.hasTrainingCommitment)
      ? 'high'
      : 'medium';
    const score = input.conflicts.length > 0 && (signals.hasContentWindow || signals.hasTrainingCommitment || signals.hasFinancePressure)
      ? (signals.hasFocusBlock || signals.needsRecoveryProtection
          ? (severity === 'high' ? 92 : 76)
          : (severity === 'high' ? 78 : 64))
      : (severity === 'high' ? 90 : 70);
    blockers.push({
      id: `calendar-overload:${input.date}`,
      kind: 'calendar_overload',
      severity,
      urgency: 'today',
      confidence: 'high',
      title: text(language, 'A agenda já está demasiado apertada.', 'A agenda já está apertada demais.', 'The calendar is already too tight.'),
      summary: text(
        language,
        `Há ${signals.eventCount || 'vários'} compromissos fixos a comprimir o espaço de execução real.`,
        `Há ${signals.eventCount || 'vários'} compromissos fixos comprimindo o espaço de execução real.`,
        `${signals.eventCount || 'Several'} fixed commitments are squeezing the real execution space.`,
      ),
      affectedArea: 'calendar',
      affectedSkills: dedupeSkills([
        signals.hasTrainingCommitment ? 'training' : null,
        signals.hasContentWindow || signals.hasBlockedContent ? 'content' : null,
        signals.hasFinancePressure ? 'finance' : null,
        'secretary',
      ]),
      recommendedAction: text(
        language,
        'Congela o que é fixo e corta o resto antes de tentares encaixar mais trabalho.',
        'Congele o que é fixo e corte o resto antes de tentar encaixar mais trabalho.',
        'Freeze the fixed commitments and cut the rest before trying to fit more work in.',
      ),
      score,
    });
  }

  if (signals.isTravelDay) {
    blockers.push({
      id: `travel-constraint:${input.date}`,
      kind: 'travel_constraint',
      severity: 'high',
      urgency: 'today',
      confidence: 'high',
      title: text(language, 'A viagem já consome a capacidade do dia.', 'A viagem já consome a capacidade do dia.', 'Travel is already consuming the day’s capacity.'),
      summary: text(
        language,
        'O plano precisa de ficar portátil e curto para continuar executável.',
        'O plano precisa ficar portátil e curto para continuar executável.',
        'The plan needs to stay portable and short to remain executable.',
      ),
      affectedArea: 'travel',
      affectedSkills: dedupeSkills([
        signals.hasTrainingCommitment ? 'training' : null,
        signals.hasContentWindow ? 'content' : null,
        'secretary',
      ]),
      recommendedAction: text(
        language,
        'Mantém apenas blocos essenciais e empurra o opcional para outro dia.',
        'Mantenha apenas blocos essenciais e empurre o opcional para outro dia.',
        'Keep only essential blocks and push optional work to another day.',
      ),
      score: 95,
    });
  }

  if (signals.hasHighTaskPressure) {
    const severity: BlockerSeverity = signals.hasOverduePressure ? 'high' : 'medium';
    const score = signals.isFragmentedDay && (signals.hasContentWindow || signals.hasTrainingCommitment || signals.hasFinancePressure)
      ? (severity === 'high' ? 72 : 58)
      : (severity === 'high' ? 88 : 68);
    blockers.push({
      id: `task-pressure:${input.date}`,
      kind: 'task_pressure',
      severity,
      urgency: signals.hasOverduePressure ? 'today' : 'this_week',
      confidence: 'high',
      title: text(language, 'A pressão de tarefas já está a vazar para o dia.', 'A pressão de tarefas já está vazando para o dia.', 'Task pressure is already spilling into the day.'),
      summary: text(
        language,
        `Há ${signals.overdueCount} atrasadas, ${signals.taskCountForDate} para hoje e ${signals.mailUnreadTotal} e-mails por ler no radar.`,
        `Há ${signals.overdueCount} atrasadas, ${signals.taskCountForDate} para hoje e ${signals.mailUnreadTotal} e-mails não lidos no radar.`,
        `There are ${signals.overdueCount} overdue tasks, ${signals.taskCountForDate} due today, and ${signals.mailUnreadTotal} unread emails in play.`,
      ),
      affectedArea: 'tasks',
      affectedSkills: ['secretary'],
      recommendedAction: text(
        language,
        'Agrupa admin e atrasos num bloco curto em vez de os espalhar pelo dia.',
        'Agrupe admin e atrasos num bloco curto em vez de espalhar pelo dia.',
        'Batch admin and overdue items into one short block instead of scattering them across the day.',
      ),
      score,
    });
  }

  if (!signals.hasFocusBlock && (signals.hasTrainingCommitment || signals.hasContentWindow || signals.hasFinancePressure)) {
    const score = (signals.hasContentWindow || signals.hasTrainingCommitment || signals.hasFinancePressure) && signals.isFragmentedDay
      ? 92
      : signals.isCalendarOverloaded
        ? 80
        : 60;
    blockers.push({
      id: `focus-gap:${input.date}`,
      kind: 'focus_gap',
      severity: signals.isCalendarOverloaded ? 'high' : 'medium',
      urgency: 'today',
      confidence: 'medium',
      title: text(language, 'Falta uma janela limpa para o trabalho importante.', 'Falta uma janela limpa para o trabalho importante.', 'There is no clean window for the important work.'),
      summary: text(
        language,
        'Sem um bloco real, o que importa hoje corre o risco de virar sobra de agenda.',
        'Sem um bloco real, o que importa hoje corre o risco de virar sobra de agenda.',
        'Without a real block, what matters today risks becoming leftover time.',
      ),
      affectedArea: 'focus',
      affectedSkills: dedupeSkills([
        signals.hasTrainingCommitment ? 'training' : null,
        signals.hasContentWindow || signals.hasBlockedContent ? 'content' : null,
        signals.hasFinancePressure ? 'finance' : null,
        'secretary',
      ]),
      recommendedAction: text(
        language,
        'Cria uma janela curta e protegida ou baixa já o escopo do dia.',
        'Crie uma janela curta e protegida ou reduza já o escopo do dia.',
        'Create a short protected window or reduce the scope of the day right away.',
      ),
      score,
    });
  }

  if (signals.needsRecoveryProtection) {
    blockers.push({
      id: `energy-constraint:${input.date}`,
      kind: 'energy_constraint',
      severity: signals.isCalendarOverloaded || signals.hasContentWindow ? 'high' : 'medium',
      urgency: 'today',
      confidence: 'high',
      title: text(language, 'A energia do dia já pede contenção.', 'A energia do dia já pede contenção.', 'Today’s energy already calls for restraint.'),
      summary: text(
        language,
        'Treino e recuperação estão a pedir menos atrito e menos expansão.',
        'Treino e recuperação estão pedindo menos atrito e menos expansão.',
        'Training and recovery are asking for less friction and less expansion.',
      ),
      affectedArea: 'energy',
      affectedSkills: dedupeSkills([
        signals.hasTrainingCommitment ? 'training' : null,
        signals.hasContentWindow ? 'content' : null,
        'secretary',
      ]),
      recommendedAction: text(
        language,
        'Corta trabalho opcional e mantém apenas o que protege a semana.',
        'Corte trabalho opcional e mantenha apenas o que protege a semana.',
        'Cut optional work and keep only what protects the week.',
      ),
      score: signals.isCalendarOverloaded || signals.hasContentWindow ? 84 : 66,
    });
  }

  if (input.conflicts.length > 0 || signals.hasFinancePressure) {
    const score = input.conflicts.length > 0 && (signals.hasContentWindow || signals.hasTrainingCommitment || signals.hasFinancePressure)
      ? (!signals.hasFocusBlock && !signals.needsRecoveryProtection && (signals.hasContentWindow || signals.hasFinancePressure)
          ? 96
          : 84)
      : input.conflicts.length > 0
        ? 86
        : 62;
    blockers.push({
      id: `deadline-collision:${input.date}`,
      kind: 'deadline_collision',
      severity: input.conflicts.length > 0 ? 'high' : 'medium',
      urgency: 'today',
      confidence: input.conflicts.length > 0 ? 'high' : 'medium',
      title: text(language, 'Há compromissos a competir pela mesma margem.', 'Há compromissos competindo pela mesma margem.', 'Commitments are competing for the same margin.'),
      summary: firstText([
        input.conflicts[0]?.message,
        text(
          language,
          'Admin, calendário e trabalho confirmado estão a competir pela mesma janela limitada.',
          'Admin, calendário e trabalho confirmado estão competindo pela mesma janela limitada.',
          'Admin, calendar, and confirmed work are competing for the same limited window.',
        ),
      ])!,
      affectedArea: signals.hasFinancePressure ? 'finance' : 'content',
      affectedSkills: dedupeSkills([
        signals.hasContentWindow || signals.hasBlockedContent ? 'content' : null,
        signals.hasFinancePressure ? 'finance' : null,
        signals.hasTrainingCommitment ? 'training' : null,
        'secretary',
      ]),
      recommendedAction: text(
        language,
        'Define já qual é o bloco que não pode falhar e empurra o resto para a seguir.',
        'Defina já qual é o bloco que não pode falhar e empurre o resto para depois.',
        'Decide which block cannot slip and push the rest behind it.',
      ),
      score,
    });
  }

  if (signals.hasBlockedContent) {
    blockers.push({
      id: `dependency-gap:${input.date}`,
      kind: 'dependency_gap',
      severity: 'medium',
      urgency: 'this_week',
      confidence: 'medium',
      title: text(language, 'Há trabalho dependente sem caminho limpo.', 'Há trabalho dependente sem caminho limpo.', 'Dependent work has no clean path yet.'),
      summary: text(
        language,
        'A proposta de trabalho de conteúdo ainda não tem um bloco privado confirmado.',
        'A proposta de trabalho de conteúdo ainda não tem um bloco privado confirmado.',
        'The Content work proposal still lacks a confirmed private block.',
      ),
      affectedArea: 'content',
      affectedSkills: dedupeSkills([
        'secretary',
        'content',
      ]),
      recommendedAction: text(
        language,
        'Empurra preparação vaga para outro dia e pede à Secretary uma pré-visualização para a próxima janela.',
        'Empurre preparação vaga para outro dia e peça ao Secretário uma pré-visualização para a próxima janela.',
        'Push vague prep work out and ask Secretary to preview the next window.',
      ),
      score: 58,
    });
  }

  return blockers
    .sort((lhs, rhs) => rhs.score - lhs.score)
    .map(({ score: _score, ...blocker }) => blocker);
}

function buildProtectedBlocks(
  input: SecretaryOrchestrationInput,
  signals: DerivedDaySignals,
  language: string,
): ProtectedBlockModel[] {
  const blocks: ProtectedBlockModel[] = [];

  if (input.day.secretary.focusBlock) {
    blocks.push({
      id: `focus:${input.date}`,
      type: 'focus',
      title: text(language, 'Bloco de foco', 'Bloco de foco', 'Focus block'),
      summary: input.day.secretary.focusBlock.note
        ?? text(language, 'É a melhor janela limpa do dia.', 'É a melhor janela limpa do dia.', 'It is the cleanest window of the day.'),
      windowLabel: formatWindow(input.day.secretary.focusBlock.start, input.day.secretary.focusBlock.end),
      quality: signals.hasContentWindow ? 'creative' : 'deep_focus',
      affectedSkills: dedupeSkills([
        'secretary',
        signals.hasTrainingCommitment ? 'training' : null,
        signals.hasContentWindow ? 'content' : null,
        signals.hasFinancePressure ? 'finance' : null,
      ]),
    });
  }

  if (signals.hasTrainingCommitment) {
    blocks.push({
      id: `training:${input.date}`,
      type: signals.needsRecoveryProtection ? 'recovery' : 'training',
      title: input.day.training.title || text(language, 'Treino protegido', 'Treino protegido', 'Protected training'),
      summary: input.day.training.reason
        || text(language, 'O treino continua a ser um bloco de alto custo para reorganizar.', 'O treino continua sendo um bloco de alto custo para reorganizar.', 'Training remains a high-cost block to reorganize.'),
      windowLabel: null,
      quality: signals.needsRecoveryProtection ? 'recovery_compatible' : 'deep_focus',
      affectedSkills: ['training', 'secretary'],
    });
  }

  if (signals.hasContentWindow && input.day.content) {
    const confirmedBlocks = (input.day.content.confirmedBlocks ?? [])
      .filter(isCurrentConfirmedPrivateContentBlock);
    for (const [index, block] of confirmedBlocks.entries()) {
      blocks.push({
        id: `content:${input.date}:${block.itemId}`,
        type: 'content',
        title: block.title || input.day.content.title || text(language, 'Janela de conteúdo', 'Janela de conteúdo', 'Content window'),
        summary: index === 0 && input.day.content.note
          ? input.day.content.note
          : text(language, 'Sessão privada confirmada pela Secretary; isto não publica conteúdo.', 'Sessão privada confirmada pelo Secretário; isso não publica conteúdo.', 'Secretary-confirmed private work session; this does not publish content.'),
        windowLabel: formatWindow(block.startsAt, block.endsAt),
        quality: 'creative',
        affectedSkills: ['content', 'secretary'],
      });
    }
  }

  if (signals.hasFinancePressure) {
    blocks.push({
      id: `finance:${input.date}`,
      type: 'admin',
      title: text(language, 'Bloco administrativo', 'Bloco administrativo', 'Admin block'),
      summary: firstText([
        input.day.finance?.taxNote,
        input.day.finance?.budgetNote,
        input.day.finance?.subscriptionNote,
      ]) ?? text(language, 'Há pressão operacional que não deve ser empurrada demasiado.', 'Há pressão operacional que não deve ser empurrada demais.', 'There is operational pressure that should not be pushed too far.'),
      windowLabel: null,
      quality: 'admin_light',
      affectedSkills: ['finance', 'secretary'],
    });
  }

  if (input.day.meals.length > 0) {
    blocks.push({
      id: `meal:${input.date}`,
      type: 'meal',
      title: input.day.meals[0]?.title || text(language, 'Cobertura de refeição', 'Cobertura de refeição', 'Meal coverage'),
      summary: input.day.meals[0]?.note
        || text(language, 'A refeição reduz atrito no resto do dia.', 'A refeição reduz atrito no resto do dia.', 'The meal reduces friction for the rest of the day.'),
      windowLabel: null,
      quality: 'recovery_compatible',
      affectedSkills: ['cooking', 'secretary'],
    });
  }

  if (signals.isTravelDay) {
    blocks.push({
      id: `travel:${input.date}`,
      type: 'travel',
      title: text(language, 'Logística fixa', 'Logística fixa', 'Fixed logistics'),
      summary: text(language, 'Viagem e deslocações devem ser tratadas como não negociáveis.', 'Viagem e deslocamentos devem ser tratados como não negociáveis.', 'Travel and transit should be treated as non-negotiable.'),
      windowLabel: null,
      quality: 'portable',
      affectedSkills: ['secretary'],
    });
  }

  return blocks;
}

function buildCrossSkillImpacts(
  day: WeeklyPlanDay,
  signals: DerivedDaySignals,
  language: string,
): CrossSkillImpactModel[] {
  const impacts: CrossSkillImpactModel[] = [];

  if (signals.needsRecoveryProtection) {
    impacts.push({
      id: `impact-training:${day.date}`,
      skillId: 'training',
      skillLabel: skillLabel('training', language),
      summary: text(
        language,
        'Treino está a puxar o dia para menos atrito e menos carga.',
        'Treino está puxando o dia para menos atrito e menos carga.',
        'Training is pulling the day toward less friction and less load.',
      ),
    });
  } else if (signals.hasTrainingCommitment) {
    impacts.push({
      id: `impact-training:${day.date}`,
      skillId: 'training',
      skillLabel: skillLabel('training', language),
      summary: text(
        language,
        'Treino deve ficar protegido antes de expandires trabalho opcional.',
        'Treino deve ficar protegido antes de expandir trabalho opcional.',
        'Training should stay protected before optional work expands.',
      ),
    });
  }

  if (signals.hasContentWindow) {
    impacts.push({
      id: `impact-content:${day.date}`,
      skillId: 'content',
      skillLabel: skillLabel('content', language),
      summary: text(
        language,
        'Conteúdo tem uma sessão privada confirmada para avançar o trabalho registado; isto não implica publicação.',
        'Conteúdo tem uma sessão privada confirmada para avançar o trabalho registrado; isso não implica publicação.',
        'Content has a confirmed private session for its recorded work; this does not imply publication.',
      ),
    });
  } else if (signals.hasBlockedContent) {
    impacts.push({
      id: `impact-content:${day.date}`,
      skillId: 'content',
      skillLabel: skillLabel('content', language),
      summary: text(
        language,
        'Conteúdo ainda depende de uma janela ou decisão melhor para andar.',
        'Conteúdo ainda depende de uma janela ou decisão melhor para andar.',
        'Content still depends on a better window or decision to move.',
      ),
    });
  }

  if (day.meals.length > 0) {
    impacts.push({
      id: `impact-cooking:${day.date}`,
      skillId: 'cooking',
      skillLabel: skillLabel('cooking', language),
      summary: text(
        language,
        'A refeição alinhada ajuda a manter treino e agenda mais executáveis.',
        'A refeição alinhada ajuda a manter treino e agenda mais executáveis.',
        'The aligned meal helps keep training and schedule more executable.',
      ),
    });
  }

  if (signals.hasFinancePressure) {
    impacts.push({
      id: `impact-finance:${day.date}`,
      skillId: 'finance',
      skillLabel: skillLabel('finance', language),
      summary: text(
        language,
        'Finanças ou admin merecem o primeiro slot fiável antes de ficarem ruído.',
        'Finanças ou admin merecem o primeiro slot confiável antes de virarem ruído.',
        'Finance or admin deserves the first reliable slot before it becomes noise.',
      ),
    });
  }

  if (impacts.length === 0) {
    impacts.push({
      id: `impact-secretary:${day.date}`,
      skillId: 'secretary',
      skillLabel: skillLabel('secretary', language),
      summary: text(
        language,
        'A agenda precisa sobretudo de ordem, não de mais entradas.',
        'A agenda precisa sobretudo de ordem, não de mais entradas.',
        'The schedule mostly needs order, not more inputs.',
      ),
    });
  }

  return impacts;
}

function buildResolutions(opts: {
  input: SecretaryOrchestrationInput;
  signals: DerivedDaySignals;
  blockers: BlockerCardModel[];
  protectedBlocks: ProtectedBlockModel[];
  language: string;
}): BlockerResolutionModel[] {
  const { input, signals, blockers, protectedBlocks, language } = opts;
  const focusWindow = protectedBlocks.find((block) => block.type === 'focus')?.windowLabel ?? null;
  const contentWindow = protectedBlocks.find((block) => block.type === 'content')?.windowLabel ?? null;
  const resolutions: Array<BlockerResolutionModel & { score: number }> = [];

  for (const blocker of blockers) {
    switch (blocker.kind) {
      case 'calendar_overload':
        resolutions.push({
          id: `resolution:${blocker.id}`,
          blockerId: blocker.id,
          action: signals.hasWritableCalendar ? 'protect' : 'salvage',
          title: focusWindow
            ? text(language, `Protege ${focusWindow} e corta o resto.`, `Proteja ${focusWindow} e corte o resto.`, `Protect ${focusWindow} and cut the rest.`)
            : text(language, 'Congela o fixo e baixa o escopo.', 'Congele o fixo e reduza o escopo.', 'Freeze the fixed commitments and reduce scope.'),
          summary: text(
            language,
            'Mantém só um bloco de trabalho real e empurra o admin leve para mais tarde.',
            'Mantenha só um bloco de trabalho real e empurre o admin leve para mais tarde.',
            'Keep only one real work block and push lighter admin later.',
          ),
          targetWindow: focusWindow,
          affectedSkills: blocker.affectedSkills,
          score: signals.hasFocusBlock ? 84 : 72,
        });
        break;
      case 'travel_constraint':
        resolutions.push({
          id: `resolution:${blocker.id}`,
          blockerId: blocker.id,
          action: 'defer',
          title: text(language, 'Mantém o dia portátil e curto.', 'Mantenha o dia portátil e curto.', 'Keep the day portable and short.'),
          summary: text(
            language,
            'Só o essencial fica hoje; o resto deve sair do caminho.',
            'Só o essencial fica hoje; o resto deve sair do caminho.',
            'Only the essentials stay today; the rest should move out of the way.',
          ),
          targetWindow: null,
          affectedSkills: blocker.affectedSkills,
          score: 98,
        });
        break;
      case 'task_pressure':
        resolutions.push({
          id: `resolution:${blocker.id}`,
          blockerId: blocker.id,
          action: 'batch',
          title: text(language, 'Agrupa atrasos num bloco curto.', 'Agrupe atrasos num bloco curto.', 'Batch overdue work into one short block.'),
          summary: text(
            language,
            'Fecha admin numa passagem controlada em vez de quebrar o foco ao longo do dia.',
            'Feche admin numa passagem controlada em vez de quebrar o foco ao longo do dia.',
            'Clear admin in one controlled pass instead of breaking focus throughout the day.',
          ),
          targetWindow: null,
          affectedSkills: blocker.affectedSkills,
          score: signals.portableTaskRatio >= 0.6 ? 86 : 74,
        });
        break;
      case 'focus_gap':
        resolutions.push({
          id: `resolution:${blocker.id}`,
          blockerId: blocker.id,
          action: 'protect',
          title: contentWindow
            ? text(language, `Mantém ${contentWindow} como bloco privado confirmado.`, `Mantenha ${contentWindow} como bloco privado confirmado.`, `Keep ${contentWindow} as the confirmed private block.`)
            : text(language, 'Cria uma janela curta mas real.', 'Crie uma janela curta mas real.', 'Create a short but real focus window.'),
          summary: text(
            language,
            'Se isso não for possível, baixa já a ambição do dia.',
            'Se isso não for possível, reduza já a ambição do dia.',
            'If that is not possible, lower the ambition of the day immediately.',
          ),
          targetWindow: contentWindow,
          affectedSkills: blocker.affectedSkills,
          score: contentWindow ? 92 : 82,
        });
        break;
      case 'energy_constraint':
        resolutions.push({
          id: `resolution:${blocker.id}`,
          blockerId: blocker.id,
          action: 'salvage',
          title: text(language, 'Mantém o dia leve e recuperável.', 'Mantenha o dia leve e recuperável.', 'Keep the day light and recoverable.'),
          summary: text(
            language,
            'Corta trabalho opcional e deixa só o que protege a semana.',
            'Corte trabalho opcional e deixe só o que protege a semana.',
            'Cut optional work and leave only what protects the week.',
          ),
          targetWindow: null,
          affectedSkills: blocker.affectedSkills,
          score: 94,
        });
        break;
      case 'deadline_collision':
        resolutions.push({
          id: `resolution:${blocker.id}`,
          blockerId: blocker.id,
          action: 'protect',
          title: signals.hasFinancePressure
            ? text(language, 'Fecha o bloco administrativo primeiro.', 'Feche o bloco administrativo primeiro.', 'Handle the admin block first.')
            : contentWindow
              ? text(language, `Revê o conflito do bloco de conteúdo em ${contentWindow}.`, `Revise o conflito do bloco de conteúdo em ${contentWindow}.`, `Review the Content-block conflict at ${contentWindow}.`)
              : text(language, 'Define o bloco que não pode falhar.', 'Defina o bloco que não pode falhar.', 'Define the block that cannot slip.'),
          summary: text(
            language,
            'Pede à Secretary para reconciliar os blocos confirmados; não inventes uma nova ordem ou publicação.',
            'Peça ao Secretário para reconciliar os blocos confirmados; não invente uma nova ordem ou publicação.',
            'Ask Secretary to reconcile the confirmed blocks; do not invent a new order or publication.',
          ),
          targetWindow: contentWindow,
          affectedSkills: blocker.affectedSkills,
          score: signals.hasFinancePressure ? 99 : contentWindow ? 96 : 88,
        });
        break;
      case 'dependency_gap':
        resolutions.push({
          id: `resolution:${blocker.id}`,
          blockerId: blocker.id,
          action: 'move',
          title: text(language, 'Move a preparação vaga para fora do dia.', 'Mova a preparação vaga para fora do dia.', 'Move vague prep work out of the day.'),
          summary: text(
            language,
            'Guarda a próxima janela limpa para fechar a dependência com um resultado de trabalho concreto.',
            'Guarde a próxima janela limpa para fechar a dependência com um resultado de trabalho concreto.',
            'Save the next clean window to close the dependency with a concrete work result.',
          ),
          targetWindow: contentWindow,
          affectedSkills: blocker.affectedSkills,
          score: contentWindow ? 76 : 64,
        });
        break;
      default:
        break;
    }
  }

  if (
    signals.isFragmentedDay
    && signals.portableTaskRatio >= 0.6
    && !resolutions.some((resolution) => resolution.action === 'batch')
  ) {
    resolutions.push({
      id: `resolution:portable-batch:${input.date}`,
      blockerId: 'none',
      action: 'batch',
      title: text(language, 'Junta trabalho portátil numa só passagem.', 'Junte trabalho portátil numa só passagem.', 'Batch portable work into one pass.'),
      summary: text(
        language,
        'Isso reduz trocas de contexto e impede que pequenos itens roubem o dia todo.',
        'Isso reduz trocas de contexto e impede que pequenos itens roubem o dia todo.',
        'That reduces context switching and stops small items from stealing the entire day.',
      ),
      targetWindow: null,
      affectedSkills: ['secretary'],
      score: 70,
    });
  }

  if (resolutions.length === 0 && signals.hasFocusBlock) {
    resolutions.push({
      id: `resolution:follow-plan:${input.date}`,
      blockerId: 'none',
      action: 'protect',
      title: text(language, 'Protege a melhor janela e segue o plano.', 'Proteja a melhor janela e siga o plano.', 'Protect the best window and follow the plan.'),
      summary: text(
        language,
        'Não vale abrir mais frentes enquanto o dia continua estável.',
        'Não vale abrir mais frentes enquanto o dia continua estável.',
        'Do not open more fronts while the day is still stable.',
      ),
      targetWindow: focusWindow,
      affectedSkills: signals.activeSkills,
      score: 50,
    });
  }

  return dedupeById(resolutions)
    .sort((lhs, rhs) => rhs.score - lhs.score)
    .map(({ score: _score, ...resolution }) => resolution);
}

function chooseNextBestAction(opts: {
  input: SecretaryOrchestrationInput;
  signals: DerivedDaySignals;
  blockers: BlockerCardModel[];
  suggestedMoves: BlockerResolutionModel[];
  protectedBlocks: ProtectedBlockModel[];
  language: string;
}): NextBestActionModel | null {
  const { input, signals, blockers, suggestedMoves, protectedBlocks, language } = opts;
  const firstMove = suggestedMoves[0] ?? null;
  const focusWindow = protectedBlocks.find((block) => block.type === 'focus')?.windowLabel ?? null;
  const contentWindow = protectedBlocks.find((block) => block.type === 'content')?.windowLabel ?? null;
  const topBlocker = blockers[0] ?? null;

  if (shouldPrioritizeFinanceFirst({ signals, topBlocker })) {
    return {
      kind: 'finance_first',
      title: text(language, 'Fecha o bloco administrativo primeiro.', 'Feche o bloco administrativo primeiro.', 'Handle the admin block first.'),
      summary: text(
        language,
        'É o compromisso mais caro se escorregar para o fim do dia.',
        'É o compromisso mais caro se escorregar para o fim do dia.',
        'It is the most expensive commitment if it slips to the end of the day.',
      ),
      whyNow: input.day.finance?.taxNote ?? input.day.finance?.budgetNote ?? null,
      targetWindow: null,
      urgency: 'today',
      confidence: 'high',
      affectedSkills: dedupeSkills(['finance', 'secretary']),
    };
  }

  if (signals.isTravelDay) {
    return {
      kind: 'portable_day',
      title: text(language, 'Mantém o dia portátil e curto.', 'Mantenha o dia portátil e curto.', 'Keep the day portable and short.'),
      summary: text(
        language,
        'A viagem já dita a capacidade real do dia.',
        'A viagem já dita a capacidade real do dia.',
        'Travel is already dictating the day’s real capacity.',
      ),
      whyNow: blockers.find((blocker) => blocker.kind === 'travel_constraint')?.summary ?? null,
      targetWindow: null,
      urgency: 'today',
      confidence: 'high',
      affectedSkills: dedupeSkills(['secretary', signals.hasTrainingCommitment ? 'training' : null, signals.hasContentWindow ? 'content' : null]),
    };
  }

  if (signals.needsRecoveryProtection) {
    return {
      kind: 'lighten_day',
      title: text(language, 'Mantém o dia leve e recuperável.', 'Mantenha o dia leve e recuperável.', 'Keep the day light and recoverable.'),
      summary: text(
        language,
        'Hoje vale proteger margem em vez de esticar o plano.',
        'Hoje vale proteger margem em vez de esticar o plano.',
        'Today it is worth protecting margin instead of stretching the plan.',
      ),
      whyNow: input.day.training.reason || null,
      targetWindow: null,
      urgency: 'today',
      confidence: 'high',
      affectedSkills: dedupeSkills(['secretary', signals.hasTrainingCommitment ? 'training' : null, signals.hasContentWindow ? 'content' : null]),
    };
  }

  if (topBlocker?.kind === 'deadline_collision' && signals.hasContentWindow) {
    return {
      kind: 'work_content',
      title: contentWindow
        ? text(language, `Revê o bloco de conteúdo em ${contentWindow}.`, `Revise o bloco de conteúdo em ${contentWindow}.`, `Review the Content work block at ${contentWindow}.`)
        : text(language, 'Revê o bloco privado de conteúdo.', 'Revise o bloco privado de conteúdo.', 'Review the private Content work block.'),
      summary: text(
        language,
        'O conflito real envolve uma sessão privada confirmada; a Secretary deve reconciliá-lo sem inferir publicação.',
        'O conflito real envolve uma sessão privada confirmada; o Secretário deve reconciliá-lo sem inferir publicação.',
        'The real collision involves a confirmed private session; Secretary should reconcile it without inferring publication.',
      ),
      whyNow: topBlocker.summary,
      targetWindow: contentWindow,
      urgency: 'today',
      confidence: 'high',
      affectedSkills: dedupeSkills(['content', 'secretary', signals.hasTrainingCommitment ? 'training' : null]),
    };
  }

  if (signals.hasTrainingCommitment && !signals.hasContentWindow) {
    return {
      kind: 'protect_training',
      title: text(language, 'Protege o treino antes do resto.', 'Proteja o treino antes do resto.', 'Protect training before the rest.'),
      summary: text(
        language,
        'É o compromisso de maior custo para mexer ou estragar.',
        'É o compromisso de maior custo para mexer ou estragar.',
        'It is the highest-cost commitment to move or damage.',
      ),
      whyNow: input.day.training.reason || topBlocker?.summary || null,
      targetWindow: null,
      urgency: 'today',
      confidence: topBlocker?.kind === 'deadline_collision' ? 'high' : 'medium',
      affectedSkills: ['training', 'secretary'],
    };
  }

  if (topBlocker?.kind === 'focus_gap' && (signals.hasContentWindow || signals.hasFinancePressure)) {
    return {
      kind: 'protect_focus',
      title: firstMove?.title
        ?? text(language, 'Cria uma janela curta mas real.', 'Crie uma janela curta mas real.', 'Create a short but real focus window.'),
      summary: text(
        language,
        'Sem essa janela, o bloco importante do dia vira sobra entre interrupções.',
        'Sem essa janela, o bloco importante do dia vira sobra entre interrupções.',
        'Without that window, the important block of the day becomes leftover time between interruptions.',
      ),
      whyNow: topBlocker.summary,
      targetWindow: firstMove?.targetWindow ?? contentWindow ?? focusWindow,
      urgency: 'today',
      confidence: 'high',
      affectedSkills: dedupeSkills(topBlocker.affectedSkills),
    };
  }

  if (signals.isCalendarOverloaded && firstMove && topBlocker?.kind === 'calendar_overload') {
    return {
      kind: 'salvage_day',
      title: firstMove.title,
      summary: text(
        language,
        'Primeiro salva o que importa; só depois decides o que mais ainda cabe.',
        'Primeiro salve o que importa; só depois decida o que mais ainda cabe.',
        'Save what matters first; only then decide what else still fits.',
      ),
      whyNow: blockers.find((blocker) => blocker.kind === 'calendar_overload')?.summary ?? null,
      targetWindow: firstMove.targetWindow,
      urgency: 'today',
      confidence: 'high',
      affectedSkills: firstMove.affectedSkills,
    };
  }

  if (signals.hasOverduePressure) {
    return {
      kind: 'batch_overdue',
      title: text(language, 'Agrupa atrasos num bloco curto.', 'Agrupe atrasos num bloco curto.', 'Batch overdue work into one short block.'),
      summary: text(
        language,
        'Isso limpa pressão sem roubar o dia todo.',
        'Isso limpa pressão sem roubar o dia todo.',
        'That clears pressure without stealing the entire day.',
      ),
      whyNow: blockers.find((blocker) => blocker.kind === 'task_pressure')?.summary ?? null,
      targetWindow: null,
      urgency: 'today',
      confidence: 'high',
      affectedSkills: ['secretary'],
    };
  }

  if (signals.hasContentWindow) {
    return {
      kind: 'work_content',
      title: text(language, 'Usa o bloco de conteúdo para o trabalho registado.', 'Use o bloco de conteúdo para o trabalho registrado.', 'Use the Content block for its recorded work.'),
      summary: text(
        language,
        'O bloco privado está confirmado, mas não é uma promessa de publicação ou entrega.',
        'O bloco privado está confirmado, mas não é uma promessa de publicação ou entrega.',
        'The private block is confirmed, but it is not a publication or delivery promise.',
      ),
      whyNow: input.day.content?.note ?? null,
      targetWindow: protectedBlocks.find((block) => block.type === 'content')?.windowLabel ?? null,
      urgency: 'today',
      confidence: signals.hasFocusBlock ? 'high' : 'medium',
      affectedSkills: dedupeSkills(['content', 'secretary', signals.hasTrainingCommitment ? 'training' : null]),
    };
  }

  if (signals.hasFocusBlock) {
    return {
      kind: 'protect_focus',
      title: focusWindow
        ? text(language, `Protege ${focusWindow} para foco.`, `Proteja ${focusWindow} para foco.`, `Protect ${focusWindow} for focus.`)
        : text(language, 'Protege a melhor janela para foco.', 'Proteja a melhor janela para foco.', 'Protect the best window for focus.'),
      summary: text(
        language,
        'É a melhor forma de transformar o dia em trabalho real.',
        'É a melhor forma de transformar o dia em trabalho real.',
        'It is the best way to turn the day into real work.',
      ),
      whyNow: input.day.secretary.focusBlock?.note ?? null,
      targetWindow: focusWindow,
      urgency: 'today',
      confidence: 'medium',
      affectedSkills: signals.activeSkills,
    };
  }

  if (!signals.hasMeaningfulCoordination) {
    return null;
  }

  return {
    kind: 'follow_plan',
    title: text(language, 'Segue a ordem do dia sem abrir novas frentes.', 'Siga a ordem do dia sem abrir novas frentes.', 'Follow the order of the day without opening new fronts.'),
    summary: text(
      language,
      'O sistema não encontrou um reshaping maior do que a disciplina básica.',
      'O sistema não encontrou um reshaping maior do que a disciplina básica.',
      'The system did not find a larger reshaping need beyond basic discipline.',
    ),
    whyNow: input.day.secretary.tradeoffNote ?? null,
    targetWindow: null,
    urgency: 'monitor',
    confidence: 'low',
    affectedSkills: signals.activeSkills,
  };
}

function buildRisks(opts: {
  input: SecretaryOrchestrationInput;
  signals: DerivedDaySignals;
  blockers: BlockerCardModel[];
  nextBestAction: NextBestActionModel | null;
  language: string;
}): RiskAlertModel[] {
  const { input, signals, blockers, nextBestAction, language } = opts;
  const risks: RiskAlertModel[] = [];

  if (blockers.length >= 2 && signals.activeSkills.length >= 2) {
    risks.push({
      id: `risk:context-switch:${input.date}`,
      level: 'high',
      title: text(language, 'Há demasiadas frentes abertas ao mesmo tempo.', 'Há frentes abertas demais ao mesmo tempo.', 'Too many fronts are open at the same time.'),
      summary: text(
        language,
        'Se não definires uma ordem dura, o dia dispersa-se em contexto a mais.',
        'Se não definir uma ordem dura, o dia se dispersa em contexto demais.',
        'Without a hard order, the day will dissolve into too much context switching.',
      ),
    });
  }

  if (!signals.hasWritableCalendar && (signals.isCalendarOverloaded || signals.isTravelDay)) {
    risks.push({
      id: `risk:manual-reschedule:${input.date}`,
      level: 'medium',
      title: text(language, 'Não há escrita automática no calendário.', 'Não há escrita automática no calendário.', 'Automatic calendar writes are not available.'),
      summary: text(
        language,
        'Qualquer mudança terá de ser aplicada manualmente depois da decisão.',
        'Qualquer mudança terá de ser aplicada manualmente depois da decisão.',
        'Any reschedule will need to be applied manually after the decision.',
      ),
    });
  }

  if (!signals.hasFocusBlock && nextBestAction?.kind !== 'portable_day' && nextBestAction?.kind !== 'lighten_day') {
    risks.push({
      id: `risk:leftover-work:${input.date}`,
      level: 'medium',
      title: text(language, 'O trabalho importante pode virar sobra.', 'O trabalho importante pode virar sobra.', 'Important work may become leftover time.'),
      summary: text(
        language,
        'Sem uma janela protegida, o que importa hoje fica mais frágil do que parece.',
        'Sem uma janela protegida, o que importa hoje fica mais frágil do que parece.',
        'Without a protected window, what matters today is more fragile than it looks.',
      ),
    });
  }

  return risks;
}

function resolveConfidence(opts: {
  signals: DerivedDaySignals;
  blockers: BlockerCardModel[];
  nextBestAction: NextBestActionModel | null;
}): PlanConfidence {
  if (opts.nextBestAction && (opts.blockers.length > 0 || opts.signals.hasFocusBlock || opts.signals.hasFinancePressure)) {
    return 'high';
  }
  if (opts.blockers.length > 0 || opts.signals.hasMeaningfulCoordination) {
    return 'medium';
  }
  return 'low';
}

function selectDayPosture(signals: DerivedDaySignals): SecretaryExecutionMode {
  if (signals.isTravelDay) return 'reactive_day';
  if (signals.needsRecoveryProtection) return 'recovery_protected_day';
  if (signals.isCalendarOverloaded && (signals.hasHighTaskPressure || signals.hasContentWindow || signals.hasTrainingCommitment)) {
    return 'meeting_salvage_day';
  }
  if (signals.hasFinancePressure && !signals.hasFocusBlock) return 'admin_consolidation_day';
  if (signals.hasFocusBlock && signals.hasContentWindow && !signals.isCalendarOverloaded) return 'high_output_day';
  if (signals.hasFocusBlock && !signals.isCalendarOverloaded) return 'deep_work_day';
  if (signals.hasHighTaskPressure || signals.isCalendarOverloaded) return 'reactive_day';
  return 'stable_day';
}

function selectWeekPosture(input: SecretaryOrchestrationInput, signals: DerivedDaySignals): SecretaryWeeklyMode {
  const days = input.weekPlan.days;
  const travelDays = days.filter((day) => day.secretary.travel).length;
  const busyDays = days.filter((day) => day.secretary.busy).length;
  const recoveryDays = days.filter((day) => trainingNeedsRecovery(day)).length;
  const contentDays = days.filter((day) => isConfirmedPrivateContentBlock(day.content)).length;
  const financeDays = days.filter((day) => hasMeaningfulFinancePressure(day.finance)).length;

  if (travelDays > 0) return 'travel_logistics';
  if (recoveryDays >= 2 || input.weekPlan.variant === 'conservative') {
    return recoveryDays >= 2 ? 'recovery' : 'consistency';
  }
  if (input.weekPlan.conflicts.length >= 2 || busyDays >= 2 || financeDays >= 2) return 'deadline_pressure';
  if (contentDays >= 2 || input.weekPlan.variant === 'push') return 'output';
  if (signals.needsRecoveryProtection) return 'consistency';
  return 'stable';
}

function dayReasons(input: SecretaryOrchestrationInput, signals: DerivedDaySignals, language: string): string[] {
  return dedupeStrings([
    signals.isTravelDay
      ? text(language, 'A viagem já define a capacidade real do dia.', 'A viagem já define a capacidade real do dia.', 'Travel is already defining the day’s real capacity.')
      : null,
    signals.needsRecoveryProtection
      ? text(language, 'A recuperação pede menos atrito do que o plano ideal.', 'A recuperação pede menos atrito do que o plano ideal.', 'Recovery is asking for less friction than the ideal plan.')
      : null,
    signals.isCalendarOverloaded
      ? text(language, 'O calendário está mais apertado do que o trabalho importante pede.', 'O calendário está mais apertado do que o trabalho importante pede.', 'The calendar is tighter than the important work needs.')
      : null,
    signals.hasHighTaskPressure
      ? text(language, 'Há pressão de tarefas suficiente para contaminar a execução.', 'Há pressão de tarefas suficiente para contaminar a execução.', 'There is enough task pressure to contaminate execution.')
      : null,
    signals.hasContentWindow
      ? text(language, 'Existe uma janela útil de conteúdo que vale mesmo a pena proteger.', 'Existe uma janela útil de conteúdo que vale mesmo a pena proteger.', 'There is a useful content window worth protecting.')
      : null,
    signals.hasFinancePressure
      ? text(language, 'Há uma pendência administrativa real a pedir um slot fiável.', 'Há uma pendência administrativa real pedindo um slot confiável.', 'A real admin obligation is asking for a reliable slot.')
      : null,
    input.day.secretary.tradeoffNote,
  ]).slice(0, 4);
}

function weekReasons(input: SecretaryOrchestrationInput, signals: DerivedDaySignals, language: string): string[] {
  const days = input.weekPlan.days;
  const busyDays = days.filter((day) => day.secretary.busy).length;
  const recoveryDays = days.filter((day) => trainingNeedsRecovery(day)).length;
  const contentDays = days.filter((day) => isConfirmedPrivateContentBlock(day.content)).length;

  return dedupeStrings([
    busyDays >= 2
      ? text(language, `Há ${busyDays} dias já comprimidos pela agenda.`, `Há ${busyDays} dias já comprimidos pela agenda.`, `${busyDays} days are already compressed by the calendar.`)
      : null,
    recoveryDays >= 2
      ? text(language, `Treino ou recuperação estão a condicionar ${recoveryDays} dias desta semana.`, `Treino ou recuperação estão condicionando ${recoveryDays} dias desta semana.`, `Training or recovery is shaping ${recoveryDays} days this week.`)
      : null,
    contentDays >= 2
      ? text(language, `Há ${contentDays} janelas de conteúdo com valor real esta semana.`, `Há ${contentDays} janelas de conteúdo com valor real esta semana.`, `${contentDays} content windows have real value this week.`)
      : null,
    input.weekPlan.conflicts.length > 0
      ? text(language, 'Já existem conflitos suficientes para a sequência da semana importar.', 'Já existem conflitos suficientes para a sequência da semana importar.', 'There are already enough conflicts for sequencing to matter this week.')
      : null,
    signals.hasFinancePressure
      ? text(language, 'A pressão administrativa desta semana não deve ser deixada para o fim.', 'A pressão administrativa desta semana não deve ser deixada para o fim.', 'This week’s admin pressure should not be left to the end.')
      : null,
  ]).slice(0, 4);
}

function resolveAvailableSkills(day: WeeklyPlanDay): SecretarySkillId[] {
  return dedupeSkills([
    'secretary',
    day.training.status !== 'gated' && (hasText(day.training.title) || hasText(day.training.reason)) ? 'training' : null,
    day.content ? 'content' : null,
    day.meals.length > 0 ? 'cooking' : null,
    day.finance ? 'finance' : null,
  ]);
}

function trainingNeedsRecovery(day: WeeklyPlanDay): boolean {
  if (day.training.status === 'adjusted' || day.training.status === 'rest') return true;
  const textBlob = [day.training.title, day.training.reason].filter(Boolean).join(' ');
  return /\b(recovery|recover|rest|conservative|easy|lighter|recupera|descanso|leve|conservador)\b/i.test(textBlob);
}

function hasMeaningfulFinancePressure(dayFinance: WeeklyPlanDay['finance'] | null | undefined): boolean {
  const notes = [dayFinance?.budgetNote, dayFinance?.taxNote, dayFinance?.subscriptionNote]
    .filter((value): value is string => hasText(value));
  if (notes.length === 0) return false;

  const joined = notes.join(' ');
  const hardPressure = /\b(tax|invoice|payment|subscription|renew|renews|due|pending|tight|headroom is tight|admin needs|finance\/admin needs|imposto|fatura|pagamento|assinatura|renova|vence|pendente|apertad|press[aã]o administrativa)\b/i.test(joined);
  const softContextOnly = /\b(controlled|under control|stable|lean|selective|mode is controlled|sob controle|estável|controlad[oa]|seletiv[oa])\b/i.test(joined);

  if (hardPressure) return true;
  if (softContextOnly) return false;
  return /\b(finance|admin|budget|orçamento|finanças|administra)\b/i.test(joined);
}

function shouldPrioritizeFinanceFirst(opts: {
  signals: DerivedDaySignals;
  topBlocker: BlockerCardModel | null;
}): boolean {
  const { signals, topBlocker } = opts;
  if (!signals.hasFinancePressure) return false;

  // Finance should not trump the cases where the day is already constrained by
  // travel, recovery, or a genuine conflict involving a confirmed private work block.
  if (signals.isTravelDay || signals.needsRecoveryProtection) return false;
  if (topBlocker?.kind === 'deadline_collision' && signals.hasContentWindow) return false;

  return true;
}

function dedupeSkills(values: Array<SecretarySkillId | null | undefined>): SecretarySkillId[] {
  const seen = new Set<SecretarySkillId>();
  const result: SecretarySkillId[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0)))];
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function hasText(value?: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function firstText(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (hasText(value)) return value.trim();
  }
  return null;
}

function formatWindow(startIso?: string | null, endIso?: string | null): string | null {
  if (!hasText(startIso) || !hasText(endIso)) return null;
  const zone = config.app.timezone || 'Europe/Lisbon';
  const start = DateTime.fromISO(startIso, { zone }).setZone(zone);
  const end = DateTime.fromISO(endIso, { zone }).setZone(zone);
  if (!start.isValid || !end.isValid) return null;
  return `${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}`;
}

function skillLabel(skill: SecretarySkillId, language: string): string {
  switch (skill) {
    case 'training':
      return text(language, 'Treino', 'Treino', 'Training');
    case 'content':
      return text(language, 'Conteúdo', 'Conteúdo', 'Content');
    case 'cooking':
      return text(language, 'Cozinha', 'Cozinha', 'Cooking');
    case 'finance':
      return text(language, 'Finanças', 'Finanças', 'Finance');
    case 'secretary':
    default:
      return text(language, 'Secretária', 'Secretária', 'Secretary');
  }
}

function normalizeLanguage(language?: string): string {
  if (typeof language !== 'string' || language.trim().length === 0) return 'en';
  return language.trim().toLowerCase();
}

function text(language: string, ptPt: string, ptBr: string, en: string): string {
  if (language.startsWith('pt-br')) return ptBr;
  if (language.startsWith('pt')) return ptPt;
  return en;
}
