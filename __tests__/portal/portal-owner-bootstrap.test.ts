import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockGetDb = vi.fn();
const mockIsGarminConfigured = vi.fn();
const mockClearAllConversations = vi.fn();
const mockPushEvent = vi.fn();
const mockGetOwnerBootstrapTarget = vi.fn();
const mockSendDailyBriefing = vi.fn();

vi.mock('../../src/config', () => ({
  config: {
    portal: { enabled: true, port: 0, bind: '127.0.0.1', token: 'test-portal-token' },
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
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/utils/request-context', () => ({
  runWithContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  generateRequestId: vi.fn(() => 'req-test'),
}));

vi.mock('../../src/services/database', () => ({
  getDb: (...args: unknown[]) => mockGetDb(...args),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/portal/telemetry', () => ({
  getRecentEvents: vi.fn(() => []),
  getJobStatuses: vi.fn(() => []),
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
vi.mock('../../src/services/scheduler', () => ({
  sendDailyBriefing: (...args: unknown[]) => mockSendDailyBriefing(...args),
}));
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
  writeGovernedSignal: vi.fn(() => 1),
}));
vi.mock('../../src/agents/pipeline-agent', () => ({
  getPipelineStats: vi.fn(() => ({ total: 0, published: 0 })),
  runPipelineAgent: vi.fn(),
}));
vi.mock('../../src/agents/seo-agent', () => ({ runSEOAgent: vi.fn() }));
vi.mock('../../src/agents/reaction-radar-agent', () => ({ runReactionRadar: vi.fn() }));
vi.mock('../../src/agents/performance-agent', () => ({ runPerformanceAgent: vi.fn() }));
vi.mock('../../src/agents/voice-evolution-agent', () => ({
  runVoiceEvolutionAgent: vi.fn(),
  runScheduledVoiceEvolutionAgent: vi.fn(),
}));
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
vi.mock('../../src/services/user-service', () => ({
  getOwnerBootstrapTarget: (...args: unknown[]) => mockGetOwnerBootstrapTarget(...args),
}));

import {
  getPortalTrainingStatsUserId,
  getPortalUsageMeteringUserIds,
} from '../../src/portal/snapshot-builder';
import {
  VALID_PORTAL_ACTIONS,
  handlePortalAction as handleAction,
  isPortalActionRateLimited,
  recordPortalAction,
  resetPortalActionCooldownsForTests,
} from '../../src/portal/actions';

describe('portal owner bootstrap hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPortalActionCooldownsForTests();
    mockGetOwnerBootstrapTarget.mockReturnValue({ tenantId: 42, telegramId: 1042 });
    mockGetDb.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => []),
        get: vi.fn(() => null),
      })),
    });
    mockIsGarminConfigured.mockReturnValue(true);
    mockSendDailyBriefing.mockResolvedValue(true);
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

  it('clear-history uses the canonical owner bootstrap tenant instead of synthetic user 0', async () => {
    const result = await handleAction('clear-history');

    expect(result.ok).toBe(true);
    expect(mockClearAllConversations).toHaveBeenCalledWith(42);
    expect(mockClearAllConversations).not.toHaveBeenCalledWith(0);
  });

  it('clear-history fails honestly when no owner bootstrap target exists', async () => {
    mockGetOwnerBootstrapTarget.mockReturnValue(null);

    const result = await handleAction('clear-history');

    expect(result).toEqual({
      ok: false,
      message: 'Owner bootstrap target unavailable',
    });
    expect(mockClearAllConversations).not.toHaveBeenCalled();
  });

  it('keeps portal action allowlist and cooldown ownership outside the server factory', () => {
    expect(VALID_PORTAL_ACTIONS.has('trigger-briefing')).toBe(true);
    expect(VALID_PORTAL_ACTIONS.has('run-performance-agent')).toBe(false);
    expect(VALID_PORTAL_ACTIONS.has('run-reaction-radar')).toBe(false);
    expect(VALID_PORTAL_ACTIONS.has('run-seo-agent')).toBe(false);
    expect(isPortalActionRateLimited('trigger-briefing')).toBe(false);

    recordPortalAction('trigger-briefing');

    expect(isPortalActionRateLimited('trigger-briefing')).toBe(true);
  });

  it('reports the manual briefing as disabled when the scheduler parent/sub-skill gate rejects it', async () => {
    mockSendDailyBriefing.mockResolvedValue(false);

    const result = await handleAction('trigger-briefing');

    expect(result).toEqual({ ok: false, message: 'Secretary briefings are disabled' });
    expect(mockPushEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'auth',
      summary: expect.stringContaining('disabled'),
    }));
  });

  it('reports success only after the gated manual briefing executes', async () => {
    const result = await handleAction('trigger-briefing');

    expect(result).toEqual({ ok: true, message: 'Morning briefing stored and pushed' });
    expect(mockSendDailyBriefing).toHaveBeenCalledTimes(1);
  });

  it('does not expose paused Content agent manual actions in the portal', async () => {
    const portalHtml = readFileSync(path.resolve(__dirname, '../../src/portal/portal.html'), 'utf8')
      + readFileSync(path.resolve(__dirname, '../../src/portal/ui/legacy.js'), 'utf8');

    expect(portalHtml).not.toContain("name: 'run-performance-agent'");
    expect(portalHtml).not.toContain("name: 'run-reaction-radar'");
    expect(portalHtml).not.toContain("name: 'run-seo-agent'");
    expect(portalHtml).toContain('Historical Reaction Radar signals are hidden while the agent is paused.');
    await expect(handleAction('run-performance-agent')).resolves.toEqual({
      ok: false,
      message: 'Unknown action: run-performance-agent',
    });
    await expect(handleAction('run-seo-agent')).resolves.toEqual({
      ok: false,
      message: 'Unknown action: run-seo-agent',
    });
    await expect(handleAction('run-reaction-radar')).resolves.toEqual({
      ok: false,
      message: 'Unknown action: run-reaction-radar',
    });
  });

  it('keeps the mixed legacy Content overview outside the selected tenant scope', () => {
    const portalHtml = readFileSync(path.resolve(__dirname, '../../src/portal/ui/legacy.js'), 'utf8');

    expect(portalHtml).toContain("url === '/api/v1/admin/content'");
    expect(portalHtml).toContain("url.startsWith('/api/v1/admin/content/')");
    expect(portalHtml).not.toContain("url.includes('/api/v1/admin/content')");
    expect(portalHtml).toContain('mixed overview remains owner-bootstrap/platform');
    expect(portalHtml).toContain('legacy mixed overview is intentionally');
  });
});
