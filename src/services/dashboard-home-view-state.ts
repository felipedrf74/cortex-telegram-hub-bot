// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ScreenContractMeta } from './screen-contract-meta';
import { buildScreenContractMeta } from './screen-contract-meta';
import type { Lang } from '../utils/i18n';

export type HomeDayStateKind =
  | 'calm'
  | 'overloaded'
  | 'competingPriorities'
  | 'crossSkillConflict'
  | 'recoveryProtected'
  | 'highPerformance'
  | 'noNextAction'
  | 'planComplete';

export type HomeActionTarget =
  | 'dayPlan'
  | 'tasks'
  | 'training'
  | 'contentRadar'
  | 'cooking'
  | 'finance'
  | 'inbox'
  | 'connections'
  | `skill:${string}`;

export type HomeActionPriority = 'primary' | 'secondary' | 'quiet';
export type HomeSemanticTint =
  | 'accent'
  | 'secretary'
  | 'training'
  | 'content'
  | 'cooking'
  | 'finance'
  | 'success'
  | 'warning'
  | 'error'
  | 'info';

export type HomeImpactDomain = 'secretary' | 'training' | 'cooking' | 'content' | 'finance';

export interface HomeActionModel {
  id: string;
  title: string;
  subtitle: string | null;
  icon: string;
  tint: HomeSemanticTint;
  target: HomeActionTarget;
  priority: HomeActionPriority;
}

export interface DailyStateHeroModel {
  state: HomeDayStateKind;
  eyebrow: string;
  title: string;
  summary: string;
  whyNow: string | null;
  readinessText: string;
  energyText: string;
  confidenceText: string | null;
  primaryAction: HomeActionModel;
  secondaryAction: HomeActionModel | null;
}

export interface QuickMetricModel {
  id: string;
  value: string;
  label: string;
  icon: string;
  tint: HomeSemanticTint;
  target: HomeActionTarget;
}

export interface HomeInsightModel {
  id: string;
  title: string;
  summary: string;
  icon: string;
  tint: HomeSemanticTint;
  target: HomeActionTarget;
}

export interface SecretaryPreviewItemModel {
  id: string;
  time: string;
  title: string;
  source: string | null;
  isNow: boolean;
  isPast: boolean;
}

export interface SecretaryPreviewModel {
  summary: string;
  items: SecretaryPreviewItemModel[];
  primaryAction: HomeActionModel;
}

export interface CrossSkillImpactModel {
  id: string;
  domain: HomeImpactDomain;
  label: string;
  detail: string;
}

export interface CoordinatedDecisionModel {
  stateLabel: string;
  title: string;
  summary: string;
  confidenceText: string | null;
  reasonTitle: string;
  reason: string;
  protectedTitle: string | null;
  protectedLater: string | null;
  impacts: CrossSkillImpactModel[];
  primaryAction: HomeActionModel;
  secondaryAction: HomeActionModel | null;
}

export interface SkillQueueItemModel {
  id: string;
  domain: HomeImpactDomain;
  stateLabel: string;
  headline: string;
  summary: string | null;
  whyNow: string | null;
  confidenceText: string | null;
  blockedReason: string | null;
  action: HomeActionModel;
  urgency: 'calm' | 'active' | 'watch';
}

export interface HomeViewState {
  meta: ScreenContractMeta;
  hero: DailyStateHeroModel;
  insights: HomeInsightModel[];
  metrics: QuickMetricModel[];
  quickActions: HomeActionModel[];
  secretaryPreview: SecretaryPreviewModel;
  coordinatedDecision: CoordinatedDecisionModel | null;
  skillQueue: SkillQueueItemModel[];
}

export interface DashboardHomeOrchestrationSummary {
  headline: string;
  detail: string;
  protectedLater: string | null;
  impacts: Array<{
    id: string;
    domain: HomeImpactDomain;
    detail: string;
  }>;
  watchouts: string[];
}

export interface DashboardHomeBuildInput {
  readinessScore: number | null;
  bodyBattery: number | null;
  tasksDue: number;
  overdueTasks: number;
  eventsCount: number;
  nextEventTitle: string | null;
  nextEventTime: string | null;
  nextEventSource: string | null;
  hasCalendarUnavailable: boolean;
  trainingTitle: string | null;
  trainingTime: string | null;
  trainingDurationMinutes: number | null;
  trainingStatus: 'ready' | 'degraded' | 'unavailable';
  contentHeadline: string;
  contentSubline: string | null;
  cookingHeadline: string;
  cookingSubline: string | null;
  financeHeadline: string;
  financeSubline: string | null;
  orchestrationSummary: DashboardHomeOrchestrationSummary | null;
  warningMessages: string[];
  secretaryItems: SecretaryPreviewItemModel[];
  secretarySummary: string;
  meta?: ScreenContractMeta | null;
}

export function buildDashboardHomeViewState(
  input: DashboardHomeBuildInput,
  language: Lang,
): HomeViewState {
  const state = classify(input);
  const hero = buildHero(state, input, language);
  const insights = buildInsights(state, input, language);
  const metrics = buildMetrics(input, language);
  const quickActions = buildQuickActions(state, input, language);
  const secretaryPreview: SecretaryPreviewModel = {
    summary: input.secretarySummary,
    items: input.secretaryItems.slice(0, 3),
    primaryAction: action(
      'secretary-day-plan',
      localizePT(language, 'Abrir plano do dia', 'Open day plan'),
      localizePT(language, 'Ver a agenda coordenada', 'See the coordinated schedule'),
      'calendar.badge.clock',
      'secretary',
      'dayPlan',
      'secondary',
    ),
  };
  const coordinatedDecision = buildDecision(state, input, language);
  const skillQueue = buildSkillQueue(state, input, language);

  return {
    meta: input.meta ?? inferDashboardContractMeta(input),
    hero,
    insights,
    metrics,
    quickActions,
    secretaryPreview,
    coordinatedDecision,
    skillQueue,
  };
}

function inferDashboardContractMeta(input: DashboardHomeBuildInput): ScreenContractMeta {
  const reasonCodes = [
    ...(input.hasCalendarUnavailable ? ['CALENDAR_UNAVAILABLE'] : []),
    ...(input.trainingStatus === 'degraded' ? ['TRAINING_DEGRADED'] : []),
    ...(input.trainingStatus === 'unavailable' ? ['TRAINING_UNAVAILABLE'] : []),
    ...(input.warningMessages.length > 0 ? ['HAS_WARNINGS'] : []),
  ];
  return buildScreenContractMeta({
    source: 'server',
    isFallback: reasonCodes.length > 0,
    isPartial: reasonCodes.length > 0,
    isStale: false,
    reasonCodes,
  });
}

function buildInsights(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): HomeInsightModel[] {
  const insights: HomeInsightModel[] = [];

  if (input.warningMessages.length > 0) {
    pushInsightIfDistinct(insights, {
      id: 'sync-attention',
      title: localizePT(language, 'Sincronização precisa de atenção', 'Sync needs attention'),
      summary: input.warningMessages[0]!,
      icon: 'exclamationmark.circle.fill',
      tint: 'warning',
      target: 'connections',
    });
  }

  const watchout = input.orchestrationSummary?.watchouts?.[0] ?? null;
  if (watchout) {
    pushInsightIfDistinct(insights, {
      id: 'watchout',
      title: localizePT(language, 'Presta atenção', 'Pay attention'),
      summary: watchout,
      icon: 'eye.trianglebadge.exclamationmark',
      tint: state === 'highPerformance' ? 'info' : 'warning',
      target: state === 'recoveryProtected' ? 'training' : 'dayPlan',
    });
  }

  if (insights.length === 0 && state === 'overloaded' && input.overdueTasks > 0) {
    pushInsightIfDistinct(insights, {
      id: 'task-pressure',
      title: localizePT(language, 'Há bloqueios para destravar', 'There are blockers to clear'),
      summary: quantifiedLabel(
        input.overdueTasks,
        language,
        'tarefa em atraso a travar o resto do dia',
        'tarefas em atraso a travar o resto do dia',
        'overdue task is blocking the rest of the day',
        'overdue tasks are blocking the rest of the day',
      ),
      icon: 'checklist.checked',
      tint: 'accent',
      target: 'tasks',
    });
  }

  if (insights.length === 0 && state === 'highPerformance' && input.nextEventTitle && input.nextEventTime) {
    pushInsightIfDistinct(insights, {
      id: 'protected-window',
      title: localizePT(language, 'Janela protegida', 'Protected window'),
      summary: localizePT(
        language,
        `${input.nextEventTitle} começa às ${input.nextEventTime}.`,
        `${input.nextEventTitle} starts at ${input.nextEventTime}.`,
      ),
      icon: 'flag.checkered.2.crossed',
      tint: 'training',
      target: 'dayPlan',
    });
  }

  return insights.slice(0, 2);
}

function pushInsightIfDistinct(insights: HomeInsightModel[], candidate: HomeInsightModel): void {
  const normalizedCandidate = normalizeInsightSummary(candidate.summary);
  const alreadyExists = insights.some((insight) => normalizeInsightSummary(insight.summary) === normalizedCandidate);
  if (alreadyExists) return;
  insights.push(candidate);
}

function classify(input: DashboardHomeBuildInput): HomeDayStateKind {
  const readiness = input.readinessScore ?? 0;
  const battery = input.bodyBattery ?? 0;
  const hasTraining = Boolean((input.trainingTitle ?? '').trim());
  const hasEvent = Boolean((input.nextEventTitle ?? '').trim());
  const hasWork = input.tasksDue + input.overdueTasks > 0;
  const summaryText = [input.orchestrationSummary?.headline, input.orchestrationSummary?.detail]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase();
  const hasCrossSkillPressure = hasTraining
    && input.overdueTasks > 0
    && input.eventsCount >= 4
    && (input.orchestrationSummary?.impacts.length ?? 0) >= 2;

  if (!hasTraining && !hasEvent && !hasWork) return 'noNextAction';
  if (hasCrossSkillPressure && (summaryText.includes('recuper') || summaryText.includes('margem') || readiness < 65 || battery < 45)) {
    return 'crossSkillConflict';
  }
  if (hasCrossSkillPressure) return 'competingPriorities';
  if (input.overdueTasks >= 2 || input.eventsCount >= 6) return 'overloaded';
  if (summaryText.includes('recuper') || summaryText.includes('margem') || readiness < 65 || battery < 45) {
    return 'recoveryProtected';
  }
  if (readiness >= 82 && battery >= 70 && hasTraining && input.overdueTasks === 0) {
    return 'highPerformance';
  }
  if (input.tasksDue === 0 && input.overdueTasks === 0 && input.eventsCount <= 1 && hasTraining) {
    return 'planComplete';
  }
  return 'calm';
}

function buildHero(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): DailyStateHeroModel {
  const readinessText = input.readinessScore == null ? '—' : String(input.readinessScore);
  const energyText = input.bodyBattery == null ? '—' : `${input.bodyBattery}%`;
  const confidenceText = input.orchestrationSummary
    ? localizePT(language, 'Coordenação ativa', 'Active coordination')
    : null;

  let title: string;
  let summary: string;
  let whyNow: string | null;
  let primaryAction: HomeActionModel;
  let secondaryAction: HomeActionModel | null;

  switch (state) {
    case 'competingPriorities':
      title = localizePT(language, 'Hoje pede arbitragem', 'Today needs arbitration');
      summary = localizePT(
        language,
        'Há mais do que uma prioridade legítima a competir. O melhor passo agora é decidir a ordem sem dispersar o dia.',
        'There is more than one legitimate priority competing. The best move now is deciding the order without scattering the day.',
      );
      whyNow = input.orchestrationSummary?.detail
        ?? localizePT(language, 'Treino, agenda e execução estão a puxar ao mesmo tempo.', 'Training, schedule, and execution are pulling at the same time.');
      primaryAction = action(
        'hero-primary-plan',
        localizePT(language, 'Ver plano coordenado', 'See coordinated plan'),
        null,
        'square.grid.2x2',
        'accent',
        'dayPlan',
        'primary',
      );
      secondaryAction = action(
        'hero-secondary-tasks',
        localizePT(language, 'Atacar próxima tarefa', 'Attack next task'),
        null,
        'checkmark.circle',
        'secretary',
        'tasks',
        'secondary',
      );
      break;
    case 'crossSkillConflict':
      title = localizePT(language, 'Hoje pede proteção cruzada', 'Today needs cross-skill protection');
      summary = localizePT(
        language,
        'Há conflito real entre carga, agenda e trabalho. Vamos proteger o que importa sem deixar o dia partir em duas direções.',
        'There is a real conflict between load, schedule, and work. Let’s protect what matters without splitting the day in two directions.',
      );
      whyNow = input.orchestrationSummary?.detail
        ?? localizePT(language, 'Os sinais do dia já não suportam empurrar todas as frentes ao mesmo tempo.', 'Today’s signals no longer support pushing every front at once.');
      primaryAction = action(
        'hero-primary-training',
        localizePT(language, 'Ver ajuste do treino', 'See training adjustment'),
        input.trainingTitle,
        'figure.run',
        'training',
        'training',
        'primary',
      );
      secondaryAction = action(
        'hero-secondary-plan',
        localizePT(language, 'Abrir plano do dia', 'Open day plan'),
        null,
        'calendar.badge.clock',
        'secretary',
        'dayPlan',
        'secondary',
      );
      break;
    case 'overloaded':
      title = localizePT(language, 'Hoje pede triagem', 'Today needs triage');
      summary = localizePT(
        language,
        'Há pressão real entre agenda e trabalho. Vamos atacar o que destrava o resto do dia.',
        'There’s real pressure across schedule and work. Let’s clear what unlocks the rest of the day.',
      );
      whyNow = input.overdueTasks > 0
        ? localizePT(language, 'Há tarefas em atraso a puxar prioridade.', 'Overdue tasks are pulling priority.')
        : localizePT(language, 'A agenda já começou densa para hoje.', 'The day already started dense.');
      primaryAction = action(
        'hero-primary-tasks',
        localizePT(language, 'Atacar próxima tarefa', 'Attack next task'),
        localizePT(language, 'Focar no que destrava o dia', 'Focus on what unlocks the day'),
        'checkmark.circle',
        'accent',
        'tasks',
        'primary',
      );
      secondaryAction = action(
        'hero-secondary-plan',
        localizePT(language, 'Ver plano do dia', 'See day plan'),
        null,
        'calendar.badge.clock',
        'secretary',
        'dayPlan',
        'secondary',
      );
      break;
    case 'recoveryProtected':
      title = localizePT(language, 'Hoje pede margem', 'Today needs margin');
      summary = localizePT(
        language,
        'A coordenação está a proteger consistência e recuperação antes de empurrar carga.',
        'Coordination is protecting consistency and recovery before pushing load.',
      );
      whyNow = input.orchestrationSummary?.detail
        ?? localizePT(language, 'Os sinais do dia pedem menos atrito.', 'Today’s signals call for less friction.');
      primaryAction = action(
        'hero-primary-training',
        localizePT(language, 'Ver ajuste do treino', 'See training adjustment'),
        input.trainingTitle,
        'figure.run',
        'training',
        'training',
        'primary',
      );
      secondaryAction = action(
        'hero-secondary-plan',
        localizePT(language, 'Abrir plano do dia', 'Open day plan'),
        null,
        'calendar.badge.clock',
        'secretary',
        'dayPlan',
        'secondary',
      );
      break;
    case 'highPerformance':
      title = localizePT(language, 'Hoje está pronto para render', 'Today is ready to perform');
      summary = localizePT(
        language,
        'Energia, treino e agenda estão alinhados para executar bem sem dispersão.',
        'Energy, training, and schedule are aligned for strong execution without drift.',
      );
      whyNow = input.nextEventTitle
        ? localizePT(language, 'O próximo bloco já está definido e protegido.', 'The next block is already defined and protected.')
        : input.orchestrationSummary?.detail ?? null;
      primaryAction = action(
        'hero-primary-train',
        localizePT(language, 'Entrar na sessão', 'Open session'),
        input.trainingTitle,
        'bolt.heart.fill',
        'training',
        'training',
        'primary',
      );
      secondaryAction = action(
        'hero-secondary-plan',
        localizePT(language, 'Ver plano coordenado', 'See coordinated plan'),
        null,
        'square.grid.2x2',
        'secretary',
        'dayPlan',
        'secondary',
      );
      break;
    case 'noNextAction':
      title = localizePT(language, 'Hoje está em aberto', 'Today is open');
      summary = localizePT(
        language,
        'Não há uma próxima ação dominante. É uma boa janela para decidir o que avançar a seguir.',
        'There is no dominant next action. It’s a good window to decide what to advance next.',
      );
      whyNow = localizePT(
        language,
        'O sistema não detectou pressão forte entre tarefas, treino ou agenda.',
        'The system didn’t detect strong pressure across tasks, training, or schedule.',
      );
      primaryAction = action(
        'hero-primary-content',
        localizePT(language, 'Encontrar próximo tema', 'Find next topic'),
        input.contentHeadline,
        'sparkles',
        'content',
        'contentRadar',
        'primary',
      );
      secondaryAction = action(
        'hero-secondary-task',
        localizePT(language, 'Abrir tarefas', 'Open tasks'),
        null,
        'checklist',
        'accent',
        'tasks',
        'secondary',
      );
      break;
    case 'planComplete':
      title = localizePT(language, 'Hoje já está alinhado', 'Today is already aligned');
      summary = localizePT(
        language,
        'O essencial do dia já está coordenado. Agora é mais sobre execução limpa do que sobre replaneamento.',
        'The core of the day is already coordinated. Now it’s more about clean execution than replanning.',
      );
      whyNow = input.orchestrationSummary?.headline ?? null;
      primaryAction = action(
        'hero-primary-plan',
        localizePT(language, 'Ver próximo passo', 'See next step'),
        input.nextEventTitle ?? input.trainingTitle,
        'arrow.right.circle.fill',
        'accent',
        'dayPlan',
        'primary',
      );
      secondaryAction = action(
        'hero-secondary-training',
        localizePT(language, 'Abrir treino', 'Open training'),
        null,
        'figure.run',
        'training',
        'training',
        'secondary',
      );
      break;
    case 'calm':
    default:
      title = localizePT(language, 'Hoje está controlado', 'Today feels under control');
      summary = localizePT(
        language,
        'O dia está estável, com margem para cumprir o plano sem pressa nem ruído excessivo.',
        'The day is stable, with enough margin to follow the plan without rush or noise.',
      );
      whyNow = input.orchestrationSummary?.detail ?? input.nextEventTitle ?? null;
      primaryAction = action(
        'hero-primary-next-step',
        localizePT(language, 'Ver próximo passo', 'See next step'),
        input.nextEventTitle ?? input.trainingTitle,
        'arrow.right.circle.fill',
        'accent',
        'dayPlan',
        'primary',
      );
      secondaryAction = action(
        'hero-secondary-task',
        localizePT(language, 'Atacar próxima tarefa', 'Attack next task'),
        null,
        'checkmark.circle',
        'secretary',
        'tasks',
        'secondary',
      );
      break;
  }

  return {
    state,
    eyebrow: localizePT(language, 'Estado do dia', 'Day state'),
    title,
    summary,
    whyNow,
    readinessText,
    energyText,
    confidenceText,
    primaryAction,
    secondaryAction,
  };
}

function buildMetrics(input: DashboardHomeBuildInput, language: Lang): QuickMetricModel[] {
  return [
    {
      id: 'tasks',
      value: String(input.tasksDue + input.overdueTasks),
      label: localizePT(language, 'Tarefas', 'Tasks'),
      icon: 'checkmark.circle',
      tint: input.overdueTasks > 0 ? 'error' : 'accent',
      target: 'tasks',
    },
    {
      id: 'readiness',
      value: input.readinessScore == null ? '—' : String(input.readinessScore),
      label: localizePT(language, 'Prontidão', 'Readiness'),
      icon: 'heart.fill',
      tint: 'warning',
      target: 'training',
    },
    {
      id: 'energy',
      value: input.bodyBattery == null ? '—' : `${input.bodyBattery}%`,
      label: localizePT(language, 'Bateria', 'Body Battery'),
      icon: 'battery.75percent',
      tint: 'secretary',
      target: 'training',
    },
    {
      id: 'events',
      value: input.hasCalendarUnavailable ? '—' : String(input.eventsCount),
      label: localizePT(language, 'Eventos', 'Events'),
      icon: 'calendar',
      tint: input.hasCalendarUnavailable ? 'warning' : 'secretary',
      target: input.hasCalendarUnavailable ? 'connections' : 'dayPlan',
    },
  ];
}

function buildQuickActions(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): HomeActionModel[] {
  const actions: HomeActionModel[] = [];

  if (input.overdueTasks > 0) {
    actions.push(action(
      'quick-tasks',
      localizePT(language, 'Atacar atrasos', 'Clear overdue'),
      localizePT(language, `${input.overdueTasks} tarefas a pedir decisão`, `${input.overdueTasks} tasks need a decision`),
      'checkmark.circle',
      'accent',
      'tasks',
      'primary',
    ));
  }

  if (input.trainingTitle?.trim()) {
    actions.push(action(
      'quick-training',
      state === 'recoveryProtected'
        ? localizePT(language, 'Ver ajuste do treino', 'See training adjustment')
        : localizePT(language, 'Abrir treino', 'Open training'),
      input.trainingTitle,
      'figure.run',
      'training',
      'training',
      'secondary',
    ));
  }

  actions.push(action(
    'quick-plan',
    localizePT(language, 'Abrir plano do dia', 'Open day plan'),
    input.nextEventTitle ?? localizePT(language, 'Ver a agenda coordenada', 'See the coordinated schedule'),
    'calendar.badge.clock',
    'secretary',
    'dayPlan',
    'secondary',
  ));

  const contentHeadlineLower = input.contentHeadline.toLowerCase();
  if (contentHeadlineLower.includes('ideia') || contentHeadlineLower.includes('idea')) {
    actions.push(action(
      'quick-content',
      localizePT(language, 'Encontrar próximo tema', 'Find next topic'),
      input.contentSubline,
      'sparkles',
      'content',
      'contentRadar',
      'quiet',
    ));
  } else if (input.cookingHeadline.trim()) {
    actions.push(action(
      'quick-cooking',
      localizePT(language, 'Ver refeição alinhada', 'See aligned meal'),
      input.cookingHeadline,
      'fork.knife',
      'cooking',
      'cooking',
      'quiet',
    ));
  }

  return actions.slice(0, 4).map((item, index) => ({ ...item, id: `${item.id}-${index}` }));
}

function buildDecision(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): CoordinatedDecisionModel | null {
  const summary = input.orchestrationSummary;
  if (!summary) return null;

  return {
    stateLabel: coordinatedStateLabel(state, language),
    title: localizePT(language, 'Coordenação do dia', 'Daily coordination'),
    summary: summary.headline,
    confidenceText: coordinatedConfidenceText(state, summary, language),
    reasonTitle: localizePT(language, 'Porque', 'Why'),
    reason: summary.detail,
    protectedTitle: summary.protectedLater
      ? localizePT(language, 'O que isto protege', 'What this protects')
      : null,
    protectedLater: summary.protectedLater ?? null,
    impacts: summary.impacts.map((impact) => ({
      id: impact.id,
      domain: impact.domain,
      label: domainLabel(impact.domain, language),
      detail: impact.detail,
    })),
    primaryAction: action(
      'coordination-primary',
      localizePT(language, 'Ver plano coordenado', 'See coordinated plan'),
      null,
      'square.grid.2x2',
      'accent',
      'dayPlan',
      'primary',
    ),
    secondaryAction: action(
      'coordination-secondary',
      localizePT(language, 'Abrir treino', 'Open training'),
      null,
      'figure.run',
      'training',
      'training',
      'secondary',
    ),
  };
}

function buildSkillQueue(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): SkillQueueItemModel[] {
  return [
    {
      id: 'training',
      domain: 'training',
      stateLabel: state === 'recoveryProtected'
        ? localizePT(language, 'ajustado hoje', 'adjusted today')
        : localizePT(language, 'próxima sessão', 'next session'),
      headline: input.trainingTitle ?? localizePT(language, 'Sem sessão definida', 'No session defined'),
      summary: input.trainingTime ? `${input.trainingTime} · ${input.trainingDurationMinutes ?? 0} min` : null,
      whyNow: trainingWhyNow(state, input, language),
      confidenceText: trainingConfidenceText(state, input, language),
      blockedReason: trainingBlockedReason(input, language),
      action: action(
        'queue-training',
        localizePT(language, 'Ver sessão', 'See session'),
        null,
        'figure.run',
        'training',
        'training',
        'secondary',
      ),
      urgency: state === 'highPerformance' ? 'active' : (state === 'recoveryProtected' ? 'watch' : 'calm'),
    },
    {
      id: 'content',
      domain: 'content',
      stateLabel: localizePT(language, 'próximo passo', 'next move'),
      headline: input.contentHeadline,
      summary: input.contentSubline,
      whyNow: contentWhyNow(input, language),
      confidenceText: contentConfidenceText(input, language),
      blockedReason: contentBlockedReason(input, language),
      action: action(
        'queue-content',
        localizePT(language, 'Abrir radar', 'Open radar'),
        null,
        'sparkles',
        'content',
        'contentRadar',
        'secondary',
      ),
      urgency: input.contentHeadline.toLowerCase().includes('nenhuma') ? 'watch' : 'calm',
    },
    {
      id: 'cooking',
      domain: 'cooking',
      stateLabel: localizePT(language, 'alinhado ao dia', 'aligned to today'),
      headline: input.cookingHeadline,
      summary: input.cookingSubline,
      whyNow: cookingWhyNow(state, input, language),
      confidenceText: cookingConfidenceText(state, input, language),
      blockedReason: cookingBlockedReason(input, language),
      action: action(
        'queue-cooking',
        localizePT(language, 'Ver refeição', 'See meal'),
        null,
        'fork.knife',
        'cooking',
        'cooking',
        'secondary',
      ),
      urgency: state === 'recoveryProtected' ? 'active' : 'calm',
    },
    {
      id: 'finance',
      domain: 'finance',
      stateLabel: localizePT(language, 'pressão do mês', 'month pressure'),
      headline: input.financeHeadline,
      summary: input.financeSubline,
      whyNow: financeWhyNow(input, language),
      confidenceText: financeConfidenceText(input, language),
      blockedReason: financeBlockedReason(input, language),
      action: action(
        'queue-finance',
        localizePT(language, 'Abrir finanças', 'Open finance'),
        null,
        'chart.line.uptrend.xyaxis',
        'finance',
        'finance',
        'secondary',
      ),
      urgency: input.financeHeadline.includes('—') || input.financeHeadline.includes('-') ? 'watch' : 'calm',
    },
  ];
}

function action(
  id: string,
  title: string,
  subtitle: string | null,
  icon: string,
  tint: HomeSemanticTint,
  target: HomeActionTarget,
  priority: HomeActionPriority,
): HomeActionModel {
  return { id, title, subtitle, icon, tint, target, priority };
}

function domainLabel(domain: HomeImpactDomain, language: Lang): string {
  switch (domain) {
    case 'secretary': return localizePT(language, 'Secretaria', 'Secretary');
    case 'training': return localizePT(language, 'Treino', 'Training');
    case 'cooking': return localizePT(language, 'Cozinha', 'Cooking');
    case 'content': return localizePT(language, 'Conteúdo', 'Content');
    case 'finance': return localizePT(language, 'Finanças', 'Finance');
  }
}

function coordinatedStateLabel(state: HomeDayStateKind, language: Lang): string {
  switch (state) {
    case 'crossSkillConflict':
      return localizePT(language, 'Resolve conflito', 'Resolve conflict');
    case 'competingPriorities':
      return localizePT(language, 'Define ordem', 'Set the order');
    case 'recoveryProtected':
      return localizePT(language, 'Protege consistência', 'Protect consistency');
    case 'overloaded':
      return localizePT(language, 'Reduz atrito', 'Reduce friction');
    case 'highPerformance':
      return localizePT(language, 'Aproveita a janela', 'Use the window');
    case 'planComplete':
      return localizePT(language, 'Mantém o plano', 'Hold the plan');
    case 'noNextAction':
      return localizePT(language, 'Define a próxima jogada', 'Define the next move');
    case 'calm':
    default:
      return localizePT(language, 'Segue o plano', 'Follow the plan');
  }
}

function coordinatedConfidenceText(
  state: HomeDayStateKind,
  summary: DashboardHomeOrchestrationSummary,
  language: Lang,
): string | null {
  if (summary.impacts.length >= 3 || (summary.protectedLater && state !== 'overloaded')) {
    return localizePT(language, 'Confiança alta', 'High confidence');
  }
  if (summary.impacts.length >= 1) {
    return localizePT(language, 'Confiança moderada', 'Moderate confidence');
  }
  return null;
}

function trainingWhyNow(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): string | null {
  if (!input.trainingTitle?.trim()) {
    return localizePT(language, 'Ainda não há sessão pronta para hoje.', 'There is no session ready for today yet.');
  }
  if (state === 'recoveryProtected') {
    return localizePT(language, 'O treino foi mantido mais leve para proteger a consistência da semana.', 'Training was kept lighter to protect the week’s consistency.');
  }
  if (state === 'crossSkillConflict') {
    return localizePT(language, 'O treino continua importante, mas já não manda sozinho na prioridade do dia.', 'Training still matters, but it is no longer the only driver of today’s priority.');
  }
  if (state === 'competingPriorities') {
    return localizePT(language, 'O treino está a competir com outras prioridades reais, por isso vale seguir a ordem coordenada.', 'Training is competing with other real priorities, so it is worth following the coordinated order.');
  }
  if (state === 'highPerformance') {
    return localizePT(language, 'A janela de hoje favorece uma boa execução sem comprometer o resto da semana.', 'Today’s window favors strong execution without compromising the rest of the week.');
  }
  if (input.trainingStatus === 'degraded') {
    return localizePT(language, 'Os dados do treino ainda estão a estabilizar, mas a direção de hoje já está definida.', 'Training data is still stabilizing, but today’s direction is already clear.');
  }
  return localizePT(language, 'Esta é a sessão que melhor encaixa no plano de hoje.', 'This is the session that best fits today’s plan.');
}

function trainingConfidenceText(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): string | null {
  if (!input.trainingTitle?.trim() || input.trainingStatus === 'unavailable') {
    return localizePT(language, 'Confiança baixa', 'Low confidence');
  }
  if (state === 'recoveryProtected' || state === 'highPerformance' || state === 'crossSkillConflict' || state === 'competingPriorities' || input.trainingStatus === 'ready') {
    return localizePT(language, 'Confiança alta', 'High confidence');
  }
  return localizePT(language, 'Confiança moderada', 'Moderate confidence');
}

function trainingBlockedReason(input: DashboardHomeBuildInput, language: Lang): string | null {
  if (input.trainingStatus === 'unavailable') {
    return localizePT(language, 'Ainda estamos a recuperar os dados do treino.', 'We are still recovering training data.');
  }
  if (!input.trainingTitle?.trim()) {
    return localizePT(language, 'Ainda não há sessão definida.', 'There is no session defined yet.');
  }
  return null;
}

function contentWhyNow(input: DashboardHomeBuildInput, language: Lang): string | null {
  if (isEmptyContentHeadline(input.contentHeadline)) {
    return localizePT(language, 'Sem um tema validado, o fluxo criativo perde ritmo mais depressa.', 'Without a validated topic, the creative flow loses momentum faster.');
  }
  return input.contentSubline
    ?? localizePT(language, 'Este é o próximo movimento que mais faz o pipeline andar.', 'This is the next move that advances the pipeline the most.');
}

function contentConfidenceText(input: DashboardHomeBuildInput, language: Lang): string | null {
  if (isEmptyContentHeadline(input.contentHeadline)) {
    return localizePT(language, 'Confiança baixa', 'Low confidence');
  }
  if ((input.contentSubline ?? '').trim()) {
    return localizePT(language, 'Confiança alta', 'High confidence');
  }
  return localizePT(language, 'Confiança moderada', 'Moderate confidence');
}

function contentBlockedReason(input: DashboardHomeBuildInput, language: Lang): string | null {
  if (isEmptyContentHeadline(input.contentHeadline)) {
    return localizePT(language, 'Ainda não há um próximo tema validado.', 'There is no validated next topic yet.');
  }
  return null;
}

function cookingWhyNow(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): string | null {
  if (isPlaceholderHeadline(input.cookingHeadline)) {
    return localizePT(language, 'A rotina de refeições ainda precisa de uma decisão concreta para hoje.', 'Meal planning still needs a concrete decision for today.');
  }
  if (state === 'recoveryProtected') {
    return localizePT(language, 'A refeição certa ajuda a proteger recuperação e reduzir atrito no resto do dia.', 'The right meal helps protect recovery and reduce friction across the rest of the day.');
  }
  if (state === 'crossSkillConflict') {
    return localizePT(language, 'A refeição ajuda a reduzir o atrito entre treino, agenda e o resto do dia.', 'The meal helps reduce friction between training, schedule, and the rest of the day.');
  }
  if (state === 'competingPriorities') {
    return localizePT(language, 'A refeição certa ajuda a manter o dia executável quando há demasiadas prioridades a competir.', 'The right meal helps keep the day executable when too many priorities are competing.');
  }
  return input.cookingSubline
    ?? localizePT(language, 'Há uma oportunidade boa de alinhar comida com a carga do dia.', 'There is a good opportunity to align food with today’s load.');
}

function cookingConfidenceText(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): string | null {
  if (isPlaceholderHeadline(input.cookingHeadline)) {
    return localizePT(language, 'Confiança baixa', 'Low confidence');
  }
  if (state === 'recoveryProtected' || state === 'crossSkillConflict' || state === 'competingPriorities' || (input.cookingSubline ?? '').trim()) {
    return localizePT(language, 'Confiança alta', 'High confidence');
  }
  return localizePT(language, 'Confiança moderada', 'Moderate confidence');
}

function cookingBlockedReason(input: DashboardHomeBuildInput, language: Lang): string | null {
  if (isPlaceholderHeadline(input.cookingHeadline)) {
    return localizePT(language, 'Ainda não há refeição alinhada para hoje.', 'There is no aligned meal for today yet.');
  }
  return null;
}

function financeWhyNow(input: DashboardHomeBuildInput, language: Lang): string | null {
  if (isUnavailableFinanceHeadline(input.financeHeadline)) {
    return localizePT(language, 'O resumo financeiro ainda não está sólido o suficiente para virar prioridade.', 'The financial summary is not solid enough yet to become a priority.');
  }
  return input.financeSubline
    ?? localizePT(language, 'Vale confirmar a pressão do mês antes que vire ruído mais tarde.', 'It is worth checking month pressure before it turns into noise later.');
}

function financeConfidenceText(input: DashboardHomeBuildInput, language: Lang): string | null {
  if (isUnavailableFinanceHeadline(input.financeHeadline)) {
    return localizePT(language, 'Confiança baixa', 'Low confidence');
  }
  if ((input.financeSubline ?? '').trim()) {
    return localizePT(language, 'Confiança alta', 'High confidence');
  }
  return localizePT(language, 'Confiança moderada', 'Moderate confidence');
}

function financeBlockedReason(input: DashboardHomeBuildInput, language: Lang): string | null {
  if (isUnavailableFinanceHeadline(input.financeHeadline)) {
    return localizePT(language, 'Ainda falta contexto financeiro para priorizar isto bem.', 'There is still not enough financial context to prioritize this well.');
  }
  return null;
}

function isEmptyContentHeadline(headline: string): boolean {
  const normalized = headline.trim().toLowerCase();
  return normalized.includes('nenhuma') || normalized.includes('no idea') || normalized.includes('sem tema');
}

function isPlaceholderHeadline(headline: string): boolean {
  const normalized = headline.trim().toLowerCase();
  return normalized.length === 0
    || normalized.includes('planear')
    || normalized.includes('planejar')
    || normalized.includes('sem')
    || normalized.includes('nenhum');
}

function isUnavailableFinanceHeadline(headline: string): boolean {
  const normalized = headline.trim();
  return normalized === '—' || normalized === '-' || normalized.length === 0;
}

function localizePT(language: Lang, pt: string, en: string): string;
function localizePT(language: Lang, ptPt: string, ptBr: string, en: string): string;
function localizePT(language: Lang, a: string, b: string, c?: string): string {
  if (c == null) {
    return language.startsWith('pt') ? a : b;
  }
  if (language === 'pt-PT') return a;
  if (language.startsWith('pt')) return b;
  return c;
}

function quantifiedLabel(
  count: number,
  language: Lang,
  ptSingular: string,
  ptPlural: string,
  enSingular: string,
  enPlural: string,
): string {
  if (language.startsWith('pt')) {
    return count === 1
      ? `1 ${ptSingular}`
      : `${count} ${ptPlural}`;
  }

  return count === 1
    ? `1 ${enSingular}`
    : `${count} ${enPlural}`;
}

function normalizeInsightSummary(summary: string): string {
  return summary.trim().toLocaleLowerCase('en-US');
}
