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

  it('surfaces kernel-generated guardrail adjustments in weekProtection.kernelAdjustments', () => {
    // The authoritative "what changed and why" lives in the coach-kernel
    // guardrail results. When those are threaded into the view-state
    // input, they appear as ruleId-prefixed lines independent of whether
    // the LLM briefing happens to be fresh — previously this story was
    // only told by the LLM path.
    const state = buildTrainingHomeViewState(baseInput({
      kernelGuardrails: [
        { ruleId: 'readiness', status: 'warn', adjusted: true, message: 'Reduced Monday tempo to recovery run because readiness is critically low.' },
        { ruleId: 'volume_growth', status: 'warn', adjusted: true, message: 'Held week-over-week run volume flat instead of +10% to respect adherence dip.' },
        { ruleId: 'readiness', status: 'pass', adjusted: false, message: 'Readiness within band — no adjustment.' },
      ],
    }), 'pt-BR');

    expect(state.weekProtection?.kernelAdjustments.length).toBe(2);
    expect(state.weekProtection?.kernelAdjustments[0]).toContain('readiness:');
    expect(state.weekProtection?.kernelAdjustments[0]).toContain('recovery run');
    expect(state.weekProtection?.kernelAdjustments[1]).toContain('volume_growth:');
    // pass-status guardrails must NOT appear
    expect(state.weekProtection?.kernelAdjustments.some((line) => line.includes('Readiness within band'))).toBe(false);
  });

  it('falls back to an empty kernelAdjustments array when no kernel data is threaded through', () => {
    // Backward-compat check: callers that don't know about the new
    // kernelGuardrails input still produce a valid contract with an
    // empty list rather than undefined / a type error on the client.
    const state = buildTrainingHomeViewState(baseInput(), 'pt-BR');
    expect(state.weekProtection?.kernelAdjustments).toEqual([]);
  });

  it('classifies stale-Garmin with an active plan as lowConfidence and surfaces the COACH_STALE reason code', () => {
    // Stale-wearable-with-plan is a distinct degraded state. It
    // deliberately falls into 'lowConfidence' (not 'ready' or
    // 'insufficientData') so the UI can render a trust banner AND
    // still show the cached prescription. The COACH_STALE reason
    // code in contract meta signals WHY confidence is low.
    const state = buildTrainingHomeViewState({
      todaySession: null,
      readiness: { score: 68, factors: { sleepScore: 72, hrvStatus: 'normal', bodyBattery: 60 }, recommendation: null },
      coachBriefing: null,
      signals: [],
      weekSessions: [
        { id: 'tue', day: 'Tuesday', type: 'Easy', title: 'Easy Run', time: '07:00', status: 'planned', duration: 30 },
      ],
      weeklyAdherence: 0.6,
      tomorrowSession: null,
      hasActivePlan: true,
      isGarminStale: true,
    }, 'pt-BR');

    expect(state.hero.state).toBe('lowConfidence');
    expect(state.meta.reasonCodes).toContain('COACH_STALE');
    expect(state.meta.isStale).toBe(true);
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

  it('exposes structured confidence=high when both readiness and signals are fresh', () => {
    // This pins the machine-readable contract so the iOS client can
    // drive trust-badge color and analytics buckets from `confidence`
    // directly instead of pattern-matching on the localized label.
    const state = buildTrainingHomeViewState(baseInput({
      signals: [
        {
          id: 1,
          type: 'focus',
          title: 'Focus',
          summary: 'Tight schedule suggests efficient session.',
          priority: 'normal',
          source: 'secretary',
          createdAt: '2026-04-19T06:00:00.000Z',
          expiresAt: '2026-04-19T18:00:00.000Z',
        },
      ],
    }), 'pt-BR');

    expect(state.confidence).toBe('high');
    expect(state.hero.confidenceLabel).toBe('Alta confiança');
  });

  it('falls back to confidence=medium when only one of readiness or signals is present', () => {
    const state = buildTrainingHomeViewState(baseInput({
      signals: [],
    }), 'pt-BR');

    expect(state.confidence).toBe('medium');
    expect(state.hero.confidenceLabel).toBe('Confiança média');
  });

  it('forces confidence=low when Garmin is stale regardless of other signal quality', () => {
    const state = buildTrainingHomeViewState(baseInput({
      isGarminStale: true,
      signals: [
        {
          id: 1,
          type: 'focus',
          title: 'Focus',
          summary: 'Still present.',
          priority: 'normal',
          source: 'secretary',
          createdAt: '2026-04-19T06:00:00.000Z',
          expiresAt: '2026-04-19T18:00:00.000Z',
        },
      ],
    }), 'pt-BR');

    expect(state.confidence).toBe('low');
  });

  it('falls to confidence=low when there is no readiness, no signals, and no briefing', () => {
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

    expect(state.confidence).toBe('low');
  });

  it('surfaces the low-adherence coaching card when weekly adherence is below 60% with a plan', () => {
    // This is a coaching state — not an error state. The user has a
    // plan, they've drifted, and the card's job is to give them one
    // actionable nudge without shaming them.
    const state = buildTrainingHomeViewState(baseInput({
      weeklyAdherence: 0.45,
    }), 'pt-BR');

    expect(state.lowAdherenceCard).not.toBeNull();
    expect(state.lowAdherenceCard?.adherencePercent).toBe(45);
    expect(state.lowAdherenceCard?.tip.length).toBeGreaterThan(0);
    expect(state.lowAdherenceCard?.primaryAction.target).toBe('openWeekPlan');
  });

  it('uses a gentler, reset-focused tip when adherence collapses below 20%', () => {
    const state = buildTrainingHomeViewState(baseInput({
      weeklyAdherence: 0.1,
    }), 'pt-BR');

    expect(state.lowAdherenceCard?.adherencePercent).toBe(10);
    // The lowest tier should frame the next session as "already a win"
    // rather than demanding a specific key session.
    expect(state.lowAdherenceCard?.tip).toContain('vitória');
  });

  it('does not show the low-adherence card when the user is hitting ≥60% adherence', () => {
    const state = buildTrainingHomeViewState(baseInput({
      weeklyAdherence: 0.72,
    }), 'pt-BR');

    expect(state.lowAdherenceCard).toBeNull();
  });

  it('suppresses the low-adherence card when there is no active plan to drift from', () => {
    const state = buildTrainingHomeViewState({
      todaySession: null,
      readiness: null,
      coachBriefing: null,
      signals: [],
      weekSessions: [],
      weeklyAdherence: 0.1,
      tomorrowSession: null,
      hasActivePlan: false,
      isGarminStale: false,
    }, 'pt-BR');

    expect(state.lowAdherenceCard).toBeNull();
  });

  it('suppresses the low-adherence card on a completed-day read', () => {
    // Not useful to tell a user their week adherence is low on a day
    // they just completed a session — timing is wrong.
    const state = buildTrainingHomeViewState(baseInput({
      weeklyAdherence: 0.3,
      todaySession: {
        id: 'done',
        type: 'Tempo Run',
        sessionType: 'running',
        time: '07:00',
        duration: 42,
        status: 'completed',
      },
    }), 'pt-BR');

    expect(state.lowAdherenceCard).toBeNull();
  });

  it('exposes null original/adapted prescription on the hero when the input has none', () => {
    // Backward-compat pin: the prescription pair is additive. Callers
    // that don't know to provide it should still produce a valid hero.
    const state = buildTrainingHomeViewState(baseInput(), 'pt-BR');
    expect(state.hero.originalPrescription).toBeNull();
    expect(state.hero.adaptedPrescription).toBeNull();
  });

  it('surfaces identical original/adapted prescription when the coach did not adapt today', () => {
    // Sunny-day case: readiness is green, no fatigue re-run, so both
    // fields point at the same prescription — the client can collapse
    // into a single "today is X" line.
    const same = {
      title: 'Tempo Run',
      detail: '42 min · threshold',
      durationMinutes: 42,
      sessionType: 'threshold_run',
    };
    const state = buildTrainingHomeViewState(baseInput({
      todayOriginalPrescription: same,
      todayAdaptedPrescription: same,
    }), 'pt-BR');

    expect(state.hero.originalPrescription).toEqual(same);
    expect(state.hero.adaptedPrescription).toEqual(same);
  });

  it('surfaces differing original/adapted prescription when fatigue adjustment changed today', () => {
    // The core Structural #6 behavior: when the coach downgrades today
    // because of poor recovery, both prescriptions must survive the
    // round-trip so the UI can say "was Long Run 90min, now Recovery
    // Run 30min".
    const state = buildTrainingHomeViewState(baseInput({
      todayOriginalPrescription: {
        title: 'Long Run',
        detail: '90 min · endurance',
        durationMinutes: 90,
        sessionType: 'long_run',
      },
      todayAdaptedPrescription: {
        title: 'Recovery Run',
        detail: '30 min · recovery',
        durationMinutes: 30,
        sessionType: 'recovery_run',
      },
    }), 'pt-BR');

    expect(state.hero.originalPrescription?.title).toBe('Long Run');
    expect(state.hero.adaptedPrescription?.title).toBe('Recovery Run');
    expect(state.hero.originalPrescription?.durationMinutes).toBe(90);
    expect(state.hero.adaptedPrescription?.durationMinutes).toBe(30);
  });

  it('keeps confidence label and level in sync across localizations', () => {
    // Regression pin: a refactor that forks the label from the level
    // would desynchronize presentation from analytics. We pick en-US
    // here so a future translation drift shows up.
    const state = buildTrainingHomeViewState(baseInput(), 'en-US');

    expect(state.confidence).toBe('medium');
    expect(state.hero.confidenceLabel).toBe('Medium confidence');
  });

  // ── Gap 6: provider-truthful degraded copy ───────────────────────
  //
  // The adjustmentSummary (internal) surfaces as the `reasoning.summary`
  // string. We assert on that surface because it's what iOS renders.

  describe('Gap 6 — degraded copy does not lie about Garmin', () => {
    it('uses Garmin-specific "until Garmin syncs again" copy ONLY when Garmin is genuinely stale', () => {
      const state = buildTrainingHomeViewState(baseInput({
        isGarminStale: true,
        coachBriefing: {
          briefing: 'Stale snapshot.',
          recommendations: [],
          garminData: null,
          degraded: true,
        },
      }), 'en-US');

      expect(state.reasoning?.summary).toMatch(/Garmin syncs again/i);
    });

    it('uses provider-agnostic copy when briefing is degraded but Garmin is NOT stale (Gmail-only user)', () => {
      const state = buildTrainingHomeViewState(baseInput({
        // Caller (training-home-payload.ts) gates isGarminStale on
        // `isGarminActivelyIntegrated`; for a user without Garmin it stays
        // false even when coachBriefing is degraded.
        isGarminStale: false,
        coachBriefing: {
          briefing: 'Cached briefing.',
          recommendations: [],
          garminData: null,
          degraded: true,
        },
      }), 'en-US');

      expect(state.reasoning?.summary ?? '').not.toMatch(/Garmin/i);
      expect(state.reasoning?.summary ?? '').toMatch(/signals recover/i);
    });

    it('uses provider-agnostic copy on cachedOnlyMiss without Garmin', () => {
      const state = buildTrainingHomeViewState(baseInput({
        isGarminStale: false,
        coachBriefing: {
          briefing: 'Cached briefing.',
          recommendations: [],
          garminData: null,
          degraded: false,
          cachedOnlyMiss: true,
        },
      }), 'en-US');

      expect(state.reasoning?.summary ?? '').not.toMatch(/Garmin/i);
    });
  });
});
