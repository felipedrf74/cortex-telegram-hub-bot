// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Default in-process handlers for the SQLite event backbone.
 *
 * Scheduler/PM2 can call these helpers later. Tests also exercise them
 * directly so the queue foundation has a real idempotent handler contract.
 */

import { enqueueJob, processPendingJobs, type JobHandler } from './background-job-queue';
import { processPendingEvents, type EventHandler } from './event-outbox';
import { projectSummaryReadModelsForUser } from './app-summary-read-models';
import { recordProductDecision } from './product-decision-log';
import { syncContentTopicSecretaryArtifactsById } from './content-topic-secretary-sync';
import { releaseDueNotificationDeliveries } from './notification-orchestrator';
import { recordTrainingLearningObservation } from './product-learning';
import { logger } from '../utils/logger';
import {
  assertAgentEventHandlerRuntimeParity,
  assertAgentQueuedJobHandlerRuntimeParity,
} from './agent-job-manifest';
import { chatCoreV2BackgroundCommandJobHandler } from './chat-core-v2/background-command-worker';
import { chatLegacyTimeoutContinuationJobHandler } from './chat-legacy-timeout-continuation';

const PROJECTABLE_EVENT_TYPES = new Set([
  'auth.user.logged_in',
  'chat.message.created',
  'secretary.agenda_item.created',
  'secretary.agenda_item.updated',
  'secretary.conflict.detected',
  'secretary.reflow.suggested',
  'training.plan.created',
  'training.plan.updated',
  'training.plan_revision.activated.v1',
  'training.session.updated',
  'training.feedback.recorded',
  'content.profile.updated',
  'content.idea.created',
  'content.idea.updated',
  'content.script.updated',
  'cooking.meal_plan.updated',
  'finance.expense.created',
  'finance.expense.updated',
  'finance.expense.deleted',
  'notification.intent.created',
  'notification.item.updated',
]);

// Event types the '*' router consumes ONLY to enqueue a durable background
// job — no read-model projection. Kept as a named registry (parsed by
// scripts/generate-agent-job-manifest.mjs, like PROJECTABLE_EVENT_TYPES) so
// AgentJobManifest lists them as routed without implying projection
// semantics. Dispatch stays strictly 1:1: the single '*' handler branches
// internally; never add a second consumer for one of these types.
const QUEUE_ROUTED_EVENT_TYPES = new Set([
  'training.plan_calendar_sync.requested.v1',
]);

// Direct effects run inside the event lease instead of creating a second
// background_jobs row. Keep this compact registration aligned with
// AgentJobManifest so new direct side effects cannot bypass governance.
export const DEFAULT_EVENT_DIRECT_EFFECTS = [
  {
    eventType: 'training.plan_revision.activated.v1',
    effect: 'record_training_learning_observation',
  },
  {
    eventType: 'training.adaptation.rejected.v1',
    effect: 'record_training_learning_observation',
  },
] as const;

function normalizeEventCreatedAtUtc(value: string): string {
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error('training learning event requires a valid created_at timestamp');
  }
  return new Date(parsed).toISOString();
}

export const defaultEventHandlers: EventHandler[] = [
  {
    eventType: '*',
    handle(event, db) {
      if (!event.userId) return;
      if (event.eventType === DEFAULT_EVENT_DIRECT_EFFECTS[0].eventType
          && event.sourceSkill === 'training'
          && event.payload?.action === 'ADAPT') {
        const contentHash = event.payload.contentHash;
        if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) {
          throw new Error('training adaptation learning event requires a sha256 content hash');
        }
        const observedAt = normalizeEventCreatedAtUtc(event.createdAt);
        recordTrainingLearningObservation({
          id: `training-adaptation-accepted-${event.eventId}`,
          tenantId: event.tenantId,
          userId: event.userId,
          kind: 'adaptation_accepted',
          outcomeCode: 'user_approved',
          expectedContractId: 'training.adaptation.activation.v1',
          evidenceReferences: [`event://training/plan-revision/${event.eventId}`],
          producerVersion: event.schemaVersion,
          confidence: 1,
          observedAt,
          subjectFingerprint: contentHash,
        }, db);
      }
      if (event.eventType === DEFAULT_EVENT_DIRECT_EFFECTS[0].eventType
          && event.sourceSkill === 'training'
          && event.payload?.capacityCoverage === 'AUTHORITATIVE') {
        const capacitySubjectFingerprint = event.payload.capacitySubjectFingerprint;
        if (typeof capacitySubjectFingerprint !== 'string'
            || !/^[a-f0-9]{64}$/.test(capacitySubjectFingerprint)) {
          throw new Error('training capacity learning event requires a scoped sha256 fingerprint');
        }
        const observedAt = normalizeEventCreatedAtUtc(event.createdAt);
        recordTrainingLearningObservation({
          id: `training-capacity-confirmed-${event.eventId}`,
          tenantId: event.tenantId,
          userId: event.userId,
          kind: 'capacity_conflict_accuracy',
          outcomeCode: 'confirmed',
          expectedContractId: 'training.capacity_conflict.v1',
          evidenceReferences: [`event://training/capacity/${event.eventId}`],
          producerVersion: event.schemaVersion,
          confidence: 1,
          observedAt,
          subjectFingerprint: capacitySubjectFingerprint,
        }, db);
      }
      if (event.eventType === DEFAULT_EVENT_DIRECT_EFFECTS[1].eventType
          && event.sourceSkill === 'training'
          && event.payload?.action === 'REJECT') {
        const materialFingerprint = event.payload.materialFingerprint;
        if (typeof materialFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(materialFingerprint)) {
          throw new Error('training adaptation rejection learning event requires a sha256 material fingerprint');
        }
        const observedAt = normalizeEventCreatedAtUtc(event.createdAt);
        recordTrainingLearningObservation({
          id: `training-adaptation-rejected-${event.eventId}`,
          tenantId: event.tenantId,
          userId: event.userId,
          kind: 'adaptation_rejected',
          outcomeCode: 'user_rejected',
          expectedContractId: 'training.adaptation.rejection.v1',
          evidenceReferences: [`event://training/adaptation/${event.eventId}`],
          producerVersion: event.schemaVersion,
          confidence: 1,
          observedAt,
          subjectFingerprint: materialFingerprint,
        }, db);
      }
      if (PROJECTABLE_EVENT_TYPES.has(event.eventType)) {
        enqueueJob({
          tenantId: event.tenantId,
          userId: event.userId,
          jobType: 'project_read_models',
          payload: {
            eventId: event.eventId,
            eventType: event.eventType,
            sourceSkill: event.sourceSkill,
          },
          priority: 30,
          idempotencyKey: `project_read_models:${event.eventId}`,
          correlationId: event.correlationId,
          causationEventId: event.eventId,
        }, db);
      }
      if (QUEUE_ROUTED_EVENT_TYPES.has(event.eventType)
        && event.eventType === 'training.plan_calendar_sync.requested.v1'
        && event.sourceSkill === 'training') {
        // Provider calendar work must never run inside this event lease
        // (this runtime group is providerUsage: 'none'); the dedicated
        // training-plan-calendar-sync worker drains the queued job. Payload
        // keys are chosen to survive the outbox privacy sanitizer — any key
        // matching /calendar|title|description/i would arrive '[redacted]'.
        enqueueJob({
          tenantId: event.tenantId,
          userId: event.userId,
          jobType: 'training_plan_calendar_sync',
          payload: {
            eventId: event.eventId,
            planId: Number(event.payload?.planId ?? event.entityId),
            planVersion: Number(event.payload?.planVersion ?? event.entityVersion),
            sessionIds: Array.isArray(event.payload?.sessionIds) ? event.payload.sessionIds : null,
            syncTarget: typeof event.payload?.syncTarget === 'string' ? event.payload.syncTarget : null,
          },
          priority: 20,
          maxAttempts: 5,
          idempotencyKey: `training_plan_calendar_sync:${event.eventId}`,
          correlationId: event.correlationId,
          causationEventId: event.eventId,
        }, db);
      }
      if (event.sourceSkill === 'content'
        && event.entityType === 'content_topic'
        && (event.eventType === 'content.idea.created' || event.eventType === 'content.idea.updated')) {
        const summary = event.payload?.summary as Record<string, unknown> | undefined;
        if (summary?.syncPending === true) {
          enqueueJob({
            tenantId: event.tenantId,
            userId: event.userId,
            jobType: 'content_topic_secretary_sync',
            payload: {
              topicId: Number(event.entityId),
              language: typeof event.payload?.language === 'string' ? event.payload.language : undefined,
              eventId: event.eventId,
            },
            priority: 20,
            maxAttempts: 5,
            idempotencyKey: `content_topic_secretary_sync:${event.tenantId}:${event.userId}:${event.entityId}:${event.eventId}`,
            correlationId: event.correlationId,
            causationEventId: event.eventId,
          }, db);
        }
      }
    },
  },
];

export const defaultJobHandlers: JobHandler[] = [
  // Chat background jobs share the same durable SQLite lease/retry worker as
  // the rest of the event backbone. Keeping them in this executable registry
  // (and AgentJobManifest) prevents a successfully queued iOS 202 from becoming
  // orphaned work in production.
  {
    jobType: 'chat_core_v2_background_command',
    idempotent: true,
    handle(job) {
      return chatCoreV2BackgroundCommandJobHandler.handle(job);
    },
  },
  {
    jobType: 'chat_legacy_timeout_continuation',
    idempotent: true,
    handle(job) {
      return chatLegacyTimeoutContinuationJobHandler.handle(job);
    },
  },
  {
    jobType: 'project_read_models',
    idempotent: true,
    handle(job) {
      if (!job.userId) return;
      const projected = projectSummaryReadModelsForUser({
        tenantId: job.tenantId,
        userId: job.userId,
      });
      recordProductDecision({
        tenantId: job.tenantId,
        userId: job.userId,
        sourceSkill: 'system',
        entityType: 'app_summary_read_model',
        entityId: job.jobId,
        decisionType: 'read_model_projection',
        inputsSummary: {
          jobType: job.jobType,
          summaries: projected.map((summary) => summary.summaryType),
        },
        decision: { projectedCount: projected.length },
        explanationCode: 'read_models_projected_from_event',
        correlationId: job.correlationId,
        eventId: job.causationEventId,
      });
    },
  },
  {
    jobType: 'deliver_notification',
    idempotent: true,
    async handle(job) {
      const sweep = await releaseDueNotificationDeliveries();
      // Spread: the sweep summary is a named interface without an index
      // signature, and recordProductDecision takes Record<string, unknown>.
      const result = { ...sweep };
      if (job.userId) {
        recordProductDecision({
          tenantId: job.tenantId,
          userId: job.userId,
          sourceSkill: 'system',
          entityType: 'notification_delivery_job',
          entityId: String(job.payload?.intentId ?? job.jobId),
          decisionType: 'notification_delivery_release',
          inputsSummary: {
            jobType: job.jobType,
            intentId: job.payload?.intentId ?? null,
          },
          decision: result,
          explanationCode: 'notification_delivery_job_released_due_items',
          correlationId: job.correlationId,
          eventId: job.causationEventId,
        });
      }
      if (sweep.failed > 0) {
        throw new Error(`notification delivery release: ${sweep.failed} delivery operation(s) failed`);
      }
    },
  },
  {
    jobType: 'training_summary_projector',
    idempotent: true,
    handle(job) {
      if (!job.userId) return;
      projectSummaryReadModelsForUser({ tenantId: job.tenantId, userId: job.userId, summaryTypes: ['training', 'home', 'week'] });
    },
  },
  {
    jobType: 'content_radar_scan_stub_or_existing',
    idempotent: true,
    handle() {
      // Intentionally no provider call in local/job foundation mode.
    },
  },
  {
    jobType: 'content_topic_secretary_sync',
    idempotent: true,
    async handle(job) {
      if (!job.userId) return;
      const topicId = Number(job.payload.topicId);
      if (!Number.isInteger(topicId) || topicId <= 0) {
        throw new Error('content_topic_secretary_sync_topic_id_required');
      }
      await syncContentTopicSecretaryArtifactsById(job.userId, topicId, {
        tenantId: job.tenantId,
        language: typeof job.payload.language === 'string' ? job.payload.language : undefined,
      });
    },
  },
  {
    jobType: 'sync_calendar_safe_mock',
    idempotent: true,
    handle() {
      // Intentionally no external calendar call in local/job foundation mode.
    },
  },
];

export async function runEventBackboneOnce(opts: {
  eventLimit?: number;
  jobLimit?: number;
  lockOwner?: string;
  disabled?: boolean;
} = {}): Promise<{
  events: Awaited<ReturnType<typeof processPendingEvents>>;
  jobs: Awaited<ReturnType<typeof processPendingJobs>>;
}> {
  // Handler arrays are executable runtime registries. Refuse to consume a
  // queue when a handler is added, removed, renamed, or changes idempotency
  // without regenerating and reviewing AgentJobManifest policy.
  assertAgentEventHandlerRuntimeParity(defaultEventHandlers, 'event-backbone-default', DEFAULT_EVENT_DIRECT_EFFECTS);
  assertAgentQueuedJobHandlerRuntimeParity(defaultJobHandlers, 'event-backbone-default');
  if (opts.disabled || process.env.EVENT_BACKBONE_WORKER_DISABLED === '1') {
    return {
      events: { processed: 0, failed: 0, deadLetter: 0 },
      jobs: { completed: 0, failed: 0, deadLetter: 0, skipped: 1 },
    };
  }

  const lockOwner = opts.lockOwner ?? `event-backbone-${process.pid}`;
  const startedAt = Date.now();
  const events = await processPendingEvents(defaultEventHandlers, {
    limit: clampBatchLimit(opts.eventLimit, 1, 100, 25),
    lockOwner,
  });
  const jobs = await processPendingJobs(defaultJobHandlers, {
    limit: clampBatchLimit(opts.jobLimit, 1, 50, 10),
    lockOwner,
  });
  logger.info(
    {
      scope: 'event_backbone_worker',
      lockOwner,
      events,
      jobs,
      durationMs: Date.now() - startedAt,
    },
    'event_backbone_worker_tick',
  );
  return { events, jobs };
}

function clampBatchLimit(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value as number));
}
