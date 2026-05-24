/**
 * Slice B2 — WeekIntent resolver tests.
 *
 * Pins:
 *   - intentFromKind reads JSON defaults when available
 *   - intentFromKind falls back to inline defaults when JSON missing
 *   - blockPhaseFromWeekIntent maps to legacy BlockPhase for iOS compat
 *   - Resolution precedence: race > post-race > taper > mesocycle > default
 *   - Resolver returns 'race' when race day is in this week
 *   - Resolver returns 'post_race_recovery' when in recovery window
 *   - Resolver returns 'taper' when in pre-race taper window
 *   - Resolver returns mesocycle template entry otherwise
 *   - Resolver returns 'accumulation' fallback when nothing matches
 */

import { describe, expect, it } from 'vitest';
import { loadCoachKnowledge } from '../../src/services/coach-kernel/knowledge-loader';
import type { RaceEvent } from '../../src/services/coach-kernel/types';
import {
  blockPhaseFromWeekIntent,
  intentFromKind,
  resolveWeekIntent,
} from '../../src/services/coach-kernel/week-intent';

describe('intentFromKind', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('reads accumulation defaults from JSON', () => {
    const i = intentFromKind('accumulation', principles);
    expect(i.kind).toBe('accumulation');
    expect(i.volumeMultiplier).toBe(1.0);
    expect(i.primaryQuality).toBe('volume');
  });

  it('deload is soreness-sensitive with low volume', () => {
    const i = intentFromKind('deload', principles);
    expect(i.sorenessSensitive).toBe(true);
    expect(i.volumeMultiplier).toBeLessThan(1);
  });

  it('taper has reduced volume and preserved intensity (sharpness quality)', () => {
    const i = intentFromKind('taper', principles);
    expect(i.primaryQuality).toBe('sharpness');
    expect(i.volumeMultiplier).toBeLessThan(0.6);
  });

  it('falls back to inline defaults when JSON missing', () => {
    const i = intentFromKind('accumulation', {});
    expect(i.kind).toBe('accumulation');
    expect(i.volumeMultiplier).toBe(1.0);
  });
});

describe('blockPhaseFromWeekIntent', () => {
  it('maps to legacy BlockPhase strings', () => {
    expect(blockPhaseFromWeekIntent('accumulation')).toBe('base');
    expect(blockPhaseFromWeekIntent('intensification')).toBe('build');
    expect(blockPhaseFromWeekIntent('realization')).toBe('peak');
    expect(blockPhaseFromWeekIntent('deload')).toBe('deload');
    expect(blockPhaseFromWeekIntent('recovery')).toBe('deload');
    expect(blockPhaseFromWeekIntent('taper')).toBe('taper');
    expect(blockPhaseFromWeekIntent('race')).toBe('race');
    expect(blockPhaseFromWeekIntent('post_race_recovery')).toBe('deload');
  });
});

describe('resolveWeekIntent — precedence', () => {
  const knowledge = loadCoachKnowledge();
  const principles = knowledge.principles;

  it('race day in this week → race intent (highest precedence)', () => {
    const cal: RaceEvent[] = [
      { id: 'r1', name: 'Race', discipline: 'running', date: '2026-06-15', priority: 'a' },
    ];
    const result = resolveWeekIntent({
      weekStartISODate: '2026-06-09', // race is 6 days later, in this week
      raceCalendar: cal,
      mesocycle: ['accumulation', 'accumulation', 'accumulation', 'deload'],
      weekInBlock: 0,
      principles,
    });
    expect(result.kind).toBe('race');
  });

  it('post-race window → post_race_recovery (overrides mesocycle)', () => {
    const cal: RaceEvent[] = [
      { id: 'r1', name: 'Race', discipline: 'running', subtype: 'marathon', date: '2026-05-15', priority: 'a' },
    ];
    const result = resolveWeekIntent({
      weekStartISODate: '2026-05-18', // 3 days after marathon, recovery is 10 days
      raceCalendar: cal,
      mesocycle: ['accumulation'],
      weekInBlock: 0,
      principles,
    });
    expect(result.kind).toBe('post_race_recovery');
  });

  it('pre-race taper window → taper (overrides mesocycle)', () => {
    const cal: RaceEvent[] = [
      { id: 'r1', name: 'Race', discipline: 'running', date: '2026-06-15', priority: 'a' },
    ];
    const result = resolveWeekIntent({
      weekStartISODate: '2026-06-03', // 12 days out, inside 14-day A-priority taper
      raceCalendar: cal,
      mesocycle: ['accumulation'],
      weekInBlock: 0,
      principles,
    });
    expect(result.kind).toBe('taper');
  });

  it('outside race windows → mesocycle template position', () => {
    const result = resolveWeekIntent({
      weekStartISODate: '2026-01-15',
      mesocycle: ['accumulation', 'accumulation', 'accumulation', 'deload'],
      weekInBlock: 3, // last week = deload
      principles,
    });
    expect(result.kind).toBe('deload');
  });

  it('no race, no mesocycle → accumulation fallback', () => {
    const result = resolveWeekIntent({
      weekStartISODate: '2026-01-15',
      principles,
    });
    expect(result.kind).toBe('accumulation');
  });

  it('mesocycle position wraps modulo length', () => {
    const result = resolveWeekIntent({
      weekStartISODate: '2026-01-15',
      mesocycle: ['accumulation', 'deload'],
      weekInBlock: 5, // 5 % 2 = 1 = deload
      principles,
    });
    expect(result.kind).toBe('deload');
  });
});
