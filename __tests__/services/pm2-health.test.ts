import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureError = vi.fn();

vi.mock('../../src/services/error-monitor', () => ({
  captureError: (...args: unknown[]) => captureError(...args),
}));

import {
  getPm2SupervisorHealth,
  recordPm2SupervisorAlerts,
  resetPm2HealthAlertStateForTests,
} from '../../src/services/pm2-health';

function execWithPayload(payload: unknown) {
  return vi.fn((_file, _args, _options, callback) => {
    callback(null, JSON.stringify(payload), '');
  });
}

describe('pm2-health', () => {
  beforeEach(() => {
    captureError.mockReset();
    resetPm2HealthAlertStateForTests();
  });

  it('maps pm2 jlist output into health-process fields', async () => {
    const execFileImpl = execWithPayload([{
      name: 'nexus-hub',
      pm_id: 7,
      pm2_env: {
        status: 'online',
        restart_time: 2,
        unstable_restarts: 0,
        pm_uptime: 1_000,
        exit_code: 0,
      },
    }]);

    const health = await getPm2SupervisorHealth({ execFileImpl, pm2Bin: 'pm2', nowMs: 11_000 });

    expect(health).toEqual({
      available: true,
      processes: [{
        name: 'nexus-hub',
        pmId: 7,
        status: 'online',
        restartCount: 2,
        unstableRestarts: 0,
        uptimeMs: 10_000,
        lastCrashReason: null,
      }],
    });
    expect(execFileImpl).toHaveBeenCalledWith(
      'pm2',
      ['jlist'],
      expect.objectContaining({ timeout: 2_000 }),
      expect.any(Function),
    );
  });

  it('returns unavailable instead of throwing when pm2 cannot be called', async () => {
    const execFileImpl = vi.fn((_file, _args, _options, callback) => {
      callback(new Error('spawn pm2 ENOENT'), '', 'pm2 not found');
    });

    const health = await getPm2SupervisorHealth({ execFileImpl, pm2Bin: 'pm2' });

    expect(health.available).toBe(false);
    expect(health.error).toContain('pm2 not found');
    expect(health.processes).toEqual([]);
  });

  it('records an operator-visible alert for a crash-loop process', () => {
    const count = recordPm2SupervisorAlerts({
      available: true,
      processes: [{
        name: 'nexus-hub',
        pmId: 0,
        status: 'online',
        restartCount: 16,
        unstableRestarts: 1,
        uptimeMs: 30_000,
        lastCrashReason: 'exit_code=1 restart_delay=5000',
      }],
    }, 100_000);

    expect(count).toBe(1);
    expect(captureError).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warning',
      source: 'process',
      message: expect.stringContaining('PM2 supervisor attention required: nexus-hub'),
      context: expect.objectContaining({
        restartCount: 16,
        unstableRestarts: 1,
      }),
    }));
  });

  it('records an error-level alert when a process is not online', () => {
    const count = recordPm2SupervisorAlerts({
      available: true,
      processes: [{
        name: 'nexus-hub',
        pmId: 0,
        status: 'errored',
        restartCount: 3,
        unstableRestarts: 0,
        uptimeMs: null,
        lastCrashReason: 'exit_code=1',
      }],
    }, 100_000);

    expect(count).toBe(1);
    expect(captureError).toHaveBeenCalledWith(expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('status=errored'),
    }));
  });

  it('deduplicates repeated supervisor alerts inside the cooldown window', () => {
    const health = {
      available: true,
      processes: [{
        name: 'nexus-hub',
        pmId: 0,
        status: 'online',
        restartCount: 16,
        unstableRestarts: 1,
        uptimeMs: 30_000,
        lastCrashReason: null,
      }],
    };

    expect(recordPm2SupervisorAlerts(health, 100_000)).toBe(1);
    expect(recordPm2SupervisorAlerts(health, 101_000)).toBe(0);
    expect(captureError).toHaveBeenCalledTimes(1);
  });
});
