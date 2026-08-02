/**
 * Priority model (shadow mode).
 *
 * The model is pure, so these tests are the specification. They pin the
 * properties that matter for trust, not just arithmetic:
 *
 *   - a producer cannot buy its way to the top by declaring `critical`
 *   - policy floors raise, never rescue a quality-gate failure
 *   - an explicit user mute outranks everything except a floor
 *   - APNs Critical Alerts are unreachable by construction
 */
import { describe, expect, it } from 'vitest';
import {
  COLD_START_MIN_OBSERVATIONS,
  NEUTRAL_ENGAGEMENT,
  PRIORITY_MODEL_VERSION,
  deadlinePressure,
  fatiguePenalty,
  scoreNotification,
  stalenessPenalty,
  tierForScore,
  TYPE_BASE,
  type EngagementStats,
  type PriorityFeatures,
} from '../../src/services/notification-priority-model';

const NOW = Date.parse('2026-05-07T12:00:00.000Z');

function features(over: Partial<PriorityFeatures> = {}): PriorityFeatures {
  return {
    type: 'decision_required',
    sourceSkill: 'secretary',
    declaredPriority: 'active',
    nowMs: NOW,
    deadlineAtMs: null,
    sourceObservedAtMs: NOW,
    requiresUserAction: true,
    hasSourceScope: true,
    actionCount: 2,
    riskIfIgnored: 'medium',
    reversibility: 'reversible',
    confidence: 0.9,
    engagement: { ...NEUTRAL_ENGAGEMENT },
    dependencyBlocked: false,
    dependencySlack: 0,
    escalationGeneration: 0,
    snoozed: false,
    safeForAPNs: true,
    ...over,
  };
}

function engagement(over: Partial<EngagementStats> = {}): EngagementStats {
  return { ...NEUTRAL_ENGAGEMENT, ...over };
}

describe('deadline pressure', () => {
  it('rises as the deadline approaches', () => {
    const at = (h: number) => deadlinePressure(NOW + h * 3_600_000, NOW);
    expect(at(200)).toBe(0);
    expect(at(100)).toBe(3);
    expect(at(36)).toBe(11);
    expect(at(20)).toBe(17);
    expect(at(2)).toBe(28);
    expect(at(0.5)).toBe(30);
  });

  it('scores an overdue deadline high but below imminent', () => {
    // A missed deadline is usually LESS actionable than an approaching one.
    const overdue = deadlinePressure(NOW - 3_600_000, NOW);
    expect(overdue).toBe(26);
    expect(overdue).toBeLessThan(deadlinePressure(NOW + 1_800_000, NOW));
  });

  it('is zero when there is no deadline', () => {
    expect(deadlinePressure(null, NOW)).toBe(0);
  });
});
describe('staleness', () => {
  it('decays per type half-life', () => {
    const sixHoursAgo = NOW - 6 * 3_600_000;
    // A conflict has a 6h half-life; a reminder 24h.
    expect(stalenessPenalty(sixHoursAgo, NOW, 'conflict_detected')).toBe(5);
    expect(stalenessPenalty(sixHoursAgo, NOW, 'reminder')).toBe(0);
  });

  it('caps the penalty and treats unknown freshness as mildly stale', () => {
    expect(stalenessPenalty(NOW - 400 * 3_600_000, NOW, 'conflict_detected')).toBe(15);
    expect(stalenessPenalty(null, NOW, 'reminder')).toBe(6);
  });
});

describe('fatigue', () => {
  it('is suppressed below the cold-start threshold', () => {
    const heavy = engagement({ surfaced: COLD_START_MIN_OBSERVATIONS - 1, dismissRate: 1 });
    expect(fatiguePenalty(heavy)).toBe(0);
  });

  it('grows with dismissals and shrinks with a small sample', () => {
    const small = fatiguePenalty(engagement({ surfaced: 5, dismissRate: 1 }));
    const large = fatiguePenalty(engagement({ surfaced: 20, dismissRate: 1 }));
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it('gives a rebate to a type the user actually acts on', () => {
    const ignored = fatiguePenalty(engagement({ surfaced: 20, dismissRate: 0.8 }));
    const acted = fatiguePenalty(engagement({ surfaced: 20, dismissRate: 0.8, actionRate: 1 }));
    expect(acted).toBeLessThan(ignored);
  });
});

describe('scoreNotification', () => {
  it('caps what a producer can buy by declaring a priority', () => {
    const passive = scoreNotification(features({ declaredPriority: 'passive' }));
    const critical = scoreNotification(features({ declaredPriority: 'critical' }));
    // The claim is a vote, not a veto: 14 points, not an automatic top rank.
    expect(critical.score - passive.score).toBe(14);
    expect(critical.tier).not.toBe('critical');
  });

  it('penalises an actionable intent with no source object', () => {
    const scoped = scoreNotification(features({ requiresUserAction: true, hasSourceScope: true }));
    const unscoped = scoreNotification(features({ requiresUserAction: true, hasSourceScope: false }));
    expect(unscoped.score).toBeLessThan(scoped.score);
    expect(unscoped.components.actionability).toBe(-25);
  });

  it('floors a security notification to critical regardless of its score', () => {
    const verdict = scoreNotification(features({
      type: 'security_account',
      sourceSkill: 'security',
      declaredPriority: 'passive',
      riskIfIgnored: 'low',
      confidence: 0.2,
    }));
    expect(verdict.tier).toBe('critical');
    expect(verdict.reasonCodes).toContain('floor_security');
    expect(verdict.floored).toBe(true);
  });

  it('floors a broken connection so it cannot be scored into the background', () => {
    const verdict = scoreNotification(features({ type: 'sync_failure', declaredPriority: 'passive' }));
    expect(verdict.reasonCodes).toContain('floor_connection_blocking');
    expect(['high', 'critical']).toContain(verdict.tier);
  });

  it('never lets a floor rescue something the quality gate rejected', () => {
    const verdict = scoreNotification(features({
      type: 'sync_failure',
      safeForAPNs: false,
    }));
    expect(verdict.reasonCodes).toContain('ceiling_quality_gate');
    // Floored to 'high', then capped back down.
    expect(verdict.tier).toBe('normal');
  });

  it('respects an explicit user mute unless a policy floor applies', () => {
    const muted = scoreNotification(features({
      engagement: engagement({ surfaced: 30, mutedCount: 1 }),
    }));
    expect(muted.tier).toBe('low');
    expect(muted.reasonCodes).toContain('ceiling_user_muted_type');

    // Security is not mutable — the floor wins.
    const security = scoreNotification(features({
      type: 'security_account',
      engagement: engagement({ surfaced: 30, mutedCount: 1 }),
    }));
    expect(security.tier).toBe('critical');
    expect(security.reasonCodes).not.toContain('ceiling_user_muted_type');
  });

  it('ranks a blocker above the decisions it unblocks', () => {
    const blocked = scoreNotification(features({ dependencyBlocked: true }));
    const blocker = scoreNotification(features({ dependencySlack: 3 }));
    expect(blocker.score).toBeGreaterThan(blocked.score);
    expect(blocker.components.dependency).toBe(9);
    expect(blocked.components.dependency).toBe(-12);
  });

  it('damps a snoozed item', () => {
    expect(scoreNotification(features({ snoozed: true })).components.snooze).toBe(-20);
  });

  it('is deterministic and clamped to 0..100', () => {
    const f = features({ type: 'security_account', deadlineAtMs: NOW, riskIfIgnored: 'high', reversibility: 'irreversible' });
    const a = scoreNotification(f);
    const b = scoreNotification(f);
    expect(a).toEqual(b);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(100);
    expect(a.modelVersion).toBe(PRIORITY_MODEL_VERSION);
  });

  it('scores every intent type without throwing', () => {
    for (const type of Object.keys(TYPE_BASE)) {
      expect(() => scoreNotification(features({ type: type as PriorityFeatures['type'] }))).not.toThrow();
    }
  });
});

describe('tier boundaries', () => {
  it('maps scores onto tiers at the documented cut points', () => {
    expect(tierForScore(0)).toBe('ambient');
    expect(tierForScore(24)).toBe('ambient');
    expect(tierForScore(25)).toBe('low');
    expect(tierForScore(45)).toBe('normal');
    expect(tierForScore(68)).toBe('high');
    expect(tierForScore(85)).toBe('critical');
  });
});
