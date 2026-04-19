import { describe, expect, it } from 'vitest';
import { buildTrainingHomeViewState, type TrainingHomeViewStateInput } from '../../src/services/training-home-view-state';

function baseInput(overrides: Partial<TrainingHomeViewStateInput> = {}): TrainingHomeViewStateInput {
  return {
    todaySession: {
      id: 'today',
      type: 'Força + Core Support',
      sessionType: 'strength',
      time: '06:30',
      duration: 40,
      status: 'planned',
      exercises: [{ name: 'Split squat' }],
    },
    readiness: {
      score: 74,
      factors: {
        sleepScore: 76,
        hrvStatus: 'normal',
        bodyBattery: 68,
      },
      recommendation: 'Stay on plan.',
    },
    coachBriefing: null,
    signals: [],
    weekSessions: [
      { id: 'sun', day: 'Sunday', type: 'Long Run', title: 'Long Run', time: '07:00', status: 'planned', duration: 90 },
      { id: 'mon', day: 'Monday', type: 'Recovery', title: 'Recovery', time: '07:30', status: 'planned', duration: 30 },
      { id: 'tue', day: 'Tuesday', type: 'Tempo Run', title: 'Tempo Run', time: '07:00', status: 'planned', duration: 42 },
    ],
    weeklyAdherence: 0.72,
    tomorrowSession: { id: 'mon', day: 'Monday', type: 'Recovery', title: 'Recovery', time: '07:30', status: 'planned', duration: 30 },
    hasActivePlan: true,
    isGarminStale: false,
    ...overrides,
  };
}

describe('buildTrainingHomeViewState', () => {
  it('marks recovery when low readiness pushes caution', () => {
    const state = buildTrainingHomeViewState(baseInput({
      readiness: {
        score: 49,
        factors: {
          sleepScore: 58,
          hrvStatus: 'low',
          bodyBattery: 32,
        },
        recommendation: 'Below baseline — reduce volume by ~25% or swap for easy session.',
      },
    }), 'pt-BR');

    expect(state.hero.state).toBe('recovery');
    expect(state.meta.source).toBe('server');
    expect(state.meta.isFallback).toBe(false);
    expect(state.hero.primaryAction.target).toBe('completeSession');
    expect(state.hero.secondaryAction?.target).toBe('skipSession');
    expect(state.reasoning?.signals.length).toBeGreaterThanOrEqual(1);
  });

  it('marks no-plan state and promotes create-plan CTA', () => {
    const state = buildTrainingHomeViewState({
      todaySession: null,
      readiness: null,
      coachBriefing: null,
      signals: [],
      weekSessions: [],
      weeklyAdherence: 0,
      tomorrowSession: null,
      hasActivePlan: false,
      isGarminStale: false,
    }, 'pt-BR');

    expect(state.hero.state).toBe('noPlan');
    expect(state.hero.primaryAction.target).toBe('createPlan');
    expect(state.emptyState?.action.target).toBe('createPlan');
  });

  it('keeps no-plan state even when there is only a standalone calendar workout today', () => {
    const state = buildTrainingHomeViewState({
      todaySession: {
        id: 'calendar-today',
        type: '🧘 Rest Day — Mobility + Recovery (NO TRAINING)',
        sessionType: null,
        time: '08:00',
        duration: 30,
        status: 'planned',
      },
      readiness: null,
      coachBriefing: null,
      signals: [],
      weekSessions: [],
      weeklyAdherence: 0,
      tomorrowSession: null,
      hasActivePlan: false,
      isGarminStale: false,
    }, 'pt-BR');

    expect(state.hero.state).toBe('noPlan');
    expect(state.hero.title).toBe('Ainda sem plano de treino');
    expect(state.hero.primaryAction.target).toBe('createPlan');
    expect(state.weekProtection).toBeNull();
  });

  it('marks completed day and promotes week follow-through', () => {
    const state = buildTrainingHomeViewState(baseInput({
      todaySession: {
        id: 'done',
        type: 'Tempo Run',
        sessionType: 'running',
        time: '07:00',
        duration: 42,
        status: 'completed',
      },
    }), 'pt-BR');

    expect(state.hero.state).toBe('completed');
    expect(state.hero.primaryAction.target).toBe('openWeekPlan');
    expect(state.hero.secondaryAction).toBeNull();
  });

  it('surfaces original and adjusted prescription in week protection', () => {
    const state = buildTrainingHomeViewState(baseInput({
      coachBriefing: {
        briefing: 'Hoje protegemos a semana.',
        recommendations: [
          {
            action: 'MODIFY',
            eventId: 'evt-1',
            source: 'coach',
            originalTitle: 'Long Run',
            newTitle: 'Tempo Run',
            summary: 'Troca a sessão para proteger a semana.',
            reason: 'Recuperação baixa',
          },
        ],
      },
    }), 'pt-BR');

    expect(state.weekProtection?.changedFrom).toBe('Corrida longa');
    expect(state.weekProtection?.changedTo).toBe('Corrida tempo');
  });

  it('builds a coach review with actionable recommendations when briefing exists', () => {
    const state = buildTrainingHomeViewState(baseInput({
      coachBriefing: {
        briefing: 'Há uma troca clara para proteger a semana.',
        recommendations: [
          {
            action: 'MODIFY',
            eventId: 'evt-1',
            source: 'coach',
            originalTitle: 'Long Run',
            newTitle: 'Tempo Run',
            summary: 'Troca a corrida longa por uma corrida tempo mais curta.',
            reason: 'Recuperação baixa hoje.',
          },
        ],
      },
    }), 'pt-BR');

    expect(state.coachReview?.state).toBe('ready');
    expect(state.coachReview?.primaryAction.target).toBe('applyCoachRecommendations');
    expect(state.coachReview?.summary).toContain('Troca a corrida longa');
  });

  it('builds a refresh-oriented coach review when no briefing exists yet', () => {
    const state = buildTrainingHomeViewState(baseInput({
      coachBriefing: null,
      signals: [
        {
          id: 1,
          type: 'low_sleep',
          title: 'Low sleep',
          summary: 'Sleep score 61',
          priority: 'normal',
          source: 'garmin',
          createdAt: '2026-04-19T06:00:00.000Z',
          expiresAt: '2026-04-19T18:00:00.000Z',
        },
      ],
    }), 'pt-BR');

    expect(state.coachReview?.state).toBe('needsRefresh');
    expect(state.coachReview?.primaryAction.target).toBe('refreshCoach');
  });

  it('marks low confidence when the read is degraded', () => {
    const state = buildTrainingHomeViewState(baseInput({
      isGarminStale: true,
    }), 'pt-BR');

    expect(state.hero.state).toBe('lowConfidence');
    expect(state.meta.isStale).toBe(true);
    expect(state.meta.reasonCodes).toEqual(['COACH_STALE']);
    expect(state.hero.primaryAction.target).toBe('refreshCoach');
    expect(state.emptyState?.action.target).toBe('refreshCoach');
  });

  it('keeps explicit meta when the route already derived a partial server contract', () => {
    const state = buildTrainingHomeViewState(baseInput({
      meta: {
        source: 'server',
        isFallback: true,
        isPartial: true,
        isStale: true,
        generatedAt: '2026-04-19T10:00:00.000Z',
        reasonCodes: ['READINESS_UNAVAILABLE', 'COACH_STALE'],
      },
    }), 'pt-BR');

    expect(state.meta.isFallback).toBe(true);
    expect(state.meta.isPartial).toBe(true);
    expect(state.meta.reasonCodes).toEqual(['READINESS_UNAVAILABLE', 'COACH_STALE']);
  });

  it('marks conflicting schedule when overlapping sessions exist in the planned week', () => {
    const state = buildTrainingHomeViewState(baseInput({
      weekSessions: [
        { id: 'mon-1', day: 'Monday', type: 'Strength', title: 'Strength', time: '07:00', status: 'planned', duration: 60 },
        { id: 'mon-2', day: 'Monday', type: 'Tempo Run', title: 'Tempo Run', time: '07:30', status: 'planned', duration: 45 },
      ],
    }), 'pt-BR');

    expect(state.hero.state).toBe('conflictingSchedule');
    expect(state.hero.primaryAction.target).toBe('openWeekPlan');
  });

  it('prefers plan title and localizes newer session vocabulary', () => {
    const state = buildTrainingHomeViewState(baseInput({
      todaySession: {
        id: 'today-bike',
        type: 'Bike',
        sessionType: 'cycling',
        time: '06:30',
        duration: 60,
        status: 'planned',
      },
      weekSessions: [
        { id: 'sun', day: 'Sunday', type: 'Bike', title: 'Long Conditioning Session', sessionType: 'cycling', time: '07:00', status: 'planned', duration: 90 },
      ],
      tomorrowSession: { id: 'sun', day: 'Sunday', type: 'Bike', title: 'Long Conditioning Session', sessionType: 'cycling', time: '07:00', status: 'planned', duration: 90 },
    }), 'pt-BR');

    expect(state.hero.title).toBe('Bicicleta');
    expect(state.weekJourney?.days[0]?.title).toBe('Sessão longa de condicionamento');
    expect(state.weekProtection?.impactLines[0]).toContain('Sessão longa de condicionamento');
  });
});
