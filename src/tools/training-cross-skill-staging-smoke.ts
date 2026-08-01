// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  buildTrainingPlanCoordination,
  type TrainingPlanCoordination,
  type TrainingPlanCoordinationInput,
} from '../services/training-plan-coordination';
import {
  formatTrainingContextForPrompt,
  readTrainingContextAll,
  type TrainingContext,
} from '../services/training-signals';
import type {
  ContentMeshContext,
  CookingMeshContext,
  FinanceMeshContext,
  MeshSignalDraft,
  SecretaryMeshContext,
  TrainingMeshContext,
} from '../services/cross-agent-learning';
import type { SharedDecisionContracts } from '../services/shared-decision-context';
import { findChatActionDefinition } from '../services/chat/registry';
import {
  CROSS_SKILL_EXECUTION_ENV_VAR,
  enforceCrossSkillPreview,
  isCrossSkillExecutionEnabled,
} from '../services/chat/planner/cross-skill-ownership';
import { MANIFEST_ROUTING_MASTER_KILL_ENV_VAR } from '../services/intent-resolution/manifest-routing-flags';
import { splitChatMultiStepRequest } from '../services/chat-multi-step-splitter';
import { routeChatMultiStepSegments } from '../services/chat-segment-router';
import { multiStepPreviewCopy } from '../services/chat/executor/response-copy';
import { executeChatActionPlan } from '../services/chat/executor/plan-executor';
import { makeStep } from '../services/skills/step-builder';
import { crossSkillPlanDeclinedStage } from '../api/routes/chat-pipeline/stages/cross-skill-plan-declined';
import type {
  ChatActionPlan,
  ChatActionPlannerDeps,
  ChatPlannerInput,
  ChatPlanStep,
} from '../services/chat/types';
import type { ChatTurnCtx } from '../api/routes/chat-pipeline/types';

export const DEFAULT_CROSS_SKILL_SMOKE_RESULTS_PATH =
  '.local/release/smoke-evidence/training-cross-skill-staging-latest.md';

type CrossSkillFlow =
  | 'local_fixture_contracts'
  | 'staging_prerequisites'
  | 'phase7_cross_skill_flag_contract'
  | 'secretary_conflict'
  | 'cooking_fueling_gap'
  | 'finance_budget_constraint'
  | 'content_workload'
  | 'training_content_milestone'
  | 'shared_context_scope';

type SmokeStatus = 'pass' | 'fail' | 'blocked';

interface SmokeOperationResult {
  flow: CrossSkillFlow;
  expected: string;
  actual: string;
  status: SmokeStatus;
  evidence: string[];
}

interface SmokePrerequisiteReport {
  ok: boolean;
  missing: string[];
  warnings: string[];
}

interface SmokeReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  userId?: number;
  releaseIdentity: {
    environment: string | null;
    runtimeSha: string | null;
    artifactDigest: string | null;
  };
  prerequisites: SmokePrerequisiteReport;
  operations: SmokeOperationResult[];
  localFixtureOperations: SmokeOperationResult[];
}

interface SmokeHarnessOptions {
  userId?: number;
  runId: string;
  dryRun: boolean;
  now: Date;
  env: NodeJS.ProcessEnv;
}

interface RuntimeCrossSkillReader {
  readTrainingMeshContext(opts: { userId: number; weekStart?: string }): Promise<TrainingMeshContext>;
  readCookingMeshContext(opts: { userId: number; weekStart?: string }): Promise<CookingMeshContext>;
  readFinanceMeshContext(opts: { userId: number; weekStart?: string }): Promise<FinanceMeshContext>;
  readContentMeshContext(opts: { userId: number; weekStart?: string }): Promise<ContentMeshContext>;
  readSecretaryMeshContext(opts: { userId: number; weekStart?: string }): Promise<SecretaryMeshContext>;
  buildSharedDecisionContext(domain: 'triathlon', userId: number): Promise<string>;
  buildSharedDecisionContracts(domain: 'triathlon', userId: number): Promise<SharedDecisionContracts>;
}

interface RuntimeBundle {
  training: TrainingMeshContext;
  cooking: CookingMeshContext;
  finance: FinanceMeshContext;
  content: ContentMeshContext;
  secretary: SecretaryMeshContext;
  sharedDecisionContext: string;
  contracts: SharedDecisionContracts;
  coordination: TrainingPlanCoordination;
  trainingContext: TrainingContext;
}

const WEEK_START = '2026-05-04';
const WEEK_END = '2026-05-10';

export function buildCrossSkillSmokeRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `training-cross-skill-smoke-${stamp}-${random}`;
}

export function evaluateCrossSkillSmokePrerequisites(env: NodeJS.ProcessEnv): SmokePrerequisiteReport {
  const missing: string[] = [];
  const warnings: string[] = [];

  const stagingMode = env.STAGING === 'true' || env.NODE_ENV === 'staging';
  if (!stagingMode) {
    missing.push('STAGING=true or NODE_ENV=staging');
  }

  if (env.NODE_ENV === 'production') {
    missing.push('NODE_ENV must not be production');
  }

  if (env.TRAINING_CROSS_SKILL_STAGING_SMOKE !== '1') {
    missing.push('TRAINING_CROSS_SKILL_STAGING_SMOKE=1');
  }

  if (!parseEnvBoolean(env[CROSS_SKILL_EXECUTION_ENV_VAR])) {
    missing.push(`${CROSS_SKILL_EXECUTION_ENV_VAR}=true`);
  }

  if (parseEnvBoolean(env[MANIFEST_ROUTING_MASTER_KILL_ENV_VAR])) {
    missing.push(`${MANIFEST_ROUTING_MASTER_KILL_ENV_VAR} must be false/unset`);
  }

  if (env.NEXUS_RELEASE_ROLE !== 'staging') {
    missing.push('NEXUS_RELEASE_ROLE=staging');
  }

  if (!/^[a-f0-9]{40}$/.test(env.NEXUS_RELEASE_SHA ?? '')) {
    missing.push('NEXUS_RELEASE_SHA=<full lowercase 40-hex SHA>');
  }

  if (!/^[a-f0-9]{64}$/.test(env.NEXUS_RELEASE_ARTIFACT_SHA256 ?? '')) {
    missing.push('NEXUS_RELEASE_ARTIFACT_SHA256=<full lowercase 64-hex digest>');
  }

  const userId = Number(env.TRAINING_CROSS_SKILL_STAGING_USER_ID);
  if (!Number.isInteger(userId) || userId <= 0) {
    missing.push('TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id>');
  }

  if (!env.DATABASE_PATH) {
    missing.push('DATABASE_PATH=<staging database path>');
  } else if (!/staging|stage|test/i.test(env.DATABASE_PATH) && env.TRAINING_CROSS_SKILL_ALLOW_NON_STAGING_DB !== '1') {
    missing.push('DATABASE_PATH must look like a staging/test database or set TRAINING_CROSS_SKILL_ALLOW_NON_STAGING_DB=1');
  }

  if (env.TRAINING_CROSS_SKILL_ALLOW_NON_STAGING_DB === '1') {
    warnings.push('Non-staging-looking DATABASE_PATH allowed explicitly; verify this is not production.');
  }

  return { ok: missing.length === 0, missing, warnings };
}

/**
 * Phase 7 behavioral proof for the real cross-skill runtime boundaries.
 * This is deliberately provider-free and mutation-free: the synthetic plan
 * reaches the production segment router, ownership transform, grouped preview,
 * declined-stage predicate, and executor confirmation hold with persistence
 * disabled. It never confirms the plan, so no action executor can run.
 *
 * The Training handoff still returns verified_pending, so its ordinary
 * outputRefs must remain absent even while cross-skill execution is enabled.
 */
export async function evaluatePhase7CrossSkillFlagContract(
  env: NodeJS.ProcessEnv,
): Promise<SmokeOperationResult> {
  const trainingPlanCreate = findChatActionDefinition('training', 'training_plan_create');
  const crossSkillEnabled = isCrossSkillExecutionEnabled(env);
  const masterKillEnabled = parseEnvBoolean(env[MANIFEST_ROUTING_MASTER_KILL_ENV_VAR]);
  const ordinaryOutputRefsAbsent = trainingPlanCreate !== null && trainingPlanCreate.outputRefs === undefined;

  try {
    return await withScopedCrossSkillProcessEnv(env, async () => {
      const isolatedUserId = Number(env.TRAINING_CROSS_SKILL_STAGING_USER_ID);
      const plannerInput: ChatPlannerInput = {
        text: "create this week's workout plan and add workout review to my calendar tomorrow at 7am",
        userId: isolatedUserId,
        tenantId: isolatedUserId,
        conversationId: 'phase7-cross-skill-smoke',
        messageId: 'phase7-cross-skill-smoke-message',
        channel: 'api',
        locale: 'en-US',
        timezone: 'Europe/Lisbon',
        nowIso: '2026-07-31T10:00:00.000Z',
        persistRuns: false,
      };
      const split = splitChatMultiStepRequest(plannerInput.text);
      const segmentSteps: ChatPlanStep[] = [
        makeStep(plannerInput, {
          skill: 'training',
          action: 'training_plan_create',
          risk: 'safe_write',
          provider: 'nexus',
          args: {
            sport: 'running',
            goal: 'weekly workout plan',
            durationWeeks: 1,
            startDate: '2026-08-03',
            weeklyVolumeKm: 20,
          },
          requiredArgsPresent: true,
        }),
        // This is the historical lookalike misroute. The live manifest's
        // calendar-placement ownership row must replace it in the router.
        makeStep(plannerInput, {
          skill: 'tasks',
          action: 'add_subtasks_to_task',
          risk: 'safe_write',
          provider: 'nexus',
          args: { title: 'calendar', subtasks: ['workout review'] },
          requiredArgsPresent: true,
        }),
      ];
      let segmentIndex = 0;
      const routed = await routeChatMultiStepSegments(
        plannerInput,
        split.segments,
        async (segmentInput) => syntheticSegmentPlan(segmentInput, segmentSteps[segmentIndex++]),
      );
      const routedPlan = routed.plan;
      const ownershipSignal = routedPlan?.debug?.routingSignals.find((signal) => (
        signal === 'cross_skill_ownership_rewrite:tasks.add_subtasks_to_task->secretary_calendar.schedule_event'
      ));
      const ownedSteps = routedPlan?.steps.map((step) => `${step.skill}.${step.action}`) ?? [];
      const allStepsReady = routedPlan?.steps.every((step) => step.requiredArgsPresent) === true;
      const previewPlan = routedPlan ? enforceCrossSkillPreview(routedPlan) : null;
      const preview = previewPlan ? multiStepPreviewCopy(previewPlan, plannerInput) : '';
      const groupedPreview = preview.includes('Training:')
        && preview.includes('Secretary — Calendar:');

      const declineCtx = {
        normalizedText: 'Log this receipt for 45 EUR and remind me Friday',
        preRoutingDecision: {
          primaryDomain: 'finance',
          involvedSkills: ['finance', 'secretary'],
          intentKinds: ['action', 'cross_skill'],
          confidence: 0.94,
          reasonCodes: ['cross_skill_request'],
          explanation: 'Finance owns the receipt and Secretary owns the reminder.',
          ownership: {
            scheduleOwner: 'secretary',
            contentOwners: ['finance', 'secretary'],
            chatRole: 'coordinate_and_explain',
          },
          safety: {
            destructive: false,
            requiresConfirmation: false,
            explicitConfirmation: false,
            confirmationReasonCodes: [],
          },
          context: {
            shouldRefreshBeforeAnswer: false,
            staleContextRisk: false,
            ambiguousReference: false,
            tenantBoundaryMention: false,
          },
          clarify: null,
        },
      } as unknown as ChatTurnCtx;
      const declineFlagOn = await crossSkillPlanDeclinedStage.canHandle(declineCtx);
      process.env[CROSS_SKILL_EXECUTION_ENV_VAR] = 'false';
      const declineFlagOff = await crossSkillPlanDeclinedStage.canHandle(declineCtx);
      process.env[CROSS_SKILL_EXECUTION_ENV_VAR] = env[CROSS_SKILL_EXECUTION_ENV_VAR] ?? 'true';

      let dependencyAccesses = 0;
      let executorAccesses = 0;
      const failClosedDependencies = new Proxy(Object.create(null) as Required<ChatActionPlannerDeps>, {
        get(_target, property) {
          dependencyAccesses += 1;
          throw new Error(`cross_skill_smoke_dependency_access:${String(property)}`);
        },
      });
      const executorResponse = previewPlan && allStepsReady
        ? await executeChatActionPlan(previewPlan, plannerInput, failClosedDependencies, {
          beforeStepExecution() {
            executorAccesses += 1;
            throw new Error('cross_skill_smoke_executor_access');
          },
        })
        : null;
      const executorHeldForConfirmation = executorResponse?.metadata.actionStatus === 'needs_confirmation';
      const executionStayedCold = dependencyAccesses === 0 && executorAccesses === 0;

      return assertOperation({
        flow: 'phase7_cross_skill_flag_contract',
        expected: 'The enabled runtime rewrites ownership, groups one preview, declines unsafe planner fallthrough, and holds execution for confirmation while Training outputRefs remain absent.',
        checks: [
          ['AI_CROSS_SKILL_EXECUTION is effectively enabled', crossSkillEnabled && isCrossSkillExecutionEnabled()],
          ['manifest-routing master kill is off', !masterKillEnabled],
          ['training_plan_create definition is present', trainingPlanCreate !== null],
          ['training_plan_create ordinary outputRefs remain absent', ordinaryOutputRefsAbsent],
          ['the real splitter produced two planner segments', split.classification === 'multi' && split.segments.length === 2],
          ['the real segment router applied the manifest ownership row', ownershipSignal !== undefined],
          ['the rewritten plan has Training and Secretary-owned calendar steps', ownedSteps.join(',') === 'training.training_plan_create,secretary_calendar.schedule_event'],
          ['the owner-extracted steps are executable without invented test patches', allStepsReady],
          ['the real cross-skill preview is grouped and confirmation-required', previewPlan?.requiresConfirmation === true && groupedPreview],
          ['the declined-stage boundary handles only the flag-on turn', declineFlagOn === true && declineFlagOff === false],
          ['the real executor held the plan before any action ran', executorHeldForConfirmation && executionStayedCold],
          ['the behavioral plan uses only the dedicated staging identity', Number.isInteger(isolatedUserId) && isolatedUserId > 0 && plannerInput.userId === isolatedUserId && plannerInput.tenantId === isolatedUserId],
        ],
        evidence: [
          `${CROSS_SKILL_EXECUTION_ENV_VAR}=${crossSkillEnabled ? 'enabled' : 'disabled'}`,
          `${MANIFEST_ROUTING_MASTER_KILL_ENV_VAR}=${masterKillEnabled ? 'on' : 'off'}`,
          `training_plan_create.outputRefs=${ordinaryOutputRefsAbsent ? 'absent' : 'present-or-definition-missing'}`,
          `ownership=${ownershipSignal ? 'tasks.add_subtasks_to_task->secretary_calendar.schedule_event' : 'missing'}`,
          `groupedPreview=${groupedPreview ? 'training+secretary_calendar' : 'missing'}`,
          `declineBoundary=${declineFlagOn === true && declineFlagOff === false ? 'flag-on-only' : 'failed'}`,
          `executorConfirmation=${executorHeldForConfirmation ? 'needs_confirmation;executedActions=0' : 'failed'}`,
          `executionGuards=dependencyAccesses:${dependencyAccesses};executorAccesses:${executorAccesses}`,
          `scope=user:${plannerInput.userId};tenant:${plannerInput.tenantId}`,
        ],
      });
    });
  } catch (error) {
    return assertOperation({
      flow: 'phase7_cross_skill_flag_contract',
      expected: 'The enabled runtime completes every provider-free cross-skill behavioral probe.',
      checks: [['behavioral probe completed without an exception', false]],
      evidence: [`probeError=${oneLine(error instanceof Error ? error.message : String(error))}`],
    });
  }
}

function syntheticSegmentPlan(input: ChatPlannerInput, step: ChatPlanStep | undefined): ChatActionPlan | null {
  if (!step) return null;
  return {
    schemaVersion: 1,
    userId: String(input.userId),
    tenantId: String(input.tenantId),
    conversationId: input.conversationId,
    messageId: input.messageId,
    locale: input.locale ?? 'en-US',
    timezone: input.timezone,
    channel: input.channel,
    createdAt: input.nowIso ?? new Date().toISOString(),
    planner: 'deterministic',
    steps: [step],
    requiresConfirmation: false,
    confidence: 0.99,
    effectiveConfidence: 0.99,
    debug: {
      routingSignals: ['phase7_cross_skill_smoke_segment'],
      rejectedFastPaths: [],
      parser: 'deterministic',
    },
  };
}

async function withScopedCrossSkillProcessEnv<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
): Promise<T> {
  const names = [CROSS_SKILL_EXECUTION_ENV_VAR, MANIFEST_ROUTING_MASTER_KILL_ENV_VAR] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    const value = env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

export async function runTrainingCrossSkillStagingSmoke(
  options: SmokeHarnessOptions,
  reader: RuntimeCrossSkillReader | null = null,
): Promise<SmokeReport> {
  const startedAt = new Date().toISOString();
  const prerequisites = evaluateCrossSkillSmokePrerequisites(options.env);
  const localFixtureOperations = runLocalFixtureSmoke();
  const operations: SmokeOperationResult[] = [];

  if (options.dryRun || !prerequisites.ok || !options.userId) {
    operations.push({
      flow: 'staging_prerequisites',
      expected: 'A staging-mode process, staging database, and isolated staging test user are configured.',
      actual: options.dryRun
        ? 'Blocked: dry run requested; real staging contexts were not read.'
        : `Blocked: ${prerequisites.missing.join(', ')}`,
      status: 'blocked',
      evidence: options.dryRun ? ['--dry-run is not staging proof'] : prerequisites.missing,
    });
    return finishReport(options, startedAt, prerequisites, operations, localFixtureOperations);
  }

  const runtimeReader = reader ?? loadRuntimeCrossSkillReader();
  operations.push(await evaluatePhase7CrossSkillFlagContract(options.env));
  const bundle = await readRuntimeBundle(options.userId, runtimeReader);
  operations.push(...evaluateRuntimeBundle(bundle, options.userId));

  return finishReport(options, startedAt, prerequisites, operations, localFixtureOperations);
}

export function runLocalFixtureSmoke(): SmokeOperationResult[] {
  const bundle = buildFixtureBundle();
  const operations: SmokeOperationResult[] = [];
  const contextPrompt = formatTrainingContextForPrompt(bundle.trainingContext, 'hybrid');

  operations.push(assertOperation({
    flow: 'local_fixture_contracts',
    expected: 'Fixture contexts exercise Secretary, Cooking, Finance, Content, and signal-prompt plumbing without staging writes.',
    checks: [
      ['Secretary travel/admin pressure constrains Training', bundle.coordination.modularSessionBias && bundle.coordination.maxHardSessionsPerWeek === 1],
      ['Cooking fueling gap produces one specific warning line', countOccurrences(contextPrompt, 'FUELING GAP') === 1 && contextPrompt.includes('2026-05-05')],
      ['Finance budget constraint reaches Training', bundle.coordination.lowCostBias && bundle.coordination.selectiveTrainingSpend],
      ['Content workload protects filming day', bundle.coordination.protectFilmingDay === 'thursday'],
      ['Training milestone signal exists for Content', hasSignal(bundle.training.derivedSignals, 'content_capture_opportunity')],
    ],
    evidence: [
      `maxHardSessionsPerWeek=${bundle.coordination.maxHardSessionsPerWeek}`,
      `protectFocusDay=${bundle.coordination.protectFocusDay}`,
      `protectFilmingDay=${bundle.coordination.protectFilmingDay}`,
      `prompt=${oneLine(contextPrompt)}`,
    ],
  }));

  operations.push(assertOperation({
    flow: 'secretary_conflict',
    expected: 'Secretary pressure creates reflow/modular guidance instead of Training locking an impossible schedule.',
    checks: [
      ['modular session bias enabled', bundle.coordination.modularSessionBias],
      ['focus day is protected', bundle.coordination.protectFocusDay === 'wednesday'],
      ['prompt names travel pressure', bundle.coordination.promptBlock.includes('Travel is currently flagged')],
    ],
    evidence: [bundle.coordination.promptBlock],
  }));

  operations.push(assertOperation({
    flow: 'cooking_fueling_gap',
    expected: 'Cooking fueling gaps are specific, actionable, and deduped.',
    checks: [
      ['conservative first week enabled', bundle.coordination.conservativeFirstWeek],
      ['context prompt has one fueling line', countOccurrences(contextPrompt, 'FUELING GAP') === 1],
      ['hard date is named', contextPrompt.includes('2026-05-05')],
    ],
    evidence: [contextPrompt],
  }));

  operations.push(assertOperation({
    flow: 'finance_budget_constraint',
    expected: 'Finance constraints reduce paid gear/supplement pressure and cap optional spend-heavy work.',
    checks: [
      ['low-cost bias enabled', bundle.coordination.lowCostBias],
      ['selective training spend enabled', bundle.coordination.selectiveTrainingSpend],
      ['strength target is capped', bundle.coordination.strengthSessionTarget <= 2],
    ],
    evidence: [`strengthSessionTarget=${bundle.coordination.strengthSessionTarget}`, bundle.coordination.promptBlock],
  }));

  operations.push(assertOperation({
    flow: 'content_workload',
    expected: 'Content workload/filming windows are visible to Training as schedule friction.',
    checks: [
      ['filming day protected', bundle.coordination.protectFilmingDay === 'thursday'],
      ['prompt references Content', bundle.coordination.promptBlock.includes('Content currently prefers')],
    ],
    evidence: [bundle.coordination.promptBlock],
  }));

  operations.push(assertOperation({
    flow: 'training_content_milestone',
    expected: 'Training can expose a content-capture opportunity for Content Creation when supported.',
    checks: [
      ['content_capture_opportunity derived signal exists', hasSignal(bundle.training.derivedSignals, 'content_capture_opportunity')],
    ],
    evidence: [JSON.stringify(bundle.training.derivedSignals.find((signal) => signal.signalType === 'content_capture_opportunity')?.payload ?? {})],
  }));

  return operations;
}

function evaluateRuntimeBundle(bundle: RuntimeBundle, userId: number): SmokeOperationResult[] {
  const operations: SmokeOperationResult[] = [];
  const prompt = formatTrainingContextForPrompt(bundle.trainingContext, 'hybrid');
  const shared = bundle.sharedDecisionContext;
  const contracts = bundle.contracts;
  const secretarySignals = signalTypes(bundle.secretary.derivedSignals);
  const cookingSignals = signalTypes(bundle.cooking.derivedSignals);
  const financeSignals = signalTypes(bundle.finance.derivedSignals);
  const contentSignals = signalTypes(bundle.content.derivedSignals);
  const trainingSignals = signalTypes(bundle.training.derivedSignals);
  const secretaryHasConflictFixture =
    hasAnySignal(bundle.secretary.derivedSignals, ['calendar_busy_blocks', 'calendar_fragmentation', 'meeting_criticality', 'travel_window'])
    || bundle.secretary.events.length > 0
    || Boolean(bundle.secretary.focusBlock);
  const secretaryCoordinationReacted =
    bundle.coordination.modularSessionBias
    || Boolean(bundle.coordination.protectFocusDay)
    || bundle.coordination.maxHardSessionsPerWeek < 2;
  const cookingHasFuelingFixture =
    hasAnySignal(bundle.cooking.derivedSignals, ['fueling_support_status', 'meal_execution_readiness', 'meal_plan_window']);
  const financeHasConstraintFixture =
    hasAnySignal(bundle.finance.derivedSignals, ['budget_remaining'])
    || ['tight', 'controlled'].includes(String(bundle.finance.budgetView?.affordability ?? '').toLowerCase());
  const contentHasWorkloadFixture =
    hasAnySignal(bundle.content.derivedSignals, ['publishing_commitment', 'content_workload', 'filming_window'])
    || Boolean(bundle.content.filmingRecommendation)
    || Boolean(bundle.content.nextExecution)
    || bundle.content.upcomingTopicCount > 0;

  operations.push(assertRuntimeOperation({
    flow: 'secretary_conflict',
    expected: 'Staging Secretary context shows a real schedule constraint that Training can reflow around.',
    dataChecks: [
      ['Secretary context is present', bundle.secretary.userId === userId],
      ['Secretary section or contract is present', shared.includes('Secretary:') || Boolean(contracts.secretary)],
      ['Secretary conflict/travel/focus fixture data is present', secretaryHasConflictFixture],
    ],
    qualityChecks: [
      ['Training coordination reacts to Secretary constraints', !secretaryHasConflictFixture || secretaryCoordinationReacted],
    ],
    evidence: [
      `secretarySignals=${secretarySignals}`,
      `secretaryEvents=${bundle.secretary.events.length}`,
      `focusBlock=${Boolean(bundle.secretary.focusBlock)}`,
      `protectFocusDay=${bundle.coordination.protectFocusDay ?? 'none'}`,
      `modularSessionBias=${bundle.coordination.modularSessionBias}`,
    ],
  }));

  operations.push(assertRuntimeOperation({
    flow: 'cooking_fueling_gap',
    expected: 'Staging Cooking context exposes meal/fueling gaps once and Training receives actionable constraints.',
    dataChecks: [
      ['Cooking context is present', bundle.cooking.userId === userId],
      ['Cooking section or contract is present', shared.includes('Cooking:') || Boolean(contracts.cooking)],
      ['Cooking fueling/meal-gap fixture data is present', cookingHasFuelingFixture],
    ],
    qualityChecks: [
      ['Fueling warning is deduped in direct signal prompt when active', countOccurrences(prompt, 'FUELING GAP') <= 1],
      ['Training coordination reacts to fueling gap', !cookingHasFuelingFixture || prompt.includes('FUELING GAP') || bundle.coordination.conservativeFirstWeek],
    ],
    evidence: [
      `cookingSignals=${cookingSignals}`,
      `conservativeFirstWeek=${bundle.coordination.conservativeFirstWeek}`,
      oneLine(prompt),
    ],
  }));

  operations.push(assertRuntimeOperation({
    flow: 'finance_budget_constraint',
    expected: 'Staging Finance budget/equipment posture is visible to Training without recommending unrealistic spend.',
    dataChecks: [
      ['Finance context is present', bundle.finance.userId === userId],
      ['Finance section or contract is present', shared.includes('Finance:') || Boolean(contracts.finance)],
      ['Finance budget/equipment fixture data is present', financeHasConstraintFixture],
    ],
    qualityChecks: [
      ['Budget prompt is deduped when active', countOccurrences(prompt, 'FINANCE CONSTRAINT') <= 1],
      ['Training coordination reacts to budget constraint', !financeHasConstraintFixture || bundle.coordination.lowCostBias || prompt.includes('FINANCE CONSTRAINT')],
    ],
    evidence: [
      `financeSignals=${financeSignals}`,
      `affordability=${bundle.finance.budgetView?.affordability ?? 'unknown'}`,
      `lowCostBias=${bundle.coordination.lowCostBias}`,
      oneLine(prompt),
    ],
  }));

  operations.push(assertRuntimeOperation({
    flow: 'content_workload',
    expected: 'Staging Content workload/filming signal is visible to Training as schedule friction.',
    dataChecks: [
      ['Content context is present', bundle.content.userId === userId],
      ['Content section or contract is present', shared.includes('Content:') || Boolean(contracts.content)],
      ['Content workload/filming fixture data is present', contentHasWorkloadFixture],
    ],
    qualityChecks: [
      ['Training coordination reacts to Content workload when a filming day exists', !bundle.content.filmingRecommendation?.date || Boolean(bundle.coordination.protectFilmingDay)],
    ],
    evidence: [
      `contentSignals=${contentSignals}`,
      `upcomingTopicCount=${bundle.content.upcomingTopicCount}`,
      `nextExecution=${bundle.content.nextExecution?.title ?? 'none'}`,
      `protectFilmingDay=${bundle.coordination.protectFilmingDay ?? 'none'}`,
    ],
  }));

  const milestone = hasSignal(bundle.training.derivedSignals, 'content_capture_opportunity');
  operations.push({
    flow: 'training_content_milestone',
    expected: 'If a Training milestone/content opportunity exists, it is exposed as a user-scoped mesh signal.',
    actual: milestone
      ? 'Training content_capture_opportunity signal is present.'
      : 'No content_capture_opportunity signal is active for this staging user/week. This is supported by the mesh but not present in current staging data.',
    status: milestone ? 'pass' : 'blocked',
    evidence: [
      `trainingSignals=${trainingSignals}`,
    ],
  });

  operations.push(assertOperation({
    flow: 'shared_context_scope',
    expected: 'All peer contexts are scoped to the selected staging user and no unrelated tenant data is present.',
    checks: [
      ['Training scoped', bundle.training.userId === userId],
      ['Cooking scoped', bundle.cooking.userId === userId],
      ['Finance scoped', bundle.finance.userId === userId],
      ['Content scoped', bundle.content.userId === userId],
      ['Secretary scoped', bundle.secretary.userId === userId],
    ],
    evidence: [
      `userIds=${[
        bundle.training.userId,
        bundle.cooking.userId,
        bundle.finance.userId,
        bundle.content.userId,
        bundle.secretary.userId,
      ].join(',')}`,
    ],
  }));

  return operations;
}

async function readRuntimeBundle(userId: number, reader: RuntimeCrossSkillReader): Promise<RuntimeBundle> {
  const [training, cooking, finance, content, secretary, sharedDecisionContext, contracts] = await Promise.all([
    reader.readTrainingMeshContext({ userId }),
    reader.readCookingMeshContext({ userId }),
    reader.readFinanceMeshContext({ userId }),
    reader.readContentMeshContext({ userId }),
    reader.readSecretaryMeshContext({ userId }),
    reader.buildSharedDecisionContext('triathlon', userId),
    reader.buildSharedDecisionContracts('triathlon', userId),
  ]);
  const trainingContext = readTrainingContextAll({ userId });
  const coordination = buildTrainingPlanCoordination({
    sessionsPerWeek: 5,
    strengthSessionsPerWeek: 3,
    longWorkoutDay: 'saturday',
    fitnessProfile: null,
    gymProfile: null,
    runProfile: null,
    training,
    cooking,
    finance,
    content,
    secretary,
    sharedDecisionContext,
  });
  return { training, cooking, finance, content, secretary, sharedDecisionContext, contracts, coordination, trainingContext };
}

function buildFixtureBundle(): RuntimeBundle {
  const training = fixtureTrainingContext();
  const cooking = fixtureCookingContext();
  const finance = fixtureFinanceContext();
  const content = fixtureContentContext();
  const secretary = fixtureSecretaryContext();
  const trainingContext = fixtureTrainingSignalContext();
  const input: TrainingPlanCoordinationInput = {
    sessionsPerWeek: 6,
    strengthSessionsPerWeek: 4,
    longWorkoutDay: 'saturday',
    fitnessProfile: { experienceLevel: 'intermediate' },
    gymProfile: { injuries: [] },
    runProfile: {},
    training,
    cooking,
    finance,
    content,
    secretary,
    sharedDecisionContext: [
      'Secretary: travel, focus, and admin constraints are active.',
      'Cooking: hard-session fueling is missing on 2026-05-05.',
      'Finance: budget mode is tight and training spend is selective.',
      'Content: filming window is Thursday 10:00-12:00.',
    ].join('\n'),
  };
  return {
    training,
    cooking,
    finance,
    content,
    secretary,
    sharedDecisionContext: input.sharedDecisionContext ?? '',
    contracts: {},
    coordination: buildTrainingPlanCoordination(input),
    trainingContext,
  };
}

function signal(signalType: MeshSignalDraft['signalType'], payload: Record<string, unknown>, priority: MeshSignalDraft['priority'] = 'normal'): MeshSignalDraft {
  return {
    sourceAgent: 'training-cross-skill-smoke.fixture',
    signalType,
    meshPriority: priority === 'urgent' ? 1 : 3,
    priority,
    payload,
    expiresAt: '2026-05-10T23:59:59.000Z',
  };
}

function fixtureTrainingContext(): TrainingMeshContext {
  return {
    userId: 42,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    activePlan: null,
    activeWeek: null,
    sessions: [],
    trainingContext: fixtureTrainingSignalContext(),
    coachBriefing: null,
    adherence: null,
    coachPhaseMemory: null,
    derivedSignals: [
      signal('recovery_state', { state: 'strained' }, 'urgent'),
      signal('content_capture_opportunity', {
        angle: 'Staying consistent during a constrained travel week',
        title: 'Travel-week training win',
        date: '2026-05-07',
      }),
    ],
  } as TrainingMeshContext;
}

function fixtureCookingContext(): CookingMeshContext {
  return {
    userId: 42,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    meals: [],
    shoppingList: null,
    derivedSignals: [
      signal('meal_plan_window', {
        coveredDays: ['2026-05-04'],
        missingDates: ['2026-05-05', '2026-05-06', '2026-05-07'],
      }),
      signal('fueling_support_status', {
        status: 'at_risk',
        trainingDates: ['2026-05-05', '2026-05-07'],
        trainingDatesMissingMeals: ['2026-05-05', '2026-05-07'],
        hardDatesMissingMeals: ['2026-05-05'],
        trainingCoverageRatio: 0.25,
        shoppingReady: false,
      }, 'urgent'),
      signal('meal_execution_readiness', {
        status: 'partial',
        missingDates: ['2026-05-05'],
        shoppingReady: false,
      }),
    ],
  } as CookingMeshContext;
}

function fixtureFinanceContext(): FinanceMeshContext {
  return {
    userId: 42,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    month: '2026-05',
    monthlySummary: {
      month: '2026-05',
      currency: 'EUR',
      currencies: ['EUR'],
      mixedCurrency: false,
      totalIncome: 1000,
      totalExpenses: 930,
      totalDeductions: 0,
      netIncome: 70,
      transactionCount: 8,
    },
    budgetView: {
      month: '2026-05',
      basisCurrency: 'EUR',
      currencies: ['EUR'],
      integrity: 'reliable',
      affordability: 'tight',
      incomeInBasisCurrency: 1000,
      expensesInBasisCurrency: 930,
      currentRemainingInBasisCurrency: 70,
      currentRemainingRatio: 0.07,
      projectedExpensesInBasisCurrency: 930,
      projectedRemainingInBasisCurrency: 70,
      projectedRemainingRatio: 0.07,
      recurringExpenseEstimate: 120,
      recurringExpenseCount: 2,
      recurringExpenses: [],
      notes: [],
    },
    taxEvents: [],
    annualSummary: {
      year: 2026,
      totalGrossIncome: 0,
      totalDeductions: 0,
      totalInssDue: 0,
      totalTaxDue: 0,
      totalPaid: 0,
      totalPending: 0,
      effectiveAnnualRate: 0,
      monthsPaid: 0,
      monthsPending: 0,
      months: [],
    },
    subscription: {
      plan: 'pro',
      period: 'monthly',
      status: 'active',
      provider: 'stripe',
      currentPeriodEnd: '2026-05-20T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      isActive: true,
      isPro: true,
    },
    derivedSignals: [
      signal('budget_remaining', {
        month: '2026-05',
        remainingRatio: 0.07,
        projectedRemainingRatio: 0.07,
        basisCurrency: 'EUR',
        integrity: 'reliable',
        budgetMode: 'tight',
        trainingSpendMode: 'selective',
        supplementMode: 'pause',
        recurringExpenseEstimate: 120,
        recurringExpenseCount: 2,
      }, 'urgent'),
    ],
  } as FinanceMeshContext;
}

function fixtureContentContext(): ContentMeshContext {
  return {
    userId: 42,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    upcomingTopicCount: 3,
    scheduledTopics: [],
    filmingRecommendation: {
      date: '2026-05-07',
      blockStart: '2026-05-07T10:00:00.000Z',
      blockEnd: '2026-05-07T12:00:00.000Z',
      reason: 'Best available filming block.',
      confidence: 'high',
    },
    unreadNotifications: [],
    deskItems: [],
    monitoredPillars: [],
    recentSignals: [],
    nextExecution: {
      mode: 'film',
      title: 'Training block update',
      summary: 'Capture the travel-week coaching story.',
      scheduledDate: '2026-05-07',
      confidence: 'high',
    },
    voiceDnaEntries: [],
    knowledgeStats: {} as ReturnType<any>,
    derivedSignals: [
      signal('publishing_commitment', {
        upcomingTopicCount: 3,
        nextDate: '2026-05-07',
        nextTopicTitle: 'Travel-week training update',
      }),
    ],
  } as unknown as ContentMeshContext;
}

function fixtureSecretaryContext(): SecretaryMeshContext {
  return {
    userId: 42,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    events: [],
    focusBlock: {
      date: '2026-05-06',
      startIso: '2026-05-06T08:00:00.000Z',
      endIso: '2026-05-06T11:00:00.000Z',
      reason: 'Protected focus block.',
      confidence: 'high',
    } as any,
    dueToday: [],
    dueThisWeek: [],
    overdue: [],
    pending: [],
    writableCalendar: true,
    mailPressure: null,
    derivedSignals: [
      signal('calendar_busy_blocks', {
        dates: ['2026-05-05', '2026-05-06'],
        totalEvents: 9,
      }, 'urgent'),
      signal('travel_window', {
        dates: ['2026-05-08'],
      }, 'urgent'),
      signal('inbox_pressure', {
        overdueCount: 4,
        dueTodayCount: 3,
        dueThisWeekCount: 8,
        pendingCount: 15,
      }, 'urgent'),
      signal('calendar_fragmentation', {
        dates: ['2026-05-05'],
        fragmentedDayCount: 1,
        maxEventsInDay: 6,
      }),
      signal('meeting_criticality', {
        criticalEventCount: 2,
        dates: ['2026-05-05'],
        examples: ['Investor call'],
      }),
    ],
  } as SecretaryMeshContext;
}

function fixtureTrainingSignalContext(): TrainingContext {
  return {
    signals: [
      {
        id: 1,
        source_agent: 'secretary.calendar',
        signal_type: 'calendar_conflict',
        payload: {
          conflict_event_title: 'Board review',
          overlap_start: '2026-05-05T08:30:00.000Z',
          overlap_end: '2026-05-05T09:30:00.000Z',
        },
        priority: 'urgent',
        consumed_by: [],
        status: 'active',
        created_at: '2026-05-04T00:00:00.000Z',
        expires_at: '2026-05-05T00:00:00.000Z',
        tenant_id: 42,
        user_id: 42,
        confidence: 1,
        format_tag: null,
        pillar_tag: null,
        evidence_count: 1,
      },
      {
        id: 2,
        source_agent: 'cooking.fueling',
        signal_type: 'fueling_gap_risk',
        payload: {
          status: 'at_risk',
          hard_dates_missing_meals: ['2026-05-05'],
        },
        priority: 'urgent',
        consumed_by: [],
        status: 'active',
        created_at: '2026-05-04T00:00:00.000Z',
        expires_at: '2026-05-06T00:00:00.000Z',
        tenant_id: 42,
        user_id: 42,
        confidence: 1,
        format_tag: null,
        pillar_tag: null,
        evidence_count: 1,
      },
      {
        id: 3,
        source_agent: 'finance.training',
        signal_type: 'budget_remaining',
        payload: {
          budgetMode: 'tight',
          trainingSpendMode: 'selective',
        },
        priority: 'urgent',
        consumed_by: [],
        status: 'active',
        created_at: '2026-05-04T00:00:00.000Z',
        expires_at: '2026-05-10T00:00:00.000Z',
        tenant_id: 42,
        user_id: 42,
        confidence: 1,
        format_tag: null,
        pillar_tag: null,
        evidence_count: 1,
      },
      {
        id: 4,
        source_agent: 'content.pipeline',
        signal_type: 'publishing_commitment',
        payload: {
          nextDate: '2026-05-07',
        },
        priority: 'normal',
        consumed_by: [],
        status: 'active',
        created_at: '2026-05-04T00:00:00.000Z',
        expires_at: '2026-05-10T00:00:00.000Z',
        tenant_id: 42,
        user_id: 42,
        confidence: 1,
        format_tag: null,
        pillar_tag: null,
        evidence_count: 1,
      },
    ],
    flags: {
      lowSleep: false,
      lowHrv: false,
      lowReadiness: false,
      highLegLoad: false,
      highShoulderLoad: false,
      raceThisWeek: false,
      lowAdherence: false,
      highAdherence: false,
      planDrift: false,
      calendarConflict: true,
      scheduleStale: false,
      fuelingGap: true,
      budgetConstraint: true,
      contentCommitment: true,
      otherSportRpeToday: 0,
    },
  };
}

function assertOperation(input: {
  flow: CrossSkillFlow;
  expected: string;
  checks: Array<[string, boolean]>;
  evidence: string[];
}): SmokeOperationResult {
  const failed = input.checks.filter(([, ok]) => !ok).map(([label]) => label);
  return {
    flow: input.flow,
    expected: input.expected,
    actual: failed.length === 0 ? 'All checks passed.' : `Failed checks: ${failed.join(', ')}`,
    status: failed.length === 0 ? 'pass' : 'fail',
    evidence: input.evidence,
  };
}

function assertRuntimeOperation(input: {
  flow: CrossSkillFlow;
  expected: string;
  dataChecks: Array<[string, boolean]>;
  qualityChecks: Array<[string, boolean]>;
  evidence: string[];
}): SmokeOperationResult {
  const failedQuality = input.qualityChecks.filter(([, ok]) => !ok).map(([label]) => label);
  if (failedQuality.length > 0) {
    return {
      flow: input.flow,
      expected: input.expected,
      actual: `Failed quality checks: ${failedQuality.join(', ')}`,
      status: 'fail',
      evidence: input.evidence,
    };
  }

  const missingData = input.dataChecks.filter(([, ok]) => !ok).map(([label]) => label);
  if (missingData.length > 0) {
    return {
      flow: input.flow,
      expected: input.expected,
      actual: `Blocked by missing staging fixture data: ${missingData.join(', ')}`,
      status: 'blocked',
      evidence: input.evidence,
    };
  }

  return {
    flow: input.flow,
    expected: input.expected,
    actual: 'All checks passed.',
    status: 'pass',
    evidence: input.evidence,
  };
}

function finishReport(
  options: SmokeHarnessOptions,
  startedAt: string,
  prerequisites: SmokePrerequisiteReport,
  operations: SmokeOperationResult[],
  localFixtureOperations: SmokeOperationResult[],
): SmokeReport {
  return {
    runId: options.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    userId: options.userId,
    releaseIdentity: {
      environment: options.env.NEXUS_RELEASE_ROLE ?? null,
      runtimeSha: options.env.NEXUS_RELEASE_SHA ?? null,
      artifactDigest: options.env.NEXUS_RELEASE_ARTIFACT_SHA256 ?? null,
    },
    prerequisites,
    operations,
    localFixtureOperations,
  };
}

function hasSignal(signals: MeshSignalDraft[], type: MeshSignalDraft['signalType']): boolean {
  return signals.some((signal) => signal.signalType === type);
}

function hasAnySignal(signals: MeshSignalDraft[], types: string[]): boolean {
  return signals.some((signal) => types.includes(String(signal.signalType)));
}

function signalTypes(signals: MeshSignalDraft[]): string {
  return signals.map((signal) => signal.signalType).join(', ') || 'none';
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function oneLine(text: string): string {
  return text
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function parseEnvBoolean(raw: string | undefined): boolean {
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

export function renderCrossSkillSmokeReportMarkdown(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push('# Training Cross-Skill Staging Smoke Results');
  lines.push('');
  lines.push(`- Run ID: \`${report.runId}\``);
  lines.push(`- Started: \`${report.startedAt}\``);
  lines.push(`- Finished: \`${report.finishedAt}\``);
  lines.push(`- Dry run: \`${report.dryRun}\``);
  lines.push(`- Staging user ID: \`${report.userId ?? 'not configured'}\``);
  lines.push(`- Environment: \`${report.releaseIdentity.environment ?? 'not configured'}\``);
  lines.push(`- Runtime SHA: \`${report.releaseIdentity.runtimeSha ?? 'not configured'}\``);
  lines.push(`- Artifact SHA-256: \`${report.releaseIdentity.artifactDigest ?? 'not configured'}\``);
  lines.push('');
  lines.push('## Prerequisites');
  lines.push('');
  lines.push(`- Status: **${report.prerequisites.ok ? 'ready' : 'blocked'}**`);
  if (report.prerequisites.missing.length > 0) {
    lines.push(`- Missing: ${report.prerequisites.missing.map((item) => `\`${item}\``).join(', ')}`);
  }
  if (report.prerequisites.warnings.length > 0) {
    lines.push(`- Warnings: ${report.prerequisites.warnings.join(' ')}`);
  }
  lines.push('');
  lines.push('## Local Fixture Contract Checks');
  lines.push('');
  appendOperationTable(lines, report.localFixtureOperations);
  lines.push('');
  lines.push('## Staging Runtime Checks');
  lines.push('');
  appendOperationTable(lines, report.operations);
  lines.push('');
  lines.push('## Interpretation');
  lines.push('');
  if (report.dryRun) {
    lines.push('Real staging validation was **not** run because this was a dry run. The local fixture checks only prove harness and contract behavior; they are not a staging pass.');
  } else if (!report.prerequisites.ok) {
    lines.push('Real staging validation was **not** run because prerequisites are missing. The local fixture checks only prove harness and contract behavior; they are not a staging pass.');
  } else if (report.operations.some((operation) => operation.status === 'fail')) {
    lines.push('Staging validation ran but at least one flow failed. Treat this as a release blocker until the failing flow is fixed or the staging fixture is corrected.');
  } else if (report.operations.some((operation) => operation.status === 'blocked')) {
    lines.push('Staging validation is partially blocked. See the operation table for the exact missing runtime signal or fixture.');
  } else {
    lines.push('All requested staging runtime flows passed.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function appendOperationTable(lines: string[], operations: SmokeOperationResult[]): void {
  if (operations.length === 0) {
    lines.push('No operations recorded.');
    return;
  }
  lines.push('| Flow | Expected | Actual | Status | Evidence |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const operation of operations) {
    lines.push([
      operation.flow,
      operation.expected,
      operation.actual,
      operation.status,
      operation.evidence.map((item) => escapeMarkdownCell(oneLine(item))).join('<br>') || '-',
    ].map(escapeMarkdownCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
}

function escapeMarkdownCell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

async function main(): Promise<void> {
  const envFile = process.env.TRAINING_CROSS_SKILL_STAGING_ENV_FILE;
  dotenv.config(envFile ? { path: envFile } : undefined);

  const userId = Number(process.env.TRAINING_CROSS_SKILL_STAGING_USER_ID);
  const normalizedUserId = Number.isInteger(userId) && userId > 0 ? userId : undefined;
  const runId = process.env.TRAINING_CROSS_SKILL_STAGING_RUN_ID || buildCrossSkillSmokeRunId();
  const dryRun = process.argv.includes('--dry-run') || process.env.TRAINING_CROSS_SKILL_STAGING_DRY_RUN === '1';
  const resultsPath = process.env.TRAINING_CROSS_SKILL_STAGING_RESULTS_PATH
    || DEFAULT_CROSS_SKILL_SMOKE_RESULTS_PATH;
  const prerequisites = evaluateCrossSkillSmokePrerequisites(process.env);
  const reader = !dryRun && prerequisites.ok && normalizedUserId ? loadRuntimeCrossSkillReader() : null;

  const report = await runTrainingCrossSkillStagingSmoke(
    {
      userId: normalizedUserId,
      runId,
      dryRun,
      now: new Date(),
      env: process.env,
    },
    reader,
  );

  const markdown = renderCrossSkillSmokeReportMarkdown(report);
  fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
  fs.writeFileSync(resultsPath, markdown);
  process.stdout.write(markdown);

  const failed = [...report.operations, ...report.localFixtureOperations].some((operation) => operation.status === 'fail');
  const blocked = report.operations.some((operation) => operation.status === 'blocked');
  if (failed || blocked) {
    process.exitCode = blocked && !failed ? 2 : 1;
  }
}

function loadRuntimeCrossSkillReader(): RuntimeCrossSkillReader {
  // Lazy requires keep dotenv/env-file loading before config and storage modules initialize.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const database = require('../services/database') as typeof import('../services/database');
  database.initDatabase();
  // Match the runtime boot wiring so training signal reads see the same
  // user-scoped intelligence-bus rows that the server would expose.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bus = require('../services/intelligence-bus') as typeof import('../services/intelligence-bus');
  bus.setDbProvider(() => database.getDb() as any);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mesh = require('../services/cross-agent-learning') as typeof import('../services/cross-agent-learning');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shared = require('../services/shared-decision-context') as typeof import('../services/shared-decision-context');
  return {
    readTrainingMeshContext: mesh.readTrainingMeshContext,
    readCookingMeshContext: mesh.readCookingMeshContext,
    readFinanceMeshContext: mesh.readFinanceMeshContext,
    readContentMeshContext: mesh.readContentMeshContext,
    readSecretaryMeshContext: mesh.readSecretaryMeshContext,
    buildSharedDecisionContext: shared.buildSharedDecisionContext,
    buildSharedDecisionContracts: shared.buildSharedDecisionContracts,
  };
}

if (require.main === module) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Training cross-skill staging smoke failed: ${message}\n`);
    process.exitCode = 1;
  });
}
