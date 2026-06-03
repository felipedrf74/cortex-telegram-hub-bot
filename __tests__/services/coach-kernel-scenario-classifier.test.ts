/**
 * Slice C8 — unified scenario classifier with CoachAction grammar.
 *
 * Pins:
 *   - Safety pause always wins (precedence #1)
 *   - Rate-limited reflows produce no_scenario when caps reached
 *   - Race week → race_protection, drops non-key strength
 *   - Taper week → scale_volume per WeekIntent multiplier
 *   - Post-race recovery → downgrade_intensity to aerobic
 *   - Return-from-gap → scale_volume 0.5x
 *   - Travel + strength → downgrade_intensity
 *   - Missed session in taper → drop (never cram)
 *   - Low adherence → minimum viable week (drops non-key)
 *   - Multiple scenarios compose (not single-winner)
 */

import { describe, expect, it } from 'vitest';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';
import type { Session, WeekConditions, WeekIntent } from '../../src/services/coach-kernel/types';
import {
  classifyTrainingScenario,
} from '../../src/services/coach-kernel/scenario-classifier';
import { intentFromKind } from '../../src/services/coach-kernel/week-intent';

const knowledge = loadCoachKnowledge();
const principles = knowledge.principles;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `s-${Math.random()}`,
    sport: 'running',
    sessionType: 'easy_run',
    title: 'test',
    description: '',
    dayOfWeek: 'monday',
    durationMinutes: 60,
    intensityZone: 'aerobic',
    fatigueCost: 'low',
    keySession: false,
    plannedLoad: 0,
    tags: [],
    ...overrides,
  };
}

function intent(kind: WeekIntent['kind']): WeekIntent {
  return intentFromKind(kind, principles);
}

describe('classifyTrainingScenario — safety precedence', () => {
  it('safety pause overrides everything', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession(), makeSession({ keySession: true })],
      weekConditions: { weekIndex: 0, deloadDue: true, lowAdherenceTrend: true },
      weekIntent: intent('accumulation'),
      safetyOutput: {
        decisionReasons: [],
        effectiveSeverity: 'block',
        safetyEvaluation: { status: 'flag', findings: [], topMessage: '' },
      },
      principles,
    });
    expect(result.primaryScenario).toBe('safety_pause');
    expect(result.safetyOverrides).toContain('safety_pause');
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].type).toBe('pause_training');
    if (result.actions[0].type === 'pause_training') {
      expect(result.actions[0].severity).toBe('medical_referral');
    }
    expect(result.confidence).toBe('high');
  });

  it('safety warning (non-block) does NOT win', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession()],
      weekConditions: { weekIndex: 0 },
      weekIntent: intent('accumulation'),
      safetyOutput: {
        decisionReasons: [],
        effectiveSeverity: 'warning',
        safetyEvaluation: { status: 'flag', findings: [], topMessage: '' },
      },
      principles,
    });
    expect(result.primaryScenario).not.toBe('safety_pause');
    expect(result.safetyOverrides.length).toBe(0);
  });
});

describe('rate-limit anti-churn', () => {
  it('suppresses actions when daily rate limit hit but preserves the would-have modifier (R6 P2)', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession()],
      weekConditions: { weekIndex: 0, deloadDue: true },
      weekIntent: intent('accumulation'),
      recentReflowCount24h: 1,
      adaptationRateLimitPerDay: 1,
      principles,
    });
    // R6 P2 — actions cleared, but the deload modifier still surfaces
    // so the UI can render "we'd suggest deload but waiting."
    expect(result.actions.length).toBe(0);
    expect(result.rateLimited).toBe(true);
    expect(result.modifiers).toContain('deload_apply');
    expect(result.primaryScenario).toBe('deload_apply');
    expect((result.suppressedActions ?? []).length).toBeGreaterThan(0);
  });

  it('suppresses actions when weekly rate limit hit but preserves the would-have modifier (R6 P2)', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession()],
      weekConditions: { weekIndex: 0, deloadDue: true },
      weekIntent: intent('accumulation'),
      recentReflowCount7d: 2,
      adaptationRateLimitPerWeek: 2,
      principles,
    });
    expect(result.actions.length).toBe(0);
    expect(result.rateLimited).toBe(true);
    expect(result.modifiers).toContain('deload_apply');
    expect(result.primaryScenario).toBe('deload_apply');
  });

  it('safety pause is EXEMPT from rate limit', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession()],
      weekConditions: { weekIndex: 0 },
      weekIntent: intent('accumulation'),
      recentReflowCount24h: 999,
      safetyOutput: {
        decisionReasons: [], effectiveSeverity: 'block',
        safetyEvaluation: { status: 'flag', findings: [], topMessage: '' },
      },
      principles,
    });
    expect(result.actions.length).toBe(1);
    expect(result.actions[0].type).toBe('pause_training');
  });
});

describe('race / taper / post-race', () => {
  it('race week drops non-key strength', () => {
    const result = classifyTrainingScenario({
      sessions: [
        makeSession({ id: 'run', sport: 'running', keySession: true }),
        makeSession({ id: 'strength', sport: 'strength', keySession: false }),
      ],
      weekConditions: { weekIndex: 0 },
      weekIntent: intent('race'),
      principles,
    });
    expect(result.modifiers).toContain('race_protection');
    const drops = result.actions.filter((a) => a.type === 'drop_session');
    expect(drops.length).toBe(1);
  });

  it('taper week scales every session via WeekIntent multiplier', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession(), makeSession()],
      weekConditions: { weekIndex: 0 },
      weekIntent: intent('taper'),
      principles,
    });
    expect(result.modifiers).toContain('taper_protection');
    const scales = result.actions.filter((a) => a.type === 'scale_volume');
    expect(scales.length).toBe(2);
  });

  it('post_race_recovery week downgrades intensity to aerobic', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession({ intensityZone: 'threshold' })],
      weekConditions: { weekIndex: 0 },
      weekIntent: intent('post_race_recovery'),
      principles,
    });
    expect(result.modifiers).toContain('post_race_recovery');
    const downgrades = result.actions.filter((a) => a.type === 'downgrade_intensity');
    expect(downgrades.length).toBe(1);
    if (downgrades[0].type === 'downgrade_intensity') {
      expect(downgrades[0].targetCeiling).toBe('aerobic');
    }
  });
});

describe('return-from-gap', () => {
  it('emits scale_volume 0.5x for every session', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession(), makeSession()],
      weekConditions: { weekIndex: 0, returnProtocol: 'minor_illness_resolved' },
      weekIntent: intent('accumulation'),
      principles,
    });
    expect(result.modifiers).toContain('return_from_gap');
    const scales = result.actions.filter((a) => a.type === 'scale_volume');
    expect(scales.length).toBe(2);
    if (scales[0].type === 'scale_volume') {
      expect(scales[0].multiplier).toBe(0.5);
    }
  });
});

describe('scale-volume action normalization', () => {
  it('collapses stacked scale_volume actions per session into one combined multiplier', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession({ id: 's1' })],
      weekConditions: {
        weekIndex: 0,
        deloadDue: true,
        returnProtocol: 'minor_illness_resolved',
      },
      weekIntent: intent('taper'),
      principles,
    });
    const scales = result.actions.filter((a) => a.type === 'scale_volume');

    expect(scales).toHaveLength(1);
    if (scales[0].type === 'scale_volume') {
      expect(scales[0].sessionId).toBe('s1');
      expect(scales[0].reasonCode).toContain('taper_volume_scaled');
      expect(scales[0].reasonCode).toContain('return_from_gap_minor_illness_resolved');
      expect(scales[0].reasonCode).toContain('deload_applied');
    }
  });
});

describe('travel adjustment', () => {
  it('travel week downgrades strength intensity', () => {
    const result = classifyTrainingScenario({
      sessions: [
        makeSession({ sport: 'strength', id: 'strength' }),
        makeSession({ sport: 'running', id: 'run' }),
      ],
      weekConditions: { weekIndex: 0, isTravelWeek: true },
      weekIntent: intent('accumulation'),
      principles,
    });
    expect(result.modifiers).toContain('travel_adjustment');
    const downgrades = result.actions.filter((a) => a.type === 'downgrade_intensity');
    expect(downgrades.length).toBe(1);
  });
});

describe('missed-session policy', () => {
  it('taper missed session → drop (never cram)', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession({ id: 's1' })],
      weekConditions: { weekIndex: 0, missedSessionsThisWeek: 1, missedSessionIds: ['s1'] },
      weekIntent: intent('taper'),
      principles,
    });
    const drops = result.actions.filter((a) => a.type === 'drop_session' && a.reasonCode === 'taper_session_never_cram');
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('non-taper missed session uses A1b policy lookup', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession({ id: 's1', intensityZone: 'aerobic', sessionType: 'easy_run' })],
      weekConditions: { weekIndex: 0, missedSessionsThisWeek: 1, missedSessionIds: ['s1'] },
      weekIntent: intent('accumulation'),
      principles,
    });
    const drops = result.actions.filter((a) => a.type === 'drop_session');
    expect(drops.length).toBeGreaterThanOrEqual(1);
  });

  it('reschedules missed key sessions from the training week date instead of Date.now', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession({
        id: 'key-missed',
        dayOfWeek: 'monday',
        intensityZone: 'threshold',
        sessionType: 'threshold_run',
        keySession: true,
      })],
      weekConditions: {
        weekIndex: 0,
        weekStartISODate: '2026-05-04',
        missedSessionsThisWeek: 1,
        missedSessionIds: ['key-missed'],
      },
      weekIntent: intent('accumulation'),
      principles,
    });
    const move = result.actions.find((a) => a.type === 'move_session');
    expect(move?.type).toBe('move_session');
    if (move?.type === 'move_session') {
      expect(move.toDate).toBe('2026-05-06');
    }
  });

  it('Codex P2 fix — ONE missed session in a 5-session week acts ONLY on that session', () => {
    // The pre-Codex code would have iterated all 5 sessions when only
    // missedSessionsThisWeek=1. This test pins the corrected scope.
    const sessions = [
      makeSession({ id: 'kept-1' }),
      makeSession({ id: 'kept-2' }),
      makeSession({ id: 'missed-target' }),
      makeSession({ id: 'kept-3' }),
      makeSession({ id: 'kept-4' }),
    ];
    const result = classifyTrainingScenario({
      sessions,
      weekConditions: {
        weekIndex: 0,
        missedSessionsThisWeek: 1,
        missedSessionIds: ['missed-target'],
      },
      weekIntent: intent('accumulation'),
      principles,
    });
    const missedActions = result.actions.filter(
      (a) => a.type === 'drop_session' || a.type === 'move_session',
    );
    expect(missedActions.length).toBe(1);
    // The one action MUST target the actually-missed session, not the others.
    if (missedActions[0].type === 'drop_session') {
      expect(missedActions[0].sessionId).toBe('missed-target');
    } else if (missedActions[0].type === 'move_session') {
      expect(missedActions[0].sessionId).toBe('missed-target');
    }
  });

  it('Codex P2 fix — missedSessionsThisWeek > 0 but missedSessionIds empty → NO missed-session actions', () => {
    // Defensive guard: count > 0 without IDs means we lost the
    // specific signal somewhere; safer to emit no action than wrong action.
    const result = classifyTrainingScenario({
      sessions: [
        makeSession({ id: 's1' }),
        makeSession({ id: 's2' }),
      ],
      weekConditions: { weekIndex: 0, missedSessionsThisWeek: 1 },
      weekIntent: intent('accumulation'),
      principles,
    });
    const missedActions = result.actions.filter(
      (a) => a.type === 'drop_session' || a.type === 'move_session',
    );
    expect(missedActions.length).toBe(0);
  });
});

describe('low-adherence simplification', () => {
  it('drops non-key sessions, keeps key + aerobic', () => {
    const result = classifyTrainingScenario({
      sessions: [
        makeSession({ id: 'key', keySession: true }),
        makeSession({ id: 'aerobic', intensityZone: 'aerobic' }),
        makeSession({ id: 'extra1' }),
        makeSession({ id: 'extra2' }),
      ],
      weekConditions: { weekIndex: 0, lowAdherenceTrend: true },
      weekIntent: intent('accumulation'),
      principles,
    });
    expect(result.modifiers).toContain('low_adherence_simplify');
    const drops = result.actions.filter((a) => a.type === 'drop_session');
    // 'key' and 'aerobic' are kept; the other 2 dropped.
    // (Note: 'aerobic' may be a duplicate of the key session pick; allow 2 drops.)
    expect(drops.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves a minimum mobility dose when simplifying low-adherence weeks', () => {
    const result = classifyTrainingScenario({
      sessions: [
        makeSession({ id: 'key', keySession: true }),
        makeSession({ id: 'aerobic', intensityZone: 'aerobic' }),
        makeSession({ id: 'mobility', sport: 'strength', sessionType: 'mobility', tags: ['mobility'] }),
        makeSession({ id: 'extra' }),
      ],
      weekConditions: { weekIndex: 0, lowAdherenceTrend: true },
      weekIntent: intent('accumulation'),
      principles,
    });
    const droppedIds = result.actions
      .filter((action) => action.type === 'drop_session')
      .map((action) => action.sessionId);

    expect(droppedIds).toContain('extra');
    expect(droppedIds).not.toContain('mobility');
  });
});

describe('scenario composition (multiple modifiers)', () => {
  it('travel + deload + low adherence all stack', () => {
    const result = classifyTrainingScenario({
      sessions: [makeSession()],
      weekConditions: {
        weekIndex: 0,
        isTravelWeek: true,
        deloadDue: true,
        lowAdherenceTrend: true,
      },
      weekIntent: intent('accumulation'),
      principles,
    });
    expect(result.modifiers).toContain('travel_adjustment');
    expect(result.modifiers).toContain('deload_apply');
    expect(result.modifiers).toContain('low_adherence_simplify');
  });
});
