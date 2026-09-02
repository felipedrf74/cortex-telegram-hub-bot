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
});
