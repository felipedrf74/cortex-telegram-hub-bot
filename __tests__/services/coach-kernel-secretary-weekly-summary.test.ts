// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression guard for the C8 workstream: Secretary's weekly contribution
 * woven into coach-kernel weekly decision notes.
 *
 * Two layers:
 * 1. `buildSecretaryWeeklySummary(items, weekStart)` — pure, no DB. Counts
 *    compressed/reflowed/deferred sessions in the week + detects protected
 *    training long runs.
 * 2. `buildWeeklyDecisionNotes(plan, athlete, secretarySummary)` — when
 *    `secretarySummary` is non-empty, prepends a `Secretary: ...` line.
 *    Also `dedupeDecisionLines` recognizes `Secretary:` as an auto-prefix
 *    so old stale Secretary lines are dropped on rebuild.
 *
 * Plan reference: Wave 1 workstream C8.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  buildSecretaryWeeklySummary,
  buildWeeklyDecisionNotes,
  buildWeekPlan,
  sampleHybridAthlete,
  type SecretaryAgendaSummaryInput,
  type WeeklyPlan,
} from '../../src/services/coach-kernel';

const WEEK_START = '2026-05-04T00:00:00.000Z';
const IN_WEEK_DAY = '2026-05-06T08:00:00.000Z';
const OUT_OF_WEEK = '2026-05-13T08:00:00.000Z';

function item(overrides: Partial<SecretaryAgendaSummaryInput>): SecretaryAgendaSummaryInput {
  return {
    startAt: IN_WEEK_DAY,
    endAt: '2026-05-06T09:00:00.000Z',
    lifecycleState: 'scheduled',
    sourceSkill: 'training',
    decisionAction: 'scheduled',
    ...overrides,
  };
}

describe('C8: buildSecretaryWeeklySummary', () => {
  it('returns null when there are no Secretary changes in the week', () => {
    expect(buildSecretaryWeeklySummary([], WEEK_START)).toBeNull();
  });

  it('counts compressed sessions in the week', () => {
    const summary = buildSecretaryWeeklySummary(
      [
        item({ lifecycleState: 'compressed' }),
        item({ lifecycleState: 'compressed', startAt: '2026-05-07T10:00:00.000Z', endAt: '2026-05-07T11:00:00.000Z' }),
      ],
      WEEK_START,
    );
    expect(summary).toContain('compressed 2 sessions');
  });

  it('counts reflowed and deferred items separately', () => {
    const summary = buildSecretaryWeeklySummary(
      [
        item({ lifecycleState: 'reflowed' }),
        item({ lifecycleState: 'deferred', startAt: '2026-05-08T08:00:00.000Z', endAt: '2026-05-08T09:00:00.000Z' }),
      ],
      WEEK_START,
    );
    expect(summary).toContain('reflowed 1');
    expect(summary).toContain('deferred 1');
  });

  it('detects a protected training long run (>=90 min scheduled session)', () => {
    const summary = buildSecretaryWeeklySummary(
      [
        item({
          startAt: IN_WEEK_DAY,
          endAt: '2026-05-06T10:00:00.000Z', // 120 min
          lifecycleState: 'scheduled',
          sourceSkill: 'training',
        }),
      ],
      WEEK_START,
    );
    expect(summary).toContain('long run protected');
  });

  it('excludes items outside the week boundary', () => {
    const summary = buildSecretaryWeeklySummary(
      [
        item({ lifecycleState: 'compressed', startAt: OUT_OF_WEEK, endAt: '2026-05-13T09:00:00.000Z' }),
      ],
      WEEK_START,
    );
    expect(summary).toBeNull();
  });

  it('returns null for an invalid weekStart', () => {
    expect(buildSecretaryWeeklySummary([], 'not-a-date')).toBeNull();
  });
});

describe('C8: buildWeeklyDecisionNotes with secretarySummary', () => {
  function emptyPlan(): WeeklyPlan {
    return {
      athleteId: sampleHybridAthlete.profile.athleteId,
      weekStart: '2026-05-04',
      discipline: 'hybrid',
      phase: 'build',
      sessions: [],
      notes: [],
      guardrailResults: [],
    };
  }

  it('prepends a Secretary: line when summary is non-empty', () => {
    const notes = buildWeeklyDecisionNotes(emptyPlan(), sampleHybridAthlete, 'compressed 2 sessions');
    expect(notes.some((line) => line.startsWith('Secretary: compressed 2 sessions'))).toBe(true);
  });

  it('omits the Secretary line when summary is null or empty', () => {
    expect(
      buildWeeklyDecisionNotes(emptyPlan(), sampleHybridAthlete, null)
        .some((line) => line.startsWith('Secretary:')),
    ).toBe(false);
    expect(
      buildWeeklyDecisionNotes(emptyPlan(), sampleHybridAthlete, '   ')
        .some((line) => line.startsWith('Secretary:')),
    ).toBe(false);
  });

  it('drops stale Secretary auto-summary lines on rebuild (dedupeDecisionLines hook)', () => {
    const plan: WeeklyPlan = {
      ...emptyPlan(),
      notes: [
        'Secretary: stale summary from a previous week that should NOT survive rebuild.',
        'Random non-auto note that survives.',
      ],
    };
    const rebuilt = buildWeeklyDecisionNotes(plan, sampleHybridAthlete, 'compressed 1 session');
    // Only the new Secretary line — the stale one is filtered out.
    const secretaryLines = rebuilt.filter((line) => line.startsWith('Secretary:'));
    expect(secretaryLines.length).toBe(1);
    expect(secretaryLines[0]).toContain('compressed 1 session');
    // Non-auto note survives.
    expect(rebuilt).toContain('Random non-auto note that survives.');
  });
});

describe('C8: planner dependency boundary', () => {
  it('accepts an already-scoped Secretary summary without reading a database', () => {
    const plan = buildWeekPlan(sampleHybridAthlete, '2026-05-04', {
      secretaryWeeklySummary: 'reflowed 1',
    });

    expect(plan.notes).toContain('Secretary: reflowed 1.');
  });

  it('keeps the coach kernel free of Secretary storage imports and tenant fallbacks', () => {
    const source = readFileSync('src/services/coach-kernel/planner-engine.ts', 'utf8');

    expect(source).not.toContain('secretary-scheduling-arbitrator');
    expect(source).not.toContain('listSecretaryAgendaItems');
    expect(source).not.toMatch(/tenantId:\s*athleteId/);
  });
});
