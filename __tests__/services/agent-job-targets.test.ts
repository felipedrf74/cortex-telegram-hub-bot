import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  all: vi.fn(),
  getOwnerBootstrapTarget: vi.fn(),
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  )),
  getDb: () => ({
    prepare: () => ({ all: (...args: unknown[]) => mocks.all(...args) }),
  }),
}));

vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service',
  )),
  getOwnerBootstrapTarget: (...args: unknown[]) => mocks.getOwnerBootstrapTarget(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  AgentJobTargetReadUnavailableError,
  listActiveAgentJobTenantTargets,
} from '../../src/services/agent-job-targets';

describe('agent job tenant target discovery', () => {
  beforeEach(() => {
    mocks.all.mockReset();
    mocks.getOwnerBootstrapTarget.mockReset();
  });

  it('returns every validated active tenant-user pair', () => {
    mocks.all.mockReturnValue([
      { id: 7, telegram_id: 70 },
      { id: 9, telegram_id: null },
    ]);

    expect(listActiveAgentJobTenantTargets()).toEqual([
      { tenantId: 7, userId: 7, telegramId: 70 },
      { tenantId: 9, userId: 9, telegramId: null },
    ]);
    expect(mocks.getOwnerBootstrapTarget).not.toHaveBeenCalled();
  });

  it('uses the owner bootstrap only when the users table is provably absent', () => {
    mocks.all.mockImplementation(() => {
      throw new Error('no such table: users');
    });
    mocks.getOwnerBootstrapTarget.mockReturnValue({ tenantId: 11, telegramId: 110 });

    expect(listActiveAgentJobTenantTargets({ allowBootstrapFallback: true })).toEqual([
      { tenantId: 11, userId: 11, telegramId: 110 },
    ]);
  });

  it('returns no targets when the users table exists with no active users', () => {
    mocks.all.mockReturnValue([]);
    mocks.getOwnerBootstrapTarget.mockReturnValue({ tenantId: 11, telegramId: 110 });

    expect(listActiveAgentJobTenantTargets()).toEqual([]);
    expect(mocks.getOwnerBootstrapTarget).not.toHaveBeenCalled();
  });

  it('fails closed instead of silently running only the owner on storage outage', () => {
    mocks.all.mockImplementation(() => {
      throw new Error('database unavailable');
    });

    expect(() => listActiveAgentJobTenantTargets())
      .toThrow(AgentJobTargetReadUnavailableError);
    expect(mocks.getOwnerBootstrapTarget).not.toHaveBeenCalled();
  });
});
