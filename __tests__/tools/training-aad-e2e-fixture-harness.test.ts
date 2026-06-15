// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import {
  buildNexushubbotLisbonCalendarFixture,
  buildTrainingAadScenarioDefinitions,
  renderTrainingAadFixtureMarkdown,
  renderTrainingAadNegativeControlsMarkdown,
  runTrainingAadFixtureHarness,
  runTrainingAadNegativeControls,
} from '../../src/tools/training-aad-e2e-fixture-harness';

describe('Training A-AD E2E fixture harness', () => {
  it('keeps the full A-AD execution matrix explicit', () => {
    const scenarios = buildTrainingAadScenarioDefinitions();

    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      'I',
      'J',
      'K',
      'L',
      'M',
      'N',
      'O',
      'P',
      'Q',
      'R',
      'S',
      'T',
      'U',
      'V',
      'W',
      'X',
      'Y',
      'Z',
      'AA',
      'AB',
      'AC',
      'AD',
    ]);

    for (const scenario of scenarios) {
      expect(scenario.userAccount).toContain('nexushubbot@gmail.com');
      expect(scenario.inputs.length).toBeGreaterThan(0);
      expect(scenario.signalInjectionPath.length).toBeGreaterThan(0);
      expect(scenario.expectedBackendResult.length).toBeGreaterThan(0);
      expect(scenario.expectedIosResult.length).toBeGreaterThan(0);
      expect(scenario.calendarExpectation.length).toBeGreaterThan(0);
      expect(scenario.evidenceExpectation.length).toBeGreaterThan(0);
      expect(scenario.validators.length).toBeGreaterThan(0);
    }
  });

  it('defines the required Lisbon calendar and DST fixture rows', () => {
    const fixture = buildNexushubbotLisbonCalendarFixture('2026-06-22');
    const calendarTypes = fixture.map((item) => item.calendarType);

    expect(calendarTypes).toEqual(expect.arrayContaining([
      'Busy workday',
      'Fragmented day',
      'Travel day',
      'Existing workout + personal commitment',
      'All-day busy marker',
      'Long availability',
      'Recovery/flexible',
      'DST case',
    ]));
    expect(fixture.find((item) => item.calendarType === 'DST case')?.date).toBe('2026-10-25');
  });

  it('executes every scenario through the local planner and renders a report', () => {
    const result = runTrainingAadFixtureHarness({ weekStart: '2026-06-22' });

    expect(result.testIdentity).toBe('nexushubbot@gmail.com');
    expect(result.timezone).toBe('Europe/Lisbon');
    expect(result.aggregate.scenarioCount).toBe(30);
    expect(result.aggregate.passCount + result.aggregate.failCount).toBe(30);
    expect(result.aggregate.averageScore).toBeGreaterThanOrEqual(1);
    expect(result.aggregate.averageScore).toBeLessThanOrEqual(5);
    expect(result.scenarioResults.every((item) => item.actualBackendResult.length > 0)).toBe(true);

    const markdown = renderTrainingAadFixtureMarkdown(result);
    expect(markdown).toContain('# Training A-AD Local Fixture Harness Report');
    expect(markdown).toContain('| A - Beginner strength, dumbbells only |');
    expect(markdown).toContain('| AD - Same account / two tenants |');
  });

  it('can label the full A-AD run with the Outlook sandbox identity', () => {
    const previous = process.env.TRAINING_AAD_TEST_IDENTITY;
    process.env.TRAINING_AAD_TEST_IDENTITY = 'nexushubbot@hotmail.com';
    try {
      const scenarios = buildTrainingAadScenarioDefinitions();
      const result = runTrainingAadFixtureHarness({ weekStart: '2026-06-22' });

      expect(result.testIdentity).toBe('nexushubbot@hotmail.com');
      expect(scenarios.every((scenario) => scenario.userAccount.includes('nexushubbot@hotmail.com'))).toBe(true);
      expect(result.scenarioResults.every((scenario) => scenario.userAccount.includes('nexushubbot@hotmail.com'))).toBe(true);
    } finally {
      if (previous == null) {
        delete process.env.TRAINING_AAD_TEST_IDENTITY;
      } else {
        process.env.TRAINING_AAD_TEST_IDENTITY = previous;
      }
    }
  });

  it('fails required negative controls for bad A-AD outputs', () => {
    const results = runTrainingAadNegativeControls();

    expect(results.map((result) => result.id)).toEqual([
      'unavailable_equipment',
      'calendar_overlap',
      'bad_sleep_ignored',
      'injury_ignored',
      'missed_session_cramming',
      'race_taper_cramming',
      'raw_ui_internal_text',
      'tenant_leak',
    ]);
    expect(results.every((result) => result.passFail === 'pass')).toBe(true);
    expect(results.every((result) => result.notes.length > 0)).toBe(true);

    const markdown = renderTrainingAadNegativeControlsMarkdown(results);
    expect(markdown).toContain('## A-AD Harness Strictness');
    expect(markdown).toContain('Unavailable equipment negative control');
    expect(markdown).toContain('Tenant leak negative control');
  });
});
