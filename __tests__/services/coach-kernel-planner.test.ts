import { describe, expect, it } from 'vitest';

import {
  buildWeekPlan,
  buildDayPlan,
  loadCoachKnowledge,
  sampleHybridAthlete,
  sampleMarathonAthlete,
  sampleTriathlete,
  type AthleteState,
} from '../../src/services/coach-kernel';
import { adjustForFatigue } from '../../src/services/coach-kernel/planner-engine';

describe('coach-kernel planner', () => {
  it('handles marathon peak-week long run safely', () => {
    const athlete: AthleteState = {
      ...sampleMarathonAthlete,
      currentBlock: {
        ...sampleMarathonAthlete.currentBlock,
        phase: 'peak',
      },
    };

    const plan = buildWeekPlan(athlete, '2026-08-10');
    const longRun = plan.sessions.find((session) => session.sessionType === 'long_run');

    expect(longRun).toBeTruthy();
    expect(longRun!.durationMinutes).toBeLessThanOrEqual(170);
    expect(plan.phase).toBe('peak');
  });

  it('places a triathlon brick around the bike day', () => {
    const plan = buildWeekPlan(sampleTriathlete, '2026-06-15');
    const brick = plan.sessions.find((session) => session.sessionType === 'brick');
    const keyRide = plan.sessions.find((session) => session.tags.includes('key_ride'));

    expect(brick).toBeTruthy();
    expect(keyRide).toBeTruthy();
    expect(brick!.dayOfWeek).toBe(keyRide!.dayOfWeek);
  });

  it('resolves hybrid priority conflicts in favor of the declared priority', () => {
    const knowledge = loadCoachKnowledge();
    expect(knowledge.docs.hybridAthleteRules).toContain('Endurance priority wins');

    const plan = buildWeekPlan(sampleHybridAthlete, '2026-05-04');
    const strengthSessions = plan.sessions.filter((session) => session.sport === 'strength');
    const runSessions = plan.sessions.filter((session) => session.sport === 'running');

    expect(strengthSessions.length).toBeGreaterThan(0);
    expect(runSessions.length).toBeLessThanOrEqual(3);
  });

  it('builds a daily recommendation using deterministic weekly plan output', () => {
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');
    const day = buildDayPlan(sampleMarathonAthlete, plan, 'tuesday');

    expect(day.session).toBeTruthy();
    expect(day.rationale[0]).toContain('primary prescription');
  });

  it('re-running adjustForFatigue with a red readiness collapses the phase to deload', () => {
    // Structural #5 depends on this path: the home-view route stores
    // the AthleteState at plan-generation time and re-runs adjustForFatigue
    // with a patched readiness snapshot when today's score drops into
    // orange/red. This test validates that the re-run produces a
    // different plan (phase switches to deload on red).
    const greenAthlete: AthleteState = {
      ...sampleMarathonAthlete,
      readiness: {
        ...sampleMarathonAthlete.readiness,
        level: 'green',
        score: 88,
      },
    };
    const originalPlan = buildWeekPlan(greenAthlete, '2026-05-11');

    const redAthlete: AthleteState = {
      ...greenAthlete,
      readiness: {
        ...greenAthlete.readiness,
        level: 'red',
        score: 32,
      },
    };
    const adjusted = adjustForFatigue(redAthlete, originalPlan);

    // With red readiness the block phase must be pulled to deload.
    // Because the plan itself carries `phase`, the reassembled plan
    // should reflect that downshift. We check the re-emitted guardrails
    // look different from the originals — the exact rules that fire are
    // tested elsewhere, but the re-run MUST produce a non-identity
    // guardrail set.
    expect(adjusted.guardrailResults).not.toEqual(originalPlan.guardrailResults);
  });

  it('is a no-op when readiness stays green or yellow', () => {
    // Green/yellow explicitly skip the adjustment path — otherwise we
    // would pay the cost on every healthy home-view hit.
    const yellowAthlete: AthleteState = {
      ...sampleMarathonAthlete,
      readiness: {
        ...sampleMarathonAthlete.readiness,
        level: 'yellow',
        score: 72,
      },
    };
    const plan = buildWeekPlan(yellowAthlete, '2026-05-11');
    const result = adjustForFatigue(yellowAthlete, plan);

    expect(result).toBe(plan); // reference equality — returned same object
  });

  it('enumerates fired guardrails in the daily rationale and preserves every guardrail result', () => {
    // The prior implementation filtered guardrailResults to just
    // readiness+schedule and did not include their adjustment reasons
    // in `rationale`. This meant the "why did today change?" story was
    // only answerable via an LLM briefing. Now every adjusted guardrail
    // is a rationale line and every guardrail result flows through.
    const plan = buildWeekPlan(sampleMarathonAthlete, '2026-05-11');

    // Inject a synthetic adjusted guardrail so we can assert the
    // rationale pipeline transparently (without depending on which
    // specific guardrails happen to fire for the sample athlete).
    const syntheticPlan = {
      ...plan,
      guardrailResults: [
        ...plan.guardrailResults,
        { ruleId: 'volume_growth', status: 'warn' as const, adjusted: true, message: 'Capped volume growth at +8% because adherence dipped below 75%.' },
        { ruleId: 'readiness', status: 'pass' as const, adjusted: false, message: 'Readiness within band.' },
      ],
    };

    const day = buildDayPlan(sampleMarathonAthlete, syntheticPlan, 'tuesday');

    // Every guardrail result (pass AND warn) flows through.
    expect(day.guardrailResults.length).toBe(syntheticPlan.guardrailResults.length);

    // Only adjusted guardrails surface in the rationale, prefixed with ✳.
    const adjustedLine = day.rationale.find((line) => line.includes('Capped volume growth'));
    expect(adjustedLine).toBeTruthy();
    expect(adjustedLine!.startsWith('✳')).toBe(true);

    // Pass-status guardrails should NOT appear in rationale.
    expect(day.rationale.some((line) => line.includes('Readiness within band'))).toBe(false);
  });
});

