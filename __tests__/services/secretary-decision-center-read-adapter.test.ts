import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDecisionOverview = vi.fn();

vi.mock('../../src/services/decision-center', () => ({
  getDecisionOverview: (...args: unknown[]) => mockGetDecisionOverview(...args),
}));

describe('Secretary Decision Center read adapter', () => {
  beforeEach(() => {
    mockGetDecisionOverview.mockReset();
  });

  it('rejects a scope mismatch before reading Decision Center', async () => {
    const { readSecretaryDecisionProjection } = await import(
      '../../src/services/secretary-decision-center-read-adapter'
    );

    const result = readSecretaryDecisionProjection(12, 34);

    expect(mockGetDecisionOverview).not.toHaveBeenCalled();
    expect(result.health).toMatchObject({
      status: 'unavailable',
      warningCodes: ['DECISION_CENTER_SCOPE_INVALID'],
    });
  });

  it('rejects an invalid equal scope without reading Decision Center', async () => {
    const { readSecretaryDecisionProjection } = await import(
      '../../src/services/secretary-decision-center-read-adapter'
    );

    const result = readSecretaryDecisionProjection(0, 0);

    expect(mockGetDecisionOverview).not.toHaveBeenCalled();
    expect(result.health.warningCodes).toEqual(['DECISION_CENTER_SCOPE_INVALID']);
  });

  it('does not turn a partial Decision overview into a ready all-clear', async () => {
    mockGetDecisionOverview.mockReturnValue({
      items: [],
      handled: [],
      partial: { items: true, handled: false, summary: false },
    });
    const { readSecretaryDecisionProjection } = await import(
      '../../src/services/secretary-decision-center-read-adapter'
    );

    const result = readSecretaryDecisionProjection(12, 12);

    expect(result.health).toMatchObject({
      status: 'degraded',
      warningCodes: ['DECISION_CENTER_PARTIAL'],
    });
  });

  it('fails closed when the Decision read throws', async () => {
    mockGetDecisionOverview.mockImplementation(() => {
      throw new Error('private provider detail');
    });
    const { readSecretaryDecisionProjection } = await import(
      '../../src/services/secretary-decision-center-read-adapter'
    );

    const result = readSecretaryDecisionProjection(12, 12);

    expect(result.signals).toBeUndefined();
    expect(result.health.status).toBe('unavailable');
  });

  it('reports unavailable when neither Decision Center partition is available', async () => {
    mockGetDecisionOverview.mockReturnValue({
      items: [],
      handled: [],
      partial: { items: false, handled: false, summary: false },
    });
    const { readSecretaryDecisionProjection } = await import(
      '../../src/services/secretary-decision-center-read-adapter'
    );

    const result = readSecretaryDecisionProjection(12, 12);

    expect(result.health).toMatchObject({
      status: 'unavailable',
      warningCodes: ['DECISION_CENTER_UNAVAILABLE'],
    });
  });

  it('projects Secretary-only title fallbacks, filters blanks, and counts both stale signals', async () => {
    mockGetDecisionOverview.mockReturnValue({
      items: [
        {
          sourceSkill: 'secretary',
          explanation: { userAction: 'Confirm the move' },
          summary: 'unused summary',
          title: 'unused title',
          analysis: { sourceFreshness: 'stale' },
        },
        {
          sourceSkill: 'secretary',
          explanation: {},
          summary: 'Review lunch conflict',
          title: 'unused title',
          analysis: { sourceFreshness: 'fresh' },
          sourceTrace: { dataFreshness: 'cached' },
        },
        {
          sourceSkill: 'secretary',
          explanation: {},
          summary: undefined,
          title: 'Review travel time',
          recommendedActionLabel: 'Open review',
          analysis: { sourceFreshness: 'fresh' },
          sourceTrace: { dataFreshness: 'live' },
        },
        {
          sourceSkill: 'secretary',
          explanation: {},
          summary: undefined,
          title: '   ',
          analysis: { sourceFreshness: 'fresh' },
        },
        {
          sourceSkill: 'training',
          title: 'Not Secretary work',
          analysis: { sourceFreshness: 'stale' },
        },
      ],
      handled: [
        {
          sourceSkill: 'secretary',
          explanation: { result: 'Moved focus block' },
          summary: 'unused summary',
          title: 'unused title',
        },
        {
          sourceSkill: 'secretary',
          explanation: {},
          summary: 'Protected lunch',
          title: 'unused title',
        },
        {
          sourceSkill: 'secretary',
          explanation: {},
          summary: undefined,
          title: 'Cleared duplicate',
        },
        {
          sourceSkill: 'secretary',
          explanation: {},
          summary: undefined,
          title: ' ',
        },
      ],
      partial: { items: true, handled: true, summary: true },
    });
    const { readSecretaryDecisionProjection } = await import(
      '../../src/services/secretary-decision-center-read-adapter'
    );

    const result = readSecretaryDecisionProjection(12, 12);

    expect(result.health.status).toBe('ready');
    expect(result.signals).toEqual({
      handledCount: 4,
      handledTitles: ['Moved focus block', 'Protected lunch', 'Cleared duplicate'],
      needsUserCount: 4,
      needsUserTitles: ['Confirm the move', 'Review lunch conflict', 'Review travel time'],
      staleCount: 2,
      topUserAction: 'Confirm the move',
    });
  });

  it('sanitizes a non-Error Decision Center failure to an unavailable projection', async () => {
    mockGetDecisionOverview.mockImplementation(() => {
      throw 'provider_failed';
    });
    const { readSecretaryDecisionProjection } = await import(
      '../../src/services/secretary-decision-center-read-adapter'
    );

    const result = readSecretaryDecisionProjection(12, 12);

    expect(result.signals).toBeUndefined();
    expect(result.health.warningCodes).toEqual(['DECISION_CENTER_UNAVAILABLE']);
  });
});
