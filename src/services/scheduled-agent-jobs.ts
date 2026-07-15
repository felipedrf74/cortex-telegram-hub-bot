// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';
import { runWithContext } from '../utils/request-context';
import {
  computePromptStateHash,
  getScheduledTarget,
  runAutoresearch,
  type AutoresearchResult,
} from './autoresearch';
import {
  generateAndStoreTopicCandidates,
  generateWeeklyPackage,
  getMissingScheduledInventoryCount,
  type TopicCandidateResult,
  type WeeklyPackageResult,
} from './content-workflow';
import { getDb } from './database';
import { getEvalTarget } from './eval-criteria';
import {
  runGovernedAgentJob,
  AgentJobOutputValidationError,
  type AgentJobOutcome,
  type GovernedAgentJobAdapter,
} from './agent-job-runner';
import { listActiveAgentJobTenantTargets } from './agent-job-targets';
import {
  recordAiAutomationEligibilitySkip,
  resolveAiAutomationEligibility,
} from './ai-automation-policy';
import { isPaidAiCostControlsEnforcementEnabled } from './entitlement';
import { recordOperatorAlert } from './operator-alerts';

const AUTORESEARCH_PROVIDER_ROUTE = 'gemini-or-openai-primary-anthropic-fallback';
const CONTENT_PROVIDER_ROUTE = 'grounded-provider-fallback-route';

export const SHARED_GOVERNED_AGENT_JOB_IDS = [
  'autoresearch',
  'friday_weekly',
  'thursday_youtube',
  'tuesday_reels',
] as const;

type ContentTopicJobId = 'tuesday_reels' | 'thursday_youtube';
type ContentTopicInput = {
  format: 'reel' | 'youtube';
  sourceJob: ContentTopicJobId;
  missingCount: number;
};
type WeeklyContentInput = { missingReels: number; missingYoutube: number };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function isValidGeneratedCandidate(candidate: {
  feedbackId?: unknown;
  title?: unknown;
  niche?: unknown;
  whyNow?: unknown;
  hookIdea?: unknown;
}): boolean {
  return Number.isSafeInteger(candidate.feedbackId)
    && Number(candidate.feedbackId) > 0
    && typeof candidate.title === 'string'
    && candidate.title.trim().length > 0
    && typeof candidate.niche === 'string'
    && candidate.niche.trim().length > 0
    && typeof candidate.whyNow === 'string'
    && candidate.whyNow.trim().length > 0
    && typeof candidate.hookIdea === 'string'
    && candidate.hookIdea.trim().length > 0;
}

// Content topic generation only pays for itself when someone consumes the
// output. First-time users still receive their initial governed inventory.
function shouldGenerateContentTopicsForUser(
  userId: number,
  sourceJob: string,
  initialTargets: ReadonlyArray<{ format: 'reel' | 'youtube'; targetCount: number }>,
): boolean {
  if (!isPaidAiCostControlsEnforcementEnabled()) return true;
  const localBypass = process.env.CONTENT_CRON_ENGAGEMENT_GATE === 'off'
    && ['development', 'test'].includes(process.env.NODE_ENV ?? '');
  if (localBypass) return true;
  try {
    const db = getDb();
    const engaged = db.prepare(`
      SELECT (
        EXISTS(
          SELECT 1 FROM content_topic_feedback
           WHERE user_id = ?
             AND COALESCE(tenant_id, user_id) = ?
             AND (
               (sentiment != 'pending' AND COALESCE(updated_at, created_at) >= datetime('now', '-30 days'))
               OR (COALESCE(script_generated, 0) = 1 AND COALESCE(updated_at, created_at) >= datetime('now', '-30 days'))
               OR converted_at >= datetime('now', '-30 days')
             )
        )
        OR EXISTS(
          SELECT 1 FROM content_scripts
           WHERE user_id = ?
             AND COALESCE(tenant_id, user_id) = ?
             AND COALESCE(scope_status, 'active') = 'active'
             AND created_at >= datetime('now', '-30 days')
        )
      ) AS engaged
    `).get(userId, userId, userId, userId) as { engaged: number };
    if (engaged.engaged) return true;
    const historicalCount = db.prepare(`
      SELECT COUNT(*) AS count
        FROM content_topic_feedback
       WHERE user_id = ?
         AND COALESCE(tenant_id, user_id) = ?
         AND source_job = ?
         AND format = ?
    `);
    const initialInventoryComplete = initialTargets.every((target) => {
      const row = historicalCount.get(
        userId,
        userId,
        sourceJob,
        target.format,
      ) as { count: number };
      return Number(row.count || 0) >= target.targetCount;
    });
    if (!initialInventoryComplete) return true;
    logger.info(
      { userId, sourceJob },
      'Scheduled Content generation skipped: no Content-surface engagement in 30 days',
    );
    return false;
  } catch (error) {
    logger.warn(
      { errorCode: errorName(error), userId, sourceJob },
      'Scheduled Content engagement gate failed closed',
    );
    return false;
  }
}

function topicAdapter(
  format: 'reel' | 'youtube',
  sourceJob: ContentTopicJobId,
): GovernedAgentJobAdapter<ContentTopicInput, TopicCandidateResult> {
  return {
    jobId: sourceJob,
    providerRouting: CONTENT_PROVIDER_ROUTE,
    prepare(scope) {
      const eligibility = resolveAiAutomationEligibility(scope.userId, 'content');
      if (!eligibility.allowed) {
        recordAiAutomationEligibilitySkip(scope.userId, eligibility, {
          jobName: sourceJob,
          baseCategory: `content_workflow_${format}`,
        });
        return {
          kind: 'skip',
          status: 'skipped_no_work',
          reason: 'automation_ineligible',
          fingerprintMaterial: { eligibility: eligibility.reason, format, sourceJob },
        };
      }
      const missingCount = getMissingScheduledInventoryCount(scope.userId, {
        format,
        sourceJob,
        targetCount: 5,
        windowDays: 7,
      }, scope.tenantId);
      if (missingCount === 0) {
        return {
          kind: 'skip',
          status: 'skipped_unchanged',
          reason: 'output_inventory_full',
          fingerprintMaterial: { format, sourceJob, missingCount },
        };
      }
      if (!shouldGenerateContentTopicsForUser(scope.userId, sourceJob, [{ format, targetCount: 5 }])) {
        return {
          kind: 'skip',
          status: 'skipped_no_work',
          reason: 'engagement_gate',
          fingerprintMaterial: { format, sourceJob, missingCount },
        };
      }
      return {
        kind: 'ready',
        input: { format, sourceJob, missingCount },
        fingerprintMaterial: { format, sourceJob, missingCount },
      };
    },
    execute: async ({ scope, input, runId }) => runWithContext(
      { source: `cron:${sourceJob}`, userId: scope.userId, tenantId: scope.tenantId },
      async () => generateAndStoreTopicCandidates(
        scope.userId,
        input.format,
        input.sourceJob,
        scope.tenantId,
        input.missingCount,
        {
          requestSource: 'automation',
          jobName: sourceJob,
          runId,
        },
      ),
    ),
    validateOutput(output, input) {
      if (output.format !== input.format
          || output.sourceJob !== input.sourceJob
          || output.candidates.length === 0
          || output.candidates.length > input.missingCount
          || !output.candidates.every(isValidGeneratedCandidate)) {
        throw new AgentJobOutputValidationError('Scheduled Content topic output failed validation');
      }
    },
  };
}

function weeklyContentAdapter(): GovernedAgentJobAdapter<WeeklyContentInput, WeeklyPackageResult> {
  return {
    jobId: 'friday_weekly',
    providerRouting: CONTENT_PROVIDER_ROUTE,
    prepare(scope) {
      const eligibility = resolveAiAutomationEligibility(scope.userId, 'content');
      if (!eligibility.allowed) {
        recordAiAutomationEligibilitySkip(scope.userId, eligibility, {
          jobName: 'friday_weekly',
          baseCategory: 'content_workflow_weekly',
        });
        return {
          kind: 'skip',
          status: 'skipped_no_work',
          reason: 'automation_ineligible',
          fingerprintMaterial: { eligibility: eligibility.reason, sourceJob: 'friday_weekly' },
        };
      }
      const missingReels = getMissingScheduledInventoryCount(scope.userId, {
        format: 'reel',
        sourceJob: 'friday_weekly',
        targetCount: 4,
        windowDays: 7,
      }, scope.tenantId);
      const missingYoutube = getMissingScheduledInventoryCount(scope.userId, {
        format: 'youtube',
        sourceJob: 'friday_weekly',
        targetCount: 2,
        windowDays: 7,
      }, scope.tenantId);
      if (missingReels === 0 && missingYoutube === 0) {
        return {
          kind: 'skip',
          status: 'skipped_unchanged',
          reason: 'output_inventory_full',
          fingerprintMaterial: { missingReels, missingYoutube, sourceJob: 'friday_weekly' },
        };
      }
      if (!shouldGenerateContentTopicsForUser(scope.userId, 'friday_weekly', [
        { format: 'reel', targetCount: 4 },
        { format: 'youtube', targetCount: 2 },
      ])) {
        return {
          kind: 'skip',
          status: 'skipped_no_work',
          reason: 'engagement_gate',
          fingerprintMaterial: { missingReels, missingYoutube, sourceJob: 'friday_weekly' },
        };
      }
      return {
        kind: 'ready',
        input: { missingReels, missingYoutube },
        fingerprintMaterial: { missingReels, missingYoutube, sourceJob: 'friday_weekly' },
      };
    },
    execute: async ({ scope, input, runId }) => runWithContext(
      { source: 'cron:friday_weekly', userId: scope.userId, tenantId: scope.tenantId },
      async () => generateWeeklyPackage(
        scope.userId,
        scope.tenantId,
        { reels: input.missingReels, youtube: input.missingYoutube },
        {
          requestSource: 'automation',
          jobName: 'friday_weekly',
          runId,
        },
      ),
    ),
    validateOutput(output, input) {
      if (output.reels.length !== input.missingReels
          || output.youtube.length !== input.missingYoutube
          || !output.reels.every(isValidGeneratedCandidate)
          || !output.youtube.every(isValidGeneratedCandidate)) {
        throw new AgentJobOutputValidationError('Scheduled weekly Content output failed validation');
      }
    },
  };
}

export async function runContentTopicCronForActiveUsers(
  format: 'reel' | 'youtube',
  sourceJob: ContentTopicJobId,
): Promise<void> {
  for (const target of listActiveAgentJobTenantTargets()) {
    try {
      await runGovernedAgentJob(topicAdapter(format, sourceJob), {
        tenantId: target.tenantId,
        userId: target.userId,
      });
    } catch (error) {
      logger.error(
        { errorCode: errorName(error), userId: target.userId, tenantId: target.tenantId, sourceJob, format },
        'Scheduled Content topic job failed for tenant',
      );
    }
  }
}

export async function runWeeklyContentPackageCronForActiveUsers(): Promise<void> {
  for (const target of listActiveAgentJobTenantTargets()) {
    try {
      await runGovernedAgentJob(weeklyContentAdapter(), {
        tenantId: target.tenantId,
        userId: target.userId,
      });
    } catch (error) {
      logger.error(
        { errorCode: errorName(error), userId: target.userId, tenantId: target.tenantId },
        'Scheduled weekly Content job failed for tenant',
      );
    }
  }
}

export async function runScheduledAutoresearch(): Promise<AgentJobOutcome<AutoresearchResult>> {
  const targetId = getScheduledTarget();
  const adapter: GovernedAgentJobAdapter<{ targetId: string }, AutoresearchResult> = {
    jobId: 'autoresearch',
    providerRouting: AUTORESEARCH_PROVIDER_ROUTE,
    prepare() {
      const target = getEvalTarget(targetId);
      if (!target) throw new Error('UnknownScheduledAutoresearchTargetError');
      return {
        kind: 'ready',
        input: { targetId },
        fingerprintMaterial: {
          targetId,
          promptStateHash: computePromptStateHash(target),
          mode: 'evaluate_only',
        },
      };
    },
    execute: ({ input, runId }) => runAutoresearch(
      input.targetId,
      1,
      true,
      async (message) => {
        logger.info({ targetId: input.targetId, message }, 'Scheduled autoresearch progress');
      },
      { mode: 'evaluate_only', runId },
    ),
    validateOutput(output, input) {
      if (output.targetId !== input.targetId
          || output.mode !== 'evaluate_only'
          || !Array.isArray(output.rounds)
          || !Number.isFinite(output.finalScore)
          || output.finalScore < 0
          || output.finalScore > 1
          || !Number.isFinite(output.totalDurationMs)
          || output.totalDurationMs < 0) {
        throw new AgentJobOutputValidationError('Scheduled autoresearch output failed validation');
      }
    },
    classifyOutput: (output) => output.skipped === 'skipped_unchanged'
      ? 'skipped_unchanged'
      : 'success',
    async notify(outcome) {
      const score = outcome.output?.finalScore;
      const skipped = outcome.status === 'skipped_unchanged';
      recordOperatorAlert({
        severity: 'info',
        source: 'autoresearch',
        dedupeKey: `autoresearch:${outcome.status}:${targetId}:${new Date().toISOString().slice(0, 10)}`,
        title: skipped ? `Autoresearch unchanged: ${targetId}` : `Autoresearch evaluated: ${targetId}`,
        detail: skipped
          ? 'Skipped unchanged prompt/eval fingerprint before provider routing (0 model calls).'
          : `Evaluate-only score ${typeof score === 'number' ? `${(score * 100).toFixed(1)}%` : 'recorded'} with ${outcome.providerCalls} attributed provider call${outcome.providerCalls === 1 ? '' : 's'}.`,
        owner: 'ops',
        suspectedArea: 'ai_quality',
        userImpact: 'None — scheduled evaluation telemetry; prompts and Git state were not mutated.',
      });
    },
  };

  return runGovernedAgentJob(adapter, { tenantId: 0, userId: 0 });
}
