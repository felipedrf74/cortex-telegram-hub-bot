/**
 * Slice B3 — mesocycle resolver tests.
 *
 * Pins:
 *   - intermediate athlete defaults to 4-week mesocycle (3 build + 1 deload)
 *   - advanced athlete defaults to 3-week mesocycle
 *   - novice athlete defaults to 5-week mesocycle
 *   - Block template loops correctly across totalWeeks
 *   - Deload weeks appear at the expected cadence
 *   - Race calendar overrides mesocycle position (taper/race/post_race)
 *   - 12-week plan with A-priority race in week 11 generates correct shape
 *   - Invalid start date throws
 */

import { describe, expect, it } from 'vitest';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';
import type { RaceEvent } from '../../src/services/coach-kernel/types';
import { resolveMesocyclePlan } from '../../src/services/coach-kernel/mesocycle';

describe('resolveMesocyclePlan — base shape', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('intermediate athlete: 4-week mesocycle with deload in week 4', () => {
    const plan = resolveMesocyclePlan({
      startDate: '2026-01-05', // Monday
      totalWeeks: 8,
      level: 'intermediate',
      principles,
    });
    expect(plan.blockTemplate).toEqual(['accumulation', 'accumulation', 'accumulation', 'deload']);
    expect(plan.weeks[0].kind).toBe('accumulation');
    expect(plan.weeks[3].kind).toBe('deload');
    expect(plan.weeks[4].kind).toBe('accumulation'); // wraps
    expect(plan.weeks[7].kind).toBe('deload');
  });

  it('advanced athlete: 3-week mesocycle (3:1 → 2:1)', () => {
    const plan = resolveMesocyclePlan({
      startDate: '2026-01-05',
      totalWeeks: 6,
      level: 'advanced',
      principles,
    });
    expect(plan.blockTemplate.length).toBe(3);
    expect(plan.weeks[2].kind).toBe('deload');
    expect(plan.weeks[5].kind).toBe('deload');
  });

  it('novice athlete: 5-week mesocycle (4 build + 1 deload)', () => {
    const plan = resolveMesocyclePlan({
      startDate: '2026-01-05',
      totalWeeks: 10,
      level: 'novice',
      principles,
    });
    expect(plan.blockTemplate.length).toBe(5);
    expect(plan.weeks[4].kind).toBe('deload');
    expect(plan.weeks[9].kind).toBe('deload');
  });

  it('throws on invalid start date', () => {
    expect(() => resolveMesocyclePlan({
      startDate: 'not-a-date',
      totalWeeks: 4,
      level: 'intermediate',
      principles,
    })).toThrow(/invalid startDate/);
  });
});

describe('resolveMesocyclePlan — race-aware', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('12-week plan with A-priority marathon in week 11 inserts taper + race + post_race', () => {
    const startDate = '2026-01-05';
    const raceDate = new Date(Date.parse(startDate) + 11 * 7 * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
    const cal: RaceEvent[] = [
      { id: 'r1', name: 'Marathon', discipline: 'running', subtype: 'marathon', date: raceDate, priority: 'a' },
    ];
    const plan = resolveMesocyclePlan({
      startDate,
      totalWeeks: 13,
      level: 'intermediate',
      raceCalendar: cal,
      principles,
    });
    // Week 11 contains race day → race intent.
    expect(plan.weeks[11].kind).toBe('race');
    // Weeks 9-10 should be taper (14-day window for A-priority).
    // Week 9 starts 14 days before race day; week 10 starts 7 days before.
    expect(['taper']).toContain(plan.weeks[10].kind);
    // Week 12 should be post_race_recovery (marathon = 10-day recovery).
    expect(plan.weeks[12].kind).toBe('post_race_recovery');
  });

  it('B-priority race only takes 7-day taper window (1 week)', () => {
    const startDate = '2026-01-05';
    const raceDate = new Date(Date.parse(startDate) + 4 * 7 * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
    const cal: RaceEvent[] = [
      { id: 'r1', name: 'Race', discipline: 'running', date: raceDate, priority: 'b' },
    ];
    const plan = resolveMesocyclePlan({
      startDate,
      totalWeeks: 6,
      level: 'intermediate',
      raceCalendar: cal,
      principles,
    });
    // Week 4 contains race day.
    expect(plan.weeks[4].kind).toBe('race');
    // Week 3 starts 7 days before race → in taper window.
    expect(plan.weeks[3].kind).toBe('taper');
    // Week 2 starts 14 days before race → outside B-priority 7-day taper.
    expect(plan.weeks[2].kind).not.toBe('taper');
  });
});
