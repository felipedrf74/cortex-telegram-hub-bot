import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function collectRuntimeDependencySpecifiers(source: string, file: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = new Set<string>();
  const record = (node: ts.Expression | undefined) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      record(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...specifiers].sort();
}

function collectForbiddenProviderCalls(source: string, file: string): string[] {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const forbidden = new Set([
    'acquireCostLock',
    'callAI',
    'enforceCostGuardrails',
    'generateText',
    'withAiBudgetReservation',
  ]);
  const calls = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : '';
      if (forbidden.has(name)) calls.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...calls].sort();
}

const mockGetProfile = vi.fn();
const mockGetMissingProfileFields = vi.fn();
const mockGetQuestionnaire = vi.fn();
const mockGetEvents = vi.fn();
const mockBuildTrainingEquipmentAdaptation = vi.fn();
const mockAdaptTrainingPlanToAvailableEquipment = vi.fn();
const mockBuildTrainingPlanCoordination = vi.fn();
const mockApplyTrainingPlanCoordination = vi.fn();
const mockBuildSharedDecisionContext = vi.fn();
const mockReadTrainingMeshContext = vi.fn();
const mockReadCookingMeshContext = vi.fn();
const mockReadFinanceMeshContext = vi.fn();
const mockReadContentMeshContext = vi.fn();
const mockReadSecretaryMeshContext = vi.fn();
const mockBuildCoachKernelTrainingPlan = vi.fn();
const mockBuildDeterministicTrainingPlan = vi.fn();
const mockFetchCurrentReadinessForPlan = vi.fn();
const mockFinalizeGeneratedTrainingPlanForPersistence = vi.fn();
const mockLintGeneratedTrainingPlanPreflight = vi.fn();
const mockPersistGeneratedTrainingPlan = vi.fn();
const mockCancelTrainingPlanForUser = vi.fn();
// Slice 4.D.2 — saga inspects post-cancellation state via these.
const mockGetActivePlans = vi.fn();
const mockActivatePendingPlan = vi.fn(() => true);
const mockDeletePlanHard = vi.fn(() => ({ deleted: true }));
const mockFindOrphanedOwnerships = vi.fn();
const mockReconcileOrphanedTrainingAgendaEvents = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockIsConnected = vi.fn();
const mockGetLatestHealthSignal = vi.fn();

vi.mock('../../src/services/onboarding', () => ({
  getProfile: (...args: unknown[]) => mockGetProfile(...args),
  getMissingProfileFields: (...args: unknown[]) => mockGetMissingProfileFields(...args),
  getQuestionnaire: (...args: unknown[]) => mockGetQuestionnaire(...args),
}));

vi.mock('../../src/services/unified-calendar', () => ({
  getEvents: (...args: unknown[]) => mockGetEvents(...args),
  getEventsForSources: (...args: unknown[]) => mockGetEvents(...args),
  // Identity-safety / test-isolation: vitest config has `singleFork: true`,
  // so a partial mock on this module leaks `undefined` exports to later
  // test files (e.g., `training-plan-calendar-sync.test.ts` re-mocks but
  // hits a stale module cache without these methods). Provide complete
  // no-op spies for the rest of the surface so the partial mock cannot
  // poison sibling tests.
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  getEventsWithDiagnostics: vi.fn(async () => ({
    events: [],
    status: 'ready',
    warnings: [],
    warningCodes: [],
    sources: { configured: [], fulfilled: [], failed: [] },
  })),
  isAnyCalendarConfigured: vi.fn(() => false),
  hasConnectedCalendarForUser: vi.fn(() => false),
  hasWritableCalendarForUser: vi.fn(() => false),
  getConfiguredSources: vi.fn(() => []),
  eventFingerprint: vi.fn(() => ''),
  deduplicateEvents: vi.fn((events: unknown[]) => events),
}));

vi.mock('../../src/services/training-plan-equipment-adaptation', () => ({
  buildTrainingEquipmentAdaptation: (...args: unknown[]) => mockBuildTrainingEquipmentAdaptation(...args),
  adaptTrainingPlanToAvailableEquipment: (...args: unknown[]) => mockAdaptTrainingPlanToAvailableEquipment(...args),
}));

vi.mock('../../src/services/training-plan-coordination', () => ({
  buildTrainingPlanCoordination: (...args: unknown[]) => mockBuildTrainingPlanCoordination(...args),
  applyTrainingPlanCoordination: (...args: unknown[]) => mockApplyTrainingPlanCoordination(...args),
}));

vi.mock('../../src/services/shared-decision-context', () => ({
  buildSharedDecisionContext: (...args: unknown[]) => mockBuildSharedDecisionContext(...args),
}));

vi.mock('../../src/services/cross-agent-learning', () => ({
  readTrainingMeshContext: (...args: unknown[]) => mockReadTrainingMeshContext(...args),
  readCookingMeshContext: (...args: unknown[]) => mockReadCookingMeshContext(...args),
  readFinanceMeshContext: (...args: unknown[]) => mockReadFinanceMeshContext(...args),
  readContentMeshContext: (...args: unknown[]) => mockReadContentMeshContext(...args),
  readSecretaryMeshContext: (...args: unknown[]) => mockReadSecretaryMeshContext(...args),
}));

vi.mock('../../src/services/training-coach-kernel-plan-generator', () => ({
  buildCoachKernelTrainingPlan: (...args: unknown[]) => mockBuildCoachKernelTrainingPlan(...args),
  normalizeTrainingPlanDurationWeeks: (raw: unknown, fallback = 4) => {
    const resolved = Number(raw);
    const candidate = Number.isFinite(resolved) && resolved > 0 ? Math.round(resolved) : fallback;
    return Math.max(1, Math.min(52, candidate));
  },
}));

vi.mock('../../src/api/routes/training-fallback-plan', () => ({
  buildDeterministicTrainingPlan: (...args: unknown[]) => mockBuildDeterministicTrainingPlan(...args),
}));

vi.mock('../../src/api/routes/training-read-models', () => ({
  fetchCurrentReadinessForPlan: (...args: unknown[]) => mockFetchCurrentReadinessForPlan(...args),
}));

vi.mock('../../src/api/routes/training-plan-persistence', () => ({
  finalizeGeneratedTrainingPlanForPersistence: (...args: unknown[]) => (
    mockFinalizeGeneratedTrainingPlanForPersistence(...args)
  ),
  lintGeneratedTrainingPlanPreflight: (...args: unknown[]) => (
    mockLintGeneratedTrainingPlanPreflight(...args)
  ),
  persistGeneratedTrainingPlan: (...args: unknown[]) => mockPersistGeneratedTrainingPlan(...args),
}));

vi.mock('../../src/api/routes/training-plan-cancellation', () => ({
  cancelTrainingPlanForUser: (...args: unknown[]) => mockCancelTrainingPlanForUser(...args),
}));

vi.mock('../../src/services/training-plans', () => ({
  getActivePlans: (...args: unknown[]) => mockGetActivePlans(...args),
  // F6 (Phase 1A-2): generation now persists the replacement as
  // `pending_activation` and promotes it only after the old plan is gone.
  activatePendingPlan: (...args: unknown[]) => mockActivatePendingPlan(...args),
  deletePlanHard: (...args: unknown[]) => mockDeletePlanHard(...args),
}));

vi.mock('../../src/services/training-plan-lifecycle', () => ({
  findOrphanedOwnerships: (...args: unknown[]) => mockFindOrphanedOwnerships(...args),
}));

vi.mock('../../src/services/training-agenda-reconciliation', () => ({
  reconcileOrphanedTrainingAgendaEvents: (...args: unknown[]) => (
    mockReconcileOrphanedTrainingAgendaEvents(...args)
  ),
}));

vi.mock('../../src/services/oauth-store', () => ({
  isConnected: (...args: unknown[]) => mockIsConnected(...args),
}));

vi.mock('../../src/services/health-signals', () => ({
  getLatestHealthSignal: (...args: unknown[]) => mockGetLatestHealthSignal(...args),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    info: vi.fn(),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  TRAINING_PLAN_GENERATOR_POLICY_VERSION,
  clampTrainingPlanDurationWeeksToRaceDate,
  generateTrainingPlanForUser,
  resolveTrainingPlanStartDate,
} from '../../src/api/routes/training-plan-generation';
import { config } from '../../src/config';
import {
  TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
  TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
} from '../../src/services/training-exercise-identity';
import { resolveCanonicalEquipmentProfile } from '../../src/services/training-equipment-vocabulary';
import { validateTrainingPlanPreviewToken } from '../../src/services/training-plan-preview-token';

function makePlan(title = 'Coach Plan') {
  return {
    planName: title,
    sport: 'running',
    weeks: [
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          {
            dayOfWeek: 'Monday',
            sessionType: 'run',
            title: 'Easy Run',
            durationMinutes: 45,
            description: 'Easy aerobic run.',
          },
        ],
      },
    ],
  };
}

function makePlanFromKernelInput(input: any, title = 'Coach Plan') {
  const priority = String(input?.trainingPriority ?? '').toLowerCase();
  const objective = String(input?.objective ?? '').toLowerCase();
  const sport = priority === 'strength' || /muscle|strength|gym/i.test(objective)
    ? 'gym'
    : priority === 'cycling'
      ? 'cycling'
      : priority === 'swimming'
        ? 'swimming'
        : priority === 'triathlon' || priority === 'hybrid'
          ? 'hybrid'
          : 'running';
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const sessions: any[] = [];
  let dayIndex = 0;
  const requested = (value: unknown): number => (
    typeof value === 'number' && value > 0 ? Math.round(value) : 0
  );
  const sessionsPerWeek = requested(input?.sessionsPerWeek) || 5;
  const activeDays = days.slice(0, Math.max(1, Math.min(days.length, sessionsPerWeek)));
  const addSessions = (count: number, sessionType: string, sessionTitle: string) => {
    for (let index = 0; index < count; index += 1) {
      sessions.push({
        dayOfWeek: activeDays[dayIndex % activeDays.length],
        sessionType,
        title: `${sessionTitle} ${index + 1}`,
        durationMinutes: sessionType === 'swim' ? 35 : 45,
        description: `${sessionTitle} scheduled from test kernel input.`,
        exercises: sessionType === 'gym' ? [{ name: 'Squat' }] : [],
      });
      dayIndex += 1;
    }
  };

  const runCount = requested(input?.runSessionsPerWeek)
    || (sport === 'running' ? sessionsPerWeek : 0);
  const bikeCount = requested(input?.bikeSessionsPerWeek)
    || (priority === 'cycling' ? sessionsPerWeek : 0)
    || (priority === 'triathlon' ? 1 : 0);
  const swimCount = requested(input?.swimSessionsPerWeek)
    || (priority === 'swimming' ? sessionsPerWeek : 0)
    || (priority === 'triathlon' ? 1 : 0);
  const strengthCount = requested(input?.strengthSessionsPerWeek);
  const strengthFallback = sport === 'gym' && strengthCount === 0 ? sessionsPerWeek : 0;

  addSessions(runCount, 'run', 'Run');
  addSessions(bikeCount, 'ride', 'Ride');
  addSessions(swimCount, 'swim', 'Swim');
  addSessions(strengthCount || strengthFallback, 'gym', 'Strength');

  return {
    planName: title,
    sport,
    weeks: [
      {
        weekNumber: 1,
        focus: 'base',
        intensityPct: 70,
        sessions,
      },
    ],
  };
}

describe('generateTrainingPlanForUser', () => {
  it('restores the never-two-a-day invariant after quality enrichment', () => {
    const source = readFileSync(path.resolve('src/api/routes/training-plan-generation.ts'), 'utf8');
    const qualityCall = source.indexOf('prepareTrainingPlanForQualityGate(planData');
    const finalCapCall = source.indexOf('enforceFinalTrainingPlanTwoADayCap(', qualityCall + 1);

    // Stronger guarantee: late quality/repair passes may move sessions, so the
    // hard athlete cap must be the final schedule-shape mutator before lint.
    expect(qualityCall).toBeGreaterThan(-1);
    expect(finalCapCall).toBeGreaterThan(qualityCall);
    expect(finalCapCall).toBeLessThan(source.indexOf('lintGeneratedTrainingPlanPreflight('));
  });

  it('keeps the operational generator free of direct model-provider dependencies', () => {
    const files = [
      'src/api/routes/training-plan-generation.ts',
      'src/api/routes/training-plan-routes.ts',
    ];
    const forbidden = /anthropic|gemini|openai|ollama|ai-provider|domain-provider-router|provider-fallback|provider-registry|api-usage|usage-metering|cost-guardrail/i;

    expect(collectRuntimeDependencySpecifiers(`
      import '../../services/anthropic-provider';
      const one = import('../../services/openai-provider');
      const two = require('../../services/provider-fallback');
      import legacy = require('../../services/ollama-provider');
    `, 'synthetic-provider-boundary.ts')).toEqual([
      '../../services/anthropic-provider',
      '../../services/ollama-provider',
      '../../services/openai-provider',
      '../../services/provider-fallback',
    ]);

    for (const file of files) {
      const source = readFileSync(path.resolve(file), 'utf8');
      const dependencies = collectRuntimeDependencySpecifiers(source, file);
      expect(dependencies.filter((specifier) => forbidden.test(specifier)), file).toEqual([]);
      expect(collectForbiddenProviderCalls(source, file), file).toEqual([]);
    }
  });

  beforeEach(() => {
    vi.useRealTimers();
    mockGetProfile.mockReset();
    mockGetMissingProfileFields.mockReset();
    mockGetQuestionnaire.mockReset();
    mockGetEvents.mockReset();
    mockBuildTrainingEquipmentAdaptation.mockReset();
    mockAdaptTrainingPlanToAvailableEquipment.mockReset();
    mockBuildTrainingPlanCoordination.mockReset();
    mockApplyTrainingPlanCoordination.mockReset();
    mockBuildSharedDecisionContext.mockReset();
    mockReadTrainingMeshContext.mockReset();
    mockReadCookingMeshContext.mockReset();
    mockReadFinanceMeshContext.mockReset();
    mockReadContentMeshContext.mockReset();
    mockReadSecretaryMeshContext.mockReset();
    mockBuildCoachKernelTrainingPlan.mockReset();
    mockBuildDeterministicTrainingPlan.mockReset();
    mockFetchCurrentReadinessForPlan.mockReset();
    mockFinalizeGeneratedTrainingPlanForPersistence.mockReset();
    mockLintGeneratedTrainingPlanPreflight.mockReset();
    mockPersistGeneratedTrainingPlan.mockReset();
    mockCancelTrainingPlanForUser.mockReset();
    mockGetActivePlans.mockReset();
    mockFindOrphanedOwnerships.mockReset();
    mockReconcileOrphanedTrainingAgendaEvents.mockReset();
    mockLoggerWarn.mockReset();
    mockLoggerError.mockReset();
    mockIsConnected.mockReset();
    mockGetLatestHealthSignal.mockReset();
    mockGetLatestHealthSignal.mockReturnValue(null);
    config.coaching.trainingSafetyGuardrailsEnabled = false;
    config.coaching.coachKernelEquipmentAuthorityEnabled = false;
    config.coaching.trainingCalendarCapacityKernelEnabled = false;
    mockIsConnected.mockReturnValue(true);
    // Slice 4.D.2 defaults — clean state, no orphans, no remaining plans.
    mockGetActivePlans.mockReturnValue([]);
    mockFindOrphanedOwnerships.mockReturnValue([]);
    mockReconcileOrphanedTrainingAgendaEvents.mockResolvedValue({
      attempted: 0,
      deleted: 0,
      failed: 0,
    });

    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      if (questionnaireId === 'triathlon-running') return { currentMileage: 35 };
      if (questionnaireId === 'triathlon-gym') return { equipment_access: 'Full gym' };
      return null;
    });
    mockGetMissingProfileFields.mockReturnValue([]);
    mockGetQuestionnaire.mockImplementation((id: string) => ({ id, title: id }));
    mockGetEvents.mockResolvedValue([]);
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({ equipmentProfile: 'full_gym' });
    mockBuildTrainingPlanCoordination.mockReturnValue({ promptBlock: '- ok' });
    mockApplyTrainingPlanCoordination.mockImplementation((plan: unknown) => plan);
    mockAdaptTrainingPlanToAvailableEquipment.mockImplementation((plan: unknown) => plan);
    mockBuildSharedDecisionContext.mockResolvedValue('<shared>context</shared>');
    mockReadTrainingMeshContext.mockResolvedValue({ derivedSignals: [{ signalType: 'recovery_state' }] });
    mockReadCookingMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadFinanceMeshContext.mockResolvedValue({ derivedSignals: [] });
    mockReadContentMeshContext.mockResolvedValue({ filmingRecommendation: null });
    mockReadSecretaryMeshContext.mockResolvedValue({ focusBlock: null });
    mockBuildCoachKernelTrainingPlan.mockImplementation((input: any) => makePlanFromKernelInput(input));
    mockBuildDeterministicTrainingPlan.mockReturnValue(makePlan('Fallback Plan'));
    mockFetchCurrentReadinessForPlan.mockResolvedValue({ score: 76 });
    mockFinalizeGeneratedTrainingPlanForPersistence.mockImplementation((input: unknown) => input);
    mockLintGeneratedTrainingPlanPreflight.mockReturnValue({
      status: 'pass',
      blockers: [],
      warnings: [],
      suggestedFixes: [],
    });
    // Phase 1B: persistence queues calendar work through the outbox instead
    // of creating provider events inline, so its result reports zero
    // created/linked plus the queued-sync flags.
    mockPersistGeneratedTrainingPlan.mockResolvedValue({
      planId: 9001,
      totalSessions: 4,
      eventsCreated: 0,
      sessionsLinked: 0,
      calendarSyncQueued: true,
      syncableSessions: 4,
      weekSummaries: [{ weekNumber: 1, focus: 'base', sessionCount: 4 }],
    });
    mockCancelTrainingPlanForUser.mockResolvedValue({
      status: 'not_found',
      data: {
        cancelled: false,
        removedEvents: 0,
        removedSessions: 0,
        removedWeeks: 0,
        removedCompletions: 0,
        removedPlans: 0,
        totalSessions: 0,
        message: 'No active training plan to cancel.',
      },
    });
  });

  it('returns a missing-profile response before calling planning services', async () => {
    mockGetProfile.mockReturnValue(null);
    mockGetMissingProfileFields.mockReturnValue([{ key: 'fitness_goal' }]);
    mockGetQuestionnaire.mockImplementation((id: string) =>
      id === 'fitness' ? { id, title: 'Fitness Profile' } : { id, title: id });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
    });

    expect(result.status).toBe('needs_profile');
    // RERUN-2 finding 3: the fitness gate must carry the questionnaire
    // id + title just like the objective gate below it — a null id
    // suppressed the iOS routing CTA for empty-profile users.
    expect(result.data).toMatchObject({
      needsProfile: true,
      requiredQuestionnaireId: 'fitness',
      requiredQuestionnaireTitle: 'Fitness Profile',
      missingFields: [{ key: 'fitness_goal' }],
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('asks for clarification before saving high-frequency strength plans with unknown equipment', async () => {
    const fitnessProfile = {
      experienceLevel: 'Intermediate',
      available_equipment: 'unknown',
    };
    const gymProfile = { equipment_access: 'unknown' };
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return fitnessProfile;
      if (questionnaireId === 'triathlon-gym') return gymProfile;
      return null;
    });
    const canonicalProfile = resolveCanonicalEquipmentProfile({
      fitnessProfile,
      gymProfile,
      recordConservativeDefaultMetric: false,
    });
    expect(canonicalProfile).toMatchObject({
      bucket: 'bodyweight',
      confidence: 'unknown',
    });
    expect(canonicalProfile.items.length).toBeGreaterThan(0);
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({
      // Stronger guarantee: the real resolver retains bodyweight-safe
      // generation defaults, but those items are not evidence that the user
      // declared equipment and therefore must not suppress clarification.
      equipmentProfile: 'full_gym',
      canonicalProfile,
      decisionReasons: canonicalProfile.decisionReasons,
      summary: canonicalProfile.summary,
      promptBlock: '- conservative fallback',
      authority: 'legacy_route_adapter',
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build muscle with a 5-day gym plan',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    expect(result.status).toBe('needs_clarification');
    if (result.status === 'needs_clarification') {
      expect(
        result.data.clarificationIssues
          .filter((issue) => issue.severity === 'blocker')
          .map((issue) => issue.id)
          .sort(),
      ).toEqual(['equipment_clarification', 'session_duration_clarification']);
      expect(result.data.clarificationIssues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'equipment_clarification', severity: 'blocker' }),
          expect.objectContaining({ id: 'session_duration_clarification', severity: 'blocker' }),
        ]),
      );
      expect(result.data.suggestedQuestions.join(' ')).toMatch(/equipment/i);
      // Phase 2 (F2): every clarification issue carries allowlisted,
      // machine-readable resolution metadata so the client can render an
      // answerable form and save through the canonical profile path instead
      // of dead-ending on "Try again".
      const issuesById = new Map(
        (result.data.clarificationIssues as Array<{ id: string; resolution?: unknown }>).map(
          (issue) => [issue.id, issue],
        ),
      );
      expect(issuesById.get('equipment_clarification')?.resolution).toEqual({
        profileType: 'triathlon-gym',
        fields: [{
          fieldKey: 'equipment_access',
          answerType: 'choice',
          allowedValues: [
            'Full commercial gym',
            'Garage gym (barbell + rack)',
            'Home gym (basic)',
            'Bodyweight only',
          ],
        }],
      });
      expect(issuesById.get('session_duration_clarification')?.resolution).toEqual({
        profileType: 'triathlon-gym',
        fields: [{
          fieldKey: 'session_duration_minutes',
          answerType: 'number',
          min: 20,
          max: 180,
          unit: 'minutes',
        }],
      });
    }
    expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'training_plan_spec.needs_clarification',
        clarificationIds: expect.arrayContaining(['equipment_clarification']),
      }),
      expect.stringContaining('needs clarification'),
    );
  });

  it('consumes an answered session duration from the canonical gym profile', async () => {
    // Phase 2 (F2): the client answers session_duration_clarification by
    // writing the allowlisted `session_duration_minutes` field through the
    // canonical profile path, then re-previews. The answered value must feed
    // the spec so the clarification clears — equipment stays open here, so
    // the request is still blocked, proving severity is untouched.
    const fitnessProfile = {
      experienceLevel: 'Intermediate',
      available_equipment: 'unknown',
    };
    const gymProfile = {
      equipment_access: 'unknown',
      session_duration_minutes: '60',
    };
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return fitnessProfile;
      if (questionnaireId === 'triathlon-gym') return gymProfile;
      return null;
    });
    const canonicalProfile = resolveCanonicalEquipmentProfile({
      fitnessProfile,
      gymProfile,
      recordConservativeDefaultMetric: false,
    });
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({
      equipmentProfile: 'full_gym',
      canonicalProfile,
      decisionReasons: canonicalProfile.decisionReasons,
      summary: canonicalProfile.summary,
      promptBlock: '- conservative fallback',
      authority: 'legacy_route_adapter',
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build muscle with a 5-day gym plan',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });

    expect(result.status).toBe('needs_clarification');
    if (result.status === 'needs_clarification') {
      const ids = (result.data.clarificationIssues as Array<{ id: string }>).map((issue) => issue.id);
      expect(ids).toContain('equipment_clarification');
      expect(ids).not.toContain('session_duration_clarification');
    }
  });

  it('falls back to the questionnaire id when the fitness definition has no title', async () => {
    mockGetProfile.mockReturnValue(null);
    mockGetMissingProfileFields.mockReturnValue([{ key: 'fitness_goal' }]);
    mockGetQuestionnaire.mockReturnValue(undefined);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
    });

    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      needsProfile: true,
      requiredQuestionnaireId: 'fitness',
      requiredQuestionnaireTitle: 'fitness',
    });
  });

  it('treats an empty persisted onboarding wrapper as a missing profile', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') {
        return {
          id: 1,
          user_id: 12,
          profile_type: 'fitness',
          data: {},
          created_at: '2026-05-03',
          updated_at: '2026-05-03',
        };
      }
      return null;
    });
    mockGetMissingProfileFields.mockReturnValue([{ key: 'experience_level' }]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General fitness',
    });

    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      needsProfile: true,
      requiredQuestionnaireId: 'fitness',
      requiredQuestionnaireTitle: 'fitness',
    });
    expect(mockBuildTrainingEquipmentAdaptation).not.toHaveBeenCalled();
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('unwraps persisted onboarding profile rows before planning and equipment adaptation', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') {
        return {
          id: 1,
          user_id: 12,
          profile_type: 'fitness',
          data: {
            experience_level: 'Advanced (3+ years)',
            available_equipment: 'Full gym',
            training_goals: 'Strength, Endurance',
          },
          created_at: '2026-05-03',
          updated_at: '2026-05-03',
        };
      }
      if (questionnaireId === 'triathlon-gym') {
        return {
          id: 2,
          user_id: 12,
          profile_type: 'triathlon-gym',
          data: {
            training_age: '5+ years',
            equipment_access: 'Full commercial gym',
            primary_goal: 'Hypertrophy',
          },
          created_at: '2026-05-03',
          updated_at: '2026-05-03',
        };
      }
      if (questionnaireId === 'triathlon-running') {
        return {
          id: 3,
          user_id: 12,
          profile_type: 'triathlon-running',
          data: {
            weekly_mileage_km: '45',
            target_race: 'Marathon',
            target_race_date: '2026-10-18',
          },
          created_at: '2026-05-03',
          updated_at: '2026-05-03',
        };
      }
      return null;
    });

    await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 5,
    });

    expect(mockBuildTrainingEquipmentAdaptation).toHaveBeenCalledWith(expect.objectContaining({
      fitnessProfile: expect.objectContaining({
        available_equipment: 'Full gym',
      }),
      gymProfile: expect.objectContaining({
        equipment_access: 'Full commercial gym',
      }),
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      fitnessProfile: expect.objectContaining({
        experience_level: 'Advanced (3+ years)',
      }),
      gymProfile: expect.objectContaining({
        training_age: '5+ years',
      }),
      runProfile: expect.objectContaining({
        weekly_mileage_km: '45',
      }),
    }));
    expect(mockBuildCoachKernelTrainingPlan.mock.calls[0][0].fitnessProfile).not.toHaveProperty('data');
    expect(mockBuildCoachKernelTrainingPlan.mock.calls[0][0].gymProfile).not.toHaveProperty('data');
    expect(mockBuildCoachKernelTrainingPlan.mock.calls[0][0].runProfile).not.toHaveProperty('data');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    const preferences = JSON.parse(persistInput.preferencesJson);
    expect(preferences.trainingPlanQuality).toEqual(expect.objectContaining({
      schemaVersion: 1,
      validation: expect.any(Object),
      whyThisPlan: expect.arrayContaining([expect.any(String)]),
    }));
  });

  it('returns the objective-specific questionnaire requirement before planning', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      return null;
    });
    mockGetQuestionnaire.mockImplementation((id: string) => ({ id, title: 'Running Profile' }));
    mockGetMissingProfileFields.mockImplementation((_userId: number, questionnaireId: string) => (
      questionnaireId === 'triathlon-running'
        ? [{ key: 'weekly_mileage_km' }]
        : []
    ));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Porto Marathon',
    });

    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      needsProfile: true,
      requiredQuestionnaireId: 'triathlon-running',
      requiredQuestionnaireTitle: 'Running Profile',
      missingFields: [{ key: 'weekly_mileage_km' }],
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
  });

  it('builds a coordinated coach-kernel plan and returns the persisted response shape', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-04-15T06:00:00.000Z'));
    mockGetEvents.mockResolvedValue([
      {
        start: '2026-04-20T09:00:00.000Z',
        end: '2026-04-20T10:00:00.000Z',
        subject: 'Fixed meeting',
      },
    ]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      durationWeeks: 6,
      preferredTime: 'not-a-time',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: ' Sunday ',
      notes: '  keep knees happy  ',
    });

    expect(result.status).toBe('created');
    expect(result.data).toMatchObject({
      planId: 9001,
      planName: 'Coach Plan',
      sport: 'running',
      objective: 'Lisbon Marathon',
      durationWeeks: 6,
      resolvedStartDate: '2026-04-20',
      totalSessions: 4,
      // Phase 1B: the creation response can no longer observe provider
      // outcomes — sync happens in the background worker after activation.
      // The old 'partial' + fabricated per-session failure counts encoded
      // the inline provider loop; 'not_synced' + pending is the honest
      // point-in-time truth and the worker persists the durable state.
      eventsCreated: 0,
      calendarSync: expect.objectContaining({
        eventsCreated: 0,
        sessionsLinked: 0,
        sessionsFailed: 0,
        unscheduled: 0,
        status: 'not_synced',
        pending: true,
      }),
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      fallbackTemplateUsed: false,
    });
    expect(String(result.data.message)).toContain('Plan created!');
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12, ['outlook']);
    expect(mockBuildSharedDecisionContext).toHaveBeenCalledWith('triathlon', 12, 12);
    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: 'Sunday',
      sharedDecisionContext: '<shared>context</shared>',
      training: { derivedSignals: [{ signalType: 'recovery_state' }] },
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 3,
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      longWorkoutDay: 'Sunday',
      notes: 'keep knees happy',
      currentReadiness: { score: 76 },
      startDate: '2026-04-20',
    }));
    // F6 stronger guarantee: generation no longer invokes the destructive
    // cancellation saga. The persister receives the predecessor snapshot and
    // owns supersede + activation + outbox in one transaction.
    expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput).toMatchObject({
      replaceExistingActivePlan: true,
      expectedActivePlanIds: [],
    });
    expect(persistInput.busyWindows).toEqual([
      expect.objectContaining({ title: 'Fixed meeting' }),
    ]);
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      preferredTime: '12:00',
      preferredCardioTime: '07:00',
      preferredStrengthTime: '12:30',
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 3,
      longWorkoutDay: ' Sunday ',
      notes: '  keep knees happy  ',
      startPolicy: 'next_full_week',
    });
  });

  it('reports strength targets from the final repaired schedule when requested strength exceeds the day budget', async () => {
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      ...makePlan('Strength Plan'),
      sport: 'gym',
      weeks: [{ weekNumber: 1, focus: 'base', intensityPct: 70, sessions: [] }],
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'strength',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 5,
    }));
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'strength',
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });
  });

  it('derives reported strength targets from the final explicit run-plus-strength schedule', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Running with strength support',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'running',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'running',
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 5,
    });
  });

  it('reports sessionsPerWeek as distinct scheduled training days, not modality totals', async () => {
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Two-a-day Headline Days Plan',
      sport: 'running',
      weeks: [
        {
          weekNumber: 1,
          focus: 'base',
          intensityPct: 70,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'run', title: 'Run 1', durationMinutes: 45 },
            { dayOfWeek: 'Monday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
            { dayOfWeek: 'Tuesday', sessionType: 'run', title: 'Run 2', durationMinutes: 45 },
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 3', durationMinutes: 45 },
            { dayOfWeek: 'Thursday', sessionType: 'gym', title: 'Strength 2', durationMinutes: 45, exercises: [{ name: 'Hinge' }] },
            { dayOfWeek: 'Friday', sessionType: 'run', title: 'Run 4', durationMinutes: 60 },
          ],
        },
      ],
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Running with two-a-day support',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 4,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'running',
      twoADayPreference: 'preferred',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 4,
      strengthSessionsPerWeek: 2,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 5,
      runSessionsPerWeek: 4,
      strengthSessionsPerWeek: 2,
    });
  });

  it('reports zero weekly targets when every generated session is unschedulable', async () => {
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'All Unschedulable Plan',
      sport: 'hybrid',
      weeks: [
        {
          weekNumber: 1,
          focus: 'blocked',
          intensityPct: 40,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'run', title: 'Dropped Run', durationMinutes: 45, scheduleState: 'unscheduled' },
            { dayOfWeek: 'Tuesday', sessionType: 'ride', title: 'Deferred Ride', durationMinutes: 60, scheduleState: 'deferred' },
            { dayOfWeek: 'Wednesday', sessionType: 'swim', title: 'Canceled Swim', durationMinutes: 35, scheduleState: 'canceled' },
            { dayOfWeek: 'Thursday', sessionType: 'rest', title: 'Rest Day', durationMinutes: 0 },
          ],
        },
      ],
    });
    mockFinalizeGeneratedTrainingPlanForPersistence.mockImplementation((input: any) => ({
      ...input,
      planData: {
        ...input.planData,
        weeks: input.planData.weeks.map((week: any) => ({
          ...week,
          sessions: week.sessions.map((session: any) => ({
            ...session,
            scheduleState: 'unscheduled',
          })),
        })),
      },
    }));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Blocked hybrid week',
      sessionsPerWeek: 4,
      runSessionsPerWeek: 2,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 1,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 0,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 0,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 0,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 0,
    });
  });

  it('keeps the raw partial-multisport target when the final route plan contains only swim and strength', async () => {
    const finalSessions = [
      { dayOfWeek: 'Monday', sessionType: 'swim', title: 'Swim 1', durationMinutes: 40 },
      { dayOfWeek: 'Tuesday', sessionType: 'swim', title: 'Swim 2', durationMinutes: 40 },
      { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45 },
      { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Strength 2', durationMinutes: 45 },
    ];
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      if (questionnaireId === 'triathlon-running') return { currentMileage: 35 };
      if (questionnaireId === 'triathlon-gym') {
        return { equipment_access: 'Full gym', session_duration_minutes: 45 };
      }
      return null;
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Partial Multisport Plan',
      sport: 'triathlon',
      weeks: [{
        weekNumber: 1,
        sessions: [
          { dayOfWeek: 'Monday', sessionType: 'swim', title: 'Swim 1', durationMinutes: 40 },
          { dayOfWeek: 'Tuesday', sessionType: 'swim', title: 'Swim 2', durationMinutes: 40 },
          { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 1', durationMinutes: 40 },
          { dayOfWeek: 'Thursday', sessionType: 'ride', title: 'Ride 1', durationMinutes: 50 },
          { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45 },
          { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Strength 2', durationMinutes: 45 },
        ],
      }],
    });
    mockFinalizeGeneratedTrainingPlanForPersistence.mockImplementation((input: any) => ({
      ...input,
      planData: {
        ...input.planData,
        weeks: [{ weekNumber: 1, sessions: finalSessions }],
      },
    }));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Balanced triathlon support',
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    expect((result as any).data.volumeShortfalls).toContainEqual(expect.objectContaining({
      kind: 'active',
      requested: 6,
      achieved: 4,
      reason: 'no_available_day',
    }));
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson).volumeShortfalls).toEqual(
      (result as any).data.volumeShortfalls,
    );
  });

  it.each([
    ['zero weeks', []],
    ['one zero-session week', [{ weekNumber: 1, sessions: [] }]],
  ])('reports realized-zero targets for %s and keeps preview/create/persistence shortfalls aligned', async (_label, weeks) => {
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Empty Engine Plan',
      sport: 'running',
      weeks,
    });
    const input = {
      userId: 12,
      tenantId: 12,
      objective: 'Running plan with no engine rows',
      sessionsPerWeek: 3,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'running' as const,
    };

    const preview = await generateTrainingPlanForUser({ ...input, previewOnly: true });
    const created = await generateTrainingPlanForUser(input);

    expect(preview.status).toBe('preview');
    expect(created.status).toBe('created');
    expect((preview as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 0,
      runSessionsPerWeek: 0,
      strengthSessionsPerWeek: 0,
    });
    expect((created as any).data.weeklyTargets).toEqual((preview as any).data.weeklyTargets);
    expect((created as any).data.volumeShortfalls).toEqual((preview as any).data.volumeShortfalls);

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    const preferences = JSON.parse(persistInput.preferencesJson);
    expect(preferences).toMatchObject({
      sessionsPerWeek: 0,
      runSessionsPerWeek: 0,
      strengthSessionsPerWeek: 0,
    });
    expect(preferences.volumeShortfalls).toEqual((created as any).data.volumeShortfalls);
  });

  it('derives triathlon zero bike and swim floors without inventing missing run sessions', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Olympic triathlon',
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 0,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    // Stronger F10 guarantee: realized targets describe only engine-authored
    // rows; the original six-day ask remains explicit under requestedTargets.
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 3,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 1,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'triathlon',
      requestedTargets: {
        sessionsPerWeek: 6,
        runSessionsPerWeek: 0,
        bikeSessionsPerWeek: 0,
        swimSessionsPerWeek: 0,
        strengthSessionsPerWeek: 1,
      },
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 3,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 1,
      strengthSessionsPerWeek: 1,
    });
  });

  it('derives weekly targets from finalized week-two counts when week one is unscheduled', async () => {
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Midweek Finalized Plan',
      sport: 'running',
      weeks: [
        {
          weekNumber: 1,
          focus: 'start-week',
          intensityPct: 65,
          sessions: [
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 1', durationMinutes: 45 },
            { dayOfWeek: 'Thursday', sessionType: 'run', title: 'Run 2', durationMinutes: 45 },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Strength 1', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
            { dayOfWeek: 'Saturday', sessionType: 'gym', title: 'Strength 2', durationMinutes: 45, exercises: [{ name: 'Hinge' }] },
          ],
        },
        {
          weekNumber: 2,
          focus: 'steady-state',
          intensityPct: 70,
          sessions: [
            { dayOfWeek: 'Monday', sessionType: 'run', title: 'Run 1', durationMinutes: 45 },
            { dayOfWeek: 'Wednesday', sessionType: 'run', title: 'Run 2', durationMinutes: 45 },
            { dayOfWeek: 'Saturday', sessionType: 'run', title: 'Run 3', durationMinutes: 60 },
            { dayOfWeek: 'Friday', sessionType: 'gym', title: 'Strength', durationMinutes: 45, exercises: [{ name: 'Squat' }] },
          ],
        },
      ],
    });
    mockFinalizeGeneratedTrainingPlanForPersistence.mockImplementation((input: any) => ({
      ...input,
      planData: {
        ...input.planData,
        weeks: input.planData.weeks.map((week: any) => (
          week.weekNumber === 1
            ? {
                ...week,
                sessions: week.sessions.map((session: any) => ({
                  ...session,
                  scheduleState: 'unscheduled',
                })),
              }
            : week
        )),
      },
    }));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Running after a mid-week start',
      startDate: '2026-04-29',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'running',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.planData.weeks[0].sessions.every((session: any) => session.scheduleState === 'unscheduled')).toBe(true);
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 4,
      runSessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 4,
      runSessionsPerWeek: 3,
      strengthSessionsPerWeek: 1,
    });
  });

  it('reports a reduced modality target when finalization unschedules that modality in every week', async () => {
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Triathlon Finalized Plan',
      sport: 'hybrid',
      weeks: [1, 2].map((weekNumber) => ({
        weekNumber,
        focus: 'base',
        intensityPct: 70,
        sessions: [
          { dayOfWeek: 'Monday', sessionType: 'run', title: `Run ${weekNumber}`, durationMinutes: 45 },
          { dayOfWeek: 'Wednesday', sessionType: 'ride', title: `Ride ${weekNumber}`, durationMinutes: 60 },
          { dayOfWeek: 'Thursday', sessionType: 'swim', title: `Swim ${weekNumber}`, durationMinutes: 35 },
          { dayOfWeek: 'Friday', sessionType: 'gym', title: `Strength ${weekNumber}`, durationMinutes: 45, exercises: [{ name: 'Split Squat' }] },
        ],
      })),
    });
    mockFinalizeGeneratedTrainingPlanForPersistence.mockImplementation((input: any) => ({
      ...input,
      planData: {
        ...input.planData,
        weeks: input.planData.weeks.map((week: any) => ({
          ...week,
          sessions: week.sessions.map((session: any) => (
            session.sessionType === 'swim'
              ? { ...session, scheduleState: 'unscheduled' }
              : session
          )),
        })),
      },
    }));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Olympic triathlon',
      sessionsPerWeek: 6,
      runSessionsPerWeek: 1,
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      bikeSessionsPerWeek: 1,
      swimSessionsPerWeek: 0,
      strengthSessionsPerWeek: 1,
    });
  });

  it('pauses generated sessions before persistence when structured safety guardrail blocks training', async () => {
    config.coaching.trainingSafetyGuardrailsEnabled = true;
    mockGetLatestHealthSignal.mockReturnValue({
      id: 1,
      user_id: 12,
      tenant_id: 12,
      date: '2026-04-18',
      pain_score: null,
      pain_location: null,
      illness_symptoms_json: JSON.stringify(['chest_pain']),
      injury_status: null,
      menstrual_status: null,
      energy_availability_risk: null,
      source: 'structured_intake',
      consent_scope: 'illness',
      created_at: '2026-04-18T10:00:00.000Z',
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General fitness',
    });

    expect(result.status).toBe('created');
    expect(mockGetLatestHealthSignal).toHaveBeenCalledWith(12, 12, expect.any(String), { maxAgeDays: 14 });
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.planData.weeks[0].sessions[0]).toMatchObject({
      sessionType: 'rest',
      title: 'Safety pause',
      durationMinutes: 0,
      scheduleState: 'deferred',
    });
    expect(persistInput.planData.weeks[0].sessions[0].scheduleReason).toMatch(/consult a qualified healthcare professional/i);
    expect(result.data).toMatchObject({
      trainingSafety: {
        status: 'blocked',
        reasonCode: 'medical_referral',
      },
    });
    expect(result.data.warnings).toContainEqual(expect.objectContaining({
      code: 'safety_guardrail_blocked',
    }));
  });

  it('continues generation when the bounded safety lookup returns no fresh health signal', async () => {
    config.coaching.trainingSafetyGuardrailsEnabled = true;
    mockGetLatestHealthSignal.mockReturnValue(null);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General fitness',
    });

    expect(result.status).toBe('created');
    expect(mockGetLatestHealthSignal).toHaveBeenCalledWith(12, 12, expect.any(String), { maxAgeDays: 14 });
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.planData.weeks[0].sessions[0]).toMatchObject({
      sessionType: 'run',
      durationMinutes: 45,
    });
    expect(persistInput.planData.weeks[0].sessions[0].title).toMatch(/run/i);
    expect(result.data.trainingSafety).toBeNull();
  });

  it('skips route-level equipment mutation when coach-kernel equipment authority is enabled', async () => {
    config.coaching.coachKernelEquipmentAuthorityEnabled = true;
    const equipmentDecisionReason = {
      code: 'equipment_conservative_default',
      text: 'I used bodyweight-safe options because your available equipment is unknown.',
      severity: 'notice',
      affectedEntity: { type: 'week' },
      sourceConstraint: { type: 'equipment', label: 'unknown equipment' },
      evidence: ['equipment_missing'],
    };
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({
      equipmentProfile: 'bodyweight',
      summary: 'Bodyweight-safe default',
      promptBlock: '- bodyweight safe',
      authority: 'coach_kernel',
      canonicalProfile: {
        profileId: 'equipment-vocabulary-v1:unknown_conservative',
        bucket: 'bodyweight',
        items: ['bodyweight', 'floor_space', 'mobility_mat'],
        confidence: 'unknown',
        source: 'default',
        matchedAliases: [],
        summary: 'Bodyweight-safe default',
        decisionReasons: [equipmentDecisionReason],
      },
      decisionReasons: [equipmentDecisionReason],
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General fitness',
    });

    expect(result.status).toBe('created');
    expect(mockBuildTrainingEquipmentAdaptation).toHaveBeenCalledWith(expect.objectContaining({
      conservativeUnknown: true,
    }));
    expect(mockAdaptTrainingPlanToAvailableEquipment).not.toHaveBeenCalled();
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.equipmentProfile).toBe('bodyweight');
    expect(persistInput.planData.decisionReasons).toContainEqual(expect.objectContaining({
      code: 'equipment_conservative_default',
    }));
    expect(result.data.decisionReasons).toContainEqual(expect.objectContaining({
      code: 'equipment_conservative_default',
    }));
  });

  it('resolves default plan starts to the next full training week unless today is requested', () => {
    expect(resolveTrainingPlanStartDate(new Date('2026-04-17T10:00:00.000Z'), 'next_full_week')).toBe('2026-04-20');
    expect(resolveTrainingPlanStartDate(new Date('2026-04-17T10:00:00.000Z'), 'today')).toBe('2026-04-17');
    expect(resolveTrainingPlanStartDate(new Date('2026-04-20T10:00:00.000Z'), 'next_full_week')).toBe('2026-04-20');
    expect(resolveTrainingPlanStartDate(new Date('2026-06-15T08:00:00.000Z'), 'today')).toBe('2026-06-15');
    expect(resolveTrainingPlanStartDate(new Date('2026-06-14T20:56:00.000Z'), 'today')).toBe('2026-06-15');
  });

  it('passes Monday June 15 2026 through as the plan start when iOS asks for today', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-15T08:00:00.000Z'));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      startPolicy: 'today',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-06-15',
    }));
  });

  it('rolls Sunday June 14 2026 today requests to Monday to avoid an empty first week', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-14T20:56:00.000Z'));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      startPolicy: 'today',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 0,
      strengthSessionsPerWeek: 5,
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-06-15',
      sessionsPerWeek: 5,
      runSessionsPerWeek: 0,
      strengthSessionsPerWeek: 5,
    }));
  });

  it('honors the internal planner clock override for staging smoke runs', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      startPolicy: 'today',
      plannerNow: '2026-06-15T08:00:00+01:00',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2026-06-15',
    }));
  });

  it('persists one immutable user-zone schedule across the generation pipeline', async () => {
    const schedulingTimezone = 'America/Los_Angeles';
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      startPolicy: 'today',
      plannerNow: '2026-06-16T00:30:00.000Z',
      schedulingTimezone,
    });

    // Stronger guarantee: generation resolves "today" once in the trusted
    // user zone and persists that same zone for every later schedule rewrite.
    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.data.resolvedStartDate).toBe('2026-06-15');
    }
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.schedulingTimezone).toBe(schedulingTimezone);
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({ schedulingTimezone });
  });

  // Rerun-4 R3: iOS derives the week count from "today" while the
  // engine anchors at next Monday, so a 16-week marathon request made
  // mid-week overshot the race by days and lint-blocked the wizard.
  // The clamp mirrors the linter (planDays <= daysThroughRace, race
  // day inclusive) so a clamped duration always passes it.
  it('clamps the requested duration to the largest whole-week count ending by race day', () => {
    // Exact rerun-4 repro: Mon 2026-06-15 → race Fri 2026-10-02 is a
    // 110-day window; 16 weeks (112 days) overshoots, 15 weeks fits.
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-10-02',
    })).toBe(15);
    // Already-fitting requests are untouched.
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 15,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-10-02',
    })).toBe(15);
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 8,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-10-02',
    })).toBe(8);
    // No race date / malformed / race-before-start / sub-week windows
    // pass through unchanged and stay with the linter.
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: null,
    })).toBe(16);
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: 'not-a-date',
    })).toBe(16);
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-06-01',
    })).toBe(16);
    expect(clampTrainingPlanDurationWeeksToRaceDate({
      requestedDurationWeeks: 16,
      startDateIso: '2026-06-15',
      raceDateIso: '2026-06-18',
    })).toBe(16);
  });

  it('generates an event-based plan with the clamped duration instead of lint-blocking (rerun-4 R3)', async () => {
    vi.useFakeTimers();
    // Friday 2026-06-12 in Europe/Lisbon → start resolves to Monday 2026-06-15.
    vi.setSystemTime(new Date('2026-06-12T10:00:00.000Z'));
    try {
      const result = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 12,
        objective: 'Marathon',
        goalMode: 'event_based',
        raceDate: '2026-10-02',
        durationWeeks: 16,
      });

      expect(result.status).toBe('created');
      expect(result.durationWeeks).toBe(15);
      expect(result.data.resolvedStartDate).toBe('2026-06-15');
      const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
      expect(persistInput.durationWeeks).toBe(15);
      expect(persistInput.endDate).toBe('2026-09-28');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a valid future race date override continuous mode and discloses the decision (F12)', async () => {
    vi.useFakeTimers();
    // Friday 2026-06-12 in Europe/Lisbon -> start resolves to Monday
    // 2026-06-15. Sixteen weeks overshoots the future race; fifteen fits.
    vi.setSystemTime(new Date('2026-06-12T10:00:00.000Z'));
    try {
      const result = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 12,
        objective: 'Lisbon Marathon',
        goalMode: 'continuous',
        raceDate: '2026-10-02',
        durationWeeks: 16,
      });

      expect(result.status).toBe('created');
      expect(result.durationWeeks).toBe(15);
      expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
        goalMode: 'event_based',
        raceDate: '2026-10-02',
        durationWeeks: 15,
      }));
      expect(mockLintGeneratedTrainingPlanPreflight).toHaveBeenCalledWith(expect.objectContaining({
        goalMode: 'event_based',
        isRaceSpecific: true,
        raceDate: '2026-10-02',
        durationWeeks: 15,
      }));

      const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
      expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
        goalMode: 'event_based',
        raceDate: '2026-10-02',
      });
      expect(persistInput.planData.decisionReasons).toContainEqual(expect.objectContaining({
        code: 'race_date_implies_event_based',
        before: { goalMode: 'continuous' },
        after: { goalMode: 'event_based' },
      }));
      expect(result.data).toMatchObject({
        durationWeeks: 15,
        goalMode: 'event_based',
        raceDate: '2026-10-02',
      });
      expect(result.data.decisionReasons).toContainEqual(expect.objectContaining({
        code: 'race_date_implies_event_based',
        severity: 'notice',
        before: { goalMode: 'continuous' },
        after: { goalMode: 'event_based' },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('discloses the race-date mode override on non-mutating previews (F12)', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      goalMode: 'continuous',
      raceDate: '2026-10-02',
      durationWeeks: 8,
      previewOnly: true,
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    expect(result.status).toBe('preview');
    if (result.status !== 'preview') return;
    expect(result.data.goalMode).toBe('event_based');
    expect(result.data.decisionReasons).toContainEqual(expect.objectContaining({
      code: 'race_date_implies_event_based',
      before: { goalMode: 'continuous' },
      after: { goalMode: 'event_based' },
    }));
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('binds create to the exact signed preview candidate before persistence', async () => {
    const contextFingerprint = 'c'.repeat(64);
    const request = {
      userId: 12,
      tenantId: 12,
      objective: 'General training consistency',
      durationWeeks: 4,
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      plannerNow: '2026-08-05T12:00:00.000Z',
    };
    const preview = await generateTrainingPlanForUser({
      ...request,
      previewOnly: true,
      previewContextFingerprint: contextFingerprint,
    });

    expect(preview.status).toBe('preview');
    if (preview.status !== 'preview') return;
    expect(preview.data.previewToken).toEqual(expect.any(String));
    const validatedPreview = validateTrainingPlanPreviewToken(preview.data.previewToken, {
      userId: 12,
      tenantId: 12,
      now: new Date('2026-08-05T12:01:00.000Z'),
    });
    expect(validatedPreview.ok).toBe(true);
    if (!validatedPreview.ok) return;

    // Same trusted/request context, different finalized candidate. The
    // compatibility endpoint reruns the deterministic engine, so this fence
    // is what prevents calendar/engine drift from silently creating a plan
    // other than the one the athlete reviewed.
    mockBuildCoachKernelTrainingPlan.mockImplementation((input: any) => ({
      ...makePlanFromKernelInput(input),
      planName: 'Changed after preview',
    }));
    mockPersistGeneratedTrainingPlan.mockClear();

    await expect(generateTrainingPlanForUser({
      ...request,
      expectedPreviewCandidateFingerprint: validatedPreview.payload.candidateFingerprint,
    })).rejects.toMatchObject({
      code: 'TRAINING_PLAN_PREVIEW_STALE',
      reason: 'candidate_changed',
    });
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('rejects an explicit same-day race date before invoking the planner', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Race day is already here',
      goalMode: 'continuous',
      raceDate: '2026-06-12',
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    // F12 stronger guarantee: direct/internal callers receive the same
    // strict-future decision as both REST boundaries.
    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      validationError: { code: 'PAST_RACE_DATE', field: 'raceDate' },
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('blocks a strictly-future race that precedes the resolved plan start (F12)', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Weekend race preparation',
      goalMode: 'continuous',
      // Friday -> the default next_full_week anchor is Monday 2026-06-15.
      // Saturday is strictly future relative to the request, but already over
      // before week 1. F12 must not persist an event-based plan that silently
      // drops this race from phase generation.
      raceDate: '2026-06-13',
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    expect(result.status).toBe('needs_profile');
    expect(result.data).toMatchObject({
      needsProfile: true,
      validationError: {
        code: 'RACE_DATE_BEFORE_PLAN_START',
        field: 'raceDate',
        raceDate: '2026-06-13',
        resolvedStartDate: '2026-06-15',
      },
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('discloses an unspecified mode as null when a future race date selects event mode', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      raceDate: '2026-10-02',
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.data.goalMode).toBe('event_based');
    expect(result.data.decisionReasons).toContainEqual(expect.objectContaining({
      code: 'race_date_implies_event_based',
      before: { goalMode: null },
      after: { goalMode: 'event_based' },
    }));
  });

  it('does not fabricate an override when the request is already event-based', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      goalMode: 'event_based',
      raceDate: '2026-10-02',
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.data.goalMode).toBe('event_based');
    expect(result.data.decisionReasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'race_date_implies_event_based' }),
    ]));
  });

  it('persists the requested training calendar source for generation and follow-up sync', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      calendarSource: 'google',
    });

    expect(result.status).toBe('created');
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.calendarSource).toBe('google');
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      trainingCalendarSource: 'google',
    });
  });

  it('returns a non-mutating preview using the selected calendar source', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      calendarSource: 'outlook',
      previewOnly: true,
    });

    expect(result.status).toBe('preview');
    if (result.status === 'preview') {
      expect(result.data).toMatchObject({
        status: 'preview',
        calendarSource: 'outlook',
        phaseRoadmap: [
          expect.objectContaining({
            weekNumber: 1,
            phase: 'base',
          }),
        ],
      });
      expect(result.data.totalSessions).toBeGreaterThan(0);
      expect(result.data.phaseRoadmap[0].sessionCount).toBeGreaterThan(0);
      expect(result.data.trainingLearningPath?.weeklyPath[0]?.phaseGoal).toBeTruthy();
      expect(result.data.phaseRoadmap[0].weeklyLearningFocus).toBeTruthy();
    }
    expect(mockGetEvents).toHaveBeenCalledWith(expect.any(String), expect.any(String), 12, ['outlook']);
    expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('does not synthesize run volume for pure strength preview requests', async () => {
    mockBuildTrainingEquipmentAdaptation.mockReturnValue({
      equipmentProfile: 'dumbbells',
      canonicalProfile: { items: ['dumbbells'] },
    });
    mockBuildCoachKernelTrainingPlan.mockReturnValue({
      planName: 'Dumbbell Strength',
      sport: 'gym',
      weeks: [1, 2, 3, 4].map((weekNumber) => ({
        weekNumber,
        focus: weekNumber === 4 ? 'deload' : 'base',
        intensityPct: weekNumber === 4 ? 55 : 70,
        sessions: [],
      })),
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Beginner strength plan, dumbbells only',
      durationWeeks: 4,
      sessionsPerWeek: 3,
      strengthSessionsPerWeek: 3,
      previewOnly: true,
      calendarSource: null,
    });

    expect(result.status).toBe('preview');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Beginner strength plan, dumbbells only',
      sessionsPerWeek: 3,
      runSessionsPerWeek: undefined,
      strengthSessionsPerWeek: 3,
    }));
    if (result.status === 'preview') {
      expect(result.data.weeklyTargets).toMatchObject({
        sessionsPerWeek: 3,
        runSessionsPerWeek: null,
        strengthSessionsPerWeek: 3,
      });
      expect(result.data.totalSessions).toBe(12);
      expect(result.data.phaseRoadmap).toHaveLength(4);
      expect(result.data.phaseRoadmap.every((week) => week.sessionCount === 3)).toBe(true);
      expect(result.data.trainingLearningPath?.measurableOutcomes).toEqual(expect.arrayContaining([
        'Session completion and skip rate',
        'Post-session RPE, soreness, and pain feedback',
      ]));
      expect(result.data.blockers).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'progression_model_integrity' }),
      ]));
    }
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('passes cycling and swim profile modules into generation and preflight context', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      if (questionnaireId === 'triathlon-gym') return { equipment_access: 'Full gym' };
      if (questionnaireId === 'triathlon-running') return { weekly_mileage_km: 28, easy_pace_min_per_km: '5:45' };
      if (questionnaireId === 'triathlon-cycling') {
        return {
          ftp_watts: 235,
          weekly_hours: '3-6 hours',
          target_event: 'Triathlon bike leg',
          preferred_training_days: ['Saturday'],
          blocked_days: ['Friday'],
        };
      }
      if (questionnaireId === 'triathlon-swim') {
        return {
          pool_access: 'Yes',
          sessions_per_week: '2',
          primary_stroke: 'Freestyle',
          preferred_training_days: ['Wednesday'],
          blocked_days: ['Sunday'],
        };
      }
      return null;
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Sprint triathlon plan',
      durationWeeks: 4,
      bikeSessionsPerWeek: 2,
      swimSessionsPerWeek: 2,
      previewOnly: true,
      calendarSource: null,
    });

    expect(result.status).toBe('preview');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      runProfile: expect.objectContaining({
        ftp_watts: 235,
        cycling_weekly_hours: '3-6 hours',
        pool_access: 'Yes',
        swim_sessions_per_week: '2',
        preferred_training_days: ['Saturday', 'Wednesday'],
        blocked_days: ['Friday', 'Sunday'],
      }),
    }));
    expect(mockLintGeneratedTrainingPlanPreflight).toHaveBeenCalledWith(expect.objectContaining({
      athleteProfiles: expect.objectContaining({
        cyclingProfile: expect.objectContaining({ ftp_watts: 235 }),
        swimProfile: expect.objectContaining({ pool_access: 'Yes' }),
      }),
    }));
  });

  it('blocks deterministic fallback persistence when the coach kernel fails', async () => {
    mockBuildCoachKernelTrainingPlan.mockImplementation(() => {
      throw new Error('kernel unavailable');
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General running consistency',
      durationWeeks: 4,
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 1,
      goalMode: 'continuous',
      raceDate: '2026-10-02',
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    expect(result.status).toBe('plan_quality_blocked');
    expect(result.data.fallbackTemplateUsed).toBe(true);
    expect(String(result.data.message)).toContain('did not save it');
    expect(result.data.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'fallback_requires_review' }),
    ]));
    expect(result.data.decisionReasons).toContainEqual(expect.objectContaining({
      code: 'race_date_implies_event_based',
    }));
    expect(mockBuildDeterministicTrainingPlan).toHaveBeenCalledWith(
      'General running consistency',
      4,
      expect.objectContaining({
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 1,
      }),
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 12, objective: 'General running consistency' }),
      expect.stringContaining('Coach-kernel training plan generation unavailable'),
    );
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('continues plan generation when calendar reads are unavailable', async () => {
    mockGetEvents.mockRejectedValue(new Error('calendar offline'));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build consistency',
    });

    expect(result.status).toBe('created');
    expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      busyWindows: [],
    }));
  });

  it('does not replace profile availability with synthetic open-day windows when the calendar is empty', async () => {
    config.coaching.trainingCalendarCapacityKernelEnabled = true;
    mockGetEvents.mockResolvedValue([]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Travel-safe running and strength',
      sessionsPerWeek: 3,
      runSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
      notes: 'Every session must fit a 35-minute window.',
      previewOnly: true,
    });

    expect(result.status).toBe('preview');
    // Stronger guarantee: an empty provider calendar adds no capacity facts.
    // The kernel must retain the user's profile-derived duration/day windows
    // instead of replacing them with fabricated 05:00-21:00 open days.
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      notes: 'Every session must fit a 35-minute window.',
      capacityWindows: null,
    }));
  });

  // training-expert-coach-knowledge-engine (2026-05-03):
  // P0-C — calendar fetch fail-safe. When `getEvents` errors we still
  // generate a plan (so a transient OAuth blip doesn't block the user)
  // but mark `calendarFetchDegraded: true` and emit an explicit
  // `calendar_fetch_degraded` warning so iOS can render a "review your
  // week before trusting it" banner. Historical bug: the silent empty
  // busyWindows scheduled sessions on top of meetings.
  it('marks the response as calendarFetchDegraded when getEvents throws', async () => {
    mockGetEvents.mockRejectedValue(new Error('OAuth token expired'));

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build consistency',
    });

    expect(result.status).toBe('created');
    expect((result as any).data.calendarFetchDegraded).toBe(true);
    expect((result as any).data.calendarFetchError).toBe('OAuth token expired');
    expect((result as any).data.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'calendar_fetch_degraded' }),
      ]),
    );
  });

  it('blocks failed plan-linter preflight before cancellation or persistence', async () => {
    mockLintGeneratedTrainingPlanPreflight.mockReturnValueOnce({
      status: 'fail',
      blockers: [
        {
          ruleId: 'equipment_compatibility',
          severity: 'blocker',
          message: 'Barbell work is incompatible with a bodyweight-only profile.',
          affectedSessions: [{ weekNumber: 1, dayOfWeek: 'monday', title: 'Lower Body Strength' }],
        },
      ],
      warnings: [],
      suggestedFixes: [
        {
          findingRuleId: 'equipment_compatibility',
          action: 'Substitute barbell work for bodyweight variants.',
        },
      ],
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build consistency',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      goalMode: 'continuous',
      raceDate: '2026-10-02',
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    expect(result.status).toBe('plan_quality_blocked');
    if (result.status === 'plan_quality_blocked') {
      expect(result.data.planLint.status).toBe('fail');
      expect(result.data.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'lint_blocker_equipment_compatibility',
            message: 'Barbell work is incompatible with a bodyweight-only profile.',
          }),
        ]),
      );
      expect(result.data.message).toContain('blocked this plan before saving');
      expect(result.data.decisionReasons).toContainEqual(expect.objectContaining({
        code: 'race_date_implies_event_based',
      }));
    }
    expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'training_plan_quality_gate.blocked_pre_persist',
        blockerRuleIds: ['equipment_compatibility'],
      }),
      expect.stringContaining('blocked plan before cancellation/persistence'),
    );
  });

  it('blocks event-based race-style plans when the race date is missing', async () => {
    mockLintGeneratedTrainingPlanPreflight.mockImplementationOnce((input: any) => {
      expect(input).toMatchObject({
        objective: 'Lisbon Marathon',
        goalMode: 'event_based',
        raceDate: null,
        isRaceSpecific: true,
      });
      return {
        status: 'fail',
        blockers: [
          {
            ruleId: 'race_specific_plan_requires_race_date',
            severity: 'blocker',
            message: 'Event-based plans need a race date.',
            affectedSessions: [],
          },
        ],
        warnings: [],
        suggestedFixes: [],
      };
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      goalMode: 'event_based',
      raceDate: null,
    });

    expect(result.status).toBe('plan_quality_blocked');
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  it('allows continuous marathon-style planning without forcing an event day', async () => {
    mockLintGeneratedTrainingPlanPreflight.mockImplementationOnce((input: any) => {
      expect(input).toMatchObject({
        objective: 'Lisbon Marathon',
        goalMode: 'continuous',
        raceDate: null,
        isRaceSpecific: false,
      });
      return {
        status: 'pass',
        blockers: [],
        warnings: [],
        suggestedFixes: [],
      };
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      goalMode: 'continuous',
      raceDate: null,
    });

    expect(result.status).toBe('created');
    expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['past', '2026-06-11'],
    ['same-day', '2026-06-12'],
  ])('does not let a %s profile race date override continuous mode', async (_label, profileRaceDate) => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      if (questionnaireId === 'triathlon-running') {
        return {
          currentMileage: 35,
          target_race: 'Historical race',
          target_race_date: profileRaceDate,
        };
      }
      if (questionnaireId === 'triathlon-gym') return { equipment_access: 'Full gym' };
      return null;
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Maintain running consistency',
      goalMode: 'continuous',
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    // F12 stronger guarantee: only a future profile date has authority to
    // switch modes. Expired profile metadata is removed before both phase
    // generation and linting so it cannot manufacture taper semantics.
    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      goalMode: 'continuous',
      raceDate: null,
      runProfile: expect.not.objectContaining({
        target_race_date: profileRaceDate,
      }),
    }));
    expect(mockLintGeneratedTrainingPlanPreflight).toHaveBeenCalledWith(expect.objectContaining({
      goalMode: 'continuous',
      raceDate: null,
      isRaceSpecific: false,
    }));
    expect((result as any).data.decisionReasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'race_date_implies_event_based' }),
    ]));
  });

  it('lets a strictly future profile race date select event mode', async () => {
    mockGetProfile.mockImplementation((_userId: number, questionnaireId: string) => {
      if (questionnaireId === 'fitness') return { experienceLevel: 'Intermediate' };
      if (questionnaireId === 'triathlon-running') {
        return {
          currentMileage: 35,
          target_race: 'Lisbon Marathon',
          target_race_date: '2026-10-02',
        };
      }
      if (questionnaireId === 'triathlon-gym') return { equipment_access: 'Full gym' };
      return null;
    });

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Maintain running consistency',
      goalMode: 'continuous',
      plannerNow: '2026-06-12T10:00:00.000Z',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      goalMode: 'event_based',
      raceDate: '2026-10-02',
      runProfile: expect.objectContaining({ target_race_date: '2026-10-02' }),
    }));
    expect((result as any).data.decisionReasons).toContainEqual(expect.objectContaining({
      code: 'race_date_implies_event_based',
      before: { goalMode: 'continuous' },
      after: { goalMode: 'event_based' },
    }));
  });

  it('does NOT mark calendarFetchDegraded on a normal calendar read', async () => {
    mockGetEvents.mockResolvedValue([]);

    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build consistency',
    });

    expect(result.status).toBe('created');
    expect((result as any).data.calendarFetchDegraded).toBe(false);
    expect((result as any).data.calendarFetchError).toBeUndefined();
    // No `calendar_fetch_degraded` warning surface.
    const warnings = (result as any).data.warnings ?? [];
    const codes = warnings.map((w: any) => w.code);
    expect(codes).not.toContain('calendar_fetch_degraded');
  });

  it('preserves legacy zero-value session fallback semantics', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build consistency',
      sessionsPerWeek: 0,
      strengthSessionsPerWeek: 0,
    });

    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 0,
    }));
  });

  it('normalizes fractional and out-of-range frequency inputs before planning', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Olympic triathlon',
      durationWeeks: 4.4,
      sessionsPerWeek: 4.5,
      runSessionsPerWeek: 2.4,
      bikeSessionsPerWeek: 99,
      swimSessionsPerWeek: 1.6,
      strengthSessionsPerWeek: 1.2,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      durationWeeks: 4,
      sessionsPerWeek: 5,
      runSessionsPerWeek: 2,
      bikeSessionsPerWeek: 7,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
    }));
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 7,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
    });
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 6,
      runSessionsPerWeek: 0,
      bikeSessionsPerWeek: 7,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 1,
    });
  });

  it('bounds durationWeeks and records the generator policy version', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Build consistency',
      durationWeeks: 999,
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      durationWeeks: 52,
    }));
    expect((result as any).data.durationWeeks).toBe(52);
    expect((result as any).data.generatorPolicyVersion).toBe(TRAINING_PLAN_GENERATOR_POLICY_VERSION);
    expect((result as any).data.generationVersionPins).toMatchObject({
      selectorPolicyVersion: 'selector-policy-v2',
      equipmentVocabularyVersion: 'equipment-vocabulary-v1',
      generationPipelineVersion: 'training-generation-pipeline-v1',
    });

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      generatorPolicyVersion: TRAINING_PLAN_GENERATOR_POLICY_VERSION,
      generationVersionPins: expect.objectContaining({
        selectorPolicyVersion: 'selector-policy-v2',
      }),
    });
  });

  it('preserves the exact legacy version-pin shape off and adds identity pins only while active', async () => {
    const scopedKey = 'TRAINING_EXERCISE_IDENTITY_V1_MODE_USER_12';
    const priorMode = process.env[scopedKey];
    try {
      process.env[scopedKey] = 'off';
      const off = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 12,
        objective: 'Build consistency',
      });
      expect(off.status).toBe('created');
      const offPins = (off as any).data.generationVersionPins;
      expect(Object.keys(offPins).sort()).toEqual([
        'catalogVersion',
        'equipmentVocabularyVersion',
        'generationPipelineVersion',
        'sciencePolicyVersion',
        'selectorPolicyVersion',
      ]);
      expect(offPins).not.toHaveProperty('catalogSourceHash');
      expect(mockBuildCoachKernelTrainingPlan.mock.calls.at(-1)?.[0])
        .not.toHaveProperty('exerciseIdentityMode');
      expect(JSON.parse(mockPersistGeneratedTrainingPlan.mock.calls.at(-1)?.[0].preferencesJson)
        .generationVersionPins).toEqual(offPins);

      process.env[scopedKey] = 'active';
      const active = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 12,
        objective: 'Build consistency',
      });
      expect(active.status).toBe('created');
      const activePins = (active as any).data.generationVersionPins;
      expect(activePins).toMatchObject({
        catalogVersion: TRAINING_EXERCISE_IDENTITY_CATALOG_VERSION,
        catalogSourceHash: TRAINING_EXERCISE_IDENTITY_EXPECTED_SOURCE_HASH,
      });
      expect(mockBuildCoachKernelTrainingPlan.mock.calls.at(-1)?.[0])
        .toMatchObject({ exerciseIdentityMode: 'active' });
      expect(Object.keys(activePins).sort()).toEqual([
        'catalogSourceHash',
        'catalogVersion',
        'equipmentVocabularyVersion',
        'generationPipelineVersion',
        'sciencePolicyVersion',
        'selectorPolicyVersion',
      ]);
      expect(JSON.parse(mockPersistGeneratedTrainingPlan.mock.calls.at(-1)?.[0].preferencesJson)
        .generationVersionPins).toEqual(activePins);
    } finally {
      if (priorMode === undefined) delete process.env[scopedKey];
      else process.env[scopedKey] = priorMode;
    }
  });

  it('respects the requested gym volume for English muscle-building goals', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
    });

    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
    }));
  });

  it('passes explicit five-day strength volume through the app-facing marathon generation route', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    });

    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Lisbon Marathon',
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 6,
      strengthSessionsPerWeek: 5,
    });
  });

  it('derives omitted gym-only strength targets from the selected weekly structure', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      trainingPriority: 'strength',
    });

    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'strength',
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
      trainingPriority: 'strength',
    });
  });

  it('does not widen non-gym strength priority into a fake gym-only target', async () => {
    await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General fitness',
      sessionsPerWeek: 5,
      trainingPriority: 'strength',
    });

    expect(mockBuildTrainingPlanCoordination).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
    }));
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'General fitness',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'strength',
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      // Stronger F10 guarantee: the request remains auditable, but two
      // engine-authored strength rows do not become three generic sessions.
      sessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'strength',
      requestedTargets: {
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
      },
    });
  });

  it('persists the effective gym strength target when explicit zero is expanded downstream', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 0,
    });

    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Muscle Building',
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 0,
    }));
    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      sessionsPerWeek: 5,
      strengthSessionsPerWeek: 5,
    });
  });

  it('passes explicit bike and swim targets through the app-facing triathlon route', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Olympic triathlon',
      sessionsPerWeek: 7,
      runSessionsPerWeek: 4,
      bikeSessionsPerWeek: 3,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'triathlon',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Olympic triathlon',
      sessionsPerWeek: 7,
      runSessionsPerWeek: 4,
      bikeSessionsPerWeek: 3,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
      trainingPriority: 'triathlon',
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      runSessionsPerWeek: 4,
      bikeSessionsPerWeek: 3,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
    });
    expect((result as any).data.weeklyTargets).toMatchObject({
      runSessionsPerWeek: 4,
      bikeSessionsPerWeek: 3,
      swimSessionsPerWeek: 2,
      strengthSessionsPerWeek: 2,
    });
  });

  it('round-trips app-facing weekly targets for every selected training priority', async () => {
    const cases = [
      {
        objective: 'Lisbon Marathon',
        trainingPriority: 'running',
        sessionsPerWeek: 6,
        runSessionsPerWeek: 5,
        bikeSessionsPerWeek: 0,
        swimSessionsPerWeek: 0,
        strengthSessionsPerWeek: 1,
      },
      {
        objective: 'Cycling gran fondo',
        trainingPriority: 'cycling',
        sessionsPerWeek: 5,
        runSessionsPerWeek: 0,
        bikeSessionsPerWeek: 4,
        swimSessionsPerWeek: 0,
        strengthSessionsPerWeek: 1,
      },
      {
        objective: 'Open-water swimming',
        trainingPriority: 'swimming',
        sessionsPerWeek: 5,
        runSessionsPerWeek: 0,
        bikeSessionsPerWeek: 0,
        swimSessionsPerWeek: 4,
        strengthSessionsPerWeek: 1,
      },
      {
        objective: 'Sprint triathlon',
        trainingPriority: 'triathlon',
        sessionsPerWeek: 6,
        runSessionsPerWeek: 2,
        bikeSessionsPerWeek: 2,
        swimSessionsPerWeek: 2,
        strengthSessionsPerWeek: 1,
      },
      {
        objective: 'General fitness',
        trainingPriority: 'hybrid',
        sessionsPerWeek: 5,
        runSessionsPerWeek: 2,
        bikeSessionsPerWeek: 1,
        swimSessionsPerWeek: 0,
        strengthSessionsPerWeek: 2,
      },
      {
        objective: 'Muscle Building',
        trainingPriority: 'strength',
        sessionsPerWeek: 5,
        runSessionsPerWeek: 0,
        bikeSessionsPerWeek: 0,
        swimSessionsPerWeek: 0,
        strengthSessionsPerWeek: 5,
      },
    ] as const;

    for (const planCase of cases) {
      const result = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 12,
        objective: planCase.objective,
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: planCase.runSessionsPerWeek,
        bikeSessionsPerWeek: planCase.bikeSessionsPerWeek,
        swimSessionsPerWeek: planCase.swimSessionsPerWeek,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
        trainingPriority: planCase.trainingPriority,
      });

      expect(result.status).toBe('created');
      const lastKernelCall = mockBuildCoachKernelTrainingPlan.mock.calls[
        mockBuildCoachKernelTrainingPlan.mock.calls.length - 1
      ]?.[0];
      expect(lastKernelCall).toMatchObject({
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: planCase.runSessionsPerWeek,
        bikeSessionsPerWeek: planCase.bikeSessionsPerWeek,
        swimSessionsPerWeek: planCase.swimSessionsPerWeek,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
        trainingPriority: planCase.trainingPriority,
      });

      const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[
        mockPersistGeneratedTrainingPlan.mock.calls.length - 1
      ]?.[0];
      expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: planCase.runSessionsPerWeek,
        bikeSessionsPerWeek: planCase.bikeSessionsPerWeek,
        swimSessionsPerWeek: planCase.swimSessionsPerWeek,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
        trainingPriority: planCase.trainingPriority,
      });
      expect((result as any).data.weeklyTargets).toMatchObject({
        sessionsPerWeek: planCase.sessionsPerWeek,
        runSessionsPerWeek: planCase.runSessionsPerWeek,
        bikeSessionsPerWeek: planCase.bikeSessionsPerWeek,
        swimSessionsPerWeek: planCase.swimSessionsPerWeek,
        strengthSessionsPerWeek: planCase.strengthSessionsPerWeek,
      });
    }
  });

  it('forwards explicit goal mode, priority, and race date from the app request', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      sessionsPerWeek: 7,
      strengthSessionsPerWeek: 5,
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      objective: 'Lisbon Marathon',
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
      runProfile: expect.objectContaining({
        currentMileage: 35,
        target_race_date: '2026-10-18',
        target_race: 'Lisbon Marathon',
      }),
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.raceDate).toBe('2026-10-18');
    expect(persistInput.athleteProfiles.runProfile).toEqual(expect.objectContaining({
      target_race_date: '2026-10-18',
    }));
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
    });
    expect((result as any).data).toMatchObject({
      goalMode: 'event_based',
      trainingPriority: 'running',
      raceDate: '2026-10-18',
    });
  });

  it('drops unsupported goal mode and priority before planning', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'General running consistency',
      goalMode: 'race',
      trainingPriority: 'bodybuilding',
    });

    expect(result.status).toBe('created');
    expect(mockBuildCoachKernelTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
      goalMode: null,
      trainingPriority: null,
      raceDate: null,
      runProfile: { currentMileage: 35 },
    }));

    const persistInput = mockPersistGeneratedTrainingPlan.mock.calls[0][0];
    expect(persistInput.raceDate).toBeNull();
    expect(JSON.parse(persistInput.preferencesJson)).toMatchObject({
      goalMode: null,
      trainingPriority: null,
      raceDate: null,
    });
  });

  it('blocks impossible race dates before planning', async () => {
    const result = await generateTrainingPlanForUser({
      userId: 12,
      tenantId: 12,
      objective: 'Lisbon Marathon',
      raceDate: '2026-02-30',
    });

    expect(result.status).toBe('needs_profile');
    expect((result as any).data.validationError).toMatchObject({
      code: 'INVALID_RACE_DATE',
      field: 'raceDate',
    });
    expect(mockBuildCoachKernelTrainingPlan).not.toHaveBeenCalled();
    expect(mockPersistGeneratedTrainingPlan).not.toHaveBeenCalled();
  });

  describe('atomic compatibility replacement (F6)', () => {
    it('passes the exact predecessor snapshot to the transactional persister', async () => {
      mockGetActivePlans.mockReturnValue([
        { id: 902, status: 'active' },
        { id: 901, status: 'active' },
      ]);

      const result = await generateTrainingPlanForUser({
        userId: 12,
        tenantId: 34,
        objective: 'Lisbon Marathon',
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
      });

      expect(result.status).toBe('created');
      expect(mockPersistGeneratedTrainingPlan).toHaveBeenCalledWith(expect.objectContaining({
        replaceExistingActivePlan: true,
        expectedActivePlanIds: [901, 902],
      }));
      // Stronger guarantee than the retired saga: generation never performs
      // provider cancellation, hard-delete, or a separate activation step.
      expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();
      expect(mockDeletePlanHard).not.toHaveBeenCalled();
      expect(mockActivatePendingPlan).not.toHaveBeenCalled();
    });

    it('propagates a transactional replacement failure without cleanup side effects', async () => {
      mockGetActivePlans.mockReturnValue([{ id: 999, status: 'active' }]);
      mockPersistGeneratedTrainingPlan.mockRejectedValueOnce(new Error('injected transaction rollback'));

      await expect(generateTrainingPlanForUser({
        userId: 12,
        tenantId: 34,
        objective: 'Lisbon Marathon',
        sessionsPerWeek: 5,
        strengthSessionsPerWeek: 2,
      })).rejects.toThrow('injected transaction rollback');

      expect(mockCancelTrainingPlanForUser).not.toHaveBeenCalled();
      expect(mockDeletePlanHard).not.toHaveBeenCalled();
      expect(mockActivatePendingPlan).not.toHaveBeenCalled();
    });
  });
});
