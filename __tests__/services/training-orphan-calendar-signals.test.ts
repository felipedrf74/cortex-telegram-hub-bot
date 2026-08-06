import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

const trainingSignalsSource = source('src/services/training-signals.ts');
const intelligenceBusSource = source('src/services/intelligence-bus.ts');
const signalsObservabilitySource = source('src/services/signals-observability.ts');
const conflictResolverSource = source('src/services/conflict-resolver.ts');
const focusPlannerSource = source('src/services/focus-planner.ts');
const trainingHomeSource = source('src/services/training-home-view-state.ts');
const trainingMeshSource = source('src/services/cross-agent-learning/training-mesh-context.ts');

const orphanSignalTypes = [
  'training_session_scheduled',
  'calendar_conflict',
  'training_schedule_stale',
] as const;

function between(fullSource: string, start: string, end: string): string {
  const startIndex = fullSource.indexOf(start);
  const endIndex = fullSource.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing source anchor: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing source anchor: ${end}`).toBeGreaterThan(startIndex);
  return fullSource.slice(startIndex, endIndex);
}

describe('F33 — orphan Training calendar signals stay deleted', () => {
  // Canonical truth already exists elsewhere:
  // - scheduled sessions: Training sessions + calendar ownership/agenda rows;
  // - conflicts: Secretary conflict analysis + Decision Center/notifications;
  // - stale sync: Secretary agenda lifecycle + Training calendarSyncState.
  // A second TTL bus copy is neither authoritative nor durable enough to
  // drive planning or user-facing instructions.
  it.each([
    'publishTrainingSessionScheduled',
    'readScheduledTrainingSessions',
    'publishCalendarConflict',
    'publishTrainingScheduleStale',
  ])('does not expose the orphan %s API', (exportName) => {
    expect(trainingSignalsSource).not.toMatch(
      new RegExp(`export\\s+function\\s+${exportName}\\b`),
    );
  });

  it.each(orphanSignalTypes)('removes %s from Training bus producers and readers', (signalType) => {
    expect(trainingSignalsSource).not.toContain(`'${signalType}'`);
  });

  it.each(orphanSignalTypes)('removes %s from the intelligence-bus contract and TTL registry', (signalType) => {
    expect(intelligenceBusSource).not.toContain(`'${signalType}'`);
  });

  it.each(orphanSignalTypes)('removes %s from the iOS signals observability mirror', (signalType) => {
    expect(signalsObservabilitySource).not.toContain(`'${signalType}'`);
  });

  it('removes calendar_conflict from the generic mesh priority mirror', () => {
    expect(conflictResolverSource).not.toContain('calendar_conflict');
  });

  it('removes the producer-less scheduled-session reader from Focus planning', () => {
    expect(focusPlannerSource).not.toContain('readScheduledTrainingSessions');
    expect(focusPlannerSource).not.toContain('scheduledTraining');
  });

  it('removes orphan conflict/staleness booleans from the Training mesh mirror', () => {
    expect(trainingMeshSource).not.toMatch(/\bcalendarConflict\s*:/);
    expect(trainingMeshSource).not.toMatch(/\bscheduleStale\s*:/);
  });

  it('cannot render private calendar titles or free-form stale reasons into prompts', () => {
    expect(trainingSignalsSource).not.toContain('conflict_event_title');
    expect(trainingSignalsSource).not.toContain('payload?.reason');
    expect(trainingSignalsSource).not.toContain('CALENDAR CONFLICT');
    expect(trainingSignalsSource).not.toContain('TRAINING SCHEDULE STALE');
  });

  it('removes only orphan signal copy from Training Home, preserving canonical kernel conflict rules', () => {
    const signalRenderingSource = [
      between(trainingHomeSource, 'function dedupedCausePhrases', 'function dedupedCauseChips'),
      between(trainingHomeSource, 'function localizedSignalTitle', 'function signalTone'),
      between(trainingHomeSource, 'function isMarginSignal', 'function localizedSport'),
    ].join('\n');

    for (const signalType of orphanSignalTypes) {
      expect(signalRenderingSource).not.toContain(`'${signalType}'`);
    }
    // This is authoritative coach-kernel output, not the deleted TTL signal.
    expect(trainingHomeSource).toContain("case 'calendar_conflict':");
    expect(trainingHomeSource).toContain("case 'focus_protection':");
  });
});
