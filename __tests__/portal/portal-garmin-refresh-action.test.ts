// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * The portal's "Refresh Garmin" button had no coverage at all. The only test
 * that names this action, portal-action-routes.test.ts, mocks
 * `src/portal/actions` wholesale, so the handler body never executed.
 *
 * That gap mattered: the button was one of the callers broken by making
 * `resolveGarminUserId` fail closed. It called `garminKeepAlive()` bare, with
 * no request context to inherit a user from, so once the owner fallback was
 * removed it resolved to no user and did nothing while still reporting a
 * failure to the operator.
 *
 * These tests run the real handler against a mocked fan-out. Every mock
 * factory below is complete (all runtime exports present) so the vi.mock
 * completeness ratchet does not regress.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  refreshConnectedGarminUsers: vi.fn(),
  refreshConnectedGarminUsersWithLease: vi.fn(),
  pushEvent: vi.fn(),
}));

vi.mock('../../src/agents/performance-agent', () => ({
  runPerformanceAgent: vi.fn(),
}));

vi.mock('../../src/agents/voice-evolution-agent', () => ({
  VoiceEvolutionFingerprintReadError: vi.fn(),
  VoiceEvolutionProviderSchemaError: vi.fn(),
  VoiceEvolutionProviderCallError: vi.fn(),
  VoiceEvolutionPersistenceError: vi.fn(),
  runVoiceEvolutionAgent: vi.fn(),
  runVoiceEvolutionForTarget: vi.fn(),
  runScheduledVoiceEvolutionAgent: vi.fn(),
}));

vi.mock('../../src/agents/reaction-radar-agent', () => ({
  runReactionRadar: vi.fn(),
}));

vi.mock('../../src/agents/seo-agent', () => ({
  seedKeywordsIfEmpty: vi.fn(),
  runSEOAgent: vi.fn(),
  handleAddSEOKeyword: vi.fn(),
  handleSEORank: vi.fn(),
}));

vi.mock('../../src/agents/pipeline-agent', () => ({
  getPipelineStats: vi.fn(),
  getPipelineOperationalMetrics: vi.fn(),
  runPipelineAgent: vi.fn(),
}));

vi.mock('../../src/services/scheduler', () => ({
  decisionMetricsRollupDateForScheduler: vi.fn(),
  refreshConnectedGarminUsers: (...args: unknown[]) => hoisted.refreshConnectedGarminUsers(...args),
  refreshConnectedGarminUsersWithLease: (...args: unknown[]) =>
    hoisted.refreshConnectedGarminUsersWithLease(...args),
  getActiveTaskSyncScopes: vi.fn(),
  runChatCoreV2ShadowDataRetention: vi.fn(),
  runChatCoreV2GateCheck: vi.fn(),
  buildEndOfDaySummaryForUser: vi.fn(),
  buildDailyBriefingDataForUser: vi.fn(),
  buildWeeklyReviewPayloadForUser: vi.fn(),
  getTodayNotifications: vi.fn(),
  _resetSchedulerTenantStateForTesting: vi.fn(),
  buildSharedListNotificationForUser: vi.fn(),
  buildCalendarConflictAnalysisForUser: vi.fn(),
  buildConflictAlertForUser: vi.fn(),
  formatCalendarConflictMessage: vi.fn(),
  buildSecretaryCalendarConflictDecisionPlans: vi.fn(),
  startScheduler: vi.fn(),
  sendCoachBriefingForTarget: vi.fn(),
  runScheduledCoachBriefingForTarget: vi.fn(),
  sendCoachBriefings: vi.fn(),
  runEndOfDaySummaryForTarget: vi.fn(),
  sendDailyBriefingForTarget: vi.fn(),
  sendDailyBriefing: vi.fn(),
  runContentTopicCronForActiveUsers: vi.fn(),
  runWeeklyContentPackageCronForActiveUsers: vi.fn(),
  getActiveUserIds: vi.fn(),
  getOwnerUserIds: vi.fn(),
}));

vi.mock('../../src/services/microsoft-auth', () => ({
  invalidateMicrosoftAccessTokenCacheForUser: vi.fn(),
  invalidateMicrosoftAccessTokenCacheForOwner: vi.fn(),
  getOutlookRefreshTokenForUser: vi.fn(),
  getAccessTokenForUser: vi.fn(),
  setRequestUserId: vi.fn(),
  getGraphClient: vi.fn(),
  getGraphClientForUser: vi.fn(),
  isMicrosoftConfigured: vi.fn(),
  resetMicrosoftClients: vi.fn(),
  __testing: vi.fn(),
}));

vi.mock('../../src/services/invoice-filer', () => ({
  PT_MONTHS: vi.fn(),
  isInvoiceFilingConfigured: vi.fn(),
  analyzeInvoiceImage: vi.fn(),
  getPortugueseMonthFolder: vi.fn(),
  resolveTargetDirectory: vi.fn(),
  buildFilename: vi.fn(),
  fileInvoice: vi.fn(),
  buildPdfFilename: vi.fn(),
  filePdf: vi.fn(),
}));

vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>(
    '../../src/services/user-service'
  )),
  ClosedBetaInviteRequiredError: vi.fn(),
  getClosedBetaInviteStatus: vi.fn(),
  assertClosedBetaInviteForNewUser: vi.fn(),
  assertOptionalInviteForNewUser: vi.fn(),
  resolveCurrentTenantIdForUser: vi.fn(),
  getUserByTelegramId: vi.fn(),
  getOwnerBootstrapTelegramId: vi.fn(),
  assertOwnerBootstrapReadyForRuntime: vi.fn(),
  isOwnerBootstrapTelegramId: vi.fn(),
  getOrCreateUser: vi.fn(),
  getUserById: vi.fn(),
  resolveCanonicalUserId: vi.fn(),
  getOwnerBootstrapUser: vi.fn(),
  getOwnerBootstrapTarget: vi.fn(),
  getActiveUserTargets: vi.fn(),
  getOwnerBootstrapUserRefs: vi.fn(),
  getOrCreateInviteSandboxUser: vi.fn(),
  resolveIosInviteRegistrationTarget: vi.fn(),
  isOwnerUserRef: vi.fn(),
  sanitizeDisplayName: vi.fn(),
  getPreferredDisplayName: vi.fn(),
  getPreferredDisplayNameById: vi.fn(),
  getUserByAppleId: vi.fn(),
  getUserByGoogleId: vi.fn(),
  getUserByEmail: vi.fn(),
  createAppleUser: vi.fn(),
  createGoogleUser: vi.fn(),
  createEmailUser: vi.fn(),
  emitProviderLinkedAudit: vi.fn(),
  isUserAuthorized: vi.fn(),
  isOwner: vi.fn(),
  touchUser: vi.fn(),
  getUserLanguage: vi.fn(),
  getUserLanguageById: vi.fn(),
  getUserTimezone: vi.fn(),
  getUserTimezoneById: vi.fn(),
  setUserLanguage: vi.fn(),
  listUsers: vi.fn(),
  listUsersInternal: vi.fn(),
  setUserStatus: vi.fn(),
  setUserStatusById: vi.fn(),
  setUserTier: vi.fn(),
  setUserLimits: vi.fn(),
  createInviteCode: vi.fn(),
  peekInviteCode: vi.fn(),
  validateAndConsumeInviteCode: vi.fn(),
  consumeDatabaseInviteForUser: vi.fn(),
  listInviteCodes: vi.fn(),
  deleteInviteCode: vi.fn(),
  seedOwnerUser: vi.fn(),
  backfillTelegramIdentityArchive: vi.fn(),
}));

vi.mock('../../src/state/conversation', () => ({
  getConversationHistory: vi.fn(),
  addToConversation: vi.fn(),
  syncLastAssistantConversationMessage: vi.fn(),
  getLastAssistantMessage: vi.fn(),
  clearConversation: vi.fn(),
  clearAllConversations: vi.fn(),
  markConversationLifecycle: vi.fn(),
}));

vi.mock('../../src/services/channel-learner', () => ({
  computeChannelAnalysisFingerprint: vi.fn(),
  buildChannelLearnerExtractionPrompt: vi.fn(),
  buildChannelLearnerSynthesisPrompt: vi.fn(),
  analyzeChannel: vi.fn(),
  processAllChannels: vi.fn(),
  planChannelRelearnScopes: vi.fn(),
  processChannelRelearnScope: vi.fn(),
  processAllChannelScopes: vi.fn(),
  addAndAnalyzeChannel: vi.fn(),
  seedDefaultChannels: vi.fn(),
  synthesizeKnowledge: vi.fn(),
}));

vi.mock('../../src/portal/telemetry', async () => ({
  ...(await vi.importActual<typeof import('../../src/portal/telemetry')>(
    '../../src/portal/telemetry'
  )),
  pushEvent: (...args: unknown[]) => hoisted.pushEvent(...args),
  getRecentEvents: vi.fn(),
  registerJob: vi.fn(),
  setJobEnabledChecker: vi.fn(),
  isJobEnabled: vi.fn(),
  setJobFailureNotifier: vi.fn(),
  wrapJob: vi.fn(),
  getJobStatuses: vi.fn(),
  getJobMap: vi.fn(),
  isRestarting: vi.fn(),
  setIsRestarting: vi.fn(),
  setBotPollingActive: vi.fn(),
  isBotPollingActive: vi.fn(),
  recordMessageProcessed: vi.fn(),
  getLastMessageAt: vi.fn(),
  recordGarminRefresh: vi.fn(),
  getGarminRefreshStatus: vi.fn(),
  setDbProvider: vi.fn(),
  _resetTelemetryForTests: vi.fn(),
  seedJobLastRunFromHistory: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  LOGGER_REDACTION_PATHS: [],
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { handlePortalAction } from '../../src/portal/actions';

describe('portal action: refresh-garmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fans out to every connected user instead of relying on request context', async () => {
    hoisted.refreshConnectedGarminUsersWithLease.mockResolvedValue({
      status: 'completed',
      outcome: { total: 1, refreshed: 1, failed: [] },
    });

    await handlePortalAction('refresh-garmin');

    // The portal authenticates with PORTAL_TOKEN, not a user JWT, so there is
    // no ambient user. Passing the source explicitly is what keeps this from
    // silently becoming a no-op again.
    expect(hoisted.refreshConnectedGarminUsersWithLease).toHaveBeenCalledWith('manual');
    expect(hoisted.refreshConnectedGarminUsers).not.toHaveBeenCalled();
  });

  it('reports failure when no user has connected Garmin', async () => {
    hoisted.refreshConnectedGarminUsersWithLease.mockResolvedValue({
      status: 'completed',
      outcome: { total: 0, refreshed: 0, failed: [] },
    });

    const result = await handlePortalAction('refresh-garmin');

    expect(result).toEqual({ ok: false, message: 'No Garmin-connected users to refresh' });
  });

  it('reports success only when every connected user refreshed', async () => {
    hoisted.refreshConnectedGarminUsersWithLease.mockResolvedValue({
      status: 'completed',
      outcome: { total: 2, refreshed: 2, failed: [] },
    });

    const result = await handlePortalAction('refresh-garmin');

    expect(result).toEqual({ ok: true, message: 'Garmin sessions refreshed (2/2 refreshed)' });
  });

  it('reports incomplete rather than success when one user fails', async () => {
    hoisted.refreshConnectedGarminUsersWithLease.mockResolvedValue({
      status: 'completed',
      outcome: { total: 2, refreshed: 1, failed: [7] },
    });

    const result = await handlePortalAction('refresh-garmin');

    expect(result.ok).toBe(false);
    expect(result.message).toBe('Garmin refresh incomplete (1/2 refreshed)');
  });

  it('records a telemetry event describing the outcome', async () => {
    hoisted.refreshConnectedGarminUsersWithLease.mockResolvedValue({
      status: 'completed',
      outcome: { total: 3, refreshed: 2, failed: [9] },
    });

    await handlePortalAction('refresh-garmin');

    expect(hoisted.pushEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'auth', summary: 'Manual Garmin refresh: 2/3 refreshed' }),
    );
  });

  it('reports a durable overlap without starting an unfenced fallback refresh', async () => {
    hoisted.refreshConnectedGarminUsersWithLease.mockResolvedValue({
      status: 'not_executed',
      outcome: null,
    });

    const result = await handlePortalAction('refresh-garmin');

    expect(hoisted.refreshConnectedGarminUsersWithLease).toHaveBeenCalledWith('manual');
    expect(result).toEqual({
      ok: false,
      message: 'Garmin refresh already running or temporarily disabled',
    });
    expect(hoisted.refreshConnectedGarminUsers).not.toHaveBeenCalled();
  });
});
