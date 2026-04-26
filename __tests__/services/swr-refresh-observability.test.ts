import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordOperatorAlert = vi.fn();
const loggerWarn = vi.fn();

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => recordOperatorAlert(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => loggerWarn(...args),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('swr-refresh-observability', () => {
  beforeEach(async () => {
    vi.resetModules();
    recordOperatorAlert.mockReset();
    loggerWarn.mockReset();
    const mod = await import('../../src/services/swr-refresh-observability');
    mod._resetSWRRefreshFailuresForTests();
  });

  it('counts consecutive SWR refresh failures and raises an operator alert at threshold', async () => {
    const {
      getSWRRefreshFailureSnapshot,
      recordSWRRefreshFailure,
    } = await import('../../src/services/swr-refresh-observability');

    recordSWRRefreshFailure('u:42:tasks:inbox:all', new Error('provider down'), {
      source: 'tasks_route',
      userId: 42,
      operation: 'task_swr_refresh',
    });
    recordSWRRefreshFailure('u:42:tasks:inbox:all', new Error('provider down'), {
      source: 'tasks_route',
      userId: 42,
      operation: 'task_swr_refresh',
    });
    expect(recordOperatorAlert).not.toHaveBeenCalled();

    recordSWRRefreshFailure('u:42:tasks:inbox:all', new Error('provider down'), {
      source: 'tasks_route',
      userId: 42,
      operation: 'task_swr_refresh',
    });

    expect(getSWRRefreshFailureSnapshot()['u:42:tasks:inbox:all']).toMatchObject({
      consecutiveFailures: 3,
      lastErrorMessage: 'provider down',
    });
    expect(recordOperatorAlert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'swr_refresh',
      title: 'SWR background refresh failing',
      metadata: expect.objectContaining({
        key: 'u:42:tasks:inbox:all',
        consecutiveFailures: 3,
        source: 'tasks_route',
        userId: 42,
      }),
    }));
  });

  it('resets the consecutive failure count after a successful refresh', async () => {
    const {
      getSWRRefreshFailureSnapshot,
      recordSWRRefreshFailure,
      recordSWRRefreshSuccess,
    } = await import('../../src/services/swr-refresh-observability');

    recordSWRRefreshFailure('dashboard:42:pt-BR', new Error('timeout'));
    recordSWRRefreshSuccess('dashboard:42:pt-BR');

    expect(getSWRRefreshFailureSnapshot()['dashboard:42:pt-BR']).toMatchObject({
      consecutiveFailures: 0,
      lastErrorMessage: 'timeout',
    });
  });
});
