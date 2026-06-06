/**
 * Slice B2a — race calendar read model tests.
 *
 * Pins:
 *   - normalizeRacePriority a/b/c → A/B/C
 *   - findNextRace returns earliest future race (or undefined)
 *   - findMostRecentPastRace returns latest past race
 *   - daysToRace sign convention (negative = past, positive = future)
 *   - isInTaperWindow uses A=14/B=7/C=3 defaults
 *   - isInPostRaceRecovery uses race-format-aware defaults
 *   - resolveRaceDisciplines defaults triathlon to [swim, bike, run]
 *   - Multisport priority A 70.3 → 7-day recovery
 *   - Ironman priority A → 14-day recovery
 */

import { describe, expect, it } from 'vitest';
import type { RaceEvent } from '../../src/services/coach-kernel/types';
import {
  daysToRace,
  findMostRecentPastRace,
  findNextRace,
  isInPostRaceRecovery,
  isInTaperWindow,
  normalizeRacePriority,
  resolveRaceDisciplines,
} from '../../src/services/race-calendar';

function race(overrides: Partial<RaceEvent> = {}): RaceEvent {
  return {
    id: 'r1',
    name: 'Test Race',
    discipline: 'running',
    date: '2026-06-15',
    priority: 'a',
    ...overrides,
  };
}

describe('normalizeRacePriority', () => {
  it('converts a/b/c to A/B/C', () => {
    expect(normalizeRacePriority('a')).toBe('A');
    expect(normalizeRacePriority('b')).toBe('B');
    expect(normalizeRacePriority('c')).toBe('C');
  });
});

describe('findNextRace / findMostRecentPastRace', () => {
  const calendar: RaceEvent[] = [
    race({ id: 'past1', date: '2026-01-01' }),
    race({ id: 'past2', date: '2026-03-15' }),
    race({ id: 'future1', date: '2026-07-01' }),
    race({ id: 'future2', date: '2026-10-01' }),
  ];

  it('findNextRace returns earliest future', () => {
    const r = findNextRace(calendar, '2026-05-01');
    expect(r?.id).toBe('future1');
  });

  it('findMostRecentPastRace returns latest past', () => {
    const r = findMostRecentPastRace(calendar, '2026-05-01');
    expect(r?.id).toBe('past2');
  });

  it('findNextRace returns undefined when no future races', () => {
    expect(findNextRace(calendar, '2027-01-01')).toBeUndefined();
  });

  it('findMostRecentPastRace returns undefined when no past races', () => {
    expect(findMostRecentPastRace(calendar, '2025-12-31')).toBeUndefined();
  });
});

describe('daysToRace', () => {
  it('positive when race is in the future', () => {
    expect(daysToRace(race({ date: '2026-06-15' }), '2026-06-01')).toBe(14);
  });

  it('negative when race is in the past', () => {
    expect(daysToRace(race({ date: '2026-05-15' }), '2026-06-01')).toBe(-17);
  });

  it('0 on race day', () => {
    expect(daysToRace(race({ date: '2026-06-15' }), '2026-06-15')).toBe(0);
  });
});

describe('isInTaperWindow', () => {
  it('A priority: 14-day taper window', () => {
    const cal = [race({ priority: 'a', date: '2026-06-15' })];
    const result = isInTaperWindow(cal, '2026-06-05'); // 10 days out
    expect(result.inTaper).toBe(true);
    expect(result.taperWindowDays).toBe(14);
  });

  it('A priority: outside 14-day window', () => {
    const cal = [race({ priority: 'a', date: '2026-06-15' })];
    const result = isInTaperWindow(cal, '2026-05-15'); // 31 days out
    expect(result.inTaper).toBe(false);
  });

  it('B priority: 7-day taper window', () => {
    const cal = [race({ priority: 'b', date: '2026-06-15' })];
    expect(isInTaperWindow(cal, '2026-06-12').inTaper).toBe(true); // 3 days out
    expect(isInTaperWindow(cal, '2026-06-05').inTaper).toBe(false); // 10 days out
  });

  it('C priority: 3-day taper window', () => {
    const cal = [race({ priority: 'c', date: '2026-06-15' })];
    expect(isInTaperWindow(cal, '2026-06-13').inTaper).toBe(true);
    expect(isInTaperWindow(cal, '2026-06-10').inTaper).toBe(false);
  });

  it('no future race → not in taper', () => {
    expect(isInTaperWindow([], '2026-06-01').inTaper).toBe(false);
  });
});

describe('isInPostRaceRecovery', () => {
  it('A-priority marathon: 10-day recovery', () => {
    const cal = [race({ priority: 'a', subtype: 'marathon', date: '2026-06-01' })];
    expect(isInPostRaceRecovery(cal, '2026-06-08').inRecovery).toBe(true);
    expect(isInPostRaceRecovery(cal, '2026-06-15').inRecovery).toBe(false);
  });

  it('A-priority Ironman: 14-day recovery', () => {
    const cal = [race({
      priority: 'a',
      discipline: 'triathlon',
      subtype: 'ironman',
      raceFormat: 'multisport',
      date: '2026-06-01',
    })];
    expect(isInPostRaceRecovery(cal, '2026-06-10').inRecovery).toBe(true);
    expect(isInPostRaceRecovery(cal, '2026-06-20').inRecovery).toBe(false);
  });

  it('A-priority 70.3: 10-day recovery (long course but not Ironman)', () => {
    const cal = [race({
      priority: 'a',
      discipline: 'triathlon',
      subtype: '70.3',
      raceFormat: 'multisport',
      date: '2026-06-01',
    })];
    expect(isInPostRaceRecovery(cal, '2026-06-05').inRecovery).toBe(true);
    expect(isInPostRaceRecovery(cal, '2026-06-09').inRecovery).toBe(true);
    expect(isInPostRaceRecovery(cal, '2026-06-15').inRecovery).toBe(false);
  });

  it('A-priority Olympic-distance tri: 7-day recovery (multisport, short course)', () => {
    const cal = [race({
      priority: 'a',
      discipline: 'triathlon',
      subtype: 'olympic',
      raceFormat: 'multisport',
      date: '2026-06-01',
    })];
    expect(isInPostRaceRecovery(cal, '2026-06-05').inRecovery).toBe(true);
    expect(isInPostRaceRecovery(cal, '2026-06-10').inRecovery).toBe(false);
  });

  it('B-priority: 3-day recovery', () => {
    const cal = [race({ priority: 'b', date: '2026-06-01' })];
    expect(isInPostRaceRecovery(cal, '2026-06-02').inRecovery).toBe(true);
    expect(isInPostRaceRecovery(cal, '2026-06-05').inRecovery).toBe(false);
  });

  it('C-priority: 1-day recovery', () => {
    const cal = [race({ priority: 'c', date: '2026-06-01' })];
    expect(isInPostRaceRecovery(cal, '2026-06-01').inRecovery).toBe(true);
    expect(isInPostRaceRecovery(cal, '2026-06-03').inRecovery).toBe(false);
  });

  it('honors explicit recoveryDaysAfter override', () => {
    const cal = [race({ priority: 'b', date: '2026-06-01', recoveryDaysAfter: 14 })];
    expect(isInPostRaceRecovery(cal, '2026-06-10').inRecovery).toBe(true);
  });

  it('returns false when no past races', () => {
    expect(isInPostRaceRecovery([], '2026-06-01').inRecovery).toBe(false);
  });
});

describe('resolveRaceDisciplines', () => {
  it('explicit disciplines win', () => {
    const r = race({
      discipline: 'triathlon',
      disciplines: ['swimming', 'cycling', 'running'],
    });
    expect(resolveRaceDisciplines(r)).toEqual(['swimming', 'cycling', 'running']);
  });

  it('triathlon defaults to all three disciplines', () => {
    expect(resolveRaceDisciplines(race({ discipline: 'triathlon' })))
      .toEqual(['swimming', 'cycling', 'running']);
  });

  it('single-discipline race returns that discipline only', () => {
    expect(resolveRaceDisciplines(race({ discipline: 'running' }))).toEqual(['running']);
    expect(resolveRaceDisciplines(race({ discipline: 'cycling' }))).toEqual(['cycling']);
  });
});
