import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { Router } from 'express';

const mockDbAll = vi.fn();
const mockDbGet = vi.fn();
const mockDbRun = vi.fn();
const mockGetCached = vi.fn();
const mockSetCache = vi.fn();
const mockComposeDailyBrief = vi.fn();
const mockGetMealPlan = vi.fn();
const mockGetActivePlans = vi.fn();
const mockGetCurrentWeek = vi.fn();
const mockGetWeeksForPlan = vi.fn();
const mockGetSessionsForWeek = vi.fn();
const mockReadTrainingContextAll = vi.fn();
const mockGetWearableReadiness = vi.fn();
const mockGetMonthlySummary = vi.fn();
const mockGetMonthlyBudgetView = vi.fn();
const mockGetPreferredCurrencyForUser = vi.fn();
const mockCalculateMonthlyTax = vi.fn();
const mockBuildTrainingHomeViewState = vi.fn();
const mockBuildActiveSignalsResponse = vi.fn();
const mockGetRuntimeStatus = vi.fn();
const mockGetUserConnections = vi.fn();
const mockGetFocusBlockRecommendation = vi.fn();
const mockGetInvoiceVendorsMerged = vi.fn();
const mockGetInvoiceVendorsDb = vi.fn();
const mockGetUserLanguage = vi.fn(() => 'pt-BR');
const mockGetUserById = vi.fn((userId: number) => ({ id: userId, first_name: 'Jaqueline', tier: 'pro' }));
const mockSetUserLanguage = vi.fn();
const mockGetNotifications = vi.fn();
const mockGetUnreadNotificationCount = vi.fn();
const mockMarkNotificationRead = vi.fn();
const mockMarkAllNotificationsRead = vi.fn();
const mockResolveNotification = vi.fn();
const mockGetRecentReports = vi.fn();
const mockGetUnreadReportCount = vi.fn();
const mockMarkReportRead = vi.fn();
const mockSetPushPreference = vi.fn();
const mockGetPushPreferences = vi.fn();
const mockCreateCalendarEvent = vi.fn();
const mockUpdateCalendarEvent = vi.fn();
const mockDeleteCalendarEvent = vi.fn();
const mockTaskProvider = {
  getLists: vi.fn(),
  findListByName: vi.fn(),
  getDefaultList: vi.fn(),
  createList: vi.fn(),
  getTasks: vi.fn(),
  getAllPendingTasks: vi.fn(),
  getTask: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  completeTask: vi.fn(),
  deleteTask: vi.fn(),
};
const mockCollectMonthlyInvoices = vi.fn();
const mockAddInvoiceVendor = vi.fn();
const mockRemoveInvoiceVendor = vi.fn();
const mockGetFiscalCollectionSummary = vi.fn();
const mockSendFiscalBundleNow = vi.fn();
const mockUpdateFiscalCollectionProfile = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (...args: unknown[]) => mockDbAll(sql, ...args),
      get: (...args: unknown[]) => mockDbGet(sql, ...args),
      run: (...args: unknown[]) => mockDbRun(sql, ...args),
    }),
  }),
}));

vi.mock('../../src/services/cache-store', () => ({
  getCached: (...args: unknown[]) => mockGetCached(...args),
  setCache: (...args: unknown[]) => mockSetCache(...args),
  getCachedSWR: vi.fn(() => null),
  setCacheSWR: vi.fn(),
}));

vi.mock('../../src/services/daily-brief-orchestrator', () => ({
  composeDailyBrief: (...args: unknown[]) => mockComposeDailyBrief(...args),
}));

vi.mock('../../src/services/cooking-chef', () => ({
  getMealPlan: (...args: unknown[]) => mockGetMealPlan(...args),
  addRecipe: vi.fn(),
  getRecipes: vi.fn(),
  getRecipeById: vi.fn(),
  updateRecipe: vi.fn(),
  deleteRecipe: vi.fn(),
  setMealPlan: vi.fn(),
  deleteMealPlan: vi.fn(),
  generateShoppingList: vi.fn(),
  getShoppingList: vi.fn(),
  updateShoppingListItemChecked: vi.fn(),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  getCurrentWeek: (...args: unknown[]) => mockGetCurrentWeek(...args),
  getWeeksForPlan: (...args: unknown[]) => mockGetWeeksForPlan(...args),
  getSessionsForWeek: (...args: unknown[]) => mockGetSessionsForWeek(...args),
  getActivePlan: vi.fn(),
  getWeeklyAdherence: vi.fn(() => 0.75),
}));

vi.mock('../../src/services/training-signals', () => ({
  readTrainingContextAll: (...args: unknown[]) => mockReadTrainingContextAll(...args),
}));

vi.mock('../../src/services/wearable/wearable-service', () => ({
  getReadiness: (...args: unknown[]) => mockGetWearableReadiness(...args),
}));

vi.mock('../../src/services/finance-tracker', () => ({
  getMonthlySummary: (...args: unknown[]) => mockGetMonthlySummary(...args),
  getMonthlyBudgetView: (...args: unknown[]) => mockGetMonthlyBudgetView(...args),
  getPreferredCurrencyForUser: (...args: unknown[]) => mockGetPreferredCurrencyForUser(...args),
  calculateMonthlyTax: (...args: unknown[]) => mockCalculateMonthlyTax(...args),
  addTransaction: vi.fn(),
  getTransactions: vi.fn(),
  deleteTransaction: vi.fn(),
  getTaxEvents: vi.fn(),
  getAnnualTaxSummary: vi.fn(),
  calculateAndStoreTax: vi.fn(),
  markTaxPaid: vi.fn(),
}));

vi.mock('../../src/services/runtime-status', () => ({
  getRuntimeStatus: (...args: unknown[]) => mockGetRuntimeStatus(...args),
}));

vi.mock('../../src/services/oauth-store', () => ({
  getUserConnections: (...args: unknown[]) => mockGetUserConnections(...args),
  isConnected: vi.fn(() => true),
  getConnectedProviders: vi.fn(() => []),
}));

vi.mock('../../src/services/secretary-fastpath', () => ({
  normalizeLangHeader: (value: string) => value || 'pt-BR',
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguage: (...args: unknown[]) => mockGetUserLanguage(...args),
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
  getUserByTelegramId: (...args: unknown[]) => mockGetUserById(...args),
  setUserLanguage: (...args: unknown[]) => mockSetUserLanguage(...args),
}));

vi.mock('../../src/services/signals-observability', () => ({
  buildActiveSignalsResponse: (...args: unknown[]) => mockBuildActiveSignalsResponse(...args),
}));

vi.mock('../../src/services/training-home-view-state', () => ({
  buildTrainingHomeViewState: (...args: unknown[]) => mockBuildTrainingHomeViewState(...args),
}));

vi.mock('../../src/services/readiness-scorer', () => ({
  calculateReadiness: vi.fn(async () => ({
    score: 74,
    factors: {
      sleep: { score: 78 },
      hrv: { trend: 'stable' },
      bodyBattery: { current: 68 },
    },
    recommendation: 'Train as planned',
    reasonCode: null,
  })),
}));

vi.mock('../../src/services/content-notification-store', () => ({
  getNotifications: (...args: unknown[]) => mockGetNotifications(...args),
  getUnreadCount: (...args: unknown[]) => mockGetUnreadNotificationCount(...args),
  markRead: (...args: unknown[]) => mockMarkNotificationRead(...args),
  markAllRead: (...args: unknown[]) => mockMarkAllNotificationsRead(...args),
  resolveNotification: (...args: unknown[]) => mockResolveNotification(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getLatestByType: vi.fn(() => null),
  getRecentReports: (...args: unknown[]) => mockGetRecentReports(...args),
  getUnreadReportCount: (...args: unknown[]) => mockGetUnreadReportCount(...args),
  getReportById: vi.fn(() => null),
  markReportRead: (...args: unknown[]) => mockMarkReportRead(...args),
  getPushPreferences: (...args: unknown[]) => mockGetPushPreferences(...args),
  setPushPreference: (...args: unknown[]) => mockSetPushPreference(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: vi.fn(async () => []),
  createEvent: (...args: unknown[]) => mockCreateCalendarEvent(...args),
  updateEvent: (...args: unknown[]) => mockUpdateCalendarEvent(...args),
  deleteEvent: (...args: unknown[]) => mockDeleteCalendarEvent(...args),
  isAnyCalendarConfigured: vi.fn(() => false),
  hasConnectedCalendarForUser: vi.fn(() => true),
  hasWritableCalendarForUser: vi.fn(() => true),
}));

vi.mock('../../src/services/task-store/task-router', () => ({
  getTaskProviderForUser: vi.fn(() => mockTaskProvider),
  resolveTaskProvider: vi.fn(() => 'ms_todo'),
}));

vi.mock('../../src/services/task-cache-invalidator', () => ({
  invalidateTaskCaches: vi.fn(),
}));

vi.mock('../../src/services/focus-planner', () => ({
  getFocusBlockRecommendation: (...args: unknown[]) => mockGetFocusBlockRecommendation(...args),
}));

vi.mock('../../src/services/training-cache-invalidator', () => ({
  invalidateTrainingDerivedCaches: vi.fn(),
}));

vi.mock('../../src/services/calendar-cache-invalidator', () => ({
  invalidateCalendarCaches: vi.fn(),
}));

vi.mock('../../src/services/cooking-cache-invalidator', () => ({
  invalidateCookingDerivedCaches: vi.fn(),
}));

vi.mock('../../src/services/finance-cache-invalidator', () => ({
  invalidateFinanceDerivedCaches: vi.fn(),
}));

vi.mock('../../src/services/cross-agent-learning', () => ({
  readTrainingMeshContext: vi.fn(() => ({ summary: null })),
  readCookingMeshContext: vi.fn(() => ({ summary: null })),
  readFinanceMeshContext: vi.fn(() => ({ summary: null })),
  readContentMeshContext: vi.fn(() => ({ summary: null })),
  readSecretaryMeshContext: vi.fn(() => ({ summary: null })),
}));

vi.mock('../../src/services/shared-decision-context', () => ({
  buildSharedDecisionContext: vi.fn(async () => ({ decisions: [] })),
}));

vi.mock('../../src/services/training-plan-equipment-adaptation', () => ({
  adaptTrainingPlanToAvailableEquipment: vi.fn((plan) => plan),
  buildTrainingEquipmentAdaptation: vi.fn(() => null),
}));

vi.mock('../../src/services/training-plan-coordination', () => ({
  applyTrainingPlanCoordination: vi.fn((plan) => plan),
  buildTrainingPlanCoordination: vi.fn(() => null),
}));

vi.mock('../../src/services/cost-guardrail', () => ({
  acquireCostLock: vi.fn(async () => () => {}),
  buildQuotaExceededMessage: vi.fn((quota: { plan: string; resetAt: string }) => `Daily AI quota reached for the ${quota.plan} plan. Resets at ${quota.resetAt}.`),
  isUserOverDailyCap: vi.fn(() => ({
    over: false,
    spentUsd: 0,
    capUsd: 0.2,
    plan: 'pro',
    resetAt: '2026-04-15T00:00:00.000Z',
  })),
}));

vi.mock('../../src/services/invoice-collector', () => ({
  getAllVendors: (...args: unknown[]) => mockGetInvoiceVendorsMerged(...args),
  collectMonthlyInvoices: (...args: unknown[]) => mockCollectMonthlyInvoices(...args),
}));

vi.mock('../../src/state/invoice-vendors', () => ({
  addVendor: (...args: unknown[]) => mockAddInvoiceVendor(...args),
  removeVendor: (...args: unknown[]) => mockRemoveInvoiceVendor(...args),
  getAllVendors: (...args: unknown[]) => mockGetInvoiceVendorsDb(...args),
}));

vi.mock('../../src/services/fiscal-bundle', () => ({
  getFiscalCollectionSummary: (...args: unknown[]) => mockGetFiscalCollectionSummary(...args),
  sendFiscalBundleNow: (...args: unknown[]) => mockSendFiscalBundleNow(...args),
}));

vi.mock('../../src/state/fiscal-collection-profiles', () => ({
  updateFiscalCollectionProfile: (...args: unknown[]) => mockUpdateFiscalCollectionProfile(...args),
}));

vi.mock('../../src/services/garmin-coach', () => ({
  applyCoachRecommendations: vi.fn(),
  generateCoachBriefing: vi.fn(),
}));

vi.mock('../../src/services/onboarding', () => ({
  getMissingProfileFields: vi.fn(() => []),
  getQuestionnaire: vi.fn(() => null),
  getProfile: vi.fn(() => null),
}));

vi.mock('../../src/services/training-coach-kernel-plan-generator', () => ({
  buildCoachKernelTrainingPlan: vi.fn(),
}));

vi.mock('../../src/services/coach-plan-registry', () => ({
  getStoredPlanCoveringDate: vi.fn(() => null),
}));

vi.mock('../../src/services/coach-kernel/planner-engine', () => ({
  adjustForFatigue: vi.fn((athlete: unknown, plan: unknown) => plan),
}));

vi.mock('../../src/domains/domain-handler', () => ({
  setLastCoachState: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { planRoutes } from '../../src/api/routes/plan';
import { trainingRoutes } from '../../src/api/routes/training';
import { contentRoutes } from '../../src/api/routes/content';
import { cookingRoutes } from '../../src/api/routes/cooking';
import { financeRoutes } from '../../src/api/routes/finance';
import { connectionRoutes } from '../../src/api/routes/connections';
import { settingsRoutes } from '../../src/api/routes/settings';
import { calendarRoutes } from '../../src/api/routes/calendar';
import { invoicesRoutes } from '../../src/api/routes/invoices';
import { notificationRoutes } from '../../src/api/routes/notifications';
import { reportRoutes } from '../../src/api/routes/reports';
import { taskRoutes } from '../../src/api/routes/tasks';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function fetchJson(
  app: express.Express,
  method: HttpMethod,
  url: string,
  headers?: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to start test server'));
        return;
      }

      const req = http.request(
        {
          host: '127.0.0.1',
          port: address.port,
          path: url,
          method,
          headers: {
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(headers || {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode || 0,
              body: data ? JSON.parse(data) : null,
            });
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body !== undefined) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

function protectedApp(mountPath: string, router: Router): express.Express {
  const app = express();
  app.use(express.json());
  // Auth behavior already has its own smoke coverage. This suite keeps the
  // request on the "auth has admitted the caller" path so the route family
  // health checks stay focused on downstream app-facing contracts.
  app.use((req, _res, next) => {
    (req as express.Request & { userId: number; deviceId: string }).userId = 7001;
    (req as express.Request & { userId: number; deviceId: string }).deviceId = 'smoke-device';
    next();
  });
  app.use(mountPath, router);
  return app;
}

describe('app-facing happy path smoke', () => {
  beforeEach(() => {
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const todayIso = now.toISOString().slice(0, 10);
    const todayName = now.toLocaleDateString('en-US', { weekday: 'long' });

    mockDbAll.mockReset();
    mockDbGet.mockReset();
    mockDbRun.mockReset();
    mockGetCached.mockReset();
    mockSetCache.mockReset();
    mockComposeDailyBrief.mockReset();
    mockGetMealPlan.mockReset();
    mockGetActivePlans.mockReset();
    mockGetCurrentWeek.mockReset();
    mockGetWeeksForPlan.mockReset();
    mockGetSessionsForWeek.mockReset();
    mockReadTrainingContextAll.mockReset();
    mockGetWearableReadiness.mockReset();
    mockGetMonthlySummary.mockReset();
    mockGetMonthlyBudgetView.mockReset();
    mockGetPreferredCurrencyForUser.mockReset();
    mockCalculateMonthlyTax.mockReset();
    mockBuildTrainingHomeViewState.mockReset();
    mockBuildActiveSignalsResponse.mockReset();
    mockGetRuntimeStatus.mockReset();
    mockGetUserConnections.mockReset();
    mockGetFocusBlockRecommendation.mockReset();
    mockGetInvoiceVendorsMerged.mockReset();
    mockGetInvoiceVendorsDb.mockReset();
    mockGetUserLanguage.mockReset();
    mockGetUserById.mockReset();
    mockSetUserLanguage.mockReset();
    mockGetNotifications.mockReset();
    mockGetUnreadNotificationCount.mockReset();
    mockMarkNotificationRead.mockReset();
    mockMarkAllNotificationsRead.mockReset();
    mockResolveNotification.mockReset();
    mockGetRecentReports.mockReset();
    mockGetUnreadReportCount.mockReset();
    mockMarkReportRead.mockReset();
    mockSetPushPreference.mockReset();
    mockGetPushPreferences.mockReset();
    mockCreateCalendarEvent.mockReset();
    mockUpdateCalendarEvent.mockReset();
    mockDeleteCalendarEvent.mockReset();
    Object.values(mockTaskProvider).forEach((fn) => fn.mockReset());
    mockCollectMonthlyInvoices.mockReset();
    mockAddInvoiceVendor.mockReset();
    mockRemoveInvoiceVendor.mockReset();
    mockGetFiscalCollectionSummary.mockReset();
    mockSendFiscalBundleNow.mockReset();
    mockUpdateFiscalCollectionProfile.mockReset();

    mockGetCached.mockReturnValue(null);
    mockComposeDailyBrief.mockResolvedValue({
      date: todayIso,
      headline: 'Hoje está controlado',
      sections: [],
      coordination: null,
    });
    mockGetMealPlan.mockReturnValue([
      {
        id: 1,
        date: todayIso,
        meal_type: 'lunch',
        title: 'Frango com arroz',
        recipe_id: null,
        notes: null,
      },
    ]);
    mockGetActivePlans.mockReturnValue([]);
    mockGetCurrentWeek.mockReturnValue(null);
    mockGetWeeksForPlan.mockReturnValue([]);
    mockGetSessionsForWeek.mockReturnValue([]);
    mockReadTrainingContextAll.mockReturnValue({
      flags: {
        lowReadiness: false,
        lowSleep: false,
        lowHrv: false,
        highLegLoad: false,
      },
      signals: [],
    });
    mockGetWearableReadiness.mockResolvedValue(null);
    mockGetMonthlySummary.mockReturnValue({
      month: currentMonth,
      totalIncome: 2500,
      totalExpenses: 920,
      totalDeductions: 100,
      netIncome: 1480,
      transactionCount: 18,
    });
    mockGetMonthlyBudgetView.mockReturnValue({
      month: currentMonth,
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'reliable',
      affordability: 'comfortable',
      incomeInBasisCurrency: 2500,
      expensesInBasisCurrency: 920,
      currentRemainingInBasisCurrency: 1580,
      currentRemainingRatio: 0.632,
      projectedExpensesInBasisCurrency: 1200,
      projectedRemainingInBasisCurrency: 1300,
      projectedRemainingRatio: 0.52,
      recurringExpenseEstimate: 400,
      recurringExpenseCount: 4,
      recurringExpenses: [],
      notes: [],
    });
    mockGetPreferredCurrencyForUser.mockReturnValue('EUR');
    mockCalculateMonthlyTax.mockReturnValue({
      grossIncome: 2500,
      deductions: 100,
      inssDue: 275,
      taxableIncome: 2125,
      taxDue: 330,
      effectiveRate: 0.132,
      bracket: '23%',
    });
    mockBuildTrainingHomeViewState.mockReturnValue({
      title: 'Treino de hoje',
      hero: {
        title: 'Corrida leve',
        duration: 45,
        state: 'ready',
      },
      meta: { source: 'server' },
    });
    mockBuildActiveSignalsResponse.mockReturnValue({
      signals: [
        { id: 'sleep', title: 'Sono estável' },
      ],
    });
    mockGetRuntimeStatus.mockReturnValue({
      serviceStatus: 'online',
      databaseStatus: 'connected',
      botStatus: 'online',
      botPolling: true,
      botRestarting: false,
      lastMessageAt: `${todayIso}T12:00:00.000Z`,
    });
    mockGetUserConnections.mockReturnValue([
      {
        provider: 'google',
        connectedAt: `${todayIso}T07:00:00.000Z`,
        scopes: ['calendar', 'gmail.readonly'],
      },
    ]);
    mockGetFocusBlockRecommendation.mockResolvedValue({
      title: 'Bloco de foco',
      start: `${todayIso}T09:00:00.000Z`,
      end: `${todayIso}T10:30:00.000Z`,
    });
    mockGetInvoiceVendorsMerged.mockReturnValue([
      {
        name: 'ViaVerde',
        senderPatterns: ['viaverde.pt'],
        subjectPatterns: ['fatura'],
        builtin: true,
      },
    ]);
    mockGetInvoiceVendorsDb.mockReturnValue([
      {
        id: 77,
        name: 'ViaVerde',
        sender_pattern: 'viaverde.pt',
        subject_patterns: 'fatura',
        enabled: 1,
        user_id: 7001,
      },
    ]);
    mockGetUserLanguage.mockReturnValue('pt-BR');
    mockGetUserById.mockImplementation((userId: number) => ({ id: userId, first_name: 'Jaqueline', tier: 'pro' }));
    mockSetUserLanguage.mockReturnValue(undefined);
    mockGetNotifications.mockReturnValue([
      {
        id: 301,
        type: 'script_ready',
        title: 'Roteiro pronto',
        body: 'O roteiro da semana está pronto para rever.',
        data: { ideaId: 12 },
        status: 'unread',
        createdAt: `${todayIso}T11:00:00.000Z`,
      },
    ]);
    mockGetUnreadNotificationCount.mockReturnValue(1);
    mockMarkNotificationRead.mockReturnValue(true);
    mockMarkAllNotificationsRead.mockReturnValue(1);
    mockResolveNotification.mockReturnValue(true);
    mockGetRecentReports.mockReturnValue([
      {
        id: 401,
        type: 'morning_briefing',
        title: 'Briefing da manhã',
        summary: 'O dia está controlado antes do bloco de foco.',
        status: 'unread',
        createdAt: `${todayIso}T06:30:00.000Z`,
      },
    ]);
    mockGetUnreadReportCount.mockReturnValue(1);
    mockMarkReportRead.mockReturnValue(true);
    mockGetPushPreferences.mockReturnValue([
      { category: 'reports', enabled: true },
    ]);
    mockSetPushPreference.mockReturnValue(undefined);
    mockCreateCalendarEvent.mockResolvedValue({
      id: 'evt-new',
      summary: 'Bloco de foco',
      start: `${todayIso}T09:00:00.000Z`,
      end: `${todayIso}T10:00:00.000Z`,
      source: 'google',
      color: '#34C759',
    });
    mockUpdateCalendarEvent.mockResolvedValue({
      id: 'evt-1',
      summary: 'Bloco de foco ajustado',
      start: `${todayIso}T09:30:00.000Z`,
      end: `${todayIso}T10:30:00.000Z`,
      source: 'google',
      color: '#34C759',
    });
    mockDeleteCalendarEvent.mockResolvedValue(true);
    mockTaskProvider.getLists.mockResolvedValue({
      success: true,
      data: [{ id: 'list-1', displayName: 'Tasks', wellknownListName: 'defaultList' }],
    });
    mockTaskProvider.findListByName.mockResolvedValue(null);
    mockTaskProvider.getDefaultList.mockResolvedValue({ id: 'list-1', displayName: 'Tasks' });
    mockTaskProvider.createList.mockResolvedValue({
      success: true,
      data: { id: 'list-new', displayName: 'Recibos' },
    });
    mockTaskProvider.getTasks.mockResolvedValue({ success: true, data: [] });
    mockTaskProvider.getAllPendingTasks.mockResolvedValue({ success: true, data: [] });
    mockTaskProvider.getTask.mockResolvedValue({
      success: true,
      data: {
        id: 'task-1',
        title: 'Enviar recibos',
        status: 'notStarted',
        listId: 'list-1',
        listName: 'Tasks',
      },
    });
    mockTaskProvider.createTask.mockResolvedValue({
      success: true,
      data: {
        id: 'task-new',
        title: 'Enviar recibos',
        status: 'notStarted',
        importance: 'high',
      },
    });
    mockTaskProvider.updateTask.mockResolvedValue({
      success: true,
      data: {
        id: 'task-1',
        title: 'Enviar recibos atualizados',
        status: 'notStarted',
      },
    });
    mockTaskProvider.completeTask.mockResolvedValue({
      success: true,
      data: {
        id: 'task-1',
        title: 'Enviar recibos',
        status: 'completed',
      },
    });
    mockTaskProvider.deleteTask.mockResolvedValue({ success: true });
    mockCollectMonthlyInvoices.mockResolvedValue({
      collected: 2,
      filed: 2,
    });
    mockAddInvoiceVendor.mockReturnValue({
      id: 88,
      name: 'Apple',
      sender_pattern: 'apple.com',
      subject_patterns: 'receipt',
      enabled: 1,
      user_id: 7001,
    });
    mockRemoveInvoiceVendor.mockReturnValue(true);
    mockGetFiscalCollectionSummary.mockReturnValue({
      enabled: true,
      cadence: 'monthly',
      primaryDay: 28,
      sourceCount: 1,
    });
    mockSendFiscalBundleNow.mockResolvedValue({
      sent: true,
      recipient: 'accountant@example.com',
      attachmentCount: 2,
    });
    mockUpdateFiscalCollectionProfile.mockReturnValue(undefined);

    mockDbGet.mockImplementation((sql: string) => {
      if (sql.includes('SELECT status FROM users')) return { status: 'active' };
      if (sql.includes('FROM garmin_user_tokens')) return undefined;
      if (sql.includes('SELECT 1 as ok')) return { ok: 1 };
      return undefined;
    });
    mockDbRun.mockReturnValue({ changes: 1 });
    mockDbAll.mockImplementation((sql: string) => {
      if (sql.includes("FROM content_ideas WHERE stage = 'ideas'")) {
        return [{ id: 1, title: 'Ideia de recuperação', score: 88, created_at: `${todayIso}T10:00:00.000Z` }];
      }
      if (sql.includes("FROM content_ideas WHERE stage = 'scripted'")) {
        return [{ id: 2, title: 'Roteiro pronto', score: 80, created_at: `${todayIso}T09:00:00.000Z` }];
      }
      if (sql.includes("FROM content_ideas WHERE stage = 'filmed'")) return [];
      if (sql.includes("FROM content_ideas WHERE stage = 'editing'")) return [];
      if (sql.includes("FROM content_ideas WHERE stage = 'published'")) {
        return [{ id: 3, title: 'Publicado ontem', score: 70, created_at: `${todayIso}T08:00:00.000Z` }];
      }
      return [];
    });

    mockGetCurrentWeek.mockReturnValue({
      id: 91,
      week_number: 2,
      focus: 'base',
    });
    mockGetSessionsForWeek.mockReturnValue([
      {
        id: 501,
        day_of_week: todayName,
        title: 'Corrida leve',
        session_type: 'run',
        duration_minutes: 45,
        status: 'planned',
        description: 'Rodagem leve',
        exercises_json: null,
        calendar_event_id: null,
      },
    ]);
  });

  it('serves authenticated happy paths for the main app-facing route families', async () => {
    const cases: Array<{
      label: string;
      app: express.Express;
      path: string;
      assert: (body: any) => void;
    }> = [
      {
        label: 'plan today',
        app: protectedApp('/plan', planRoutes()),
        path: '/plan/today',
        assert: (body) => {
          expect(body.data).toMatchObject({
            headline: 'Hoje está controlado',
          });
        },
      },
      {
        label: 'training home',
        app: protectedApp('/training', trainingRoutes()),
        path: '/training/home',
        assert: (body) => {
          expect(body.data).toMatchObject({
            title: 'Treino de hoje',
            hero: {
              title: 'Corrida leve',
            },
          });
        },
      },
      {
        label: 'content pipeline',
        app: protectedApp('/content', contentRoutes()),
        path: '/content/pipeline',
        assert: (body) => {
          expect(body.data.stages.ideas).toHaveLength(1);
          expect(body.data.stats).toMatchObject({
            totalIdeas: 2,
            publishedThisMonth: 1,
          });
        },
      },
      {
        label: 'cooking meal plan',
        app: protectedApp('/cooking', cookingRoutes()),
        path: `/cooking/meal-plan?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`,
        assert: (body) => {
          expect(body.data).toMatchObject({
            count: 1,
          });
          expect(body.data.meals[0]).toMatchObject({
            title: 'Frango com arroz',
          });
        },
      },
      {
        label: 'finance monthly summary',
        app: protectedApp('/finance', financeRoutes()),
        path: '/finance/monthly-summary',
        assert: (body) => {
          expect(body.data.summary).toMatchObject({
            totalIncome: 2500,
            totalExpenses: 920,
          });
          expect(body.data.preferredCurrency).toBe('EUR');
        },
      },
      {
        label: 'connections root',
        app: protectedApp('/connections', connectionRoutes()),
        path: '/connections',
        assert: (body) => {
          expect(body.data.count).toBe(1);
          expect(body.data.connections[0]).toMatchObject({
            provider: 'google',
          });
        },
      },
      {
        label: 'settings status',
        app: protectedApp('/settings', settingsRoutes()),
        path: '/settings/status',
        assert: (body) => {
          expect(body.data).toMatchObject({
            serviceStatus: 'online',
            databaseStatus: 'connected',
            botStatus: 'online',
          });
        },
      },
      {
        label: 'calendar today',
        app: protectedApp('/calendar', calendarRoutes()),
        path: '/calendar/today',
        assert: (body) => {
          expect(body.data.date).toBeTruthy();
          expect(Array.isArray(body.data.events)).toBe(true);
        },
      },
      {
        label: 'invoices vendors',
        app: protectedApp('/invoices', invoicesRoutes()),
        path: '/invoices/vendors',
        assert: (body) => {
          expect(body.data).toMatchObject({
            builtinCount: 0,
            customCount: 1,
          });
          expect(body.data.active[0]).toMatchObject({
            name: 'ViaVerde',
            builtin: false,
          });
          expect(mockGetInvoiceVendorsMerged).not.toHaveBeenCalled();
        },
      },
      {
        label: 'notifications list',
        app: protectedApp('/notifications', notificationRoutes()),
        path: '/notifications',
        assert: (body) => {
          expect(body.data).toMatchObject({
            unreadCount: 1,
            count: 1,
          });
          expect(body.data.notifications[0]).toMatchObject({
            id: 301,
            type: 'script_ready',
            title: 'Roteiro pronto',
            status: 'unread',
          });
        },
      },
      {
        label: 'reports list',
        app: protectedApp('/reports', reportRoutes()),
        path: '/reports',
        assert: (body) => {
          expect(body.data).toMatchObject({
            unreadCount: 1,
            count: 1,
          });
          expect(body.data.reports[0]).toMatchObject({
            id: 401,
            type: 'morning_briefing',
            title: 'Briefing da manhã',
            status: 'unread',
          });
        },
      },
    ];

    for (const testCase of cases) {
      const res = await fetchJson(testCase.app, 'GET', testCase.path, { 'x-language': 'pt-BR' });
      expect(res.status, `${testCase.label}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.ok, `${testCase.label}: ${JSON.stringify(res.body)}`).toBe(true);
      expect(typeof res.body.timestamp).toBe('string');
      testCase.assert(res.body);
    }
  });

  it('serves authenticated mutation happy paths for core app-facing actions', async () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const cases: Array<{
      label: string;
      app: express.Express;
      method: Exclude<HttpMethod, 'GET'>;
      path: string;
      body?: unknown;
      expectedStatus?: number;
      assert: (body: any) => void;
    }> = [
      {
        label: 'tasks create list',
        app: protectedApp('/tasks', taskRoutes()),
        method: 'POST',
        path: '/tasks/lists',
        body: { name: 'Recibos' },
        expectedStatus: 201,
        assert: (body) => {
          expect(body.data).toMatchObject({
            id: 'list-new',
            displayName: 'Recibos',
          });
          expect(mockTaskProvider.createList).toHaveBeenCalledWith('Recibos');
        },
      },
      {
        label: 'tasks create task',
        app: protectedApp('/tasks', taskRoutes()),
        method: 'POST',
        path: '/tasks',
        body: { title: 'Enviar recibos', importance: 'high' },
        expectedStatus: 201,
        assert: (body) => {
          expect(body.data.task).toMatchObject({
            id: 'task-new',
            title: 'Enviar recibos',
            listId: 'list-1',
            listName: 'Tasks',
            syncProvider: 'ms_todo',
          });
          expect(mockTaskProvider.createTask).toHaveBeenCalledWith(
            'list-1',
            'Tasks',
            expect.objectContaining({ title: 'Enviar recibos', importance: 'high' }),
          );
        },
      },
      {
        label: 'tasks complete task',
        app: protectedApp('/tasks', taskRoutes()),
        method: 'POST',
        path: '/tasks/list-1/task-1/complete',
        assert: (body) => {
          expect(body.data.task).toMatchObject({
            id: 'task-1',
            title: 'Enviar recibos',
            status: 'completed',
            listId: 'list-1',
            listName: 'Tasks',
          });
          expect(body.data.message).toContain('Completed');
          expect(mockTaskProvider.completeTask).toHaveBeenCalledWith('list-1', 'task-1', 'Tasks');
        },
      },
      {
        label: 'calendar create event',
        app: protectedApp('/calendar', calendarRoutes()),
        method: 'POST',
        path: '/calendar/events',
        body: {
          title: 'Bloco de foco',
          start: `${todayIso}T09:00:00.000Z`,
          end: `${todayIso}T10:00:00.000Z`,
          source: 'google',
        },
        assert: (body) => {
          expect(body.data.event).toMatchObject({
            id: 'evt-new',
            title: 'Bloco de foco',
            source: 'google',
            color: '#34C759',
          });
          expect(mockCreateCalendarEvent).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Bloco de foco' }),
            'google',
            7001,
          );
        },
      },
      {
        label: 'calendar update event',
        app: protectedApp('/calendar', calendarRoutes()),
        method: 'PATCH',
        path: '/calendar/events/evt-1',
        body: {
          title: 'Bloco de foco ajustado',
          source: 'google',
        },
        assert: (body) => {
          expect(body.data.event).toMatchObject({
            id: 'evt-1',
            title: 'Bloco de foco ajustado',
            source: 'google',
          });
          expect(mockUpdateCalendarEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              event_id: 'evt-1',
              new_title: 'Bloco de foco ajustado',
            }),
            'google',
            7001,
          );
        },
      },
      {
        label: 'calendar delete event',
        app: protectedApp('/calendar', calendarRoutes()),
        method: 'DELETE',
        path: '/calendar/events/evt-1?source=google',
        assert: (body) => {
          expect(body.data).toMatchObject({
            deleted: true,
            eventId: 'evt-1',
            source: 'google',
          });
          expect(mockDeleteCalendarEvent).toHaveBeenCalledWith('evt-1', 'google', 7001);
        },
      },
      {
        label: 'settings language',
        app: protectedApp('/settings', settingsRoutes()),
        method: 'POST',
        path: '/settings/language',
        body: { language: 'pt-PT' },
        assert: (body) => {
          expect(body.data).toMatchObject({ language: 'pt-PT' });
          expect(mockSetUserLanguage).toHaveBeenCalledWith(7001, 'pt-PT');
        },
      },
      {
        label: 'settings push preferences',
        app: protectedApp('/settings', settingsRoutes()),
        method: 'POST',
        path: '/settings/push-preferences',
        body: { category: 'reports', enabled: false },
        assert: (body) => {
          expect(body.data).toMatchObject({ category: 'reports', enabled: false });
          expect(mockSetPushPreference).toHaveBeenCalledWith(7001, 'reports', false);
        },
      },
      {
        label: 'invoices update profile',
        app: protectedApp('/invoices', invoicesRoutes()),
        method: 'PUT',
        path: '/invoices/profile',
        body: {
          enabled: true,
          cadence: 'monthly',
          primaryDay: 28,
          recipientEmail: 'accountant@example.com',
          sourceProviders: ['gmail'],
        },
        assert: (body) => {
          expect(body.data).toMatchObject({
            enabled: true,
            cadence: 'monthly',
            primaryDay: 28,
          });
          expect(mockUpdateFiscalCollectionProfile).toHaveBeenCalledWith(
            7001,
            expect.objectContaining({
              enabled: true,
              cadence: 'monthly',
              primary_day: 28,
            }),
          );
        },
      },
      {
        label: 'invoices create vendor',
        app: protectedApp('/invoices', invoicesRoutes()),
        method: 'POST',
        path: '/invoices/vendors',
        body: { name: 'Apple', senderPattern: 'apple.com', subjectPatterns: ['receipt'] },
        expectedStatus: 201,
        assert: (body) => {
          expect(body.data.vendor).toMatchObject({
            id: 88,
            name: 'Apple',
          });
          expect(mockAddInvoiceVendor).toHaveBeenCalledWith('Apple', 'apple.com', 7001, ['receipt']);
        },
      },
      {
        label: 'invoices delete vendor',
        app: protectedApp('/invoices', invoicesRoutes()),
        method: 'DELETE',
        path: '/invoices/vendors/88',
        assert: (body) => {
          expect(body.data).toMatchObject({ removed: true, id: 88 });
          expect(mockRemoveInvoiceVendor).toHaveBeenCalledWith(88, 7001);
        },
      },
      {
        label: 'notifications mark read',
        app: protectedApp('/notifications', notificationRoutes()),
        method: 'POST',
        path: '/notifications/301/read',
        assert: (body) => {
          expect(body.data).toMatchObject({ marked: true });
          expect(mockMarkNotificationRead).toHaveBeenCalledWith(301, 7001);
        },
      },
      {
        label: 'notifications mark all read',
        app: protectedApp('/notifications', notificationRoutes()),
        method: 'POST',
        path: '/notifications/read-all',
        assert: (body) => {
          expect(body.data).toMatchObject({ markedCount: 1 });
          expect(mockMarkAllNotificationsRead).toHaveBeenCalledWith(7001);
        },
      },
      {
        label: 'reports mark read',
        app: protectedApp('/reports', reportRoutes()),
        method: 'POST',
        path: '/reports/401/read',
        assert: (body) => {
          expect(body.data).toMatchObject({ marked: true });
          expect(mockMarkReportRead).toHaveBeenCalledWith(401, 7001);
        },
      },
    ];

    for (const testCase of cases) {
      const res = await fetchJson(
        testCase.app,
        testCase.method,
        testCase.path,
        { 'x-language': 'pt-BR' },
        testCase.body,
      );
      expect(res.status, `${testCase.label}: ${JSON.stringify(res.body)}`).toBe(testCase.expectedStatus || 200);
      expect(res.body.ok, `${testCase.label}: ${JSON.stringify(res.body)}`).toBe(true);
      expect(typeof res.body.timestamp).toBe('string');
      testCase.assert(res.body);
    }
  });
});
