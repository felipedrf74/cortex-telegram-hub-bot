// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { config } from '../../config';
import type { DailyBriefResponse } from '../../services/daily-brief-orchestrator';
import {
  type DashboardHomeBuildInput,
  type DashboardHomeOrchestrationSummary,
  type HomeImpactDomain,
  type SecretaryPreviewItemModel,
  type SkillAvailabilityModel,
} from '../../services/dashboard-home-view-state';
import { checkSkillAccess } from '../../services/skill-tiers';
import { getUserById, getUserByTelegramId } from '../../services/user-service';
import type { Lang } from '../../utils/i18n';
import { dedupeStrings } from './dashboard-data-fetchers';

// Phase 17 hostile-QA fix (2026-05-18): 'stale' added so the Secretary
// all-clear gate at buildSecretarySummary line 200 can distinguish
// fresh-ready from stale-snapshot (provider-fetch failed; cached data).
// The trainingStatus alias used previously was narrower and lost the
// 'stale' discriminator on the way through the dashboard-home pipeline.
type DashboardSectionStatus = 'ready' | 'stale' | 'degraded' | 'unavailable';

interface DashboardCalendarEvent {
  id?: string;
  start?: string;
  end?: string;
  title?: string;
  source?: string | null;
}

interface DashboardHomeSource {
  featureFlags?: {
    secretaryOrchestrationSnapshotV1?: boolean;
  };
  calendar?: {
    today?: DashboardCalendarEvent[];
    status?: DashboardSectionStatus;
    warningCodes?: string[];
  };
  tasks?: {
    dueToday?: number;
    overdue?: number;
    status?: DashboardSectionStatus;
    warningCodes?: string[];
  };
  training?: {
    readinessScore?: number | null;
    bodyBattery?: number | null;
    todaySession?: {
      type?: string | null;
      time?: string | null;
      duration?: number | null;
    } | null;
    status?: DashboardSectionStatus;
    warningCodes?: string[];
  };
  content?: {
    pipelineCount?: {
      ideas?: number;
      scripted?: number;
      filmed?: number;
      editing?: number;
      published?: number;
    };
    status?: DashboardSectionStatus;
    warningCodes?: string[];
  };
}

export function buildDashboardHomeInput(opts: {
  userId: number;
  dashboard: DashboardHomeSource;
  brief: DailyBriefResponse | null;
  language: Lang;
  meta: DashboardHomeBuildInput['meta'];
}): DashboardHomeBuildInput {
  const { userId, dashboard, brief, language, meta } = opts;
  const nextEvent = selectNextEvent(dashboard.calendar?.today ?? []);
  const secretaryItems = buildSecretaryPreviewItems(dashboard.calendar?.today ?? [], language);
  const tasksDue = dashboard.tasks?.dueToday ?? 0;
  const overdueTasks = dashboard.tasks?.overdue ?? 0;
  const calendarUnavailable = dashboard.calendar?.status === 'unavailable';

  return {
    readinessScore: dashboard.training?.readinessScore ?? null,
    bodyBattery: dashboard.training?.bodyBattery ?? null,
    tasksDue,
    overdueTasks,
    eventsCount: calendarUnavailable ? 0 : (dashboard.calendar?.today?.length ?? 0),
    nextEventTitle: localizeTrainingTitle(nextEvent?.title, null, language),
    nextEventTime: nextEvent?.start ?? null,
    nextEventSource: nextEvent?.source ?? null,
    hasCalendarUnavailable: calendarUnavailable,
    trainingTitle: localizeTrainingTitle(brief?.day.training.title, dashboard.training?.todaySession?.type, language),
    trainingTime: dashboard.training?.todaySession?.time ?? null,
    trainingDurationMinutes: dashboard.training?.todaySession?.duration ?? brief?.day.training.durationMinutes ?? null,
    // Training view-state type only supports ready|degraded|unavailable;
    // collapse the wider 'stale' (Phase 17) into 'degraded' for training.
    trainingStatus: dashboard.training?.status === 'stale'
      ? 'degraded'
      : (dashboard.training?.status ?? 'unavailable'),
    contentHeadline: buildContentHeadline(dashboard, brief, language),
    contentSubline: buildContentSubline(brief, language),
    cookingHeadline: buildCookingHeadline(brief, language),
    cookingSubline: buildCookingSubline(brief),
    financeHeadline: buildFinanceHeadline(brief, language),
    financeSubline: buildFinanceSubline(brief),
    orchestrationSummary: buildHomeOrchestrationSummary(brief, language),
    skillAvailability: buildHomeSkillAvailability(userId),
    warningMessages: buildDashboardHomeWarningMessages(dashboard, language),
    secretaryItems,
    secretarySummary: buildSecretarySummary({
      events: dashboard.calendar?.today ?? [],
      tasksDue,
      overdueTasks,
      hasCalendarUnavailable: calendarUnavailable,
      // Phase 17 hostile-QA fix (2026-05-18): pass real statuses through.
      // The previous code forced 'ready' when the flag was OFF, which made
      // the rollback path LIE — degraded providers were silently reported
      // as ready, and buildSecretarySummary at line 200 fell through to
      // "all clear" copy. The flag at dashboard.ts:298 controls whether
      // the truth fields are populated; do NOT zero out the input here.
      calendarStatus: dashboard.calendar?.status ?? 'ready',
      tasksStatus: dashboard.tasks?.status ?? 'ready',
      language,
    }),
    meta,
  };
}

function buildHomeSkillAvailability(userId: number): SkillAvailabilityModel {
  const user = getUserById(userId) || getUserByTelegramId(userId);
  const skills: HomeImpactDomain[] = ['secretary', 'training', 'cooking', 'content', 'finance'];
  const availableSkills = skills.filter((skill) => hasHomeSkillAccess(userId, user, skill));
  const hiddenSkills = skills.filter((skill) => !availableSkills.includes(skill));

  return {
    availableSkills,
    hiddenSkills,
    capabilityFlags: {
      secretary: availableSkills.includes('secretary'),
      training: availableSkills.includes('training'),
      cooking: availableSkills.includes('cooking'),
      content: availableSkills.includes('content'),
      finance: availableSkills.includes('finance'),
    },
  };
}

function hasHomeSkillAccess(
  _userId: number,
  user: { id: number; tier: string } | null | undefined,
  skill: HomeImpactDomain,
): boolean {
  const skillId = skill === 'training' ? 'triathlon' : skill;
  return checkSkillAccess(user as any, skillId).allowed;
}

function selectNextEvent(events: Array<{ start?: string; end?: string } & Record<string, any>>) {
  const nowMinutes = currentLocalMinutes();
  const ongoing = events.find((event) => {
    const start = timeToMinutes(event.start);
    const end = timeToMinutes(event.end);
    return start != null && end != null && start <= nowMinutes && nowMinutes < end;
  });
  if (ongoing) return ongoing;

  const upcoming = events.find((event) => {
    const start = timeToMinutes(event.start);
    return start != null && start > nowMinutes;
  });
  return upcoming ?? events[0] ?? null;
}

function buildSecretaryPreviewItems(
  events: Array<{ id?: string; start?: string; end?: string; title?: string; source?: string | null }>,
  language: Lang,
): SecretaryPreviewItemModel[] {
  const nowMinutes = currentLocalMinutes();
  return events.slice(0, 3).map((event, index) => {
    const start = timeToMinutes(event.start);
    const end = timeToMinutes(event.end);
    const isNow = start != null && end != null && start <= nowMinutes && nowMinutes < end;
    const isPast = end != null && nowMinutes >= end;
    return {
      id: String(event.id ?? `event-${index}`),
      time: formatEventRange(event.start, event.end),
      title: localizeTrainingTitle(event.title, null, language) ?? String(event.title ?? '(No title)'),
      source: event.source ?? null,
      isNow,
      isPast,
    };
  });
}

export function buildSecretarySummary(opts: {
  events: Array<{ title?: string; start?: string; end?: string }>;
  tasksDue: number;
  overdueTasks: number;
  hasCalendarUnavailable: boolean;
  calendarStatus: DashboardSectionStatus;
  tasksStatus: DashboardSectionStatus;
  language: Lang;
}): string {
  if (opts.hasCalendarUnavailable) {
    return localizePT(
      opts.language,
      'A agenda precisa de integração antes de coordenar o resto do dia.',
      'Your calendar needs integration before the rest of the day can coordinate.',
    );
  }

  if (opts.tasksStatus !== 'ready' || opts.calendarStatus !== 'ready') {
    return localizePT(
      opts.language,
      'Ainda estou a confirmar tarefas e agenda antes de chamar o dia de limpo.',
      'I am still confirming tasks and calendar before calling the day clear.',
    );
  }

  const nowMinutes = currentLocalMinutes();
  const ongoing = opts.events.find((event) => {
    const start = timeToMinutes(event.start);
    const end = timeToMinutes(event.end);
    return start != null && end != null && start <= nowMinutes && nowMinutes < end;
  });
  if (ongoing?.title) {
    const ongoingTitle = localizeTrainingTitle(ongoing.title, null, opts.language) ?? ongoing.title;
    return localizePT(
      opts.language,
      `Agora: ${ongoingTitle}. ${opts.tasksDue} tarefas ainda pedem atenção hoje.`,
      `Now: ${ongoingTitle}. ${opts.tasksDue} tasks still need attention today.`,
    );
  }

  const upcoming = opts.events.find((event) => {
    const start = timeToMinutes(event.start);
    return start != null && start > nowMinutes;
  });
  if (upcoming?.start) {
    const taskCount = Math.max(0, opts.tasksDue + opts.overdueTasks);
    return localizePT(
      opts.language,
      `Próximo bloco às ${upcoming.start}. ${taskCount} tarefas continuam no radar.`,
      `Next block starts at ${upcoming.start}. ${taskCount} tasks remain on the radar.`,
    );
  }

  if (opts.tasksDue + opts.overdueTasks > 0) {
    return localizePT(
      opts.language,
      'A agenda está leve; o próximo peso do dia está nas tarefas em aberto.',
      'The calendar is light; the next weight of the day is in open tasks.',
    );
  }

  return localizePT(
    opts.language,
    'A agenda está controlada e o dia tem margem para seguir o plano sem ruído.',
    'The schedule is under control and the day has room to follow the plan without noise.',
  );
}

export function buildHomeOrchestrationSummary(
  brief: DailyBriefResponse | null,
  language: Lang,
): DashboardHomeOrchestrationSummary | null {
  if (!brief) return null;
  const coordination = brief.coordination;

  const coordinationImpacts: DashboardHomeOrchestrationSummary['impacts'] = (coordination?.crossSkillImpacts ?? [])
    .map((impact): DashboardHomeOrchestrationSummary['impacts'][number] => ({
      id: impact.id,
      domain: impact.skillId === 'secretary' ? 'secretary' : impact.skillId,
      detail: impact.summary,
    }))
    .slice(0, 4);

  const impacts: DashboardHomeOrchestrationSummary['impacts'] = (
    coordinationImpacts.length > 0
      ? coordinationImpacts
      : compactStrings([
        secretaryImpact(brief, language),
        trainingImpact(brief, language),
        cookingImpact(brief, language),
        contentImpact(brief, language),
        financeImpact(brief),
      ])
  ).slice(0, 4);

  if (impacts.length === 0) return null;

  const weeklyHeadline = firstRenderable([
    coordination?.weekOrchestration?.title ?? null,
    coordination?.dayOrchestration?.title ?? null,
    preferredFallbackWeeklyHeadline(brief),
    brief.day.headline,
    brief.creativeCopy.headline,
    coordination?.topPriority ?? null,
  ]) ?? localizePT(language, 'O dia já foi coordenado para proteger o que importa agora.', 'The day was already coordinated to protect what matters now.');

  const heroHeadline = firstRenderable([
    coordination?.dayOrchestration?.title ?? null,
    coordination?.nextBestAction?.title ?? null,
    coordination?.topPriority ?? null,
    brief.day.headline,
    weeklyHeadline,
  ]);

  const heroDetail = firstRenderable([
    coordination?.nextBestAction?.summary ?? null,
    coordination?.blockers?.[0]?.summary ?? null,
    coordination?.dayOrchestration?.summary ?? null,
    brief.conflicts[0]?.message ?? null,
    brief.day.secretary.tradeoffNote,
    coordination?.watchouts?.[0] ?? null,
    brief.day.training.reason,
    brief.creativeCopy.note,
  ]) ?? localizePT(language, 'A coordenação está a alinhar agenda, treino e execução para reduzir atrito.', 'Coordination is aligning schedule, training, and execution to reduce friction.');

  const weeklyDetail = firstRenderable([
    coordination?.weekOrchestration?.summary ?? null,
    coordination?.protectedBlocks?.[0]?.summary ?? null,
    coordination?.handoffs?.[0] ?? null,
    brief.creativeCopy.note,
    heroDetail,
  ]) ?? localizePT(language, 'A coordenação está a alinhar agenda, treino e execução para reduzir atrito.', 'Coordination is aligning schedule, training, and execution to reduce friction.');

  const insightSummary = firstRenderable([
    coordination?.blockers?.[0]?.summary ?? null,
    coordination?.protectedBlocks?.[0]?.summary ?? null,
    coordination?.watchouts?.[0] ?? null,
    brief.conflicts[0]?.message ?? null,
  ]);

  const protectedLater = firstRenderable([
    coordination?.nextBestAction?.whyNow ?? null,
    coordination?.protectedBlocks?.[0]?.summary ?? null,
    coordination?.handoffs?.[0] ?? null,
    brief.day.content?.note?.trim() ?? null,
  ]);

  return {
    headline: weeklyHeadline,
    detail: weeklyDetail,
    protectedLater,
    heroHeadline,
    heroDetail,
    insightSummary,
    weeklyHeadline,
    weeklyDetail,
    impacts,
    watchouts: compactStrings([
      ...(coordination?.watchouts ?? []),
      ...((coordination?.blockers ?? []).map((blocker) => blocker.title)),
    ]).slice(0, 2),
  };
}

function preferredFallbackWeeklyHeadline(brief: DailyBriefResponse): string | null {
  const dayHeadline = brief.day.headline?.trim() ?? '';
  const creativeHeadline = brief.creativeCopy.headline?.trim() ?? '';
  const topPriority = brief.coordination.topPriority?.trim() ?? '';

  if (!creativeHeadline) return dayHeadline || topPriority || null;
  if (!dayHeadline) return creativeHeadline || topPriority || null;

  const dayKey = normalizedHomeCopyKey(dayHeadline);
  const creativeKey = normalizedHomeCopyKey(creativeHeadline);
  const priorityKey = normalizedHomeCopyKey(topPriority);
  const creativeExpandsDay =
    dayKey.length > 0
      && creativeKey.startsWith(dayKey)
      && creativeHeadline.length > dayHeadline.length + 12;
  const creativeExpandsPriority =
    priorityKey.length > 0
      && creativeKey.startsWith(priorityKey)
      && creativeHeadline.length > topPriority.length + 12;

  return creativeExpandsDay || creativeExpandsPriority ? creativeHeadline : dayHeadline;
}

function normalizedHomeCopyKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function buildDashboardHomeWarningMessages(
  dashboard: DashboardHomeSource,
  language: Lang,
): string[] {
  const codes = dedupeStrings([
    ...(dashboard.calendar?.warningCodes ?? []),
    ...(dashboard.tasks?.warningCodes ?? []),
    ...(dashboard.training?.warningCodes ?? []),
    ...(dashboard.content?.warningCodes ?? []),
  ]);

  return compactStrings(codes.map((code) => localizedDashboardWarningMessage(code, language))).slice(0, 2);
}

function localizedDashboardWarningMessage(code: string, language: Lang): string | null {
  switch (code) {
    case 'OUTLOOK_CALENDAR_UNAVAILABLE':
      return localizePT(language, 'O Outlook Calendar está indisponível agora.', 'Outlook Calendar is unavailable right now.');
    case 'GOOGLE_CALENDAR_UNAVAILABLE':
      return localizePT(language, 'O Google Calendar está indisponível agora.', 'Google Calendar is unavailable right now.');
    case 'CALENDAR_INTEGRATION_MISSING':
      return localizePT(language, 'Liga o Google Calendar ou o Outlook para preencher o plano do dia.', 'Connect Google Calendar or Outlook to fill your day plan.');
    case 'WEARABLE_INTEGRATION_MISSING':
      return localizePT(language, 'Liga o Garmin ou o Apple Health para personalizar a prontidão.', 'Connect Garmin or Apple Health to personalize readiness.');
    case 'TASKS_UNAVAILABLE':
      return localizePT(language, 'As tarefas estão indisponíveis agora.', 'Tasks are unavailable right now.');
    case 'READINESS_UNAVAILABLE':
      return localizePT(language, 'A prontidão está indisponível agora.', 'Readiness data is unavailable right now.');
    case 'BODY_BATTERY_UNAVAILABLE':
      return localizePT(language, 'A Body Battery está indisponível agora.', 'Body Battery is unavailable right now.');
    case 'CALENDAR_UNAVAILABLE':
      return localizePT(language, 'Os dados de calendário estão indisponíveis agora.', 'Calendar data is unavailable right now.');
    case 'CONTENT_UNAVAILABLE':
      return localizePT(language, 'O conteúdo está indisponível agora.', 'Content is unavailable right now.');
    default:
      return null;
  }
}

function secretaryImpact(
  brief: DailyBriefResponse,
  language: Lang,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  const secretary = brief.day.secretary;
  const focusNote = secretary.focusBlock?.note?.trim();
  if (focusNote) {
    return { id: 'secretary', domain: 'secretary', detail: focusNote };
  }
  if (secretary.overdueTasks > 0) {
    return {
      id: 'secretary',
      domain: 'secretary',
      detail: quantifiedLabel(secretary.overdueTasks, language, 'atrasada', 'atrasadas', 'overdue task', 'overdue tasks'),
    };
  }
  if (secretary.pendingTasks > 0) {
    return {
      id: 'secretary',
      domain: 'secretary',
      detail: quantifiedLabel(secretary.pendingTasks, language, 'tarefa ativa', 'tarefas ativas', 'active task', 'active tasks'),
    };
  }
  if (secretary.busy || secretary.travel || secretary.sequence.length > 0) {
    return {
      id: 'secretary',
      domain: 'secretary',
      detail: localizePT(language, 'Agenda reajustada', 'Calendar adjusted'),
    };
  }
  return null;
}

function trainingImpact(
  brief: DailyBriefResponse,
  language: Lang,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  const training = brief.day.training;
  if (training.title?.trim()) {
    return { id: 'training', domain: 'training', detail: localizeTrainingTitle(training.title, null, language) ?? training.title };
  }
  if (training.durationMinutes && training.durationMinutes > 0) {
    return {
      id: 'training',
      domain: 'training',
      detail: localizePT(language, `${training.durationMinutes} min de treino`, `${training.durationMinutes} min session`),
    };
  }
  if (training.reason?.trim()) {
    return { id: 'training', domain: 'training', detail: training.reason.trim() };
  }
  return null;
}

function cookingImpact(
  brief: DailyBriefResponse,
  language: Lang,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  if (brief.day.meals.length === 0) return null;
  const firstMeal = brief.day.meals[0];
  const mealCount = brief.day.meals.length;
  return {
    id: 'cooking',
    domain: 'cooking',
    detail: firstMeal.title?.trim()
      || quantifiedLabel(mealCount, language, 'refeição alinhada', 'refeições alinhadas', 'meal aligned', 'meals aligned'),
  };
}

function contentImpact(
  brief: DailyBriefResponse,
  language: Lang,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  const content = brief.day.content;
  if (!content) return null;
  if (content.title?.trim()) {
    return { id: 'content', domain: 'content', detail: content.title.trim() };
  }
  if (content.note?.trim()) {
    return { id: 'content', domain: 'content', detail: content.note.trim() };
  }
  return {
    id: 'content',
    domain: 'content',
    detail: localizePT(language, 'Conteúdo alinhado', 'Content aligned'),
  };
}

function financeImpact(
  brief: DailyBriefResponse,
): DashboardHomeOrchestrationSummary['impacts'][number] | null {
  const finance = brief.day.finance;
  if (!finance) return null;
  const detail = firstRenderable([
    finance.budgetNote,
    finance.taxNote,
    finance.subscriptionNote,
  ]);
  return detail ? { id: 'finance', domain: 'finance', detail } : null;
}

function buildContentHeadline(
  dashboard: DashboardHomeSource,
  brief: DailyBriefResponse | null,
  language: Lang,
): string {
  const content = brief?.day.content;
  if (content?.title?.trim()) return content.title.trim();
  if (content?.status === 'blocked') return localizePT(language, 'Conteúdo bloqueado', 'Content blocked');
  const counts = dashboard.content?.pipelineCount;
  if (!counts) return localizePT(language, 'Nenhuma ideia ainda', 'No ideas yet');
  if ((counts.scripted ?? 0) > 0) {
    return localizePT(language, `${counts.scripted} roteiro${counts.scripted === 1 ? '' : 's'} em andamento`, `${counts.scripted} script${counts.scripted === 1 ? '' : 's'} in progress`);
  }
  if ((counts.ideas ?? 0) > 0) {
    return localizePT(language, `${counts.ideas} ideia${counts.ideas === 1 ? '' : 's'} no radar`, `${counts.ideas} idea${counts.ideas === 1 ? '' : 's'} on the radar`);
  }
  return localizePT(language, 'Nenhuma ideia ainda', 'No ideas yet');
}

function buildContentSubline(
  brief: DailyBriefResponse | null,
  language: Lang,
): string | null {
  const content = brief?.day.content;
  if (!content) return localizePT(language, 'Toque para planear', 'Tap to plan');
  if (content.note?.trim()) return content.note.trim();
  if (content.blockStart && content.blockEnd) return `${content.blockStart}–${content.blockEnd}`;
  switch (content.status) {
    case 'scheduled':
      return localizePT(language, 'Janela pronta para avançar', 'A slot is ready to move forward');
    case 'blocked':
      return localizePT(language, 'Há um bloqueio a resolver antes de avançar', 'There is a blocker to resolve before moving forward');
    default:
      return null;
  }
}

function buildCookingHeadline(
  brief: DailyBriefResponse | null,
  language: Lang,
): string {
  if (!brief || brief.day.meals.length === 0) {
    return localizePT(language, 'Planejar refeições', 'Plan meals');
  }
  return brief.day.meals[0]?.title?.trim()
    || quantifiedLabel(brief.day.meals.length, language, 'refeição alinhada', 'refeições alinhadas', 'meal aligned', 'meals aligned');
}

function buildCookingSubline(brief: DailyBriefResponse | null): string | null {
  if (!brief || brief.day.meals.length === 0) return null;
  return brief.day.meals[0]?.note?.trim() || null;
}

function buildFinanceHeadline(
  brief: DailyBriefResponse | null,
  language: Lang,
): string {
  const finance = brief?.day.finance;
  const note = firstRenderable([
    finance?.budgetNote,
    finance?.taxNote,
    finance?.subscriptionNote,
  ]);
  return note ?? localizePT(language, 'Finanças sob controle', 'Finances under control');
}

function buildFinanceSubline(brief: DailyBriefResponse | null): string | null {
  const finance = brief?.day.finance;
  return firstRenderable([
    finance?.taxNote,
    finance?.subscriptionNote,
  ]);
}

function localizeTrainingTitle(
  briefTitle: string | null | undefined,
  dashboardType: string | null | undefined,
  language: Lang,
): string | null {
  const preferred = briefTitle?.trim() || dashboardType?.trim() || null;
  if (!preferred || !language.startsWith('pt')) return preferred;

  const normalized = preferred.toLowerCase();
  if (normalized === 'rest' || normalized === 'rest day') return 'Descanso';
  if (normalized === 'recovery') return 'Recuperação';

  const trainingSignals = [
    /\blong\s+conditioning\s+session\b/i,
    /\bconditioning\s+session\b/i,
    /\bmobility\s*\+\s*recovery\b/i,
    /\bcore\s+support\b/i,
    /\bkey\s+session\b/i,
    /\bfitness\s+baseline\s+test\b/i,
    /\bno\s+training\b/i,
    /\bupper\s+body\s+strength\b/i,
    /\blower\s+body\s+strength\b/i,
    /\btrack\s+intervals\b/i,
    /\btempo\s+ride\b/i,
    /\btempo\s+run\b/i,
    /\blong\s+run\b/i,
    /\beasy\s+run\b/i,
    /\brecovery\s+swim\b/i,
    /\brecovery\s+ride\b/i,
    /\brecovery\s+run\b/i,
    /\bactive\s+recovery\b/i,
    /\bstrength\b/i,
    /\bgym\b/i,
    /\bcycling\b/i,
    /\bcycle\b/i,
    /\bbike\b/i,
    /\bride\b/i,
    /\bswim\b/i,
    /\brun\b/i,
    /\btraining\b/i,
    /\bworkout\b/i,
    /\bsession\b/i,
    /\bbrick\b/i,
  ];

  if (!trainingSignals.some((pattern) => pattern.test(preferred))) {
    return preferred;
  }

  const patterns: Array<[RegExp, string]> = [
    [/\blong\s+conditioning\s+session\b/gi, 'Sessão longa de condicionamento'],
    [/\bconditioning\s+session\b/gi, 'Sessão de condicionamento'],
    [/\bmobility\s*\+\s*recovery\b/gi, 'Mobilidade + recuperação'],
    [/\bcore\s+support\b/gi, 'Core de suporte'],
    [/\bkey\s+session\b/gi, 'Sessão-chave'],
    [/\bfitness\s+baseline\s+test\b/gi, 'Teste de base física'],
    [/\bno\s+training\b/gi, 'Sem treino'],
    [/\bupper\s+body\s+strength\b/gi, 'Força de tronco superior'],
    [/\blower\s+body\s+strength\b/gi, 'Força de pernas'],
    [/\btrack\s+intervals\b/gi, 'Intervalos de pista'],
    [/\btempo\s+ride\b/gi, 'Treino tempo de bicicleta'],
    [/\btempo\s+run\b/gi, 'Corrida tempo'],
    [/\blong\s+run\b/gi, 'Corrida longa'],
    [/\beasy\s+run\b/gi, 'Corrida fácil'],
    [/\brecovery\s+swim\b/gi, 'Natação de recuperação'],
    [/\brecovery\s+ride\b/gi, 'Bicicleta de recuperação'],
    [/\brecovery\s+run\b/gi, 'Corrida de recuperação'],
    [/\bactive\s+recovery\b/gi, 'Recuperação ativa'],
    [/\bbrick\s+session\b/gi, 'Sessão brick'],
    [/\bupper\s+body\b/gi, 'Tronco superior'],
    [/\blower\s+body\b/gi, 'Pernas'],
    [/\brest\s+day\b/gi, 'Descanso'],
    [/\bstrength\b/gi, 'Força'],
    [/\bgym\b/gi, 'Ginásio'],
    [/\bcycling\b/gi, 'Ciclismo'],
    [/\bcycle\b/gi, 'Ciclismo'],
    [/\bbike\b/gi, 'Bicicleta'],
    [/\bride\b/gi, 'Saída de bicicleta'],
    [/\bswim\b/gi, 'Natação'],
    [/\brun\b/gi, 'Corrida'],
    [/\btraining\b/gi, 'Treino'],
    [/\bworkout\b/gi, 'Treino'],
    [/\bsession\b/gi, 'Sessão'],
  ];

  let localized = preferred;
  for (const [pattern, replacement] of patterns) {
    localized = localized.replace(pattern, replacement);
  }
  return localized.replace(/\b(\d+)\s*[kK]\b/g, '$1 km').replace(/\s{2,}/g, ' ').trim();
}

function quantifiedLabel(
  count: number,
  language: Lang,
  singularPT: string,
  pluralPT: string,
  singularEN: string,
  pluralEN: string,
): string {
  if (language.startsWith('pt')) {
    return `${count} ${count === 1 ? singularPT : pluralPT}`;
  }
  return `${count} ${count === 1 ? singularEN : pluralEN}`;
}

function formatEventRange(start?: string | null, end?: string | null): string {
  if (start && end) return `${start}–${end}`;
  return start ?? end ?? '';
}

function currentLocalMinutes(): number {
  const now = new Date();
  const localized = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: config.app.timezone,
  }).format(now);
  return timeToMinutes(localized) ?? 0;
}

function timeToMinutes(value?: string | null): number | null {
  if (!value) return null;
  const match = value.match(/(\d{2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function firstRenderable(values: Array<string | null | undefined>): string | null {
  return values.map((value) => value?.trim() ?? '').find((value) => value.length > 0) ?? null;
}

function localizePT(language: Lang, pt: string, en: string): string {
  return language.startsWith('pt') ? pt : en;
}

function compactStrings<T>(values: Array<T | null | undefined>): T[] {
  return values.filter((value): value is T => value != null);
}
