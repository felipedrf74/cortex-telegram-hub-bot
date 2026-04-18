import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetDb = vi.fn();
const mockIsGarminConfigured = vi.fn();
const mockDispatchCoachReports = vi.fn();
const mockDispatchContentReports = vi.fn();
const mockClearAllConversations = vi.fn();
const mockPushEvent = vi.fn();
const mockGetOwnerBootstrapTarget = vi.fn();

vi.mock('../../src/config', () => ({
  config: {
    portal: { enabled: true, port: 0, bind: '127.0.0.1', token: 'test-portal-token' },
    telegram: { allowedUserIds: [111111] },
    app: { timezone: 'Europe/Lisbon', databasePath: ':memory:' },
    health: { token: '' },
    webhooks: { enabled: false, secret: '', maxPayloadBytes: 1048576, eventRetentionDays: 30 },
    financeEncryption: { enabled: false, masterKey: '' },
    google: { clientId: '', clientSecret: '', refreshToken: '' },
    outlook: { clientId: '', clientSecret: '', tenantId: '', refreshToken: '' },
    garmin: { email: '', password: '', tokenPath: '', coachEnabled: false, coachTime: '' },
    invoices: { enabled: false, sshHost: '', sshPort: '', sshUser: '', sshKeyPath: '', remotePath: '' },
    contentEngine: { enabled: false, port: 8100 },
    googleDrive: { enabled: false, rootFolderId: '' },
    backup: { time: '03:00' },
    todo: { digestTime: '08:00', digestEnabled: true },
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../src/utils/request-context', () => ({
  runWithContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  generateRequestId: vi.fn(() => 'req-test'),
}));

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('../../src/portal/telemetry', () => ({
  getRecentEvents: vi.fn(() => []),
  getJobStatuses: vi.fn(() => []),
  getBotRef: vi.fn(() => null),
  isBotPollingActive: vi.fn(() => true),
  getLastMessageAt: vi.fn(() => null),
  getGarminRefreshStatus: vi.fn(() => ({ at: null, ok: false })),
  isRestarting: vi.fn(() => false),
  setIsRestarting: vi.fn(),
  setBotPollingActive: vi.fn(),
  pushEvent: (...args: unknown[]) => mockPushEvent(...args),
}));

vi.mock('../../src/state/conversation', () => ({
  clearAllConversations: (...args: unknown[]) => mockClearAllConversations(...args),
}));

vi.mock('../../src/services/garmin', () => ({
  isGarminConfigured: (...args: unknown[]) => mockIsGarminConfigured(...args),
  keepAlive: vi.fn(),
}));

vi.mock('../../src/services/microsoft-auth', () => ({ isMicrosoftConfigured: vi.fn(() => false) }));
vi.mock('../../src/services/invoice-filer', () => ({ isInvoiceFilingConfigured: vi.fn(() => false) }));
vi.mock('../../src/services/google-calendar', () => ({ isGoogleCalendarConfigured: vi.fn(() => false) }));
vi.mock('../../src/services/google-gmail', () => ({ isGmailConfigured: vi.fn(() => false) }));
vi.mock('../../src/services/google-drive', () => ({ isGoogleDriveEnabled: vi.fn(() => false) }));
vi.mock('../../src/services/outlook-calendar', () => ({ isOutlookCalendarConfigured: vi.fn(() => false) }));
vi.mock('../../src/services/outlook-mail', () => ({ isOutlookMailConfigured: vi.fn(() => false) }));
vi.mock('../../src/services/microsoft-todo', () => ({ isOutlookTodoConfigured: vi.fn(() => false) }));
vi.mock('../../src/services/invoice-queue', () => ({ getPendingCount: vi.fn(() => 0) }));
vi.mock('../../src/services/scheduler', () => ({ sendDailyBriefing: vi.fn() }));
vi.mock('../../src/state/content-references', () => ({
  getAllChannels: vi.fn(() => []),
  removeChannel: vi.fn(),
  getAllKnowledge: vi.fn(() => []),
}));
vi.mock('../../src/services/channel-learner', () => ({
  addAndAnalyzeChannel: vi.fn(),
  synthesizeKnowledge: vi.fn(),
}));
vi.mock('../../src/services/intelligence-bus', () => ({
  getActiveSignalCount: vi.fn(() => 0),
  getSignalLog: vi.fn(() => []),
  getAgentStats: vi.fn(() => []),
  dismissSignal: vi.fn(),
  writeSignal: vi.fn(),
}));
vi.mock('../../src/agents/pipeline-agent', () => ({
  getPipelineStats: vi.fn(() => ({ total: 0, published: 0 })),
  runPipelineAgent: vi.fn(),
}));
vi.mock('../../src/agents/seo-agent', () => ({ runSEOAgent: vi.fn() }));
vi.mock('../../src/agents/reaction-radar-agent', () => ({ runReactionRadar: vi.fn() }));
vi.mock('../../src/agents/performance-agent', () => ({ runPerformanceAgent: vi.fn() }));
vi.mock('../../src/agents/voice-evolution-agent', () => ({ runVoiceEvolutionAgent: vi.fn() }));
vi.mock('../../src/skills/skill-manager', () => ({
  getAllSkillStatuses: vi.fn(() => []),
  enableSkill: vi.fn(),
  disableSkill: vi.fn(),
  enableSubSkill: vi.fn(),
  disableSubSkill: vi.fn(),
}));
vi.mock('../../src/services/error-monitor', () => ({ getErrorTrends: vi.fn(() => []) }));
vi.mock('../../src/services/runtime-status', () => ({
  getRuntimeStatus: vi.fn(() => ({
    serviceStatus: 'online',
    databaseStatus: 'connected',
    botPolling: true,
    botRestarting: false,
    lastMessageAt: null,
  })),
}));
vi.mock('../../src/services/webhook-registry', () => ({
  verifySignature: vi.fn(() => true),
  receiveWebhookEvent: vi.fn(),
  getSubscriptions: vi.fn(() => []),
  registerSubscription: vi.fn(),
  removeSubscription: vi.fn(),
  getWebhookStats: vi.fn(() => ({ total: 0 })),
  getRecentEvents: vi.fn(() => []),
  replayEvent: vi.fn(),
  expireSubscriptions: vi.fn(),
}));
vi.mock('../../src/services/manual-report-triggers', () => ({
  dispatchCoachReports: (...args: unknown[]) => mockDispatchCoachReports(...args),
  dispatchContentReports: (...args: unknown[]) => mockDispatchContentReports(...args),
}));
vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapTarget: (...args: unknown[]) => mockGetOwnerBootstrapTarget(...args),
}));

import {
  getPortalTrainingStatsUserId,
  getPortalUsageMeteringUserIds,
  handleAction,
} from '../../src/portal/server';

describe('portal owner bootstrap hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOwnerBootstrapTarget.mockReturnValue({ tenantId: 42, telegramId: 1042 });
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => []),
        get: vi.fn(() => null),
      })),
    });
    mockIsGarminConfigured.mockReturnValue(true);
  });

  it('getPortalTrainingStatsUserId resolves the canonical owner bootstrap tenant', () => {
    expect(getPortalTrainingStatsUserId()).toBe(42);
  });

  it('getPortalUsageMeteringUserIds prefers active canonical users from the database', () => {
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => [{ id: 11 }, { id: 22 }]),
      })),
    });

    expect(getPortalUsageMeteringUserIds()).toEqual([11, 22]);
  });

  it('getPortalUsageMeteringUserIds falls back only to the owner bootstrap tenant', () => {
    mockGetDb.mockImplementation(() => {
      throw new Error('no users table');
    });

    expect(getPortalUsageMeteringUserIds()).toEqual([42]);
  });

  it('trigger-coach delegates to the scoped manual-report dispatcher', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockDispatchCoachReports.mockImplementation(async (send: (telegramId: number, message: string, mode?: 'HTML' | 'MarkdownV2') => Promise<void>) => {
      await send(1042, 'coach message', 'HTML');
    });

    const result = await handleAction('trigger-coach', { api: { sendMessage } } as any);

    expect(result.ok).toBe(true);
    expect(mockDispatchCoachReports).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(1042, 'coach message', { parse_mode: 'HTML' });
  });

  it('trigger-content delegates to the scoped manual-report dispatcher', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    mockDispatchContentReports.mockImplementation(async (send: (telegramId: number, message: string, mode?: 'HTML' | 'MarkdownV2') => Promise<void>) => {
      await send(1042, 'content message', 'HTML');
    });

    const result = await handleAction('trigger-content', { api: { sendMessage } } as any);

    expect(result.ok).toBe(true);
    expect(mockDispatchContentReports).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(1042, 'content message', { parse_mode: 'HTML' });
  });

  it('clear-history uses the canonical owner bootstrap tenant instead of synthetic user 0', async () => {
    const result = await handleAction('clear-history', { api: { sendMessage: vi.fn() } } as any);

    expect(result.ok).toBe(true);
    expect(mockClearAllConversations).toHaveBeenCalledWith(42);
    expect(mockClearAllConversations).not.toHaveBeenCalledWith(0);
  });

  it('clear-history fails honestly when no owner bootstrap target exists', async () => {
    mockGetOwnerBootstrapTarget.mockReturnValue(null);

    const result = await handleAction('clear-history', { api: { sendMessage: vi.fn() } } as any);

    expect(result).toEqual({
      ok: false,
      message: 'Owner bootstrap target unavailable',
    });
    expect(mockClearAllConversations).not.toHaveBeenCalled();
  });
});
