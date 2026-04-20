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

export interface SkillCapabilityFlags {
  secretary: boolean;
  training: boolean;
  cooking: boolean;
  content: boolean;
  finance: boolean;
}

export interface SkillAvailabilityModel {
  availableSkills: HomeImpactDomain[];
  hiddenSkills: HomeImpactDomain[];
  capabilityFlags: SkillCapabilityFlags;
}

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

export type CoordinatedWeekFallbackMode = 'default' | 'singleOutcome' | 'stableWeek' | 'insightPending';
export type CoordinatedWeekVisibility = 'visible' | 'hidden';

export interface CoordinatedOutcomeItem {
  id: string;
  skillId: HomeImpactDomain;
  skillLabel: string;
  icon: string;
  tint: HomeSemanticTint;
  decisionTitle: string;
  impactSummary: string | null;
  cta: HomeActionModel | null;
  priority: number;
}

export interface CoordinatedWeekCardModel {
  stateLabel: string | null;
  title: string;
  weeklyPosture: string;
  summary: string;
  confidenceText: string | null;
  reasonsTitle: string | null;
  reasons: string[];
  outcomes: CoordinatedOutcomeItem[];
  primaryAction: HomeActionModel;
  secondaryAction: HomeActionModel | null;
  skillAvailability: SkillAvailabilityModel;
  visibility: CoordinatedWeekVisibility;
  fallbackMode: CoordinatedWeekFallbackMode;
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
  coordinatedWeek: CoordinatedWeekCardModel | null;
  coordinatedDecision: CoordinatedDecisionModel | null;
  skillQueue: SkillQueueItemModel[];
}

export interface DashboardHomeOrchestrationSummary {
  headline: string;
  detail: string;
  protectedLater: string | null;
  heroHeadline?: string | null;
  heroDetail?: string | null;
  insightSummary?: string | null;
  weeklyHeadline?: string | null;
  weeklyDetail?: string | null;
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
  skillAvailability?: SkillAvailabilityModel | null;
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
  const coordinatedWeek = buildCoordinatedWeek(state, input, language);
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
    coordinatedWeek,
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

  const watchout = input.orchestrationSummary?.insightSummary
    ?? input.orchestrationSummary?.watchouts?.[0]
    ?? null;
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
  const summaryText = [
    input.orchestrationSummary?.heroHeadline,
    input.orchestrationSummary?.heroDetail,
    input.orchestrationSummary?.weeklyHeadline,
    input.orchestrationSummary?.weeklyDetail,
    input.orchestrationSummary?.headline,
    input.orchestrationSummary?.detail,
  ]
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
  const heroHeadline = input.orchestrationSummary?.heroHeadline ?? input.orchestrationSummary?.headline ?? null;
  const heroDetail = input.orchestrationSummary?.heroDetail ?? input.orchestrationSummary?.detail ?? null;

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
      whyNow = heroDetail
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
      whyNow = heroDetail
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
      whyNow = heroDetail
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
        : heroDetail;
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
      whyNow = heroHeadline;
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
      whyNow = heroDetail ?? input.nextEventTitle ?? null;
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

const ALL_HOME_SKILLS: HomeImpactDomain[] = ['secretary', 'training', 'cooking', 'content', 'finance'];

interface CoordinatedOutcomeCandidate {
  skillId: HomeImpactDomain;
  decisionTitle: string;
  impactSummary: string | null;
  priority: number;
  cta: HomeActionModel | null;
}

interface CoordinatedOutcomeProvider {
  skillId: HomeImpactDomain;
  build: (
    state: HomeDayStateKind,
    input: DashboardHomeBuildInput,
    language: Lang,
    skillAvailability: SkillAvailabilityModel,
  ) => CoordinatedOutcomeCandidate | null;
}

const COORDINATED_OUTCOME_PROVIDERS: CoordinatedOutcomeProvider[] = [
  {
    skillId: 'secretary',
    build: (_state, input, language, skillAvailability) => secretaryOutcomeCandidate(input, language, skillAvailability),
  },
  {
    skillId: 'training',
    build: (state, input, language, skillAvailability) => trainingOutcomeCandidate(state, input, language, skillAvailability),
  },
  {
    skillId: 'content',
    build: (_state, input, language, skillAvailability) => contentOutcomeCandidate(input, language, skillAvailability),
  },
  {
    skillId: 'cooking',
    build: (_state, input, language, skillAvailability) => cookingOutcomeCandidate(input, language, skillAvailability),
  },
  {
    skillId: 'finance',
    build: (_state, input, language, skillAvailability) => financeOutcomeCandidate(input, language, skillAvailability),
  },
];

function buildCoordinatedWeek(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): CoordinatedWeekCardModel {
  const skillAvailability = resolveSkillAvailability(input);
  const outcomes = rankCoordinatedOutcomes(
    buildCoordinatedOutcomeCandidates(state, input, language, skillAvailability),
  ).slice(0, 3);
  const reasons = buildCoordinatedReasons(input, language, skillAvailability, outcomes);
  const fallbackMode = coordinatedFallbackMode(input, outcomes);

  return {
    stateLabel: coordinatedStateLabel(state, language),
    title: localizePT(language, 'Semana coordenada', 'Coordinated week'),
    weeklyPosture: coordinatedWeeklyPosture(state, input, language, skillAvailability, outcomes),
    summary: coordinatedWeekSummary(state, input, language, skillAvailability, outcomes, reasons),
    confidenceText: coordinatedWeekConfidenceText(input, language, outcomes, reasons),
    reasonsTitle: reasons.length > 0
      ? localizePT(language, 'Sinais por trás disto', 'Signals behind this')
      : null,
    reasons,
    outcomes,
    primaryAction: action(
      'coordination-week-primary',
      localizePT(language, 'Abrir plano coordenado', 'Open coordinated plan'),
      null,
      'square.grid.2x2',
      'accent',
      'dayPlan',
      'primary',
    ),
    secondaryAction: coordinatedSecondaryAction(outcomes),
    skillAvailability,
    visibility: 'visible',
    fallbackMode,
  };
}

function resolveSkillAvailability(input: DashboardHomeBuildInput): SkillAvailabilityModel {
  if (input.skillAvailability) {
    return normalizeSkillAvailability(input.skillAvailability);
  }
  return inferSkillAvailability(input);
}

function normalizeSkillAvailability(skillAvailability: SkillAvailabilityModel): SkillAvailabilityModel {
  const available = dedupeDomains(skillAvailability.availableSkills);
  const hidden = dedupeDomains(
    skillAvailability.hiddenSkills.length > 0
      ? skillAvailability.hiddenSkills
      : ALL_HOME_SKILLS.filter((skill) => !available.includes(skill)),
  );

  return {
    availableSkills: available,
    hiddenSkills: hidden,
    capabilityFlags: {
      secretary: available.includes('secretary'),
      training: available.includes('training'),
      cooking: available.includes('cooking'),
      content: available.includes('content'),
      finance: available.includes('finance'),
    },
  };
}

function inferSkillAvailability(input: DashboardHomeBuildInput): SkillAvailabilityModel {
  const available = new Set<HomeImpactDomain>(['secretary']);
  for (const impact of input.orchestrationSummary?.impacts ?? []) {
    available.add(impact.domain);
  }

  if (meaningfulTrainingHeadline(input.trainingTitle) || input.trainingStatus === 'degraded') {
    available.add('training');
  }
  if (isMeaningfulContentHeadline(input.contentHeadline)) available.add('content');
  if (isMeaningfulCookingHeadline(input.cookingHeadline)) available.add('cooking');
  if (isMeaningfulFinanceHeadline(input.financeHeadline, input.financeSubline)) available.add('finance');

  return normalizeSkillAvailability({
    availableSkills: Array.from(available),
    hiddenSkills: ALL_HOME_SKILLS.filter((skill) => !available.has(skill)),
    capabilityFlags: {
      secretary: available.has('secretary'),
      training: available.has('training'),
      cooking: available.has('cooking'),
      content: available.has('content'),
      finance: available.has('finance'),
    },
  });
}

function dedupeDomains(domains: HomeImpactDomain[]): HomeImpactDomain[] {
  return Array.from(new Set(domains.filter((domain): domain is HomeImpactDomain => ALL_HOME_SKILLS.includes(domain))));
}

function buildCoordinatedOutcomeCandidates(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
  skillAvailability: SkillAvailabilityModel,
): CoordinatedOutcomeItem[] {
  const availableSkills = new Set(skillAvailability.availableSkills);
  const candidates = compactItems(
    COORDINATED_OUTCOME_PROVIDERS
      .filter((provider) => availableSkills.has(provider.skillId))
      .map((provider) => provider.build(state, input, language, skillAvailability)),
  );

  return candidates.map((candidate) => ({
    id: candidate.skillId,
    skillId: candidate.skillId,
    skillLabel: domainLabel(candidate.skillId, language),
    icon: coordinatedIcon(candidate.skillId),
    tint: coordinatedTint(candidate.skillId),
    decisionTitle: candidate.decisionTitle,
    impactSummary: candidate.impactSummary,
    cta: candidate.cta,
    priority: candidate.priority,
  }));
}

function secretaryOutcomeCandidate(
  input: DashboardHomeBuildInput,
  language: Lang,
  skillAvailability: SkillAvailabilityModel,
): CoordinatedOutcomeCandidate | null {
  const impact = impactDetail(input.orchestrationSummary, 'secretary');
  if (input.overdueTasks > 0) {
    return {
      skillId: 'secretary',
      decisionTitle: quantifiedLabel(input.overdueTasks, language, 'tarefa atrasada', 'tarefas atrasadas', 'overdue task', 'overdue tasks'),
      impactSummary: localizePT(language, 'Resolve o arrasto antes que ele coma o resto da semana.', 'Clear the drag before it eats the rest of the week.'),
      priority: 94,
      cta: action('coordination-secretary-tasks', localizePT(language, 'Abrir tarefas', 'Open tasks'), null, 'checkmark.circle', 'accent', 'tasks', 'secondary'),
    };
  }
  if (input.tasksDue > 0) {
    return {
      skillId: 'secretary',
      decisionTitle: quantifiedLabel(input.tasksDue, language, 'tarefa pede atenção', 'tarefas pedem atenção', 'task needs attention', 'tasks need attention'),
      impactSummary: localizePT(language, 'Fecha pontas soltas sem apertar os próximos dias.', 'Close loose ends without squeezing the next days.'),
      priority: 78,
      cta: action('coordination-secretary-tasks', localizePT(language, 'Abrir tarefas', 'Open tasks'), null, 'checkmark.circle', 'accent', 'tasks', 'secondary'),
    };
  }
  if (impact && !/agenda pronta|calendar ready/i.test(impact)) {
    return {
      skillId: 'secretary',
      decisionTitle: normalizeSecretaryDecision(impact, language),
      impactSummary: localizePT(language, 'Mantém a agenda mais limpa para o resto da semana.', 'Keeps the schedule cleaner for the rest of the week.'),
      priority: 68,
      cta: action('coordination-secretary-plan', localizePT(language, 'Abrir agenda', 'Open schedule'), null, 'calendar.badge.clock', 'secretary', 'dayPlan', 'secondary'),
    };
  }
  return null;
}

function trainingOutcomeCandidate(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
  skillAvailability: SkillAvailabilityModel,
): CoordinatedOutcomeCandidate | null {
  const impact = impactDetail(input.orchestrationSummary, 'training');
  const protectedLater = sanitizeCoordinationText(input.orchestrationSummary?.protectedLater ?? null, skillAvailability);
  const shouldProtectRecovery =
    input.trainingStatus === 'degraded'
    || state === 'recoveryProtected'
    || /recupera|descanso|leve|deload|light/i.test(impact ?? '');

  if (shouldProtectRecovery) {
    return {
      skillId: 'training',
      decisionTitle: localizePT(language, 'Recuperação protegida hoje', 'Recovery protected today'),
      impactSummary: protectedLater
        ?? localizePT(language, 'Protege a próxima sessão forte sem partir a consistência.', 'Protects the next strong session without breaking consistency.'),
      priority: 100,
      cta: action('coordination-training', localizePT(language, 'Abrir treino', 'Open training'), null, 'figure.run', 'training', 'training', 'secondary'),
    };
  }

  const decisionTitle = firstRenderable([
    normalizeTrainingDecision(impact, language),
    meaningfulTrainingHeadline(input.trainingTitle),
  ]);

  if (!decisionTitle) return null;

  return {
    skillId: 'training',
    decisionTitle,
    impactSummary: protectedLater
      ?? (input.trainingTime
        ? localizePT(language, `Sessão alinhada para ${input.trainingTime}.`, `Session aligned for ${input.trainingTime}.`)
        : localizePT(language, 'Mantém a consistência da semana sem subir a fricção.', 'Keeps weekly consistency without adding friction.')),
    priority: impact ? 86 : 72,
    cta: action('coordination-training', localizePT(language, 'Abrir treino', 'Open training'), null, 'figure.run', 'training', 'training', 'secondary'),
  };
}

function contentOutcomeCandidate(
  input: DashboardHomeBuildInput,
  language: Lang,
  skillAvailability: SkillAvailabilityModel,
): CoordinatedOutcomeCandidate | null {
  const impact = impactDetail(input.orchestrationSummary, 'content');
  const decisionTitle = firstRenderable([
    normalizeContentDecision(impact, input.contentSubline, input.contentHeadline, language),
    meaningfulContentSummary(input.contentSubline),
    meaningfulContentHeadline(input.contentHeadline),
  ]);

  if (!decisionTitle) return null;

  return {
    skillId: 'content',
    decisionTitle,
    impactSummary: sanitizeCoordinationText(input.orchestrationSummary?.protectedLater ?? null, skillAvailability)
      ?? input.contentSubline
      ?? localizePT(language, 'Melhor encaixe de energia e agenda para avançar.', 'Best schedule and energy fit to move forward.'),
    priority: /janela|grava|window|film/i.test(`${decisionTitle} ${input.contentSubline ?? ''}`) ? 84 : 70,
    cta: action('coordination-content', localizePT(language, 'Abrir conteúdo', 'Open content'), null, 'sparkles', 'content', 'contentRadar', 'secondary'),
  };
}

function cookingOutcomeCandidate(
  input: DashboardHomeBuildInput,
  language: Lang,
  _skillAvailability: SkillAvailabilityModel,
): CoordinatedOutcomeCandidate | null {
  const impact = impactDetail(input.orchestrationSummary, 'cooking');
  const decisionTitle = firstRenderable([
    normalizeCookingDecision(impact, input.cookingHeadline, language),
    meaningfulCookingHeadline(input.cookingHeadline),
  ]);

  if (!decisionTitle) return null;

  return {
    skillId: 'cooking',
    decisionTitle,
    impactSummary: input.cookingSubline
      ?? localizePT(language, 'Mantém a execução simples e o custo da semana mais leve.', 'Keeps execution simple and the weekly cost lighter.'),
    priority: /econ[oó]m|batch|meal prep/i.test(`${decisionTitle} ${input.cookingSubline ?? ''}`) ? 76 : 66,
    cta: action('coordination-cooking', localizePT(language, 'Abrir refeição', 'Open meal'), null, 'fork.knife', 'cooking', 'cooking', 'secondary'),
  };
}

function financeOutcomeCandidate(
  input: DashboardHomeBuildInput,
  language: Lang,
  skillAvailability: SkillAvailabilityModel,
): CoordinatedOutcomeCandidate | null {
  const impact = impactDetail(input.orchestrationSummary, 'finance');
  const decisionTitle = firstRenderable([
    sanitizeCoordinationText(impact, skillAvailability),
    meaningfulFinanceHeadline(input.financeHeadline, input.financeSubline),
  ]);

  if (!decisionTitle) return null;

  return {
    skillId: 'finance',
    decisionTitle,
    impactSummary: input.financeSubline
      ?? localizePT(language, 'Mantém a pressão financeira visível sem barulho extra.', 'Keeps financial pressure visible without extra noise.'),
    priority: 62,
    cta: action('coordination-finance', localizePT(language, 'Abrir finanças', 'Open finances'), null, 'chart.line.uptrend.xyaxis', 'finance', 'finance', 'secondary'),
  };
}

function rankCoordinatedOutcomes(outcomes: CoordinatedOutcomeItem[]): CoordinatedOutcomeItem[] {
  return [...outcomes]
    .sort((lhs, rhs) => rhs.priority - lhs.priority)
    .filter((item, index, array) => array.findIndex((candidate) => candidate.skillId === item.skillId) === index);
}

function coordinatedWeeklyPosture(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
  skillAvailability: SkillAvailabilityModel,
  outcomes: CoordinatedOutcomeItem[],
): string {
  const summaryHeadline = sanitizeCoordinationText(
    input.orchestrationSummary?.weeklyHeadline
      ?? input.orchestrationSummary?.headline
      ?? null,
    skillAvailability,
  );
  if (summaryHeadline) return summaryHeadline;

  switch (state) {
    case 'recoveryProtected':
      return localizePT(language, 'Esta semana protege primeiro a consistência.', 'This week protects consistency first.');
    case 'competingPriorities':
      return localizePT(language, 'Esta semana define a ordem antes da intensidade.', 'This week sets the order before intensity.');
    case 'crossSkillConflict':
      return localizePT(language, 'Esta semana resolve conflito antes de acelerar.', 'This week resolves conflict before pushing.');
    case 'overloaded':
      return localizePT(language, 'Esta semana reduz atrito para manter o plano viável.', 'This week reduces friction to keep the plan viable.');
    case 'highPerformance':
      return localizePT(language, 'Esta semana aproveita as melhores janelas.', 'This week uses the best windows.');
    case 'noNextAction':
      return localizePT(language, 'Esta semana segue estável, sem ajustes fortes.', 'This week stays stable, with no strong adjustments.');
    case 'planComplete':
      return localizePT(language, 'Esta semana está alinhada e pronta para seguir.', 'This week is aligned and ready to keep moving.');
    case 'calm':
    default:
      if (outcomes.length === 1) {
        return localizePT(language, `Esta semana mantém ${outcomes[0]!.skillLabel.toLowerCase()} sob controlo.`, `This week keeps ${outcomes[0]!.skillLabel.toLowerCase()} under control.`);
      }
      return localizePT(language, 'Esta semana segue coordenada sem pressão extra.', 'This week stays coordinated without extra pressure.');
  }
}

function coordinatedWeekSummary(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
  skillAvailability: SkillAvailabilityModel,
  outcomes: CoordinatedOutcomeItem[],
  reasons: string[],
): string {
  const detail = sanitizeCoordinationText(
    input.orchestrationSummary?.weeklyDetail
      ?? input.orchestrationSummary?.detail
      ?? null,
    skillAvailability,
  );
  if (detail) return detail;
  if (reasons[0]) return reasons[0];
  if (outcomes[0]?.impactSummary) return outcomes[0].impactSummary;
  if (outcomes.length === 1) {
    return localizePT(language, 'Este é o ajuste semanal que mais mexe com o teu plano agora.', 'This is the weekly adjustment that matters most right now.');
  }
  if (outcomes.length > 1) {
    return localizePT(language, 'Os próximos ajustes já estão ordenados para proteger a semana sem criar ruído.', 'The next adjustments are already ordered to protect the week without adding noise.');
  }
  if (state === 'noNextAction' || state === 'calm' || state === 'planComplete') {
    return localizePT(language, 'Esta semana está estável. Não foram precisos ajustes coordenados maiores.', 'This week is stable. No major coordinated adjustments were needed.');
  }
  return localizePT(language, 'Ainda não há um ajuste multi-skill forte para destacar aqui.', 'There is not yet a strong multi-skill adjustment to highlight here.');
}

function coordinatedWeekConfidenceText(
  input: DashboardHomeBuildInput,
  language: Lang,
  outcomes: CoordinatedOutcomeItem[],
  reasons: string[],
): string | null {
  if (outcomes.length >= 3 || (outcomes.length >= 2 && reasons.length > 0)) {
    return localizePT(language, 'Confiança alta', 'High confidence');
  }
  if (outcomes.length >= 1 || input.orchestrationSummary) {
    return localizePT(language, 'Confiança moderada', 'Moderate confidence');
  }
  return null;
}

function coordinatedSecondaryAction(outcomes: CoordinatedOutcomeItem[]): HomeActionModel | null {
  return outcomes.map((outcome) => outcome.cta).find((cta): cta is HomeActionModel => Boolean(cta && cta.target !== 'dayPlan')) ?? null;
}

function buildCoordinatedReasons(
  input: DashboardHomeBuildInput,
  language: Lang,
  skillAvailability: SkillAvailabilityModel,
  outcomes: CoordinatedOutcomeItem[],
): string[] {
  const outcomeKeys = new Set(
    outcomes.flatMap((outcome) => [outcome.decisionTitle, outcome.impactSummary ?? ''].map(normalizedTextKey)),
  );

  return compactStrings([
    sanitizeCoordinationText(
      input.orchestrationSummary?.weeklyDetail
        ?? input.orchestrationSummary?.detail
        ?? null,
      skillAvailability,
    ),
    ...(input.orchestrationSummary?.watchouts ?? []).map((reason) => sanitizeCoordinationText(reason, skillAvailability)),
    sanitizeCoordinationText(input.orchestrationSummary?.protectedLater ?? null, skillAvailability),
    fallbackReason(input, language),
  ])
    .filter((reason, index, array) => {
      const key = normalizedTextKey(reason);
      return key.length > 0
        && !outcomeKeys.has(key)
        && array.findIndex((candidate) => normalizedTextKey(candidate) === key) === index;
    })
    .slice(0, 3);
}

function fallbackReason(input: DashboardHomeBuildInput, language: Lang): string | null {
  if ((input.readinessScore ?? 100) < 60 || input.trainingStatus === 'degraded') {
    return localizePT(language, 'A recuperação caiu e o sistema abriu margem.', 'Recovery dropped and the system opened more room.');
  }
  if (input.overdueTasks > 0) {
    return localizePT(language, 'Há tarefas em atraso a disputar prioridade com a agenda.', 'Overdue tasks are competing with the calendar for priority.');
  }
  return null;
}

function coordinatedFallbackMode(
  input: DashboardHomeBuildInput,
  outcomes: CoordinatedOutcomeItem[],
): CoordinatedWeekFallbackMode {
  if (outcomes.length >= 2) return 'default';
  if (outcomes.length === 1) return 'singleOutcome';
  if (input.orchestrationSummary || (input.warningMessages.length > 0)) return 'insightPending';
  return 'stableWeek';
}

function impactDetail(
  summary: DashboardHomeOrchestrationSummary | null,
  domain: HomeImpactDomain,
): string | null {
  return summary?.impacts.find((impact) => impact.domain === domain)?.detail?.trim() || null;
}

function sanitizeCoordinationText(
  text: string | null | undefined,
  skillAvailability: SkillAvailabilityModel,
): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  if (skillAvailability.hiddenSkills.some((skill) => hiddenSkillPattern(skill).test(trimmed))) {
    return null;
  }
  return trimmed;
}

function hiddenSkillPattern(skill: HomeImpactDomain): RegExp {
  switch (skill) {
    case 'training':
      return /\b(treino|training|corrida|run|bike|ride|swim|workout|recupera[çc][aã]o)\b/i;
    case 'content':
      return /\b(conte[uú]do|content|grava[çc][aã]o|roteiro|script|film|post)\b/i;
    case 'cooking':
      return /\b(cozinha|meal|refei[çc][aã]o|receita|recipe|batch)\b/i;
    case 'finance':
      return /\b(finanç|financial|budget|orçamento|tax|gasto|expense|darf)\b/i;
    case 'secretary':
      return /\b(secretaria|agenda|calendar|task|tarefa)\b/i;
  }
}

function normalizedTextKey(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function coordinatedIcon(domain: HomeImpactDomain): string {
  switch (domain) {
    case 'secretary': return 'calendar.badge.clock';
    case 'training': return 'figure.run';
    case 'content': return 'sparkles';
    case 'cooking': return 'fork.knife';
    case 'finance': return 'chart.line.uptrend.xyaxis';
  }
}

function coordinatedTint(domain: HomeImpactDomain): HomeSemanticTint {
  switch (domain) {
    case 'secretary': return 'secretary';
    case 'training': return 'training';
    case 'content': return 'content';
    case 'cooking': return 'cooking';
    case 'finance': return 'finance';
  }
}

function normalizeSecretaryDecision(detail: string, language: Lang): string {
  if (/foco|focus/i.test(detail)) {
    return localizePT(language, 'Bloco de foco preservado', 'Focus block preserved');
  }
  if (/reajustad|adjusted/i.test(detail)) {
    return localizePT(language, 'Agenda reajustada hoje', 'Schedule adjusted today');
  }
  return detail;
}

function normalizeTrainingDecision(detail: string | null, language: Lang): string | null {
  if (!detail) return null;
  if (/menos carga|leve|recupera|descanso|deload|light/i.test(detail)) {
    return localizePT(language, 'Recuperação protegida hoje', 'Recovery protected today');
  }
  if (/coordinated|alinhado/i.test(detail)) {
    return localizePT(language, 'Sessão preservada para hoje', 'Session preserved for today');
  }
  return detail;
}

function normalizeContentDecision(
  detail: string | null,
  subline: string | null,
  headline: string,
  language: Lang,
): string | null {
  const candidate = firstRenderable([detail, subline, headline]);
  if (!candidate) return null;
  if (/bloco de conte[uú]do|content block/i.test(candidate)) {
    return localizePT(language, 'Janela de gravação preservada', 'Filming window preserved');
  }
  if (/conte[uú]do alinhado|content aligned/i.test(candidate)) {
    return null;
  }
  return candidate;
}

function normalizeCookingDecision(detail: string | null, headline: string, language: Lang): string | null {
  const candidate = firstRenderable([detail, headline]);
  if (!candidate) return null;
  if (/refei[çc][aã]o alinhada|meal aligned/i.test(candidate)) {
    return localizePT(language, '1 refeição alinhada para a semana', '1 meal aligned for the week');
  }
  return candidate;
}

function meaningfulTrainingHeadline(title: string | null): string | null {
  const trimmed = title?.trim();
  if (!trimmed || /sem sessão|unavailable|indispon/i.test(trimmed)) return null;
  return trimmed;
}

function meaningfulContentHeadline(headline: string): string | null {
  const trimmed = headline.trim();
  if (!trimmed || /nenhuma ideia|no ideas yet|radar ready|sem ideias|conte[uú]do alinhado/i.test(trimmed)) return null;
  return trimmed;
}

function meaningfulContentSummary(subline: string | null): string | null {
  const trimmed = subline?.trim();
  if (!trimmed) return null;
  return /janela|grava|window|film|public/i.test(trimmed) ? trimmed : null;
}

function meaningfulCookingHeadline(headline: string): string | null {
  const trimmed = headline.trim();
  if (!trimmed || /planear refei|sem refei|meals ready/i.test(trimmed)) return null;
  return trimmed;
}

function isMeaningfulCookingHeadline(headline: string): boolean {
  return meaningfulCookingHeadline(headline) != null;
}

function meaningfulFinanceHeadline(headline: string, subline: string | null): string | null {
  const trimmed = compactStrings([subline, headline])[0] ?? null;
  if (!trimmed) return null;
  if (/^€?\s*0\b/.test(headline.trim()) && !subline?.trim()) return null;
  if (/sem dados|unavailable|indispon/i.test(trimmed)) return null;
  return trimmed;
}

function isMeaningfulFinanceHeadline(headline: string, subline: string | null): boolean {
  return meaningfulFinanceHeadline(headline, subline) != null;
}

function isMeaningfulContentHeadline(headline: string): boolean {
  return meaningfulContentHeadline(headline) != null;
}

function compactItems<T>(items: Array<T | null | undefined>): T[] {
  return items.filter((item): item is T => item != null);
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values
    .map((value) => value?.trim() ?? '')
    .filter((value): value is string => value.length > 0);
}

function firstRenderable(values: Array<string | null | undefined>): string | null {
  return compactStrings(values)[0] ?? null;
}

function buildDecision(
  state: HomeDayStateKind,
  input: DashboardHomeBuildInput,
  language: Lang,
): CoordinatedDecisionModel | null {
  const summary = input.orchestrationSummary;
  if (!summary) return null;
  const decisionSummary = preferredCoordinatedDecisionSummary(summary);

  return {
    stateLabel: coordinatedStateLabel(state, language),
    title: localizePT(language, 'Coordenação do dia', 'Daily coordination'),
    summary: decisionSummary,
    confidenceText: coordinatedConfidenceText(state, summary, language),
    reasonTitle: localizePT(language, 'Porque', 'Why'),
    reason: summary.weeklyDetail ?? summary.detail,
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

function preferredCoordinatedDecisionSummary(summary: DashboardHomeOrchestrationSummary): string {
  const headline = firstRenderable([summary.weeklyHeadline, summary.headline]);
  const detail = firstRenderable([summary.weeklyDetail, summary.detail]);

  if (!headline) return detail ?? '';
  if (!detail) return headline;

  const headlineKey = normalizedTextKey(headline);
  const detailKey = normalizedTextKey(detail);
  const detailIsExpandedHeadline =
    headlineKey.length > 0
      && detailKey.startsWith(headlineKey)
      && detail.length > headline.length + 12;

  return detailIsExpandedHeadline ? detail : headline;
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
