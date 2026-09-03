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
import {
  planChannelRelearnScopes,
  processChannelRelearnScope,
  type ChannelRelearnResult,
} from './channel-learner';

const AUTORESEARCH_PROVIDER_ROUTE = 'gemini-or-openai-primary-anthropic-fallback';
const CONTENT_PROVIDER_ROUTE = 'grounded-provider-configuration-fallthrough-single-attempt';
const CHANNEL_RELEARN_PROVIDER_ROUTE = 'gemini-primary-configuration-fallthrough-single-attempt';

export const SHARED_GOVERNED_AGENT_JOB_IDS = [
  'autoresearch',
  'channel_relearn',
  'chat_action_fixer_worker',
  'friday_weekly',
  'garmin_coach',
  'thursday_youtube',
  'tuesday_reels',
  'voice_evolution',
] as const;

type ContentTopicJobId = 'tuesday_reels' | 'thursday_youtube';
type ContentTopicInput = {
  format: 'reel' | 'youtube';
  sourceJob: ContentTopicJobId;
  missingCount: number;
};
type WeeklyContentInput = { missingReels: number; missingYoutube: number };

function errorName(error: unknown): string {
  const candidate = error instanceof Error ? error.name : 'UnknownError';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate)
    ? candidate
    : 'UnknownError';
}

function emptyChannelRelearnResult(synthesisDeferred = false): ChannelRelearnResult {
  return {
    analyzed: 0,
    failed: 0,
    skipped_no_new_videos: 0,
    synthesized: false,
    synthesis_skipped_all_unchanged: false,
    synthesis_deferred: synthesisDeferred,
  };
}

function mergeChannelRelearnResult(
  total: ChannelRelearnResult,
  result: ChannelRelearnResult,
): void {
  total.analyzed += result.analyzed;
  total.failed += result.failed;
  total.skipped_no_new_videos += result.skipped_no_new_videos;
  total.synthesized = total.synthesized || result.synthesized;
  total.synthesis_skipped_all_unchanged = total.synthesis_skipped_all_unchanged
    || result.synthesis_skipped_all_unchanged;
  total.synthesis_deferred = total.synthesis_deferred || result.synthesis_deferred;
}

class ChannelRelearnScopeExecutionError extends Error {
  constructor(readonly result: ChannelRelearnResult) {
    super('Channel re-learn scope contained failed channels');
    this.name = 'ChannelRelearnScopeExecutionError';
  }
}

function channelRelearnAdapter(input: {
  force: boolean;
  scopeUserId: number | undefined;
  systemScopeChanged: boolean;
}): GovernedAgentJobAdapter<typeof input, ChannelRelearnResult> {
  return {
    jobId: 'channel_relearn',
    providerRouting: CHANNEL_RELEARN_PROVIDER_ROUTE,
    prepare: () => ({
      kind: 'ready',
      input,
      fingerprintMaterial: {
        force: input.force,
        scope: input.scopeUserId == null ? 'platform' : 'tenant',
        systemScopeChanged: input.systemScopeChanged,
      },
    }),
    async execute({ input: prepared, runId, abortSignal }) {
      const result = await processChannelRelearnScope(prepared.force, prepared.scopeUserId, {
        runId,
        systemScopeChanged: prepared.systemScopeChanged,
        abortSignal,
      });
      if (result.failed > 0) throw new ChannelRelearnScopeExecutionError(result);
      return result;
    },
    validateOutput(output) {
      const counts = [output.analyzed, output.failed, output.skipped_no_new_videos];
      if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0)
          || output.failed !== 0
          || ![output.synthesized, output.synthesis_skipped_all_unchanged, output.synthesis_deferred]
            .every((value) => typeof value === 'boolean')) {
        throw new AgentJobOutputValidationError('Channel re-learn output failed validation');
      }
    },
    classifyOutput(output, _prepared, usage) {
      if (usage.providerCalls > 0) return 'success';
      if (output.synthesis_skipped_all_unchanged || output.skipped_no_new_videos > 0) {
        return 'skipped_unchanged';
      }
      return 'skipped_no_work';
    },
  };
}

/**
 * Run each channel-learning scope under its own immutable run id. The existing
 * per-channel video fingerprint remains the source of unchanged-input truth.
 */
export async function runScheduledChannelRelearn(force = false): Promise<ChannelRelearnResult> {
  const plan = planChannelRelearnScopes();
  const total = emptyChannelRelearnResult(plan.synthesisDeferred);
  if (plan.scopes.length === 0) {
    await runGovernedAgentJob({
      ...channelRelearnAdapter({ force, scopeUserId: undefined, systemScopeChanged: false }),
      prepare: () => ({
        kind: 'skip',
        status: 'skipped_no_work',
        reason: 'no_eligible_channel_scopes',
        fingerprintMaterial: { force, scopes: 0 },
      }),
    }, { tenantId: 0, userId: 0 });
    return total;
  }

  let systemScopeChanged = false;
  for (const scopeUserId of plan.scopes) {
    try {
      const outcome: AgentJobOutcome<ChannelRelearnResult> = await runGovernedAgentJob(channelRelearnAdapter({
        force,
        scopeUserId,
        systemScopeChanged,
      }), {
        tenantId: scopeUserId ?? 0,
        userId: scopeUserId ?? 0,
      });
      if (outcome.output) {
        mergeChannelRelearnResult(total, outcome.output);
        if (scopeUserId == null) systemScopeChanged = outcome.output.synthesized;
      }
    } catch (error) {
      if (!(error instanceof ChannelRelearnScopeExecutionError)) throw error;
      mergeChannelRelearnResult(total, error.result);
      if (scopeUserId == null) systemScopeChanged = error.result.synthesized;
      logger.warn(
        { failed: error.result.failed, scopeUserId: scopeUserId ?? null },
        'Channel re-learn governed scope completed with channel failures',
      );
    }
  }
  return total;
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
  tenantId: number,
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
          SELECT 1
            FROM content_domain_objects content_item
            JOIN content_artifacts content_artifact
              ON content_artifact.item_id = content_item.id
             AND content_artifact.tenant_id = content_item.tenant_id
             AND content_artifact.owner_user_id = content_item.owner_user_id
            JOIN content_revisions content_revision
              ON content_revision.id = content_artifact.current_revision_id
             AND content_revision.artifact_id = content_artifact.id
             AND content_revision.tenant_id = content_artifact.tenant_id
             AND content_revision.owner_user_id = content_artifact.owner_user_id
           WHERE content_item.owner_user_id = ?
             AND content_item.tenant_id = ?
             AND content_item.visibility_scope = 'user_private'
             AND content_item.scope_status = 'active'
             AND content_item.deleted_at IS NULL
             AND content_item.object_type = 'content_item'
             AND content_artifact.visibility_scope = 'user_private'
             AND content_artifact.scope_status = 'active'
             AND content_artifact.artifact_type IN ('script', 'platform_variant')
             AND content_revision.created_at >= datetime('now', '-30 days')
        )
      ) AS engaged
    `).get(userId, tenantId, userId, tenantId) as { engaged: number };
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
        tenantId,
        sourceJob,
        target.format,
      ) as { count: number };
      return Number(row.count || 0) >= target.targetCount;
    });
    if (!initialInventoryComplete) return true;
    logger.info(
      { userId, tenantId, sourceJob },
      'Scheduled Content generation skipped: no Content-surface engagement in 30 days',
    );
    return false;
  } catch (error) {
    logger.warn(
      { errorCode: errorName(error), userId, tenantId, sourceJob },
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
      if (!shouldGenerateContentTopicsForUser(scope.userId, scope.tenantId, sourceJob, [{ format, targetCount: 5 }])) {
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
        fingerprintMaterial: {
          format,
          sourceJob,
          missingCount,
        },
      };
    },
    execute: async ({ scope, input, runId, abortSignal }) => runWithContext(
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
          abortSignal,
        },
      ),
    ),
    validateOutput(output, input) {
      if (output.format !== input.format
          || output.sourceJob !== input.sourceJob
          || output.candidates.length !== input.missingCount
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
      if (!shouldGenerateContentTopicsForUser(scope.userId, scope.tenantId, 'friday_weekly', [
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
        fingerprintMaterial: {
          missingReels,
          missingYoutube,
          sourceJob: 'friday_weekly',
        },
      };
    },
    execute: async ({ scope, input, runId, abortSignal }) => runWithContext(
      { source: 'cron:friday_weekly', userId: scope.userId, tenantId: scope.tenantId },
      async () => generateWeeklyPackage(
        scope.userId,
        scope.tenantId,
        { reels: input.missingReels, youtube: input.missingYoutube },
        {
          requestSource: 'automation',
          jobName: 'friday_weekly',
          runId,
          abortSignal,
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
  const targets = listActiveAgentJobTenantTargets();
  const failures: Array<Readonly<{ errorCode: string }>> = [];
  for (const target of targets) {
    try {
      await runGovernedAgentJob(topicAdapter(format, sourceJob), {
        tenantId: target.tenantId,
        userId: target.userId,
      });
    } catch (error) {
      const errorCode = errorName(error);
      failures.push({ errorCode });
      logger.error(
        { errorCode, userId: target.userId, tenantId: target.tenantId, sourceJob, format },
        'Scheduled Content topic job failed for tenant',
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Scheduled Content topic job failed for ${failures.length} of ${targets.length} tenant scopes`,
    );
  }
}

export async function runWeeklyContentPackageCronForActiveUsers(): Promise<void> {
  const targets = listActiveAgentJobTenantTargets();
  const failures: Array<Readonly<{ errorCode: string }>> = [];
  for (const target of targets) {
    try {
      await runGovernedAgentJob(weeklyContentAdapter(), {
        tenantId: target.tenantId,
        userId: target.userId,
      });
    } catch (error) {
      const errorCode = errorName(error);
      failures.push({ errorCode });
      logger.error(
        { errorCode, userId: target.userId, tenantId: target.tenantId },
        'Scheduled weekly Content job failed for tenant',
      );
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Scheduled weekly Content job failed for ${failures.length} of ${targets.length} tenant scopes`,
    );
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
