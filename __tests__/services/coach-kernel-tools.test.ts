import { describe, expect, it } from 'vitest';

import {
  calculateZones,
  computeTrainingLoad,
  generateDailyBrief,
  parseFitFile,
  parseGpxFile,
  progressStrengthBlockTool,
  sampleMarathonAthlete,
  savePlan,
  scoreCompliance,
  syncCalendar,
  type AthleteState,
} from '../../src/services/coach-kernel';
import { InMemoryCoachPlanStore } from '../../src/services/coach-kernel/stores/in-memory-plan-store';
import { buildWeekPlan } from '../../src/services/coach-kernel/planner-engine';

describe('coach-kernel tools', () => {
  it('produces deterministic zone calculations', () => {
    const zones = calculateZones(sampleMarathonAthlete);
    expect(zones.runningPaceSecondsPerKm?.threshold.min).toBeGreaterThan(0);
    expect(zones.bikePowerWatts?.threshold.max).toBeGreaterThan(0);
  });

  it('scores compliance from planned vs recent sessions', () => {
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');
    const recent = plan.sessions.slice(0, 2).map((session, index) => ({
      id: session.id,
      sport: session.sport,
      sessionType: session.sessionType,
      completedAt: new Date().toISOString(),
      durationMinutes: session.durationMinutes,
      intensityZone: session.intensityZone,
      fatigueCost: session.fatigueCost,
      completed: index === 0,
      keySession: session.keySession,
    }));
    const compliance = scoreCompliance(plan, recent);

    expect(compliance.trailing14DayCompliance).toBeGreaterThanOrEqual(0);
    expect(compliance.trailing14DayCompliance).toBeLessThanOrEqual(1);
  });

  it('progresses strength work when compliance and readiness are good', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      readiness: { ...sampleMarathonAthlete.readiness, level: 'green', score: 86 },
      compliance: { ...sampleMarathonAthlete.compliance, trailing14DayCompliance: 0.9 },
    };
    const plan = buildWeekPlan(athlete, '2026-05-11');
    const progressed = progressStrengthBlockTool(athlete, plan);
    const originalSets = plan.sessions.find((session) => session.sport === 'strength')?.exercises?.[0]?.sets ?? 0;
    const progressedSets = progressed.sessions.find((session) => session.sport === 'strength')?.exercises?.[0]?.sets ?? 0;

    expect(progressedSets).toBeGreaterThanOrEqual(originalSets);
  });

  it('parses GPX and FIT files into deterministic metadata', () => {
    const gpx = `<?xml version="1.0"?><gpx><trk><trkseg><trkpt lat="0" lon="0"><time>2026-04-18T08:00:00Z</time></trkpt><trkpt lat="0" lon="0"><time>2026-04-18T08:30:00Z</time></trkpt></trkseg></trk></gpx>`;
    const gpxParsed = parseGpxFile(gpx);
    const fitBuffer = Buffer.alloc(14);
    fitBuffer.writeUInt8(14, 0);
    fitBuffer.writeUInt8(32, 1);
    fitBuffer.writeUInt16LE(2200, 2);
    fitBuffer.writeUInt32LE(1024, 4);
    fitBuffer.write('.FIT', 8, 'ascii');
    const fitParsed = parseFitFile(fitBuffer);

    expect(gpxParsed.trackPointCount).toBe(2);
    expect(gpxParsed.totalSeconds).toBe(1800);
    expect(fitParsed.signature).toBe('.FIT');
    expect(fitParsed.dataSize).toBe(1024);
  });

  it('saves plans and generates a daily brief for LLM presentation', () => {
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');
    const store = new InMemoryCoachPlanStore();
    // savePlan now persists WeeklyPlan + AthleteState together so the
    // home-view route can re-run fatigue adjustments later. The stored
    // entry exposes `.plan` for downstream code that only cares about
    // the WeeklyPlan.
    savePlan(plan, sampleMarathonAthlete, sampleMarathonAthlete.profile.athleteId, store);
    const stored = store.get(
      sampleMarathonAthlete.profile.athleteId,
      sampleMarathonAthlete.profile.athleteId,
      '2026-05-11',
    );
    const load = computeTrainingLoad(plan.sessions);
    const brief = generateDailyBrief(sampleMarathonAthlete, plan, 'tuesday');
    const calendarEvents = syncCalendar(plan);

    expect(stored?.plan.weekStart).toBe('2026-05-11');
    expect(stored?.athleteState.profile.athleteId).toBe(sampleMarathonAthlete.profile.athleteId);
    expect(load.totalLoad).toBeGreaterThan(0);
    expect(brief.length).toBeGreaterThan(20);
    expect(calendarEvents.length).toBeGreaterThan(0);
  });

  it('rejects an invalid tenant before writing the plan store', () => {
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');
    const store = new InMemoryCoachPlanStore();

    expect(() => savePlan(plan, sampleMarathonAthlete, 0, store)).toThrow(/TENANT_SCOPE_REQUIRED|validated tenantId/);
    expect(store.get(sampleMarathonAthlete.profile.athleteId, 0, '2026-05-11')).toBeNull();
  });
});
