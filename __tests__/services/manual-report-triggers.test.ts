// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDb = vi.fn();
const mockGetOwnerBootstrapTarget = vi.fn();
const mockRunContentDiscovery = vi.fn();
const mockGenerateCoachBriefing = vi.fn();
const mockBuildEndOfDaySummaryForUser = vi.fn();
const mockSendDailyBriefing = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapTarget: (...args: unknown[]) => mockGetOwnerBootstrapTarget(...args),
}));

vi.mock('../../src/utils/telegram-formatter', () => ({
  splitMessage: (message: string) => [message],
  escapeHtml: (value: string) => value,
}));

vi.mock('../../src/services/content-discovery', () => ({
  runContentDiscovery: (...args: unknown[]) => mockRunContentDiscovery(...args),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  generateCoachBriefing: (...args: unknown[]) => mockGenerateCoachBriefing(...args),
}));

vi.mock('../../src/services/scheduler', () => ({
  buildEndOfDaySummaryForUser: (...args: unknown[]) => mockBuildEndOfDaySummaryForUser(...args),
  sendDailyBriefing: (...args: unknown[]) => mockSendDailyBriefing(...args),
}));

import {
  dispatchCoachReports,
  dispatchContentReports,
  dispatchDailyBriefings,
  dispatchEveningReports,
  getManualReportTargets,
} from '../../src/services/manual-report-triggers';

describe('manual-report-triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getManualReportTargets prefers active users with Telegram ids from the database', () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => [
          { id: 11, telegram_id: 1011 },
          { id: 22, telegram_id: 2022 },
          { id: 33, telegram_id: null },
        ]),
      })),
    });

    expect(getManualReportTargets()).toEqual([
      { userId: 11, tenantId: 11, telegramId: 1011 },
      { userId: 22, tenantId: 22, telegramId: 2022 },
    ]);
  });

  it('getManualReportTargets falls back to the explicit owner bootstrap target', () => {
    mockGetDb.mockImplementation(() => {
      throw new Error('no users table');
    });
    mockGetOwnerBootstrapTarget.mockReturnValue({ tenantId: 17, telegramId: 7001 });

    expect(getManualReportTargets()).toEqual([
      { userId: 17, tenantId: 17, telegramId: 7001 },
    ]);
  });

  it('getManualReportTargets returns an empty list when no owner bootstrap target exists', () => {
    mockGetDb.mockImplementation(() => {
      throw new Error('no users table');
    });
    mockGetOwnerBootstrapTarget.mockReturnValue(null);

    expect(getManualReportTargets()).toEqual([]);
  });

  it('dispatchContentReports runs discovery per tenant and sends per-target summaries', async () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => [{ id: 11, telegram_id: 1011 }]),
      })),
    });
    mockRunContentDiscovery.mockResolvedValue({
      ideas: ['Idea A', 'Idea B'],
      filePath: '/tmp/ideas.md',
      searchCount: 3,
    });
    const send = vi.fn().mockResolvedValue(undefined);

    await dispatchContentReports(send);

    expect(mockRunContentDiscovery).toHaveBeenCalledWith({ userId: 11, tenantId: 11 });
    expect(send).toHaveBeenCalledWith(
      1011,
      expect.stringContaining('Idea A'),
      'HTML',
    );
  });

  it('dispatchCoachReports generates and sends a coach briefing per tenant', async () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => [{ id: 11, telegram_id: 1011 }]),
      })),
    });
    mockGenerateCoachBriefing.mockResolvedValue({ message: 'coach message' });
    const send = vi.fn().mockResolvedValue(undefined);

    await dispatchCoachReports(send);

    expect(mockGenerateCoachBriefing).toHaveBeenCalledWith(11, { garminSilent: true });
    expect(send).toHaveBeenCalledWith(1011, 'coach message', 'HTML');
  });

  it('dispatchEveningReports builds end-of-day summaries per tenant and falls back to the empty-state message', async () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => [
          { id: 11, telegram_id: 1011 },
          { id: 22, telegram_id: 2022 },
        ]),
      })),
    });
    mockBuildEndOfDaySummaryForUser
      .mockResolvedValueOnce({ message: 'summary 11' })
      .mockResolvedValueOnce(null);
    const send = vi.fn().mockResolvedValue(undefined);

    await dispatchEveningReports(send);

    expect(mockBuildEndOfDaySummaryForUser).toHaveBeenNthCalledWith(1, 11);
    expect(mockBuildEndOfDaySummaryForUser).toHaveBeenNthCalledWith(2, 22);
    expect(send).toHaveBeenNthCalledWith(1, 1011, 'summary 11', 'HTML');
    expect(send).toHaveBeenNthCalledWith(
      2,
      2022,
      expect.stringContaining('No tasks due today or overdue'),
      'HTML',
    );
  });

  it('dispatchDailyBriefings delegates to the scheduler path', async () => {
    const bot = { api: {} };
    await dispatchDailyBriefings(bot);
    expect(mockSendDailyBriefing).toHaveBeenCalledWith(bot);
  });
});
