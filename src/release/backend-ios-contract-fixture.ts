// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { buildContentHomeViewState } from '../services/content-home-view-state';
import { buildDashboardHomeViewState } from '../services/dashboard-home-view-state';
import { buildTrainingHomeViewState } from '../services/training-home-view-state';
import { buildTrainingPlanGenerationResponseDiscriminator } from '../api/routes/training-plan-generation-response-contract';
import { resolveTrainingPlanClarificationResolution } from '../services/training-plan-clarification-registry';
import type { ScreenContractMeta } from '../services/screen-contract-meta';

export const BACKEND_IOS_CONTRACT_FIXTURE_SCHEMA = 'nexus.backend-ios-contract-fixtures.v1';

const stableMeta: ScreenContractMeta = {
  source: 'server',
  isFallback: false,
  isPartial: false,
  isStale: false,
  generatedAt: '2026-07-01T12:00:00.000Z',
  reasonCodes: [],
};

/**
 * Build deterministic, release-bound examples through the same pure builders
 * used by the production read routes. The RC bundle stores the resulting JSON;
 * iOS decodes those exact bytes before its protected signer can attest
 * compatibility.
 */
export function buildBackendIosContractFixture() {
  const dashboardHome = buildDashboardHomeViewState({
    readinessScore: 74,
    bodyBattery: 62,
    tasksDue: 1,
    overdueTasks: 0,
    eventsCount: 2,
    nextEventTitle: 'Editorial review',
    nextEventTime: '10:00',
    nextEventSource: 'Outlook',
    hasCalendarUnavailable: false,
    trainingTitle: 'Recovery run',
    trainingTime: '07:00',
    trainingDurationMinutes: 40,
    trainingStatus: 'ready',
    contentHeadline: 'One script ready',
    contentSubline: 'Recording window on Friday',
    cookingHeadline: 'Recovery bowl',
    cookingSubline: 'Lunch today',
    financeHeadline: 'Monthly review ready',
    financeSubline: 'No action required',
    orchestrationSummary: null,
    warningMessages: [],
    secretaryItems: [{
      id: 'fixture-event-1',
      time: '10:00–10:30',
      title: 'Editorial review',
      source: 'Outlook',
      isNow: false,
      isPast: false,
    }],
    secretarySummary: 'Editorial review at 10:00',
    meta: stableMeta,
  }, 'en-US');

  const trainingHome = buildTrainingHomeViewState({
    todaySession: {
      id: 'fixture-session-1',
      type: 'Recovery Run',
      sessionType: 'recovery_run',
      time: '07:00',
      duration: 40,
      status: 'planned',
      exercises: [],
    },
    readiness: {
      score: 74,
      factors: { sleepScore: 76, hrvStatus: 'normal', bodyBattery: 68 },
      recommendation: 'Stay on plan.',
      source: 'garmin',
    },
    coachBriefing: null,
    signals: [],
    weekSessions: [{
      id: 'fixture-session-1',
      day: 'Monday',
      type: 'Recovery Run',
      title: 'Recovery Run',
      sessionType: 'recovery_run',
      time: '07:00',
      status: 'planned',
      duration: 40,
      exercises: [],
    }],
    weeklyAdherence: 0.8,
    tomorrowSession: null,
    hasActivePlan: true,
    isGarminStale: false,
    kernelGuardrails: [],
    meta: stableMeta,
  }, 'en-US');

  const contentHome = buildContentHomeViewState({
    pipeline: {
      stages: {
        ideas: [],
        scripted: [{ title: 'Release-bound contract evidence' }],
        filmed: [],
        editing: [],
        published: [],
      },
    },
    ideas: [],
    topics: [],
    discovery: null,
    script: { voicePatternCount: 3, hasBrandVoice: true },
    optimization: null,
    filmingRecommendation: {
      date: '2026-07-03',
      confidence: 'high',
      localizedReason: 'The next recording window is protected.',
      localizedConfidenceLabel: 'High confidence',
    },
    hasAttemptedLoad: true,
    lastLoadError: null,
    meta: stableMeta,
  }, 'en-US');

  const createdPlan = {
    ...buildTrainingPlanGenerationResponseDiscriminator('created'),
    planId: 9001,
    planName: 'Release-bound hybrid plan',
    sport: 'hybrid',
    objective: 'Build durable strength and running fitness',
    durationWeeks: 8,
    resolvedStartDate: '2026-07-06',
    calendarSource: 'google',
    totalSessions: 32,
    eventsCreated: 0,
    calendarSync: {
      provider: 'google',
      sessionsAttempted: 32,
      eventsCreated: 0,
      sessionsLinked: 0,
      sessionsFailed: 0,
      unscheduled: 0,
      status: 'not_synced',
      pending: true,
    },
    volumeShortfalls: [],
    warnings: [],
    fallbackTemplateUsed: false,
    goalMode: 'continuous',
    trainingPriority: 'balanced',
    raceDate: null,
  } as const;

  const equipmentResolution = resolveTrainingPlanClarificationResolution(
    'equipment_clarification',
  );
  if (!equipmentResolution) {
    throw new Error('release-bound equipment clarification resolution is missing');
  }
  const needsClarification = {
    ...buildTrainingPlanGenerationResponseDiscriminator('needs_clarification'),
    message: 'Nexus needs your available equipment before saving this plan.',
    specReadiness: {
      status: 'needs_clarification',
      issues: [{
        id: 'equipment_clarification',
        severity: 'blocker',
        question: 'What equipment can you use for strength sessions?',
        reason: 'The plan cannot select safe strength exercises without declared equipment.',
        resolution: equipmentResolution,
      }],
    },
    clarificationIssues: [{
      id: 'equipment_clarification',
      severity: 'blocker',
      question: 'What equipment can you use for strength sessions?',
      reason: 'The plan cannot select safe strength exercises without declared equipment.',
      resolution: equipmentResolution,
    }],
    suggestedQuestions: ['What equipment can you use for strength sessions?'],
    fallbackTemplateUsed: false,
    decisionReasons: [],
    goalMode: 'continuous',
    trainingPriority: 'balanced',
    raceDate: null,
  } as const;

  const generationAttemptStatus = {
    schemaVersion: 'training_plan_generation_attempt_status.v1',
    state: 'created',
    recovery: 'use_created_plan',
    canStartNew: false,
    planId: 9001,
  } as const;

  return {
    schema: BACKEND_IOS_CONTRACT_FIXTURE_SCHEMA,
    contracts: [
      {
        id: 'dashboard.home.v1',
        method: 'GET',
        path: '/api/v1/dashboard/home',
        decoder: 'HomeViewState',
        payload: dashboardHome,
      },
      {
        id: 'training.home.v1',
        method: 'GET',
        path: '/api/v1/training/home',
        decoder: 'TrainingHomeViewState',
        payload: trainingHome,
      },
      {
        id: 'content.home.v1',
        method: 'GET',
        path: '/api/v1/content/home',
        decoder: 'ContentHomeViewState',
        payload: contentHome,
      },
      {
        id: 'training.plan.generate.created.v1',
        method: 'POST',
        path: '/api/v1/training/plan/generate',
        decoder: 'PlanGenerateResponse',
        payload: createdPlan,
      },
      {
        id: 'training.plan.generate.needs-clarification.v1',
        method: 'POST',
        path: '/api/v1/training/plan/generate',
        decoder: 'PlanGenerateResponse',
        payload: needsClarification,
      },
      {
        id: 'training.plan.generation-attempt-status.created.v1',
        method: 'POST',
        path: '/api/v1/training/plan/generation-attempt/status',
        decoder: 'TrainingPlanGenerationAttemptStatus',
        payload: generationAttemptStatus,
      },
    ],
  } as const;
}
