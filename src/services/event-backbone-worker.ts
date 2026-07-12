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
import { logger } from '../utils/logger';

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

export const defaultEventHandlers: EventHandler[] = [
  {
    eventType: '*',
    handle(event) {
      if (!event.userId) return;
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
        });
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
          });
        }
      }
    },
  },
];

export const defaultJobHandlers: JobHandler[] = [
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
      if (!job.userId) return;
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
