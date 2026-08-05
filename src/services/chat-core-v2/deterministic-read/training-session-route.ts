// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getActivePlan,
  getSessionsForWeek,
  getWeeklyAdherence,
  getWeeksForPlan,
  type TrainingPlan,
  type TrainingSession,
  type TrainingWeek,
  type WeeklyAdherenceStats,
} from '../../training-plans';
import { evaluateChatCoreV2TrainingSafetyPolicy } from '../training-safety-policy';
import {
  buildChatCoreV2ReadContextPack,
  buildChatCoreV2ReadModelResult,
  isReadModelFreshEnough,
} from '../read-models';
import {
  buildChatCoreV2MessageResponse,
  normalizeChatCoreV2Locale,
} from '../response-contracts';
import {
  MAX_VISIBLE_TRAINING_SESSIONS,
  TRAINING_SESSION_EXPLAIN_CAPABILITY,
  hashStable,
} from './common';
import { joinParts, plural, type ChatCoreV2NormalizedLocale } from './copy';
import type { ChatCoreV2ShadowRouteGuess } from '../shadow-route-classifier';
import type {
  BuildChatCoreV2DeterministicReadRouteInput,
  ChatCoreV2DeterministicReadRouteResult,
  ChatCoreV2TrainingSessionExplainData,
  ChatCoreV2TrainingSessionSummaryItem,
} from './types';

const INACTIVE_SESSION_STATUSES = new Set([
  'rest',
  'unscheduled',
  'deferred',
  'dropped',
  'cancelled',
  'superseded',
]);

export function buildTrainingSessionExplainRoute(
  input: BuildChatCoreV2DeterministicReadRouteInput,
  routeGuess: ChatCoreV2ShadowRouteGuess,
): ChatCoreV2DeterministicReadRouteResult | null {
  const now = input.now ?? new Date();
  const policy = evaluateChatCoreV2TrainingSafetyPolicy({
    operation: 'read',
    changeTypes: ['explain_session'],
    affectedSessionCount: 0,
  });
  if (!policy.ok) return null;

  const plan = getActivePlan(input.userId, input.tenantId);
  const weeks = plan ? getWeeksForPlan(plan.id) : [];
  const currentWeek = plan ? currentWeekForPlan(plan, weeks, now) : null;
  const sessions = currentWeek ? getSessionsForWeek(currentWeek.id) : [];
  const adherence = plan && currentWeek ? getWeeklyAdherence(plan.id, currentWeek.id) : null;
  const data = buildTrainingSessionExplainData(plan, currentWeek, sessions, adherence);
  const sourceEntityIds = sourceEntityIdsForTraining(plan, data.topSessions);
  const readModel = buildChatCoreV2ReadModelResult<ChatCoreV2TrainingSessionExplainData>({
    capabilityId: TRAINING_SESSION_EXPLAIN_CAPABILITY,
    domain: 'training',
    data,
    sourceEntityIds,
    sourceVersions: sourceVersionsForTraining(plan, currentWeek, sessions, adherence),
    generatedAt: now.toISOString(),
    maxSourceAgeSeconds: 60,
    sensitivity: 'health_adjacent',
    summary: buildTrainingSessionExplainText(data, input.locale),
    locale: normalizeChatCoreV2Locale(input.locale),
    now,
  });
  if (!isReadModelFreshEnough(readModel)) return null;

  const contextPack = buildChatCoreV2ReadContextPack([readModel], { generatedAt: now.toISOString() });
  const response = buildChatCoreV2MessageResponse({
    text: readModel.summary ?? buildTrainingSessionExplainText(data, input.locale),
    locale: input.locale,
    reasonCodes: ['deterministic_read', TRAINING_SESSION_EXPLAIN_CAPABILITY, ...policy.reasons],
  });

  return {
    capabilityId: TRAINING_SESSION_EXPLAIN_CAPABILITY,
    routeGuess,
    readModel,
    contextPack,
    response,
  };
}

function buildTrainingSessionExplainData(
  plan: TrainingPlan | null,
  currentWeek: TrainingWeek | null,
  sessions: TrainingSession[],
  adherence: WeeklyAdherenceStats | null,
): ChatCoreV2TrainingSessionExplainData {
  const activeSessions = sessions.filter((session) => !INACTIVE_SESSION_STATUSES.has(normalizeStatus(session.status)));
  const topSessions = activeSessions
    .map(toSessionSummaryItem)
    .slice(0, MAX_VISIBLE_TRAINING_SESSIONS);

  return {
    hasActivePlan: plan != null,
    planName: plan?.name ?? null,
    sport: plan?.sport ?? null,
    goal: plan?.goal ?? null,
    durationWeeks: plan?.duration_weeks ?? null,
    currentWeekNumber: currentWeek?.week_number ?? null,
    currentWeekFocus: currentWeek?.focus ?? null,
    currentWeekIntensityPct: currentWeek?.intensity_pct ?? null,
    adherenceRate: adherence?.adherenceRate ?? null,
    completedSessions: adherence?.completedSessions ?? activeSessions.filter((session) => normalizeStatus(session.status) === 'completed').length,
    partialSessions: adherence?.partialSessions ?? activeSessions.filter((session) => normalizeStatus(session.status) === 'partial').length,
    skippedSessions: adherence?.skippedSessions ?? activeSessions.filter((session) => normalizeStatus(session.status) === 'skipped').length,
    pendingSessions: adherence?.pendingSessions ?? activeSessions.filter((session) => !['completed', 'partial', 'skipped'].includes(normalizeStatus(session.status))).length,
    totalSessions: adherence?.totalSessions ?? activeSessions.length,
    topSessions,
  };
}

function toSessionSummaryItem(session: TrainingSession): ChatCoreV2TrainingSessionSummaryItem {
  return {
    entityId: trainingSessionEntityId(session.id),
    title: session.title,
    dayOfWeek: session.day_of_week,
    sessionType: session.session_type,
    status: normalizeStatus(session.status),
    durationMinutes: session.duration_minutes,
    intensityText: session.intensity_text,
  };
}

function buildTrainingSessionExplainText(
  data: ChatCoreV2TrainingSessionExplainData,
  locale: string | null | undefined,
): string {
  const normalizedLocale = normalizeChatCoreV2Locale(locale);
  if (!data.hasActivePlan) {
    if (normalizedLocale === 'pt-BR') return 'Você ainda não tem um plano de treino ativo.';
    if (normalizedLocale === 'pt-PT') return 'Ainda não tens um plano de treino ativo.';
    return 'You do not have an active training plan yet.';
  }

  const header = buildTrainingHeader(data, normalizedLocale);
  if (data.topSessions.length === 0) return header;
  const sessionLines = data.topSessions.map((session) => `- ${session.title}${sessionSuffix(session, normalizedLocale)}`);
  return `${header}\n\n${sessionListLabel(normalizedLocale)}\n${sessionLines.join('\n')}`;
}

function buildTrainingHeader(
  data: ChatCoreV2TrainingSessionExplainData,
  locale: ChatCoreV2NormalizedLocale,
): string {
  const planName = data.planName ?? trainingFallback(locale, 'plan');
  const weekText = data.currentWeekNumber != null && data.durationWeeks != null
    ? weekPhrase(data.currentWeekNumber, data.durationWeeks, locale)
    : null;
  const sessionText = sessionCountPhrase(data.totalSessions, locale);
  const statusParts: string[] = [];
  if (data.completedSessions > 0) statusParts.push(progressPhrase(data.completedSessions, locale, 'completed'));
  if (data.partialSessions > 0) statusParts.push(progressPhrase(data.partialSessions, locale, 'partial'));
  if (data.pendingSessions > 0) statusParts.push(progressPhrase(data.pendingSessions, locale, 'pending'));
  if (data.skippedSessions > 0) statusParts.push(progressPhrase(data.skippedSessions, locale, 'skipped'));
  if (data.adherenceRate != null) statusParts.push(adherencePhrase(data.adherenceRate, locale));
  const statusText = statusParts.length > 0 ? ` ${joinParts(statusParts, locale)}.` : '';
  const focus = data.currentWeekFocus ? focusPhrase(data.currentWeekFocus, locale) : null;
  const intensity = data.currentWeekIntensityPct != null ? intensityPhrase(data.currentWeekIntensityPct, locale) : null;
  const descriptors = [weekText, focus, intensity].filter((part): part is string => Boolean(part));
  const descriptorText = descriptors.length > 0 ? ` ${joinParts(descriptors, locale)}.` : '';

  if (locale === 'pt-BR') return `Plano de treino: ${planName}. Esta semana tem ${sessionText}.${descriptorText}${statusText}`;
  if (locale === 'pt-PT') return `Plano de treino: ${planName}. Esta semana tem ${sessionText}.${descriptorText}${statusText}`;
  return `Training plan: ${planName}. This week has ${sessionText}.${descriptorText}${statusText}`;
}

function sessionCountPhrase(count: number, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return `${count} ${plural(count, 'sessão', 'sessões')}`;
  return `${count} ${plural(count, 'session', 'sessions')}`;
}

function progressPhrase(
  count: number,
  locale: ChatCoreV2NormalizedLocale,
  kind: 'completed' | 'partial' | 'pending' | 'skipped',
): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') {
    if (kind === 'completed') return `${count} ${plural(count, 'concluída', 'concluídas')}`;
    if (kind === 'partial') return `${count} ${plural(count, 'parcial', 'parciais')}`;
    if (kind === 'skipped') return `${count} ${plural(count, 'saltada', 'saltadas')}`;
    return `${count} ${plural(count, 'pendente', 'pendentes')}`;
  }
  if (kind === 'completed') return `${count} completed`;
  if (kind === 'partial') return `${count} partial`;
  if (kind === 'skipped') return `${count} skipped`;
  return `${count} pending`;
}

function weekPhrase(week: number, durationWeeks: number, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return `semana ${week}/${durationWeeks}`;
  return `week ${week}/${durationWeeks}`;
}

function focusPhrase(focus: string, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return `foco: ${focus}`;
  return `focus: ${focus}`;
}

function intensityPhrase(intensityPct: number, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return `intensidade ${intensityPct}%`;
  return `${intensityPct}% intensity`;
}

function adherencePhrase(adherenceRate: number, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR' || locale === 'pt-PT') return `${adherenceRate}% de adesão`;
  return `${adherenceRate}% adherence`;
}

function sessionListLabel(locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'pt-BR') return 'Sessões principais:';
  if (locale === 'pt-PT') return 'Sessões principais:';
  return 'Key sessions:';
}

function sessionSuffix(
  session: ChatCoreV2TrainingSessionSummaryItem,
  locale: ChatCoreV2NormalizedLocale,
): string {
  const parts = [
    localizeDay(session.dayOfWeek, locale),
    session.sessionType,
    session.durationMinutes != null ? durationPhrase(session.durationMinutes, locale) : null,
    session.intensityText,
    statusLabel(session.status, locale),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function durationPhrase(minutes: number, _locale: ChatCoreV2NormalizedLocale): string {
  return `${minutes} min`;
}

function statusLabel(status: string, locale: ChatCoreV2NormalizedLocale): string | null {
  if (status === 'pending' || status === 'scheduled' || status === 'reflowed' || status === 'moved') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return 'por fazer';
    return 'pending';
  }
  if (status === 'completed') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return 'concluída';
    return 'completed';
  }
  if (status === 'partial') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return 'parcial';
    return 'partial';
  }
  if (status === 'skipped') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return 'saltada';
    return 'skipped';
  }
  return null;
}

function localizeDay(day: string, locale: ChatCoreV2NormalizedLocale): string {
  if (locale === 'en') return day;
  const normalized = day.toLowerCase();
  const pt: Record<string, string> = {
    monday: 'segunda',
    tuesday: 'terça',
    wednesday: 'quarta',
    thursday: 'quinta',
    friday: 'sexta',
    saturday: 'sábado',
    sunday: 'domingo',
  };
  return pt[normalized] ?? day;
}

function trainingFallback(locale: ChatCoreV2NormalizedLocale, kind: 'plan'): string {
  if (kind === 'plan') {
    if (locale === 'pt-BR' || locale === 'pt-PT') return 'plano ativo';
  }
  return 'active plan';
}

function currentWeekForPlan(plan: TrainingPlan, weeks: TrainingWeek[], now: Date): TrainingWeek | null {
  if (weeks.length === 0) return null;
  const currentWeekNumber = currentWeekNumberForPlan(plan, now);
  return weeks.find((week) => week.week_number === currentWeekNumber)
    ?? weeks.find((week) => week.week_number === 1)
    ?? weeks[0]
    ?? null;
}

function currentWeekNumberForPlan(plan: TrainingPlan, now: Date): number {
  const start = new Date(`${plan.start_date}T00:00:00.000Z`);
  const durationWeeks = Math.max(1, plan.duration_weeks || 1);
  if (!Number.isFinite(start.getTime())) return 1;
  const diffMs = now.getTime() - start.getTime();
  const rawWeek = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;
  return Math.min(Math.max(1, rawWeek), durationWeeks);
}

function sourceEntityIdsForTraining(
  plan: TrainingPlan | null,
  sessions: ChatCoreV2TrainingSessionSummaryItem[],
): string[] {
  const ids = plan ? [trainingPlanEntityId(plan.id)] : [];
  return [...ids, ...sessions.map((session) => session.entityId)];
}

function sourceVersionsForTraining(
  plan: TrainingPlan | null,
  currentWeek: TrainingWeek | null,
  sessions: TrainingSession[],
  adherence: WeeklyAdherenceStats | null,
): Record<string, string> {
  const versions: Record<string, string> = {};
  if (plan) {
    versions[trainingPlanEntityId(plan.id)] = hashStable({
      name: plan.name,
      sport: plan.sport,
      goal: plan.goal,
      durationWeeks: plan.duration_weeks,
      status: plan.status,
      startDate: plan.start_date,
      endDate: plan.end_date,
      planVersion: plan.plan_version,
      updatedAt: plan.updated_at,
      currentWeek: currentWeek ? {
        weekNumber: currentWeek.week_number,
        focus: currentWeek.focus,
        intensityPct: currentWeek.intensity_pct,
        autoAdjusted: currentWeek.auto_adjusted,
      } : null,
      adherence,
    });
  }
  for (const session of sessions) {
    if (INACTIVE_SESSION_STATUSES.has(normalizeStatus(session.status))) continue;
    versions[trainingSessionEntityId(session.id)] = hashStable({
      title: session.title,
      dayOfWeek: session.day_of_week,
      sessionType: session.session_type,
      durationMinutes: session.duration_minutes,
      intensityText: session.intensity_text,
      status: session.status,
      sessionShapeHash: session.session_shape_hash,
    });
  }
  return versions;
}

function trainingPlanEntityId(planId: number): string {
  return `training_plan:${planId}`;
}

function trainingSessionEntityId(sessionId: number): string {
  return `training_session:${sessionId}`;
}

function normalizeStatus(status: unknown): string {
  return String(status || 'pending').trim().toLowerCase();
}
