import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUserById = vi.fn();

vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  )),
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

describe('secretary planning context', () => {
  beforeEach(() => {
    mockGetUserById.mockReset();
    mockGetUserById.mockReturnValue({
      id: 12,
      tier: 'max',
      timezone: 'America/New_York',
      language: 'pt-PT',
    });
  });

  it('rejects a tenant mismatch before reading the user profile', async () => {
    const { resolveSecretaryPlanningContext, SecretaryPlanningContextError } = await import(
      '../../src/services/secretary-planning-context'
    );

    expect(() => resolveSecretaryPlanningContext({ userId: 12, tenantId: 34 }))
      .toThrow(SecretaryPlanningContextError);
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('rejects malformed calendar dates before reading the user profile', async () => {
    const { resolveSecretaryPlanningContext } = await import('../../src/services/secretary-planning-context');

    expect(() => resolveSecretaryPlanningContext({ userId: 12, tenantId: 12, date: '2026-02-30' }))
      .toThrowError(expect.objectContaining({ code: 'INVALID_DATE' }));
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('uses the saved IANA timezone and supported language for one deterministic week', async () => {
    const { resolveSecretaryPlanningContext } = await import('../../src/services/secretary-planning-context');
    const result = resolveSecretaryPlanningContext({
      userId: 12,
      tenantId: 12,
      date: '2026-03-08',
      language: 'pt-PT',
    });

    expect(result).toMatchObject({
      timezone: 'America/New_York',
      language: 'pt-PT',
      targetDate: '2026-03-08',
      weekStart: '2026-03-02',
      weekEnd: '2026-03-08',
    });
  });

  it('canonicalizes a valid saved timezone alias before building cache identity', async () => {
    mockGetUserById.mockReturnValueOnce({
      id: 12,
      tier: 'max',
      timezone: 'Etc/UTC',
      language: 'en-US',
    });
    const { resolveSecretaryPlanningContext } = await import('../../src/services/secretary-planning-context');

    const result = resolveSecretaryPlanningContext({ userId: 12, tenantId: 12, date: '2026-04-15' });

    expect(result.timezone).toBe('UTC');
    expect(result.warningCodes).toEqual([]);
  });

  it('anchors a week-only request to a day inside that exact composed week', async () => {
    const { resolveSecretaryPlanningContext } = await import('../../src/services/secretary-planning-context');
    const result = resolveSecretaryPlanningContext({
      userId: 12,
      tenantId: 12,
      weekStart: '2026-04-15',
    });

    expect(result).toMatchObject({
      targetDate: '2026-04-13',
      weekStart: '2026-04-13',
      weekEnd: '2026-04-19',
    });
  });

  it('derives the local day and ISO week across the New York spring DST boundary', async () => {
    vi.useFakeTimers();
    try {
      const { resolveSecretaryPlanningContext } = await import('../../src/services/secretary-planning-context');
      vi.setSystemTime(new Date('2026-03-08T04:30:00.000Z'));
      const before = resolveSecretaryPlanningContext({ userId: 12, tenantId: 12 });
      vi.setSystemTime(new Date('2026-03-08T07:30:00.000Z'));
      const after = resolveSecretaryPlanningContext({ userId: 12, tenantId: 12 });

      expect(before).toMatchObject({ targetDate: '2026-03-07', weekStart: '2026-03-02' });
      expect(after).toMatchObject({ targetDate: '2026-03-08', weekStart: '2026-03-02' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back safely and reports an invalid saved timezone', async () => {
    mockGetUserById.mockReturnValueOnce({
      id: 12,
      tier: 'max',
      timezone: 'Mars/Olympus',
      language: 'en-US',
    });
    const { resolveSecretaryPlanningContext } = await import('../../src/services/secretary-planning-context');
    const result = resolveSecretaryPlanningContext({ userId: 12, tenantId: 12, date: '2026-04-15' });

    expect(result.timezone).toBe('Europe/Lisbon');
    expect(result.warningCodes).toContain('USER_TIMEZONE_INVALID');
  });
});
