import { describe, expect, it } from 'vitest';

import {
  trainingSemanticFixtures,
  type TrainingSemanticFixture,
} from '../fixtures/training/semantic-fixtures';
import { lintPlan } from '../../src/services/coach-kernel/plan-linter';
import {
  buildRichSessionDescription,
  type RichSessionDescription,
} from '../../src/services/training-session-description';

const REQUIRED_FIXTURE_IDS = [
  'advanced-marathon-5-gym-6-run',
  'beginner-no-equipment',
  'continuous-strength-maintenance',
  'long-run-saturday-conflict',
  'low-sleep-readiness-cap',
  'calendar-packed-reflow',
  'fueling-missing-hard-session',
  'strength-session-modality-copy',
  'running-session-modality-copy',
  'cycling-session-modality-copy',
  'triathlon-hybrid-balance',
  'race-date-far-future-roadmap',
  'continuous-no-event-deload',
  'missed-sessions-reflow',
  'injury-discomfort-substitution',
  'user-switch-training-plan-isolation',
  'calendar-sync-partial-summary',
  'duplicate-decision-trail-dedupe',
] as const;

const GENERIC_OR_DEBUG_COPY =
  /\b(calendar_busy_blocks|session_prescription|fueling_gap_risk|decision_trail|source_trace|mp\d+|needs your attention|generic conflict)\b/i;

function renderedText(description: RichSessionDescription): string {
  const execution = description.sections.execution
    ?.map((item) => `${item.label} ${item.value} ${item.note ?? ''}`)
    .join('\n') ?? '';
  const exercises = description.sections.exercises
    ?.map((item) => `${item.name} ${item.detail} ${item.note ?? ''}`)
    .join('\n') ?? '';
  return [
    description.text,
    description.sections.notes ?? '',
    execution,
    exercises,
  ].join('\n');
}

function assertCopyPresent(text: string, expected: string[], fixtureId: string): void {
  for (const token of expected) {
    expect(text.toLowerCase(), `${fixtureId} should render "${token}"`).toContain(token.toLowerCase());
  }
}

function assertCopyAbsent(text: string, forbidden: string[], fixtureId: string): void {
  for (const token of forbidden) {
    expect(text.toLowerCase(), `${fixtureId} should not render "${token}"`).not.toContain(token.toLowerCase());
  }
}

describe('training semantic fixture matrix', () => {
  it('pins the required fixture roster in prompt order', () => {
    expect(trainingSemanticFixtures.map((fixture) => fixture.id)).toEqual([...REQUIRED_FIXTURE_IDS]);
    expect(new Set(trainingSemanticFixtures.map((fixture) => fixture.id)).size).toBe(trainingSemanticFixtures.length);
  });

  it('keeps every fixture traceable, scoped, and free of raw debug copy in primary expectations', () => {
    for (const fixture of trainingSemanticFixtures) {
      expect(fixture.sourceTrace.originatingSkill, fixture.id).toBeTruthy();
      expect(fixture.sourceTrace.originatingSignal, fixture.id).toBeTruthy();
      expect(fixture.sourceTrace.sourceEntityIds.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.sourceTrace.verifier, fixture.id).toBeTruthy();
      expect(fixture.expected.planQuality.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.expected.ui.primaryCopy.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.expected.privacy.userId, fixture.id).toBe(fixture.expected.privacy.tenantId);

      const primaryCopy = fixture.expected.ui.primaryCopy.join('\n');
      expect(primaryCopy, fixture.id).not.toMatch(GENERIC_OR_DEBUG_COPY);
      expect(primaryCopy, fixture.id).not.toMatch(/\bReview\b$/i);
    }
  });

  it('covers the requested cross-skill surfaces without pretending every fixture is production-real', () => {
    const hasIntegration = (key: keyof TrainingSemanticFixture['expected']['integrations']) =>
      trainingSemanticFixtures.some((fixture) => fixture.expected.integrations[key]);

    expect(hasIntegration('secretary')).toBe(true);
    expect(hasIntegration('cooking')).toBe(true);
    expect(hasIntegration('decisionCenter')).toBe(true);
    expect(hasIntegration('chatCorrection')).toBe(true);
    expect(trainingSemanticFixtures.some((fixture) => fixture.productionStatus === 'fixture_only')).toBe(true);
    expect(
      trainingSemanticFixtures.find((fixture) => fixture.id === 'user-switch-training-plan-isolation')
        ?.expected.privacy.forbiddenPreviewCopy,
    ).toEqual(expect.arrayContaining(['User A', 'private plan']));
  });

  it('validates real plan-linter-backed fixture expectations', () => {
    const lintBacked = trainingSemanticFixtures.filter((fixture) => fixture.planLintInput);
    expect(lintBacked.map((fixture) => fixture.id)).toEqual([
      'beginner-no-equipment',
      'continuous-no-event-deload',
    ]);

    for (const fixture of lintBacked) {
      const result = lintPlan(fixture.planLintInput!);
      if (fixture.expected.gateStatus === 'pass') {
        expect(result.status, fixture.id).not.toBe('fail');
        expect(result.blockers, fixture.id).toHaveLength(0);
      }
    }

    const continuous = lintBacked.find((fixture) => fixture.id === 'continuous-no-event-deload');
    expect(lintPlan(continuous!.planLintInput!).warnings.map((warning) => warning.ruleId)).not.toContain(
      'no_fake_taper_without_event',
    );
  });

  it('validates real modality-copy fixtures through the canonical description builder', () => {
    const descriptionBacked = trainingSemanticFixtures.filter((fixture) => fixture.sessionDescriptionInput);
    expect(descriptionBacked.map((fixture) => fixture.id)).toEqual([
      'strength-session-modality-copy',
      'running-session-modality-copy',
      'cycling-session-modality-copy',
    ]);

    for (const fixture of descriptionBacked) {
      const description = buildRichSessionDescription(fixture.sessionDescriptionInput!);
      const text = renderedText(description);
      assertCopyPresent(text, fixture.expected.sessionQuality.requiredCopy, fixture.id);
      assertCopyAbsent(text, fixture.expected.sessionQuality.forbiddenCopy, fixture.id);
      expect(text, fixture.id).not.toMatch(GENERIC_OR_DEBUG_COPY);

      if (fixture.expected.sessionQuality.modality === 'strength') {
        expect(description.sections.execution, fixture.id).toBeUndefined();
        expect(description.sections.exercises?.length, fixture.id).toBeGreaterThan(0);
      } else {
        expect(description.sections.execution?.length, fixture.id).toBeGreaterThan(0);
      }
    }
  });
});
