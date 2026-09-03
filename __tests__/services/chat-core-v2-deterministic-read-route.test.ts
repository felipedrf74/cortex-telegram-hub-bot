import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedTask } from '../../src/services/task-store/types';
import type { NotificationCenterItem } from '../../src/services/notification-orchestrator';
import type { IntegrationSummary } from '../../src/services/integration-status';
import type { SecretaryAgendaItem } from '../../src/services/secretary-scheduling-arbitrator';
import type { MonthlyBudgetView, MonthlySummary } from '../../src/services/finance-tracker';
import type { ContentDeskItem, ContentSignalDigest } from '../../src/services/content-intelligence';
import type { ContentTopic } from '../../src/services/content-scheduler';
import type { ContentWorkspaceSummaryCounts } from '../../src/services/content-workspace-read-models';
import type { MealPlan, PantryItem, ShoppingList } from '../../src/services/cooking-chef';
import type {
  TrainingPlan,
  TrainingSession,
  TrainingWeek,
  WeeklyAdherenceStats,
} from '../../src/services/training-plans';

vi.mock('../../src/services/task-store/task-service', () => ({
  listTasks: vi.fn(),
  listTasksForUser: vi.fn(),
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  )),
  getDb: () => ({}),
}));

vi.mock('../../src/services/decision-center', () => ({
  getDecisionSummary: vi.fn(),
}));

vi.mock('../../src/services/notification-orchestrator', () => ({
  listNotificationCenterItems: vi.fn(),
}));

vi.mock('../../src/services/integration-status', () => ({
  getIntegrationSummary: vi.fn(),
}));

vi.mock('../../src/services/secretary-scheduling-arbitrator', () => ({
  listSecretaryAgendaItems: vi.fn(),
  previewSecretarySchedulingIntent: vi.fn(),
  submitSecretarySchedulingIntent: vi.fn(),
  getSecretaryAgendaItemById: vi.fn(),
  cancelSecretaryAgendaItem: vi.fn(),
}));

vi.mock('../../src/services/finance-tracker', () => ({
  getMonthlySummary: vi.fn(),
  getMonthlyBudgetView: vi.fn(),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlan: vi.fn(),
  getWeeksForPlan: vi.fn(),
  getSessionsForWeek: vi.fn(),
  getWeeklyAdherence: vi.fn(),
}));

vi.mock('../../src/services/content-scheduler', () => ({
  getTopics: vi.fn(),
}));

vi.mock('../../src/services/content-intelligence', () => ({
  getActiveContentPillars: vi.fn(),
  getContentDeskItems: vi.fn(),
  getRankedContentSignals: vi.fn(),
}));

vi.mock('../../src/services/content-learning-store', () => ({
  getLearnedPatterns: vi.fn(),
  getPerformanceSummary: vi.fn(),
}));

vi.mock('../../src/services/content-workspace-read-models', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/content-workspace-read-models')>(
    '../../src/services/content-workspace-read-models',
  )),
  getContentWorkspaceSummaryCounts: vi.fn(),
}));

vi.mock('../../src/services/stripe-service', () => ({
  getSubscriptionStatus: vi.fn(),
}));

vi.mock('../../src/services/cooking-chef', () => ({
  getMealPlan: vi.fn(),
  getShoppingList: vi.fn(),
  getPantryItems: vi.fn(),
}));

import { getActiveContentPillars, getContentDeskItems, getRankedContentSignals } from '../../src/services/content-intelligence';
import { getLearnedPatterns, getPerformanceSummary } from '../../src/services/content-learning-store';
import { getTopics } from '../../src/services/content-scheduler';
import { getContentWorkspaceSummaryCounts } from '../../src/services/content-workspace-read-models';
import { getMealPlan, getPantryItems, getShoppingList } from '../../src/services/cooking-chef';
import { getDecisionSummary } from '../../src/services/decision-center';
import { getMonthlyBudgetView, getMonthlySummary } from '../../src/services/finance-tracker';
import { getIntegrationSummary } from '../../src/services/integration-status';
import { listNotificationCenterItems } from '../../src/services/notification-orchestrator';
import { listSecretaryAgendaItems } from '../../src/services/secretary-scheduling-arbitrator';
import { getSubscriptionStatus } from '../../src/services/stripe-service';
import { listTasksForUser } from '../../src/services/task-store/task-service';
import {
  getActivePlan,
  getSessionsForWeek,
  getWeeklyAdherence,
  getWeeksForPlan,
} from '../../src/services/training-plans';
import { tryBuildChatCoreV2DeterministicReadRoute } from '../../src/services/chat-core-v2';

const FIXED_NOW = new Date('2026-05-24T10:00:00.000Z');
const ENABLED_ENV = {
  CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
  CHAT_CORE_V2_ENABLED: 'true',
  CHAT_CORE_V2_READS_ENABLED: 'true',
} as NodeJS.ProcessEnv;

function task(overrides: Partial<NormalizedTask>): NormalizedTask {
  return {
    id: 1,
    provider: 'nexus',
    externalId: `task-${overrides.id ?? 1}`,
    title: 'Task',
    status: 'pending',
    priority: 0,
    projectName: 'Inbox',
    ...overrides,
  };
}

function agendaItem(overrides: Partial<SecretaryAgendaItem>): SecretaryAgendaItem {
  return {
    agendaItemId: 'agenda_1',
    sourceIntentId: 'intent_1',
    sourceSkill: 'secretary',
    sourceAction: null,
    intentAction: 'schedule_this',
    sourceEntityId: null,
    sourceEntityType: null,
    ownerUserId: 42,
    tenantId: '84',
    lifecycleState: 'scheduled',
    providerSyncState: 'synced',
    providerEventId: null,
    providerSource: null,
    version: 1,
    title: 'Client review',
    startAt: '2026-05-24T14:00:00.000Z',
    endAt: '2026-05-24T14:30:00.000Z',
    durationMinutes: 30,
    decisionAction: 'scheduled',
    decisionReasonCodes: [],
    decisionExplanation: null,
    sourceShapeHash: 'shape_1',
    scheduledSegments: [],
    cancellationReason: null,
    supersededByAgendaItemId: null,
    createdAt: '2026-05-24T09:00:00.000Z',
    updatedAt: '2026-05-24T09:00:00.000Z',
    completedAt: null,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    reasoningTrail: [],
    ...overrides,
  };
}

function monthlySummary(overrides: Partial<MonthlySummary> = {}): MonthlySummary {
  return {
    month: '2026-05',
    totalIncome: 4200,
    totalExpenses: 2300,
    totalDeductions: 400,
    netIncome: 1900,
    transactionCount: 12,
    ...overrides,
  };
}

function monthlyBudgetView(overrides: Partial<MonthlyBudgetView> = {}): MonthlyBudgetView {
  return {
    month: '2026-05',
    basisCurrency: 'EUR',
    currencies: ['EUR'],
    integrity: 'reliable',
    affordability: 'controlled',
    incomeInBasisCurrency: 4200,
    expensesInBasisCurrency: 2300,
    currentRemainingInBasisCurrency: 1900,
    currentRemainingRatio: 0.45,
    projectedExpensesInBasisCurrency: 2800,
    projectedRemainingInBasisCurrency: 1400,
    projectedRemainingRatio: 0.33,
    recurringExpenseEstimate: 500,
    recurringExpenseCount: 2,
    recurringExpenses: [
      {
        fingerprint: 'private-vendor',
        label: 'Private vendor subscription',
        currency: 'EUR',
        monthlyEstimate: 500,
        monthCount: 3,
        lastSeenDate: '2026-04-20',
        alreadyLoggedThisMonth: false,
      },
    ],
    notes: ['Recurring expense pressure still likely this month: EUR 500.00 across 2 pending commitment(s).'],
    ...overrides,
  };
}

function trainingPlan(overrides: Partial<TrainingPlan> = {}): TrainingPlan {
  return {
    id: 101,
    user_id: 42,
    tenant_id: 84,
    name: 'Marathon Base',
    sport: 'running',
    goal: 'Finish strong',
    duration_weeks: 8,
    periodization: 'linear',
    status: 'active',
    start_date: '2026-05-18',
    end_date: '2026-07-12',
    preferences_json: null,
    plan_version: 2,
    created_at: '2026-05-18T00:00:00.000Z',
    updated_at: '2026-05-20T09:00:00.000Z',
    ...overrides,
  };
}

function trainingWeek(overrides: Partial<TrainingWeek> = {}): TrainingWeek {
  return {
    id: 201,
    plan_id: 101,
    week_number: 1,
    focus: 'Base endurance',
    intensity_pct: 85,
    volume_sessions: 3,
    notes: null,
    auto_adjusted: 0,
    adjustment_reason: null,
    created_at: '2026-05-18T00:00:00.000Z',
    ...overrides,
  };
}

function trainingSession(overrides: Partial<TrainingSession> = {}): TrainingSession {
  return {
    id: 301,
    week_id: 201,
    plan_id: 101,
    tenant_id: 84,
    day_of_week: 'Monday',
    session_type: 'running',
    title: 'Easy run',
    description: 'Private coaching detail that should not be surfaced in Chat Core v2 read summaries.',
    description_json: null,
    exercises_json: '[{"name":"Private drill"}]',
    duration_minutes: 45,
    intensity_text: 'easy',
    calendar_event_id: 'evt_private',
    calendar_source: 'google',
    session_identity_key: 'week1_run1',
    session_shape_hash: 'shape_1',
    preferred_time_unavailable: 0,
    status: 'scheduled',
    created_at: '2026-05-18T00:00:00.000Z',
    updated_at: '2026-05-20T09:00:00.000Z',
    ...overrides,
  };
}

function weeklyAdherence(overrides: Partial<WeeklyAdherenceStats> = {}): WeeklyAdherenceStats {
  return {
    planId: 101,
    weekNumber: 1,
    totalSessions: 3,
    completedSessions: 1,
    // F18: partial has its own 0.5-credit bucket; it is never completed.
    partialSessions: 0,
    skippedSessions: 0,
    pendingSessions: 2,
    adherenceRate: 33,
    avgRpe: 6,
    avgEnergy: 7,
    avgSoreness: 3,
    ...overrides,
  };
}

function contentTopic(overrides: Partial<ContentTopic> = {}): ContentTopic {
  return {
    id: 401,
    user_id: 42,
    title: 'Race-week fueling mistakes',
    notes: 'Private draft notes that should not be surfaced in Chat Core v2 read summaries.',
    scheduled_date: null,
    scheduled_at: null,
    status: 'planned',
    secretary_task_list_id: null,
    secretary_task_list_name: null,
    secretary_task_external_id: null,
    calendar_event_id: 'calendar_private',
    calendar_source: 'google',
    secretary_sync_status: null,
    secretary_sync_error: null,
    created_at: '2026-05-20T09:00:00.000Z',
    updated_at: '2026-05-21T09:00:00.000Z',
    ...overrides,
  };
}

function contentDeskItem(overrides: Partial<ContentDeskItem> = {}): ContentDeskItem {
  return {
    id: 501,
    type: 'script_ready',
    title: 'Recovery reel draft',
    body: 'Private script body that should stay out of Chat Core v2 metadata.',
    createdAt: '2026-05-22T09:00:00.000Z',
    ...overrides,
  };
}

function contentSignal(overrides: Partial<ContentSignalDigest> = {}): ContentSignalDigest {
  return {
    type: 'reaction_opportunity',
    title: 'Creators are debating carb myths again',
    summary: 'Private signal summary that should not be surfaced in Chat Core v2 metadata.',
    priority: 'urgent',
    relevanceScore: 0.93,
    confidence: 0.81,
    ...overrides,
  };
}

function contentWorkSchedule(
  overrides: Partial<ContentWorkspaceSummaryCounts> = {},
): ContentWorkspaceSummaryCounts {
  return {
    schemaVersion: 'content-workspace-operational-read-model-v2',
    availability: 'available',
    source: 'content_workspace',
    ideasNeedingReview: 0,
    scriptsInProgress: 0,
    scheduledThisWeek: 0,
    scheduleAttentionThisWeek: 0,
    scheduleAuthorityStatus: 'current',
    pendingCount: 0,
    scheduleSemantics: 'private_work_session',
    ...overrides,
  };
}

function mealPlan(overrides: Partial<MealPlan> = {}): MealPlan {
  return {
    id: 601,
    tenant_id: 84,
    user_id: 42,
    owner_user_id: 42,
    visibility_scope: 'user_private',
    lifecycle_state: 'available',
    scope_status: 'active',
    date: '2026-05-24',
    meal_type: 'dinner',
    recipe_id: 701,
    title: 'Salmon recovery bowl',
    notes: 'Private prep notes that should not appear in Chat Core v2 read summaries.',
    created_at: '2026-05-20T09:00:00.000Z',
    ...overrides,
  };
}

function shoppingList(overrides: Partial<ShoppingList> = {}): ShoppingList {
  return {
    id: 801,
    tenant_id: 84,
    user_id: 42,
    owner_user_id: 42,
    visibility_scope: 'user_private',
    lifecycle_state: 'active',
    scope_status: 'active',
    week_start: '2026-05-18',
    items: [
      {
        name: 'salmon',
        quantity: '2',
        unit: 'fillets',
        checked: false,
        aisle: 'protein',
        pantry_status: 'needed',
        pantry_item_id: 901,
        pantry_freshness_status: 'unknown',
        pantry_note: 'Private pantry note',
      },
      {
        name: 'rice',
        quantity: '500',
        unit: 'g',
        checked: true,
        aisle: 'pantry',
        pantry_status: 'pantry_available',
        pantry_item_id: 902,
        pantry_freshness_status: 'fresh',
      },
    ],
    status: 'active',
    created_at: '2026-05-20T09:00:00.000Z',
    updated_at: '2026-05-20T09:00:00.000Z',
    ...overrides,
  };
}

function pantryItem(overrides: Partial<PantryItem> = {}): PantryItem {
  return {
    id: 901,
    tenant_id: 84,
    user_id: 42,
    owner_user_id: 42,
    visibility_scope: 'user_private',
    lifecycle_state: 'available',
    scope_status: 'active',
    name: 'rice',
    normalized_name: 'rice',
    quantity: '500',
    unit: 'g',
    category: 'pantry',
    expires_at: null,
    freshness_status: 'fresh',
    availability_status: 'available',
    source: 'manual',
    confidence: 1,
    notes: 'Private pantry note',
    created_at: '2026-05-20T09:00:00.000Z',
    updated_at: '2026-05-20T09:00:00.000Z',
    ...overrides,
  };
}


function notification(overrides: Partial<NotificationCenterItem>): NotificationCenterItem {
  return {
    itemId: 'notif_1',
    intentId: 'intent_1',
    decisionLogId: null,
    userId: 42,
    tenantId: 84,
    title: 'Notification',
    body: 'Notification body',
    safeBody: 'Notification body',
    sensitiveBody: null,
    sourceSkill: 'system',
    type: 'reminder',
    priority: 'active',
    status: 'unread',
    deeplink: null,
    actions: [],
    dedupeKey: null,
    createdAt: '2026-05-24T09:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

function integrationSummary(overrides: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    providers: [
      {
        provider: 'google',
        state: 'connected',
        connectedAt: '2026-05-23T08:00:00.000Z',
        scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.readonly'],
        capabilities: ['calendar', 'gmail'],
        lastCheckedAt: '2026-05-24T09:30:00.000Z',
      },
      {
        provider: 'garmin',
        state: 'revoked',
        connectedAt: '2026-05-20T08:00:00.000Z',
        scopes: ['activities', 'sleep', 'readiness'],
        capabilities: ['training', 'sleep', 'readiness'],
        reasonCode: 'NEEDS_REAUTH',
      },
      {
        provider: 'outlook',
        state: 'disconnected',
        connectedAt: null,
        scopes: [],
        capabilities: ['calendar', 'email', 'tasks'],
      },
      {
        provider: 'whoop',
        state: 'coming_soon',
        connectedAt: null,
        scopes: [],
        capabilities: ['recovery', 'strain', 'sleep'],
        reasonCode: 'COMING_SOON',
        detail: 'WHOOP support is coming soon.',
      },
    ],
    counts: {
      connected: 1,
      degraded: 0,
      revoked: 1,
      pending: 0,
      disconnected: 1,
    },
    capabilities: {
      mail: true,
      calendar: true,
      externalTasks: false,
      health: false,
    },
    ...overrides,
  };
}

describe('Chat Core v2 deterministic read route', () => {
  beforeEach(() => {
    vi.mocked(listTasksForUser).mockReset();
    vi.mocked(getDecisionSummary).mockReset();
    vi.mocked(listNotificationCenterItems).mockReset();
    vi.mocked(getIntegrationSummary).mockReset();
    vi.mocked(listSecretaryAgendaItems).mockReset();
    vi.mocked(getMonthlySummary).mockReset();
    vi.mocked(getMonthlyBudgetView).mockReset();
    vi.mocked(getActivePlan).mockReset();
    vi.mocked(getWeeksForPlan).mockReset();
    vi.mocked(getSessionsForWeek).mockReset();
    vi.mocked(getWeeklyAdherence).mockReset();
    vi.mocked(getTopics).mockReset();
    vi.mocked(getActiveContentPillars).mockReset();
    vi.mocked(getContentDeskItems).mockReset();
    vi.mocked(getRankedContentSignals).mockReset();
    vi.mocked(getLearnedPatterns).mockReset();
    vi.mocked(getPerformanceSummary).mockReset();
    vi.mocked(getContentWorkspaceSummaryCounts).mockReset();
    vi.mocked(getContentWorkspaceSummaryCounts).mockReturnValue(contentWorkSchedule());
    vi.mocked(getSubscriptionStatus).mockReset();
    vi.mocked(getMealPlan).mockReset();
    vi.mocked(getShoppingList).mockReset();
    vi.mocked(getPantryItems).mockReset();
  });

  it('stays disabled unless both global and read flags are explicitly enabled', () => {
    vi.mocked(listTasksForUser).mockReturnValue([]);

    const disabled = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: {},
    });
    expect(disabled).toBeNull();
    expect(listTasksForUser).not.toHaveBeenCalled();

    const globalOnly = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: { CHAT_CORE_V2_ENABLED: 'true' } as NodeJS.ProcessEnv,
    });
    expect(globalOnly).toBeNull();
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
  });

  it('honors the Phase 4 activation gate when the orchestrator mode is explicit', () => {
    vi.mocked(listTasksForUser).mockReturnValue([]);

    const base = {
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
    };

    expect(tryBuildChatCoreV2DeterministicReadRoute({
      ...base,
      env: {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off',
        CHAT_CORE_V2_ENABLED: 'true',
        CHAT_CORE_V2_READS_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
    })).toBeNull();
    expect(tryBuildChatCoreV2DeterministicReadRoute({
      ...base,
      env: {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow',
        CHAT_CORE_V2_ENABLED: 'true',
        CHAT_CORE_V2_READS_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
    })).toBeNull();
    expect(tryBuildChatCoreV2DeterministicReadRoute({
      ...base,
      env: {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
        CHAT_CORE_V2_ALLOW_DETERMINISTIC_READS: 'false',
        CHAT_CORE_V2_ENABLED: 'true',
        CHAT_CORE_V2_READS_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
    })).toBeNull();
    expect(tryBuildChatCoreV2DeterministicReadRoute({
      ...base,
      env: {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
        CHAT_CORE_V2_ALLOWED_DOMAINS: 'finance',
      } as NodeJS.ProcessEnv,
    })).toBeNull();
    expect(tryBuildChatCoreV2DeterministicReadRoute({
      ...base,
      surface: 'ios',
      env: {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
        CHAT_CORE_V2_ALLOWED_SURFACES: 'web',
      } as NodeJS.ProcessEnv,
    })).toBeNull();

    const canary = tryBuildChatCoreV2DeterministicReadRoute({
      ...base,
      env: {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
        CHAT_CORE_V2_ALLOWED_DOMAINS: 'tasks',
      } as NodeJS.ProcessEnv,
    });
    expect(canary?.capabilityId).toBe('tasks.today_summary');
    expect(canary?.response.reasonCodes).toEqual(['deterministic_read', 'tasks.today_summary']);
  });

  it('answers connection status questions through the canonical integration summary', () => {
    vi.mocked(getIntegrationSummary).mockReturnValue(integrationSummary());

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What connections are connected?',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(getIntegrationSummary).toHaveBeenCalledWith(42);
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(listNotificationCenterItems).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('connections.status');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'connections.status'],
    });
    expect(result?.response.text).toContain('Your connections have 1 active integration.');
    expect(result?.response.text).toContain('1 needing attention');
    expect(result?.response.text).toContain('- Garmin: needs reconnect');
    expect(result?.response.text).toContain('- Google: connected');
    expect(result?.response.text).not.toContain('https://www.googleapis.com');
    expect(result?.response.text).not.toContain('WHOOP support is coming soon');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'connections.status',
      domain: 'connections',
      sensitivity: 'credential_adjacent',
      freshness: { status: 'live' },
      data: {
        connectedCount: 1,
        revokedCount: 1,
        attentionCount: 1,
        capabilities: {
          mail: true,
          calendar: true,
        },
      },
    });
    expect(result?.contextPack.sourceEntityIds).toEqual([
      'connection:garmin',
      'connection:google',
      'connection:outlook',
      'connection:whoop',
    ]);
    const connectionVersions = Object.values(result?.contextPack.sourceVersions ?? {});
    expect(connectionVersions).toHaveLength(4);
    expect(connectionVersions.every((version) => /^[0-9a-f]{16}$/.test(version))).toBe(true);
    expect(JSON.stringify(result?.contextPack.sourceVersions)).not.toContain('googleapis.com');
  });

  it('answers finance summary questions through aggregate-only finance reads', () => {
    vi.mocked(getMonthlySummary).mockReturnValue(monthlySummary());
    vi.mocked(getMonthlyBudgetView).mockReturnValue(monthlyBudgetView());

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Show my finance budget summary',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(getMonthlySummary).toHaveBeenCalledWith(42, '2026-05', { tenantId: 84 });
    expect(getMonthlyBudgetView).toHaveBeenCalledWith(42, '2026-05', { tenantId: 84 });
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(listNotificationCenterItems).not.toHaveBeenCalled();
    expect(getIntegrationSummary).not.toHaveBeenCalled();
    expect(listSecretaryAgendaItems).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('finance.summary');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'finance.summary', 'aggregate_read_allowed'],
    });
    expect(result?.response.text).toContain('Finance summary for 2026-05');
    expect(result?.response.text).toContain('EUR 4200.00 income');
    expect(result?.response.text).toContain('EUR 2300.00 expenses');
    expect(result?.response.text).toContain('EUR 1900.00 net');
    expect(result?.response.text).toContain('Current headroom: EUR 1900.00');
    expect(result?.response.text).toContain('Projected headroom: EUR 1400.00');
    expect(result?.response.text).not.toContain('Private vendor');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('Private vendor');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'finance.summary',
      domain: 'finance',
      sensitivity: 'financial',
      freshness: { status: 'live' },
      data: {
        month: '2026-05',
        basisCurrency: 'EUR',
        totalIncome: 4200,
        totalExpenses: 2300,
        netIncome: 1900,
        transactionCount: 12,
        affordability: 'controlled',
        recurringExpenseCount: 2,
      },
    });
    expect(result?.contextPack.sourceEntityIds).toEqual(['finance:summary:2026-05']);
  });

  it('answers localized finance summary questions through aggregate-only finance reads', () => {
    vi.mocked(getMonthlySummary).mockReturnValue(monthlySummary());
    vi.mocked(getMonthlyBudgetView).mockReturnValue(monthlyBudgetView());

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'mostra o resumo financeiro do mês',
      userId: 42,
      tenantId: 84,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(result?.capabilityId).toBe('finance.summary');
    expect(result?.response.locale).toBe('pt-PT');
    expect(result?.response.text).toContain('Resumo financeiro de 2026-05');
    expect(result?.response.text).toContain('EUR 4200.00 de entradas');
    expect(result?.response.text).toContain('EUR 2300.00 de gastos');
    expect(result?.response.text).not.toContain('Private vendor');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('Private vendor');
    expect(getMonthlySummary).toHaveBeenCalledWith(42, '2026-05', { tenantId: 84 });
    expect(getMonthlyBudgetView).toHaveBeenCalledWith(42, '2026-05', { tenantId: 84 });
  });

  it('preserves the finance subscription renewal shortcut as a plain answer message', () => {
    vi.mocked(getMonthlySummary).mockReturnValue(monthlySummary({ transactionCount: 0, totalIncome: 0, totalExpenses: 0, netIncome: 0 }));
    vi.mocked(getMonthlyBudgetView).mockReturnValue(monthlyBudgetView({ incomeInBasisCurrency: 0, expensesInBasisCurrency: 0 }));
    vi.mocked(getSubscriptionStatus).mockReturnValue({
      plan: 'max',
      period: 'monthly',
      status: 'trialing',
      provider: 'beta',
      currentPeriodEnd: '2026-06-02T10:00:00.000Z',
      cancelAtPeriodEnd: false,
      isActive: true,
      isPro: true,
    });

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'which subscriptions renew soon',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(result?.capabilityId).toBe('finance.summary');
    expect(result?.response.kind).toBe('message');
    expect(result?.response.cards).toEqual([]);
    expect(result?.response.reasonCodes).toEqual([
      'deterministic_read',
      'finance.summary',
      'aggregate_read_allowed',
      'finance_shortcut:subscription_renewal',
    ]);
    expect(result?.response.text).toContain('Right now the durable renewal tracker only includes Nexus Hub.');
    expect(result?.contextPack.sourceEntityIds).toEqual([
      'finance:summary:2026-05',
      'finance_shortcut:subscription_renewal',
    ]);
  });

  it('answers training plan and session questions through health-adjacent read-only summaries', () => {
    vi.mocked(getActivePlan).mockReturnValue(trainingPlan());
    vi.mocked(getWeeksForPlan).mockReturnValue([trainingWeek()]);
    vi.mocked(getSessionsForWeek).mockReturnValue([
      trainingSession({ id: 301, title: 'Easy run', status: 'completed', day_of_week: 'Monday' }),
      trainingSession({ id: 302, title: 'Tempo intervals', status: 'scheduled', day_of_week: 'Wednesday', intensity_text: 'moderate' }),
      trainingSession({ id: 303, title: 'Long run', status: 'pending', day_of_week: 'Sunday', duration_minutes: 75 }),
    ]);
    vi.mocked(getWeeklyAdherence).mockReturnValue(weeklyAdherence());

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Show my training sessions',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(getActivePlan).toHaveBeenCalledWith(42, 84);
    expect(getWeeksForPlan).toHaveBeenCalledWith(101);
    expect(getSessionsForWeek).toHaveBeenCalledWith(201);
    expect(getWeeklyAdherence).toHaveBeenCalledWith(101, 201);
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(listNotificationCenterItems).not.toHaveBeenCalled();
    expect(getIntegrationSummary).not.toHaveBeenCalled();
    expect(listSecretaryAgendaItems).not.toHaveBeenCalled();
    expect(getMonthlySummary).not.toHaveBeenCalled();
    expect(getMonthlyBudgetView).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('training.session_explain');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'training.session_explain', 'read_only_allowed'],
    });
    expect(result?.response.text).toContain('Training plan: Marathon Base');
    expect(result?.response.text).toContain('week 1/8');
    expect(result?.response.text).toContain('33% adherence');
    expect(result?.response.text).toContain('Tempo intervals');
    expect(result?.response.text).not.toContain('session_id');
    expect(result?.response.text).not.toContain('evt_private');
    expect(result?.response.text).not.toContain('Private coaching detail');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('Private drill');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('evt_private');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'training.session_explain',
      domain: 'training',
      sensitivity: 'health_adjacent',
      freshness: { status: 'live' },
      data: {
        hasActivePlan: true,
        planName: 'Marathon Base',
        sport: 'running',
        currentWeekNumber: 1,
        currentWeekFocus: 'Base endurance',
        currentWeekIntensityPct: 85,
        adherenceRate: 33,
        completedSessions: 1,
        pendingSessions: 2,
        totalSessions: 3,
      },
    });
    expect(result?.contextPack.sourceEntityIds).toEqual([
      'training_plan:101',
      'training_session:301',
      'training_session:302',
      'training_session:303',
    ]);
  });

  it('keeps training read questions ahead of broad planning and modify-action classifiers', () => {
    vi.mocked(getActivePlan).mockReturnValue(trainingPlan());
    vi.mocked(getWeeksForPlan).mockReturnValue([trainingWeek()]);
    vi.mocked(getSessionsForWeek).mockReturnValue([
      trainingSession({ id: 301, title: 'Easy run', status: 'completed', day_of_week: 'Monday' }),
      trainingSession({ id: 302, title: 'Tempo intervals', status: 'scheduled', day_of_week: 'Wednesday', intensity_text: 'moderate' }),
      trainingSession({ id: 303, title: 'Recovery run', status: 'pending', day_of_week: 'Sunday', duration_minutes: 45, intensity_text: 'easy' }),
    ]);
    vi.mocked(getWeeklyAdherence).mockReturnValue(weeklyAdherence());

    const prompts = [
      ['How many training sessions are in my active plan this week?', 'en-US'],
      ['Do I have any scheduled workouts today?', 'en-US'],
      ['Which active plan session is marked easy after soreness?', 'en-US'],
      ['Does my current plan include any recovery session after a sore week?', 'en-US'],
      ['Alguma sessão do plano ativo está marcada como leve depois de dor muscular?', 'pt-BR'],
      ['Meu plano atual inclui sessão de recuperação depois de semana dolorida?', 'pt-BR'],
    ] as const;

    for (const [normalizedText, locale] of prompts) {
      const result = tryBuildChatCoreV2DeterministicReadRoute({
        normalizedText,
        userId: 42,
        tenantId: 84,
        locale,
        timezone: 'Europe/Lisbon',
        now: FIXED_NOW,
        env: ENABLED_ENV,
      });

      expect(result?.capabilityId, normalizedText).toBe('training.session_explain');
      expect(result?.routeGuess.intent, normalizedText).toBe('app_question');
      expect(result?.routeGuess.domains, normalizedText).toEqual(['training']);
      expect(result?.response.text, normalizedText).toContain(locale === 'pt-BR' ? 'Plano de treino' : 'Training plan');
    }
  });

  it('routes localized no-active-training-plan questions through deterministic training reads', () => {
    vi.mocked(getActivePlan).mockReturnValue(null);

    for (const [normalizedText, locale, expectedText] of [
      ['Qual é meu treino hoje?', 'pt-BR', 'Você ainda não tem um plano de treino ativo.'],
      ['Qual é o meu treino hoje?', 'pt-PT', 'Ainda não tens um plano de treino ativo.'],
      ['Tenho algum plano de treino ativo agora?', 'pt-BR', 'Você ainda não tem um plano de treino ativo.'],
      ['Tengo entrenamiento hoy?', 'es', 'You do not have an active training plan yet.'],
    ] as const) {
      const result = tryBuildChatCoreV2DeterministicReadRoute({
        normalizedText,
        userId: 42,
        tenantId: 84,
        locale,
        timezone: 'Europe/Lisbon',
        now: FIXED_NOW,
        env: ENABLED_ENV,
      });

      expect(result?.capabilityId, normalizedText).toBe('training.session_explain');
      expect(result?.routeGuess.domains, normalizedText).toEqual(['training']);
      expect(result?.response.text, normalizedText).toContain(expectedText);
      expect(result?.readModel.data, normalizedText).toMatchObject({
        hasActivePlan: false,
      });
    }
    expect(getActivePlan).toHaveBeenCalledTimes(4);
  });

  it('does not swallow health-adjacent training advice into deterministic no-active-plan reads', () => {
    vi.mocked(getActivePlan).mockReturnValue(null);

    for (const [normalizedText, locale] of [
      ['I have knee pain, should I train today?', 'en-US'],
      ['Tenho dor no joelho, devo treinar hoje?', 'pt-BR'],
      ['Tengo dolor de rodilla, puedo entrenar hoy?', 'es'],
      ['Tenho dor no joelho, should I train today?', 'pt-PT'],
    ] as const) {
      const result = tryBuildChatCoreV2DeterministicReadRoute({
        normalizedText,
        userId: 42,
        tenantId: 84,
        locale,
        timezone: 'Europe/Lisbon',
        now: FIXED_NOW,
        env: ENABLED_ENV,
      });

      expect(result, normalizedText).toBeNull();
    }
    expect(getActivePlan).not.toHaveBeenCalled();
  });

  it('does not swallow explicit external research prompts into deterministic domain reads', () => {
    for (const [normalizedText, locale] of [
      ['Pesquisa fontes médicas públicas sobre sinais de alerta para dor no joelho durante corrida.', 'pt-PT'],
      ['Pesquisa fontes científicas recentes sobre hidratação em treinos de calor.', 'pt-PT'],
      ['Search fontes científicas sobre zone 2 training benefits for endurance athletes.', 'mixed'],
      ['Pesquisa notícias recentes sobre tecnologia financeira em Angola esta semana.', 'pt-PT'],
      ['Find recent sources comparing iPhone 17 Pro and Pixel camera performance for low light video.', 'en-US'],
    ] as const) {
      const result = tryBuildChatCoreV2DeterministicReadRoute({
        normalizedText,
        userId: 42,
        tenantId: 84,
        locale,
        timezone: 'Europe/Lisbon',
        now: FIXED_NOW,
        env: ENABLED_ENV,
      });

      expect(result, normalizedText).toBeNull();
    }
    expect(getActivePlan).not.toHaveBeenCalled();
    expect(getMonthlySummary).not.toHaveBeenCalled();
    expect(getMonthlyBudgetView).not.toHaveBeenCalled();
  });

  it('answers personal-tenant content pipeline questions without exposing raw draft bodies or provider IDs', () => {
    vi.mocked(getTopics).mockReturnValue([
      contentTopic({ id: 401, title: 'Race-week fueling mistakes', status: 'ready', scheduled_date: '2026-05-27' }),
      contentTopic({ id: 402, title: 'Recovery myth carousel', status: 'drafting', scheduled_date: null }),
      contentTopic({ id: 403, title: 'Published archive note', status: 'published', scheduled_date: '2026-05-20' }),
    ]);
    vi.mocked(getContentDeskItems).mockReturnValue([
      contentDeskItem({ id: 501, title: 'Recovery reel draft', body: 'Full private script body' }),
    ]);
    vi.mocked(getRankedContentSignals).mockReturnValue([
      contentSignal({ title: 'Creators are debating carb myths again', summary: 'Full private signal summary' }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Show my content pipeline',
      userId: 42,
      tenantId: 42,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(getTopics).toHaveBeenCalledWith(42, { includeTerminal: false, limit: 20, tenantId: 42 });
    expect(getContentDeskItems).toHaveBeenCalledWith(42, 5, 42);
    expect(getRankedContentSignals).toHaveBeenCalledWith(42, 5, 42);
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(listNotificationCenterItems).not.toHaveBeenCalled();
    expect(getIntegrationSummary).not.toHaveBeenCalled();
    expect(listSecretaryAgendaItems).not.toHaveBeenCalled();
    expect(getMonthlySummary).not.toHaveBeenCalled();
    expect(getMonthlyBudgetView).not.toHaveBeenCalled();
    expect(getActivePlan).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('content.pipeline_summary');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'content.pipeline_summary'],
    });
    expect(result?.response.text).toContain('Content pipeline: 2 tracked topics.');
    expect(result?.response.text).toContain('1 ready');
    expect(result?.response.text).toContain('1 drafting');
    expect(result?.response.text).toContain('1 desk-ready item');
    expect(result?.response.text).toContain('1 urgent signal');
    expect(result?.response.text).toContain('Race-week fueling mistakes');
    expect(result?.response.text).toContain('Recovery reel draft');
    expect(result?.response.text).not.toContain('Published archive note');
    expect(result?.response.text).not.toContain('Full private script body');
    expect(result?.response.text).not.toContain('Full private signal summary');
    expect(result?.response.text).not.toContain('calendar_private');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('Private draft notes');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('Full private script body');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('Full private signal summary');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('calendar_private');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'content.pipeline_summary',
      domain: 'content',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        topicCount: 2,
        readyCount: 1,
        draftingCount: 1,
        publishedCount: null,
        publicationTracking: {
          availability: 'unavailable',
          reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
          publicationExecution: 'not_supported',
        },
        scheduledCount: 1,
        deskReadyCount: 1,
        urgentSignalCount: 1,
      },
    });
    expect(result?.contextPack.sourceEntityIds).toEqual([
      'content_topic:401',
      'content_topic:402',
      'content_desk:501',
      expect.stringMatching(/^content_signal:[a-f0-9]{12}$/),
      'content_work_schedule',
    ]);
  });

  it.each([
    {
      label: 'confirmed',
      schedule: contentWorkSchedule({ scheduledThisWeek: 2, scheduleAttentionThisWeek: 1 }),
      expectedStatus: 'confirmed',
      expectedNext: 'They reserve work, not publication.',
    },
    {
      label: 'attention-only unplanned',
      schedule: contentWorkSchedule({ scheduleAttentionThisWeek: 1 }),
      expectedStatus: 'unplanned',
      expectedNext: 'Review 1 attention item(s); they are not proposals or reservations.',
    },
    {
      label: 'unplanned',
      schedule: contentWorkSchedule(),
      expectedStatus: 'unplanned',
      expectedNext: 'there is no confirmed private block',
    },
    {
      label: 'partial',
      schedule: contentWorkSchedule({
        scheduledThisWeek: 1,
        scheduleAttentionThisWeek: 1,
        scheduleAuthorityStatus: 'partially_unavailable',
      }),
      expectedStatus: 'partial',
      expectedNext: 'overall authority is partial',
    },
    {
      label: 'unavailable',
      schedule: contentWorkSchedule({ scheduleAuthorityStatus: 'unavailable' }),
      expectedStatus: 'unavailable',
      expectedNext: 'I cannot claim that any block is reserved',
    },
  ])('reports $label filming-plan authority without turning topic deadlines into reservations', ({
    schedule,
    expectedStatus,
    expectedNext,
  }) => {
    vi.mocked(getTopics).mockReturnValue([
      contentTopic({ status: 'ready', scheduled_date: '2026-05-27' }),
    ]);
    vi.mocked(getContentDeskItems).mockReturnValue([]);
    vi.mocked(getRankedContentSignals).mockReturnValue([]);
    vi.mocked(getContentWorkspaceSummaryCounts).mockReturnValue(schedule);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'How should I schedule filming around my week?',
      userId: 42,
      tenantId: 42,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result?.response.reasonCodes).toContain('content_shortcut:filming');
    expect(result?.response.text).toContain(`Plan status: ${expectedStatus}`);
    expect(result?.response.text).toContain('Counts include every work kind, not filming alone');
    expect(result?.response.text).toContain('Schedule authority: Secretary');
    expect(result?.response.text).toContain('Active topic deadlines: 1 (targets, not reservations or publication)');
    expect(result?.response.text).toContain(expectedNext);
  });

  it('reports filming-plan authority unavailable when the canonical schedule read fails', () => {
    vi.mocked(getTopics).mockReturnValue([]);
    vi.mocked(getContentDeskItems).mockReturnValue([]);
    vi.mocked(getRankedContentSignals).mockReturnValue([]);
    vi.mocked(getContentWorkspaceSummaryCounts).mockImplementation(() => {
      throw new Error('schedule projection unavailable');
    });

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'How should I schedule filming around my week?',
      userId: 42,
      tenantId: 42,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result?.response.text).toContain('Schedule authority: Secretary (unavailable)');
    expect(result?.response.text).toContain('Plan status: unavailable');
    expect(result?.response.text).toContain('I cannot claim that any block is reserved');
  });

  it('preserves current Secretary schedule authority in the empty next-publish fallback', () => {
    vi.mocked(getTopics).mockReturnValue([]);
    vi.mocked(getContentDeskItems).mockReturnValue([]);
    vi.mocked(getRankedContentSignals).mockReturnValue([]);
    vi.mocked(getContentWorkspaceSummaryCounts).mockReturnValue(contentWorkSchedule({ scheduledThisWeek: 1 }));

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'what should i publish next',
      userId: 42,
      tenantId: 42,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result?.response.reasonCodes).toContain('content_shortcut:next_publish');
    expect(result?.response.text).toContain('Plan status: confirmed');
    expect(result?.response.text).not.toContain('Schedule authority: Secretary (unavailable)');
    expect(result?.contextPack.sourceEntityIds).toContain('content_work_schedule');
  });

  it('fails closed before every Content producer for a same-user distinct-tenant read', () => {
    vi.mocked(getTopics).mockReturnValue([
      contentTopic({ id: 404, title: 'Personal tenant title', status: 'ready' }),
    ]);
    vi.mocked(getContentDeskItems).mockReturnValue([
      contentDeskItem({ id: 504, title: 'Personal desk title' }),
    ]);
    vi.mocked(getRankedContentSignals).mockReturnValue([
      contentSignal({ title: 'Foreign signal title' }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Show my content pipeline',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).toBeNull();
    expect(getTopics).not.toHaveBeenCalled();
    expect(getContentDeskItems).not.toHaveBeenCalled();
    expect(getRankedContentSignals).not.toHaveBeenCalled();
    expect(getActiveContentPillars).not.toHaveBeenCalled();
    expect(getLearnedPatterns).not.toHaveBeenCalled();
    expect(getPerformanceSummary).not.toHaveBeenCalled();
  });

  it('preserves content state shortcut empty states as plain answer messages', () => {
    vi.mocked(getTopics).mockReturnValue([]);
    vi.mocked(getContentDeskItems).mockReturnValue([]);
    vi.mocked(getRankedContentSignals).mockReturnValue([]);
    vi.mocked(getActiveContentPillars).mockReturnValue([]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'which pillars am i tracking',
      userId: 42,
      tenantId: 42,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(result?.capabilityId).toBe('content.pipeline_summary');
    expect(result?.response.kind).toBe('message');
    expect(result?.response.cards).toEqual([]);
    expect(result?.response.reasonCodes).toEqual([
      'deterministic_read',
      'content.pipeline_summary',
      'content_shortcut:pillars',
    ]);
    expect(result?.response.text).toContain('I do not see any active content pillars yet.');
    expect(result?.contextPack.sourceEntityIds).toEqual([
      'content_shortcut:pillars',
      'content_work_schedule',
    ]);
  });

  it('does not route content write-like requests through deterministic reads', () => {
    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Draft a content brief for my next video',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).toBeNull();
    expect(getTopics).not.toHaveBeenCalled();
    expect(getContentDeskItems).not.toHaveBeenCalled();
    expect(getRankedContentSignals).not.toHaveBeenCalled();
  });

  it('answers cooking meal-plan questions without exposing notes, recipe IDs, or pantry IDs', () => {
    vi.mocked(getMealPlan).mockReturnValue([
      mealPlan({ id: 601, title: 'Salmon recovery bowl', meal_type: 'dinner', date: '2026-05-24' }),
      mealPlan({ id: 602, title: 'Greek yogurt breakfast', meal_type: 'breakfast', date: '2026-05-23', recipe_id: null }),
    ]);
    vi.mocked(getShoppingList).mockReturnValue(shoppingList());
    vi.mocked(getPantryItems).mockReturnValue([
      pantryItem({ id: 901, name: 'rice', freshness_status: 'fresh', availability_status: 'available' }),
      pantryItem({ id: 902, name: 'spinach', freshness_status: 'use_soon', availability_status: 'available' }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What meals do I have this week?',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(getMealPlan).toHaveBeenCalledWith(42, '2026-05-18', '2026-05-24', 84);
    expect(getShoppingList).toHaveBeenCalledWith(42, '2026-05-18', 84);
    expect(getPantryItems).toHaveBeenCalledWith(42, {
      tenantId: 84,
      includeExpired: true,
      limit: 100,
    });
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(listNotificationCenterItems).not.toHaveBeenCalled();
    expect(getIntegrationSummary).not.toHaveBeenCalled();
    expect(listSecretaryAgendaItems).not.toHaveBeenCalled();
    expect(getMonthlySummary).not.toHaveBeenCalled();
    expect(getMonthlyBudgetView).not.toHaveBeenCalled();
    expect(getActivePlan).not.toHaveBeenCalled();
    expect(getTopics).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('cooking.meal_plan_summary');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'cooking.meal_plan_summary'],
    });
    expect(result?.response.text).toContain("This week's meal plan (2026-05-18 to 2026-05-24).");
    expect(result?.response.text).toContain('2 planned meals');
    expect(result?.response.text).toContain('2 shopping items');
    expect(result?.response.text).toContain('1 already in the pantry');
    expect(result?.response.text).toContain('Salmon recovery bowl');
    expect(result?.response.text).toContain('salmon');
    expect(result?.response.text).not.toContain('Private prep notes');
    expect(result?.response.text).not.toContain('Private pantry note');
    expect(result?.response.text).not.toContain('recipe_id');
    expect(result?.response.text).not.toContain('pantry_item_id');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('Private prep notes');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('Private pantry note');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('recipe_id');
    expect(JSON.stringify(result?.readModel.data)).not.toContain('pantry_item_id');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'cooking.meal_plan_summary',
      domain: 'cooking',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        rangeStart: '2026-05-18',
        rangeEnd: '2026-05-24',
        plannedMealCount: 2,
        plannedDateCount: 2,
        shoppingItemCount: 2,
        checkedShoppingItemCount: 1,
        pantryAvailableShoppingItemCount: 1,
        pantryAvailableCount: 2,
        pantryUseSoonCount: 1,
      },
    });
    expect(result?.contextPack.sourceEntityIds).toEqual([
      'cooking_meal:601',
      'cooking_meal:602',
      'cooking_shopping_list:2026-05-18',
      'cooking_pantry_summary',
    ]);
  });

  it('routes pt-PT meal-plan wording with "refeições planeadas" to the cooking read model', () => {
    vi.mocked(getMealPlan).mockReturnValue([
      mealPlan({ id: 603, title: 'Sopa de legumes', meal_type: 'dinner', date: '2026-05-24' }),
    ]);
    vi.mocked(getShoppingList).mockReturnValue(shoppingList({ items: [] }));
    vi.mocked(getPantryItems).mockReturnValue([]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'que refeições tenho planeadas esta semana',
      userId: 42,
      tenantId: 84,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(result?.capabilityId).toBe('cooking.meal_plan_summary');
    expect(result?.response.locale).toBe('pt-PT');
    expect(getMealPlan).toHaveBeenCalledWith(42, '2026-05-18', '2026-05-24', 84);
  });

  it('does not route cooking grocery write-like requests through deterministic reads', () => {
    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Add milk to my grocery list',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).toBeNull();
    expect(getMealPlan).not.toHaveBeenCalled();
    expect(getShoppingList).not.toHaveBeenCalled();
    expect(getPantryItems).not.toHaveBeenCalled();
  });

  it('answers task summary questions without model calls or provider reads', () => {
    vi.mocked(listTasksForUser).mockReturnValue([
      task({ id: 1, title: 'Review proposal', dueDate: '2026-05-24', priority: 3 }),
      task({ id: 2, title: 'Send invoice', dueDate: '2026-05-23', priority: 2 }),
      // M10 P-scale (NEX-17): only 'Send invoice' (P2) is in the high bucket.
      task({ id: 3, title: 'Buy groceries', dueDate: '2026-05-26', priority: 4 }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(listTasksForUser).toHaveBeenCalledWith(42, { status: 'pending' });
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'tasks.today_summary'],
    });
    expect(result?.response.text).toContain('You have 3 open tasks.');
    expect(result?.response.text).toContain('1 due today');
    expect(result?.response.text).toContain('1 overdue');
    expect(result?.response.text).toContain('- Send invoice (overdue)');
    expect(result?.response.text).toContain('- Review proposal (today)');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'tasks.today_summary',
      domain: 'tasks',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        pendingCount: 3,
        dueTodayCount: 1,
        overdueCount: 1,
        highPriorityCount: 1,
      },
    });
    expect(result?.contextPack.contextHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('renders a retired Spanish-authored task read in the resolved English locale', () => {
    vi.mocked(listTasksForUser).mockReturnValue([
      task({ id: 1, title: 'Review proposal', dueDate: '2026-05-24', priority: 3 }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Muestra mis tareas de hoy',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result?.response.locale).toBe('en');
    expect(result?.response.text).toContain('You have 1 open task.');
    expect(result?.response.text).not.toContain('Você tem');
    expect(result?.response.text).not.toContain('Tens');
  });

  it('answers Secretary agenda summary questions from the tenant-scoped agenda ledger', () => {
    vi.mocked(listSecretaryAgendaItems).mockReturnValue([
      agendaItem({
        agendaItemId: 'agenda_today',
        title: 'Client review',
        sourceSkill: 'content',
        startAt: '2026-05-24T14:00:00.000Z',
        endAt: '2026-05-24T14:30:00.000Z',
      }),
      agendaItem({
        agendaItemId: 'agenda_unscheduled',
        title: 'Finance follow-up',
        sourceSkill: 'finance',
        lifecycleState: 'proposed',
        providerSyncState: 'not_synced',
        startAt: null,
        endAt: null,
        durationMinutes: null,
      }),
      agendaItem({
        agendaItemId: 'agenda_failed',
        title: 'Training check-in',
        sourceSkill: 'training',
        providerSyncState: 'readback_failed',
        startAt: '2026-05-25T08:00:00.000Z',
        endAt: '2026-05-25T08:30:00.000Z',
      }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: "What's on my agenda today?",
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(listSecretaryAgendaItems).toHaveBeenCalledWith({
      ownerUserId: 42,
      tenantId: 84,
      includeInactive: false,
    });
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(listNotificationCenterItems).not.toHaveBeenCalled();
    expect(getIntegrationSummary).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('secretary.agenda_summary');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'secretary.agenda_summary'],
    });
    expect(result?.response.text).toContain('Secretary has 3 active agenda items.');
    expect(result?.response.text).toContain('1 for today');
    expect(result?.response.text).toContain('1 not timed yet');
    expect(result?.response.text).toContain('1 needing verification');
    expect(result?.response.text).toContain('- Client review (today)');
    expect(result?.response.text).toContain('- Training check-in (needs verification)');
    expect(result?.response.text).toContain('- Finance follow-up (not timed yet)');
    expect(result?.response.text).not.toContain('secretary_agenda_items');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'secretary.agenda_summary',
      domain: 'secretary',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        activeCount: 3,
        todayCount: 1,
        unscheduledCount: 1,
        providerAttentionCount: 1,
      },
    });
    expect(result?.contextPack.sourceEntityIds).toEqual([
      'secretary_agenda:agenda_today',
      'secretary_agenda:agenda_failed',
      'secretary_agenda:agenda_unscheduled',
    ]);
  });

  it('does not describe an empty local agenda ledger as a clear provider calendar', () => {
    vi.mocked(listSecretaryAgendaItems).mockReturnValue([]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: "What's on my agenda today?",
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result?.response.text).toContain('No local Secretary commitments are active.');
    expect(result?.response.text).toContain('did not verify the provider calendar');
    expect(result?.response.text).not.toContain('agenda is clear');
  });


  it('answers Decision Center summary questions through the filtered Decision Center facade', () => {
    vi.mocked(getDecisionSummary).mockReturnValue({
      openCount: 2,
      urgentCount: 1,
      todayCount: 1,
      handledTodayCount: 3,
      topDecisionTitle: 'Move client review to 15:30?',
      topDecisionSourceSkill: 'secretary',
      topDecisionUrgency: 'urgent',
      topDecisionWhy: 'The current time conflicts with another commitment.',
      topSuggestion: {
        decisionId: 'dec_1',
        title: 'Move client review to 15:30?',
        actionLabel: 'Move to 15:30',
        whyNow: 'This affects today.',
        expectedOutcome: 'Calendar stays conflict-free.',
        riskIfIgnored: 'The conflict may remain.',
        sourceSkill: 'secretary',
      },
      previewItems: [
        {
          decisionId: 'dec_1',
          itemId: 'item_1',
          id: 'item_1',
          intentId: 'intent_1',
          decisionLogId: null,
          userId: 42,
          tenantId: 84,
          sourceSkill: 'secretary',
          type: 'decision_required',
          status: 'unread',
          urgency: 'urgent',
          timingLabel: null,
          priorityScore: 90,
          title: 'Move client review to 15:30?',
          summary: 'Client review needs a better slot.',
          safePreviewTitle: 'Move client review to 15:30?',
          safePreviewBody: 'Client review needs a better slot.',
          recommendedActionLabel: 'Move to 15:30',
          recommendedAction: null,
          alternativeActions: [],
          whySummary: 'The current time conflicts with another commitment.',
          whyDetails: [],
          explanation: {
            headline: 'Move client review to 15:30?',
            whatHappened: 'The current time conflicts with another commitment.',
            whyItMatters: 'It keeps the afternoon plan realistic.',
            nexusAction: 'Nexus will move the item after confirmation.',
            userAction: 'Choose whether to move it.',
            result: 'The calendar item moves to 15:30.',
            verification: 'Nexus will check the calendar after the move.',
            nextStep: 'Confirm or choose another time.',
            steps: [],
            actionLabels: { primary: 'Move to 15:30', secondary: ['Choose another time'] },
          },
          problemStatement: 'The current time conflicts with another commitment.',
          recommendation: 'Move to 15:30',
          expectedEffect: 'Calendar stays conflict-free.',
          impactIfIgnored: 'The conflict may remain.',
          impactLevel: 'high',
          primaryActionLabel: 'Move to 15:30',
          secondaryActionLabels: ['Choose another time'],
          urgencyReason: 'Affects today.',
          why: { facts: [], rules: [], tradeoffs: [], confidence: 'high' },
          actionPreview: [],
          whatWillChange: [],
          alternatives: [],
          automationEligibility: { eligible: false, reason: 'needs_user', mode: 'manual' },
          autopilotPolicy: 'manual',
          readBackVerifier: null,
          handledByNexus: false,
          handledAt: null,
          outcomeSummary: null,
          failureReason: null,
          retryActions: [],
          notificationEligibility: 'visible',
          apnsInterruptionLevel: 'active',
          collapseKey: null,
          badgeContribution: true,
          quality: {
            status: 'safe',
            safeToShowUser: true,
            safeForFrontendAction: true,
            missingFields: [],
            warnings: [],
          },
          relatedEntities: [],
          relatedEntitiesSafe: [],
          sourceTraceSummary: null,
          sourceTrace: null,
          dependencyGraphSummary: null,
          actionTruthTableEntry: null,
          askNexusContext: null,
          deadlineAt: null,
          expiresAt: null,
          confidence: 0.9,
          analysis: {
            confidence: 0.9,
            confidenceLabel: 'high',
            sourceFreshness: 'live',
            freshnessLabel: 'Live',
            whyNow: 'This affects today.',
            expectedOutcome: 'Calendar stays conflict-free.',
            costOfDelay: 'The conflict may remain.',
            tradeoffs: [],
            uncertainty: [],
            rollbackConfidence: 'high',
          },
          riskLevel: 'medium',
          groupKey: 'secretary',
          sectionKey: 'urgent',
          displayMode: 'decision_required',
          frontendActionState: 'enabled',
          privacyClassification: 'standard',
          visibilityScope: 'user_private',
          createdAt: '2026-05-24T09:00:00.000Z',
          updatedAt: '2026-05-24T09:05:00.000Z',
          snoozedUntil: null,
          actions: [],
          dependsOnDecisionIds: [],
          blockedByDecisionIds: [],
          rollbackAvailable: false,
          rollbackActionId: null,
        },
      ],
      badgeCount: 1,
      ctaLabel: 'Urgent decision',
      gamification: null,
    });

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What is in Decision Center?',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(getDecisionSummary).toHaveBeenCalledWith(42, 84, 3);
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('decision_center.summary');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'decision_center.summary'],
    });
    expect(result?.response.text).toContain('Decision Center has 2 open decisions.');
    expect(result?.response.text).toContain('1 urgent');
    expect(result?.response.text).toContain('3 handled today');
    expect(result?.response.text).toContain('- Move client review to 15:30? (urgent) - needs: Move to 15:30');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'decision_center.summary',
      domain: 'decision_center',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        openCount: 2,
        urgentCount: 1,
        todayCount: 1,
        handledTodayCount: 3,
        badgeCount: 1,
      },
    });
    expect(result?.contextPack.sourceEntityIds).toEqual(['decision:dec_1']);
  });

  it('localizes clear Decision Center summaries for Portuguese users', () => {
    vi.mocked(getDecisionSummary).mockReturnValue({
      openCount: 0,
      urgentCount: 0,
      todayCount: 0,
      handledTodayCount: 0,
      topDecisionTitle: null,
      topDecisionSourceSkill: null,
      topDecisionUrgency: null,
      topDecisionWhy: null,
      topSuggestion: null,
      previewItems: [],
      badgeCount: 0,
      ctaLabel: 'Tudo certo',
      gamification: null,
    });

    const pt = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'O que está no Decision Center?',
      userId: 42,
      tenantId: 84,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(pt?.response.locale).toBe('pt-PT');
    expect(pt?.response.text).toBe('O Decision Center não tem pendências neste momento.');
  });

  it('localizes deterministic task summaries for Portuguese users', () => {
    vi.mocked(listTasksForUser).mockReturnValue([
      task({ id: 1, title: 'Enviar proposta', dueDate: '2026-05-24', priority: 1 }),
    ]);

    const pt = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Que tarefas tenho hoje?',
      userId: 42,
      tenantId: 84,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(pt?.response.locale).toBe('pt-PT');
    expect(pt?.response.text).toContain('Tens 1 tarefa aberta.');
    expect(pt?.response.text).toContain('1 para hoje');
    expect(pt?.response.text).toContain('- Enviar proposta (hoje)');

    const br = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Que tarefas tenho hoje?',
      userId: 42,
      tenantId: 84,
      locale: 'pt-BR',
      timezone: 'America/Sao_Paulo',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    expect(br?.response.locale).toBe('pt-BR');
    expect(br?.response.text).toContain('Você tem 1 tarefa aberta.');
  });

  it('answers notification summary questions through the tenant-scoped notification center', () => {
    vi.mocked(listNotificationCenterItems).mockReturnValue([
      notification({
        itemId: 'notif_1',
        title: 'Training reminder',
        sourceSkill: 'training',
        type: 'reminder',
        priority: 'time_sensitive',
        actions: [{ id: 'open', label: 'Open', style: 'primary' }],
        createdAt: '2026-05-24T09:30:00.000Z',
      }),
      notification({
        itemId: 'notif_2',
        title: 'Content idea ready',
        sourceSkill: 'content',
        type: 'insight',
        priority: 'active',
        actions: [],
        createdAt: '2026-05-24T09:00:00.000Z',
      }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What notifications do I have?',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(listNotificationCenterItems).toHaveBeenCalledWith(42, 84, {
      status: 'unread',
      limit: 200,
    });
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('notifications.summary');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'notifications.summary'],
    });
    expect(result?.response.text).toContain('You have 2 unread notifications.');
    expect(result?.response.text).toContain('1 urgent');
    expect(result?.response.text).toContain('1 needing action');
    expect(result?.response.text).toContain('- Training reminder (urgent) - action: Open');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'notifications.summary',
      domain: 'notifications',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        unreadCount: 2,
        urgentCount: 1,
        actionRequiredCount: 1,
        remindersCount: 1,
        sourceSkills: ['content', 'training'],
      },
    });
  });

  it('answers multi-domain app questions without falling through to legacy routing', () => {
    vi.mocked(listTasksForUser).mockReturnValue([]);
    vi.mocked(getActivePlan).mockReturnValue(trainingPlan());
    vi.mocked(getWeeksForPlan).mockReturnValue([trainingWeek()]);
    vi.mocked(getSessionsForWeek).mockReturnValue([
      trainingSession({ id: 301, title: 'Easy run', status: 'scheduled', day_of_week: 'Monday' }),
    ]);
    vi.mocked(getWeeklyAdherence).mockReturnValue(weeklyAdherence());

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Show my tasks and training today',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(result?.capabilityId).toBe('tasks.today_summary');
    expect(result?.capabilityIds).toEqual(['tasks.today_summary', 'training.session_explain']);
    expect(result?.readModels?.map((readModel) => readModel.domain)).toEqual(['tasks', 'training']);
    expect(result?.contextPack.domains).toEqual(['tasks', 'training']);
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: [
        'deterministic_read',
        'multi_domain_read',
        'tasks.today_summary',
        'training.session_explain',
      ],
    });
    expect(result?.response.text).toContain('Tasks\nYou have no open tasks right now.');
    expect(result?.response.text).toContain('Training\nTraining plan: Marathon Base.');
  });

  it('does not intercept write-like requests', () => {
    vi.mocked(listTasksForUser).mockReturnValue([]);

    const write = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Create a task to call Joao tomorrow',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const portugueseWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Cria uma tarefa para ligar ao Joao amanha',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const decisionWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Dismiss this decision',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const notificationWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Snooze this notification until tomorrow',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const connectionWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Reconnect Garmin now',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const secretaryWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Schedule a meeting with Ana tomorrow',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const financeWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Pay the invoice from my account',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const localizedFinanceWrites = [
      'Paga essa fatura automaticamente agora',
      'pagar a fatura agora',
      'Diz exatamente o imposto que devo pagar sem verificar dados',
    ].map((normalizedText) => tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText,
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    }));
    const trainingWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: "Move tomorrow's workout and make it lighter",
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const broadMultiDomainWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Cancel my training plan and clear the calendar',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(write).toBeNull();
    expect(portugueseWrite).toBeNull();
    expect(decisionWrite).toBeNull();
    expect(notificationWrite).toBeNull();
    expect(connectionWrite).toBeNull();
    expect(secretaryWrite).toBeNull();
    expect(financeWrite).toBeNull();
    expect(localizedFinanceWrites).toEqual([null, null, null]);
    expect(trainingWrite).toBeNull();
    expect(broadMultiDomainWrite).toBeNull();
    expect(listTasksForUser).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(listNotificationCenterItems).not.toHaveBeenCalled();
    expect(getIntegrationSummary).not.toHaveBeenCalled();
    expect(listSecretaryAgendaItems).not.toHaveBeenCalled();
    expect(getMonthlySummary).not.toHaveBeenCalled();
    expect(getMonthlyBudgetView).not.toHaveBeenCalled();
    expect(getActivePlan).not.toHaveBeenCalled();
    expect(getWeeksForPlan).not.toHaveBeenCalled();
    expect(getSessionsForWeek).not.toHaveBeenCalled();
    expect(getWeeklyAdherence).not.toHaveBeenCalled();
  });
});
